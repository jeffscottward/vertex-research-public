import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexAction,
  VertexArtifactMetadata,
  VertexAuthorizationRepository,
  VertexClock,
  VertexCommandPolicyIdentity,
  VertexPrincipal,
  VertexScope,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import { VertexStoreError } from "@darkfactory/db/server/vertex";
import { VertexArtifactStorageError } from "@darkfactory/storage/vertex";
import type {
  VertexArtifactStorage,
  VertexManifestPut,
} from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  VersionSchema,
  type AgentRun,
} from "../contracts/vertex.ts";
import { VertexPortfolioGetInputSchema } from "../contracts/vertex-control.ts";
import {
  VERTEX_EXPERIENCE_ERRORS,
  VertexCursorSchema,
} from "../contracts/vertex-experience.ts";
import type { VertexBacktestExpectation } from "../contracts/vertex-experience.ts";
import { present } from "./present.ts";

export type VertexResearchBinding = Readonly<{
  // Supplied only by a real configured supervisor/model transport adapter.
  available: (scope: VertexScope, signal?: AbortSignal) => Promise<boolean>;
  taskContract: string;
  modelVersion: string;
  tokenBudget: number;
  costBudgetUsd: string;
  rightsPolicyId: string;
  allowedTools: readonly AgentRun["allowedTools"][number][];
}>;
export type VertexSimulationBinding = Readonly<{
  // This checks PAPER-SIMULATION capability, never broker-paper/live readiness.
  available: (scope: VertexScope, signal?: AbortSignal) => Promise<boolean>;
  simulatorId: string;
  maximumLoss: string;
  maximumNotional: string;
  ttlMilliseconds: number;
}>;
export type VertexReviewPolicy = Readonly<{
  version: string;
  reviewVersion: string;
  ttlMilliseconds: number;
}>;
export type VertexExperiencePolicyIdentity = VertexCommandPolicyIdentity;
export type VertexExperiencePolicy = Readonly<{
  reviewPolicy?: VertexReviewPolicy;
  research?: VertexResearchBinding;
  simulation?: VertexSimulationBinding;
  policyIdentity?: VertexExperiencePolicyIdentity;
}>;
export type VertexExperiencePolicyResolver = (
  principal: VertexPrincipal,
  scope: VertexScope,
  signal?: AbortSignal
) => Promise<VertexExperiencePolicy>;
export type VertexExperienceDependencies = Readonly<{
  store?: VertexStore;
  authorization?: VertexAuthorizationRepository;
  clock?: VertexClock;
  storage?: (
    principal: VertexPrincipal,
    scope: VertexScope,
    collectionId: string | null
  ) => VertexArtifactStorage;
  // Write immutable bytes without publishing a catalog alias. Atomic DB command
  // registration is the ONLY operation that makes the staged record visible.
  prepareManifest?: (
    input: VertexManifestPut
  ) => Promise<VertexArtifactMetadata>;
  validateBacktestRequest?: (
    principal: VertexPrincipal,
    scope: VertexScope,
    collectionId: string,
    expectation: VertexBacktestExpectation
  ) => Promise<void>;
  // When present, this is the exclusive source of scoped policy. Static
  // bindings remain compatible only for consumers without a runtime resolver.
  resolvePolicy?: VertexExperiencePolicyResolver;
  reviewPolicy?: VertexReviewPolicy;
  research?: VertexResearchBinding;
  simulation?: VertexSimulationBinding;
  gateway?: Readonly<{
    // Every configured gateway with its account scope; untrusted until parsed.
    listBindings: () => Promise<unknown>;
    resolveScope: (
      gatewayId: string,
      environment: "paper" | "live"
    ) => Promise<VertexScope | null>;
    readStatus: (
      principal: VertexPrincipal,
      gatewayId: string,
      environment: "paper" | "live",
      signal?: AbortSignal
    ) => Promise<unknown>;
  }>;
  signal?: AbortSignal;
}>;
export type VertexExperienceErrorCode = keyof typeof VERTEX_EXPERIENCE_ERRORS;
export class VertexExperienceServiceError extends Error {
  readonly code: VertexExperienceErrorCode;
  constructor(code: VertexExperienceErrorCode) {
    super(VERTEX_EXPERIENCE_ERRORS[code].message);
    this.name = "VertexExperienceServiceError";
    this.code = code;
  }
}

