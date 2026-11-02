-- Guarded reversal of 0038_agent_model_run_events only.
-- Refuses while any run event exists so recorded events are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."agent_model_run_events" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."agent_model_run_events") THEN
    RAISE EXCEPTION 'agent_model_run_events is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."agent_model_run_events";
COMMIT;
