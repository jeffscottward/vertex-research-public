import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import type {
  ObjectMetadata,
  ObjectMetadataRepository,
  PutObjectInput,
  StoragePort,
  StorageResult,
  StoredObject,
} from "@darkfactory/storage";
import {
  MAX_VERTEX_STORAGE_BYTES,
  VertexArtifactStorageError,
  createVertexArtifactStorage,
  createVertexReadPort,
  vertexQualifiedObjectKey,
  type VertexArtifactRequest,
  type VertexArtifactStorageDependencies,
  type VertexManifestPut,
  type VertexObjectCapabilities,
  type VertexReadCatalog,
  type VertexReadPortDependencies,
  type VertexStorageArtifactMetadata,
  type VertexStorageAuthorization,
  type VertexStorageBoundary,
  type VertexStoragePrincipal,
  type VertexStorageRights,
  type VertexStorageScope,
} from "@darkfactory/storage/vertex";

import {
  DatasetManifestSchema,
  ModuleManifestSchema,
  ResearchEvidenceSchema,
  NativeJournalProofSchema,
  computeNativeFactProjectionHash,
  parseNativeFactProjection,
} from "./vertex.ts";
import { scaledTimeout } from "../../../scripts/lib/test-timeout-scale.ts";

// Synthetic implementations exist only in this test file. No implicit provider,
// global repository, clock, authorization, random source or network is used.
const principal: VertexStoragePrincipal = Object.freeze({
  actorId: "fixture-actor",
});
const scope: VertexStorageScope = Object.freeze({
  accountAlias: "fixture-account",
  environment: "research",
});
const collectionId = "fixture-collection";
const now = "2026-09-22T10:00:00.123456789Z";
const createdAt = "2026-09-22T09:00:00Z";
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const keyForAlias = (
  account: VertexStorageScope,
  collection: string | null,
  id: string
): string =>
  canonicalArtifactJson([
    account.accountAlias,
    account.environment,
    collection,
    id,
  ]);
const sameScope = (
  left: VertexStorageScope,
  right: VertexStorageScope
): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
const cloneMetadata = (metadata: ObjectMetadata): ObjectMetadata => ({
  ...metadata,
});
const cloneObject = (stored: StoredObject): StoredObject => ({
  metadata: cloneMetadata(stored.metadata),
  body: new Uint8Array(stored.body),
});

const datasetValue = (sourceHash: string) => ({
  schemaVersion: "1.0.0",
  datasetId: "dataset-1",
  provider: "fixture-provider",
  entitlementPolicyId: "fixture-rights",
  instrumentUniverse: ["fixture-instrument"],
  startAtInclusive: "2026-09-20T14:00:00Z",
  endAtExclusive: "2026-09-21T14:00:00Z",
  captureTime: "2026-09-21T14:00:01.123456789Z",
  asOfAt: "2026-09-21T14:00:00.123456789Z",
  dataVintageId: "vintage-1",
  dataVintageStatus: "available",
  adjustmentMethod: "unadjusted",
  calendar: "XNYS",
  contentHash: sourceHash,
  storageRef: "fixture-source",
  retentionPolicy: "fixture-retention",
  sources: [
    {
      provider: "fixture-provider",
      sourceId: "source-1",
      snapshotId: "snapshot-1",
      contentHash: sourceHash,
    },
  ],
  gammaProvenance: null,
});
const evidenceValue = (sourceHash: string) => ({
  schemaVersion: "1.0.0",
  collectionId,
  evidenceId: "evidence-1",
  snapshotId: "snapshot-1",
  sourceType: "paper",
  sourceUri: "https://example.test/paper",
  sourceIdentity: {
    provider: "fixture-provider",
    sourceId: "source-1",
    snapshotId: "snapshot-1",
    contentHash: sourceHash,
  },
  sourceLocator: "page 1",
  attribution: "Synthetic test author",
  publishedAt: "2026-09-20T14:00:00Z",
  capturedAt: "2026-09-21T14:00:00.123456789Z",
  contentHash: sourceHash,
  claim: "Synthetic fixture claim",
  method: "Fixture only",
  limitations: ["Not real research"],
  acceptanceStatus: "unreviewed",
  rightsPolicyId: "fixture-rights",
  untrustedContent: true,
});
const moduleValue = {
  schemaVersion: "1.0.0",
  moduleId: "fixture-module",
  version: "1.0.0",
  inputSchemaVersion: "1.0.0",
  outputSchemaVersion: "1.0.0",
  capabilities: ["research"],
  dataRequirements: [],
  supportedInstruments: ["equity"],
  riskPolicyVersion: "1.0.0",
  artifactDigest: "a".repeat(64),
  lifecycleState: "unavailable",
  runtime: "python-external",
  reasonCodes: ["synthetic-test-only"],
};

