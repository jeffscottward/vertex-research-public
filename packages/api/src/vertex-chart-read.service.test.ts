import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexArtifactMetadata,
  VertexAuthorizationRepository,
  VertexScope,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import {
  VertexArtifactStorageError,
  type VertexArtifactStorage,
} from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import { VERTEX_READ_ERRORS } from "./contracts/vertex-read.ts";
import { createVertexChartReadService } from "./server/vertex-chart-service.ts";
import { VertexReadServiceError } from "./server/vertex-service.ts";
import {
  VertexExperienceServiceError,
  type VertexExperienceDependencies,
} from "./server/vertex-experience-core.ts";

// exactOptionalPropertyTypes: model a missing optional dependency by omission.
const withoutDependency = <T extends object, K extends keyof T>(
  dependencies: T,
  key: K
): Omit<T, K> => {
  const copy = { ...dependencies };
  delete copy[key];
  return copy;
};

// Synthetic inline fixtures only.
const principal: SafePrincipal = {
  userId: "fixture-reader",
  role: "member",
  status: "active",
};
const scope: VertexScope = {
  accountAlias: "fixture-account",
  environment: "research",
};
const START = "2026-09-21T14:00:00Z";
const NOW = "2026-09-21T14:01:01Z";
const AFTER = "2026-09-22T14:01:00Z";
const rights = {
  policyId: "fixture-policy",
  version: "1.0.0",
  status: "granted",
  allowedUses: ["store", "read", "derive"],
  checkedAt: START,
  expiresAt: AFTER,
  retentionUntil: AFTER,
} as const;
const ARTIFACT = "fixture-modules";
const LOOKUP = "module-catalog";
type Rights = Awaited<ReturnType<VertexStore["getRights"]>>;

const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));

interface Stored {
  metadata: VertexArtifactMetadata;
  bytes: Uint8Array;
}
const harness = () => {
  let stored: Stored | null = null;
  const publish = async (
    value: unknown = [],
    collectionId: string | null = null
  ): Promise<Stored> => {
    const bytes = encode(value);
    const metadata: VertexArtifactMetadata = {
      artifactId: ARTIFACT,
      contractName: "ModuleManifestList",
      scope,
      collectionId,
      objectKey: `fixture/${ARTIFACT}`,
      artifactSha256: await hashArtifact(bytes),
      sourceContentSha256: null,
      byteLength: bytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      rights,
      lineageArtifactIds: [],
      createdAt: NOW,
    };
    stored = { metadata, bytes };
    return stored;
  };
  const authorize = vi.fn<VertexAuthorizationRepository["authorize"]>(
    async () => true
  );
  const listAuthorizedScopes = vi.fn<
    VertexAuthorizationRepository["listAuthorizedScopes"]
  >(async () => [scope]);
  const findModuleCatalog = vi.fn<VertexStore["findModuleCatalog"]>(
    async () => stored?.metadata ?? null
  );
  const getRights = vi.fn<VertexStore["getRights"]>(async () => rights);
  const getManifest = vi.fn<VertexArtifactStorage["getManifest"]>(
    async () => stored
  );
  const getContent = vi.fn<VertexArtifactStorage["getContent"]>(
    async () => null
  );
  const storage = vi.fn(
    () => ({ getManifest, getContent }) as unknown as VertexArtifactStorage
  );
  const mutate = vi.fn(async () => {
    throw new Error("Reads must not mutate");
  });
  const now = vi.fn((): string => NOW);
  const store = {
    findModuleCatalog,
    getRights,
    recordImmutable: mutate,
    recordReview: mutate,
    admitPaperSimulation: mutate,
  } as unknown as VertexStore;
  const dependencies: VertexExperienceDependencies = {
    store,
    authorization: {
      authorize,
      listAuthorizedScopes,
    } as unknown as VertexAuthorizationRepository,
    storage,
    clock: { now },
  };
  return {
    publish,
    authorize,
    listAuthorizedScopes,
    findModuleCatalog,
    getRights,
    getManifest,
    getContent,
    storage,
    mutate,
    now,
    dependencies,
    service: createVertexChartReadService(dependencies),
  };
};
type Harness = ReturnType<typeof harness>;

const expectReadError = async (
  operation: Promise<unknown>,
  code: keyof typeof VERTEX_READ_ERRORS
) => {
  await expect(operation).rejects.toBeInstanceOf(VertexReadServiceError);
  return await expect(operation).rejects.toMatchObject({
    code,
    message: VERTEX_READ_ERRORS[code].message,
  });
};
const read = (h: Harness, who: SafePrincipal = principal) =>
  h.service.modules(who, scope);

