-- Source only. Operator-approved empty-schema reversal; never evidence cleanup.
-- Keep the original order stream and shared heads intact. Any native proof or
-- observation blocks reversal, including unresolved gaps and expired history.
BEGIN;
LOCK TABLE vertex_native_journal_proofs, vertex_native_fact_projections,
  vertex_native_checkpoints, vertex_native_settlements, vertex_native_settlement_sources,
  vertex_native_corporate_actions, vertex_native_reconciliations,
  vertex_native_kill_states, vertex_native_kill_reasons IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE
  table_name text;
  has_rows boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'vertex_native_journal_proofs', 'vertex_native_fact_projections',
    'vertex_native_checkpoints', 'vertex_native_settlements', 'vertex_native_settlement_sources',
    'vertex_native_corporate_actions', 'vertex_native_reconciliations',
    'vertex_native_kill_states', 'vertex_native_kill_reasons'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', table_name) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'Refusing native fact rollback: immutable observations must be retained';
    END IF;
  END LOOP;
END $$;
DROP TABLE vertex_native_kill_reasons;
DROP TABLE vertex_native_kill_states;
DROP TABLE vertex_native_reconciliations;
DROP TABLE vertex_native_corporate_actions;
DROP TABLE vertex_native_settlement_sources;
DROP TABLE vertex_native_settlements;
DROP TABLE vertex_native_checkpoints;
DROP TABLE vertex_native_fact_projections;
DROP TABLE vertex_native_journal_proofs;
COMMIT;
