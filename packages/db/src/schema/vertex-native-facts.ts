import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexProjectionHeads } from "./vertex.ts";

// Immutable native journal evidence and observation rows only. The sole stream
// head remains vertex_projection_heads; none of these tables is spending state.
const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const ns = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();
const observation = () => ({
  ...scope(),
  projectionId: text("projection_id").notNull(),
  authoritative: boolean("authoritative").notNull().default(false),
  executionAuthorized: boolean("execution_authorized").notNull().default(false),
});

export const vertexNativeJournalProofs = pgTable(
  "vertex_native_journal_proofs",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    streamId: text("stream_id").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    eventType: text("event_type").notNull(),
    journalSequence: ns("journal_sequence").notNull(),
    journalHeadHash: text("journal_head_hash").notNull(),
    sha256: text("sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    canonicalJson: text("canonical_json").notNull(),
    payload: payload(),
    factOrdinal: integer("fact_ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.artifactId] }),
    uniqueIndex("vertex_native_proof_binding").on(
      t.accountAlias,
      t.environment,
      t.artifactId,
      t.sha256,
      t.sourceEventId
    ),
    index("vertex_native_proof_source").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.ownerEpoch,
      t.sourceEventId
    ),
    check(
      "vertex_native_proof_ordinal",
      sql`${t.factOrdinal} between 0 and 63`
    ),
    check("vertex_native_proof_paper", sql`${t.environment} = 'paper'`),
    check(
      "vertex_native_proof_size",
      sql`${t.byteLength} between 1 and 1048576 and octet_length(${t.canonicalJson}) = ${t.byteLength}`
    ),
    check(
      "vertex_native_proof_digest",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.journalHeadHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_native_proof_sequence",
      sql`${t.ownerEpoch} > 0 and ${t.journalSequence} > 0`
    ),
    check(
      "vertex_native_proof_kind",
      sql`${t.eventType} in ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state')`
    ),
  ]
);