const harness = async () => {
  const blobs = new Map<string, StoredObject>();
  const objectMetadata = new Map<string, ObjectMetadata>();
  const aliases = new Map<string, VertexStorageArtifactMetadata>();
  const state: { now: string; rights: VertexStorageRights | null } = {
    now,
    rights: {
      policyId: "fixture-rights",
      version: "1.0.0",
      status: "granted",
      allowedUses: ["store", "read", "export"],
      checkedAt: "2026-09-22T08:00:00Z",
      expiresAt: "2026-09-23T10:00:00Z",
      retentionUntil: "2026-09-24T10:00:00Z",
    },
  };
  const putIfAbsent = vi.fn(
    async (input: PutObjectInput): Promise<StorageResult<ObjectMetadata>> => {
      const previous = blobs.get(input.key);
      if (previous)
        return { status: "ok", value: cloneMetadata(previous.metadata) };
      const metadata: ObjectMetadata = {
        key: input.key,
        size: input.body.byteLength,
        contentType: input.contentType,
        checksum: input.checksum,
        createdAt: state.now,
        updatedAt: state.now,
      };
      blobs.set(input.key, { metadata, body: new Uint8Array(input.body) });
      return { status: "ok", value: cloneMetadata(metadata) };
    }
  );
  const head = vi.fn(
    async (key: string): Promise<StorageResult<ObjectMetadata>> => {
      const stored = blobs.get(key);
      return stored
        ? { status: "ok", value: cloneMetadata(stored.metadata) }
        : { status: "not-found" };
    }
  );
  const getBounded = vi.fn(
    async (
      key: string,
      maximumBytes: number
    ): Promise<StorageResult<StoredObject>> => {
      const stored = blobs.get(key);
      if (!stored) return { status: "not-found" };
      if (stored.body.byteLength > maximumBytes)
        throw new Error("synthetic bounded read refused");
      return { status: "ok", value: cloneObject(stored) };
    }
  );
  const objects: StoragePort = {
    put: vi.fn(async () => {
      throw new Error("unsafe overwrite must never be called");
    }),
    get: vi.fn(async () => {
      throw new Error("unbounded get must never be called");
    }),
    delete: vi.fn(async () => {
      throw new Error("shared object deletion must never be called");
    }),
  };
  const metadata: ObjectMetadataRepository = {
    upsert: vi.fn(async (item: ObjectMetadata): Promise<void> => {
      objectMetadata.set(item.key, cloneMetadata(item));
    }),
    findByKey: vi.fn(async (key) => {
      const item = objectMetadata.get(key);
      return item ? cloneMetadata(item) : null;
    }),
    deleteByKey: vi.fn(async () => {
      throw new Error("metadata rollback must never be called");
    }),
  };
  const payloadFor = (
    item: VertexStorageArtifactMetadata
  ): Record<string, unknown> => {
    const object = blobs.get(item.objectKey);
    if (!object) throw new Error("synthetic missing manifest");
    return JSON.parse(new TextDecoder().decode(object.body)) as Record<
      string,
      unknown
    >;
  };
  const catalog: VertexReadCatalog = {
    registerArtifact: vi.fn(async (_actor, item) => {
      const key = keyForAlias(item.scope, item.collectionId, item.artifactId);
      const previous = aliases.get(key);
      if (previous) {
        if (canonicalArtifactJson(previous) !== canonicalArtifactJson(item))
          throw new VertexArtifactStorageError("conflict");
        return "duplicate" as const;
      }
      aliases.set(
        key,
        JSON.parse(canonicalArtifactJson(item)) as VertexStorageArtifactMetadata
      );
      return "recorded" as const;
    }),
    findArtifact: vi.fn(
      async (_actor, account, collection, id) =>
        aliases.get(keyForAlias(account, collection, id)) ?? null
    ),
    findDataset: vi.fn(
      async (_actor, account, id) =>
        [...aliases.values()].find(
          (item) =>
            sameScope(item.scope, account) &&
            item.contractName === "DatasetManifest" &&
            payloadFor(item)["datasetId"] === id
        ) ?? null
    ),
    findEvidence: vi.fn(
      async (_actor, account, collection, id) =>
        [...aliases.values()].find(
          (item) =>
            sameScope(item.scope, account) &&
            item.collectionId === collection &&
            item.contractName === "ResearchEvidence" &&
            payloadFor(item)["evidenceId"] === id
        ) ?? null
    ),
    findModuleCatalog: vi.fn(
      async (_actor, account) =>
        [...aliases.values()].find(
          (item) =>
            sameScope(item.scope, account) &&
            item.collectionId === null &&
            item.contractName === "ModuleManifestList"
        ) ?? null
    ),
  };
  const authorization: VertexStorageAuthorization = {
    authorize: vi.fn(async () => true),
  };
  const rights = { resolveRights: vi.fn(async () => state.rights) };
  const boundary: VertexStorageBoundary = {
    encode,
    digest: vi.fn(hashArtifact),
    validate: vi.fn(async (contractName, payload, version) => {
      if (version !== "1.0.0") throw new Error("unsupported schema");
      if (contractName === "DatasetManifest")
        return DatasetManifestSchema.parse(payload);
      if (contractName === "ResearchEvidence")
        return ResearchEvidenceSchema.parse(payload);
      if (contractName === "ModuleManifest")
        return ModuleManifestSchema.parse(payload);
      if (contractName === "NativeFactProjection")
        return parseNativeFactProjection(payload);
      if (contractName === "NativeJournalProof")
        return NativeJournalProofSchema.parse(payload);
      throw new Error(
        "test validator deliberately does not support other public contracts"
      );
    }),
  };
  const capabilities: VertexObjectCapabilities = {
    putIfAbsent,
    head,
    getBounded,
  };
  const dependencies: VertexArtifactStorageDependencies = {
    objects,
    objectCapabilities: capabilities,
    metadata,
    catalog,
    rights,
    authorization,
    boundary,
    clock: { now: () => state.now },
  };
  const sourceBytes = new TextEncoder().encode(
    "Synthetic source content; no provider or trading data."
  );
  const sourceContentSha256 = await hashArtifact(sourceBytes);
  const dataset = datasetValue(sourceContentSha256);
  const evidence = evidenceValue(sourceContentSha256);
  const request: VertexArtifactRequest = {
    principal,
    scope,
    collectionId,
    artifactId: "dataset-artifact-1",
  };
  const input: VertexManifestPut = {
    ...request,
    contractName: "DatasetManifest",
    manifest: dataset,
    artifactSha256: await hashArtifact(encode(dataset)),
    sourceContentSha256,
    sourceBytes,
    rightsPolicyId: "fixture-rights",
    lineageArtifactIds: [],
    createdAt,
  };
  type ApiPrincipal = Readonly<{
    userId: string;
    role: string;
    status: string;
  }>;
  const readerDependencies: VertexReadPortDependencies<ApiPrincipal> = {
    ...dependencies,
    catalog,
    mapPrincipal: vi.fn(async (user) => ({ actorId: user.userId })),
    resolveScope: vi.fn(async () => ({ scope, collectionId: null })),
  };
  return {
    blobs,
    objectMetadata,
    aliases,
    state,
    objects,
    metadata,
    catalog,
    authorization,
    rights,
    boundary,
    capabilities,
    putIfAbsent,
    head,
    getBounded,
    dependencies,
    sourceBytes,
    sourceContentSha256,
    dataset,
    evidence,
    request,
    input,
    readerDependencies,
    apiPrincipal: {
      userId: principal.actorId,
      role: "member",
      status: "active",
    },
    storage: createVertexArtifactStorage(dependencies),
    reader: createVertexReadPort(readerDependencies),
  };
};

const expectCode = async (
  promise: Promise<unknown>,
  code: VertexArtifactStorageError["code"]
): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    name: "VertexArtifactStorageError",
    code,
    message: `Vertex artifact storage ${code}`,
  });
};

const putModules = async (fixture: Awaited<ReturnType<typeof harness>>) =>
  fixture.storage.putManifest({
    ...fixture.input,
    collectionId: null,
    artifactId: "modules-artifact-1",
    contractName: "ModuleManifestList",
    manifest: [moduleValue],
    artifactSha256: await hashArtifact(encode([moduleValue])),
    sourceContentSha256: null,
    sourceBytes: undefined,
  });

