-- Hand-authored source only; journal/snapshot assembly and execution deferred.
-- Assertion evidence only: no grants, native owner state, or seed economics.
CREATE TABLE vertex_portfolio_epoch_transitions (
  account_alias text NOT NULL, environment text NOT NULL, transition_id text NOT NULL,
  stream_id text NOT NULL, prior_owner_epoch numeric(30,0) NOT NULL,
  prior_projection_sequence numeric(30,0) NOT NULL, prior_projection_hash text NOT NULL,
  owner_epoch numeric(30,0) NOT NULL, snapshot_id text NOT NULL,
  snapshot_sha256 text NOT NULL, genesis_hash text NOT NULL,
  journal_identity text NOT NULL, journal_sequence numeric(30,0) NOT NULL,
  journal_head_sha256 text NOT NULL, native_outbox_evidence_sha256 text NOT NULL,
  native_owner_fence_sha256 text NOT NULL, approval_base64 text NOT NULL,
  transition_sha256 text NOT NULL, actor_id text NOT NULL, recorded_at text NOT NULL,
  authorization_kind text NOT NULL DEFAULT 'direct',
  authorizing_replay_request_sha256 text, authorizing_signer_key_sha256 text, authorizing_approval_id text,
  authoritative boolean NOT NULL DEFAULT false,
  execution_authorized boolean NOT NULL DEFAULT false, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,transition_id),
  FOREIGN KEY(account_alias,environment,stream_id) REFERENCES vertex_projection_heads(account_alias,environment,stream_id),
  FOREIGN KEY(account_alias,environment,snapshot_id) REFERENCES vertex_portfolio_snapshots(account_alias,environment,snapshot_id),
  CONSTRAINT vertex_epoch_transition_observation CHECK(environment = 'paper' AND authoritative = false AND execution_authorized = false),
  CONSTRAINT vertex_epoch_transition_authorization CHECK(
    (authorization_kind = 'direct' AND authorizing_replay_request_sha256 IS NULL AND authorizing_signer_key_sha256 IS NULL AND authorizing_approval_id IS NULL)
    OR (authorization_kind = 'retained-replay' AND authorizing_replay_request_sha256 IS NOT NULL AND authorizing_signer_key_sha256 IS NOT NULL AND authorizing_approval_id IS NOT NULL AND authorizing_replay_request_sha256 ~ '^[0-9a-f]{64}$' AND authorizing_signer_key_sha256 ~ '^[0-9a-f]{64}$' AND length(authorizing_approval_id) BETWEEN 1 AND 160)),
  CONSTRAINT vertex_epoch_transition_sequences CHECK(prior_owner_epoch > 0 AND owner_epoch > prior_owner_epoch AND prior_projection_sequence > 0 AND journal_sequence > 0),
  CONSTRAINT vertex_epoch_transition_digests CHECK(
    prior_projection_hash ~ '^[0-9a-f]{64}$' AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND genesis_hash ~ '^[0-9a-f]{64}$' AND journal_head_sha256 ~ '^[0-9a-f]{64}$'
    AND native_outbox_evidence_sha256 ~ '^[0-9a-f]{64}$' AND native_owner_fence_sha256 ~ '^[0-9a-f]{64}$'
    AND transition_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_epoch_transition_approval CHECK(
    length(approval_base64) BETWEEN 4 AND 1398104
    AND approval_base64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    AND octet_length(decode(approval_base64, 'base64')) BETWEEN 1 AND 1048576
    AND replace(encode(decode(approval_base64, 'base64'), 'base64'), E'\n', '') = approval_base64),
  CONSTRAINT vertex_epoch_transition_binding CHECK((
    payload->>'schemaVersion' = '1.0.0' AND payload->>'transitionId' = transition_id
    AND payload->>'priorOwnerEpoch' = prior_owner_epoch::text
    AND payload->>'priorProjectionSequence' = prior_projection_sequence::text
    AND payload->>'priorProjectionHash' = prior_projection_hash
    AND payload->>'journalIdentity' = journal_identity
    AND payload->>'journalSequence' = journal_sequence::text
    AND payload->>'journalHeadSha256' = journal_head_sha256
    AND payload->>'nativeOutboxEvidenceSha256' = native_outbox_evidence_sha256
    AND payload->>'nativeOwnerFenceSha256' = native_owner_fence_sha256
    AND payload->>'approvalBase64' = approval_base64
    AND payload->'snapshot'->>'snapshotId' = snapshot_id
    AND payload->'snapshot'->>'accountAlias' = account_alias
    AND payload->'snapshot'->>'environment' = environment
    AND payload->'snapshot'->>'streamId' = stream_id
    AND payload->'snapshot'->>'ownerEpoch' = owner_epoch::text
    AND payload->'snapshot'->>'sequence' = '1'
    AND payload->'snapshot'->>'sourceEventHash' = genesis_hash
    AND payload->'snapshot'->>'sourceKind' = 'paper-simulation') IS TRUE)
);
CREATE UNIQUE INDEX vertex_epoch_transition_owner ON vertex_portfolio_epoch_transitions(account_alias,environment,stream_id,owner_epoch);
CREATE UNIQUE INDEX vertex_epoch_transition_predecessor ON vertex_portfolio_epoch_transitions(account_alias,environment,stream_id,prior_owner_epoch);
CREATE UNIQUE INDEX vertex_epoch_transition_snapshot ON vertex_portfolio_epoch_transitions(account_alias,environment,snapshot_id);
CREATE INDEX vertex_epoch_transition_journal ON vertex_portfolio_epoch_transitions(account_alias,environment,journal_identity,journal_sequence);
--> statement-breakpoint
-- Custom SQL invariant: immutable evidence survives later epochs. Snapshot FK
-- retains the restored checkpoint; no ON DELETE cascade or history rewrite.
CREATE FUNCTION vertex_reject_epoch_transition_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Epoch transition assertion evidence is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vertex_epoch_transition_immutable
BEFORE UPDATE OR DELETE ON vertex_portfolio_epoch_transitions
FOR EACH ROW EXECUTE FUNCTION vertex_reject_epoch_transition_mutation();
--> statement-breakpoint
CREATE TRIGGER vertex_epoch_transition_no_truncate
BEFORE TRUNCATE ON vertex_portfolio_epoch_transitions
FOR EACH STATEMENT EXECUTE FUNCTION vertex_reject_epoch_transition_mutation();
