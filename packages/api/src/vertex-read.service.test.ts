import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  MAX_VERTEX_ARTIFACT_BYTES,
  VertexReadServiceError,
  createVertexReadService,
  type VertexAuthorizationPort,
  type VertexReadDependencies,
  type VertexReadPort,
  type VertexStoredArtifact,
} from "./server/vertex-service.ts";

const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const digest = "a".repeat(64);
const moduleManifest = {
  schemaVersion: "1.0.0",
  moduleId: "gamma-research",
  version: "1.0.0",
  inputSchemaVersion: "1.0.0",
  outputSchemaVersion: "1.0.0",
  capabilities: ["research"],
  dataRequirements: [],
  supportedInstruments: ["equity"],
  riskPolicyVersion: "1.0.0",
  artifactDigest: digest,
  lifecycleState: "unavailable",
  runtime: "python-external",
  reasonCodes: ["native-adapter-not-validated"],
};
const modulesIdentity: VertexStoredArtifact["identity"] = { kind: "modules" };

const storedText = async (
  text: string,
  identity: VertexStoredArtifact["identity"] = modulesIdentity
): Promise<VertexStoredArtifact> => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    artifactSha256: await hashArtifact(bytes),
    identity: { ...identity },
  };
};

const storedValue = async (
  value: unknown,
  identity: VertexStoredArtifact["identity"] = modulesIdentity
): Promise<VertexStoredArtifact> =>
  storedText(canonicalArtifactJson(value), identity);

const dependencies = (): {
  read: VertexReadPort;
  authorization: VertexAuthorizationPort;
} => ({
  read: {
    listModules: vi.fn(async () => storedValue([moduleManifest])),
  },
  authorization: {
    canListModules: vi.fn(async () => true),
  },
});

const run = (deps: VertexReadDependencies) =>
  createVertexReadService(deps).listModules(principal, {});

const expectFailure = async (
  operation: Promise<unknown>,
  code: string
): Promise<void> => {
  await expect(operation).rejects.toBeInstanceOf(VertexReadServiceError);
  await expect(operation).rejects.toMatchObject({ code });
  await expect(operation).rejects.not.toThrow("private provider secret");
};

const expectFrozen = (value: unknown): void => {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
};

