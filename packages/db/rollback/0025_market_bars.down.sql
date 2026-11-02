-- Guarded reversal of 0025_market_bars only.
-- Refuses while any stored bar series exists so imported history is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."market_bars", "public"."market_bar_series" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."market_bar_series")
    OR EXISTS (SELECT 1 FROM "public"."market_bars") THEN
    RAISE EXCEPTION 'market bar tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."market_bars";
DROP INDEX "public"."market_bar_series_symbol_timeframe_idx";
DROP TABLE "public"."market_bar_series";
COMMIT;
