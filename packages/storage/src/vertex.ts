import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import type {
  ObjectMetadata,
  ObjectMetadataRepository,
  PutObjectInput,
  StoragePort,
  StorageResult,
  StoredObject,
} from "./index.ts";

export const MAX_VERTEX_STORAGE_BYTES = 1_048_576;

// These are internal injected ports, not alternative public artifact schemas.
// The catalog signatures intentionally match the corresponding VertexStore methods.
export type VertexStorageScope = Readonly<{
  accountAlias: string;
  environment: "research" | "paper" | "live";
}>;
export type VertexStoragePrincipal = Readonly<{ actorId: string }>;
export type VertexStorageContractName =
  | "DatasetManifest"
  | "ResearchEvidence"
  | "KnowledgeImport"
  | "StrategySpec"
  | "BacktestRun"
  | "AgentRun"
  | "ModuleManifest"
  | "EventEnvelope"
  | "TradeIntent"
  | "PortfolioSnapshot"
  | "AcceptedReview"
  | "PaperSimulationAdmission"
  | "ExecutionProjection"
  | "NativeFactProjection"
  | "NativeJournalProof";
export type VertexStorageRights = Readonly<{
  policyId: string;
  version: string;
  status: "granted" | "denied" | "expired" | "unknown";
  allowedUses: readonly ("store" | "read" | "derive" | "export")[];
  checkedAt: string;
  expiresAt: string | null;
  retentionUntil: string | null;
}>;
export type VertexStorageArtifactMetadata = Readonly<{
  artifactId: string;
  scope: VertexStorageScope;
  collectionId: string | null;
  objectKey: string;
  artifactSha256: string;
  sourceContentSha256: string | null;
  byteLength: number;
  contentType: string;
  schemaVersion: "1.0.0";
  contractName: VertexStorageContractName | "ModuleManifestList";
  rights: VertexStorageRights;
  lineageArtifactIds: readonly string[];
  createdAt: string;
}>;
export interface VertexArtifactCatalog {
  registerArtifact: (
    principal: VertexStoragePrincipal,
    artifact: VertexStorageArtifactMetadata
  ) => Promise<"recorded" | "duplicate">;
  findArtifact: (
    principal: VertexStoragePrincipal,
    scope: VertexStorageScope,
    collectionId: string | null,
    artifactId: string
  ) => Promise<VertexStorageArtifactMetadata | null>;
}
export interface VertexReadCatalog extends VertexArtifactCatalog {
  findDataset: (
    principal: VertexStoragePrincipal,
    scope: VertexStorageScope,
    datasetId: string
  ) => Promise<VertexStorageArtifactMetadata | null>;
  findEvidence: (
    principal: VertexStoragePrincipal,
    scope: VertexStorageScope,
    collectionId: string,
    evidenceId: string
  ) => Promise<VertexStorageArtifactMetadata | null>;
  findModuleCatalog: (
    principal: VertexStoragePrincipal,
    scope: VertexStorageScope
  ) => Promise<VertexStorageArtifactMetadata | null>;
}
export type VertexStorageBoundary = Readonly<{
  validate: (
    contractName: VertexStorageContractName,
    payload: unknown,
    schemaVersion: "1.0.0"
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  encode: (value: unknown) => Uint8Array;
  digest: (bytes: Uint8Array) => Promise<string>;
}>;
export type VertexStorageAuthorization = Readonly<{
  authorize: (
    input: Readonly<{
      principal: VertexStoragePrincipal;
      scope: VertexStorageScope;
      collectionId: string | null;
      resourceId: string;
      action: "read" | "publish" | "export";
      now: string;
    }>
  ) => Promise<boolean>;
}>;
export type VertexRightsResolver = Readonly<{
  // Resolve the current policy on EVERY operation, never trust a stored grant.
  resolveRights: (
    principal: VertexStoragePrincipal,
    scope: VertexStorageScope,
    collectionId: string | null,
    policyId: string
  ) => Promise<VertexStorageRights | null>;
}>;
export type VertexObjectCapabilities = Readonly<{
  // Atomic create-or-return-existing. MUST NOT overwrite an existing key, even
  // across processes. Plain StoragePort.put cannot supply this guarantee.
  putIfAbsent?:
    | ((input: PutObjectInput) => Promise<StorageResult<ObjectMetadata>>)
    | undefined;
  head?: ((key: string) => Promise<StorageResult<ObjectMetadata>>) | undefined;
  // Required for all artifact I/O. The backend must bound allocation/streaming
  // itself; a declared Content-Length alone is never an allocation guarantee.
  getBounded?:
    | ((
        key: string,
        maximumBytes: number
      ) => Promise<StorageResult<StoredObject>>)
    | undefined;
}>;
export type VertexArtifactStorageDependencies = Readonly<{
  objects?: StoragePort | undefined;
  objectCapabilities?: VertexObjectCapabilities | undefined;
  metadata?: ObjectMetadataRepository | undefined;
  catalog?: VertexArtifactCatalog | undefined;
  rights?: VertexRightsResolver | undefined;
  authorization?: VertexStorageAuthorization | undefined;
  boundary?: VertexStorageBoundary | undefined;
  clock?: Readonly<{ now: () => string }> | undefined;
  // Raw source bodies only. Default 1MiB; a larger explicit finite budget does
  // not relax the fixed 1MiB API manifest/catalog bound.
  maximumContentBytes?: number | undefined;
}>;
export type VertexArtifactRequest = Readonly<{
  principal: VertexStoragePrincipal;
  scope: VertexStorageScope;
  collectionId: string | null;
  artifactId: string;
}>;
export type VertexContentPut = Readonly<{
  principal: VertexStoragePrincipal;
  scope: VertexStorageScope;
  collectionId: string | null;
  rightsPolicyId: string;
  sourceContentSha256: string;
  bytes: Uint8Array;
}>;
export type VertexManifestPut = VertexArtifactRequest &
  Readonly<{
    contractName: VertexStorageArtifactMetadata["contractName"];
    manifest: unknown;
    artifactSha256: string;
    sourceContentSha256: string | null;
    sourceBytes?: Uint8Array | undefined;
    rightsPolicyId: string;
    lineageArtifactIds: readonly string[];
    createdAt: string;
  }>;
export type VertexContentDescriptor = Readonly<{
  objectKey: string;
  sourceContentSha256: string;
  byteLength: number;
}>;
export type VertexManifestRead = Readonly<{
  bytes: Uint8Array;
  metadata: VertexStorageArtifactMetadata;
}>;
export type VertexArtifactStorage = Readonly<{
  putContent: (input: VertexContentPut) => Promise<VertexContentDescriptor>;
  // Stage immutable bytes/object metadata only. Atomic DB commands own catalog
  // publication; staging alone never makes an artifact discoverable or readable.
  stageManifest: (
    input: VertexManifestPut
  ) => Promise<VertexStorageArtifactMetadata>;
  putManifest: (
    input: VertexManifestPut
  ) => Promise<VertexStorageArtifactMetadata>;
  getManifest: (
    input: VertexArtifactRequest
  ) => Promise<VertexManifestRead | null>;
  // Content is reachable only through a cataloged manifest alias, not by a
  // caller-supplied hash or provider URL. Export requires BOTH read and export.
  getContent: (
    input: VertexArtifactRequest & Readonly<{ use: "read" | "export" }>
  ) => Promise<Uint8Array | null>;
}>;
export class VertexArtifactStorageError extends Error {
  readonly code:
    | "unavailable"
    | "denied"
    | "invalid"
    | "conflict"
    | "integrity"
    | "too-large";
  constructor(code: VertexArtifactStorageError["code"]) {
    super(`Vertex artifact storage ${code}`);
    this.name = "VertexArtifactStorageError";
    this.code = code;
  }
}

function fail(code: VertexArtifactStorageError["code"]): never {
  throw new VertexArtifactStorageError(code);
}

const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    // Never expose provider errors, object paths, credentials or source text.
    let code: VertexArtifactStorageError["code"] = "unavailable";
    try {
      if (error instanceof VertexArtifactStorageError) {
        const field = Object.getOwnPropertyDescriptor(error, "code");
        if (
          field &&
          Object.hasOwn(field, "value") &&
          [
            "unavailable",
            "denied",
            "invalid",
            "conflict",
            "integrity",
            "too-large",
          ].includes(field.value)
        ) {
          code = field.value as VertexArtifactStorageError["code"];
        }
      }
    } catch {
      code = "unavailable";
    }
    throw new VertexArtifactStorageError(code);
  }
};