describe("scoped module catalog capability and authorization", () => {
  it("returns the authorized immutable catalog after fresh rights checks", async () => {
    const h = harness();
    await h.publish();
    expect(await read(h)).toEqual([]);
    expect(h.authorize.mock.calls.map(([grant]) => grant.resourceId)).toEqual([
      "account-scope",
      LOOKUP,
      ARTIFACT,
      ARTIFACT,
      "account-scope",
      LOOKUP,
    ]);
    for (const [grant] of h.authorize.mock.calls)
      expect(grant).toEqual({
        principal: { actorId: principal.userId },
        scope,
        resourceId: grant.resourceId,
        collectionId: null,
        action: "read",
        now: NOW,
      });
    expect(h.findModuleCatalog).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope
    );
    expect(h.getManifest).toHaveBeenCalledWith({
      principal: { actorId: principal.userId },
      scope,
      collectionId: null,
      artifactId: ARTIFACT,
    });
    expect(h.getRights).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      null,
      rights.policyId
    );
    expect(h.getContent).not.toHaveBeenCalled();
    expect(h.listAuthorizedScopes).not.toHaveBeenCalled();
    return expect(h.mutate).not.toHaveBeenCalled();
  });

  it("accepts read-only rights without retention and checked exactly now", async () => {
    const h = harness();
    await h.publish();
    h.getRights.mockResolvedValueOnce({
      ...rights,
      version: "2.0.0",
      allowedUses: ["read"],
      checkedAt: NOW,
      retentionUntil: null,
    });
    return expect(await read(h)).toEqual([]);
  });

  it("fails closed without real dependencies", async () => {
    const h = harness();
    await h.publish();
    for (const dependencies of [
      {},
      withoutDependency(h.dependencies, "store"),
      withoutDependency(h.dependencies, "authorization"),
      withoutDependency(h.dependencies, "clock"),
      withoutDependency(h.dependencies, "storage"),
    ]) {
      await expectReadError(
        createVertexChartReadService(dependencies).modules(principal, scope),
        "SERVICE_UNAVAILABLE"
      );
    }
    expect(h.getManifest).not.toHaveBeenCalled();
    return expect(h.getRights).not.toHaveBeenCalled();
  });

  it("validates input and principal before authorization or I/O", async () => {
    const h = harness();
    await h.publish();
    for (const raw of [
      {},
      { ...scope, environment: "production" },
      { ...scope, accountAlias: "../other" },
      { ...scope, role: "admin" },
      { ...scope, collectionId: null },
    ])
      await expectReadError(
        h.service.modules(principal, raw as never),
        "BAD_REQUEST"
      );
    expect(h.authorize).not.toHaveBeenCalled();
    await expectReadError(
      read(h, { ...principal, status: "suspended" }),
      "FORBIDDEN"
    );
    await expectReadError(
      read(h, { ...principal, userId: "../x" }),
      "BAD_REQUEST"
    );
    expect(h.authorize).not.toHaveBeenCalled();
    return expect(h.findModuleCatalog).not.toHaveBeenCalled();
  });

  it("denies admin too, before source/storage access", async () => {
    const h = harness();
    await h.publish();
    h.authorize.mockResolvedValue(false);
    await expectReadError(
      read(h, { ...principal, role: "admin" }),
      "FORBIDDEN"
    );
    for (const port of [h.findModuleCatalog, h.storage, h.getRights])
      expect(port).not.toHaveBeenCalled();
  });

  it("does not infer catalog rights from account authorization", async () => {
    const h = harness();
    await h.publish();
    h.authorize.mockImplementation(
      async (request) => request.resourceId === "account-scope"
    );
    await expectReadError(read(h), "FORBIDDEN");
    expect(h.findModuleCatalog).not.toHaveBeenCalled();
    expect(h.storage).not.toHaveBeenCalled();
    return expect(h.listAuthorizedScopes).not.toHaveBeenCalled();
  });

  it("denies an artifact grant before getManifest", async () => {
    const h = harness();
    await h.publish();
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== ARTIFACT
    );
    await expectReadError(read(h), "FORBIDDEN");
    return expect(h.getManifest).not.toHaveBeenCalled();
  });

  it("keeps an absent catalog distinct from unavailable ports", async () => {
    const h = harness();
    await expectReadError(read(h), "NOT_FOUND");
    expect(h.storage).not.toHaveBeenCalled();
    await h.publish();
    h.getManifest.mockResolvedValueOnce(null);
    await expectReadError(read(h), "NOT_FOUND");
    expect(h.getRights).not.toHaveBeenCalled();
    h.authorize.mockRejectedValueOnce(new Error("private provider response"));
    await expectReadError(read(h), "SERVICE_UNAVAILABLE");
    h.findModuleCatalog.mockRejectedValueOnce(new Error("private db text"));
    return await expectReadError(read(h), "SERVICE_UNAVAILABLE");
  });

  it("rejects a collection-bound catalog as forbidden before storage", async () => {
    const h = harness();
    await h.publish([], "fixture-collection");
    await expectReadError(read(h), "FORBIDDEN");
    return expect(h.storage).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { scope: { ...scope, accountAlias: "foreign" } } },
    { patch: { scope: { ...scope, environment: "live" } } },
    { patch: { contractName: "ResearchEvidence" } },
    { patch: { artifactSha256: "not-a-digest" } },
    { patch: { extra: true } },
  ] as const)("rejects wrong catalog binding $patch", async ({ patch }) => {
    const h = harness();
    const stored = await h.publish();
    h.findModuleCatalog.mockResolvedValueOnce({
      ...stored.metadata,
      ...patch,
    } as unknown as VertexArtifactMetadata);
    await expectReadError(read(h), "INVALID_SOURCE");
    return expect(h.storage).not.toHaveBeenCalled();
  });

  it("rejects invalid catalog bytes and envelopes", async () => {
    const duplicate = [{ moduleId: "a" }, { moduleId: "a" }];
    for (const value of [{ modules: [] }, duplicate, "[]"]) {
      const h = harness();
      await h.publish(value);
      await expectReadError(read(h), "INVALID_SOURCE");
      expect(h.getRights).not.toHaveBeenCalled();
    }
    const h = harness();
    const stored = await h.publish();
    h.getManifest.mockResolvedValueOnce({
      metadata: stored.metadata,
      bytes: new TextEncoder().encode("[ ]"),
    });
    return await expectReadError(read(h), "INVALID_SOURCE");
  });

  it.each([
    { code: "denied", expected: "FORBIDDEN" },
    { code: "integrity", expected: "INVALID_SOURCE" },
    { code: "too-large", expected: "INVALID_SOURCE" },
    { code: "invalid", expected: "BAD_REQUEST" },
    { code: "unavailable", expected: "SERVICE_UNAVAILABLE" },
    // CONFLICT is not part of the read vocabulary and is never reflected.
    { code: "conflict", expected: "SERVICE_UNAVAILABLE" },
  ] as const)(
    "sanitizes typed storage $code without changing read error vocabulary",
    async ({ code, expected }) => {
      const h = harness();
      await h.publish();
      h.getManifest.mockRejectedValueOnce(new VertexArtifactStorageError(code));
      return await expectReadError(read(h), expected);
    }
  );

  it("aborts before I/O and after awaited catalog reads", async () => {
    const h = harness();
    await h.publish();
    const controller = new AbortController();
    controller.abort();
    await expectReadError(
      createVertexChartReadService({
        ...h.dependencies,
        signal: controller.signal,
      }).modules(principal, scope),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.authorize).not.toHaveBeenCalled();
    const later = new AbortController();
    h.getManifest.mockImplementationOnce(async () => {
      later.abort();
      return null;
    });
    await expectReadError(
      createVertexChartReadService({
        ...h.dependencies,
        signal: later.signal,
      }).modules(principal, scope),
      "SERVICE_UNAVAILABLE"
    );
    return expect(h.getRights).not.toHaveBeenCalled();
  });
});

