-- Source only. Permanent native approval nonce history must never be erased.
BEGIN;
LOCK TABLE vertex_portfolio_epoch_transitions, vertex_native_approval_audit IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vertex_native_approval_audit LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing native approval audit rollback: consumed approval history must be retained';
  END IF;
  IF EXISTS (SELECT 1 FROM vertex_portfolio_epoch_transitions WHERE authorization_kind = 'retained-replay' LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing native approval audit rollback: retained epoch authorization history must be retained';
  END IF;
END;
$$;
ALTER TABLE vertex_portfolio_epoch_transitions DROP CONSTRAINT vertex_epoch_transition_replay_authorization_fk;
DROP TRIGGER vertex_native_approval_audit_no_truncate ON vertex_native_approval_audit;
DROP TRIGGER vertex_native_approval_audit_immutable ON vertex_native_approval_audit;
DROP TABLE vertex_native_approval_audit;
DROP FUNCTION vertex_reject_native_approval_audit_mutation();
COMMIT;