const identifier = (value: string): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    fail("invalid");
  return value;
};

const digestValue = (value: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail("integrity");
  return value;
};

const instant = (value: string): bigint => {
  try {
    return timestampToEpochNanoseconds(value);
  } catch {
    return fail("invalid");
  }
};

const bytesSnapshot = (
  value: Uint8Array,
  maximumBytes = MAX_VERTEX_STORAGE_BYTES
): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    Object.hasOwn(value, "buffer") ||
    Object.hasOwn(value, "byteLength") ||
    !(value.buffer instanceof ArrayBuffer)
  )
    fail("invalid");
  if (value.byteLength === 0 || value.byteLength > maximumBytes)
    fail("too-large");
  return new Uint8Array(value);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
};

const sameScope = (
  left: VertexStorageScope,
  right: VertexStorageScope
): boolean => {
  return (
    left.accountAlias === right.accountAlias &&
    left.environment === right.environment
  );
};

const requestSnapshot = <T extends VertexArtifactRequest>(
  input: T
): VertexArtifactRequest => {
  identifier(input.principal.actorId);
  identifier(input.scope.accountAlias);
  identifier(input.artifactId);
  if (!["research", "paper", "live"].includes(input.scope.environment))
    fail("invalid");
  if (input.collectionId !== null) identifier(input.collectionId);
  return Object.freeze({
    principal: Object.freeze({ actorId: input.principal.actorId }),
    scope: Object.freeze({
      accountAlias: input.scope.accountAlias,
      environment: input.scope.environment,
    }),
    collectionId: input.collectionId,
    artifactId: input.artifactId,
  });
};

