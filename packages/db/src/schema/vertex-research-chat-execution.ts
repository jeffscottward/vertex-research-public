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
import { vertexResearchChatThreads } from "./vertex-research-chat.ts";
import { vertexResearchChatCopyAllocations } from "./vertex-research-chat-copies.ts";
import { vertexWorkerStages } from "./vertex-worker.ts";

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

// Metadata-only immutable plans. Query/context/model bytes have no column here.
export const vertexResearchChatExecutionPlans = pgTable(
  "vertex_research_chat_execution_plans",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    storageEvidenceArtifactId: text("storage_evidence_artifact_id").notNull(),
    storageEvidenceSha256: text("storage_evidence_sha256").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId],
    }),
    uniqueIndex("vertex_chat_execution_plan_pin").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.planId,
      t.planSha256
    ),
    uniqueIndex("vertex_chat_execution_plan_request_key").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.idempotencyKey
    ),
    foreignKey({
      name: "vertex_chat_execution_plan_thread",
      columns: [t.accountAlias, t.environment, t.ownerActorId, t.threadId],
      foreignColumns: [
        vertexResearchChatThreads.accountAlias,
        vertexResearchChatThreads.environment,
        vertexResearchChatThreads.ownerActorId,
        vertexResearchChatThreads.threadId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_execution_plan_evidence",
      columns: [
        t.accountAlias,
        t.environment,
        t.storageEvidenceArtifactId,
        t.storageEvidenceSha256,
      ],
      foreignColumns: [
        vertexWorkerStages.accountAlias,
        vertexWorkerStages.environment,
        vertexWorkerStages.artifactId,
        vertexWorkerStages.contentSha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_execution_plan_scope",
      sql`${t.environment} = 'research'`
    ),
    check(
      "vertex_chat_execution_plan_hashes",
      sql`${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_execution_plan_payload",
      sql`(((${t.payload}->>'format' = 'vertex-research-chat-plan-v1' and not (${t.payload} ? 'debate')) or (${t.payload}->>'format' = 'vertex-research-chat-plan-v2' and ${t.payload} #>> '{debate,profile}' = 'vertex-research-chat-debate-plan-v1') or (${t.payload}->>'format' = 'vertex-research-chat-native-evidence-plan-v1' and not (${t.payload} ? 'debate') and ${t.payload} #>> '{nativeEvidence,profile}' = 'first-mate-read-reviewed-evidence-v1')) and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planId' = ${t.planId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'ownerActorId' = ${t.ownerActorId} and not (${t.payload} ?| array['request','retrievalQuery','body','advisory','answer'])) is true`
    ),
  ]
);

// Private staged-target review, NOT a public vertex_reviews row. The composite
// plan FK prevents transferring accepted technical evidence to another request.
export const vertexResearchChatStorageReviews = pgTable(
  "vertex_research_chat_storage_reviews",
  {
    ...scope(),
    ...record(),
    reviewId: text("review_id").notNull(),
    responseRequestId: text("response_request_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    evidenceArtifactId: text("evidence_artifact_id").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    actorId: text("actor_id").notNull(),
    issuerActorId: text("issuer_actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    decision: text("decision").notNull(),
    reviewedAtNs: ns("reviewed_at_ns"),
    expiresAtNs: ns("expires_at_ns"),
    supersedesReviewId: text("supersedes_review_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.reviewId] }),
    uniqueIndex("vertex_chat_storage_review_request_pin").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.reviewId
    ),
    uniqueIndex("vertex_chat_storage_review_request_key").on(
      t.accountAlias,
      t.environment,
      t.actorId,
      t.idempotencyKey
    ),
    foreignKey({
      name: "vertex_chat_storage_review_plan",
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
      name: "vertex_chat_storage_review_stage",
      columns: [
        t.accountAlias,
        t.environment,
        t.evidenceArtifactId,
        t.evidenceSha256,
      ],
      foreignColumns: [
        vertexWorkerStages.accountAlias,
        vertexWorkerStages.environment,
        vertexWorkerStages.artifactId,
        vertexWorkerStages.contentSha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_storage_review_scope",
      sql`${t.environment} = 'research' and ${t.actorId} <> ${t.issuerActorId}`
    ),
    check(
      "vertex_chat_storage_review_decision",
      sql`${t.decision} in ('accepted','rejected') and ${t.expiresAtNs} > ${t.reviewedAtNs}`
    ),
    check(
      "vertex_chat_storage_review_payload",
      sql`(${t.payload}->>'format' = 'vertex-research-chat-storage-qualification-review-v1' and ${t.payload}->>'purpose' = 'storage-qualification' and ${t.payload}->>'reviewId' = ${t.reviewId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'decision' = ${t.decision} and ${t.payload}->>'actorId' = ${t.actorId} and ${t.payload}->>'ownerActorId' <> ${t.actorId}) is true`
    ),
  ]
);

export const vertexResearchChatExecutionApprovals = pgTable(
  "vertex_research_chat_execution_approvals",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    storageReviewId: text("storage_review_id").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId],
    }),
    foreignKey({
      name: "vertex_chat_execution_approval_plan",
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
      name: "vertex_chat_execution_approval_review",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.storageReviewId,
      ],
      foreignColumns: [
        vertexResearchChatStorageReviews.accountAlias,
        vertexResearchChatStorageReviews.environment,
        vertexResearchChatStorageReviews.responseRequestId,
        vertexResearchChatStorageReviews.reviewId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_execution_approval_scope",
      sql`${t.environment} = 'research'`
    ),
    check(
      "vertex_chat_execution_approval_payload",
      sql`(((${t.payload}->>'format' = 'vertex-research-chat-approval-v1' and not (${t.payload} ? 'debateSha256')) or (${t.payload}->>'format' = 'vertex-research-chat-approval-v2' and ${t.payload}->>'debateSha256' ~ '^[0-9a-f]{64}$') or (${t.payload}->>'format' = 'vertex-research-chat-native-evidence-approval-v1' and not (${t.payload} ? 'debateSha256') and ${t.payload}->>'nativeEvidenceSha256' ~ '^[0-9a-f]{64}$')) and ${t.payload}->>'ownerActorId' = ${t.ownerActorId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'storageReviewId' = ${t.storageReviewId} and not (${t.payload} ?| array['request','retrievalQuery','body','context','tokenizeInput','completionInput','advisory','answer'])) is true`
    ),
  ]
);

// SOURCE ONLY: durable dispatch fences. Only the fresh committed insert winner
// may perform I/O. Neither intents nor observations contain plaintext copy bytes.
export const vertexResearchChatCopyEffects = pgTable(
  "vertex_research_chat_copy_effects",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    copyId: text("copy_id").notNull(),
    operation: text("operation").notNull(),
    planSha256: text("plan_sha256").notNull(),
    bindingSha256: text("binding_sha256").notNull(),
    intentCommittedAtNs: ns("intent_committed_at_ns"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.copyId,
        t.operation,
      ],
    }),
    foreignKey({
      name: "vertex_chat_copy_effect_approval",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
      foreignColumns: [
        vertexResearchChatExecutionApprovals.accountAlias,
        vertexResearchChatExecutionApprovals.environment,
        vertexResearchChatExecutionApprovals.responseRequestId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_copy_effect_allocation",
      columns: [t.accountAlias, t.environment, t.responseRequestId, t.copyId],
      foreignColumns: [
        vertexResearchChatCopyAllocations.accountAlias,
        vertexResearchChatCopyAllocations.environment,
        vertexResearchChatCopyAllocations.responseRequestId,
        vertexResearchChatCopyAllocations.copyId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_copy_effect_shape",
      sql`${t.environment} = 'research' and ${t.operation} in ('create','fence') and ${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.bindingSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_copy_effect_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-effect-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'responseRequestId',${t.responseRequestId},'copyId',${t.copyId},'planSha256',${t.planSha256},'operation',${t.operation},'bindingSha256',${t.bindingSha256},'content',${t.payload}->'content','intentCommittedAt',${t.payload}->'intentCommittedAt') and (${t.payload}->'content' = 'null'::jsonb or (${t.payload}->'content' = jsonb_build_object('sha256',${t.payload} #> '{content,sha256}','byteLength',${t.payload} #> '{content,byteLength}') and ${t.payload} #>> '{content,sha256}' ~ '^[0-9a-f]{64}$' and (${t.payload} #>> '{content,byteLength}')::integer between 1 and 16777216)) and (${t.operation} <> 'create' or ${t.payload}->'content' <> 'null'::jsonb)) is true`
    ),
  ]
);

export const vertexResearchChatCopyEffectObservations = pgTable(
  "vertex_research_chat_copy_effect_observations",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    copyId: text("copy_id").notNull(),
    operation: text("operation").notNull(),
    observedAtNs: ns("observed_at_ns"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.copyId,
        t.operation,
      ],
    }),
    foreignKey({
      name: "vertex_chat_copy_observation_effect",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.copyId,
        t.operation,
      ],
      foreignColumns: [
        vertexResearchChatCopyEffects.accountAlias,
        vertexResearchChatCopyEffects.environment,
        vertexResearchChatCopyEffects.responseRequestId,
        vertexResearchChatCopyEffects.copyId,
        vertexResearchChatCopyEffects.operation,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_copy_observation_shape",
      sql`${t.environment} = 'research' and ${t.operation} in ('create','fence') and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_copy_observation_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-effect-observation-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'responseRequestId',${t.responseRequestId},'copyId',${t.copyId},'planSha256',${t.payload}->'planSha256','operation',${t.operation},'proof',${t.payload}->'proof','observedAt',${t.payload}->'observedAt') and ${t.payload} #>> '{proof,state}' = case when ${t.operation} = 'create' then 'live' else 'fenced' end and ${t.payload}->'proof' = jsonb_build_object('key',${t.payload} #> '{proof,key}','state',${t.payload} #> '{proof,state}','bindingSha256',${t.payload} #> '{proof,bindingSha256}','reservationSha256',${t.payload} #> '{proof,reservationSha256}','storageProfileSha256',${t.payload} #> '{proof,storageProfileSha256}','sha256',${t.payload} #> '{proof,sha256}','byteLength',${t.payload} #> '{proof,byteLength}','etag',${t.payload} #> '{proof,etag}','version',${t.payload} #> '{proof,version}','uploadedAt',${t.payload} #> '{proof,uploadedAt}')) is true`
    ),
  ]
);

// Input closure is independent from derived closure and from the existing
// stronger whole-family closure. No terminal input action closes an advisory.
export const vertexResearchChatCopyDomainClosures = pgTable(
  "vertex_research_chat_copy_domain_closures",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    domain: text("domain").notNull(),
    planSha256: text("plan_sha256").notNull(),
    closedAtNs: ns("closed_at_ns"),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId, t.domain],
    }),
    foreignKey({
      name: "vertex_chat_copy_domain_approval",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
      foreignColumns: [
        vertexResearchChatExecutionApprovals.accountAlias,
        vertexResearchChatExecutionApprovals.environment,
        vertexResearchChatExecutionApprovals.responseRequestId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_copy_domain_shape",
      sql`${t.environment} = 'research' and ${t.domain} in ('inputs','derived') and ${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_copy_domain_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-domain-closure-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'responseRequestId',${t.responseRequestId},'planSha256',${t.planSha256},'domain',${t.domain},'cause',${t.payload}->'cause','authority',${t.payload}->'authority','closedAt',${t.payload}->'closedAt') and ${t.payload}->>'cause' in ('explicit','deadline','original-authority-revoked','original-authority-expired','rights-denied','rights-expiry','rights-superseded','retention-ended','storage-review-superseded','storage-review-rejected','storage-review-expired','corpus-review-superseded','corpus-review-rejected','corpus-review-expired','response-attempt-terminal','storage-fenced') and ${t.payload}->'authority' = jsonb_build_object('kind',${t.payload} #> '{authority,kind}','resourceId',${t.payload} #> '{authority,resourceId}','version',${t.payload} #> '{authority,version}') and ${t.payload} #>> '{authority,kind}' in ('owner-context-grant','corpus-rights','private-policy-rights','storage-review','corpus-review','plan','cleanup-grant','response-attempt','storage-fence') and ${t.payload} #>> '{authority,resourceId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and (${t.payload} #> '{authority,version}' = 'null'::jsonb or ${t.payload} #>> '{authority,version}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')) is true`
    ),
  ]
);
