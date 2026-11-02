import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWebDeploymentCli } from "./cli.ts";
import type { ApprovedRevisionDeploymentRequest } from "./approved-inputs.ts";
import { officialAdapterArguments } from "./runner.ts";

const sha = "b".repeat(40);
const account = "a".repeat(32);
const dependencies = (environment = "production") => {
  const staging = environment === "staging";
  const origin = staging
    ? "https://staging.vertex.xyz"
    : "https://app.vertex.xyz";
  const name = staging ? "vertex-research-web-staging" : "vertex-research-web";
  const selected = {
    account_id: account,
    name,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
    vars: {
      APP_ENV: "production",
      APP_URL: origin,
      BETTER_AUTH_URL: origin,
      EMAIL_PROVIDER: "disabled",
      EMAIL_TRANSPORT: "disabled",
    },
  };
  const config = JSON.stringify(
    staging ? { env: { staging: selected } } : selected
  );
  const receipt = {
    version: 1,
    environment,
    origin,
    workerName: name,
    accountFingerprint: createHash("sha256").update(account).digest("hex"),
    configurationSha256: createHash("sha256").update(config).digest("hex"),
    exactSha: sha,
    approvedBy: "synthetic-operator",
    accountVerified: true,
    domainVerified: true,
    cutoverApproved: true,
  };
  return {
    source: {
      DATABASE_PROVIDER: "planetscale",
      DATABASE_URL:
        "postgresql://test:test@aws.pg.psdb.cloud:6432/isolated_test?sslmode=verify-full",
    },
    readConfiguration: vi.fn(async (_headSha: string) => config),
    readReceipt: vi.fn(async (_path: string) => JSON.stringify(receipt)),
    currentHead: vi.fn(async () => sha),
    cleanTree: vi.fn(async () => true),
    assertAdapterInputs: vi.fn(async () => undefined),
    deploy: vi.fn(async (_request: ApprovedRevisionDeploymentRequest) => 0),
    output: { write: vi.fn() },
    errorOutput: { write: vi.fn() },
  };
};

const args = (environment = "production") => [
  "--environment",
  environment,
  "--destination-receipt",
  `private/deployment/${environment}.json`,
];