export const vertexQualifiedObjectKey = (
  scope: VertexStorageScope,
  collectionId: string | null,
  kind: "manifest" | "content",
  sha256: string
): string => {
  identifier(scope.accountAlias);
  if (!["research", "paper", "live"].includes(scope.environment))
    fail("invalid");
  if (collectionId !== null) identifier(collectionId);
  if (kind !== "manifest" && kind !== "content") fail("invalid");
  digestValue(sha256);
  const collection =
    collectionId === null
      ? "account"
      : `collection/${encodeURIComponent(collectionId)}`;
  return `vertex/v1/${encodeURIComponent(scope.accountAlias)}/${scope.environment}/${collection}/${kind}/sha256/${sha256}`;
};

const contracts: readonly VertexStorageArtifactMetadata["contractName"][] = [
  "DatasetManifest",
  "ResearchEvidence",
  "KnowledgeImport",
  "StrategySpec",
  "BacktestRun",
  "AgentRun",
  "ModuleManifest",
  "ModuleManifestList",
  "EventEnvelope",
  "TradeIntent",
  "PortfolioSnapshot",
  "AcceptedReview",
  "PaperSimulationAdmission",
  "ExecutionProjection",
  "NativeFactProjection",
  "NativeJournalProof",
];

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("invalid");
  return value as Readonly<Record<string, unknown>>;
};

// Public schemas reject provider configuration fields. This additional guard
// refuses local URLs, signed/private URI material and obvious credential text.
const assertNoPrivateReferences = (value: unknown): void => {
  if (typeof value === "string") {
    if (
      /(?:file|local):\/\/|\b(?:Bearer\s+[A-Za-z0-9_.-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(
        value
      )
    )
      fail("invalid");
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      try {
        const url = new URL(match[0]);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          fail("invalid");
      } catch {
        fail("invalid");
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateReferences(item);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(?:password|secret|token|apiKey|api_key|accessToken|refreshToken|authorization|cookie|credentials)$/i.test(
          key
        )
      )
        fail("invalid");
      assertNoPrivateReferences(item);
    }
  }
};

const required = (dependencies: VertexArtifactStorageDependencies) => {
  const { objects, metadata, catalog, rights, authorization, boundary, clock } =
    dependencies;
  if (
    !(
      objects &&
      metadata &&
      catalog &&
      rights &&
      authorization &&
      boundary &&
      clock
    )
  )
    fail("unavailable");
  if (typeof dependencies.objectCapabilities?.getBounded !== "function")
    fail("unavailable");
  if (
    typeof objects.get !== "function" ||
    typeof metadata.findByKey !== "function" ||
    typeof metadata.upsert !== "function" ||
    typeof catalog.findArtifact !== "function" ||
    typeof catalog.registerArtifact !== "function" ||
    typeof rights.resolveRights !== "function" ||
    typeof authorization.authorize !== "function" ||
    typeof boundary.validate !== "function" ||
    typeof boundary.encode !== "function" ||
    typeof boundary.digest !== "function" ||
    typeof clock.now !== "function"
  )
    fail("unavailable");
  const maximumContentBytes =
    dependencies.maximumContentBytes === undefined
      ? MAX_VERTEX_STORAGE_BYTES
      : dependencies.maximumContentBytes;
  if (!Number.isSafeInteger(maximumContentBytes) || maximumContentBytes <= 0)
    fail("invalid");
  return {
    objects,
    metadata,
    catalog,
    rights,
    authorization,
    boundary,
    clock,
    maximumContentBytes,
    capabilities: dependencies.objectCapabilities,
  };
};

type Ready = ReturnType<typeof required>;

const authorization = async (
  ports: Ready,
  request: VertexArtifactRequest,
  action: "read" | "publish" | "export"
): Promise<string> => {
  const now = ports.clock.now();
  instant(now);
  if (
    (await ports.authorization.authorize({
      principal: request.principal,
      scope: request.scope,
      collectionId: request.collectionId,
      resourceId: request.artifactId,
      action,
      now,
    })) !== true
  )
    fail("denied");
  return now;
};

const currentRights = async (
  ports: Ready,
  request: VertexArtifactRequest,
  policyId: string,
  use: "store" | "read" | "export"
): Promise<VertexStorageRights> => {
  identifier(policyId);
  const result = await ports.rights.resolveRights(
    request.principal,
    request.scope,
    request.collectionId,
    policyId
  );
  if (!result) fail("denied");
  // Snapshot through the injected canonical encoder before inspecting a mutable
  // repository value. This also refuses accessors/cycles/non-JSON graphs.
  const policy = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytesSnapshot(ports.boundary.encode(result))
    )
  ) as VertexStorageRights;
  if (
    Object.keys(policy).sort().join(",") !==
    "allowedUses,checkedAt,expiresAt,policyId,retentionUntil,status,version"
  )
    fail("denied");
  const now = instant(ports.clock.now());
  if (
    policy.policyId !== policyId ||
    policy.status !== "granted" ||
    !Array.isArray(policy.allowedUses) ||
    policy.allowedUses.length > 4 ||
    new Set(policy.allowedUses).size !== policy.allowedUses.length ||
    policy.allowedUses.some(
      (item) => !["store", "read", "derive", "export"].includes(item)
    ) ||
    !policy.allowedUses.includes(use) ||
    (use === "export" && !policy.allowedUses.includes("read"))
  )
    fail("denied");
  identifier(policy.version);
  if (
    policy.expiresAt === null ||
    instant(policy.checkedAt) > now ||
    instant(policy.expiresAt) <= now ||
    (policy.retentionUntil !== null && instant(policy.retentionUntil) <= now)
  )
    fail("denied");
  return Object.freeze({
    ...policy,
    allowedUses: Object.freeze([...policy.allowedUses]),
  });
};