export const failVertex = (code: VertexExperienceErrorCode): never => {
  throw new VertexExperienceServiceError(code);
};
export const checkVertexCancellation = (
  dependencies: VertexExperienceDependencies
): void => {
  if (dependencies.signal?.aborted) failVertex("SERVICE_UNAVAILABLE");
};
export const vertexInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try {
    canonicalArtifactJson(value);
    return schema.parse(value);
  } catch {
    return failVertex("BAD_REQUEST");
  }
};
export const vertexSource = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try {
    canonicalArtifactJson(value);
    return schema.parse(value);
  } catch {
    return failVertex("INVALID_SOURCE");
  }
};
export const vertexOperation = async <T>(
  dependencies: VertexExperienceDependencies,
  operation: () => Promise<T>
): Promise<T> => {
  checkVertexCancellation(dependencies);
  try {
    const result = await operation();
    checkVertexCancellation(dependencies);
    return result;
  } catch (error) {
    if (error instanceof VertexExperienceServiceError) throw error;
    if (
      error instanceof VertexStoreError ||
      error instanceof VertexArtifactStorageError
    ) {
      if (error.code === "denied") return failVertex("FORBIDDEN");
      if (error.code === "conflict" || error.code === "stale")
        return failVertex("CONFLICT");
      if (error.code === "integrity" || error.code === "too-large")
        return failVertex("INVALID_SOURCE");
      if (error.code === "invalid") return failVertex("BAD_REQUEST");
    }
    // Infrastructure adapters translate their own known typed errors. Arbitrary
    // provider exceptions are never reflected, even when they carry a code.
    return failVertex("SERVICE_UNAVAILABLE");
  }
};
export const vertexPorts = (dependencies: VertexExperienceDependencies) => {
  if (!(dependencies.store && dependencies.authorization && dependencies.clock))
    return failVertex("SERVICE_UNAVAILABLE");
  return {
    store: dependencies.store,
    authorization: dependencies.authorization,
    clock: dependencies.clock,
  };
};
export const vertexActor = (principal: SafePrincipal): VertexPrincipal => {
  if (principal.status !== "active") return failVertex("FORBIDDEN");
  return Object.freeze({
    actorId: vertexInput(IdentifierSchema, principal.userId),
  });
};
export const vertexNow = (
  dependencies: VertexExperienceDependencies
): string => {
  return vertexSource(TimestampSchema, vertexPorts(dependencies).clock.now());
};
export const sameVertexScope = (
  left: VertexScope,
  right: VertexScope
): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
export const authorizeVertex = async (
  dependencies: VertexExperienceDependencies,
  principal: VertexPrincipal,
  scope: VertexScope,
  resourceId: string,
  action: VertexAction = "read",
  collectionId: string | null = null
): Promise<void> => {
  checkVertexCancellation(dependencies);
  const granted = await vertexOperation(dependencies, () =>
    vertexPorts(dependencies).authorization.authorize({
      principal,
      scope,
      collectionId,
      resourceId,
      action,
      now: vertexNow(dependencies),
    })
  );
  if (granted !== true) failVertex("FORBIDDEN");
};
export const requireVertexScope = async (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  scope: VertexScope
): Promise<VertexPrincipal> => {
  const actor = vertexActor(principal);
  await authorizeVertex(dependencies, actor, scope, "account-scope");
  return actor;
};

const PolicyIdentitySchema = z
  .object({
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    selectionRevision: z.string().regex(/^(0|[1-9]\d{0,29})$/),
    revision: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  })
  .strict();
