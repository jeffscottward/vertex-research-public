import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  createVertexAuthorization,
  type VertexArtifactMetadata,
  type VertexGrantVersion,
} from "@darkfactory/db/server/vertex";
import type { Database, Transaction } from "@darkfactory/db/server";
import type {
  PolicyPrincipal,
  PolicyScope,
  CurrentModelUseContext,
} from "@darkfactory/config/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { AcceptedReviewSchema } from "../contracts/vertex-control.ts";
import {
  DigestSchema,
  IdentifierSchema,
  NonnegativeDecimalSchema,
  TimestampSchema,
  VersionSchema,
  ResearchEvidenceSchema,
} from "../contracts/vertex.ts";
import { WorkerCurrentRightsOutputSchema } from "../contracts/vertex-worker.ts";
import {
  ModelUseRequestSchema,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { present } from "./present.ts";

const scopeShape = {
  accountAlias: IdentifierSchema,
  environment: z.enum(["research", "paper"]),
};
// These private persisted document formats live at the API authority, not in a
// downstream validator clone. They convey no storage or trading permission.
export const VertexRuntimeModelDescriptorSchema = z
  .object({
    format: z.literal("vertex-model-binding-v1"),
    ...scopeShape,
    providerId: IdentifierSchema,
    modelVersion: IdentifierSchema,
    tokenizerArtifactId: IdentifierSchema,
    tokenizerSha256: DigestSchema,
    endpointReferenceId: IdentifierSchema,
    endpointSha256: DigestSchema,
    modelUsePolicyVersion: VersionSchema,
    expiresAt: TimestampSchema,
    pricing: z
      .object({
        currency: z.literal("USD"),
        basis: z.literal("conservative-input-byte-output-token-ceiling"),
        tokenizationBaseUsd: NonnegativeDecimalSchema,
        tokenizationInputByteUsd: NonnegativeDecimalSchema,
        completionBaseUsd: NonnegativeDecimalSchema,
        completionInputByteUsd: NonnegativeDecimalSchema,
        outputTokenUsd: NonnegativeDecimalSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
  })
  .strict()
  .readonly();
export const VertexRuntimeModelBudgetPolicySchema = z
  .object({
    format: z.literal("vertex-model-budget-policy-v1"),
    ...scopeShape,
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    periodId: IdentifierSchema,
    startsAt: TimestampSchema,
    expiresAt: TimestampSchema,
    maximumTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maximumCostUsd: NonnegativeDecimalSchema,
    chargeProfile: z.literal("approved-grant-ceiling-v1"),
    unknownOutcome: z.literal("retain-charge"),
  })
  .strict()
  .refine(
    (value) =>
      timestampToEpochNanoseconds(value.startsAt) <
      timestampToEpochNanoseconds(value.expiresAt)
  )
  .readonly();
export const VertexRuntimeModelPrivacyDecisionSchema = z
  .object({
    format: z.literal("vertex-model-privacy-decision-v1"),
    request: ModelUseRequestSchema,
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    issuedByActorId: IdentifierSchema,
    decidedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    decision: z.literal("allow-model-processing"),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      timestampToEpochNanoseconds(value.decidedAt) <
      timestampToEpochNanoseconds(value.expiresAt)
  )
  .readonly();

export const vertexRuntimeModelJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
export const vertexRuntimeModelRow = async (
  tx: Transaction,
  table: string,
  scope: PolicyScope,
  filter: SQL,
  order: SQL = sql``
): Promise<Record<string, unknown> | null> => {
  const result = await tx.execute(
    sql`select * from ${sql.identifier(table)} where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and (${filter}) ${order} limit 1`
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
};
export const vertexRuntimeModelBoundDatabase = (tx: Transaction): Database =>
  ({
    execute: tx.execute.bind(tx),
    transaction: async (operation: (value: Transaction) => Promise<unknown>) =>
      operation(tx),
  }) as Database;
const minimum = (...values: string[]): string =>
  values.reduce((left, right) =>
    timestampToEpochNanoseconds(left) <= timestampToEpochNanoseconds(right)
      ? left
      : right
  );
const requireFact = (condition: unknown): void => {
  if (!condition) throw new Error("Current model-use evidence unavailable");
};

export const createVertexRuntimeModelEvidence = (
  options: Readonly<{
    objectCapabilities: (scope: PolicyScope) => VertexObjectCapabilities;
    clock: Readonly<{ now: () => string }>;
    signal?: AbortSignal;
  }>
) => {
  const current = (at: string): string => {
    const now = options.clock.now();
    requireFact(
      !options.signal?.aborted &&
        timestampToEpochNanoseconds(now) >= timestampToEpochNanoseconds(at)
    );
    return now;
  };
  const objectBytes = async (
    scope: PolicyScope,
    key: string,
    digest: string,
    expectedLength?: number
  ): Promise<Uint8Array> => {
    requireFact(!options.signal?.aborted);
    const capability = options.objectCapabilities(scope);
    requireFact(typeof capability.getBounded === "function");
    const result = await present(capability.getBounded)(key, 1_048_576);
    requireFact(!options.signal?.aborted);
    if (result.status !== "ok")
      throw new Error("Current model-use evidence unavailable");
    const body = result.value.body;
    requireFact(
      body instanceof Uint8Array &&
        body.byteLength <= 1_048_576 &&
        result.value.metadata.key === key &&
        result.value.metadata.size === body.byteLength &&
        (expectedLength === undefined || body.byteLength === expectedLength)
    );
    const captured = new Uint8Array(body);
    requireFact((await hashArtifact(captured)) === digest);
    return captured;
  };
  const readGrant = async (
    tx: Transaction,
    principal: PolicyPrincipal,
    scope: PolicyScope,
    collectionId: string | null,
    resourceId: string,
    at: string
  ): Promise<Readonly<{ version: string; expiresAt: string }>> => {
    const auth = createVertexAuthorization(
      vertexRuntimeModelBoundDatabase(tx),
      { clock: options.clock }
    );
    requireFact(
      await auth.authorize({
        principal,
        scope,
        collectionId,
        resourceId,
        action: "read",
        now: at,
      })
    );
    const found = (
      await tx.execute(
        sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = ${collectionId ?? ""} and b.resource_id = ${resourceId} and a.action = 'read' and v.status = 'granted' order by v.expires_at_ns desc limit 129`
      )
    ).rows as Record<string, unknown>[];
    requireFact(found.length <= 128);
    for (const row of found) {
      const value = row["payload"] as VertexGrantVersion;
      requireFact((await hashArtifact(value)) === row["record_hash"]);
      const now = timestampToEpochNanoseconds(current(at));
      if (
        value.granteeActorId === principal.actorId &&
        value.scope.accountAlias === scope.accountAlias &&
        value.scope.environment === scope.environment &&
        value.collectionId === collectionId &&
        value.resourceId === resourceId &&
        value.status === "granted" &&
        value.actions.includes("read") &&
        value.version === row["current_version"] &&
        value.revision === row["revision"] &&
        timestampToEpochNanoseconds(value.recordedAt) <=
          timestampToEpochNanoseconds(at) &&
        timestampToEpochNanoseconds(value.validFrom) <=
          timestampToEpochNanoseconds(at) &&
        timestampToEpochNanoseconds(value.expiresAt) > now
      ) {
        return {
          version: `${value.version}:${value.revision}`,
          expiresAt: value.expiresAt,
        };
      }
    }
    throw new Error("Current model-use read grant unavailable");
  };
  const rights = async (
    tx: Transaction,
    principal: PolicyPrincipal,
    scope: PolicyScope,
    collectionId: string | null,
    policyId: string,
    version: string,
    at: string
  ) => {
    const grant = await readGrant(
      tx,
      principal,
      scope,
      collectionId,
      policyId,
      at
    );
    const row = await vertexRuntimeModelRow(
      tx,
      "vertex_rights_versions",
      scope,
      sql`collection_key = ${collectionId ?? ""} and policy_id = ${policyId}`,
      sql`order by revision desc`
    );
    requireFact(row);
    const value = WorkerCurrentRightsOutputSchema.parse(
      present(row)["payload"]
    );
    const now = timestampToEpochNanoseconds(current(at));
    requireFact(
      (await hashArtifact(value)) === present(row)["record_hash"] &&
        value.policyId === policyId &&
        value.version === version &&
        present(row)["version"] === version &&
        present(row)["status"] === value.status &&
        value.status === "granted" &&
        value.allowedUses.includes("read") &&
        value.expiresAt !== null &&
        timestampToEpochNanoseconds(value.checkedAt) <=
          timestampToEpochNanoseconds(at) &&
        timestampToEpochNanoseconds(present(value.expiresAt)) > now &&
        (value.retentionUntil === null ||
          timestampToEpochNanoseconds(value.retentionUntil) > now)
    );
    requireFact(
      present(row)["checked_at_ns"] ===
        timestampToEpochNanoseconds(value.checkedAt).toString() &&
        present(row)["expires_at_ns"] ===
          timestampToEpochNanoseconds(present(value.expiresAt)).toString() &&
        present(row)["retention_until_ns"] ===
          (value.retentionUntil === null
            ? null
            : timestampToEpochNanoseconds(value.retentionUntil).toString())
    );
    return {
      value,
      expiresAt: minimum(
        present(value.expiresAt),
        grant.expiresAt,
        value.retentionUntil ?? present(value.expiresAt)
      ),
    };
  };
  const accepted = async (
    tx: Transaction,
    principal: PolicyPrincipal,
    request: ModelUseRequest,
    reference: ModelUseRequest["evidence"][number],
    at: string
  ): Promise<CurrentModelUseContext["evidence"][number]> => {
    const scope: PolicyScope = {
      accountAlias: request.accountAlias,
      environment: request.environment,
    };
    const row = await vertexRuntimeModelRow(
      tx,
      "vertex_artifacts",
      scope,
      sql`artifact_id = ${reference.artifactId}`
    );
    requireFact(row);
    const metadata = present(row)["payload"] as VertexArtifactMetadata;
    requireFact(
      (await hashArtifact(metadata)) === present(row)["metadata_hash"] &&
        metadata.artifactId === reference.artifactId &&
        metadata.artifactSha256 === reference.artifactSha256 &&
        metadata.scope.accountAlias === scope.accountAlias &&
        metadata.scope.environment === scope.environment &&
        present(row)["collection_key"] === (metadata.collectionId ?? "") &&
        metadata.contractName === "ResearchEvidence" &&
        metadata.byteLength > 0 &&
        metadata.byteLength <= 1_048_576 &&
        metadata.rights.policyId === reference.rightsPolicyId &&
        metadata.rights.version === reference.rightsVersion
    );
    requireFact(
      present(row)["artifact_sha256"] === metadata.artifactSha256 &&
        present(row)["object_key"] === metadata.objectKey &&
        String(present(row)["byte_length"]) === String(metadata.byteLength) &&
        present(row)["rights_policy_id"] === reference.rightsPolicyId &&
        present(row)["rights_version"] === reference.rightsVersion
    );
    const grant = await readGrant(
      tx,
      principal,
      scope,
      metadata.collectionId,
      reference.artifactId,
      at
    );
    const currentRights = await rights(
      tx,
      principal,
      scope,
      metadata.collectionId,
      reference.rightsPolicyId,
      reference.rightsVersion,
      at
    );
    const pinned = WorkerCurrentRightsOutputSchema.parse(metadata.rights);
    requireFact(
      pinned.status === "granted" &&
        pinned.allowedUses.includes("read") &&
        pinned.expiresAt !== null &&
        timestampToEpochNanoseconds(pinned.checkedAt) <=
          timestampToEpochNanoseconds(at) &&
        timestampToEpochNanoseconds(present(pinned.expiresAt)) >
          timestampToEpochNanoseconds(current(at)) &&
        (pinned.retentionUntil === null ||
          timestampToEpochNanoseconds(pinned.retentionUntil) >
            timestampToEpochNanoseconds(current(at)))
    );
    const latest = await vertexRuntimeModelRow(
      tx,
      "vertex_reviews",
      scope,
      sql`collection_key = ${metadata.collectionId ?? ""} and artifact_id = ${reference.artifactId} and purpose = 'research'`,
      sql`order by reviewed_at_ns desc, review_id desc`
    );
    requireFact(latest);
    const review = AcceptedReviewSchema.parse(present(latest)["payload"]);
    requireFact(
      (await hashArtifact(review)) === present(latest)["record_hash"] &&
        review.accountAlias === scope.accountAlias &&
        review.environment === scope.environment &&
        review.collectionId === metadata.collectionId &&
        review.artifactId === reference.artifactId &&
        review.artifactSha256 === reference.artifactSha256 &&
        review.reviewId === reference.reviewId &&
        review.reviewVersion === reference.reviewVersion &&
        review.decision === "accepted" &&
        review.purpose === "research" &&
        timestampToEpochNanoseconds(review.reviewedAt) <=
          timestampToEpochNanoseconds(at) &&
        timestampToEpochNanoseconds(review.expiresAt) >
          timestampToEpochNanoseconds(current(at))
    );
    requireFact(
      present(latest)["review_id"] === review.reviewId &&
        present(latest)["reviewed_at_ns"] ===
          timestampToEpochNanoseconds(review.reviewedAt).toString() &&
        present(latest)["expires_at_ns"] ===
          timestampToEpochNanoseconds(review.expiresAt).toString() &&
        present(latest)["decision"] === review.decision &&
        present(latest)["review_version"] === review.reviewVersion &&
        present(latest)["artifact_sha256"] === review.artifactSha256 &&
        present(latest)["actor_id"] === review.actorId &&
        present(latest)["policy_version"] === review.policyVersion
    );
    const link = await vertexRuntimeModelRow(
      tx,
      "vertex_reviewed_artifact_links",
      scope,
      sql`review_id = ${review.reviewId} and artifact_id = ${reference.artifactId} and artifact_sha256 = ${reference.artifactSha256} and collection_key = ${metadata.collectionId ?? ""}`
    );
    requireFact(link);
    const reviewGrant = await readGrant(
      tx,
      principal,
      scope,
      metadata.collectionId,
      review.reviewId,
      at
    );
    requireFact(
      metadata.objectKey ===
        vertexQualifiedObjectKey(
          scope,
          metadata.collectionId,
          "manifest",
          reference.artifactSha256
        )
    );
    const bytes = await objectBytes(
      scope,
      metadata.objectKey,
      reference.artifactSha256,
      metadata.byteLength
    );
    const evidence = ResearchEvidenceSchema.parse(
      vertexRuntimeModelJson(bytes)
    );
    requireFact(
      (await hashArtifact(evidence)) === reference.artifactSha256 &&
        metadata.sourceContentSha256 === evidence.contentHash &&
        evidence.collectionId === metadata.collectionId &&
        evidence.rightsPolicyId === reference.rightsPolicyId
    );
    const published = await vertexRuntimeModelRow(
      tx,
      "vertex_records",
      scope,
      sql`collection_key = ${metadata.collectionId ?? ""} and artifact_id = ${reference.artifactId} and contract_name = 'ResearchEvidence'`
    );
    requireFact(
      published &&
        published["artifact_sha256"] === reference.artifactSha256 &&
        published["record_hash"] === reference.artifactSha256 &&
        (await hashArtifact(
          ResearchEvidenceSchema.parse(published["payload"])
        )) === reference.artifactSha256
    );
    // Hash the original source too. AcceptedReview remains an overlay and does
    // not replace immutable source bytes with an accepted rewritten manifest.
    await objectBytes(
      scope,
      vertexQualifiedObjectKey(
        scope,
        metadata.collectionId,
        "content",
        evidence.contentHash
      ),
      evidence.contentHash
    );
    await readGrant(
      tx,
      principal,
      scope,
      metadata.collectionId,
      reference.artifactId,
      current(at)
    );
    return {
      ...reference,
      reviewDecision: "accepted",
      originalArtifactSha256: await hashArtifact(bytes),
      readGrantVersion: grant.version,
      reviewedAt: review.reviewedAt,
      reviewExpiresAt: minimum(review.expiresAt, reviewGrant.expiresAt),
      rightsStatus: "granted",
      rightsExpiresAt: minimum(
        currentRights.expiresAt,
        present(pinned.expiresAt),
        pinned.retentionUntil ?? present(pinned.expiresAt),
        grant.expiresAt
      ),
    };
  };
  return Object.freeze({ accepted, readGrant, rights, objectBytes, current });
};