const verifyDigest = async (
  ports: Ready,
  bytes: Uint8Array,
  expected: string
): Promise<void> => {
  digestValue(expected);
  if (
    digestValue(await ports.boundary.digest(new Uint8Array(bytes))) !== expected
  )
    fail("integrity");
};

const metadataCheck = (
  metadata: ObjectMetadata,
  key: string,
  sha256: string,
  length?: number,
  maximumBytes = MAX_VERTEX_STORAGE_BYTES
): void => {
  if (
    metadata.key !== key ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0
  )
    fail("integrity");
  if (metadata.size > maximumBytes) fail("too-large");
  if (length !== undefined && metadata.size !== length) fail("integrity");
  if (metadata.checksum !== undefined && metadata.checksum !== sha256)
    fail("integrity");
  instant(metadata.createdAt);
  instant(metadata.updatedAt);
  if (
    metadata.contentType !== undefined &&
    !["application/json", "application/octet-stream"].includes(
      metadata.contentType
    )
  )
    fail("integrity");
};

const backendRead = async (
  ports: Ready,
  key: string,
  sha256: string,
  length?: number,
  maximumBytes = MAX_VERTEX_STORAGE_BYTES
): Promise<StoredObject | null> => {
  // Catalog/repository/head metadata reject oversized objects before fetching.
  // The required bounded backend also caps allocation even when metadata lies.
  if (!ports.capabilities?.getBounded) fail("unavailable");
  if (
    length !== undefined &&
    (!Number.isSafeInteger(length) || length <= 0 || length > maximumBytes)
  )
    fail("too-large");
  let expectedLength = length;
  const known = await ports.metadata.findByKey(key);
  if (known) {
    metadataCheck(known, key, sha256, expectedLength, maximumBytes);
    expectedLength = known.size;
  }
  if (ports.capabilities?.head) {
    const head = await ports.capabilities.head(key);
    if (head.status === "unavailable") fail("unavailable");
    if (head.status === "not-found") return null;
    metadataCheck(head.value, key, sha256, expectedLength, maximumBytes);
    expectedLength = head.value.size;
  }
  const result = await ports.capabilities.getBounded(
    key,
    expectedLength ?? maximumBytes
  );
  if (result.status === "unavailable") fail("unavailable");
  if (result.status === "not-found") return null;
  metadataCheck(
    result.value.metadata,
    key,
    sha256,
    expectedLength,
    maximumBytes
  );
  const body = bytesSnapshot(result.value.body, maximumBytes);
  if (
    body.byteLength !== result.value.metadata.size ||
    (expectedLength !== undefined && body.byteLength !== expectedLength)
  )
    fail("integrity");
  await verifyDigest(ports, body, sha256);
  return {
    metadata: Object.freeze({
      key,
      size: body.byteLength,
      ...(result.value.metadata.contentType === undefined
        ? {}
        : { contentType: result.value.metadata.contentType }),
      ...(result.value.metadata.checksum === undefined
        ? {}
        : { checksum: result.value.metadata.checksum }),
      createdAt: result.value.metadata.createdAt,
      updatedAt: result.value.metadata.updatedAt,
    }),
    body,
  };
};

