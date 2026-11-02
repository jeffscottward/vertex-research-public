import { describe, expect, it, vi } from "vitest";
import {
  materializeApprovedSource,
  type ApprovedSource,
} from "./approved-inputs.ts";
import {
  officialAdapterArguments,
  preparationPolicy,
  runApprovedRevisionDeployment,
  runtimeImagePins,
  type DeploymentRunnerPorts,
  type PreparationPolicy,
  type SealedDeploymentInputs,
} from "./runner.ts";
import {
  syntheticEnvironment,
  syntheticPolicy,
  syntheticRevision,
} from "./test-fixtures.ts";

const runnerFixture = (overrides: Record<string, string | null> = {}) => {
  const fixture = syntheticRevision(overrides);
  const ports = {
    reader: fixture.reader,
    admit: vi.fn(async () => undefined),
    prepare: vi.fn(
      async (
        snapshot: ApprovedSource,
        _policy: PreparationPolicy,
        policySha256: string
      ): Promise<SealedDeploymentInputs> => ({
        imageId: `sha256:${"a".repeat(64)}`,
        sourceSha256: snapshot.manifestSha256,
        authoritySha256: snapshot.dependencyAuthoritySha256,
        policySha256,
        dependencySha256: "b".repeat(64),
        toolchainSha256: "c".repeat(64),
      })
    ),
    execute: vi.fn(async () => 0),
    cleanup: vi.fn(async () => undefined),
  };
  return { ...fixture, ports };
};

const run = (fixture = runnerFixture()) =>
  runApprovedRevisionDeployment(
    fixture.request,
    syntheticEnvironment,
    fixture.ports
  );

