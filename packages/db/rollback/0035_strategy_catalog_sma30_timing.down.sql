-- Guarded reversal of 0035_strategy_catalog_sma30_timing only.
-- Deletes the catalog row only while it was not edited, linked to a backtest or given a preset.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."strategies" s
    WHERE s."id" IN ('strategy-seed-sma30-market-timing')
      AND (
        s."updated_at" <> s."created_at"
        OR EXISTS (SELECT 1 FROM "public"."strategy_presets" p WHERE p."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."strategy_id" = s."id")
      )
  ) THEN
    RAISE EXCEPTION 'catalog strategy has operator edits, presets or backtests; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."strategies" WHERE "id" IN ('strategy-seed-sma30-market-timing');
COMMIT;