const ensureObject = async (
  ports: Ready,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  contentType: string,
  authorizeStore: () => Promise<void>,
  maximumBytes = MAX_VERTEX_STORAGE_BYTES
): Promise<ObjectMetadata> => {
  if (!ports.capabilities?.putIfAbsent) fail("unavailable");
  await verifyDigest(ports, bytes, sha256);
  await authorizeStore();
  let stored = await backendRead(
    ports,
    key,
    sha256,
    bytes.byteLength,
    maximumBytes
  );
  if (!stored) {
    await authorizeStore();
    const result = await ports.capabilities.putIfAbsent({
      key,
      body: new Uint8Array(bytes),
      checksum: sha256,
      contentType,
    });
    if (result.status !== "ok") fail("unavailable");
    metadataCheck(result.value, key, sha256, bytes.byteLength, maximumBytes);
    stored = await backendRead(
      ports,
      key,
      sha256,
      bytes.byteLength,
      maximumBytes
    );
  }
  if (!(stored && sameBytes(stored.body, bytes))) fail("conflict");
  // Retry repairs missing metadata. Never roll back by deleting a shared object
  // after metadata/catalog failure; another immutable alias may already use it.
  await authorizeStore();
  await ports.metadata.upsert(stored.metadata);
  return stored.metadata;
};

const canonicalManifest = async (
  ports: Ready,
  contractName: VertexStorageArtifactMetadata["contractName"],
  bytes: Uint8Array
): Promise<unknown> => {
  if (!contracts.includes(contractName)) fail("invalid");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    );
  } catch {
    return fail("invalid");
  }
  if (!sameBytes(bytes, bytesSnapshot(ports.boundary.encode(value))))
    fail("integrity");
  assertNoPrivateReferences(value);
  if (contractName === "ModuleManifestList") {
    if (!Array.isArray(value) || value.length > 256) fail("invalid");
    const ids = new Set<string>();
    for (const item of value) {
      const validated = await ports.boundary.validate(
        "ModuleManifest",
        item,
        "1.0.0"
      );
      if (
        !sameBytes(
          bytesSnapshot(ports.boundary.encode(item)),
          bytesSnapshot(ports.boundary.encode(validated))
        )
      )
        fail("integrity");
      const moduleId = identifier(record(validated)["moduleId"] as string);
      if (ids.has(moduleId)) fail("invalid");
      ids.add(moduleId);
    }
  } else {
    const validated = await ports.boundary.validate(
      contractName,
      value,
      "1.0.0"
    );
    if (!sameBytes(bytes, bytesSnapshot(ports.boundary.encode(validated))))
      fail("integrity");
  }
  return value;
};

const manifestBinding = (
  value: unknown,
  metadata: VertexStorageArtifactMetadata
): void => {
  if (metadata.contractName === "ModuleManifestList") {
    if (metadata.collectionId !== null || metadata.sourceContentSha256 !== null)
      fail("integrity");
    return;
  }
  const payload = record(value);
  if (
    metadata.contractName === "DatasetManifest" ||
    metadata.contractName === "ResearchEvidence"
  ) {
    if (
      metadata.sourceContentSha256 === null ||
      payload["contentHash"] !== metadata.sourceContentSha256
    )
      fail("integrity");
    if (
      metadata.contractName === "ResearchEvidence" &&
      (payload["collectionId"] !== metadata.collectionId ||
        payload["rightsPolicyId"] !== metadata.rights.policyId)
    )
      fail("integrity");
    if (
      metadata.contractName === "DatasetManifest" &&
      payload["entitlementPolicyId"] !== metadata.rights.policyId
    )
      fail("integrity");
  } else if (metadata.sourceContentSha256 !== null) {
    fail("integrity");
  }
  if (
    metadata.contractName === "KnowledgeImport" &&
    (payload["collectionId"] !== metadata.collectionId ||
      payload["rightsPolicyId"] !== metadata.rights.policyId)
  )
    fail("integrity");
  if (
    payload["collectionId"] !== undefined &&
    payload["collectionId"] !== metadata.collectionId
  )
    fail("integrity");
  if (
    payload["accountAlias"] !== undefined &&
    payload["accountAlias"] !== metadata.scope.accountAlias
  )
    fail("integrity");
  if (
    payload["environment"] !== undefined &&
    payload["environment"] !== metadata.scope.environment
  )
    fail("integrity");
};

