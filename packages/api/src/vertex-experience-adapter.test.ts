import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import type {
  VertexArtifactMetadata,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import type { StoragePort } from "@darkfactory/storage";
import type {
  VertexArtifactStorageDependencies,
  VertexManifestPut,
  VertexStorageAuthorization,
  VertexStorageRights,
} from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  authorization: vi.fn(),
  store: vi.fn(),
  metadata: vi.fn(),
  storage: vi.fn(),
  read: vi.fn(),
  nodeDatabase: vi.fn(),
  requestDatabase: vi.fn(),
}));
vi.mock("@darkfactory/db/server", () => ({
  createNodeDatabase: factories.nodeDatabase,
  createRequestDatabase: factories.requestDatabase,
}));
vi.mock("@darkfactory/db/server/vertex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@darkfactory/db/server/vertex")>();
  return {
    ...actual,
    createVertexAuthorization: factories.authorization,
    createVertexStore: factories.store,
    createVertexObjectMetadataRepository: factories.metadata,
  };
});
vi.mock("@darkfactory/storage/vertex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@darkfactory/storage/vertex")>();
  return {
    ...actual,
    createVertexArtifactStorage: factories.storage,
    createVertexReadPort: factories.read,
  };
});

import {
  createVertexRequestDependencies,
  vertexPersistenceBoundary,
  type VertexLegacyScopeLookup,
} from "./server/vertex-experience-adapter.ts";

const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const actor = Object.freeze({ actorId: principal.userId });
const scope: VertexScope = Object.freeze({
  accountAlias: "fixture-paper",
  environment: "paper",
});
const now = "2026-09-21T14:00:01Z";
const digest = "a".repeat(64);
const rights: VertexStorageRights = Object.freeze({
  policyId: "fixture-rights",
  version: "1.0.0",
  status: "granted",
  allowedUses: ["store", "read", "derive"] as const,
  checkedAt: now,
  expiresAt: "2026-09-21T14:10:00Z",
  retentionUntil: null,
});
const metadata: VertexArtifactMetadata = Object.freeze({
  artifactId: "agent-artifact-1",
  scope,
  collectionId: "collection-1",
  objectKey: "fixture/agent-artifact-1",
  artifactSha256: digest,
  sourceContentSha256: null,
  byteLength: 32,
  contentType: "application/json",
  schemaVersion: "1.0.0",
  contractName: "AgentRun",
  rights,
  lineageArtifactIds: ["evidence-artifact-1"],
  createdAt: now,
});
const manifestInput: VertexManifestPut = Object.freeze({
  principal: actor,
  scope,
  collectionId: "collection-1",
  artifactId: metadata.artifactId,
  contractName: "AgentRun",
  manifest: Object.freeze({ fixture: "factory routing only" }),
  artifactSha256: digest,
  sourceContentSha256: null,
  rightsPolicyId: rights.policyId,
  lineageArtifactIds: ["evidence-artifact-1"],
  createdAt: now,
});