export const resolveVertexExperiencePolicy = async (
  dependencies: VertexExperienceDependencies,
  principal: VertexPrincipal,
  scope: VertexScope
): Promise<VertexExperiencePolicy> => {
  // Every invocation is account-authorized. A request-shared dependencies
  // object must never be mutated or used to cache another account's policy.
  const actor = Object.freeze({ ...principal });
  const selectedScope = Object.freeze({ ...scope });
  await authorizeVertex(dependencies, actor, selectedScope, "account-scope");
  const resolve = dependencies.resolvePolicy;
  const resolved: VertexExperiencePolicy = resolve
    ? await vertexOperation(dependencies, () =>
        resolve(actor, selectedScope, dependencies.signal)
      )
    : dependencies;
  if (!resolved || typeof resolved !== "object")
    return failVertex("SERVICE_UNAVAILABLE");
  const { reviewPolicy, research, simulation, policyIdentity } = resolved;
  if (resolve && (reviewPolicy || research || simulation) && !policyIdentity)
    return failVertex("SERVICE_UNAVAILABLE");
  // Snapshot before any more asynchronous work. In particular, retain neither
  // a mutable allowed-tools array nor the resolver's mutable selection pin.
  return Object.freeze({
    ...(reviewPolicy === undefined
      ? {}
      : { reviewPolicy: Object.freeze({ ...reviewPolicy }) }),
    ...(research === undefined
      ? {}
      : {
          research: Object.freeze({
            ...research,
            allowedTools: Object.freeze([...research.allowedTools]),
          }),
        }),
    ...(simulation === undefined
      ? {}
      : { simulation: Object.freeze({ ...simulation }) }),
    ...(policyIdentity === undefined
      ? {}
      : {
          policyIdentity: Object.freeze(
            vertexSource(PolicyIdentitySchema, policyIdentity)
          ),
        }),
  });
};

const ArtifactMetadataSchema = z
  .object({
    artifactId: IdentifierSchema,
    scope: VertexPortfolioGetInputSchema,
    collectionId: IdentifierSchema.nullable(),
    objectKey: z.string().min(1).max(1024),
    artifactSha256: DigestSchema,
    sourceContentSha256: DigestSchema.nullable(),
    byteLength: z.number().int().min(1).max(1_048_576),
    contentType: z.literal("application/json"),
    schemaVersion: z.literal("1.0.0"),
    contractName: z.enum([
      "DatasetManifest",
      "ResearchEvidence",
      "KnowledgeImport",
      "StrategySpec",
      "BacktestRun",
      "AgentRun",
      "ModuleManifest",
      "TradeIntent",
      "EventEnvelope",
      "PortfolioSnapshot",
      "AcceptedReview",
      "PaperSimulationAdmission",
      "ExecutionProjection",
      "NativeFactProjection",
      "NativeJournalProof",
      "ModuleManifestList",
    ]),
    rights: z
      .object({
        policyId: IdentifierSchema,
        version: VersionSchema,
        status: z.enum(["granted", "denied", "expired", "unknown"]),
        allowedUses: z
          .array(z.enum(["store", "read", "derive", "export"]))
          .max(4),
        checkedAt: TimestampSchema,
        expiresAt: TimestampSchema.nullable(),
        retentionUntil: TimestampSchema.nullable(),
      })
      .strict(),
    lineageArtifactIds: z.array(IdentifierSchema).max(512),
    createdAt: TimestampSchema,
  })
  .strict();
export const vertexArtifactMetadata = (
  value: unknown
): VertexArtifactMetadata => vertexSource(ArtifactMetadataSchema, value);