describe("fresh DB rights at delivery, not cached catalog rights", () => {
  it.each(["account-scope", LOOKUP, ARTIFACT])(
    "rechecks the %s grant after manifest I/O",
    async (resourceId) => {
      const h = harness();
      await h.publish();
      h.getManifest.mockImplementationOnce(async () => {
        const stored = await h.publish();
        h.authorize.mockImplementation(
          async (grant) => grant.resourceId !== resourceId
        );
        return stored;
      });
      await expectReadError(read(h), "FORBIDDEN");
      expect(h.getManifest).toHaveBeenCalledTimes(1);
      expect(h.authorize).toHaveBeenLastCalledWith({
        principal: { actorId: principal.userId },
        scope,
        resourceId,
        collectionId: null,
        action: "read",
        now: NOW,
      });
      expect(h.getRights).not.toHaveBeenCalled();
      return expect(h.mutate).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: "missing rights", current: null },
    { name: "denied status", current: { ...rights, status: "denied" } },
    { name: "expired status", current: { ...rights, status: "expired" } },
    { name: "unknown status", current: { ...rights, status: "unknown" } },
    { name: "policy mismatch", current: { ...rights, policyId: "foreign" } },
    { name: "no read use", current: { ...rights, allowedUses: ["store"] } },
    { name: "no uses", current: { ...rights, allowedUses: [] } },
    { name: "null expiresAt", current: { ...rights, expiresAt: null } },
    { name: "expired expiresAt", current: { ...rights, expiresAt: NOW } },
    {
      name: "expired retentionUntil",
      current: { ...rights, retentionUntil: NOW },
    },
    {
      name: "retention before now",
      current: { ...rights, retentionUntil: START },
    },
    { name: "checkedAt in future", current: { ...rights, checkedAt: AFTER } },
    {
      name: "checkedAt one nanosecond in future",
      current: { ...rights, checkedAt: "2026-09-21T14:01:01.000000001Z" },
    },
  ])("rejects $name after manifest I/O", async ({ current }) => {
    const h = harness();
    await h.publish();
    h.getRights.mockResolvedValueOnce(current as unknown as Rights);
    await expectReadError(read(h), "FORBIDDEN");
    return expect(h.getRights).toHaveBeenCalledTimes(1);
  });

  it("treats expiry one nanosecond after now as still current", async () => {
    const h = harness();
    await h.publish();
    h.getRights.mockResolvedValueOnce({
      ...rights,
      expiresAt: "2026-09-21T14:01:01.000000001Z",
      retentionUntil: "2026-09-21T14:01:01.000000001Z",
    });
    return expect(await read(h)).toEqual([]);
  });

  it.each([
    { ...rights, extraGrant: true },
    { ...rights, allowedUses: ["read", "read"] },
    { ...rights, allowedUses: ["execute"] },
    { ...rights, allowedUses: ["store", "read", "derive", "export", "read"] },
    { ...rights, version: "latest" },
    { ...rights, status: "revoked" },
    { ...rights, policyId: "../policy" },
    { ...rights, checkedAt: "not-a-timestamp" },
    { ...rights, expiresAt: "not-a-timestamp" },
    { ...rights, retentionUntil: "2026-13-01T00:00:00Z" },
    { ...rights, retentionUntil: undefined },
    "granted",
  ])(
    "rejects malformed fresh rights %j instead of stripping fields",
    async (current) => {
      const h = harness();
      await h.publish();
      h.getRights.mockResolvedValueOnce(current as unknown as Rights);
      await expectReadError(read(h), "INVALID_SOURCE");
      return expect(h.getRights).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects an invalid clock reading at delivery", async () => {
    const h = harness();
    await h.publish();
    h.getRights.mockImplementationOnce(async () => {
      h.now.mockReturnValue("not-a-timestamp");
      return rights;
    });
    return await expectReadError(read(h), "INVALID_SOURCE");
  });

  it.each([
    { code: "denied", expected: "FORBIDDEN" },
    { code: "unavailable", expected: "SERVICE_UNAVAILABLE" },
  ] as const)(
    "maps rights lookup failure $code without leaking port text",
    async ({ code, expected }) => {
      const h = harness();
      await h.publish();
      h.getRights.mockRejectedValueOnce(new VertexArtifactStorageError(code));
      await expectReadError(read(h), expected);
      h.getRights.mockRejectedValueOnce(new Error("private db text"));
      return await expectReadError(read(h), "SERVICE_UNAVAILABLE");
    }
  );
});

