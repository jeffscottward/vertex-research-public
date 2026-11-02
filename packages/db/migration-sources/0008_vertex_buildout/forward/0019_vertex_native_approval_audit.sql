-- Source only; permanent cross-purpose native approval consumption/audit.
-- No native key enrollment, grant creation, signature authority or execution.
CREATE TABLE vertex_native_approval_audit (
  signer_key_id text NOT NULL, signer_key_sha256 text NOT NULL,
  approval_id text NOT NULL, nonce text NOT NULL, approver_actor_id text NOT NULL,
  action text NOT NULL, subject_sha256 text NOT NULL, approval_sha256 text NOT NULL,
  status_revision numeric(30,0) NOT NULL, status_sha256 text NOT NULL, expires_at text NOT NULL,
  account_alias text NOT NULL, environment text NOT NULL, recipient_actor_id text NOT NULL,
  stream_id text NOT NULL, request_id text NOT NULL, request_sha256 text NOT NULL,
  approval_base64 text NOT NULL, outcome jsonb NOT NULL, recorded_at text NOT NULL,
  record_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(signer_key_sha256,approval_id),
  CONSTRAINT vertex_native_approval_purpose CHECK(environment = 'paper' AND action IN ('owner-epoch-transition','native-outbox-replay') AND approver_actor_id <> recipient_actor_id AND status_revision > 0),
  CONSTRAINT vertex_native_approval_digests CHECK(signer_key_sha256 ~ '^[0-9a-f]{64}$' AND nonce ~ '^[0-9a-f]{64}$' AND subject_sha256 ~ '^[0-9a-f]{64}$' AND approval_sha256 ~ '^[0-9a-f]{64}$' AND status_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_native_approval_proof CHECK(length(approval_base64) BETWEEN 4 AND 1398104 AND approval_base64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' AND octet_length(decode(approval_base64, 'base64')) BETWEEN 1 AND 1048576 AND replace(encode(decode(approval_base64, 'base64'), 'base64'), E'\n', '') = approval_base64),
  CONSTRAINT vertex_native_approval_binding CHECK((
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment
    AND payload->>'recipientActorId' = recipient_actor_id AND payload->>'streamId' = stream_id
    AND payload->>'requestId' = request_id AND payload->>'requestSha256' = request_sha256
    AND payload->>'approvalBase64' = approval_base64 AND payload->>'recordedAt' = recorded_at
    AND payload->'outcome' = outcome
    AND payload->'receipt'->>'signerKeyId' = signer_key_id
    AND payload->'receipt'->>'signerKeySha256' = signer_key_sha256
    AND payload->'receipt'->>'approvalId' = approval_id
    AND payload->'receipt'->>'nonce' = nonce
    AND payload->'receipt'->>'actorId' = approver_actor_id
    AND payload->'receipt'->>'action' = action
    AND payload->'receipt'->>'subjectSha256' = subject_sha256
    AND payload->'receipt'->>'approvalSha256' = approval_sha256
    AND payload->'receipt'->>'statusRevision' = status_revision::text
    AND payload->'receipt'->>'statusSha256' = status_sha256
    AND payload->'receipt'->>'expiresAt' = expires_at) IS TRUE),
  CONSTRAINT vertex_native_approval_outcome CHECK((outcome->>'status' IN ('applied','duplicate','gap','epoch-mismatch','stale') AND outcome->>'highWaterSequence' ~ '^(0|[1-9][0-9]{0,29})$' AND (outcome->'highWaterEventHash' = 'null'::jsonb OR outcome->>'highWaterEventHash' ~ '^[0-9a-f]{64}$')) IS TRUE)
);
-- Deliberately GLOBAL: neither account nor action weakens nonce uniqueness.
CREATE UNIQUE INDEX vertex_native_approval_nonce ON vertex_native_approval_audit(signer_key_sha256,nonce);
CREATE INDEX vertex_native_approval_request ON vertex_native_approval_audit(account_alias,environment,recipient_actor_id,action,request_id);
--> statement-breakpoint
CREATE FUNCTION vertex_reject_native_approval_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native approval consumption and audit evidence is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vertex_native_approval_audit_immutable
BEFORE UPDATE OR DELETE ON vertex_native_approval_audit
FOR EACH ROW EXECUTE FUNCTION vertex_reject_native_approval_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER vertex_native_approval_audit_no_truncate
BEFORE TRUNCATE ON vertex_native_approval_audit
FOR EACH STATEMENT EXECUTE FUNCTION vertex_reject_native_approval_audit_mutation();
--> statement-breakpoint
-- The referenced triple is nondeferrable. Only the referencing FK is deferred,
-- so replay may restore immutable lineage before its final audit INSERT while
-- COMMIT still rejects a missing or different authorizing replay request.
CREATE UNIQUE INDEX vertex_native_approval_exact_request ON vertex_native_approval_audit(signer_key_sha256,approval_id,request_sha256);
--> statement-breakpoint
ALTER TABLE vertex_portfolio_epoch_transitions
  ADD CONSTRAINT vertex_epoch_transition_replay_authorization_fk
  FOREIGN KEY(authorizing_signer_key_sha256,authorizing_approval_id,authorizing_replay_request_sha256)
  REFERENCES vertex_native_approval_audit(signer_key_sha256,approval_id,request_sha256)
  DEFERRABLE INITIALLY DEFERRED;