describe("Vertex immutable artifact storage (offline authored coverage)", () => {
  it("has no readiness fallback when dependencies or safe transport capabilities are absent", async () => {
    const fixture = await harness();
    await expectCode(
      createVertexArtifactStorage().putManifest(fixture.input),
      "unavailable"
    );
    for (const missing of [
      "objects",
      "metadata",
      "catalog",
      "rights",
      "authorization",
      "boundary",
      "clock",
      "objectCapabilities",
    ] as const) {
      await expectCode(
        createVertexArtifactStorage({
          ...fixture.dependencies,
          [missing]: undefined,
        }).putManifest(fixture.input),
        "unavailable"
      );
    }
    await expectCode(
      createVertexArtifactStorage({
        ...fixture.dependencies,
        objectCapabilities: { getBounded: fixture.getBounded },
      }).putManifest(fixture.input),
      "unavailable"
    );
    await expectCode(
      createVertexArtifactStorage({
        ...fixture.dependencies,
        objectCapabilities: {
          putIfAbsent: fixture.putIfAbsent,
          head: fixture.head,
        },
      }).getManifest(fixture.request),
      "unavailable"
    );
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    expect(fixture.objects.get).not.toHaveBeenCalled();
    return expect(fixture.objects.put).not.toHaveBeenCalled();
  });

  it("requires explicit true for the exact principal/account/environment/collection/action", async () => {
    const fixture = await harness();
    vi.mocked(fixture.authorization.authorize).mockResolvedValue(false);
    await expectCode(fixture.storage.putManifest(fixture.input), "denied");
    expect(fixture.authorization.authorize).toHaveBeenCalledWith({
      principal,
      scope,
      collectionId,
      resourceId: fixture.input.artifactId,
      action: "publish",
      now,
    });
    expect(fixture.catalog.findArtifact).not.toHaveBeenCalled();
    expect(fixture.getBounded).not.toHaveBeenCalled();
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    for (const decision of [undefined, null, "true", 1]) {
      vi.mocked(fixture.authorization.authorize).mockResolvedValue(
        decision as unknown as boolean
      );

      await expectCode(fixture.storage.getManifest(fixture.request), "denied");
    }
  });

  it("sanitizes provider exceptions and never falls back to unsafe transport", async () => {
    const fixture = await harness();
    vi.mocked(fixture.authorization.authorize).mockRejectedValue(
      new Error("private provider secret")
    );
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    const forged = new VertexArtifactStorageError("invalid");
    Object.defineProperty(forged, "code", {
      value: "private provider secret",
      configurable: true,
    });
    vi.mocked(fixture.authorization.authorize).mockRejectedValue(forged);
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    Object.defineProperty(forged, "code", {
      get: () => {
        throw new Error("private provider secret");
      },
    });
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    expect(fixture.objects.put).not.toHaveBeenCalled();
    return expect(fixture.objects.get).not.toHaveBeenCalled();
  });

  it.each(["denied", "expired", "unknown"] as const)(
    "denies %s current rights before blob I/O",
    async (status) => {
      const fixture = await harness();
      fixture.state.rights = { ...fixture.state.rights!, status };
      await expectCode(fixture.storage.putManifest(fixture.input), "denied");
      expect(fixture.rights.resolveRights).toHaveBeenCalledWith(
        principal,
        scope,
        collectionId,
        "fixture-rights"
      );
      expect(fixture.putIfAbsent).not.toHaveBeenCalled();
      return expect(fixture.getBounded).not.toHaveBeenCalled();
    }
  );

  it("denies missing, mismatched, future-checked, expired and retention-expired policies", async () => {
    const fixture = await harness();
    const original = fixture.state.rights!;
    for (const rights of [
      null,
      { ...original, policyId: "other-policy" },
      { ...original, checkedAt: "2026-09-22T10:00:00.123456790Z" },
      { ...original, expiresAt: now },
      { ...original, expiresAt: null },
      { ...original, retentionUntil: now },
      { ...original, allowedUses: ["read"] as const },
    ]) {
      fixture.state.rights = rights;
      await expectCode(fixture.storage.putManifest(fixture.input), "denied");
    }
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });

  it("seals source and canonical manifest separately and retains alias identity across hash dedup", async () => {
    const fixture = await harness();
    const first = await fixture.storage.putManifest(fixture.input);
    const second = await fixture.storage.putManifest({
      ...fixture.input,
      artifactId: "dataset-artifact-alias",
    });
    expect(first.artifactSha256).not.toBe(first.sourceContentSha256);
    expect(first.artifactSha256).toBe(
      await hashArtifact(encode(fixture.dataset))
    );
    expect(first.sourceContentSha256).toBe(
      await hashArtifact(fixture.sourceBytes)
    );
    expect(second.objectKey).toBe(first.objectKey);
    expect(fixture.aliases.size).toBe(2);
    expect(fixture.blobs.size).toBe(2);
    expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
    expect(first.objectKey).toBe(
      vertexQualifiedObjectKey(
        scope,
        collectionId,
        "manifest",
        fixture.input.artifactSha256
      )
    );
    expect(fixture.objects.delete).not.toHaveBeenCalled();
    return expect(fixture.metadata.deleteByKey).not.toHaveBeenCalled();
  });

  it("qualifies content addresses by exact account, environment, collection and object kind", () => {
    const digest = "a".repeat(64);
    const keys = [
      vertexQualifiedObjectKey(scope, null, "manifest", digest),
      vertexQualifiedObjectKey(scope, "account", "manifest", digest),
      vertexQualifiedObjectKey(scope, collectionId, "manifest", digest),
      vertexQualifiedObjectKey(
        { ...scope, environment: "paper" },
        collectionId,
        "manifest",
        digest
      ),
      vertexQualifiedObjectKey(
        { ...scope, accountAlias: "other" },
        collectionId,
        "manifest",
        digest
      ),
      vertexQualifiedObjectKey(scope, collectionId, "content", digest),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    return expect(() =>
      vertexQualifiedObjectKey(scope, "../escape", "manifest", digest)
    ).toThrow(VertexArtifactStorageError);
  });

  it("supports independent content ingestion without exposing a raw hash read endpoint", async () => {
    const fixture = await harness();
    const content = await fixture.storage.putContent({
      principal,
      scope,
      collectionId,
      rightsPolicyId: "fixture-rights",
      sourceContentSha256: fixture.sourceContentSha256,
      bytes: fixture.sourceBytes,
    });
    expect(content).toEqual({
      objectKey: vertexQualifiedObjectKey(
        scope,
        collectionId,
        "content",
        fixture.sourceContentSha256
      ),
      sourceContentSha256: fixture.sourceContentSha256,
      byteLength: fixture.sourceBytes.byteLength,
    });
    expect(fixture.aliases.size).toBe(0);
    await fixture.storage.putManifest({
      ...fixture.input,
      sourceBytes: undefined,
    });
    const bytes = await fixture.storage.getContent({
      ...fixture.request,
      use: "read",
    });
    expect(bytes).toEqual(fixture.sourceBytes);
    return expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("rejects incorrect source and manifest digests before object allocation", async () => {
    const fixture = await harness();
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        artifactSha256: fixture.sourceContentSha256,
      }),
      "integrity"
    );
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        sourceBytes: new TextEncoder().encode("changed"),
      }),
      "integrity"
    );
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    return expect(fixture.blobs.size).toBe(0);
  });

  it("rejects manifest/source identity and policy mismatches before allocation", async () => {
    const fixture = await harness();
    const wrongContent = { ...fixture.dataset, contentHash: "b".repeat(64) };
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        manifest: wrongContent,
        artifactSha256: await hashArtifact(encode(wrongContent)),
      }),
      "integrity"
    );
    const wrongPolicy = {
      ...fixture.dataset,
      entitlementPolicyId: "other-policy",
    };
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        manifest: wrongPolicy,
        artifactSha256: await hashArtifact(encode(wrongPolicy)),
      }),
      "integrity"
    );
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });

  it("rejects noncanonical graphs and relies on authoritative public validators", async () => {
    const fixture = await harness();
    const invalid = { ...fixture.dataset, schemaVersion: "2.0.0" };
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        manifest: invalid,
        artifactSha256: await hashArtifact(encode(invalid)),
      }),
      "unavailable"
    );
    expect(fixture.boundary.validate).toHaveBeenCalledWith(
      "DatasetManifest",
      invalid,
      "1.0.0"
    );
    const accessor = { ...fixture.dataset };
    Object.defineProperty(accessor, "calendar", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not execute");
      },
    });
    await expectCode(
      fixture.storage.putManifest({ ...fixture.input, manifest: accessor }),
      "unavailable"
    );
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });

  it("rejects local file URLs, signed URLs and provider credential-shaped fields", async () => {
    const fixture = await harness();
    for (const manifest of [
      { ...fixture.evidence, sourceUri: "file:///private/source" },
      {
        ...fixture.evidence,
        sourceUri: "https://example.test/paper?signature=synthetic",
      },
      { ...fixture.evidence, claim: "See local://private-source" },
      { ...fixture.evidence, apiKey: "synthetic-not-a-secret" },
    ]) {
      await expectCode(
        fixture.storage.putManifest({
          ...fixture.input,
          contractName: "ResearchEvidence",
          manifest,
          artifactSha256: await hashArtifact(encode(manifest)),
        }),
        "invalid"
      );
    }
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });

  it("retries after a successful blob put whose transport response failed without rollback", async () => {
    const fixture = await harness();
    const originalPut = fixture.putIfAbsent.getMockImplementation()!;
    fixture.putIfAbsent.mockImplementationOnce(async (input) => {
      await originalPut(input);
      throw new Error("synthetic post-write failure");
    });
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    expect(fixture.blobs.size).toBe(1);
    await fixture.storage.putManifest(fixture.input);
    expect(fixture.blobs.size).toBe(2);
    expect(fixture.aliases.size).toBe(1);
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  it("repairs metadata after an object put succeeds but metadata persistence fails", async () => {
    const fixture = await harness();
    vi.mocked(fixture.metadata.upsert).mockRejectedValueOnce(
      new Error("synthetic metadata failure")
    );
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    expect(fixture.blobs.size).toBe(1);
    expect(fixture.aliases.size).toBe(0);
    const result = await fixture.storage.putManifest(fixture.input);
    expect(fixture.objectMetadata.has(result.objectKey)).toBe(true);
    expect(fixture.blobs.size).toBe(2);
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  it("retries catalog failure and acknowledges a lost successful catalog response safely", async () => {
    const fixture = await harness();
    vi.mocked(fixture.catalog.registerArtifact).mockRejectedValueOnce(
      new Error("synthetic catalog failure")
    );
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    expect(fixture.blobs.size).toBe(2);
    expect(fixture.aliases.size).toBe(0);
    const originalRegister = vi
      .mocked(fixture.catalog.registerArtifact)
      .getMockImplementation()!;
    vi.mocked(fixture.catalog.registerArtifact).mockImplementationOnce(
      async (actor, item) => {
        await originalRegister(actor, item);
        throw new Error("synthetic lost catalog response");
      }
    );
    await expectCode(fixture.storage.putManifest(fixture.input), "unavailable");
    const result = await fixture.storage.putManifest(fixture.input);
    expect(result.artifactId).toBe(fixture.input.artifactId);
    expect(fixture.aliases.size).toBe(1);
    expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  it("rejects immutable alias overwrite and shares neither scope nor mutable caller buffers", async () => {
    const fixture = await harness();
    await fixture.storage.putManifest(fixture.input);
    const changed = { ...fixture.dataset, calendar: "XNAS" };
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        manifest: changed,
        artifactSha256: await hashArtifact(encode(changed)),
      }),
      "conflict"
    );
    const first = await fixture.storage.getManifest(fixture.request);
    first!.bytes[0] = 0;
    const second = await fixture.storage.getManifest(fixture.request);
    expect(second!.bytes).toEqual(encode(fixture.dataset));
    expect(
      await fixture.storage.getManifest({
        ...fixture.request,
        scope: { ...scope, environment: "paper" },
      })
    ).toBeNull();
    return expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("rechecks revoked, expired and retention-expired rights instead of stored metadata grants", async () => {
    const fixture = await harness();
    await fixture.storage.putManifest(fixture.input);
    const original = fixture.state.rights!;
    for (const rights of [
      { ...original, version: "2.0.0", status: "denied" as const },
      { ...original, expiresAt: now },
      { ...original, retentionUntil: now },
      { ...original, allowedUses: ["store"] as const },
    ]) {
      fixture.state.rights = rights;
      fixture.getBounded.mockClear();
      await expectCode(fixture.storage.getManifest(fixture.request), "denied");
      expect(fixture.getBounded).not.toHaveBeenCalled();
    }
  });

  it("denies export without a separate explicit action and latest export permission", async () => {
    const fixture = await harness();
    await fixture.storage.putManifest(fixture.input);
    fixture.state.rights = {
      ...fixture.state.rights!,
      allowedUses: ["store", "read"],
    };
    fixture.getBounded.mockClear();
    await expectCode(
      fixture.storage.getContent({ ...fixture.request, use: "export" }),
      "denied"
    );
    expect(fixture.getBounded).not.toHaveBeenCalled();
    fixture.state.rights = {
      ...fixture.state.rights!,
      allowedUses: ["store", "read", "export"],
    };
    vi.mocked(fixture.authorization.authorize).mockImplementation(
      async (request) => request.action !== "export"
    );
    await expectCode(
      fixture.storage.getContent({ ...fixture.request, use: "export" }),
      "denied"
    );
    vi.mocked(fixture.authorization.authorize).mockResolvedValue(true);
    expect(
      await fixture.storage.getContent({ ...fixture.request, use: "export" })
    ).toEqual(fixture.sourceBytes);
    return expect(fixture.authorization.authorize).toHaveBeenCalledWith({
      principal,
      scope,
      collectionId,
      resourceId: fixture.request.artifactId,
      action: "export",
      now,
    });
  });

  it("does not return data when rights are revoked during an in-flight read", async () => {
    const fixture = await harness();
    await fixture.storage.putManifest(fixture.input);
    const originalRead = fixture.getBounded.getMockImplementation()!;
    fixture.getBounded.mockImplementationOnce(async (key, maximumBytes) => {
      const stored = await originalRead(key, maximumBytes);
      fixture.state.rights = {
        ...fixture.state.rights!,
        status: "denied",
        version: "2.0.0",
      };
      return stored;
    });
    return await expectCode(
      fixture.storage.getManifest(fixture.request),
      "denied"
    );
  });

  it("does not publish an alias when policy is revoked while blob I/O is pending", async () => {
    const fixture = await harness();
    const originalPut = fixture.putIfAbsent.getMockImplementation()!;
    fixture.putIfAbsent.mockImplementationOnce(async (input) => {
      const stored = await originalPut(input);
      fixture.state.rights = {
        ...fixture.state.rights!,
        status: "denied",
        version: "2.0.0",
      };
      return stored;
    });
    await expectCode(fixture.storage.putManifest(fixture.input), "denied");
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  it("detects tampered manifests and source bytes without conflating their digests", async () => {
    const fixture = await harness();
    const stored = await fixture.storage.putManifest(fixture.input);
    const original = fixture.blobs.get(stored.objectKey)!;
    fixture.blobs.set(stored.objectKey, {
      ...original,
      body: new Uint8Array(original.body).fill(32),
    });
    await expectCode(fixture.storage.getManifest(fixture.request), "integrity");
    fixture.blobs.set(stored.objectKey, original);
    const contentKey = vertexQualifiedObjectKey(
      scope,
      collectionId,
      "content",
      fixture.sourceContentSha256
    );
    const content = fixture.blobs.get(contentKey)!;
    fixture.blobs.set(contentKey, {
      ...content,
      body: new Uint8Array(content.body).fill(32),
    });
    return await expectCode(
      fixture.storage.getContent({ ...fixture.request, use: "read" }),
      "integrity"
    );
  });

  it("requires canonical bytes even if a catalog digest correctly seals noncanonical JSON", async () => {
    const fixture = await harness();
    const metadata = await fixture.storage.putManifest(fixture.input);
    const bytes = new TextEncoder().encode(
      JSON.stringify(fixture.dataset, null, 2)
    );
    const artifactSha256 = await hashArtifact(bytes);
    const objectKey = vertexQualifiedObjectKey(
      scope,
      collectionId,
      "manifest",
      artifactSha256
    );
    const object: ObjectMetadata = {
      key: objectKey,
      size: bytes.byteLength,
      checksum: artifactSha256,
      createdAt,
      updatedAt: createdAt,
    };
    fixture.blobs.set(objectKey, { metadata: object, body: bytes });
    fixture.objectMetadata.set(objectKey, object);
    fixture.aliases.set(
      keyForAlias(scope, collectionId, fixture.input.artifactId),
      { ...metadata, objectKey, artifactSha256, byteLength: bytes.byteLength }
    );
    return await expectCode(
      fixture.storage.getManifest(fixture.request),
      "integrity"
    );
  });

  it("rejects oversized input and oversized catalog/head metadata before reads", async () => {
    const fixture = await harness();
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        sourceBytes: new Uint8Array(MAX_VERTEX_STORAGE_BYTES + 1),
      }),
      "too-large"
    );
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    const metadata = await fixture.storage.putManifest(fixture.input);
    fixture.getBounded.mockClear();
    fixture.aliases.set(
      keyForAlias(scope, collectionId, fixture.input.artifactId),
      { ...metadata, byteLength: MAX_VERTEX_STORAGE_BYTES + 1 }
    );
    await expectCode(fixture.storage.getManifest(fixture.request), "too-large");
    expect(fixture.getBounded).not.toHaveBeenCalled();
    fixture.aliases.set(
      keyForAlias(scope, collectionId, fixture.input.artifactId),
      metadata
    );
    fixture.head.mockResolvedValueOnce({
      status: "ok",
      value: {
        ...fixture.objectMetadata.get(metadata.objectKey)!,
        size: MAX_VERTEX_STORAGE_BYTES + 1,
      },
    });
    await expectCode(fixture.storage.getManifest(fixture.request), "too-large");
    return expect(fixture.getBounded).not.toHaveBeenCalled();
  });

  it("post-checks malicious bounded backends and declared lengths before copying or returning", async () => {
    const fixture = await harness();
    const metadata = await fixture.storage.putManifest(fixture.input);
    const stored = fixture.blobs.get(metadata.objectKey)!;
    fixture.getBounded.mockResolvedValueOnce({
      status: "ok",
      value: {
        metadata: stored.metadata,
        body: new Uint8Array(MAX_VERTEX_STORAGE_BYTES + 1),
      },
    });
    await expectCode(fixture.storage.getManifest(fixture.request), "too-large");
    fixture.getBounded.mockResolvedValueOnce({
      status: "ok",
      value: {
        metadata: stored.metadata,
        body: new Uint8Array(stored.body.byteLength - 1),
      },
    });
    await expectCode(fixture.storage.getManifest(fixture.request), "integrity");
    return expect(fixture.getBounded).toHaveBeenLastCalledWith(
      metadata.objectKey,
      metadata.byteLength
    );
  });

  it("rejects catalog path substitution and account/environment/collection substitution before transport", async () => {
    const fixture = await harness();
    const stored = await fixture.storage.putManifest(fixture.input);
    for (const metadata of [
      { ...stored, objectKey: "file:///private/object" },
      { ...stored, scope: { ...scope, accountAlias: "other-account" } },
      { ...stored, scope: { ...scope, environment: "paper" as const } },
      { ...stored, collectionId: "other-collection" },
    ]) {
      fixture.aliases.set(
        keyForAlias(scope, collectionId, fixture.input.artifactId),
        metadata
      );
      fixture.getBounded.mockClear();
      await expectCode(
        fixture.storage.getManifest(fixture.request),
        "integrity"
      );
      expect(fixture.getBounded).not.toHaveBeenCalled();
    }
  });

  // Hashes and canonicalizes several MiB-scale bodies; under a loaded parallel
  // run this exceeds the 5s default without any behaviour change.
  it(
    "permits large raw bodies only under an explicit budget while keeping API manifests capped at 1MiB",
    async () => {
      const fixture = await harness();
      const sourceBytes = new Uint8Array(MAX_VERTEX_STORAGE_BYTES + 1).fill(65);
      const sourceContentSha256 = await hashArtifact(sourceBytes);
      const manifest = datasetValue(sourceContentSha256);
      const input = {
        ...fixture.input,
        manifest,
        sourceBytes,
        sourceContentSha256,
        artifactSha256: await hashArtifact(encode(manifest)),
      };
      await expectCode(fixture.storage.putManifest(input), "too-large");
      const maximumContentBytes = 64 * MAX_VERTEX_STORAGE_BYTES;
      const storage = createVertexArtifactStorage({
        ...fixture.dependencies,
        maximumContentBytes,
      });
      const metadata = await storage.putManifest(input);
      expect(
        await storage.getContent({ ...fixture.request, use: "read" })
      ).toEqual(sourceBytes);
      expect(await storage.getManifest(fixture.request)).toEqual({
        bytes: encode(manifest),
        metadata,
      });
      await putModules(fixture);
      const reader = createVertexReadPort({
        ...fixture.readerDependencies,
        maximumContentBytes,
      });
      expect(
        (await reader.listModules(fixture.apiPrincipal)).bytes.byteLength
      ).toBeLessThanOrEqual(MAX_VERTEX_STORAGE_BYTES);
      const oversizedManifest = {
        ...manifest,
        provider: "x".repeat(MAX_VERTEX_STORAGE_BYTES + 1),
      };
      await expectCode(
        storage.putManifest({ ...input, manifest: oversizedManifest }),
        "too-large"
      );
      const contentKey = vertexQualifiedObjectKey(
        scope,
        collectionId,
        "content",
        sourceContentSha256
      );
      expect(
        fixture.getBounded.mock.calls
          .filter(([key]) => key === metadata.objectKey)
          .every(([, bound]) => bound <= MAX_VERTEX_STORAGE_BYTES)
      ).toBe(true);
      expect(
        fixture.getBounded.mock.calls
          .filter(([key]) => key === contentKey)
          .every(([, bound]) => bound <= maximumContentBytes)
      ).toBe(true);
      return await expectCode(
        fixture.storage.getContent({ ...fixture.request, use: "read" }),
        "too-large"
      );
    },
    scaledTimeout(60_000)
  );

  it("rejects non-finite, non-integral, non-positive and unsafe content budgets", async () => {
    const fixture = await harness();
    for (const maximumContentBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expectCode(
        createVertexArtifactStorage({
          ...fixture.dependencies,
          maximumContentBytes,
        }).putManifest(fixture.input),
        "invalid"
      );
    }
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });

  return it("keeps factories side-effect-free until explicitly invoked", async () => {
    const fixture = await harness();
    createVertexArtifactStorage(fixture.dependencies);
    createVertexReadPort(fixture.readerDependencies);
    expect(fixture.authorization.authorize).not.toHaveBeenCalled();
    expect(fixture.rights.resolveRights).not.toHaveBeenCalled();
    expect(fixture.catalog.findArtifact).not.toHaveBeenCalled();
    expect(fixture.getBounded).not.toHaveBeenCalled();
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });
});

describe("Vertex prepared manifest staging (offline authored coverage)", () => {
  it("stages exact verified bytes and physical metadata without publishing any catalog alias", async () => {
    const fixture = await harness();
    const prepared = await fixture.storage.stageManifest(fixture.input);
    expect(prepared.artifactId).toBe(fixture.input.artifactId);
    expect(prepared.artifactSha256).toBe(fixture.input.artifactSha256);
    expect(prepared.sourceContentSha256).toBe(fixture.sourceContentSha256);
    expect(fixture.blobs.size).toBe(2);
    expect(fixture.objectMetadata.size).toBe(2);
    expect(fixture.objectMetadata.has(prepared.objectKey)).toBe(true);
    expect(fixture.aliases.size).toBe(0);
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    expect(await fixture.storage.getManifest(fixture.request)).toBeNull();
    expect(
      await fixture.storage.getContent({ ...fixture.request, use: "read" })
    ).toBeNull();
    return expect(Object.isFrozen(prepared)).toBe(true);
  });

  it("retries staging without catalog mutation and preserves later explicit publication", async () => {
    const fixture = await harness();
    const first = await fixture.storage.stageManifest(fixture.input);
    const retried = await fixture.storage.stageManifest(fixture.input);
    expect(retried).toEqual(first);
    expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    const published = await fixture.storage.putManifest(fixture.input);
    expect(published).toEqual(first);
    expect(fixture.catalog.registerArtifact).toHaveBeenCalledTimes(1);
    expect(
      (await fixture.storage.getManifest(fixture.request))!.metadata
        .artifactSha256
    ).toBe(first.artifactSha256);
    return expect(fixture.putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("keeps orphan bytes inert after a downstream atomic command rejects prepared metadata", async () => {
    const fixture = await harness();
    const prepared = await fixture.storage.stageManifest(fixture.input);
    const rejectedAtomicCommand = vi.fn(
      async (_metadata: VertexStorageArtifactMetadata) => {
        throw new Error("synthetic atomic rollback");
      }
    );
    await expect(rejectedAtomicCommand(prepared)).rejects.toThrow(
      "synthetic atomic rollback"
    );
    expect(fixture.aliases.size).toBe(0);
    expect(fixture.blobs.size).toBe(2);
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    expect(await fixture.storage.getManifest(fixture.request)).toBeNull();
    expect(fixture.objects.delete).not.toHaveBeenCalled();
    return expect(fixture.metadata.deleteByKey).not.toHaveBeenCalled();
  });

  it("retains immutable conflict checks against existing aliases without mutating them", async () => {
    const fixture = await harness();
    const published = await fixture.storage.putManifest(fixture.input);
    vi.mocked(fixture.catalog.registerArtifact).mockClear();
    expect(await fixture.storage.stageManifest(fixture.input)).toEqual(
      published
    );
    const changed = { ...fixture.dataset, calendar: "XNAS" };
    await expectCode(
      fixture.storage.stageManifest({
        ...fixture.input,
        manifest: changed,
        artifactSha256: await hashArtifact(encode(changed)),
      }),
      "conflict"
    );
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    expect(fixture.aliases.size).toBe(1);
    return expect(await fixture.storage.getManifest(fixture.request)).toEqual({
      bytes: encode(fixture.dataset),
      metadata: published,
    });
  });

  it("uses the same authorization, current rights, canonical and digest guards before staging", async () => {
    const fixture = await harness();
    vi.mocked(fixture.authorization.authorize).mockResolvedValue(false);
    await expectCode(fixture.storage.stageManifest(fixture.input), "denied");
    vi.mocked(fixture.authorization.authorize).mockResolvedValue(true);
    const rights = fixture.state.rights!;
    fixture.state.rights = { ...rights, status: "denied" };
    await expectCode(fixture.storage.stageManifest(fixture.input), "denied");
    fixture.state.rights = rights;
    await expectCode(
      fixture.storage.stageManifest({
        ...fixture.input,
        artifactSha256: fixture.sourceContentSha256,
      }),
      "integrity"
    );
    await expectCode(
      fixture.storage.stageManifest({
        ...fixture.input,
        sourceBytes: new TextEncoder().encode("changed source"),
      }),
      "integrity"
    );
    const localSource = {
      ...fixture.evidence,
      sourceUri: "file:///private/source",
    };
    await expectCode(
      fixture.storage.stageManifest({
        ...fixture.input,
        contractName: "ResearchEvidence",
        manifest: localSource,
        artifactSha256: await hashArtifact(encode(localSource)),
      }),
      "invalid"
    );
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    return expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
  });

  it("repairs failed physical metadata staging while leaving catalog publication to the transaction", async () => {
    const fixture = await harness();
    vi.mocked(fixture.metadata.upsert).mockRejectedValueOnce(
      new Error("synthetic staging metadata failure")
    );
    await expectCode(
      fixture.storage.stageManifest(fixture.input),
      "unavailable"
    );
    expect(fixture.blobs.size).toBe(1);
    expect(fixture.aliases.size).toBe(0);
    const prepared = await fixture.storage.stageManifest(fixture.input);
    expect(fixture.objectMetadata.has(prepared.objectKey)).toBe(true);
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    expect(await fixture.storage.getManifest(fixture.request)).toBeNull();
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  it("denies a staged result if current policy is revoked during object I/O", async () => {
    const fixture = await harness();
    const originalPut = fixture.putIfAbsent.getMockImplementation()!;
    fixture.putIfAbsent.mockImplementationOnce(async (input) => {
      const result = await originalPut(input);
      fixture.state.rights = {
        ...fixture.state.rights!,
        status: "denied",
        version: "2.0.0",
      };
      return result;
    });
    await expectCode(fixture.storage.stageManifest(fixture.input), "denied");
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    expect(fixture.aliases.size).toBe(0);
    return expect(fixture.objects.delete).not.toHaveBeenCalled();
  });

  return it("accepts only injected authoritative native proof/projection contracts with null source hashes and exact scope", async () => {
    const fixture = await harness();
    const paperScope: VertexStorageScope = { ...scope, environment: "paper" };
    const fact = {
      kind: "kill-state" as const,
      action: "pause-new-risk" as const,
      reasonCodes: ["synthetic-only"],
      grantId: null,
    };
    const proof = {
      schemaVersion: "1.0.0" as const,
      proofKind: "native-journal-event" as const,
      accountAlias: scope.accountAlias,
      environment: "paper" as const,
      streamId: "fixture-native",
      ownerEpoch: "1",
      sourceEventId: "fixture-event",
      journalSequence: "1",
      journalHeadHash: "a".repeat(64),
      factOrdinal: 0,
      occurredAt: createdAt,
      eventType: "kill-state" as const,
      payload: fact,
    };
    const proofHash = await hashArtifact(encode(proof));
    const projectionDraft = {
      schemaVersion: "1.0.0" as const,
      projectionId: "fixture-projection",
      accountAlias: scope.accountAlias,
      environment: "paper" as const,
      streamId: "fixture-native",
      ownerEpoch: "1",
      sequence: "2",
      proofJournalSequence: proof.journalSequence,
      proofJournalHeadHash: proof.journalHeadHash,
      factOrdinal: proof.factOrdinal,
      previousEventHash: "0".repeat(64),
      eventHash: "0".repeat(64),
      occurredAt: createdAt,
      receivedAt: now,
      actorId: principal.actorId,
      policyVersion: "1.0.0",
      expiresAt: "2026-09-23T10:00:00Z",
      idempotencyKey: "fixture-native-projection",
      sourceKind: "paper-simulation" as const,
      proof: {
        artifactId: "fixture-proof",
        sha256: proofHash,
        sourceEventId: proof.sourceEventId,
      },
      fact,
      authoritative: false as const,
      reservationAuthority: "native-owner-only" as const,
      executionAuthorized: false as const,
    };
    const projection = {
      ...projectionDraft,
      eventHash: await computeNativeFactProjectionHash(projectionDraft),
    };
    for (const [contractName, manifest] of [
      ["NativeJournalProof", proof],
      ["NativeFactProjection", projection],
    ] as const) {
      const input: VertexManifestPut = {
        ...fixture.input,
        scope: paperScope,
        collectionId: null,
        artifactId: `fixture-${contractName}`,
        contractName,
        manifest,
        artifactSha256: await hashArtifact(encode(manifest)),
        sourceContentSha256: null,
        sourceBytes: undefined,
      };
      const prepared = await fixture.storage.stageManifest(input);
      expect(prepared.contractName).toBe(contractName);
      expect(prepared.sourceContentSha256).toBeNull();
      expect(fixture.boundary.validate).toHaveBeenCalledWith(
        contractName,
        manifest,
        "1.0.0"
      );
      await expectCode(
        fixture.storage.stageManifest({
          ...input,
          sourceContentSha256: fixture.sourceContentSha256,
        }),
        "integrity"
      );
      await expectCode(
        fixture.storage.stageManifest({ ...input, scope }),
        "integrity"
      );
      await expectCode(
        fixture.storage.stageManifest({
          ...input,
          scope: { ...paperScope, accountAlias: "other-account" },
        }),
        "integrity"
      );
    }
    await expectCode(
      fixture.storage.stageManifest({
        ...fixture.input,
        contractName: "NativeFactPayload" as VertexManifestPut["contractName"],
        manifest: fact,
        artifactSha256: await hashArtifact(encode(fact)),
        sourceContentSha256: null,
        sourceBytes: undefined,
      }),
      "invalid"
    );
    expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
    return expect(fixture.aliases.size).toBe(0);
  });
});

describe("Vertex API-compatible read adapter (offline authored coverage)", () => {
  it("returns exactly bytes, manifest hash and catalog-bound identity for modules", async () => {
    const fixture = await harness();
    const modulesMetadata = await putModules(fixture);
    const modules = await fixture.reader.listModules(fixture.apiPrincipal);
    expect(modules).toEqual({
      bytes: encode([moduleValue]),
      artifactSha256: modulesMetadata.artifactSha256,
      identity: { kind: "modules" },
    });
    expect(Object.keys(modules).sort()).toEqual([
      "artifactSha256",
      "bytes",
      "identity",
    ]);
    expect(Object.isFrozen(modules)).toBe(true);
    expect(Object.isFrozen(modules.identity)).toBe(true);
    expect(fixture.readerDependencies.mapPrincipal).toHaveBeenCalledWith(
      fixture.apiPrincipal
    );
    expect(fixture.readerDependencies.resolveScope).toHaveBeenCalledWith(
      fixture.apiPrincipal,
      { kind: "modules" }
    );
    expect(fixture.catalog.findDataset).not.toHaveBeenCalled();
    expect(fixture.catalog.findEvidence).not.toHaveBeenCalled();
    return expect(fixture.catalog.findModuleCatalog).toHaveBeenCalledWith(
      principal,
      scope
    );
  });

  it("exposes only the module list read", async () => {
    const fixture = await harness();
    return expect(Object.keys(fixture.reader)).toEqual(["listModules"]);
  });

  it("treats a missing module catalog as unavailable", async () => {
    const fixture = await harness();
    await fixture.storage.putManifest(fixture.input);
    return await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "unavailable"
    );
  });

  it("cannot infer a principal or default scope from roles, IDs or catalog content", async () => {
    const fixture = await harness();
    for (const dependencies of [
      {},
      { ...fixture.readerDependencies, catalog: undefined },
      { ...fixture.readerDependencies, mapPrincipal: undefined },
      { ...fixture.readerDependencies, resolveScope: undefined },
    ]) {
      await expectCode(
        createVertexReadPort(dependencies).listModules(fixture.apiPrincipal),
        "unavailable"
      );
    }
    await expectCode(
      createVertexReadPort({
        ...fixture.readerDependencies,
        mapPrincipal: async () => ({ actorId: "../other" }),
      }).listModules(fixture.apiPrincipal),
      "invalid"
    );
    await putModules(fixture);
    vi.mocked(fixture.authorization.authorize).mockResolvedValue(false);
    await expectCode(
      fixture.reader.listModules({ ...fixture.apiPrincipal, role: "admin" }),
      "denied"
    );
    return expect(fixture.catalog.findModuleCatalog).not.toHaveBeenCalled();
  });

  it("rejects a resolved collection scope before catalog lookup", async () => {
    const fixture = await harness();
    await putModules(fixture);
    const reader = createVertexReadPort({
      ...fixture.readerDependencies,
      resolveScope: async () => ({ scope, collectionId }),
    });
    await expectCode(reader.listModules(fixture.apiPrincipal), "denied");
    expect(fixture.catalog.findEvidence).not.toHaveBeenCalled();
    return expect(fixture.catalog.findModuleCatalog).not.toHaveBeenCalled();
  });

  it("sanitizes resolver, mapper and catalog exceptions as unavailable", async () => {
    const fixture = await harness();
    await putModules(fixture);
    for (const dependencies of [
      {
        ...fixture.readerDependencies,
        mapPrincipal: async () => {
          throw new Error("private provider secret");
        },
      },
      {
        ...fixture.readerDependencies,
        resolveScope: async () => {
          throw new Error("private provider secret");
        },
      },
    ]) {
      const operation = createVertexReadPort(dependencies).listModules(
        fixture.apiPrincipal
      );
      await expectCode(operation, "unavailable");
      await expect(operation).rejects.not.toThrow("private provider secret");
    }
    vi.mocked(fixture.catalog.findModuleCatalog).mockRejectedValue(
      new Error("private provider secret")
    );
    return await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "unavailable"
    );
  });

  it("does not trust a catalog lookup that returns a different contract or identity", async () => {
    const fixture = await harness();
    const modulesMetadata = await putModules(fixture);
    const datasetMetadata = await fixture.storage.putManifest(fixture.input);
    vi.mocked(fixture.catalog.findModuleCatalog).mockResolvedValue(
      datasetMetadata
    );
    await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "integrity"
    );
    vi.mocked(fixture.catalog.findModuleCatalog).mockResolvedValue({
      ...modulesMetadata,
      collectionId,
    });
    await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "integrity"
    );
    vi.mocked(fixture.catalog.findModuleCatalog).mockResolvedValue({
      ...datasetMetadata,
      collectionId: null,
      objectKey: vertexQualifiedObjectKey(
        scope,
        null,
        "manifest",
        datasetMetadata.artifactSha256
      ),
    });
    await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "integrity"
    );
    vi.mocked(fixture.catalog.findModuleCatalog).mockResolvedValue({
      ...modulesMetadata,
      artifactSha256: "f".repeat(64),
    });
    return await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "integrity"
    );
  });

  it("denies revoked read rights before fetching bytes even with a valid catalog identity", async () => {
    const fixture = await harness();
    await putModules(fixture);
    fixture.state.rights = {
      ...fixture.state.rights!,
      status: "denied",
      version: "2.0.0",
    };
    fixture.getBounded.mockClear();
    await expectCode(
      fixture.reader.listModules(fixture.apiPrincipal),
      "denied"
    );
    return expect(fixture.getBounded).not.toHaveBeenCalled();
  });

  it("does not return modules when rights or authorization are revoked during an in-flight read", async () => {
    for (const revoke of ["rights", "authorization"] as const) {
      const fixture = await harness();
      await putModules(fixture);
      const originalRead = fixture.getBounded.getMockImplementation()!;
      fixture.getBounded.mockImplementationOnce(async (key, maximumBytes) => {
        const result = await originalRead(key, maximumBytes);
        if (revoke === "rights") {
          fixture.state.rights = {
            ...fixture.state.rights!,
            status: "denied",
            version: "2.0.0",
          };
        } else {
          vi.mocked(fixture.authorization.authorize).mockResolvedValue(false);
        }
        return result;
      });
      await expectCode(
        fixture.reader.listModules(fixture.apiPrincipal),
        "denied"
      );
    }
  });

  return it("enforces unique bounded module lists without granting lifecycle-based access", async () => {
    const fixture = await harness();
    const duplicated = [moduleValue, moduleValue];
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        collectionId: null,
        contractName: "ModuleManifestList",
        manifest: duplicated,
        artifactSha256: await hashArtifact(encode(duplicated)),
        sourceContentSha256: null,
        sourceBytes: undefined,
      }),
      "invalid"
    );
    const excessive = Array.from({ length: 257 }, (_, index) => ({
      ...moduleValue,
      moduleId: `module-${index}`,
    }));
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        collectionId: null,
        contractName: "ModuleManifestList",
        manifest: excessive,
        artifactSha256: await hashArtifact(encode(excessive)),
        sourceContentSha256: null,
        sourceBytes: undefined,
      }),
      "invalid"
    );
    return expect(fixture.putIfAbsent).not.toHaveBeenCalled();
  });
});

