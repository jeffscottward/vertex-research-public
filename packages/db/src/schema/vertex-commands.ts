import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexArtifacts, vertexRecords, vertexReviews } from "./vertex.ts";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const ns = (name: string) => numeric(name, { precision: 30, scale: 0 });
const record = (name: string) =>
  jsonb(name).$type<Readonly<Record<string, unknown>>>().notNull();

export const vertexCommandReceipts = pgTable(
  "vertex_command_receipts",
  {
    ...scope(),
    actorId: text("actor_id").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    command: record("command"),
    result: record("result"),
    resultHash: text("result_hash").notNull(),
    collectionKey: text("collection_key").notNull(),
    targetArtifactId: text("target_artifact_id"),
    reviewId: text("review_id"),
    admissionId: text("admission_id"),
    committedAt: text("committed_at").notNull(),
    committedAtNs: ns("committed_at_ns").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_command_receipts_pk",
      columns: [
        t.accountAlias,
        t.environment,
        t.actorId,
        t.kind,
        t.idempotencyKey,
      ],
    }),
    check(
      "vertex_command_kind",
      sql`${t.kind} in ('review','research','simulation','research-chat-response')`
    ),
    check(
      "vertex_command_hashes",
      sql`${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.resultHash} ~ '^[0-9a-f]{64}$'`
    ),
    // Bodyless unavailable and original admitted profiles only. Legacy kinds
    // retain every prior meaning. IS TRUE rejects SQL unknown from missing/null
    // JSON fields; exact reconstruction rejects all extra/copy-bearing keys.
    check(
      "vertex_chat_response_scope",
      sql`${t.kind} <> 'research-chat-response' or (
    ${t.environment} = 'research' and
    ${t.accountAlias} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    ${t.actorId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    ${t.idempotencyKey} ~ '^response-[0-9a-f]{64}$' and
    ${t.collectionKey} = '' and ${t.targetArtifactId} is null and
    ${t.reviewId} is null and ${t.admissionId} is null
  ) is true`
    ),
    check(
      "vertex_chat_response_command",
      sql`${t.kind} <> 'research-chat-response' or (
    ${t.command} = jsonb_build_object(
      'profile', 'vertex-research-chat-response-command-v1',
      'operation', 'requestResponse', 'actorId', ${t.actorId},
      'input', jsonb_build_object(
        'accountAlias', ${t.accountAlias}, 'environment', ${t.environment},
        'threadId', ${t.command} #> '{input,threadId}',
        'parentMessageId', ${t.command} #> '{input,parentMessageId}',
        'participantId', ${t.command} #> '{input,participantId}',
        'snapshotRevision', ${t.command} #> '{input,snapshotRevision}',
        'contextStartSequence', ${t.command} #> '{input,contextStartSequence}',
        'idempotencyKey', ${t.command} #> '{input,idempotencyKey}'
      )
    ) and
    jsonb_typeof(${t.command} #> '{input,threadId}') = 'string' and
    (${t.command} #>> '{input,threadId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof(${t.command} #> '{input,parentMessageId}') = 'string' and
    (${t.command} #>> '{input,parentMessageId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof(${t.command} #> '{input,participantId}') = 'string' and
    (${t.command} #>> '{input,participantId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof(${t.command} #> '{input,idempotencyKey}') = 'string' and
    (${t.command} #>> '{input,idempotencyKey}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof(${t.command} #> '{input,snapshotRevision}') = 'string' and
    jsonb_typeof(${t.command} #> '{input,contextStartSequence}') = 'string' and
    case when
      (${t.command} #>> '{input,snapshotRevision}') ~ '^[1-9][0-9]{0,29}$' and
      (${t.command} #>> '{input,contextStartSequence}') ~ '^[1-9][0-9]{0,29}$'
    then (${t.command} #>> '{input,snapshotRevision}')::numeric >= 2 and
      (${t.command} #>> '{input,snapshotRevision}')::numeric - (${t.command} #>> '{input,contextStartSequence}')::numeric between 1 and 16
    else false end
  ) is true`
    ),
    check(
      "vertex_chat_response_result",
      sql`${t.kind} <> 'research-chat-response' or (
    ${t.result} = jsonb_build_object(
      'schemaVersion', '1.0.0', 'executionAuthorized', false,
      'accountAlias', ${t.accountAlias}, 'environment', ${t.environment},
      'threadId', ${t.command} #> '{input,threadId}', 'ownerActorId', ${t.actorId},
      'responseRequestId', ${t.idempotencyKey},
      'parentMessageId', ${t.command} #> '{input,parentMessageId}',
      'participantId', ${t.command} #> '{input,participantId}',
      'idempotencyKey', ${t.command} #> '{input,idempotencyKey}',
      'requestSha256', ${t.requestHash}, 'recordedAt', ${t.committedAt},
      'snapshotRevision', ${t.command} #> '{input,snapshotRevision}',
      'contextStartSequence', ${t.command} #> '{input,contextStartSequence}',
      'status', ${t.result}->>'status',
      'reasonCodes', case when ${t.result}->>'status' = 'admitted' then '[]'::jsonb else '["research-runtime-unavailable"]'::jsonb end,
      'admission', case when ${t.result}->>'status' = 'admitted' then ${t.result}->'admission' else 'null'::jsonb end, 'jobId', null
    ) and ${t.result}->>'status' in ('unavailable','admitted') and
    (${t.result}->>'status' = 'unavailable' or (
      ${t.result}->'admission' = jsonb_build_object(
        'bindingSha256', ${t.result} #> '{admission,bindingSha256}', 'contextSha256', ${t.result} #> '{admission,contextSha256}',
        'participantConfigSha256', ${t.result} #> '{admission,participantConfigSha256}', 'collectionId', ${t.result} #> '{admission,collectionId}',
        'proposal', jsonb_build_object('artifactId', ${t.result} #> '{admission,proposal,artifactId}', 'sha256', ${t.result} #> '{admission,proposal,sha256}'),
        'runId', ${t.result} #> '{admission,runId}', 'eventId', ${t.result} #> '{admission,eventId}'
      ) and
      (${t.result} #>> '{admission,bindingSha256}') ~ '^[0-9a-f]{64}$' and
      (${t.result} #>> '{admission,contextSha256}') ~ '^[0-9a-f]{64}$' and
      (${t.result} #>> '{admission,participantConfigSha256}') ~ '^[0-9a-f]{64}$' and
      (${t.result} #>> '{admission,proposal,sha256}') ~ '^[0-9a-f]{64}$' and
      (${t.result} #>> '{admission,proposal,artifactId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
      (${t.result} #>> '{admission,collectionId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
      (${t.result} #>> '{admission,runId}') ~ '^chat-run-[0-9a-f]{64}$' and
      (${t.result} #>> '{admission,eventId}') ~ '^event-[0-9a-f]{64}$'
    ))
  ) is true`
    ),
  ]
);