const fixture = () => {
  const db = {
    execute: vi.fn(),
    transaction: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    end: vi.fn(),
    release: vi.fn(),
  };
  const clock = { now: vi.fn(() => now) };
  const authorization = {
    authorize: vi.fn(
      async (
        _request: Parameters<VertexStorageAuthorization["authorize"]>[0]
      ) => true
    ),
    listAuthorizedScopes: vi.fn(async () => [
      scope,
      { ...scope, accountAlias: "other-account" },
    ]),
    issueGrant: vi.fn(),
    revokeGrant: vi.fn(),
  };
  const store = {
    getRights: vi.fn(
      async (
        _principal: unknown,
        _scope: unknown,
        _collection: unknown,
        _policy: unknown
      ): Promise<VertexStorageRights | null> => rights
    ),
    registerArtifact: vi.fn(),
    recordImmutable: vi.fn(),
    putRights: vi.fn(),
  };
  const objectMetadata = {
    create: vi.fn(),
    findByKey: vi.fn(),
    removeByKey: vi.fn(),
  };
  const storage = {
    stageManifest: vi.fn(async (_input: VertexManifestPut) => metadata),
    putManifest: vi.fn(),
    getManifest: vi.fn(),
    putContent: vi.fn(),
    getContent: vi.fn(),
  };
  const read = {
    listModules: vi.fn(async () => null),
  };
  const objects = {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  } as unknown as StoragePort;
  const objectCapabilities = {
    putIfAbsent: vi.fn(),
    head: vi.fn(),
    getBounded: vi.fn(),
  };
  factories.authorization.mockReturnValue(authorization);
  factories.store.mockReturnValue(store);
  factories.metadata.mockReturnValue(objectMetadata);
  factories.storage.mockReturnValue(storage);
  factories.read.mockReturnValue(read);
  const options = {
    db: db as unknown as Database,
    clock,
    objects,
    objectCapabilities,
    maximumContentBytes: 4096,
    maxProjectionAgeMs: 5000,
  };
  return {
    db,
    clock,
    authorization,
    store,
    objectMetadata,
    storage,
    read,
    objects,
    objectCapabilities,
    options,
  };
};

const noLifecycle = (h: ReturnType<typeof fixture>) => {
  for (const fn of [
    h.db.execute,
    h.db.transaction,
    h.db.connect,
    h.db.close,
    h.db.end,
    h.db.release,
    factories.nodeDatabase,
    factories.requestDatabase,
  ])
    expect(fn).not.toHaveBeenCalled();
};

const storageDependencies = (): VertexArtifactStorageDependencies =>
  factories.storage.mock.calls.at(-1)?.[0] as VertexArtifactStorageDependencies;