const catalogSnapshot = (
  ports: Ready,
  source: VertexStorageArtifactMetadata,
  request: VertexArtifactRequest
): VertexStorageArtifactMetadata => {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytesSnapshot(ports.boundary.encode(source))
    )
  ) as VertexStorageArtifactMetadata;
  if (
    Object.keys(value).sort().join(",") !==
      "artifactId,artifactSha256,byteLength,collectionId,contentType,contractName,createdAt,lineageArtifactIds,objectKey,rights,schemaVersion,scope,sourceContentSha256" ||
    Object.keys(value.scope).sort().join(",") !== "accountAlias,environment" ||
    Object.keys(value.rights).sort().join(",") !==
      "allowedUses,checkedAt,expiresAt,policyId,retentionUntil,status,version"
  )
    fail("integrity");
  if (
    value.artifactId !== request.artifactId ||
    !sameScope(value.scope, request.scope) ||
    value.collectionId !== request.collectionId ||
    value.schemaVersion !== "1.0.0" ||
    value.contentType !== "application/json" ||
    !contracts.includes(value.contractName)
  )
    fail("integrity");
  if (
    value.objectKey !==
    vertexQualifiedObjectKey(
      request.scope,
      request.collectionId,
      "manifest",
      value.artifactSha256
    )
  )
    fail("integrity");
  if (
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > MAX_VERTEX_STORAGE_BYTES
  )
    fail("too-large");
  if (value.sourceContentSha256 !== null)
    digestValue(value.sourceContentSha256);
  if (
    !Array.isArray(value.lineageArtifactIds) ||
    value.lineageArtifactIds.length > 512 ||
    new Set(value.lineageArtifactIds).size !== value.lineageArtifactIds.length
  )
    fail("integrity");
  value.lineageArtifactIds.forEach(identifier);
  identifier(value.rights.policyId);
  if (instant(value.createdAt) > instant(ports.clock.now())) fail("integrity");
  return Object.freeze({
    ...value,
    scope: Object.freeze({ ...value.scope }),
    rights: Object.freeze({
      ...value.rights,
      allowedUses: Object.freeze([...value.rights.allowedUses]),
    }),
    lineageArtifactIds: Object.freeze([...value.lineageArtifactIds]),
  });
};

const aliasMatches = (
  left: VertexStorageArtifactMetadata,
  right: VertexStorageArtifactMetadata
): boolean => {
  return (
    left.artifactId === right.artifactId &&
    sameScope(left.scope, right.scope) &&
    left.collectionId === right.collectionId &&
    left.objectKey === right.objectKey &&
    left.artifactSha256 === right.artifactSha256 &&
    left.sourceContentSha256 === right.sourceContentSha256 &&
    left.byteLength === right.byteLength &&
    left.contractName === right.contractName &&
    left.rights.policyId === right.rights.policyId &&
    left.createdAt === right.createdAt &&
    left.lineageArtifactIds.length === right.lineageArtifactIds.length &&
    left.lineageArtifactIds.every(
      (id, index) => id === right.lineageArtifactIds[index]
    )
  );
};

const readCatalogManifest = async (
  ports: Ready,
  request: VertexArtifactRequest,
  source: VertexStorageArtifactMetadata
): Promise<VertexManifestRead> => {
  const metadata = catalogSnapshot(ports, source, request);
  await authorization(ports, request, "read");
  await currentRights(ports, request, metadata.rights.policyId, "read");
  const stored = await backendRead(
    ports,
    metadata.objectKey,
    metadata.artifactSha256,
    metadata.byteLength
  );
  if (!stored) fail("integrity");
  manifestBinding(
    await canonicalManifest(ports, metadata.contractName, stored.body),
    metadata
  );
  await authorization(ports, request, "read");
  await currentRights(ports, request, metadata.rights.policyId, "read");
  return Object.freeze({ bytes: new Uint8Array(stored.body), metadata });
};

