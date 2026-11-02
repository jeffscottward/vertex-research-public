import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexGrantVersions } from "./vertex-authorization.ts";
import { vertexModelUseGrantVersions } from "./vertex-model-use.ts";
import { vertexResearchChatExecutionPlans } from "./vertex-research-chat-execution.ts";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const record = () => ({
  payload: jsonb("payload")
    .$type<Readonly<Record<string, unknown>>>()
    .notNull(),
  recordHash: text("record_hash").notNull(),
});
const ns = (name: string) =>
  numeric(name, { precision: 30, scale: 0 }).notNull();

// SOURCE ONLY; migration-sources/research-chat-model-privacy.sql also prohibits
// UPDATE/DELETE. Neither this declaration nor that unapplied source grants use.
export const vertexResearchChatModelPrivacyReviews = pgTable(
  "vertex_research_chat_model_privacy_reviews",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    reviewId: text("review_id").notNull(),
    actorId: text("actor_id").notNull(),
    operation: text("operation").notNull(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    modelGrantId: text("model_grant_id").notNull(),
    modelGrantVersion: text("model_grant_version").notNull(),
    accountReadGrantId: text("account_read_grant_id").notNull(),
    accountReadGrantVersion: text("account_read_grant_version").notNull(),
    policyReviewGrantId: text("policy_review_grant_id").notNull(),
    policyReviewGrantVersion: text("policy_review_grant_version").notNull(),
    requestReviewGrantId: text("request_review_grant_id").notNull(),
    requestReviewGrantVersion: text("request_review_grant_version").notNull(),
    decision: text("decision").notNull(),
    policyId: text("policy_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    revision: ns("revision"),
    idempotencyKey: text("idempotency_key").notNull(),
    commandSha256: text("command_sha256").notNull(),
    supersedesReviewId: text("supersedes_review_id"),
    reviewedAtNs: ns("reviewed_at_ns"),
    expiresAtNs: ns("expires_at_ns"),
    decisionCanonical: text("decision_canonical"),
    decisionSha256: text("decision_sha256"),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.reviewId] }),
    uniqueIndex("vertex_chat_model_privacy_key").on(
      t.accountAlias,
      t.environment,
      t.actorId,
      t.idempotencyKey
    ),
    uniqueIndex("vertex_chat_model_privacy_revision").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.operation,
      t.revision
    ),
    uniqueIndex("vertex_chat_model_privacy_predecessor").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.operation,
      sql`coalesce(${t.supersedesReviewId}, '')`
    ),
    uniqueIndex("vertex_chat_model_privacy_response_pin").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.operation,
      t.reviewId
    ),
    uniqueIndex("vertex_chat_model_privacy_dispatch_pin").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.operation,
      t.requestId,
      t.requestSha256,
      t.reviewId
    ),
    foreignKey({
      name: "vertex_chat_model_privacy_plan_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.planId,
        t.planSha256,
      ],
      foreignColumns: [
        vertexResearchChatExecutionPlans.accountAlias,
        vertexResearchChatExecutionPlans.environment,
        vertexResearchChatExecutionPlans.responseRequestId,
        vertexResearchChatExecutionPlans.planId,
        vertexResearchChatExecutionPlans.planSha256,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_privacy_previous_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.operation,
        t.supersedesReviewId,
      ],
      foreignColumns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.operation,
        t.reviewId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_privacy_model_grant_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.modelGrantId,
        t.modelGrantVersion,
      ],
      foreignColumns: [
        vertexModelUseGrantVersions.accountAlias,
        vertexModelUseGrantVersions.environment,
        vertexModelUseGrantVersions.grantId,
        vertexModelUseGrantVersions.grantVersion,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_privacy_account_grant_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.accountReadGrantId,
        t.accountReadGrantVersion,
      ],
      foreignColumns: [
        vertexGrantVersions.accountAlias,
        vertexGrantVersions.environment,
        vertexGrantVersions.grantId,
        vertexGrantVersions.version,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_privacy_policy_grant_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.policyReviewGrantId,
        t.policyReviewGrantVersion,
      ],
      foreignColumns: [
        vertexGrantVersions.accountAlias,
        vertexGrantVersions.environment,
        vertexGrantVersions.grantId,
        vertexGrantVersions.version,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_privacy_request_grant_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.requestReviewGrantId,
        t.requestReviewGrantVersion,
      ],
      foreignColumns: [
        vertexGrantVersions.accountAlias,
        vertexGrantVersions.environment,
        vertexGrantVersions.grantId,
        vertexGrantVersions.version,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_model_privacy_scope",
      sql`${t.environment} = 'research' and ${t.operation} in ('model-tokenize','model-completion')`
    ),
    check(
      "vertex_chat_model_privacy_window",
      sql`${t.revision} between 1 and 128 and ${t.expiresAtNs} > ${t.reviewedAtNs} and ((${t.revision} = 1 and ${t.supersedesReviewId} is null) or (${t.revision} > 1 and ${t.supersedesReviewId} is not null)) and ${t.reviewId} is distinct from ${t.supersedesReviewId}`
    ),
    check(
      "vertex_chat_model_privacy_hashes",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$' and ${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.commandSha256} ~ '^[0-9a-f]{64}$' and ${t.reviewId} = 'chat-privacy-' || ${t.commandSha256}`
    ),
    check(
      "vertex_chat_model_privacy_payload",
      sql`(
    jsonb_typeof(${t.payload}) = 'object' and
    ${t.payload}->>'profile' = 'vertex-research-chat-model-privacy-review-v1' and
    ${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and
    ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planId' = ${t.planId} and ${t.payload}->>'planSha256' = ${t.planSha256} and
    ${t.payload}->>'reviewId' = ${t.reviewId} and ${t.payload}->>'reviewerActorId' = ${t.actorId} and ${t.payload}->>'decision' = ${t.decision} and
    ${t.payload}->>'policyId' = ${t.policyId} and ${t.payload}->>'policyVersion' = ${t.policyVersion} and
    ${t.payload}->>'commandSha256' = ${t.commandSha256} and ${t.payload}->>'idempotencyKey' = ${t.idempotencyKey} and
    (${t.payload}->>'supersedesReviewId') is not distinct from ${t.supersedesReviewId} and ${t.payload} ? 'supersedesReviewId' and
    ${t.payload}->'request'->>'accountAlias' = ${t.accountAlias} and ${t.payload}->'request'->>'environment' = ${t.environment} and
    ${t.payload}->'request'->>'requestId' = ${t.requestId} and ${t.payload}->'request'->>'requestSha256' = ${t.requestSha256} and ${t.payload}->'request'->>'operation' = ${t.operation} and
    ${t.payload}->'request'->>'grantId' = ${t.modelGrantId} and ${t.payload}->'request'->>'grantVersion' = ${t.modelGrantVersion} and
    ${t.payload} - array['profile','accountAlias','environment','responseRequestId','planId','planSha256','reviewId','request','decision','privacyDecision','reviewerActorId','reviewerGrants','policyId','policyVersion','reviewedAt','expiresAt','supersedesReviewId','idempotencyKey','commandSha256'] = '{}'::jsonb and
    ${t.payload}->'request' - array['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) is true`
    ),
    check(
      "vertex_chat_model_privacy_grant_pins",
      sql`(
    jsonb_array_length(${t.payload}->'reviewerGrants') = 3 and
    ${t.payload}->'reviewerGrants'->0->>'grantId' = ${t.accountReadGrantId} and ${t.payload}->'reviewerGrants'->0->>'version' = ${t.accountReadGrantVersion} and
    ${t.payload}->'reviewerGrants'->0->>'resourceId' = 'account-scope' and ${t.payload}->'reviewerGrants'->0->>'action' = 'read' and
    ${t.payload}->'reviewerGrants'->1->>'grantId' = ${t.policyReviewGrantId} and ${t.payload}->'reviewerGrants'->1->>'version' = ${t.policyReviewGrantVersion} and
    ${t.payload}->'reviewerGrants'->1->>'resourceId' = ${t.policyId} and ${t.payload}->'reviewerGrants'->1->>'action' = 'review' and
    ${t.payload}->'reviewerGrants'->2->>'grantId' = ${t.requestReviewGrantId} and ${t.payload}->'reviewerGrants'->2->>'version' = ${t.requestReviewGrantVersion} and
    ${t.payload}->'reviewerGrants'->2->>'resourceId' = 'research-chat-model-privacy:' || ${t.responseRequestId} || ':' || ${t.operation} and ${t.payload}->'reviewerGrants'->2->>'action' = 'review'
  ) is true`
    ),
    check(
      "vertex_chat_model_privacy_original_decision",
      sql`(
    (${t.decision} = 'rejected' and ${t.payload}->'privacyDecision' = 'null'::jsonb and ${t.decisionCanonical} is null and ${t.decisionSha256} is null) or
    (${t.decision} = 'accepted' and ${t.decisionCanonical} is not null and ${t.decisionSha256} ~ '^[0-9a-f]{64}$' and
      ${t.decisionCanonical}::jsonb = ${t.payload}->'privacyDecision' and ${t.payload}->'privacyDecision' = jsonb_build_object(
        'format','vertex-model-privacy-decision-v1','request',${t.payload}->'request','policyId',${t.policyId},'policyVersion',${t.policyVersion},
        'issuedByActorId',${t.actorId},'decidedAt',${t.payload}->>'reviewedAt','expiresAt',${t.payload}->>'expiresAt','decision','allow-model-processing','executionAuthorized',false))
  ) is true`
    ),
  ]
);