export const loadVertexArtifact = async <T>(
  dependencies: VertexExperienceDependencies,
  principal: VertexPrincipal,
  scope: VertexScope,
  rawMetadata: VertexArtifactMetadata,
  schema: z.ZodType<T>,
  contractName: VertexArtifactMetadata["contractName"]
) => {
  if (!dependencies.storage) return failVertex("SERVICE_UNAVAILABLE");
  // Snapshot strict catalog metadata before asynchronous work. A raw object,
  // acceptance label or schema-valid record alone is never a committed record.
  const metadata = vertexSource(ArtifactMetadataSchema, rawMetadata);
  if (
    !sameVertexScope(metadata.scope, scope) ||
    metadata.contractName !== contractName
  )
    return failVertex("INVALID_SOURCE");
  vertexSource(IdentifierSchema, metadata.artifactId);
  vertexSource(DigestSchema, metadata.artifactSha256);
  await authorizeVertex(
    dependencies,
    principal,
    scope,
    metadata.artifactId,
    "read",
    metadata.collectionId
  );
  const stored = await vertexOperation(dependencies, () =>
    present(dependencies.storage)(
      principal,
      scope,
      metadata.collectionId
    ).getManifest({
      principal,
      scope,
      collectionId: metadata.collectionId,
      artifactId: metadata.artifactId,
    })
  );
  if (stored === null) return failVertex("NOT_FOUND");
  try {
    if (
      typeof stored !== "object" ||
      Object.getPrototypeOf(stored) !== Object.prototype
    )
      return failVertex("INVALID_SOURCE");
    const fields = Object.getOwnPropertyDescriptors(stored);
    if (
      Reflect.ownKeys(stored).length !== 2 ||
      !Object.hasOwn(fields, "bytes") ||
      !Object.hasOwn(fields, "metadata") ||
      Object.values(fields).some(
        (field) => !(field.enumerable && Object.hasOwn(field, "value"))
      )
    )
      return failVertex("INVALID_SOURCE");
    const source: unknown = present(fields.bytes).value;
    if (
      !(source instanceof Uint8Array) ||
      Object.getPrototypeOf(source) !== Uint8Array.prototype ||
      Object.hasOwn(source, "buffer") ||
      Object.hasOwn(source, "byteLength") ||
      !(source.buffer instanceof ArrayBuffer) ||
      source.byteLength === 0 ||
      source.byteLength > 1_048_576
    )
      return failVertex("INVALID_SOURCE");
    const bytes = new Uint8Array(source);
    const actual = vertexSource(
      ArtifactMetadataSchema,
      present(fields.metadata).value
    );
    if (
      actual.artifactId !== metadata.artifactId ||
      actual.artifactSha256 !== metadata.artifactSha256 ||
      actual.contractName !== contractName ||
      actual.collectionId !== metadata.collectionId ||
      !sameVertexScope(actual.scope, scope) ||
      actual.sourceContentSha256 !== metadata.sourceContentSha256 ||
      actual.rights.policyId !== metadata.rights.policyId ||
      actual.byteLength !== bytes.byteLength
    )
      return failVertex("INVALID_SOURCE");
    if ((await hashArtifact(bytes)) !== metadata.artifactSha256)
      return failVertex("INVALID_SOURCE");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (canonicalArtifactJson(raw) !== text)
      return failVertex("INVALID_SOURCE");
    const value = schema.parse(raw);
    if (canonicalArtifactJson(value) !== text)
      return failVertex("INVALID_SOURCE");
    const record = value as Readonly<Record<string, unknown>>;
    if (
      (record["accountAlias"] !== undefined &&
        record["accountAlias"] !== scope.accountAlias) ||
      (record["environment"] !== undefined &&
        record["environment"] !== scope.environment) ||
      (record["collectionId"] !== undefined &&
        record["collectionId"] !== metadata.collectionId)
    )
      return failVertex("INVALID_SOURCE");
    if (
      contractName === "ResearchEvidence" &&
      (record["contentHash"] !== metadata.sourceContentSha256 ||
        record["rightsPolicyId"] !== metadata.rights.policyId)
    )
      return failVertex("INVALID_SOURCE");
    if (
      contractName === "DatasetManifest" &&
      (record["contentHash"] !== metadata.sourceContentSha256 ||
        record["entitlementPolicyId"] !== metadata.rights.policyId)
    )
      return failVertex("INVALID_SOURCE");
    checkVertexCancellation(dependencies);
    return Object.freeze({
      artifactId: metadata.artifactId,
      sha256: metadata.artifactSha256,
      value,
    });
  } catch (error) {
    if (error instanceof VertexExperienceServiceError) throw error;
    return failVertex("INVALID_SOURCE");
  }
};

export const vertexPage = <T>(
  page: Readonly<{ items: readonly T[]; nextCursor: string | null }>,
  limit: number
) => {
  if (!(page && Array.isArray(page.items)) || page.items.length > limit)
    return failVertex("INVALID_SOURCE");
  vertexSource(VertexCursorSchema, page.nextCursor);
  return page;
};
export const collectVertexPages = async <T>(
  read: (
    cursor: string | null
  ) => Promise<Readonly<{ items: readonly T[]; nextCursor: string | null }>>,
  maximum = 512
): Promise<readonly T[]> => {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const result: T[] = [];
  for (let count = 0; count < 8; count += 1) {
    const page: Readonly<{ items: readonly T[]; nextCursor: string | null }> =
      vertexPage(await read(cursor), 100);
    result.push(...page.items);
    if (result.length > maximum) return failVertex("SERVICE_UNAVAILABLE");
    if (page.nextCursor === null) return result;
    if (seen.has(page.nextCursor)) return failVertex("INVALID_SOURCE");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return failVertex("SERVICE_UNAVAILABLE");
};
