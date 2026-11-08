-- Guarded reversal of 0058_market_daily_series only.
-- Refuses while any stored daily series or point exists so imported history is never silently
-- discarded. Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."market_daily_points", "public"."market_daily_series" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."market_daily_series")
    OR EXISTS (SELECT 1 FROM "public"."market_daily_points") THEN
    RAISE EXCEPTION 'market daily series tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."market_daily_points";
DROP TABLE "public"."market_daily_series";
COMMIT;
