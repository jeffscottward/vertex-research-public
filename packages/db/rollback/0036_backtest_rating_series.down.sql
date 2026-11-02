-- Guarded reversal of 0036_backtest_rating_series only.
-- Refuses while any row carries a rating series so reported data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."backtest_results" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."backtest_results" WHERE "rating_series" IS NOT NULL) THEN
    RAISE EXCEPTION 'backtest_results has rating_series data; refusing rollback';
  END IF;
END
$$;
ALTER TABLE "public"."backtest_results" DROP CONSTRAINT "backtest_results_rating_series_check";
ALTER TABLE "public"."backtest_results" DROP COLUMN "rating_series";
COMMIT;
