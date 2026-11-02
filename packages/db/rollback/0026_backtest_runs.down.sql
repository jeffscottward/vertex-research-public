-- Guarded reversal of 0026_backtest_runs only.
-- Refuses while any backtest run exists so stored reports are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."backtest_runs" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."backtest_runs") THEN
    RAISE EXCEPTION 'backtest_runs is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."backtest_runs_strategy_idx";
DROP INDEX "public"."backtest_runs_created_idx";
DROP TABLE "public"."backtest_runs";
COMMIT;