// The primary key is intentionally NOT reviewId/lease/epoch/requestId. Unknown
// provider outcomes retain the first response+operation association forever.
export const vertexResearchChatModelDispatches = pgTable(
  "vertex_research_chat_model_dispatches",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    operation: text("operation").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    originalRequestSha256: text("original_request_sha256").notNull(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    reviewId: text("review_id").notNull(),
    reservedAtNs: ns("reserved_at_ns"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.operation,
      ],
    }),
    uniqueIndex("vertex_chat_model_dispatch_request").on(
      t.accountAlias,
      t.environment,
      t.requestId
    ),
    foreignKey({
      name: "vertex_chat_model_dispatch_plan_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.planId,
        t.planSha256,
      ],
      foreignColumns: [
        vertexResearchChatExecutionPlans.accountAlias,
        vertexResearchChatExecutionPlans.environment,
        vertexResearchChatExecutionPlans.responseRequestId,
        vertexResearchChatExecutionPlans.planId,
        vertexResearchChatExecutionPlans.planSha256,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_model_dispatch_review_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.operation,
        t.requestId,
        t.requestSha256,
        t.reviewId,
      ],
      foreignColumns: [
        vertexResearchChatModelPrivacyReviews.accountAlias,
        vertexResearchChatModelPrivacyReviews.environment,
        vertexResearchChatModelPrivacyReviews.responseRequestId,
        vertexResearchChatModelPrivacyReviews.operation,
        vertexResearchChatModelPrivacyReviews.requestId,
        vertexResearchChatModelPrivacyReviews.requestSha256,
        vertexResearchChatModelPrivacyReviews.reviewId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_model_dispatch_scope",
      sql`${t.environment} = 'research' and ${t.operation} in ('model-tokenize','model-completion')`
    ),
    check(
      "vertex_chat_model_dispatch_hashes",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$' and ${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.originalRequestSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_model_dispatch_payload",
      sql`(
    jsonb_typeof(${t.payload}) = 'object' and ${t.payload}->>'profile' = 'vertex-research-chat-model-dispatch-v1' and
    ${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and
    ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planId' = ${t.planId} and ${t.payload}->>'planSha256' = ${t.planSha256} and
    ${t.payload}->>'originalRequestSha256' = ${t.originalRequestSha256} and ${t.payload}->>'reviewId' = ${t.reviewId} and
    ${t.payload}->'request'->>'requestId' = ${t.requestId} and ${t.payload}->'request'->>'requestSha256' = ${t.requestSha256} and
    ${t.payload}->'request'->>'operation' = ${t.operation} and ${t.payload}->'request'->>'accountAlias' = ${t.accountAlias} and ${t.payload}->'request'->>'environment' = ${t.environment} and
    ${t.payload} - array['profile','accountAlias','environment','responseRequestId','planId','planSha256','originalRequestSha256','request','reviewId','reservedAt'] = '{}'::jsonb and
    ${t.payload}->'request' - array['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) is true`
    ),
  ]
);