describe("Vertex request-scoped adapter", () => {
  beforeEach(() => vi.resetAllMocks());

  it("borrows exactly the request database for authorization, store and scoped object metadata", () => {
    const h = fixture();
    const deps = createVertexRequestDependencies(h.options);
    expect(deps.vertexExperience.store).toBe(h.store);
    expect(deps.vertexExperience.authorization).toBe(h.authorization);
    expect(deps.vertexExperience.clock).toBe(h.clock);
    expect(factories.authorization).toHaveBeenCalledExactlyOnceWith(h.db, {
      clock: h.clock,
    });
    expect(factories.store).toHaveBeenCalledExactlyOnceWith(h.db, {
      authorization: h.authorization,
      boundary: vertexPersistenceBoundary,
      clock: h.clock,
      maxProjectionAgeMs: 5000,
    });
    expect(deps.vertexExperience.storage?.(actor, scope, "collection-1")).toBe(
      h.storage
    );
    expect(factories.metadata).toHaveBeenCalledExactlyOnceWith(h.db, {
      principal: actor,
      scope,
      collectionId: "collection-1",
      authorization: h.authorization,
      clock: h.clock,
      maximumContentBytes: 4096,
    });
    const bound = storageDependencies();
    expect(bound.objects).toBe(h.objects);
    expect(bound.objectCapabilities).toBe(h.objectCapabilities);
    expect(bound.metadata).toBe(h.objectMetadata);
    expect(bound.catalog).toBe(h.store);
    expect(bound.boundary).toBe(vertexPersistenceBoundary);
    expect(bound.clock).toBe(h.clock);
    expect(bound.maximumContentBytes).toBe(4096);
    expect(Object.isFrozen(deps)).toBe(true);
    return noLifecycle(h);
  });

  it("does not construct a scoped object backend while constructing request or storage dependencies", () => {
    const h = fixture();
    const objectsForScope = vi.fn(async () => ({
      objects: h.objects,
      objectCapabilities: h.objectCapabilities,
    }));
    const controller = new AbortController();
    const deps = createVertexRequestDependencies({
      ...h.options,
      objectsForScope,
      signal: controller.signal,
    });
    expect(objectsForScope).not.toHaveBeenCalled();
    deps.vertexExperience.storage?.(actor, scope, "collection-1");
    const bound = storageDependencies();
    expect(bound.objectCapabilities).toEqual({
      head: expect.any(Function),
      getBounded: expect.any(Function),
      putIfAbsent: expect.any(Function),
    });
    expect(objectsForScope).not.toHaveBeenCalled();
    for (const fn of Object.values(h.objectCapabilities))
      expect(fn).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("stages immutable manifest bytes without publishing a catalog alias or touching a pool", async () => {
    const h = fixture();
    const deps = createVertexRequestDependencies(h.options);
    await expect(
      deps.vertexExperience.prepareManifest?.(manifestInput)
    ).resolves.toBe(metadata);
    expect(h.storage.stageManifest).toHaveBeenCalledExactlyOnceWith(
      manifestInput
    );
    expect(h.storage.putManifest).not.toHaveBeenCalled();
    expect(h.store.registerArtifact).not.toHaveBeenCalled();
    expect(h.store.recordImmutable).not.toHaveBeenCalled();
    expect(factories.metadata).toHaveBeenCalledWith(
      h.db,
      expect.objectContaining({
        principal: actor,
        scope,
        collectionId: "collection-1",
      })
    );
    return noLifecycle(h);
  });

  it("propagates failed staging without catalog publication, cleanup or resource ownership", async () => {
    const h = fixture();
    const error = new Error("Synthetic staging failure");
    h.storage.stageManifest.mockRejectedValueOnce(error);
    const deps = createVertexRequestDependencies(h.options);
    await expect(
      deps.vertexExperience.prepareManifest?.(manifestInput)
    ).rejects.toBe(error);
    expect(h.storage.putManifest).not.toHaveBeenCalled();
    expect(h.store.registerArtifact).not.toHaveBeenCalled();
    expect(h.store.recordImmutable).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("resolves current rights through the real scoped store callback on every request", async () => {
    const h = fixture();
    const deps = createVertexRequestDependencies(h.options);
    deps.vertexExperience.storage?.(actor, scope, "collection-1");
    const resolveRights = storageDependencies().rights!.resolveRights;
    await expect(
      resolveRights(actor, scope, "collection-1", "fixture-rights")
    ).resolves.toBe(rights);
    const denied: VertexStorageRights = {
      ...rights,
      status: "denied",
      allowedUses: [],
    };
    h.store.getRights.mockResolvedValueOnce(denied);
    await expect(
      resolveRights(actor, scope, "collection-1", "fixture-rights")
    ).resolves.toBe(denied);
    h.store.getRights.mockResolvedValueOnce(null);
    await expect(
      resolveRights(actor, scope, "collection-1", "fixture-rights")
    ).resolves.toBeNull();
    expect(h.store.getRights).toHaveBeenCalledTimes(3);
    for (const call of h.store.getRights.mock.calls)
      expect(call).toEqual([actor, scope, "collection-1", "fixture-rights"]);
    expect(h.store.putRights).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("forwards exact read and publish authorization, never upgrades read into export", async () => {
    const h = fixture();
    const deps = createVertexRequestDependencies(h.options);
    deps.vertexExperience.storage?.(actor, scope, "collection-1");
    const authorize = storageDependencies().authorization!.authorize;
    const read = {
      principal: actor,
      scope,
      collectionId: "collection-1",
      resourceId: "artifact-1",
      action: "read" as const,
      now,
    };
    await expect(authorize(read)).resolves.toBe(true);
    expect(h.authorization.authorize).toHaveBeenLastCalledWith(read);
    const publish = { ...read, action: "publish" as const };
    h.authorization.authorize.mockResolvedValueOnce(false);
    await expect(authorize(publish)).resolves.toBe(false);
    expect(h.authorization.authorize).toHaveBeenLastCalledWith(publish);
    await expect(authorize({ ...read, action: "export" })).resolves.toBe(false);
    expect(h.authorization.authorize).toHaveBeenCalledTimes(2);
    expect(h.authorization.issueGrant).not.toHaveBeenCalled();
    expect(h.authorization.revokeGrant).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("never invents a legacy scope from the first granted account or installs privileged grants", () => {
    const h = fixture();
    const deps = createVertexRequestDependencies(h.options);
    expect(deps.vertexRead).toBeUndefined();
    expect(h.authorization.listAuthorizedScopes).not.toHaveBeenCalled();
    expect(factories.authorization.mock.calls[0]?.[1]).toEqual({
      clock: h.clock,
    });
    expect(factories.read).not.toHaveBeenCalled();
    expect(h.authorization.issueGrant).not.toHaveBeenCalled();
    expect(h.authorization.revokeGrant).not.toHaveBeenCalled();
    expect(h.store.putRights).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("preserves explicitly configured capabilities and cancellation without contacting them", () => {
    const h = fixture();
    const reviewPolicy = {
      version: "1.0.0",
      reviewVersion: "1.0.0",
      ttlMilliseconds: 60_000,
    };
    const research = {
      available: vi.fn(),
      taskContract: "research-task",
      modelVersion: "fixture-model",
      tokenBudget: 100,
      costBudgetUsd: "0.01",
      rightsPolicyId: "fixture-rights",
      allowedTools: ["read-evidence"] as const,
    };
    const simulation = {
      available: vi.fn(),
      simulatorId: "paper-simulator",
      maximumLoss: "1",
      maximumNotional: "10",
      ttlMilliseconds: 1000,
    };
    const gateway = {
      listBindings: vi.fn(),
      resolveScope: vi.fn(),
      readStatus: vi.fn(),
    };
    const controller = new AbortController();
    const deps = createVertexRequestDependencies({
      ...h.options,
      reviewPolicy,
      research,
      simulation,
      gateway,
      signal: controller.signal,
    });
    for (const [key, value] of Object.entries({
      reviewPolicy,
      research,
      simulation,
      gateway,
      signal: controller.signal,
    }))
      expect(
        deps.vertexExperience[key as keyof typeof deps.vertexExperience]
      ).toBe(value);
    for (const fn of [
      research.available,
      simulation.available,
      gateway.resolveScope,
      gateway.readStatus,
    ])
      expect(fn).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("uses bounded defaults without silently enabling absent capabilities", () => {
    const h = fixture();
    const deps = createVertexRequestDependencies({
      db: h.options.db,
      clock: h.clock,
    });
    expect(factories.store).toHaveBeenCalledWith(h.db, {
      authorization: h.authorization,
      boundary: vertexPersistenceBoundary,
      clock: h.clock,
      maxProjectionAgeMs: 60_000,
    });
    deps.vertexExperience.storage?.(actor, scope, null);
    expect(storageDependencies()).not.toHaveProperty("maximumContentBytes");
    expect(factories.metadata.mock.calls[0]?.[1]).not.toHaveProperty(
      "maximumContentBytes"
    );
    for (const key of [
      "reviewPolicy",
      "research",
      "simulation",
      "gateway",
      "signal",
    ])
      expect(deps.vertexExperience).not.toHaveProperty(key);
    return noLifecycle(h);
  });

  it("binds scoped object capabilities lazily and fails closed on absent ports or cancellation", async () => {
    const h = fixture();
    const head = vi.fn(async () => ({ status: "not-found" }) as const);
    const scoped = {
      objects: h.objects,
      objectCapabilities: { head },
    };
    const objectsForScope = vi.fn(async () => scoped);
    const controller = new AbortController();
    const deps = createVertexRequestDependencies({
      ...h.options,
      objectsForScope,
      signal: controller.signal,
    });
    deps.vertexExperience.storage?.(actor, scope, "collection-1");
    const bound = storageDependencies();
    expect(objectsForScope).not.toHaveBeenCalled();
    for (const operation of [
      bound.objects?.put,
      bound.objects?.get,
      bound.objects?.delete,
    ])
      await expect(
        (operation as unknown as () => Promise<unknown>)()
      ).resolves.toEqual({ status: "unavailable", state: "unconfigured" });
    await expect(bound.objectCapabilities?.head?.("key-1")).resolves.toEqual({
      status: "not-found",
    });
    expect(head).toHaveBeenCalledExactlyOnceWith("key-1");
    await expect(
      bound.objectCapabilities?.getBounded?.("key-1", 10)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      bound.objectCapabilities?.putIfAbsent?.({} as never)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(objectsForScope).toHaveBeenCalledExactlyOnceWith(
      scope,
      "collection-1",
      controller.signal
    );
    controller.abort();
    await expect(
      bound.objectCapabilities?.head?.("key-1")
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(head).toHaveBeenCalledTimes(1);
    expect(objectsForScope).toHaveBeenCalledTimes(1);
    return noLifecycle(h);
  });

  it("forwards present scoped bounded-read and put-if-absent ports", async () => {
    const h = fixture();
    const getBounded = vi.fn(async () => ({ status: "not-found" }) as const);
    const putIfAbsent = vi.fn(async () => ({ status: "not-found" }) as const);
    const deps = createVertexRequestDependencies({
      ...h.options,
      objectsForScope: () => ({
        objects: h.objects,
        objectCapabilities: { getBounded, putIfAbsent },
      }),
    });
    deps.vertexExperience.storage?.(actor, scope, null);
    const bound = storageDependencies();
    const input = { key: "key-1" } as never;
    await bound.objectCapabilities?.getBounded?.("key-1", 10);
    await bound.objectCapabilities?.putIfAbsent?.(input);
    expect(getBounded).toHaveBeenCalledExactlyOnceWith("key-1", 10);
    expect(putIfAbsent).toHaveBeenCalledExactlyOnceWith(input);
    await expect(
      bound.objectCapabilities?.head?.("key-1")
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    return noLifecycle(h);
  });

  it("defaults to a real ISO clock only when none is supplied", () => {
    const h = fixture();
    createVertexRequestDependencies({ db: h.options.db });
    const clock = factories.authorization.mock.calls[0]?.[1]?.clock;
    expect(clock).not.toBe(h.clock);
    const value = clock.now();
    expect(new Date(value).toISOString()).toBe(value);
    return noLifecycle(h);
  });
});

describe("Vertex explicit legacy read adapter", () => {
  beforeEach(() => vi.resetAllMocks());

  it("authorizes the authenticated user and freezes each lookup to the server-selected account", async () => {
    const h = fixture();
    const selected = { scope: { ...scope }, collectionId: null };
    const legacyScope = vi.fn(
      async (_principal: SafePrincipal, _lookup: VertexLegacyScopeLookup) =>
        selected
    );
    const deps = createVertexRequestDependencies({ ...h.options, legacyScope });
    expect(Object.keys(deps.vertexRead?.read ?? {})).toEqual(["listModules"]);
    expect(Object.keys(deps.vertexRead?.authorization ?? {})).toEqual([
      "canListModules",
    ]);
    await deps.vertexRead?.read?.listModules(principal);
    expect(legacyScope).toHaveBeenCalledExactlyOnceWith(principal, {
      kind: "modules",
    });
    expect(h.authorization.authorize).toHaveBeenCalledWith({
      principal: actor,
      scope,
      collectionId: null,
      resourceId: "account-scope",
      action: "read",
      now,
    });
    expect(h.read.listModules).toHaveBeenCalledExactlyOnceWith(principal);
    const bound = factories.read.mock.calls[0]?.[0];
    expect(bound.mapPrincipal(principal)).toEqual(actor);
    expect(bound.mapPrincipal({ ...principal, role: "admin" })).toEqual(actor);
    selected.scope.accountAlias = "switched-account";
    await expect(
      bound.resolveScope(principal, { kind: "modules" })
    ).resolves.toEqual({ scope, collectionId: null });
    expect(legacyScope).toHaveBeenCalledTimes(1);
    expect(bound.catalog).toBe(h.store);
    expect(bound.metadata).toBe(h.objectMetadata);
    expect(factories.metadata).toHaveBeenCalledWith(
      h.db,
      expect.objectContaining({
        principal: actor,
        scope,
        collectionId: null,
      })
    );
    await expect(
      bound.rights.resolveRights(actor, scope, null, "fixture-rights")
    ).resolves.toBe(rights);
    expect(h.store.getRights).toHaveBeenCalledWith(
      actor,
      scope,
      null,
      "fixture-rights"
    );
    return noLifecycle(h);
  });

  it("authorizes the exact module catalog resource after the account grant", async () => {
    const h = fixture();
    const legacyScope = vi.fn(
      async (_principal: SafePrincipal, _lookup: VertexLegacyScopeLookup) => ({
        scope,
        collectionId: null,
      })
    );
    const deps = createVertexRequestDependencies({ ...h.options, legacyScope });
    await expect(
      deps.vertexRead?.authorization?.canListModules(principal)
    ).resolves.toBe(true);
    expect(legacyScope).toHaveBeenCalledExactlyOnceWith(principal, {
      kind: "modules",
    });
    expect(
      h.authorization.authorize.mock.calls.map(([request]) => request)
    ).toEqual([
      {
        principal: actor,
        scope,
        collectionId: null,
        resourceId: "account-scope",
        action: "read",
        now,
      },
      {
        principal: actor,
        scope,
        collectionId: null,
        resourceId: "modules",
        action: "read",
        now,
      },
    ]);
    expect(h.authorization.listAuthorizedScopes).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("denies a missing scoped grant even for an admin instead of returning a reader", async () => {
    const h = fixture();
    h.authorization.authorize.mockResolvedValue(false);
    const deps = createVertexRequestDependencies({
      ...h.options,
      legacyScope: async () => ({ scope, collectionId: null }),
    });
    await expect(
      deps.vertexRead?.read?.listModules({ ...principal, role: "admin" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deps.vertexRead?.authorization?.canListModules({
        ...principal,
        role: "admin",
      })
    ).resolves.toBe(false);
    expect(factories.read).not.toHaveBeenCalled();
    expect(factories.metadata).not.toHaveBeenCalled();
    expect(h.authorization.issueGrant).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("does not treat an account grant as a module catalog grant", async () => {
    const h = fixture();
    h.authorization.authorize.mockImplementation(
      async (request) => request.resourceId === "account-scope"
    );
    const deps = createVertexRequestDependencies({
      ...h.options,
      legacyScope: async () => ({ scope, collectionId: null }),
    });
    await expect(
      deps.vertexRead?.authorization?.canListModules(principal)
    ).resolves.toBe(false);
    return noLifecycle(h);
  });

  it("fails closed on a collection-scoped module catalog", async () => {
    const h = fixture();
    const deps = createVertexRequestDependencies({
      ...h.options,
      legacyScope: async () => ({
        scope,
        collectionId: "collection-1",
      }),
    });
    await expect(
      deps.vertexRead?.read?.listModules(principal)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deps.vertexRead?.authorization?.canListModules(principal)
    ).resolves.toBe(false);
    expect(factories.read).not.toHaveBeenCalled();
    expect(
      h.authorization.authorize.mock.calls.map(
        ([request]) => request.resourceId
      )
    ).not.toContain("modules");
    return noLifecycle(h);
  });

  it("propagates resolver failures instead of converting them into a deny", async () => {
    const h = fixture();
    const failure = new Error("synthetic resolver outage");
    const deps = createVertexRequestDependencies({
      ...h.options,
      legacyScope: async () => {
        throw failure;
      },
    });
    await expect(
      deps.vertexRead?.authorization?.canListModules(principal)
    ).rejects.toBe(failure);
    await expect(deps.vertexRead?.read?.listModules(principal)).rejects.toBe(
      failure
    );
    expect(h.authorization.authorize).not.toHaveBeenCalled();
    expect(factories.read).not.toHaveBeenCalled();
    return noLifecycle(h);
  });

  it("routes the scope-less module read only after an explicit trusted resolver", async () => {
    const h = fixture();
    const legacyScope = vi.fn(async () => ({ scope, collectionId: null }));
    const deps = createVertexRequestDependencies({ ...h.options, legacyScope });
    await deps.vertexRead?.read?.listModules(principal);
    expect(legacyScope).toHaveBeenCalledExactlyOnceWith(principal, {
      kind: "modules",
    });
    expect(h.read.listModules).toHaveBeenCalledExactlyOnceWith(principal);
    return noLifecycle(h);
  });
});

describe("Vertex persistence boundary", () => {
  it("hashes canonical UTF-8 bytes and rejects unsupported versions instead of coercing", async () => {
    const value = { z: "café", a: 1 };
    const bytes = vertexPersistenceBoundary.encode(value);
    expect(new TextDecoder().decode(bytes)).toBe(canonicalArtifactJson(value));
    await expect(vertexPersistenceBoundary.digest(bytes)).resolves.toBe(
      await hashArtifact(bytes)
    );
    return await expect(
      vertexPersistenceBoundary.validate("AgentRun", {}, "2.0.0" as "1.0.0")
    ).rejects.toThrow("Unsupported Vertex schema");
  });

  it("parses a canonical nonexecutable AgentRun rather than using a permissive boundary", async () => {
    const record = {
      schemaVersion: "1.0.0",
      runId: "run-1",
      agentRole: "research",
      taskContract: "research-task",
      allowedTools: ["read-evidence"],
      modelVersion: "fixture-model",
      inputEvidenceIds: ["evidence-1"],
      outputArtifactIds: [],
      tokenBudget: 100,
      costBudgetUsd: "0.01",
      status: "queued",
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    };
    await expect(
      vertexPersistenceBoundary.validate("AgentRun", record, "1.0.0")
    ).resolves.toEqual(record);
    await expect(
      vertexPersistenceBoundary.validate(
        "AgentRun",
        { ...record, executionAuthorized: true },
        "1.0.0"
      )
    ).rejects.toThrow();
    return await expect(
      vertexPersistenceBoundary.validate(
        "AgentRun",
        { ...record, allowedTools: ["submit-order"] },
        "1.0.0"
      )
    ).rejects.toThrow();
  });

  it("validates decoded NativeJournalProof shape without pretending to bind projection and raw bytes", async () => {
    const proof = {
      schemaVersion: "1.0.0",
      proofKind: "native-journal-event",
      ...scope,
      streamId: "stream-1",
      ownerEpoch: "1",
      sourceEventId: "native-event-1",
      journalSequence: "2",
      journalHeadHash: digest,
      // One durable native transition may prove up to 64 ordered facts.
      factOrdinal: 0,
      occurredAt: now,
      eventType: "checkpoint",
      payload: {
        kind: "checkpoint",
        snapshotId: "snapshot-1",
        snapshotSha256: digest,
        journalSequence: "2",
        journalHeadHash: digest,
      },
    };
    // This one-value boundary is not parseNativeJournalProof(projection, bytes).
    // appendNativeFactProjection owns the independent exact outer/hash binding.
    const decoded = await vertexPersistenceBoundary.validate(
      "NativeJournalProof",
      proof,
      "1.0.0"
    );
    expect(decoded).toEqual(proof);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(
      new TextDecoder().decode(vertexPersistenceBoundary.encode(decoded))
    ).toBe(canonicalArtifactJson(proof));
    await expect(
      vertexPersistenceBoundary.validate(
        "NativeJournalProof",
        { ...proof, eventType: "kill-state" },
        "1.0.0"
      )
    ).rejects.toThrow();
    expect(factories.nodeDatabase).not.toHaveBeenCalled();
    return expect(factories.requestDatabase).not.toHaveBeenCalled();
  });

  it("rejects unsupported research chat inputs and malformed native projections", async () => {
    const validateInput = vertexPersistenceBoundary.validateResearchChatInput;
    expect(validateInput).toBeTypeOf("function");
    await expect(validateInput?.("deleteThread" as never, {})).rejects.toThrow(
      "Unsupported research chat input"
    );
    for (const name of ["ExecutionProjection", "NativeFactProjection"] as const)
      await expect(
        vertexPersistenceBoundary.validate(name, {}, "1.0.0")
      ).rejects.toThrow();
  });
});