describe("Vertex catalog and publication guards (offline authored coverage)", () => {
  const modulesRequest = (): VertexArtifactRequest => ({
    principal,
    scope,
    collectionId: null,
    artifactId: "modules-artifact-1",
  });

  it("rejects tampered module catalog metadata before returning bytes", async () => {
    const fixture = await harness();
    const modulesMetadata = await putModules(fixture);
    const missingDigest = "f".repeat(64);
    for (const tampered of [
      { ...modulesMetadata, extra: "private provider secret" },
      { ...modulesMetadata, sourceContentSha256: fixture.sourceContentSha256 },
      { ...modulesMetadata, createdAt: "2026-09-22T11:00:00Z" },
      {
        ...modulesMetadata,
        lineageArtifactIds: ["evidence-artifact-1", "evidence-artifact-1"],
      },
      {
        ...modulesMetadata,
        artifactSha256: missingDigest,
        objectKey: vertexQualifiedObjectKey(
          scope,
          null,
          "manifest",
          missingDigest
        ),
      },
    ]) {
      vi.mocked(fixture.catalog.findModuleCatalog).mockResolvedValueOnce(
        tampered as VertexStorageArtifactMetadata
      );
      await expectCode(
        fixture.reader.listModules(fixture.apiPrincipal),
        "integrity"
      );
    }
    return expect(
      (await fixture.reader.listModules(fixture.apiPrincipal)).artifactSha256
    ).toBe(modulesMetadata.artifactSha256);
  });

  it("rejects malformed lineage and unexpected source bytes before allocation", async () => {
    const fixture = await harness();
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        lineageArtifactIds: "evidence-artifact-1" as never,
      }),
      "invalid"
    );
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        lineageArtifactIds: Array.from(
          { length: 513 },
          (_, index) => `lineage-${index}`
        ),
      }),
      "invalid"
    );
    await expectCode(
      fixture.storage.putManifest({
        ...fixture.input,
        collectionId: null,
        artifactId: "modules-artifact-1",
        contractName: "ModuleManifestList",
        manifest: [moduleValue],
        artifactSha256: await hashArtifact(encode([moduleValue])),
        sourceContentSha256: null,
      }),
      "invalid"
    );
    expect(fixture.putIfAbsent).not.toHaveBeenCalled();
    return expect(fixture.catalog.registerArtifact).not.toHaveBeenCalled();
  });

  it("compares lineage element-wise when an alias already exists", async () => {
    const fixture = await harness();
    const input = {
      ...fixture.input,
      lineageArtifactIds: ["evidence-artifact-1"],
    };
    const published = await fixture.storage.putManifest(input);
    expect(published.lineageArtifactIds).toEqual(["evidence-artifact-1"]);
    expect(await fixture.storage.putManifest(input)).toEqual(published);
    await expectCode(
      fixture.storage.putManifest({
        ...input,
        lineageArtifactIds: ["other-artifact"],
      }),
      "conflict"
    );
    return expect(fixture.catalog.registerArtifact).toHaveBeenCalledTimes(1);
  });

  it("fails closed when catalog publication is not acknowledged or not persisted exactly", async () => {
    const unacknowledged = await harness();
    vi.mocked(unacknowledged.catalog.registerArtifact).mockResolvedValueOnce(
      "ignored" as never
    );
    await expectCode(
      unacknowledged.storage.putManifest(unacknowledged.input),
      "unavailable"
    );

    const missing = await harness();
    vi.mocked(missing.catalog.findArtifact)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    await expectCode(missing.storage.putManifest(missing.input), "integrity");

    const different = await harness();
    const original = vi.mocked(different.catalog.findArtifact);
    original
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (_actor, account, collection, id) => {
        const stored = different.aliases.get(
          keyForAlias(account, collection, id)
        );
        return stored ? { ...stored, createdAt: "2026-09-22T08:00:00Z" } : null;
      });
    return await expectCode(
      different.storage.putManifest(different.input),
      "conflict"
    );
  });

  it("requires safe put capability, a declared use and source content for content reads", async () => {
    const fixture = await harness();
    await expectCode(
      createVertexArtifactStorage({
        ...fixture.dependencies,
        objectCapabilities: { ...fixture.capabilities, putIfAbsent: undefined },
      }).putContent({
        ...fixture.request,
        bytes: fixture.sourceBytes,
        sourceContentSha256: fixture.sourceContentSha256,
        rightsPolicyId: "fixture-rights",
      }),
      "unavailable"
    );
    await fixture.storage.putManifest(fixture.input);
    await expectCode(
      fixture.storage.getContent({
        ...fixture.request,
        use: "delete" as never,
      }),
      "invalid"
    );
    await putModules(fixture);
    await expectCode(
      fixture.storage.getContent({ ...modulesRequest(), use: "read" }),
      "invalid"
    );
    fixture.blobs.delete(
      vertexQualifiedObjectKey(
        scope,
        collectionId,
        "content",
        fixture.sourceContentSha256
      )
    );
    return await expectCode(
      fixture.storage.getContent({ ...fixture.request, use: "read" }),
      "integrity"
    );
  });
});