// One immutable metadata rendezvous slot per existing response/operation. This
// neither replaces the independent review chain nor the no-retry dispatch slot.
// Separate unapplied migration source: research-chat-model-privacy-rendezvous.sql.
export const vertexResearchChatModelPrivacyCandidates = pgTable(
  "vertex_research_chat_model_privacy_candidates",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    operation: text("operation").notNull(),
    candidateId: text("candidate_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    submittedAtNs: ns("submitted_at_ns"),
    expiresAtNs: ns("expires_at_ns"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.operation,
      ],
    }),
    uniqueIndex("vertex_chat_model_candidate_id").on(
      t.accountAlias,
      t.environment,
      t.candidateId
    ),
    uniqueIndex("vertex_chat_model_candidate_request").on(
      t.accountAlias,
      t.environment,
      t.requestId
    ),
    foreignKey({
      name: "vertex_chat_model_candidate_plan_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.planId,
        t.planSha256,
      ],
      foreignColumns: [
        vertexResearchChatExecutionPlans.accountAlias,
        vertexResearchChatExecutionPlans.environment,
        vertexResearchChatExecutionPlans.responseRequestId,
        vertexResearchChatExecutionPlans.planId,
        vertexResearchChatExecutionPlans.planSha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_model_candidate_scope",
      sql`${t.environment} = 'research' and ${t.operation} in ('model-tokenize','model-completion')`
    ),
    check(
      "vertex_chat_model_candidate_window",
      sql`${t.expiresAtNs} > ${t.submittedAtNs} and ${t.expiresAtNs} - ${t.submittedAtNs} <= 300000000000`
    ),
    check(
      "vertex_chat_model_candidate_hashes",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$' and ${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.candidateId} ~ '^chat-candidate-[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_model_candidate_payload",
      sql`(
    jsonb_typeof(${t.payload}) = 'object' and ${t.payload}->>'profile' = 'vertex-first-mate-model-privacy-candidate-v1' and
    ${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and ${t.payload}->>'candidateId' = ${t.candidateId} and
    ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planId' = ${t.planId} and ${t.payload}->>'planSha256' = ${t.planSha256} and
    ${t.payload}->'request'->>'requestId' = ${t.requestId} and ${t.payload}->'request'->>'requestSha256' = ${t.requestSha256} and
    ${t.payload}->'request'->>'accountAlias' = ${t.accountAlias} and ${t.payload}->'request'->>'environment' = ${t.environment} and ${t.payload}->'request'->>'operation' = ${t.operation} and
    ${t.payload} - array['profile','candidateId','accountAlias','environment','responseRequestId','planId','planSha256','request','submittedAt','expiresAt'] = '{}'::jsonb and
    ${t.payload}->'request' - array['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) is true`
    ),
  ]
);