describe("web deployment CLI safety gate", () => {
  it.each(["production", "staging"])(
    "accepts an explicit isolated %s receipt without deploying",
    async (environment) => {
      const deps = dependencies(environment);
      expect(await runWebDeploymentCli(args(environment), deps)).toBe(0);
      expect(deps.readReceipt).toHaveBeenCalledWith(
        `private/deployment/${environment}.json`
      );
      expect(deps.readConfiguration).toHaveBeenCalledWith(sha);
      expect(deps.output.write).toHaveBeenCalledWith(
        expect.stringContaining("policy gates remain required")
      );
      expect(deps.errorOutput.write).not.toHaveBeenCalled();
      return expect(deps.deploy).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["production", "deploy", ["deploy"]],
    ["production", "check", ["deploy", "--dry-run"]],
    ["staging", "deploy", ["deploy", "--env", "staging"]],
    ["staging", "check", ["deploy", "--dry-run", "--env", "staging"]],
  ] as const)(
    "passes an immutable exact-revision %s %s request to the runner",
    async (environment, mode, expected) => {
      const deps = dependencies(environment);
      expect(
        await runWebDeploymentCli([...args(environment), "--mode", mode], deps)
      ).toBe(0);
      const request = deps.deploy.mock.calls[0]![0];
      expect(request).toEqual({
        exactSha: sha,
        configurationSha256: createHash("sha256")
          .update(await deps.readConfiguration(sha))
          .digest("hex"),
        environment,
        mode,
        destinationBinding: JSON.parse(await deps.readReceipt("synthetic")),
      });
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.destinationBinding)).toBe(true);
      return expect(officialAdapterArguments(request)).toEqual(expected);
    }
  );

  it("propagates failed deployment status and redacts adapter exceptions", async () => {
    const deps = dependencies();
    deps.deploy.mockResolvedValueOnce(7);
    expect(
      await runWebDeploymentCli([...args(), "--mode", "deploy"], deps)
    ).toBe(7);
    deps.deploy.mockRejectedValueOnce(new Error("private-adapter-detail"));
    expect(
      await runWebDeploymentCli([...args(), "--mode", "deploy"], deps)
    ).toBe(1);
    return expect(
      JSON.stringify(deps.errorOutput.write.mock.calls)
    ).not.toContain("private-adapter-detail");
  });

  it.each(
    [
      [],
      ["--environment", "production"],
      ["--environment"],
      ["--environment", "preview", "--destination-receipt", "receipt.json"],
      [...args(), "--account-id", "private-value"],
      [...args(), "--environment", "staging"],
      [...args(), "--destination-receipt", "other.json"],
      ["--destination-receipt", "", "--environment", "production"],
      [...args(), "--mode", "preview"],
      [...args(), "--mode", "deploy", "--mode", "check"],
      [...args(), "--name", "darkfactory-web"],
      [...args(), "--env", "staging"],
    ].map((argv) => ({ argv }))
  )(
    "blocks incomplete, preview, repeated, or extra options %# before IO",
    async ({ argv }) => {
      const deps = dependencies();
      expect(await runWebDeploymentCli(argv, deps)).toBe(1);
      expect(deps.readConfiguration).not.toHaveBeenCalled();
      expect(deps.readReceipt).not.toHaveBeenCalled();
      expect(deps.deploy).not.toHaveBeenCalled();
      return expect(
        JSON.stringify(deps.errorOutput.write.mock.calls)
      ).not.toContain("private-value");
    }
  );

  it("blocks a dirty tree before accepting a receipt", async () => {
    const deps = dependencies();
    deps.cleanTree.mockResolvedValue(false);
    expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    return expect(deps.errorOutput.write).toHaveBeenCalledWith(
      expect.stringContaining("clean")
    );
  });

  it.each([
    "readConfiguration",
    "readReceipt",
    "currentHead",
    "cleanTree",
    "assertAdapterInputs",
  ] as const)(
    "fails closed on %s errors without revealing input",
    async (key) => {
      const deps = dependencies();
      deps[key].mockRejectedValue(new Error("private-input"));
      expect(await runWebDeploymentCli(args(), deps)).toBe(1);
      return expect(
        JSON.stringify(deps.errorOutput.write.mock.calls)
      ).not.toContain("private-input");
    }
  );

  it.each(["null", "[]", "invalid-json", "{}"])(
    "blocks invalid receipts %#",
    async (value) => {
      const deps = dependencies();
      deps.readReceipt.mockResolvedValue(value);
      return expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    }
  );

  it("blocks malformed configuration and post-verification configuration drift", async () => {
    const deps = dependencies();
    deps.readConfiguration.mockResolvedValueOnce("bad-json");
    expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    const original = await deps.readConfiguration(sha);
    deps.readConfiguration.mockResolvedValue(`${original} `);
    expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    return expect(deps.errorOutput.write).toHaveBeenLastCalledWith(
      expect.stringContaining("configuration digest")
    );
  });

  it("blocks a receipt for another exact SHA", async () => {
    const deps = dependencies();
    deps.currentHead.mockResolvedValue("c".repeat(40));
    expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    return expect(deps.errorOutput.write).toHaveBeenCalledWith(
      expect.stringContaining("exact SHA")
    );
  });

  it("retains the production database gate after destination verification", async () => {
    const deps = dependencies();
    deps.source.DATABASE_URL =
      "postgresql://test:private-input@localhost:5432/test";
    expect(await runWebDeploymentCli(args(), deps)).toBe(1);
    expect(JSON.stringify(deps.errorOutput.write.mock.calls)).not.toContain(
      "private-input"
    );
    return expect(deps.deploy).not.toHaveBeenCalled();
  });

  it.each(["production", "staging"])(
    "rejects all ambient %s config selectors before validate/check/deploy",
    async (environment) => {
      for (const mode of ["validate", "check", "deploy"]) {
        for (const key of [
          "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
          "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
          "CLOUDFLARE_VITE_BUILD",
          "WRANGLER_CI_OVERRIDE_NAME",
          "CLOUDFLARE_ENV",
          "WRANGLER_ENV",
        ]) {
          const deps = dependencies(environment);
          Object.assign(deps.source, { [key]: "private-selector" });
          expect(
            await runWebDeploymentCli(
              [...args(environment), "--mode", mode],
              deps
            )
          ).toBe(1);
          expect(deps.deploy).not.toHaveBeenCalled();
          expect(
            JSON.stringify(deps.errorOutput.write.mock.calls)
          ).not.toContain("private-selector");
        }
      }
    }
  );

  it.each(["validate", "check", "deploy"])(
    "rejects source, config, or HEAD mutation between validation and %s handoff",
    async (mode) => {
      for (const environment of ["production", "staging"]) {
        for (const mutation of ["source", "config", "head"]) {
          const deps = dependencies(environment);
          const config = await deps.readConfiguration(sha);
          const receipt = await deps.readReceipt("synthetic");
          deps.readReceipt.mockImplementationOnce(async () => {
            if (mutation === "source") deps.cleanTree.mockResolvedValue(false);
            if (mutation === "config")
              deps.readConfiguration.mockResolvedValue(`${config} `);
            if (mutation === "head")
              deps.currentHead.mockResolvedValue("c".repeat(40));
            return receipt;
          });
          expect(
            await runWebDeploymentCli(
              [...args(environment), "--mode", mode],
              deps
            )
          ).toBe(1);
          expect(deps.deploy).not.toHaveBeenCalled();
          expect(deps.errorOutput.write).toHaveBeenCalledWith(
            expect.stringContaining("changed during validation")
          );
        }
      }
    }
  );

  return it("rechecks unsupported local inputs before handing off and fails closed on late errors", async () => {
    const deps = dependencies();
    deps.assertAdapterInputs
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("late-private-dotenv"));
    expect(
      await runWebDeploymentCli([...args(), "--mode", "deploy"], deps)
    ).toBe(1);
    expect(deps.assertAdapterInputs).toHaveBeenCalledTimes(2);
    expect(deps.deploy).not.toHaveBeenCalled();
    return expect(
      JSON.stringify(deps.errorOutput.write.mock.calls)
    ).not.toContain("late-private-dotenv");
  });
});
