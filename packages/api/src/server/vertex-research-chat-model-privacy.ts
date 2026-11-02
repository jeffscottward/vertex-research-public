import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  type VertexPrincipal,
  type VertexScope,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  decimalUnits,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  fail,
  insert,
  one,
  rows,
  time,
  type PersistenceContext,
  type Row,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import {
  DigestSchema,
  IdentifierSchema,
  TimestampSchema,
  VersionSchema,
} from "../contracts/vertex.ts";
import { PolicyRevisionSchema } from "../contracts/vertex-policy.ts";
import {
  ModelUseGrantSchema,
  ModelUseOperationSchema,
  ModelUseRequestSchema,
  parseModelUseRequest,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { VertexRuntimeModelPrivacyDecisionSchema } from "./vertex-runtime-model-evidence.ts";
import {
  ChatWorkerOriginalClosedError,
  type VertexResearchChatWorkerRuntime,
} from "./vertex-research-chat-worker-runtime.ts";
import {
  ChatModelPrivacyReviewInputSchema,
  ModelPrivacyCandidateStatusSchema,
  ReadModelPrivacyReviewRequestInputSchema,
  RecordModelPrivacyReviewInputSchema,
  ReadModelPrivacyReviewRequestOutputSchema,
  RecordModelPrivacyReviewOutputSchema,
} from "../contracts/vertex-model-privacy-rendezvous.ts";
import {
  NativeModelPrivacyPhaseSchema,
  SelectedChatModelPrivacyReviewInputSchema,
  SelectedModelPrivacyCandidateSchema,
  ReadNativeModelPrivacyReviewRequestInputSchema,
  ReadNativeModelPrivacyReviewRequestOutputSchema,
  RecordNativeModelPrivacyReviewInputSchema,
} from "../contracts/vertex-model-privacy-rendezvous.ts";
import { present } from "./present.ts";

// Private original issuer, not staged evidence, owner consent, a permission
// callback, a provider dispatcher, or a public review contract.
export const researchChatModelPrivacyResource = (
  responseRequestId: string,
  operation: ModelUseRequest["operation"]
): string =>
  IdentifierSchema.parse(
    `research-chat-model-privacy:${IdentifierSchema.parse(responseRequestId)}:${ModelUseOperationSchema.parse(operation)}`
  );
const scopeOf = (request: ModelUseRequest): VertexScope => ({
  accountAlias: request.accountAlias,
  environment: "research",
});
const boundDatabase = (tx: Transaction): Database =>
  ({
    execute: tx.execute.bind(tx),
    transaction: async (
      operation: (current: Transaction) => Promise<unknown>
    ) => operation(tx),
  }) as Database;
const principalSchema = z.object({ actorId: IdentifierSchema }).strict();
const grantActions = z
  .array(
    z.enum([
      "read",
      "publish",
      "review",
      "admit-paper-simulation",
      "project",
      "manage-rights",
      "dispatch-outbox",
      "cleanup-chat-copies",
    ])
  )
  .min(1)
  .max(8)
  .refine((value) => new Set(value).size === value.length);
const grantBinding = {
  grantId: IdentifierSchema,
  granteeActorId: IdentifierSchema,
  scope: z
    .object({
      accountAlias: IdentifierSchema,
      environment: z.enum(["research", "paper", "live"]),
    })
    .strict(),
  collectionId: IdentifierSchema.nullable(),
  resourceId: IdentifierSchema,
  actions: grantActions,
};
const grantBindingSchema = z.object(grantBinding).strict();
const grantVersionSchema = z
  .object({
    ...grantBinding,
    version: VersionSchema,
    revision: PolicyRevisionSchema,
    status: z.enum(["granted", "revoked"]),
    validFrom: TimestampSchema,
    expiresAt: TimestampSchema,
    recordedAt: TimestampSchema,
    recordedByActorId: IdentifierSchema,
  })
  .strict();
const ChatModelPrivacyReviewerGrantSchema = z
  .object({
    grantId: IdentifierSchema,
    version: VersionSchema,
    revision: PolicyRevisionSchema,
    recordSha256: DigestSchema,
    resourceId: IdentifierSchema,
    action: z.enum(["read", "review"]),
    expiresAt: TimestampSchema,
  })
  .strict()
  .readonly();
export const ChatModelPrivacyReviewSchema = z
  .object({
    profile: z.literal("vertex-research-chat-model-privacy-review-v1"),
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    reviewId: IdentifierSchema,
    request: ModelUseRequestSchema,
    decision: z.enum(["accepted", "rejected"]),
    privacyDecision: VertexRuntimeModelPrivacyDecisionSchema.nullable(),
    reviewerActorId: IdentifierSchema,
    reviewerGrants: z.array(ChatModelPrivacyReviewerGrantSchema).length(3),
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    reviewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    supersedesReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
    commandSha256: DigestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.request.environment === "research" &&
      value.request.accountAlias === value.accountAlias &&
      time(value.reviewedAt) < time(value.expiresAt) &&
      time(value.expiresAt) <= time(value.request.deadlineAt) &&
      value.reviewerGrants.every(
        (grant) => time(value.expiresAt) <= time(grant.expiresAt)
      ) &&
      (value.decision === "accepted"
        ? value.privacyDecision !== null
        : value.privacyDecision === null)
  )
  .readonly()
  .transform(deepFreezeArtifact);
const NativeChatModelPrivacyReviewSchema = z
  .object({
    profile: z.literal("vertex-research-chat-native-model-privacy-review-v1"),
    nativePhase: NativeModelPrivacyPhaseSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    reviewId: IdentifierSchema,
    request: ModelUseRequestSchema,
    decision: z.enum(["accepted", "rejected"]),
    privacyDecision: VertexRuntimeModelPrivacyDecisionSchema.nullable(),
    reviewerActorId: IdentifierSchema,
    reviewerGrants: z.array(ChatModelPrivacyReviewerGrantSchema).length(3),
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    reviewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    supersedesReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
    commandSha256: DigestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.request.environment === "research" &&
      value.request.accountAlias === value.accountAlias &&
      time(value.reviewedAt) < time(value.expiresAt) &&
      time(value.expiresAt) <= time(value.request.deadlineAt) &&
      value.reviewerGrants.every(
        (grant) => time(value.expiresAt) <= time(grant.expiresAt)
      ) &&
      (value.decision === "accepted"
        ? value.privacyDecision !== null
        : value.privacyDecision === null)
  )
  .readonly()
  .transform(deepFreezeArtifact);
export const SelectedChatModelPrivacyReviewSchema = z.union([
  ChatModelPrivacyReviewSchema,
  NativeChatModelPrivacyReviewSchema,
]);
export type ChatModelPrivacyReviewInput = z.infer<
  typeof ChatModelPrivacyReviewInputSchema
>;
export type ChatModelPrivacyReview = z.infer<
  typeof SelectedChatModelPrivacyReviewSchema
>;
export type VertexRuntimeModelPrivacyDecision = z.infer<
  typeof VertexRuntimeModelPrivacyDecisionSchema
>;
type ReviewerGrant = z.infer<typeof ChatModelPrivacyReviewerGrantSchema>;
type Original = Awaited<
  ReturnType<VertexResearchChatWorkerRuntime["readModelOriginalForTransaction"]>
>;
const DispatchSchema = z
  .object({
    profile: z.literal("vertex-research-chat-model-dispatch-v1"),
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    originalRequestSha256: DigestSchema,
    request: ModelUseRequestSchema,
    reviewId: IdentifierSchema,
    reservedAt: TimestampSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
const NativeDispatchSchema = z
  .object({
    profile: z.literal("vertex-research-chat-native-model-dispatch-v1"),
    nativePhase: NativeModelPrivacyPhaseSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planId: IdentifierSchema,
    planSha256: DigestSchema,
    originalRequestSha256: DigestSchema,
    request: ModelUseRequestSchema,
    reviewId: IdentifierSchema,
    reservedAt: TimestampSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
const SelectedDispatchSchema = z.union([DispatchSchema, NativeDispatchSchema]);
const phaseOf = (
  value: object
): z.infer<typeof NativeModelPrivacyPhaseSchema> | undefined =>
  "nativePhase" in value
    ? NativeModelPrivacyPhaseSchema.parse(value.nativePhase)
    : undefined;
const phaseFields = (value: object) => {
  const phase = phaseOf(value);
  return phase === undefined ? {} : { nativePhase: phase };
};
const phaseColumns = (value: object) => {
  const phase = phaseOf(value);
  return phase === undefined
    ? {}
    : { phase_ordinal: phase.phaseOrdinal, phase_sha256: phase.phaseSha256 };
};
const phaseWhere = (value: object) => {
  const phase = phaseOf(value);
  return phase === undefined
    ? sql`true`
    : sql`phase_ordinal = ${phase.phaseOrdinal} and phase_sha256 = ${phase.phaseSha256}`;
};
const privacyTable = (
  kind: "reviews" | "dispatches" | "candidates",
  value: object
): string => {
  const native = phaseOf(value) !== undefined;
  return kind === "dispatches"
    ? native
      ? "vertex_research_chat_native_model_dispatches"
      : "vertex_research_chat_model_dispatches"
    : `vertex_research_chat_${native ? "native_" : ""}model_privacy_${kind}`;
};
const MAX_REVIEWS = 128n;
const MAX_METADATA_BYTES = 262_144;
const canonical = (value: unknown): string => {
  const text = canonicalArtifactJson(value);
  if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
    return fail("invalid");
  return text;
};
const equal = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right);
const commandFor = (
  value: ChatModelPrivacyReview
): z.infer<typeof SelectedChatModelPrivacyReviewInputSchema> =>
  ({
    responseRequestId: value.responseRequestId,
    planId: value.planId,
    planSha256: value.planSha256,
    request: value.request,
    decision: value.decision,
    expiresAt: value.expiresAt,
    expectedReviewId: value.supersedesReviewId,
    idempotencyKey: value.idempotencyKey,
    ...phaseFields(value),
  }) as z.infer<typeof SelectedChatModelPrivacyReviewInputSchema>;
const wantedGrants = (
  policyId: string,
  responseRequestId: string,
  request: ModelUseRequest,
  source: object
): readonly Readonly<{ resourceId: string; action: "read" | "review" }>[] => [
  { resourceId: "account-scope", action: "read" },
  { resourceId: policyId, action: "review" },
  {
    resourceId:
      phaseOf(source) === undefined
        ? researchChatModelPrivacyResource(responseRequestId, request.operation)
        : IdentifierSchema.parse(
            `research-chat-model-privacy:${responseRequestId}:phase-${present(phaseOf(source)).phaseOrdinal}:${request.operation}`
          ),
    action: "review",
  },
];

export const createResearchChatModelPrivacyOperations = (
  ctx: PersistenceContext,
  owner: VertexResearchChatWorkerRuntime,
  options: Readonly<{ reviewerActorId: string }>
) => {
  const reviewerActorId = IdentifierSchema.parse(options.reviewerActorId);
  let watermark: bigint | null = null;
  // Keep every internal sample. A hidden authorization-clock sample cannot be
  // rolled back before the final check to revive an expired authority.
  const current = (floor?: string): string => {
    const at = TimestampSchema.parse(ctx.now()),
      ns = time(at);
    if (
      (watermark !== null && ns < watermark) ||
      (floor !== undefined && ns < time(floor))
    )
      return fail("stale");
    watermark = ns;
    return at;
  };
  const finalCurrent = (at: string, bounds: readonly string[]): void => {
    const ns = time(current(at));
    if (bounds.some((bound) => time(bound) <= ns)) fail("stale");
  };
  const lock = async (tx: Transaction, scope: VertexScope): Promise<void> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
    );
  };
  const parseRequest = async (raw: unknown): Promise<ModelUseRequest> => {
    canonical(raw);
    const request = await parseModelUseRequest(raw);
    if (request.environment !== "research" || !equal(raw, request))
      return fail("invalid");
    return request;
  };
  const original = async (
    tx: Transaction,
    request: ModelUseRequest,
    at: string
  ): Promise<Original> => {
    const value = await owner.readModelOriginalForTransaction(
      tx,
      request,
      current(at)
    );
    canonical(value);
    for (const id of [
      value.responseRequestId,
      value.planId,
      value.ownerActorId,
      value.consumerServicePrincipalId,
    ])
      IdentifierSchema.parse(id);
    DigestSchema.parse(value.planSha256);
    DigestSchema.parse(value.originalRequestSha256);
    TimestampSchema.parse(value.expiresAt);
    const grant = ModelUseGrantSchema.parse(value.modelGrant);
    if (
      !equal(grant, value.modelGrant) ||
      grant.revision !== value.modelGrantRevision ||
      grant.status !== "granted" ||
      grant.grantId !== request.grantId ||
      grant.grantVersion !== request.grantVersion ||
      !grant.operations.includes(request.operation) ||
      !grant.purposes.includes(request.purpose)
    )
      return fail("denied");
    for (const field of [
      "accountAlias",
      "environment",
      "researchPrincipalId",
      "consumerServiceId",
      "selectionId",
      "selectionSha256",
      "providerId",
      "modelVersion",
      "tokenizerArtifactId",
      "tokenizerSha256",
      "endpointReferenceId",
      "endpointSha256",
      "modelUsePolicyVersion",
    ] as const)
      if (grant[field] !== request[field]) return fail("denied");
    if (
      request.inputBytes > grant.maximumInputBytes ||
      (request.inputTokens !== null &&
        request.inputTokens > grant.maximumInputTokens) ||
      request.maximumOutputTokens > grant.maximumOutputTokens ||
      decimalUnits(request.maximumCostUsd) >
        decimalUnits(grant.maximumCostUsd) ||
      request.tools.some((tool) => !grant.allowedTools.includes(tool)) ||
      request.evidence.some(
        (entry) => !grant.evidence.some((allowed) => equal(entry, allowed))
      )
    )
      return fail("denied");
    if (
      reviewerActorId === value.ownerActorId ||
      reviewerActorId === value.consumerServicePrincipalId ||
      time(grant.issuedAt) > time(at) ||
      time(grant.validFrom) > time(at)
    )
      return fail("denied");
    finalCurrent(at, [value.expiresAt, grant.expiresAt, request.deadlineAt]);
    return deepFreezeArtifact(structuredClone(value));
  };
  const grants = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original,
    at: string,
    pinned?: readonly ReviewerGrant[]
  ): Promise<readonly ReviewerGrant[]> => {
    const scope = scopeOf(request),
      principal = { actorId: reviewerActorId };
    const auth = createVertexAuthorization(boundDatabase(tx), {
      clock: { now: () => current(at) },
    });
    const wanted = wantedGrants(
      source.modelGrant.privacyPolicyId,
      source.responseRequestId,
      request,
      source
    );
    if (
      pinned !== undefined &&
      (pinned.length !== wanted.length ||
        pinned.some(
          (pin, index) =>
            pin.resourceId !== present(wanted[index]).resourceId ||
            pin.action !== present(wanted[index]).action
        ))
    )
      return fail("integrity");
    const result: ReviewerGrant[] = [];
    for (let index = 0; index < wanted.length; index += 1) {
      const target = present(wanted[index]),
        pin = pinned?.[index],
        checkedAt = current(at);
      if (
        !(await auth.authorize({
          principal,
          scope,
          collectionId: null,
          resourceId: target.resourceId,
          action: target.action,
          now: checkedAt,
        }))
      )
        return fail("denied");
      const found = await rows(
        tx,
        sql`select b.account_alias, b.environment, b.grant_id, b.grantee_actor_id, b.collection_key, b.resource_id, b.binding_hash, b.payload as binding_payload, v.payload as version_payload, v.record_hash, v.status as version_status, v.valid_from_ns, v.expires_at_ns, v.recorded_at_ns, v.version as version_name, v.revision as version_revision, p.current_version, p.revision as current_revision from vertex_grant_bindings b join vertex_grant_current p on p.account_alias = b.account_alias and p.environment = b.environment and p.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = p.account_alias and v.environment = p.environment and v.grant_id = p.grant_id and v.version = p.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${reviewerActorId} and b.collection_key = '' and b.resource_id = ${target.resourceId} and a.action = ${target.action} and v.status = 'granted' order by b.grant_id limit 129`
      );
      if (found.length > 128) return fail("denied");
      let retained: ReviewerGrant | null = null;
      for (const row of found) {
        const bound = grantBindingSchema.parse(row["binding_payload"]),
          value = grantVersionSchema.parse(row["version_payload"]);
        if (
          !(
            equal(bound, row["binding_payload"]) &&
            equal(value, row["version_payload"])
          ) ||
          (await hashArtifact(bound)) !== row["binding_hash"] ||
          (await hashArtifact(value)) !== row["record_hash"]
        )
          return fail("integrity");
        const {
          version: _version,
          revision: _revision,
          status: _status,
          validFrom: _from,
          expiresAt: _end,
          recordedAt: _at,
          recordedByActorId: _by,
          ...binding
        } = value;
        if (
          !equal(binding, bound) ||
          bound.grantId !== row["grant_id"] ||
          bound.scope.accountAlias !== row["account_alias"] ||
          bound.scope.environment !== row["environment"] ||
          bound.granteeActorId !== row["grantee_actor_id"] ||
          bound.resourceId !== row["resource_id"] ||
          row["collection_key"] !== "" ||
          bound.collectionId !== null ||
          value.version !== row["version_name"] ||
          value.version !== row["current_version"] ||
          value.revision !== row["version_revision"] ||
          value.revision !== row["current_revision"] ||
          value.status !== row["version_status"] ||
          time(value.validFrom).toString() !== row["valid_from_ns"] ||
          time(value.expiresAt).toString() !== row["expires_at_ns"] ||
          time(value.recordedAt).toString() !== row["recorded_at_ns"]
        )
          return fail("integrity");
        if (
          bound.scope.accountAlias !== scope.accountAlias ||
          bound.scope.environment !== "research" ||
          bound.granteeActorId !== reviewerActorId ||
          bound.resourceId !== target.resourceId ||
          !bound.actions.includes(target.action) ||
          value.status !== "granted" ||
          BigInt(value.revision) < 1n ||
          time(value.validFrom) > time(checkedAt) ||
          time(value.recordedAt) > time(checkedAt) ||
          time(value.expiresAt) <= time(current(at))
        )
          continue;
        const candidate = ChatModelPrivacyReviewerGrantSchema.parse({
          grantId: value.grantId,
          version: value.version,
          revision: value.revision,
          recordSha256: row["record_hash"],
          resourceId: value.resourceId,
          action: target.action,
          expiresAt: value.expiresAt,
        });
        if (pin !== undefined && !equal(pin, candidate)) continue;
        retained = candidate;
        break;
      }
      if (retained === null) return fail("denied");
      result.push(retained);
    }
    finalCurrent(
      at,
      result.map((pin) => pin.expiresAt)
    );
    return result;
  };
  const readReview = async (
    row: Row,
    request: ModelUseRequest,
    source: Original
  ): Promise<ChatModelPrivacyReview> => {
    canonical(row["payload"]);
    const value = SelectedChatModelPrivacyReviewSchema.parse(row["payload"]);
    if (!equal(phaseFields(value), phaseFields(source)))
      return fail("integrity");
    for (const [key, expected] of Object.entries(phaseColumns(value)))
      if (row[key] !== expected) return fail("integrity");
    await parseRequest(value.request);
    if (
      !equal(value, row["payload"]) ||
      (await hashArtifact(value)) !== row["record_hash"]
    )
      return fail("integrity");
    const commandSha256 = await hashArtifact({
      principal: { actorId: value.reviewerActorId },
      input: commandFor(value),
    });
    if (
      value.commandSha256 !== commandSha256 ||
      value.reviewId !== `chat-privacy-${commandSha256}` ||
      value.accountAlias !== request.accountAlias ||
      value.environment !== request.environment ||
      value.responseRequestId !== source.responseRequestId ||
      value.planId !== source.planId ||
      value.planSha256 !== source.planSha256 ||
      value.request.operation !== request.operation ||
      value.reviewerActorId !== reviewerActorId
    )
      return fail("integrity");
    for (const [column, expected] of Object.entries({
      account_alias: value.accountAlias,
      environment: value.environment,
      response_request_id: value.responseRequestId,
      plan_id: value.planId,
      plan_sha256: value.planSha256,
      review_id: value.reviewId,
      actor_id: value.reviewerActorId,
      operation: value.request.operation,
      request_id: value.request.requestId,
      request_sha256: value.request.requestSha256,
      decision: value.decision,
      policy_id: value.policyId,
      policy_version: value.policyVersion,
      idempotency_key: value.idempotencyKey,
      command_sha256: value.commandSha256,
      reviewed_at_ns: time(value.reviewedAt).toString(),
      expires_at_ns: time(value.expiresAt).toString(),
      supersedes_review_id: value.supersedesReviewId,
    }))
      if (row[column] !== expected) return fail("integrity");
    if (
      typeof row["revision"] !== "string" ||
      !/^[1-9][0-9]*$/.test(row["revision"]) ||
      BigInt(row["revision"]) > MAX_REVIEWS
    )
      return fail("integrity");
    if (
      value.privacyDecision !== null &&
      !equal(value.privacyDecision, {
        format: "vertex-model-privacy-decision-v1",
        request: value.request,
        policyId: value.policyId,
        policyVersion: value.policyVersion,
        issuedByActorId: value.reviewerActorId,
        decidedAt: value.reviewedAt,
        expiresAt: value.expiresAt,
        decision: "allow-model-processing",
        executionAuthorized: false,
      })
    )
      return fail("integrity");
    if (
      row["decision_canonical"] !==
        (value.privacyDecision === null
          ? null
          : canonical(value.privacyDecision)) ||
      row["decision_sha256"] !==
        (value.privacyDecision === null
          ? null
          : await hashArtifact(value.privacyDecision))
    )
      return fail("integrity");
    const expected = wantedGrants(
      value.policyId,
      value.responseRequestId,
      value.request,
      source
    );
    if (
      value.reviewerGrants.some(
        (pin, index) =>
          pin.action !== present(expected[index]).action ||
          pin.resourceId !== present(expected[index]).resourceId
      )
    )
      return fail("integrity");
    if (
      row["model_grant_id"] !== value.request.grantId ||
      row["model_grant_version"] !== value.request.grantVersion
    )
      return fail("integrity");
    for (const [index, prefix] of [
      "account_read",
      "policy_review",
      "request_review",
    ].entries()) {
      const pin = present(value.reviewerGrants[index]);
      if (
        row[`${prefix}_grant_id`] !== pin.grantId ||
        row[`${prefix}_grant_version`] !== pin.version
      )
        return fail("integrity");
    }
    return value;
  };
  const latest = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original
  ): Promise<Row | null> => {
    const history = await rows(
      tx,
      sql`select * from ${sql.identifier(privacyTable("reviews", source))} where account_alias = ${request.accountAlias} and environment = ${request.environment} and response_request_id = ${source.responseRequestId} and operation = ${request.operation} and ${phaseWhere(source)} order by revision asc limit 129`
    );
    if (history.length > Number(MAX_REVIEWS)) return fail("integrity");
    let previous: ChatModelPrivacyReview | null = null;
    for (let index = 0; index < history.length; index += 1) {
      const row = present(history[index]),
        value = await readReview(row, request, source);
      // The immutable authenticated predecessor chain, not an unhashed ordinal
      // alone, defines the current head. Gaps/reordering/truncation fail closed.
      if (
        row["revision"] !== String(index + 1) ||
        value.supersedesReviewId !== (previous?.reviewId ?? null) ||
        (previous !== null &&
          time(value.reviewedAt) < time(previous.reviewedAt))
      )
        return fail("integrity");
      previous = value;
    }
    return history.at(-1) ?? null;
  };
  const dispatch = readResearchChatModelDispatchProvenanceForTransaction;
  const finish = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original,
    review: ChatModelPrivacyReview,
    at: string
  ): Promise<void> => {
    const finalSource = await original(tx, request, current(at));
    if (
      !equal(source, finalSource) ||
      review.policyId !== finalSource.modelGrant.privacyPolicyId ||
      review.policyVersion !== finalSource.modelGrant.privacyPolicyVersion ||
      time(review.reviewedAt) > time(at) ||
      time(review.expiresAt) > time(finalSource.expiresAt) ||
      time(review.expiresAt) > time(finalSource.modelGrant.expiresAt)
    )
      return fail("stale");
    // Rejoin the ORIGINAL grants only, after the final original-owner read.
    // A newly issued/replacement grant never extends this immutable decision.
    const finalGrants = await grants(
      tx,
      request,
      finalSource,
      current(at),
      review.reviewerGrants
    );
    finalCurrent(at, [
      source.expiresAt,
      request.deadlineAt,
      source.modelGrant.expiresAt,
      review.expiresAt,
      ...finalGrants.map((pin) => pin.expiresAt),
    ]);
  };
  const currentReview = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original,
    at: string
  ): Promise<ChatModelPrivacyReview> => {
    const row = await latest(tx, request, source);
    if (row === null) return fail("denied");
    const review = await readReview(row, request, source);
    if (
      review.decision !== "accepted" ||
      review.privacyDecision === null ||
      !equal(review.request, request)
    )
      return fail("denied");
    await dispatch(tx, request, source);
    await finish(tx, request, source, review, at);
    return review;
  };
  const recordSelectedResearchChatModelPrivacyReview = async (
    rawPrincipal: VertexPrincipal,
    rawInput: z.infer<typeof SelectedChatModelPrivacyReviewInputSchema>
  ): Promise<ChatModelPrivacyReview> => {
    canonical(rawPrincipal);
    canonical(rawInput);
    const principal = principalSchema.parse(rawPrincipal),
      input = SelectedChatModelPrivacyReviewInputSchema.parse(rawInput);
    if (!equal(rawInput, input) || principal.actorId !== reviewerActorId)
      return fail("denied");
    const request = await parseRequest(input.request),
      scope = scopeOf(request);
    const commandSha256 = await hashArtifact({ principal, input });
    const recordForTransaction = async (
      tx: Transaction,
      lockedAt: string
    ): Promise<ChatModelPrivacyReview> => {
      const at = current(lockedAt),
        source = await original(tx, request, at);
      if (!equal(phaseFields(input), phaseFields(source)))
        return fail("denied");
      if (
        input.responseRequestId !== source.responseRequestId ||
        input.planId !== source.planId ||
        input.planSha256 !== source.planSha256
      )
        return fail("denied");
      await dispatch(tx, request, source);
      const prior = await one(
        tx,
        privacyTable("reviews", source),
        scope,
        sql`actor_id = ${reviewerActorId} and idempotency_key = ${input.idempotencyKey}`
      );
      if (prior !== null) {
        // Immutable command ACK only. Replay does not move the head; consumers
        // MUST use readForTransaction, which never accepts this historical ACK.
        const value = await readReview(prior, request, source);
        if (
          value.commandSha256 !== commandSha256 ||
          !equal(commandFor(value), input)
        )
          return fail("conflict");
        await finish(tx, request, source, value, at);
        return value;
      }
      const head = await latest(tx, request, source);
      const previous =
        head === null ? null : await readReview(head, request, source);
      if ((previous?.reviewId ?? null) !== input.expectedReviewId)
        return fail("conflict");
      const revision =
        head === null ? 1n : BigInt(String(head["revision"])) + 1n;
      if (revision > MAX_REVIEWS) return fail("conflict");
      const reviewerGrants = await grants(tx, request, source, at);
      const reviewedAt = current(at);
      if (
        time(input.expiresAt) > time(source.expiresAt) ||
        time(input.expiresAt) > time(source.modelGrant.expiresAt) ||
        reviewerGrants.some(
          (pin) => time(input.expiresAt) > time(pin.expiresAt)
        )
      )
        return fail("stale");
      finalCurrent(reviewedAt, [input.expiresAt, request.deadlineAt]);
      const privacyDecision =
        input.decision === "rejected"
          ? null
          : VertexRuntimeModelPrivacyDecisionSchema.parse({
              format: "vertex-model-privacy-decision-v1",
              request,
              policyId: source.modelGrant.privacyPolicyId,
              policyVersion: source.modelGrant.privacyPolicyVersion,
              issuedByActorId: reviewerActorId,
              decidedAt: reviewedAt,
              expiresAt: input.expiresAt,
              decision: "allow-model-processing",
              executionAuthorized: false,
            });
      const value = SelectedChatModelPrivacyReviewSchema.parse({
        profile:
          source.nativePhase === undefined
            ? "vertex-research-chat-model-privacy-review-v1"
            : "vertex-research-chat-native-model-privacy-review-v1",
        ...phaseFields(source),
        ...scope,
        responseRequestId: input.responseRequestId,
        planId: input.planId,
        planSha256: input.planSha256,
        reviewId: `chat-privacy-${commandSha256}`,
        request,
        decision: input.decision,
        privacyDecision,
        reviewerActorId,
        reviewerGrants,
        policyId: source.modelGrant.privacyPolicyId,
        policyVersion: source.modelGrant.privacyPolicyVersion,
        reviewedAt,
        expiresAt: input.expiresAt,
        supersedesReviewId: input.expectedReviewId,
        idempotencyKey: input.idempotencyKey,
        commandSha256,
      });
      canonical(value);
      await insert(tx, privacyTable("reviews", source), scope, {
        ...phaseColumns(source),
        response_request_id: source.responseRequestId,
        plan_id: source.planId,
        plan_sha256: source.planSha256,
        review_id: value.reviewId,
        actor_id: reviewerActorId,
        operation: request.operation,
        request_id: request.requestId,
        request_sha256: request.requestSha256,
        model_grant_id: request.grantId,
        model_grant_version: request.grantVersion,
        account_read_grant_id: present(reviewerGrants[0]).grantId,
        account_read_grant_version: present(reviewerGrants[0]).version,
        policy_review_grant_id: present(reviewerGrants[1]).grantId,
        policy_review_grant_version: present(reviewerGrants[1]).version,
        request_review_grant_id: present(reviewerGrants[2]).grantId,
        request_review_grant_version: present(reviewerGrants[2]).version,
        decision: value.decision,
        policy_id: value.policyId,
        policy_version: value.policyVersion,
        revision: revision.toString(),
        idempotency_key: value.idempotencyKey,
        command_sha256: commandSha256,
        supersedes_review_id: value.supersedesReviewId,
        reviewed_at_ns: time(reviewedAt).toString(),
        expires_at_ns: time(value.expiresAt).toString(),
        decision_canonical:
          privacyDecision === null ? null : canonical(privacyDecision),
        decision_sha256:
          privacyDecision === null ? null : await hashArtifact(privacyDecision),
        payload: value,
        record_hash: await hashArtifact(value),
      });
      const stored = await latest(tx, request, source);
      if (
        stored === null ||
        !equal(await readReview(stored, request, source), value)
      )
        return fail("conflict");
      await dispatch(tx, request, source);
      await finish(tx, request, source, value, reviewedAt);
      return value;
    };
    const recorded = await ctx.run(
      principal,
      scope,
      null,
      "account-scope",
      "read",
      (tx, at) =>
        recordForTransaction(tx, at).catch((error) => {
          if (error instanceof ChatWorkerOriginalClosedError) return null;
          throw error;
        }),
      true
    );
    if (recorded === null) return fail("denied");
    return recorded;
  };
  const readForTransaction = async (
    tx: Transaction,
    rawRequest: ModelUseRequest,
    at: string
  ): Promise<
    Readonly<{ decision: VertexRuntimeModelPrivacyDecision; expiresAt: string }>
  > => {
    current(at);
    const request = await parseRequest(rawRequest);
    await lock(tx, scopeOf(request));
    const source = await original(tx, request, at),
      review = await currentReview(tx, request, source, at);
    finalCurrent(at, [
      review.expiresAt,
      source.expiresAt,
      source.modelGrant.expiresAt,
      request.deadlineAt,
      ...review.reviewerGrants.map((pin) => pin.expiresAt),
    ]);
    return {
      decision: present(review.privacyDecision),
      expiresAt: review.expiresAt,
    };
  };
  const reserveDispatchForTransaction = async (
    tx: Transaction,
    rawRequest: ModelUseRequest,
    at: string
  ): Promise<Readonly<{ fresh: boolean }>> => {
    // Internal caller MUST obtain actual existing model-use budget proof first
    // in THIS transaction. This association is a no-retry fence, NOT that proof.
    current(at);
    const request = await parseRequest(rawRequest);
    await lock(tx, scopeOf(request));
    const source = await original(tx, request, at),
      review = await currentReview(tx, request, source, at);
    const prior = await dispatch(tx, request, source);
    if (prior !== null) {
      await finish(tx, request, source, review, at);
      return { fresh: false };
    }
    const reservedAt = current(at);
    const value = SelectedDispatchSchema.parse({
      profile:
        source.nativePhase === undefined
          ? "vertex-research-chat-model-dispatch-v1"
          : "vertex-research-chat-native-model-dispatch-v1",
      ...phaseFields(source),
      ...scopeOf(request),
      responseRequestId: source.responseRequestId,
      planId: source.planId,
      planSha256: source.planSha256,
      originalRequestSha256: source.originalRequestSha256,
      request,
      reviewId: review.reviewId,
      reservedAt,
    });
    await insert(tx, privacyTable("dispatches", source), scopeOf(request), {
      ...phaseColumns(source),
      response_request_id: source.responseRequestId,
      plan_id: source.planId,
      plan_sha256: source.planSha256,
      original_request_sha256: source.originalRequestSha256,
      operation: request.operation,
      request_id: request.requestId,
      request_sha256: request.requestSha256,
      review_id: review.reviewId,
      reserved_at_ns: time(reservedAt).toString(),
      payload: value,
      record_hash: await hashArtifact(value),
    });
    if ((await dispatch(tx, request, source)) === null)
      return fail("integrity");
    const head = await latest(tx, request, source);
    if (
      head === null ||
      !equal(await readReview(head, request, source), review)
    )
      return fail("conflict");
    await finish(tx, request, source, review, at);
    return { fresh: true };
  };
  const candidateIdentity = async (
    request: ModelUseRequest,
    source: Original
  ): Promise<string> => {
    return `chat-candidate-${await hashArtifact({ responseRequestId: source.responseRequestId, planId: source.planId, planSha256: source.planSha256, request, ...phaseFields(source) })}`;
  };
  const parseCandidate = async (row: Row) => {
    canonical(row["payload"]);
    const value = SelectedModelPrivacyCandidateSchema.parse(row["payload"]);
    for (const [key, expected] of Object.entries(phaseColumns(value)))
      if (row[key] !== expected) return fail("integrity");
    await parseRequest(value.request);
    if (
      !equal(value, row["payload"]) ||
      (await hashArtifact(value)) !== row["record_hash"]
    )
      return fail("integrity");
    for (const [key, expected] of Object.entries({
      account_alias: value.accountAlias,
      environment: value.environment,
      response_request_id: value.responseRequestId,
      operation: value.request.operation,
      candidate_id: value.candidateId,
      plan_id: value.planId,
      plan_sha256: value.planSha256,
      request_id: value.request.requestId,
      request_sha256: value.request.requestSha256,
      submitted_at_ns: time(value.submittedAt).toString(),
      expires_at_ns: time(value.expiresAt).toString(),
    }))
      if (row[key] !== expected) return fail("integrity");
    return value;
  };
  const candidateFor = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original,
    at: string
  ) => {
    const row = await one(
      tx,
      privacyTable("candidates", source),
      scopeOf(request),
      sql`response_request_id = ${source.responseRequestId} and operation = ${request.operation} and ${phaseWhere(source)}`
    );
    if (!row) return null;
    const value = await parseCandidate(row);
    if (!equal(phaseFields(value), phaseFields(source)))
      return fail("integrity");
    if (
      value.candidateId !== (await candidateIdentity(request, source)) ||
      value.responseRequestId !== source.responseRequestId ||
      value.planId !== source.planId ||
      value.planSha256 !== source.planSha256 ||
      !equal(value.request, request)
    )
      return fail("conflict");
    if (time(value.submittedAt) > time(at)) return fail("stale");
    finalCurrent(at, [value.expiresAt, source.expiresAt]);
    return value;
  };
  const candidateStatus = async (
    tx: Transaction,
    request: ModelUseRequest,
    source: Original,
    at: string
  ) => {
    const value = await candidateFor(tx, request, source, at),
      candidateId = await candidateIdentity(request, source);
    await grants(tx, request, source, at);
    if (!value)
      return ModelPrivacyCandidateStatusSchema.parse({
        candidateId,
        requestId: request.requestId,
        requestSha256: request.requestSha256,
        status: "not-observed",
        expiresAt: null,
      });
    const row = await latest(tx, request, source);
    let status: "pending" | "accepted" | "rejected" = "pending";
    if (row) {
      const review = await readReview(row, request, source);
      if (!equal(review.request, request)) return fail("conflict");
      await finish(tx, request, source, review, at);
      status = review.decision;
    }
    finalCurrent(at, [value.expiresAt, source.expiresAt]);
    return ModelPrivacyCandidateStatusSchema.parse({
      candidateId,
      requestId: request.requestId,
      requestSha256: request.requestSha256,
      status,
      expiresAt: value.expiresAt,
    });
  };
  const rendezvousForTransaction = async (
    tx: Transaction,
    operation: "prepareModelPrivacyReview" | "readModelPrivacyReview",
    rawRequest: ModelUseRequest,
    at: string,
    governedInput: Uint8Array
  ) => {
    current(at);
    const request = await parseRequest(rawRequest);
    await lock(tx, scopeOf(request));
    const selected = await owner.readRendezvousOriginalForTransaction(
      tx,
      request,
      current(at)
    );
    const source = await original(tx, request, current(at));
    if (
      !equal(source, selected.source) ||
      governedInput.byteLength !== request.inputBytes ||
      (await hashArtifact(governedInput)) !== request.inputSha256
    )
      return fail("denied");
    const prior = await candidateFor(tx, request, source, at);
    // Neither operation invokes currentModelUse, reserves dispatch or retries a
    // provider. An absent observation after lost ACK is never a resubmit signal.
    if (!prior && operation === "prepareModelPrivacyReview") {
      if ((await dispatch(tx, request, source)) !== null)
        return fail("conflict");
      const submittedAt = current(at);
      const waitEnd = new Date(
        Number(time(submittedAt) / 1_000_000n) + selected.limits.maximum_wait_ms
      ).toISOString();
      const expiresAt = [waitEnd, source.expiresAt, request.deadlineAt].reduce(
        (a, b) => (time(a) <= time(b) ? a : b)
      );
      const value = SelectedModelPrivacyCandidateSchema.parse({
        profile:
          source.nativePhase === undefined
            ? "vertex-first-mate-model-privacy-candidate-v1"
            : "vertex-first-mate-native-model-privacy-candidate-v1",
        ...phaseFields(source),
        candidateId: await candidateIdentity(request, source),
        ...scopeOf(request),
        responseRequestId: source.responseRequestId,
        planId: source.planId,
        planSha256: source.planSha256,
        request,
        submittedAt,
        expiresAt,
      });
      await insert(tx, privacyTable("candidates", source), scopeOf(request), {
        ...phaseColumns(source),
        response_request_id: source.responseRequestId,
        operation: request.operation,
        candidate_id: value.candidateId,
        plan_id: source.planId,
        plan_sha256: source.planSha256,
        request_id: request.requestId,
        request_sha256: request.requestSha256,
        submitted_at_ns: time(submittedAt).toString(),
        expires_at_ns: time(expiresAt).toString(),
        payload: value,
        record_hash: await hashArtifact(value),
      });
    }
    const finalSource = await owner.readRendezvousOriginalForTransaction(
      tx,
      request,
      current(at)
    );
    if (!equal(finalSource, selected)) return fail("stale");
    return candidateStatus(tx, request, source, current(at));
  };
  const readSelectedModelPrivacyReviewRequest = async (
    rawPrincipal: VertexPrincipal,
    rawInput:
      | z.infer<typeof ReadModelPrivacyReviewRequestInputSchema>
      | z.infer<typeof ReadNativeModelPrivacyReviewRequestInputSchema>
  ) => {
    const principal = principalSchema.parse(rawPrincipal),
      input = z
        .union([
          ReadModelPrivacyReviewRequestInputSchema,
          ReadNativeModelPrivacyReviewRequestInputSchema,
        ])
        .parse(rawInput);
    if (principal.actorId !== reviewerActorId || !equal(input, rawInput))
      return fail("denied");
    const readCandidateForTransaction = async (tx: Transaction, at: string) => {
      const row = await one(
        tx,
        privacyTable("candidates", input),
        input,
        sql`response_request_id = ${input.responseRequestId} and operation = ${input.operation} and ${phaseWhere(input)}`
      );
      if (!row) return fail("denied");
      const candidate = await parseCandidate(row),
        request = candidate.request;
      if (
        candidate.accountAlias !== input.accountAlias ||
        candidate.environment !== input.environment ||
        candidate.responseRequestId !== input.responseRequestId ||
        request.operation !== input.operation
      )
        return fail("integrity");
      const selected = await owner.readRendezvousOriginalForTransaction(
        tx,
        request,
        current(at)
      );
      const source = await original(tx, request, current(at));
      if (
        !(
          equal(phaseFields(input), phaseFields(source)) &&
          equal(phaseFields(candidate), phaseFields(source))
        )
      )
        return fail("denied");
      if (!equal(source, selected.source)) return fail("stale");
      const head = await latest(tx, request, source);
      const review =
        head === null ? null : await readReview(head, request, source);
      if (review !== null && !equal(review.request, request))
        return fail("conflict");
      await grants(tx, request, source, current(at));
      await candidateFor(tx, request, source, current(at));
      return (
        source.nativePhase === undefined
          ? ReadModelPrivacyReviewRequestOutputSchema
          : ReadNativeModelPrivacyReviewRequestOutputSchema
      ).parse({ candidate, currentReviewId: review?.reviewId ?? null });
    };
    const value = await ctx.run(
      principal,
      { accountAlias: input.accountAlias, environment: input.environment },
      null,
      "account-scope",
      "read",
      (tx, at) =>
        readCandidateForTransaction(tx, at).catch((error) => {
          if (error instanceof ChatWorkerOriginalClosedError) return null;
          throw error;
        }),
      true
    );
    if (value === null) return fail("denied");
    return value;
  };
  const recordSelectedModelPrivacyReview = async (
    principal: VertexPrincipal,
    raw:
      | z.infer<typeof RecordModelPrivacyReviewInputSchema>
      | z.infer<typeof RecordNativeModelPrivacyReviewInputSchema>
  ) => {
    const input = z
        .union([
          RecordModelPrivacyReviewInputSchema,
          RecordNativeModelPrivacyReviewInputSchema,
        ])
        .parse(raw),
      review = input.review;
    const { candidate } = await readSelectedModelPrivacyReviewRequest(
      principal,
      {
        ...scopeOf(review.request),
        environment: "research",
        responseRequestId: review.responseRequestId,
        operation: review.request.operation,
        ...phaseFields(review),
      }
    );
    if (
      candidate.candidateId !== input.candidateId ||
      candidate.planId !== review.planId ||
      candidate.planSha256 !== review.planSha256 ||
      !equal(candidate.request, review.request) ||
      time(review.expiresAt) > time(candidate.expiresAt)
    )
      return fail("denied");
    const recorded = await recordSelectedResearchChatModelPrivacyReview(
      principal,
      review
    );
    return RecordModelPrivacyReviewOutputSchema.parse({
      candidateId: candidate.candidateId,
      requestSha256: review.request.requestSha256,
      reviewId: recorded.reviewId,
      decision: recorded.decision,
      expiresAt: recorded.expiresAt,
    });
  };
  const recordResearchChatModelPrivacyReview = async (
    principal: VertexPrincipal,
    input: ChatModelPrivacyReviewInput
  ) =>
    ChatModelPrivacyReviewSchema.parse(
      await recordSelectedResearchChatModelPrivacyReview(
        principal,
        ChatModelPrivacyReviewInputSchema.parse(input)
      )
    );
  const readModelPrivacyReviewRequest = async (
    principal: VertexPrincipal,
    input: z.infer<typeof ReadModelPrivacyReviewRequestInputSchema>
  ) =>
    ReadModelPrivacyReviewRequestOutputSchema.parse(
      await readSelectedModelPrivacyReviewRequest(
        principal,
        ReadModelPrivacyReviewRequestInputSchema.parse(input)
      )
    );
  const recordModelPrivacyReview = (
    principal: VertexPrincipal,
    input: z.infer<typeof RecordModelPrivacyReviewInputSchema>
  ) =>
    recordSelectedModelPrivacyReview(
      principal,
      RecordModelPrivacyReviewInputSchema.parse(input)
    );
  const readNativeModelPrivacyReviewRequest = async (
    principal: VertexPrincipal,
    input: z.infer<typeof ReadNativeModelPrivacyReviewRequestInputSchema>
  ) =>
    ReadNativeModelPrivacyReviewRequestOutputSchema.parse(
      await readSelectedModelPrivacyReviewRequest(
        principal,
        ReadNativeModelPrivacyReviewRequestInputSchema.parse(input)
      )
    );
  const recordNativeModelPrivacyReview = (
    principal: VertexPrincipal,
    input: z.infer<typeof RecordNativeModelPrivacyReviewInputSchema>
  ) =>
    recordSelectedModelPrivacyReview(
      principal,
      RecordNativeModelPrivacyReviewInputSchema.parse(input)
    );
  return Object.freeze({
    recordResearchChatModelPrivacyReview,
    readForTransaction,
    reserveDispatchForTransaction,
    rendezvousForTransaction,
    readModelPrivacyReviewRequest,
    recordModelPrivacyReview,
    readNativeModelPrivacyReviewRequest,
    recordNativeModelPrivacyReview,
  });
};
export type ResearchChatModelPrivacyOperations = ReturnType<
  typeof createResearchChatModelPrivacyOperations
