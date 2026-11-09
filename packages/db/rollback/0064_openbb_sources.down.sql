-- Guarded reversal of 0064_openbb_sources only.
-- Refuses while any OpenBB table holds a row so fetched history is never silently discarded.
-- The UPDATE grant on the market daily series tables is revoked again (0060 granted none).
-- Vol index points written into market_daily_points by openbb.ingest stay (0060 owns them).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_ingest_runs", "public"."openbb_vx_curve",
  "public"."openbb_option_iv_daily", "public"."openbb_option_iv_term",
  "public"."openbb_cot_positions", "public"."openbb_macro_points", "public"."openbb_macro_series",
  "public"."openbb_event_calendar", "public"."openbb_finra_otc_weekly",
  "public"."openbb_short_interest", "public"."openbb_short_volume_daily",
  "public"."openbb_sec_filings", "public"."openbb_sec_insider_trades", "public"."openbb_sec_ftd",
  "public"."openbb_sec_13f_holdings", "public"."openbb_factor_returns" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."openbb_ingest_runs")
    OR EXISTS (SELECT 1 FROM "public"."openbb_vx_curve")
    OR EXISTS (SELECT 1 FROM "public"."openbb_option_iv_daily")
    OR EXISTS (SELECT 1 FROM "public"."openbb_option_iv_term")
    OR EXISTS (SELECT 1 FROM "public"."openbb_cot_positions")
    OR EXISTS (SELECT 1 FROM "public"."openbb_macro_points")
    OR EXISTS (SELECT 1 FROM "public"."openbb_macro_series")
    OR EXISTS (SELECT 1 FROM "public"."openbb_event_calendar")
    OR EXISTS (SELECT 1 FROM "public"."openbb_finra_otc_weekly")
    OR EXISTS (SELECT 1 FROM "public"."openbb_short_interest")
    OR EXISTS (SELECT 1 FROM "public"."openbb_short_volume_daily")
    OR EXISTS (SELECT 1 FROM "public"."openbb_sec_filings")
    OR EXISTS (SELECT 1 FROM "public"."openbb_sec_insider_trades")
    OR EXISTS (SELECT 1 FROM "public"."openbb_sec_ftd")
    OR EXISTS (SELECT 1 FROM "public"."openbb_sec_13f_holdings")
    OR EXISTS (SELECT 1 FROM "public"."openbb_factor_returns") THEN
    RAISE EXCEPTION 'openbb tables are not empty; refusing rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    REVOKE UPDATE ON TABLE "public"."market_daily_series", "public"."market_daily_points" FROM "vertex_research";
  END IF;
END
$$;
DROP TABLE "public"."openbb_macro_points";
DROP TABLE "public"."openbb_macro_series";
DROP TABLE "public"."openbb_ingest_runs";
DROP TABLE "public"."openbb_vx_curve";
DROP TABLE "public"."openbb_option_iv_daily";
DROP TABLE "public"."openbb_option_iv_term";
DROP TABLE "public"."openbb_cot_positions";
DROP TABLE "public"."openbb_event_calendar";
DROP TABLE "public"."openbb_finra_otc_weekly";
DROP TABLE "public"."openbb_short_interest";
DROP TABLE "public"."openbb_short_volume_daily";
DROP TABLE "public"."openbb_sec_filings";
DROP TABLE "public"."openbb_sec_insider_trades";
DROP TABLE "public"."openbb_sec_ftd";
DROP TABLE "public"."openbb_sec_13f_holdings";
DROP TABLE "public"."openbb_factor_returns";
COMMIT;
