-- Guarded reversal of 0095_strategy_catalog_smart_money_backtests only.
-- Deletes the two newly inserted smart-money catalog rows and restores the original 0031
-- insider-purchase-confirmation columns only while none of the three rows was edited and no
-- preset, spec, backtest, backtest run, optimization run, deployment request or Autopilot
-- candidate references any of them (no silent SET NULL).
-- The backtest studies in research_studies (ids insider-purchase-confirmation,
-- smart-money-congress-buys, smart-money-large-bullish-premium) are kept; delete them
-- separately if desired.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."strategies" s
    WHERE s."id" IN (
      'strategy-seed-insider-purchase-confirmation',
      'strategy-seed-smart-money-congress-buys',
      'strategy-seed-smart-money-large-bullish-premium'
    )
      AND (
        s."updated_at" <> s."created_at"
        OR EXISTS (SELECT 1 FROM "public"."strategy_presets" p WHERE p."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_runs" r WHERE r."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."optimization_runs" o WHERE o."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."strategy_specs" q WHERE q."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."deployment_requests" d WHERE d."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."autopilot_candidates" a WHERE a."strategy_id" = s."id")
      )
  ) THEN
    RAISE EXCEPTION 'catalog strategy has operator edits or linked rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."strategies"
WHERE "id" IN (
  'strategy-seed-smart-money-congress-buys',
  'strategy-seed-smart-money-large-bullish-premium'
);
UPDATE "public"."strategies"
SET
  "status" = 'researching',
  "source_ref" = 'services/research/strategies/alert_templates.py',
  "description" = 'Open-market Form 4 purchases (code P) of $100k+ by directors or senior officers in the last 30 days, price above the 50-day average. Alert after the close: a close above the highest close since the purchase, or within 3% of it on 1.5x volume. 14-day cooldown. Backtest not run: needs an insider-trade data source. Spec: docs/specs/strategies/insider-purchase-confirmation.md. Rules restated from https://freestockalerts.ai/templates/insider-purchase-confirmation. Research only.',
  "tags" = '["freestockalerts","alerts","daily","insider","needs-data"]'::jsonb
WHERE "id" = 'strategy-seed-insider-purchase-confirmation'
  AND "slug" = 'insider-purchase-confirmation';
COMMIT;