>;

// Provenance only: callers must separately rejoin current original authority
// and before/after model-use audits; this immutable association is not a grant.
export const readResearchChatModelDispatchProvenanceForTransaction = async (
  tx: Transaction,
  request: ModelUseRequest,
  source: Pick<
    Original,
    | "responseRequestId"
    | "planId"
    | "planSha256"
    | "originalRequestSha256"
    | "nativePhase"
  >
): Promise<Row | null> => {
  const row = await one(
    tx,
    privacyTable("dispatches", source),
    scopeOf(request),
    sql`response_request_id = ${source.responseRequestId} and operation = ${request.operation} and ${phaseWhere(source)}`
  );
  if (row === null) return null;
  canonical(row["payload"]);
  const value = SelectedDispatchSchema.parse(row["payload"]);
  await parseModelUseRequest(value.request);
  if (
    !equal(value, row["payload"]) ||
    (await hashArtifact(value)) !== row["record_hash"] ||
    !equal(phaseFields(value), phaseFields(source))
  )
    return fail("integrity");
  for (const [column, expected] of Object.entries({
    ...phaseColumns(value),
    account_alias: value.accountAlias,
    environment: value.environment,
    response_request_id: value.responseRequestId,
    plan_id: value.planId,
    plan_sha256: value.planSha256,
    original_request_sha256: value.originalRequestSha256,
    operation: value.request.operation,
    request_id: value.request.requestId,
    request_sha256: value.request.requestSha256,
    review_id: value.reviewId,
    reserved_at_ns: time(value.reservedAt).toString(),
  }))
    if (row[column] !== expected) return fail("integrity");
  if (
    value.accountAlias !== request.accountAlias ||
    value.environment !== request.environment ||
    value.responseRequestId !== source.responseRequestId ||
    value.planId !== source.planId ||
    value.planSha256 !== source.planSha256 ||
    value.originalRequestSha256 !== source.originalRequestSha256 ||
    !equal(value.request, request)
  )
    return fail("conflict");
  return row;
};
