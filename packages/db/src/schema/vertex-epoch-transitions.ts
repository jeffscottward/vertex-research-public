import { sql } from "drizzle-orm";
import {
  boolean,
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
import { vertexPortfolioSnapshots, vertexProjectionHeads } from "./vertex.ts";
import { vertexNativeApprovalAudit } from "./vertex-native-approval-audit.ts";

// Immutable assertions about an independently approved native transition. This
// is not native owner authority, an approval issuer, or an economic state owner.
const ns = (name: string) => numeric(name, { precision: 30, scale: 0 });
export const vertexPortfolioEpochTransitions = pgTable(
  "vertex_portfolio_epoch_transitions",
  {
    accountAlias: text("account_alias").notNull(),
    environment: text("environment").notNull(),
    transitionId: text("transition_id").notNull(),
    streamId: text("stream_id").notNull(),
    priorOwnerEpoch: ns("prior_owner_epoch").notNull(),
    priorProjectionSequence: ns("prior_projection_sequence").notNull(),
    priorProjectionHash: text("prior_projection_hash").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    genesisHash: text("genesis_hash").notNull(),
    journalIdentity: text("journal_identity").notNull(),
    journalSequence: ns("journal_sequence").notNull(),
    journalHeadSha256: text("journal_head_sha256").notNull(),
    nativeOutboxEvidenceSha256: text("native_outbox_evidence_sha256").notNull(),
    nativeOwnerFenceSha256: text("native_owner_fence_sha256").notNull(),
    approvalBase64: text("approval_base64").notNull(),
    transitionSha256: text("transition_sha256").notNull(),
    actorId: text("actor_id").notNull(),
    recordedAt: text("recorded_at").notNull(),
    authorizationKind: text("authorization_kind").notNull().default("direct"),
    authorizingReplayRequestSha256: text("authorizing_replay_request_sha256"),
    authorizingSignerKeySha256: text("authorizing_signer_key_sha256"),
    authorizingApprovalId: text("authorizing_approval_id"),
    authoritative: boolean("authoritative").notNull().default(false),
    executionAuthorized: boolean("execution_authorized")
      .notNull()
      .default(false),
    payload: jsonb("payload")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.transitionId] }),
    uniqueIndex("vertex_epoch_transition_owner").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.ownerEpoch
    ),
    uniqueIndex("vertex_epoch_transition_predecessor").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.priorOwnerEpoch
    ),
    uniqueIndex("vertex_epoch_transition_snapshot").on(
      t.accountAlias,
      t.environment,
      t.snapshotId
    ),
    index("vertex_epoch_transition_journal").on(
      t.accountAlias,
      t.environment,
      t.journalIdentity,
      t.journalSequence
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.streamId],
      foreignColumns: [
        vertexProjectionHeads.accountAlias,
        vertexProjectionHeads.environment,
        vertexProjectionHeads.streamId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.snapshotId],
      foreignColumns: [
        vertexPortfolioSnapshots.accountAlias,
        vertexPortfolioSnapshots.environment,
        vertexPortfolioSnapshots.snapshotId,
      ],
    }),
    foreignKey({
      name: "vertex_epoch_transition_replay_authorization_fk",
      columns: [
        t.authorizingSignerKeySha256,
        t.authorizingApprovalId,
        t.authorizingReplayRequestSha256,
      ],
      foreignColumns: [
        vertexNativeApprovalAudit.signerKeySha256,
        vertexNativeApprovalAudit.approvalId,
        vertexNativeApprovalAudit.requestSha256,
      ],
    }),
    check(
      "vertex_epoch_transition_observation",
      sql`${t.environment} = 'paper' and ${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
    // The migration adds DEFERRABLE INITIALLY DEFERRED to the generated audit FK;
    // Drizzle records its identity but cannot express the required deferred timing.
    check(
      "vertex_epoch_transition_authorization",
      sql`(${t.authorizationKind} = 'direct' and ${t.authorizingReplayRequestSha256} is null and ${t.authorizingSignerKeySha256} is null and ${t.authorizingApprovalId} is null) or (${t.authorizationKind} = 'retained-replay' and ${t.authorizingReplayRequestSha256} is not null and ${t.authorizingSignerKeySha256} is not null and ${t.authorizingApprovalId} is not null and ${t.authorizingReplayRequestSha256} ~ '^[0-9a-f]{64}$' and ${t.authorizingSignerKeySha256} ~ '^[0-9a-f]{64}$' and length(${t.authorizingApprovalId}) between 1 and 160)`
    ),
    check(
      "vertex_epoch_transition_sequences",
      sql`${t.priorOwnerEpoch} > 0 and ${t.ownerEpoch} > ${t.priorOwnerEpoch} and ${t.priorProjectionSequence} > 0 and ${t.journalSequence} > 0`
    ),
    check(
      "vertex_epoch_transition_digests",
      sql`${t.priorProjectionHash} ~ '^[0-9a-f]{64}$' and ${t.snapshotSha256} ~ '^[0-9a-f]{64}$' and ${t.genesisHash} ~ '^[0-9a-f]{64}$' and ${t.journalHeadSha256} ~ '^[0-9a-f]{64}$' and ${t.nativeOutboxEvidenceSha256} ~ '^[0-9a-f]{64}$' and ${t.nativeOwnerFenceSha256} ~ '^[0-9a-f]{64}$' and ${t.transitionSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_epoch_transition_approval",
      sql`length(${t.approvalBase64}) between 4 and 1398104 and ${t.approvalBase64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' and octet_length(decode(${t.approvalBase64}, 'base64')) between 1 and 1048576 and replace(encode(decode(${t.approvalBase64}, 'base64'), 'base64'), E'\n', '') = ${t.approvalBase64}`
    ),
    check(
      "vertex_epoch_transition_binding",
      sql`(${t.payload}->>'schemaVersion' = '1.0.0' and ${t.payload}->>'transitionId' = ${t.transitionId} and ${t.payload}->>'priorOwnerEpoch' = ${t.priorOwnerEpoch}::text and ${t.payload}->>'priorProjectionSequence' = ${t.priorProjectionSequence}::text and ${t.payload}->>'priorProjectionHash' = ${t.priorProjectionHash} and ${t.payload}->>'journalIdentity' = ${t.journalIdentity} and ${t.payload}->>'journalSequence' = ${t.journalSequence}::text and ${t.payload}->>'journalHeadSha256' = ${t.journalHeadSha256} and ${t.payload}->>'nativeOutboxEvidenceSha256' = ${t.nativeOutboxEvidenceSha256} and ${t.payload}->>'nativeOwnerFenceSha256' = ${t.nativeOwnerFenceSha256} and ${t.payload}->>'approvalBase64' = ${t.approvalBase64} and ${t.payload}->'snapshot'->>'snapshotId' = ${t.snapshotId} and ${t.payload}->'snapshot'->>'accountAlias' = ${t.accountAlias} and ${t.payload}->'snapshot'->>'environment' = ${t.environment} and ${t.payload}->'snapshot'->>'streamId' = ${t.streamId} and ${t.payload}->'snapshot'->>'ownerEpoch' = ${t.ownerEpoch}::text and ${t.payload}->'snapshot'->>'sequence' = '1' and ${t.payload}->'snapshot'->>'sourceEventHash' = ${t.genesisHash} and ${t.payload}->'snapshot'->>'sourceKind' = 'paper-simulation') is true`
    ),
  ]
);