describe("sealed deployment lifecycle", () => {
  it.each(["check", "deploy"] as const)(
    "runs %s only after materialization, preparation, identity checks and final admission",
    async (mode) => {
      const fixture = runnerFixture();
      const result = await runApprovedRevisionDeployment(
        { ...fixture.request, mode },
        syntheticEnvironment,
        fixture.ports
      );
      expect(result).toMatchObject({
        status: "completed",
        exitCode: 0,
        cleanup: "complete",
        providerMayHaveBeenReached: mode === "deploy",
        reason: "none",
      });
      expect(fixture.ports.admit).toHaveBeenCalledTimes(2);
      expect(fixture.ports.execute).toHaveBeenCalledWith(
        expect.objectContaining({ imageId: `sha256:${"a".repeat(64)}` }),
        { mode, environment: "production" }
      );
      return expect(fixture.ports.cleanup).toHaveBeenCalledOnce();
    }
  );

  it.each(["admit", "prepare", "execute", "cleanup"] as const)(
    "fails closed and sanitizes %s exceptions",
    async (key) => {
      const fixture = runnerFixture();
      fixture.ports[key].mockRejectedValue(
        new Error("PRIVATE_SENTINEL_CREDENTIAL")
      );
      const result = await run(fixture);
      expect(result.exitCode).toBe(1);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
      expect(fixture.ports.cleanup).toHaveBeenCalledOnce();
      if (key === "admit" || key === "prepare")
        expect(fixture.ports.execute).not.toHaveBeenCalled();
      if (key === "cleanup")
        return expect(result).toMatchObject({
          phase: "cleanup",
          cleanup: "failed",
          reason: "cleanup-failed",
        });
      return;
    }
  );

  it("does not retry an uncertain deploy even when cleanup fails", async () => {
    const fixture = runnerFixture();
    fixture.ports.execute.mockRejectedValue(
      new Error("provider may have succeeded")
    );
    fixture.ports.cleanup.mockRejectedValue(new Error("cleanup failed"));
    const result = await runApprovedRevisionDeployment(
      { ...fixture.request, mode: "deploy" },
      syntheticEnvironment,
      fixture.ports
    );
    expect(result).toMatchObject({
      status: "uncertain",
      providerMayHaveBeenReached: true,
      cleanup: "failed",
    });
    return expect(fixture.ports.execute).toHaveBeenCalledOnce();
  });

  it.each([7, -1, 256, Number.NaN, Number.POSITIVE_INFINITY])(
    "handles bounded/noninteger execution result %#",
    async (status) => {
      const fixture = runnerFixture();
      fixture.ports.execute.mockResolvedValue(status);
      return expect((await run(fixture)).exitCode).toBe(status === 7 ? 7 : 1);
    }
  );

  it.each([
    "imageId",
    "sourceSha256",
    "authoritySha256",
    "policySha256",
    "dependencySha256",
    "toolchainSha256",
  ] as const)(
    "denies sealed %s drift or nominal identity claims",
    async (key) => {
      const fixture = runnerFixture();
      const original = fixture.ports.prepare.getMockImplementation()!;
      fixture.ports.prepare.mockImplementation(async (...args) => ({
        ...(await original(...args)),
        [key]: "forged",
      }));
      expect((await run(fixture)).status).toBe("blocked");
      return expect(fixture.ports.execute).not.toHaveBeenCalled();
    }
  );

  it("rejects observed post-preparation admission drift without touching the provider", async () => {
    const fixture = runnerFixture();
    fixture.ports.admit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("head changed"));
    expect((await run(fixture)).exitCode).toBe(1);
    return expect(fixture.ports.execute).not.toHaveBeenCalled();
  });

  it("snapshots the request, binding and parent environment before awaiting", async () => {
    const fixture = runnerFixture();
    const source: Record<string, string | undefined> = {
      ...syntheticEnvironment,
    };
    fixture.ports.admit.mockImplementationOnce(async () => {
      Object.assign(fixture.request, {
        environment: "staging",
        configurationSha256: "0".repeat(64),
      });
      Object.assign(fixture.request.destinationBinding, {
        approvedBy: "changed",
        cutoverApproved: false,
      });
      source["DATABASE_URL"] = "invalid";
    });
    expect(
      (
        await runApprovedRevisionDeployment(
          fixture.request,
          source,
          fixture.ports
        )
      ).exitCode
    ).toBe(0);
    return expect(fixture.ports.execute).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "check", environment: "production" }
    );
  });

  it("rejects source corruption before preparing", async () => {
    const fixture = runnerFixture();
    fixture.objects.set(fixture.request.exactSha, Buffer.from("corrupt"));
    expect((await run(fixture)).phase).toBe("source");
    return expect(fixture.ports.prepare).not.toHaveBeenCalled();
  });

  it("keeps image and offline preparation prerequisites distinct from human approval", async () => {
    for (const [key, reason] of [
      ["nodeImage", "pinned-runtime-images-required"],
      ["offlineInputsSha256", "pinned-offline-inputs-required"],
    ] as const) {
      const fixture = runnerFixture({
        "infra/docker/deployment/policy.json": JSON.stringify({
          ...syntheticPolicy,
          [key]: null,
        }),
      });
      expect(await run(fixture)).toMatchObject({ status: "blocked", reason });
      expect(fixture.ports.prepare).not.toHaveBeenCalled();
      expect(fixture.ports.execute).not.toHaveBeenCalled();
    }
  });

  it.each([
    "bad-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...syntheticPolicy, unexpected: true }),
    JSON.stringify({ ...syntheticPolicy, platform: "linux/arm64" }),
    JSON.stringify({ ...syntheticPolicy, node: "22" }),
    " ".repeat(4097),
  ])("rejects invalid preparation policy %#", async (policy) => {
    const fixture = runnerFixture({
      "infra/docker/deployment/policy.json": policy,
    });
    expect((await run(fixture)).exitCode).toBe(1);
    return expect(fixture.ports.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { ".nvmrc": "22.0.0" },
    { "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }) },
  ])("rejects toolchain authority drift %#", async (overrides) => {
    return expect((await run(runnerFixture(overrides))).exitCode).toBe(1);
  });

  it("requires policy bytes and immutable exact image pins", async () => {
    const fixture = runnerFixture();
    const snapshot = await materializeApprovedSource(
      fixture.request,
      fixture.reader,
      syntheticEnvironment
    );
    expect(() =>
      preparationPolicy({
        ...snapshot,
        files: snapshot.files.filter(
          (file) => file.path !== "infra/docker/deployment/policy.json"
        ),
      })
    ).toThrow("preparation-policy");
    const policy = preparationPolicy(snapshot).policy;
    expect(policy.nodeImage).toBe(runtimeImagePins.node);
    return expect(policy.bunImage).toBe(runtimeImagePins.bun);
  });

  it.each([
    [{ mode: "check", environment: "production" }, ["deploy", "--dry-run"]],
    [{ mode: "deploy", environment: "production" }, ["deploy"]],
    [
      { mode: "check", environment: "staging" },
      ["deploy", "--dry-run", "--env", "staging"],
    ],
    [
      { mode: "deploy", environment: "staging" },
      ["deploy", "--env", "staging"],
    ],
  ] as const)(
    "keeps official adapter operation semantics %#",
    (operation, args) => {
      return expect(officialAdapterArguments(operation)).toEqual(args);
    }
  );

  return it("rejects forged operation enums and inertly defines injectable ports", () => {
    expect(() =>
      officialAdapterArguments({
        mode: "arbitrary",
        environment: "production",
      } as never)
    ).toThrow();
    expect(() =>
      officialAdapterArguments({
        mode: "deploy",
        environment: "preview",
      } as never)
    ).toThrow();
    const ports: DeploymentRunnerPorts = runnerFixture().ports;
    return expect(ports.prepare).not.toHaveBeenCalled();
  });
});
