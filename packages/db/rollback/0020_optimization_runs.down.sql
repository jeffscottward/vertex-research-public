-- Guarded reversal of 0020_optimization_runs only.
-- Refuses while any optimization run exists so agent-reported data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."optimization_runs" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."optimization_runs") THEN
    RAISE EXCEPTION 'optimization_runs is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."optimization_runs_strategy_idx";
DROP INDEX "public"."optimization_runs_task_idx";
DROP INDEX "public"."optimization_runs_created_idx";
DROP TABLE "public"."optimization_runs";
COMMIT;
