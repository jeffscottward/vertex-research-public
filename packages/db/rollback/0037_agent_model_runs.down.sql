-- Guarded reversal of 0037_agent_model_runs only.
-- Order: when 0038_agent_model_run_events is applied, run its rollback first (its foreign key
-- references this table).
-- Refuses while any model run exists so recorded runs are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."agent_model_runs" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."agent_model_runs") THEN
    RAISE EXCEPTION 'agent_model_runs is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."agent_model_runs";
COMMIT;
