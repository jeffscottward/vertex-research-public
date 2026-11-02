-- Hand-authored additive source only. Never executed by the author.
-- Application writers serialize BOTH event kinds under the existing account /
-- environment advisory fence and check cross-table identity before writing.
-- No new sequence ledger, cloud cash mutation, trigger or execution authority.
CREATE TABLE vertex_native_journal_proofs (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  stream_id text NOT NULL, owner_epoch numeric(30,0) NOT NULL, source_event_id text NOT NULL,
  occurred_at text NOT NULL, event_type text NOT NULL, journal_sequence numeric(30,0) NOT NULL,
  journal_head_hash text NOT NULL, sha256 text NOT NULL, byte_length integer NOT NULL,
  fact_ordinal integer NOT NULL,
  canonical_json text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  CONSTRAINT vertex_native_proof_paper CHECK(environment = 'paper'),
  CONSTRAINT vertex_native_proof_size CHECK(byte_length BETWEEN 1 AND 1048576 AND octet_length(canonical_json) = byte_length),
  CONSTRAINT vertex_native_proof_digest CHECK(sha256 ~ '^[0-9a-f]{64}$' AND journal_head_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_native_proof_sequence CHECK(owner_epoch > 0 AND journal_sequence > 0),
  CONSTRAINT vertex_native_proof_ordinal CHECK(fact_ordinal BETWEEN 0 AND 63),
  CONSTRAINT vertex_native_proof_kind CHECK(event_type IN ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state'))
);
CREATE UNIQUE INDEX vertex_native_proof_binding ON vertex_native_journal_proofs(account_alias,environment,artifact_id,sha256,source_event_id);
CREATE INDEX vertex_native_proof_source ON vertex_native_journal_proofs(account_alias,environment,stream_id,owner_epoch,source_event_id);
--> statement-breakpoint
CREATE TABLE vertex_native_fact_projections (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  stream_id text NOT NULL, owner_epoch numeric(30,0) NOT NULL, sequence numeric(30,0) NOT NULL,
  event_hash text NOT NULL, previous_event_hash text NOT NULL, idempotency_key text NOT NULL,
  occurred_at text NOT NULL, received_at text NOT NULL, expires_at_ns numeric(30,0) NOT NULL,
  applied boolean NOT NULL, disposition text NOT NULL, fact_kind text NOT NULL,
  proof_artifact_id text NOT NULL, proof_sha256 text NOT NULL, proof_source_event_id text NOT NULL,
  proof_journal_sequence numeric(30,0) NOT NULL, proof_journal_head_hash text NOT NULL, fact_ordinal integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,stream_id) REFERENCES vertex_projection_heads(account_alias,environment,stream_id),
  FOREIGN KEY(account_alias,environment,proof_artifact_id,proof_sha256,proof_source_event_id) REFERENCES vertex_native_journal_proofs(account_alias,environment,artifact_id,sha256,source_event_id),
  CONSTRAINT vertex_native_fact_sequence_positive CHECK(sequence >= 2 AND owner_epoch > 0),
  CONSTRAINT vertex_native_fact_digest CHECK(event_hash ~ '^[0-9a-f]{64}$' AND previous_event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_native_fact_journal_shape CHECK(proof_journal_sequence > 0 AND proof_journal_head_hash ~ '^[0-9a-f]{64}$' AND fact_ordinal BETWEEN 0 AND 63),
  CONSTRAINT vertex_native_fact_kind CHECK(fact_kind IN ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state')),
  CONSTRAINT vertex_native_fact_disposition CHECK(disposition IN ('applied','stale','gap','epoch-mismatch') AND (applied = (disposition IN ('applied','stale')))),
  CONSTRAINT vertex_native_fact_observation CHECK(environment = 'paper' AND authoritative = false AND execution_authorized = false)
);
CREATE UNIQUE INDEX vertex_native_fact_sequence ON vertex_native_fact_projections(account_alias,environment,stream_id,owner_epoch,sequence);
CREATE UNIQUE INDEX vertex_native_fact_idempotency ON vertex_native_fact_projections(account_alias,environment,stream_id,idempotency_key);
CREATE UNIQUE INDEX vertex_native_fact_journal_identity ON vertex_native_fact_projections(account_alias,environment,owner_epoch,proof_journal_sequence,proof_journal_head_hash,fact_ordinal);
CREATE INDEX vertex_native_fact_pending ON vertex_native_fact_projections(account_alias,environment,stream_id,applied,owner_epoch,sequence);
--> statement-breakpoint
CREATE TABLE vertex_native_checkpoints (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  snapshot_id text NOT NULL, snapshot_sha256 text NOT NULL,
  journal_sequence numeric(30,0) NOT NULL, journal_head_hash text NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_fact_projections(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_checkpoint_identity CHECK(journal_sequence > 0 AND snapshot_sha256 ~ '^[0-9a-f]{64}$' AND journal_head_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_native_checkpoint_observation CHECK(authoritative = false AND execution_authorized = false)
);
--> statement-breakpoint
CREATE TABLE vertex_native_settlements (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  fact_kind text NOT NULL, settlement_id text NOT NULL, settlement_state text NOT NULL,
  instrument_id text, underlying_id text, settlement_kind text, quantity text,
  currency text NOT NULL, cash_delta text NOT NULL, share_delta text, due_at text,
  due_at_ns numeric(30,0), occurred_at_ns numeric(30,0) NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_fact_projections(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_settlement_shape CHECK(
    (fact_kind = 'cash-settlement' AND settlement_state = 'settled' AND instrument_id IS NULL AND underlying_id IS NULL AND settlement_kind IS NULL AND quantity IS NULL AND share_delta IS NULL AND due_at IS NULL AND due_at_ns IS NULL)
    OR (fact_kind IN ('assignment','exercise','option-expiry') AND settlement_state IN ('pending','settled') AND instrument_id IS NOT NULL AND underlying_id IS NOT NULL AND instrument_id <> underlying_id AND settlement_kind IS NOT NULL AND settlement_kind IN ('cash','physical') AND quantity IS NOT NULL AND share_delta IS NOT NULL AND due_at IS NOT NULL AND due_at_ns IS NOT NULL)
  ),
  CONSTRAINT vertex_native_settlement_due CHECK(settlement_state <> 'settled' OR due_at_ns IS NULL OR due_at_ns <= occurred_at_ns),
  CONSTRAINT vertex_native_settlement_cash CHECK(settlement_kind IS NULL OR settlement_kind <> 'cash' OR share_delta = '0'),
  CONSTRAINT vertex_native_expiry_zero CHECK(fact_kind <> 'option-expiry' OR (cash_delta = '0' AND share_delta = '0')),
  CONSTRAINT vertex_native_settlement_observation CHECK(authoritative = false AND execution_authorized = false)
);
CREATE INDEX vertex_native_settlement_history ON vertex_native_settlements(account_alias,environment,settlement_id,settlement_state);
--> statement-breakpoint
CREATE TABLE vertex_native_settlement_sources (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  source_ordinal integer NOT NULL, source_event_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id,source_ordinal),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_settlements(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_settlement_source_bound CHECK(source_ordinal BETWEEN 0 AND 511)
);
CREATE UNIQUE INDEX vertex_native_settlement_source_identity ON vertex_native_settlement_sources(account_alias,environment,projection_id,source_event_id);
--> statement-breakpoint
CREATE TABLE vertex_native_corporate_actions (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  action_id text NOT NULL, old_instrument_id text NOT NULL, new_instrument_id text NOT NULL,
  quantity_numerator numeric(30,0) NOT NULL, quantity_denominator numeric(30,0) NOT NULL,
  previous_quantity text NOT NULL, new_quantity text NOT NULL, cash_delta text NOT NULL, currency text NOT NULL,
  previous_qualification_sha256 text NOT NULL, replacement_qualification_sha256 text NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_fact_projections(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_corporate_ratio CHECK(quantity_numerator > 0 AND quantity_denominator > 0),
  CONSTRAINT vertex_native_corporate_digests CHECK(previous_qualification_sha256 ~ '^[0-9a-f]{64}$' AND replacement_qualification_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_native_corporate_observation CHECK(authoritative = false AND execution_authorized = false)
);
--> statement-breakpoint
CREATE TABLE vertex_native_reconciliations (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  reconciliation_id text NOT NULL, observed_snapshot_id text NOT NULL,
  unknown_count integer NOT NULL, reconciled boolean NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_fact_projections(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_reconciliation_count CHECK(unknown_count BETWEEN 0 AND 10000 AND (reconciled = false OR unknown_count = 0)),
  CONSTRAINT vertex_native_reconciliation_observation CHECK(authoritative = false AND execution_authorized = false)
);
--> statement-breakpoint
CREATE TABLE vertex_native_kill_states (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  authoritative boolean NOT NULL DEFAULT false, execution_authorized boolean NOT NULL DEFAULT false,
  action text NOT NULL, grant_id text,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_fact_projections(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_kill_action CHECK(action IN ('pause-new-risk','reset-new-risk','reconcile-required') AND (action <> 'reset-new-risk' OR grant_id IS NOT NULL)),
  CONSTRAINT vertex_native_kill_observation CHECK(authoritative = false AND execution_authorized = false)
);
--> statement-breakpoint
CREATE TABLE vertex_native_kill_reasons (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  reason_ordinal integer NOT NULL, reason_code text NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id,reason_ordinal),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_native_kill_states(account_alias,environment,projection_id),
  CONSTRAINT vertex_native_kill_reason_bound CHECK(reason_ordinal BETWEEN 0 AND 63)
);
CREATE UNIQUE INDEX vertex_native_kill_reason_identity ON vertex_native_kill_reasons(account_alias,environment,projection_id,reason_code);
