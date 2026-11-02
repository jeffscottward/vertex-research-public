-- Guarded reversal of 0018_backtest_run_config only.
-- Refuses while any row carries run_config or benchmark data so reported data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."backtest_results" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."backtest_results" WHERE "run_config" IS NOT NULL OR "benchmark" IS NOT NULL) THEN
    RAISE EXCEPTION 'backtest_results has run_config or benchmark data; refusing rollback';
  END IF;
END
$$;
ALTER TABLE "public"."backtest_results" DROP CONSTRAINT "backtest_results_extras_check";
ALTER TABLE "public"."backtest_results" DROP COLUMN "benchmark";
ALTER TABLE "public"."backtest_results" DROP COLUMN "run_config";
COMMIT;
