-- Guarded reversal of 0017_backtest_results only.
-- Refuses while any backtest result exists so agent-reported data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."backtest_results" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."backtest_results") THEN
    RAISE EXCEPTION 'backtest_results is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."backtest_results_paper_idx";
DROP INDEX "public"."backtest_results_task_idx";
DROP INDEX "public"."backtest_results_created_idx";
DROP TABLE "public"."backtest_results";
COMMIT;