export const vertexNativeFactProjections = pgTable(
  "vertex_native_fact_projections",
  {
    ...observation(),
    streamId: text("stream_id").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    sequence: ns("sequence").notNull(),
    eventHash: text("event_hash").notNull(),
    previousEventHash: text("previous_event_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
    expiresAtNs: ns("expires_at_ns").notNull(),
    applied: boolean("applied").notNull(),
    disposition: text("disposition").notNull(),
    factKind: text("fact_kind").notNull(),
    proofArtifactId: text("proof_artifact_id").notNull(),
    proofSha256: text("proof_sha256").notNull(),
    proofSourceEventId: text("proof_source_event_id").notNull(),
    payload: payload(),
    proofJournalSequence: ns("proof_journal_sequence").notNull(),
    proofJournalHeadHash: text("proof_journal_head_hash").notNull(),
    factOrdinal: integer("fact_ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.projectionId] }),
    uniqueIndex("vertex_native_fact_sequence").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.ownerEpoch,
      t.sequence
    ),
    uniqueIndex("vertex_native_fact_idempotency").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.idempotencyKey
    ),
    uniqueIndex("vertex_native_fact_journal_identity").on(
      t.accountAlias,
      t.environment,
      t.ownerEpoch,
      t.proofJournalSequence,
      t.proofJournalHeadHash,
      t.factOrdinal
    ),
    index("vertex_native_fact_pending").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.applied,
      t.ownerEpoch,
      t.sequence
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
      columns: [
        t.accountAlias,
        t.environment,
        t.proofArtifactId,
        t.proofSha256,
        t.proofSourceEventId,
      ],
      foreignColumns: [
        vertexNativeJournalProofs.accountAlias,
        vertexNativeJournalProofs.environment,
        vertexNativeJournalProofs.artifactId,
        vertexNativeJournalProofs.sha256,
        vertexNativeJournalProofs.sourceEventId,
      ],
    }),
    check(
      "vertex_native_fact_journal_shape",
      sql`${t.proofJournalSequence} > 0 and ${t.proofJournalHeadHash} ~ '^[0-9a-f]{64}$' and ${t.factOrdinal} between 0 and 63`
    ),
    check(
      "vertex_native_fact_sequence_positive",
      sql`${t.sequence} >= 2 and ${t.ownerEpoch} > 0`
    ),
    check(
      "vertex_native_fact_digest",
      sql`${t.eventHash} ~ '^[0-9a-f]{64}$' and ${t.previousEventHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_native_fact_kind",
      sql`${t.factKind} in ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state')`
    ),
    check(
      "vertex_native_fact_disposition",
      sql`${t.disposition} in ('applied','stale','gap','epoch-mismatch') and (${t.applied} = (${t.disposition} in ('applied','stale')))`
    ),
    check(
      "vertex_native_fact_observation",
      sql`${t.environment} = 'paper' and ${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);

export const vertexNativeCheckpoints = pgTable(
  "vertex_native_checkpoints",
  {
    ...observation(),
    snapshotId: text("snapshot_id").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    journalSequence: ns("journal_sequence").notNull(),
    journalHeadHash: text("journal_head_hash").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_checkpoints_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId],
    }),
    foreignKey({
      name: "vertex_native_checkpoints_projection_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeFactProjections.accountAlias,
        vertexNativeFactProjections.environment,
        vertexNativeFactProjections.projectionId,
      ],
    }),
    check(
      "vertex_native_checkpoint_identity",
      sql`${t.journalSequence} > 0 and ${t.snapshotSha256} ~ '^[0-9a-f]{64}$' and ${t.journalHeadHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_native_checkpoint_observation",
      sql`${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);
export const vertexNativeSettlements = pgTable(
  "vertex_native_settlements",
  {
    ...observation(),
    factKind: text("fact_kind").notNull(),
    settlementId: text("settlement_id").notNull(),
    settlementState: text("settlement_state").notNull(),
    instrumentId: text("instrument_id"),
    underlyingId: text("underlying_id"),
    settlementKind: text("settlement_kind"),
    quantity: text("quantity"),
    currency: text("currency").notNull(),
    cashDelta: text("cash_delta").notNull(),
    shareDelta: text("share_delta"),
    dueAt: text("due_at"),
    dueAtNs: ns("due_at_ns"),
    occurredAtNs: ns("occurred_at_ns").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_settlements_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId],
    }),
    index("vertex_native_settlement_history").on(
      t.accountAlias,
      t.environment,
      t.settlementId,
      t.settlementState
    ),
    foreignKey({
      name: "vertex_native_settlements_projection_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeFactProjections.accountAlias,
        vertexNativeFactProjections.environment,
        vertexNativeFactProjections.projectionId,
      ],
    }),
    check(
      "vertex_native_settlement_shape",
      sql`(${t.factKind} = 'cash-settlement' and ${t.settlementState} = 'settled' and ${t.instrumentId} is null and ${t.underlyingId} is null and ${t.settlementKind} is null and ${t.quantity} is null and ${t.shareDelta} is null and ${t.dueAt} is null and ${t.dueAtNs} is null) or (${t.factKind} in ('assignment','exercise','option-expiry') and ${t.settlementState} in ('pending','settled') and ${t.instrumentId} is not null and ${t.underlyingId} is not null and ${t.instrumentId} <> ${t.underlyingId} and ${t.settlementKind} is not null and ${t.settlementKind} in ('cash','physical') and ${t.quantity} is not null and ${t.shareDelta} is not null and ${t.dueAt} is not null and ${t.dueAtNs} is not null)`
    ),
    check(
      "vertex_native_settlement_due",
      sql`${t.settlementState} <> 'settled' or ${t.dueAtNs} is null or ${t.dueAtNs} <= ${t.occurredAtNs}`
    ),
    check(
      "vertex_native_settlement_cash",
      sql`${t.settlementKind} is null or ${t.settlementKind} <> 'cash' or ${t.shareDelta} = '0'`
    ),
    check(
      "vertex_native_expiry_zero",
      sql`${t.factKind} <> 'option-expiry' or (${t.cashDelta} = '0' and ${t.shareDelta} = '0')`
    ),
    check(
      "vertex_native_settlement_observation",
      sql`${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);
export const vertexNativeSettlementSources = pgTable(
  "vertex_native_settlement_sources",
  {
    ...scope(),
    projectionId: text("projection_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    sourceEventId: text("source_event_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_settlement_sources_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId, t.sourceOrdinal],
    }),
    uniqueIndex("vertex_native_settlement_source_identity").on(
      t.accountAlias,
      t.environment,
      t.projectionId,
      t.sourceEventId
    ),
    foreignKey({
      name: "vertex_native_settlement_sources_settlement_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeSettlements.accountAlias,
        vertexNativeSettlements.environment,
        vertexNativeSettlements.projectionId,
      ],
    }),
    check(
      "vertex_native_settlement_source_bound",
      sql`${t.sourceOrdinal} between 0 and 511`
    ),
  ]
);
export const vertexNativeCorporateActions = pgTable(
  "vertex_native_corporate_actions",
  {
    ...observation(),
    actionId: text("action_id").notNull(),
    oldInstrumentId: text("old_instrument_id").notNull(),
    newInstrumentId: text("new_instrument_id").notNull(),
    quantityNumerator: ns("quantity_numerator").notNull(),
    quantityDenominator: ns("quantity_denominator").notNull(),
    previousQuantity: text("previous_quantity").notNull(),
    newQuantity: text("new_quantity").notNull(),
    cashDelta: text("cash_delta").notNull(),
    currency: text("currency").notNull(),
    previousQualificationSha256: text(
      "previous_qualification_sha256"
    ).notNull(),
    replacementQualificationSha256: text(
      "replacement_qualification_sha256"
    ).notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_corporate_actions_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId],
    }),
    foreignKey({
      name: "vertex_native_corporate_actions_projection_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeFactProjections.accountAlias,
        vertexNativeFactProjections.environment,
        vertexNativeFactProjections.projectionId,
      ],
    }),
    check(
      "vertex_native_corporate_ratio",
      sql`${t.quantityNumerator} > 0 and ${t.quantityDenominator} > 0`
    ),
    check(
      "vertex_native_corporate_digests",
      sql`${t.previousQualificationSha256} ~ '^[0-9a-f]{64}$' and ${t.replacementQualificationSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_native_corporate_observation",
      sql`${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);
export const vertexNativeReconciliations = pgTable(
  "vertex_native_reconciliations",
  {
    ...observation(),
    reconciliationId: text("reconciliation_id").notNull(),
    observedSnapshotId: text("observed_snapshot_id").notNull(),
    unknownCount: integer("unknown_count").notNull(),
    reconciled: boolean("reconciled").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_reconciliations_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId],
    }),
    foreignKey({
      name: "vertex_native_reconciliations_projection_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeFactProjections.accountAlias,
        vertexNativeFactProjections.environment,
        vertexNativeFactProjections.projectionId,
      ],
    }),
    check(
      "vertex_native_reconciliation_count",
      sql`${t.unknownCount} between 0 and 10000 and (${t.reconciled} = false or ${t.unknownCount} = 0)`
    ),
    check(
      "vertex_native_reconciliation_observation",
      sql`${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);
export const vertexNativeKillStates = pgTable(
  "vertex_native_kill_states",
  {
    ...observation(),
    action: text("action").notNull(),
    grantId: text("grant_id"),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_kill_states_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId],
    }),
    foreignKey({
      name: "vertex_native_kill_states_projection_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeFactProjections.accountAlias,
        vertexNativeFactProjections.environment,
        vertexNativeFactProjections.projectionId,
      ],
    }),
    check(
      "vertex_native_kill_action",
      sql`${t.action} in ('pause-new-risk','reset-new-risk','reconcile-required') and (${t.action} <> 'reset-new-risk' or ${t.grantId} is not null)`
    ),
    check(
      "vertex_native_kill_observation",
      sql`${t.authoritative} = false and ${t.executionAuthorized} = false`
    ),
  ]
);
export const vertexNativeKillReasons = pgTable(
  "vertex_native_kill_reasons",
  {
    ...scope(),
    projectionId: text("projection_id").notNull(),
    reasonOrdinal: integer("reason_ordinal").notNull(),
    reasonCode: text("reason_code").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_native_kill_reasons_pkey",
      columns: [t.accountAlias, t.environment, t.projectionId, t.reasonOrdinal],
    }),
    uniqueIndex("vertex_native_kill_reason_identity").on(
      t.accountAlias,
      t.environment,
      t.projectionId,
      t.reasonCode
    ),
    foreignKey({
      name: "vertex_native_kill_reasons_state_fk",
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexNativeKillStates.accountAlias,
        vertexNativeKillStates.environment,
        vertexNativeKillStates.projectionId,
      ],
    }),
    check(
      "vertex_native_kill_reason_bound",
      sql`${t.reasonOrdinal} between 0 and 63`
    ),
  ]
);
