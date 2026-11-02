-- Source only, explicit operator-approved EMPTY-schema reversal.
-- Never rewind heads, drop restored checkpoints, or delete old native history.
BEGIN;
LOCK TABLE vertex_portfolio_epoch_transitions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vertex_portfolio_epoch_transitions LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing epoch transition rollback: immutable transition lineage must be retained';
  END IF;
END;
$$;
DROP TRIGGER vertex_epoch_transition_no_truncate ON vertex_portfolio_epoch_transitions;
DROP TRIGGER vertex_epoch_transition_immutable ON vertex_portfolio_epoch_transitions;
DROP TABLE vertex_portfolio_epoch_transitions;
DROP FUNCTION vertex_reject_epoch_transition_mutation();
COMMIT;