describe("Vertex read service", () => {
  it("preserves authoritative values and deeply freezes detached graphs", async () => {
    const deps = dependencies();
    const modules = await run(deps);
    expect(modules).toEqual([moduleManifest]);
    expectFrozen(modules);
    expect(Object.isFrozen(moduleManifest)).toBe(false);
    expect(() => Array.prototype.push.call(modules, {})).toThrow();
    expect(() =>
      Array.prototype.push.call(modules[0]?.reasonCodes, "ready")
    ).toThrow();
    expect(deps.authorization.canListModules).toHaveBeenCalledWith(principal);
    return expect(deps.read.listModules).toHaveBeenCalledWith(principal);
  });

  it("fails unavailable without both ports", async () => {
    const deps = dependencies();
    for (const missing of [
      {},
      { read: deps.read },
      { authorization: deps.authorization },
    ]) {
      await expectFailure(run(missing), "SERVICE_UNAVAILABLE");
    }
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("defaults to unavailable, never synthetic readiness", async () =>
    await expectFailure(
      createVertexReadService().listModules(principal, {}),
      "SERVICE_UNAVAILABLE"
    ));

  it("checks authorization before storage", async () => {
    const deps = dependencies();
    vi.mocked(deps.authorization.canListModules).mockResolvedValue(false);
    await expectFailure(run(deps), "FORBIDDEN");
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("admin role never bypasses the module-list decision", async () => {
    const deps = dependencies();
    vi.mocked(deps.authorization.canListModules).mockResolvedValue(false);
    const admin: SafePrincipal = { ...principal, role: "admin" };
    await expectFailure(
      createVertexReadService(deps).listModules(admin, {}),
      "FORBIDDEN"
    );
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("sanitizes authorization failures and malformed decisions", async () => {
    for (const decision of [undefined, null, 1, "true", { allowed: true }]) {
      const deps = dependencies();
      vi.mocked(deps.authorization.canListModules).mockResolvedValue(
        decision as never
      );
      await expectFailure(run(deps), "SERVICE_UNAVAILABLE");
      expect(deps.read.listModules).not.toHaveBeenCalled();
    }
    const deps = dependencies();
    vi.mocked(deps.authorization.canListModules).mockRejectedValue(
      new Error("private provider secret")
    );
    await expectFailure(run(deps), "SERVICE_UNAVAILABLE");
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("sanitizes storage failures, even forged service errors", async () => {
    for (const error of [
      new Error("private provider secret"),
      new VertexReadServiceError("NOT_FOUND"),
    ]) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockRejectedValue(error);
      await expectFailure(run(deps), "SERVICE_UNAVAILABLE");
    }
    return;
  });

  it("treats missing provider envelopes as invalid source", async () => {
    for (const value of [null, undefined]) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue(value as never);
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
  });

  it("rejects request principal injection before either port", async () => {
    const deps = dependencies();
    const service = createVertexReadService(deps);
    for (const input of [
      { principal },
      { datasetId: "dataset-1" },
      { collectionId: "collection-1", evidenceId: "evidence-1" },
      null,
    ]) {
      await expectFailure(
        service.listModules(principal, input as never),
        "BAD_REQUEST"
      );
    }
    expect(deps.authorization.canListModules).not.toHaveBeenCalled();
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it.each([
    " ",
    "null",
    "{}",
    "not json",
    '[{"moduleId":"a","moduleId":"b"}]',
    '{"value":-0}',
    '{"value":1.0}',
    '{"value":9007199254740993}',
    '{"value":1e400}',
    '{"value":"\\ud800"}',
    '{"b":1,"a":2}',
    '{"value":"\\u0061"}',
  ])(
    "rejects malformed, noncanonical or wrong-schema stored text: %s",
    async (text) => {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue(
        await storedText(text)
      );
      return await expectFailure(run(deps), "INVALID_SOURCE");
    }
  );

  it("rejects even valid schema JSON when bytes are not canonical", async () => {
    const canonical = canonicalArtifactJson([moduleManifest]);
    for (const text of [
      JSON.stringify([moduleManifest], null, 1),
      ` ${canonical}`,
      `${canonical}\n`,
      `\ufeff${canonical}`,
    ]) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue(
        await storedText(text)
      );
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
  });

  it("rejects empty, oversized, exotic and non-UTF8 artifact bytes", async () => {
    const invalid = [
      new Uint8Array(),
      new Uint8Array(MAX_VERTEX_ARTIFACT_BYTES + 1),
      new Uint8Array([0xff]),
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0xed, 0xa0, 0x80]),
      new Uint8Array(new SharedArrayBuffer(4)),
      "{}",
      new DataView(new ArrayBuffer(2)),
    ];

    for (const bytes of invalid) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue({
        bytes,
        artifactSha256:
          bytes instanceof Uint8Array
            ? await hashArtifact(new Uint8Array(bytes))
            : digest,
        identity: modulesIdentity,
      } as VertexStoredArtifact);
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
  });

  it("checks byte digest, metadata shape and identity independently", async () => {
    const valid = await storedValue([moduleManifest]);
    const invalid = [
      { ...valid, artifactSha256: "b".repeat(64) },
      { ...valid, artifactSha256: "A".repeat(64) },
      {
        ...valid,
        identity: {
          kind: "dataset",
          datasetId: "dataset-1",
          contentSha256: digest,
        },
      },
      {
        ...valid,
        identity: {
          kind: "evidence",
          collectionId: "collection-1",
          evidenceId: "evidence-1",
          contentSha256: digest,
        },
      },
      { ...valid, identity: { kind: "modules", contentSha256: digest } },
      {
        ...valid,
        identity: { kind: "modules", secret: "private provider secret" },
      },
      { ...valid, identity: { kind: "modules", value: Number.NaN } },
      { ...valid, identity: undefined },
    ];

    for (const stored of invalid) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue(
        stored as VertexStoredArtifact
      );
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
  });

  it("rejects duplicate identities, excess count and unsafe capabilities", async () => {
    const deps = dependencies();
    for (const value of [
      [moduleManifest, moduleManifest],
      Array.from({ length: 257 }, (_, index) => ({
        ...moduleManifest,
        moduleId: `module-${index}`,
      })),
      [{ ...moduleManifest, capabilities: ["broker-order-submit"] }],
      [{ ...moduleManifest, lifecycleState: "ready" }],
      [{ ...moduleManifest, runtime: "native-ready" }],
      [{ ...moduleManifest, version: "latest" }],
      [{ ...moduleManifest, extra: "private provider secret" }],
    ]) {
      vi.mocked(deps.read.listModules).mockResolvedValue(
        await storedValue(value)
      );
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
    vi.mocked(deps.read.listModules).mockResolvedValue(await storedValue([]));
    const modules = await run(deps);
    expect(modules).toEqual([]);
    return expectFrozen(modules);
  });

  it("snapshots catalog metadata and bytes before asynchronous hashing", async () => {
    const deps = dependencies();
    const stored = await storedValue([moduleManifest]);
    vi.mocked(deps.read.listModules).mockResolvedValue(stored);
    // Mutate the source during the async WebCrypto hash step: a window selects
    // that path (server runtimes otherwise hash synchronously).
    vi.stubGlobal("window", globalThis);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const hashing = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, bytes) => {
        stored.bytes.fill(0);
        Object.assign(stored.identity, { kind: "changed" });
        return originalDigest(algorithm, bytes);
      });
    try {
      const output = await run(deps);
      expect(hashing).toHaveBeenCalled();
      expect(output).toEqual([moduleManifest]);
      return expectFrozen(output);
    } finally {
      hashing.mockRestore();
    }
  });

  it("rejects accessor, decorated, missing-field and exotic storage envelopes without invoking getters", async () => {
    const valid = await storedValue([moduleManifest]);
    const getter = vi.fn(() => valid.bytes);
    const accessor = { ...valid };
    Object.defineProperty(accessor, "bytes", { get: getter, enumerable: true });
    const hidden = { ...valid };
    Object.defineProperty(hidden, "bytes", {
      value: valid.bytes,
      enumerable: false,
    });
    const identityAccessor = { ...modulesIdentity };
    Object.defineProperty(identityAccessor, "kind", {
      get: getter,
      enumerable: true,
    });
    for (const value of [
      "envelope",
      Object.create(valid),
      accessor,
      hidden,
      { ...valid, extra: "private provider secret" },
      { ...valid, [Symbol("hidden")]: true },
      {
        identity: valid.identity,
        artifactSha256: valid.artifactSha256,
        replacement: true,
      },
      {
        bytes: valid.bytes,
        artifactSha256: valid.artifactSha256,
        replacement: true,
      },
      { bytes: valid.bytes, identity: valid.identity, replacement: true },
      { ...valid, identity: identityAccessor },
    ]) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue(
        value as VertexStoredArtifact
      );
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
    return expect(getter).not.toHaveBeenCalled();
  });

  it("rejects byte-container subclasses and shadowed bound accessors", async () => {
    const valid = await storedValue([moduleManifest]);
    class ExoticBytes extends Uint8Array {
      marker = true;
    }
    const getter = vi.fn(() => 1);
    const shadowBuffer = new Uint8Array(valid.bytes);
    const shadowLength = new Uint8Array(valid.bytes);
    Object.defineProperty(shadowBuffer, "buffer", { get: getter });
    Object.defineProperty(shadowLength, "byteLength", { get: getter });
    for (const bytes of [
      new ExoticBytes(valid.bytes),
      shadowBuffer,
      shadowLength,
    ]) {
      const deps = dependencies();
      vi.mocked(deps.read.listModules).mockResolvedValue({ ...valid, bytes });
      await expectFailure(run(deps), "INVALID_SOURCE");
    }
    return expect(getter).not.toHaveBeenCalled();
  });
});