// Review overlay only: source bytes, identity, citations, snapshot and original
// acceptanceStatus never change. Latest review selection is reader-owned and
// must consider rejections, supersession and expiry before effective acceptance.
export const vertexReviewedArtifactLinks = pgTable(
  "vertex_reviewed_artifact_links",
  {
    ...scope(),
    reviewId: text("review_id").notNull(),
    collectionKey: text("collection_key").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    committedAt: text("committed_at").notNull(),
    committedAtNs: ns("committed_at_ns").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_reviewed_artifact_links_pk",
      columns: [t.accountAlias, t.environment, t.reviewId],
    }),
    index("vertex_reviewed_artifact_lookup").on(
      t.accountAlias,
      t.environment,
      t.collectionKey,
      t.artifactId
    ),
    foreignKey({
      name: "vertex_reviewed_artifact_review_fk",
      columns: [t.accountAlias, t.environment, t.reviewId],
      foreignColumns: [
        vertexReviews.accountAlias,
        vertexReviews.environment,
        vertexReviews.reviewId,
      ],
    }),
    foreignKey({
      name: "vertex_reviewed_artifact_record_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
  ]
);

export const vertexResearchProposals = pgTable(
  "vertex_research_proposals",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    actorId: text("actor_id").notNull(),
    collectionId: text("collection_id").notNull(),
    question: text("question").notNull(),
    role: text("role").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    payload: record("payload"),
    committedAt: text("committed_at").notNull(),
    committedAtNs: ns("committed_at_ns").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_research_proposals_pk",
      columns: [t.accountAlias, t.environment, t.artifactId],
    }),
    foreignKey({
      name: "vertex_research_proposal_record_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
    check(
      "vertex_research_question",
      sql`length(${t.question}) between 1 and 2000`
    ),
    check(
      "vertex_research_role",
      sql`${t.role} in ('research','paper-to-strategy','backtest-review','knowledge-import')`
    ),
  ]
);
export const vertexResearchProposalEvidence = pgTable(
  "vertex_research_proposal_evidence",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    ordinal: numeric("ordinal", { precision: 2, scale: 0 }).notNull(),
    evidenceId: text("evidence_id").notNull(),
    evidenceArtifactId: text("evidence_artifact_id").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_research_proposal_evidence_pk",
      columns: [t.accountAlias, t.environment, t.artifactId, t.evidenceId],
    }),
    uniqueIndex("vertex_proposal_evidence_ordinal").on(
      t.accountAlias,
      t.environment,
      t.artifactId,
      t.ordinal
    ),
    foreignKey({
      name: "vertex_proposal_evidence_proposal_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexResearchProposals.accountAlias,
        vertexResearchProposals.environment,
        vertexResearchProposals.artifactId,
      ],
    }),
    foreignKey({
      name: "vertex_proposal_evidence_artifact_fk",
      columns: [t.accountAlias, t.environment, t.evidenceArtifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
    check(
      "vertex_proposal_evidence_ordinal_bound",
      sql`${t.ordinal} between 0 and 31`
    ),
  ]
);
