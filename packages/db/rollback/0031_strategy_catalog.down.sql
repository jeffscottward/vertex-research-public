-- Guarded reversal of 0031_strategy_catalog only.
-- Deletes the catalog rows only while none was edited, linked to a backtest or given a preset.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."strategies" s
    WHERE s."id" IN ('strategy-seed-post-earnings-strength-radar', 'strategy-seed-quality-breakout-radar', 'strategy-seed-under-the-radar-breakouts', 'strategy-seed-insider-purchase-confirmation', 'strategy-seed-analyst-upgrade-clusters', 'strategy-seed-quality-compounders-on-pullback', 'strategy-seed-leader-pullback-and-reclaim', 'strategy-seed-200-day-comeback-watchlist', 'strategy-seed-dividend-growth-buy-zones', 'strategy-seed-sector-leadership-radar', 'strategy-seed-market-stress-alerts', 'strategy-seed-earnings-calendar-alerts', 'strategy-seed-nicholascrown-sox-macro-checklist', 'strategy-seed-bridgingcycles-short-strangle', 'strategy-seed-151-4-1-sector-momentum-rotation')
      AND (
        s."updated_at" <> s."created_at"
        OR EXISTS (SELECT 1 FROM "public"."strategy_presets" p WHERE p."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."strategy_id" = s."id")
      )
  ) THEN
    RAISE EXCEPTION 'catalog strategies have operator edits, presets or backtests; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."strategies" WHERE "id" IN ('strategy-seed-post-earnings-strength-radar', 'strategy-seed-quality-breakout-radar', 'strategy-seed-under-the-radar-breakouts', 'strategy-seed-insider-purchase-confirmation', 'strategy-seed-analyst-upgrade-clusters', 'strategy-seed-quality-compounders-on-pullback', 'strategy-seed-leader-pullback-and-reclaim', 'strategy-seed-200-day-comeback-watchlist', 'strategy-seed-dividend-growth-buy-zones', 'strategy-seed-sector-leadership-radar', 'strategy-seed-market-stress-alerts', 'strategy-seed-earnings-calendar-alerts', 'strategy-seed-nicholascrown-sox-macro-checklist', 'strategy-seed-bridgingcycles-short-strangle', 'strategy-seed-151-4-1-sector-momentum-rotation');
COMMIT;