export const createVertexArtifactStorage = (
  dependencies: VertexArtifactStorageDependencies = {}
): VertexArtifactStorage => {
  const manifestOperation = (
    input: VertexManifestPut,
    publish: boolean
  ): Promise<VertexStorageArtifactMetadata> =>
    guarded(async () => {
      const ports = required(dependencies);
      if (!ports.capabilities?.putIfAbsent) fail("unavailable");
      const request = requestSnapshot(input);
      const contractName = input.contractName;
      const artifactSha256 = digestValue(input.artifactSha256);
      const sourceContentSha256 =
        input.sourceContentSha256 === null
          ? null
          : digestValue(input.sourceContentSha256);
      const rightsPolicyId = identifier(input.rightsPolicyId);
      const createdAt = input.createdAt;
      if (
        !Array.isArray(input.lineageArtifactIds) ||
        input.lineageArtifactIds.length > 512
      )
        fail("invalid");
      const lineageArtifactIds = Object.freeze([...input.lineageArtifactIds]);
      // Snapshot mutable payloads and source bytes before the first await.
      const bytes = bytesSnapshot(ports.boundary.encode(input.manifest));
      const sourceBytes =
        input.sourceBytes === undefined
          ? undefined
          : bytesSnapshot(input.sourceBytes, ports.maximumContentBytes);
      await authorization(ports, request, "publish");
      const rights = await currentRights(
        ports,
        request,
        rightsPolicyId,
        "store"
      );
      const authorizeStore = async (): Promise<void> => {
        await authorization(ports, request, "publish");
        await currentRights(ports, request, rightsPolicyId, "store");
      };
      await verifyDigest(ports, bytes, artifactSha256);
      const value = await canonicalManifest(ports, contractName, bytes);
      const metadata = catalogSnapshot(
        ports,
        {
          artifactId: request.artifactId,
          scope: request.scope,
          collectionId: request.collectionId,
          objectKey: vertexQualifiedObjectKey(
            request.scope,
            request.collectionId,
            "manifest",
            artifactSha256
          ),
          artifactSha256,
          sourceContentSha256,
          byteLength: bytes.byteLength,
          contentType: "application/json",
          schemaVersion: "1.0.0",
          contractName,
          rights,
          lineageArtifactIds,
          createdAt,
        },
        request
      );
      manifestBinding(value, metadata);
      const existingSource = await ports.catalog.findArtifact(
        request.principal,
        request.scope,
        request.collectionId,
        request.artifactId
      );
      const existing =
        existingSource === null
          ? null
          : catalogSnapshot(ports, existingSource, request);
      if (existing && !aliasMatches(existing, metadata)) fail("conflict");
      if (sourceContentSha256 !== null) {
        const contentKey = vertexQualifiedObjectKey(
          request.scope,
          request.collectionId,
          "content",
          sourceContentSha256
        );
        if (sourceBytes) {
          await ensureObject(
            ports,
            contentKey,
            sourceBytes,
            sourceContentSha256,
            "application/octet-stream",
            authorizeStore,
            ports.maximumContentBytes
          );
        } else if (
          !(await backendRead(
            ports,
            contentKey,
            sourceContentSha256,
            undefined,
            ports.maximumContentBytes
          ))
        ) {
          fail("integrity");
        }
      } else if (sourceBytes !== undefined) {
        fail("invalid");
      }
      await ensureObject(
        ports,
        metadata.objectKey,
        bytes,
        artifactSha256,
        "application/json",
        authorizeStore
      );
      // A policy may have changed while object I/O was pending. Never publish
      // the catalog alias using a cached grant; retained orphan bytes are inert.
      await authorization(ports, request, "publish");
      await currentRights(ports, request, rightsPolicyId, "store");
      // Atomic review/queue commands receive prepared metadata and publish the
      // alias inside their own SQL transaction. No catalog mutation when staging.
      if (!publish || existing) return existing ?? metadata;
      const registered = await ports.catalog.registerArtifact(
        request.principal,
        metadata
      );
      if (registered !== "recorded" && registered !== "duplicate")
        fail("unavailable");
      const persisted = await ports.catalog.findArtifact(
        request.principal,
        request.scope,
        request.collectionId,
        request.artifactId
      );
      if (!persisted) fail("integrity");
      const result = catalogSnapshot(ports, persisted, request);
      if (!aliasMatches(result, metadata)) fail("conflict");
      await authorizeStore();
      return result;
    });
  return Object.freeze({
    putContent: (input: VertexContentPut) =>
      guarded(async () => {
        const ports = required(dependencies);
        if (!ports.capabilities?.putIfAbsent) fail("unavailable");
        const sourceContentSha256 = digestValue(input.sourceContentSha256);
        const rightsPolicyId = identifier(input.rightsPolicyId);
        const request = requestSnapshot({
          ...input,
          artifactId: `content-${sourceContentSha256}`,
        });
        const bytes = bytesSnapshot(input.bytes, ports.maximumContentBytes);
        await authorization(ports, request, "publish");
        await currentRights(ports, request, rightsPolicyId, "store");
        const authorizeStore = async (): Promise<void> => {
          await authorization(ports, request, "publish");
          await currentRights(ports, request, rightsPolicyId, "store");
        };
        await verifyDigest(ports, bytes, sourceContentSha256);
        const objectKey = vertexQualifiedObjectKey(
          request.scope,
          request.collectionId,
          "content",
          sourceContentSha256
        );
        await ensureObject(
          ports,
          objectKey,
          bytes,
          sourceContentSha256,
          "application/octet-stream",
          authorizeStore,
          ports.maximumContentBytes
        );
        await authorization(ports, request, "publish");
        await currentRights(ports, request, rightsPolicyId, "store");
        return Object.freeze({
          objectKey,
          sourceContentSha256,
          byteLength: bytes.byteLength,
        });
      }),
    stageManifest: (input: VertexManifestPut) =>
      manifestOperation(input, false),
    putManifest: (input: VertexManifestPut) => manifestOperation(input, true),
    getManifest: (input: VertexArtifactRequest) =>
      guarded(async () => {
        const ports = required(dependencies);
        const request = requestSnapshot(input);
        await authorization(ports, request, "read");
        const metadata = await ports.catalog.findArtifact(
          request.principal,
          request.scope,
          request.collectionId,
          request.artifactId
        );
        return metadata === null
          ? null
          : readCatalogManifest(ports, request, metadata);
      }),
    getContent: (
      input: VertexArtifactRequest & Readonly<{ use: "read" | "export" }>
    ) =>
      guarded(async () => {
        const ports = required(dependencies);
        const request = requestSnapshot(input);
        const use = input.use;
        if (use !== "read" && use !== "export") fail("invalid");
        await authorization(ports, request, "read");
        if (use === "export") await authorization(ports, request, "export");
        const source = await ports.catalog.findArtifact(
          request.principal,
          request.scope,
          request.collectionId,
          request.artifactId
        );
        if (source === null) return null;
        const metadata = catalogSnapshot(ports, source, request);
        await currentRights(ports, request, metadata.rights.policyId, use);
        await readCatalogManifest(ports, request, metadata);
        if (metadata.sourceContentSha256 === null) fail("invalid");
        const key = vertexQualifiedObjectKey(
          request.scope,
          request.collectionId,
          "content",
          metadata.sourceContentSha256
        );
        await authorization(ports, request, "read");
        if (use === "export") await authorization(ports, request, "export");
        await currentRights(ports, request, metadata.rights.policyId, use);
        const stored = await backendRead(
          ports,
          key,
          metadata.sourceContentSha256,
          undefined,
          ports.maximumContentBytes
        );
        if (!stored) fail("integrity");
        await authorization(ports, request, "read");
        if (use === "export") await authorization(ports, request, "export");
        await currentRights(ports, request, metadata.rights.policyId, use);
        return new Uint8Array(stored.body);
      }),
  });
};

