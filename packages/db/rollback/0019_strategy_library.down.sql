-- Guarded reversal of 0019_strategy_library only.
-- Refuses while operator data exists: any preset, any backtest linked to a strategy, any strategy
-- that is not one of the eleven 0019 seed rows, or any seed row edited since it was seeded
-- (updated_at <> created_at). Unedited seed rows are the only rows it discards.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."backtest_results", "public"."strategy_presets", "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."strategy_presets") THEN
    RAISE EXCEPTION 'strategy_presets is not empty; refusing rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."backtest_results" WHERE "strategy_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'backtest_results has strategy links; refusing rollback';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."strategies"
    WHERE "id" NOT IN (
      'strategy-seed-hmm', 'strategy-seed-jump', 'strategy-seed-composite', 'strategy-seed-macro',
      'strategy-seed-quant', 'strategy-seed-swing', 'strategy-seed-wheel', 'strategy-seed-zero-dte',
      'strategy-seed-options-payoff', 'strategy-seed-fundamental', 'strategy-seed-paper-lab'
    ) OR "updated_at" <> "created_at"
  ) THEN
    RAISE EXCEPTION 'strategies has operator-created or edited rows; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."backtest_results_strategy_idx";
ALTER TABLE "public"."backtest_results" DROP CONSTRAINT "backtest_results_strategy_id_strategies_id_fk";
ALTER TABLE "public"."backtest_results" DROP COLUMN "strategy_id";
DROP INDEX "public"."strategy_presets_strategy_name_unique_idx";
DROP TABLE "public"."strategy_presets";
DROP INDEX "public"."strategies_section_idx";
DROP INDEX "public"."strategies_updated_idx";
DROP INDEX "public"."strategies_slug_unique_idx";
DROP TABLE "public"."strategies";
COMMIT;