describe("read error mapping", () => {
  it("passes through an existing read service error unchanged", async () => {
    const h = harness();
    await h.publish();
    const original = new VertexReadServiceError("NOT_FOUND");
    h.getRights.mockImplementationOnce(async () => {
      h.now.mockImplementation(() => {
        throw original;
      });
      return rights;
    });
    return await expect(read(h)).rejects.toBe(original);
  });

  it.each([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "INVALID_SOURCE",
    "SERVICE_UNAVAILABLE",
  ] as const)("maps experience %s to the same read code", async (code) => {
    const h = harness();
    await h.publish();
    h.getRights.mockImplementationOnce(async () => {
      h.now.mockImplementation(() => {
        throw new VertexExperienceServiceError(code);
      });
      return rights;
    });
    return await expectReadError(read(h), code);
  });

  it.each([
    new VertexExperienceServiceError("CONFLICT"),
    new Error("private clock text"),
    "thrown string",
  ])("sanitizes %s to SERVICE_UNAVAILABLE", async (thrown) => {
    const h = harness();
    await h.publish();
    h.getRights.mockImplementationOnce(async () => {
      h.now.mockImplementation(() => {
        throw thrown;
      });
      return rights;
    });
    const operation = read(h);
    await expectReadError(operation, "SERVICE_UNAVAILABLE");
    return await expect(operation).rejects.not.toHaveProperty(
      "message",
      "private clock text"
    );
  });
});