export type VertexReadIdentity = Readonly<{ kind: "modules" }>;
export type VertexReadArtifact = Readonly<{
  bytes: Uint8Array;
  artifactSha256: string;
  identity: VertexReadIdentity;
}>;
export type VertexReadLookup = Readonly<{ kind: "modules" }>;
export type VertexStorageReadPort<Principal> = Readonly<{
  listModules: (principal: Principal) => Promise<VertexReadArtifact>;
}>;
export type VertexReadPortDependencies<Principal> =
  VertexArtifactStorageDependencies &
    Readonly<{
      catalog?: VertexReadCatalog | undefined;
      mapPrincipal?:
        | ((
            principal: Principal
          ) => VertexStoragePrincipal | Promise<VertexStoragePrincipal>)
        | undefined;
      // Catalog scope MUST come from a trusted resolver. A null collection is
      // account scope, never a wildcard over collections.
      resolveScope?:
        | ((
            principal: Principal,
            lookup: VertexReadLookup
          ) =>
            | Readonly<{
                scope: VertexStorageScope;
                collectionId: string | null;
              }>
            | Promise<
                Readonly<{
                  scope: VertexStorageScope;
                  collectionId: string | null;
                }>
              >)
        | undefined;
    }>;

// Structurally satisfies the API VertexReadPort without importing its server,
// auth runtime, public schemas or database internals into this package.
export const createVertexReadPort = <Principal>(
  dependencies: VertexReadPortDependencies<Principal> = {}
): VertexStorageReadPort<Principal> => {
  const load = (
    principal: Principal,
    lookup: VertexReadLookup
  ): Promise<VertexReadArtifact> =>
    guarded(async () => {
      const ports = required(dependencies);
      const catalog = dependencies.catalog;
      if (!(catalog && dependencies.mapPrincipal && dependencies.resolveScope))
        fail("unavailable");
      const mappedSource = await dependencies.mapPrincipal(principal);
      const mapped = Object.freeze({
        actorId: identifier(mappedSource.actorId),
      });
      const resolved = await dependencies.resolveScope(principal, lookup);
      if (resolved.collectionId !== null) fail("denied");
      const request = requestSnapshot({
        principal: mapped,
        scope: resolved.scope,
        collectionId: resolved.collectionId,
        artifactId: "modules",
      });
      await authorization(ports, request, "read");
      const source = await catalog.findModuleCatalog(
        request.principal,
        request.scope
      );
      if (source === null) fail("unavailable");
      const detachedSource = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytesSnapshot(ports.boundary.encode(source))
        )
      ) as VertexStorageArtifactMetadata;
      const artifactRequest = requestSnapshot({
        ...request,
        artifactId: detachedSource.artifactId,
      });
      const metadata = catalogSnapshot(ports, detachedSource, artifactRequest);
      if (metadata.contractName !== "ModuleManifestList") fail("integrity");
      const stored = await readCatalogManifest(
        ports,
        artifactRequest,
        metadata
      );
      // Reject non-JSON catalog bytes before the final authorization rechecks.
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)
      );
      await authorization(ports, request, "read");
      await currentRights(
        ports,
        artifactRequest,
        metadata.rights.policyId,
        "read"
      );
      return Object.freeze({
        bytes: new Uint8Array(stored.bytes),
        artifactSha256: metadata.artifactSha256,
        identity: Object.freeze({ kind: "modules" }),
      });
    });
  return Object.freeze({
    listModules: (principal: Principal) =>
      load(principal, Object.freeze({ kind: "modules" })),
  });
};
