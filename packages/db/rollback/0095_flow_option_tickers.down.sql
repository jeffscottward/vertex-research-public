-- Guarded reversal of 0095_flow_option_tickers only. The normal rollback path is to deploy the
-- previous app, which runs cleanly against the widened CHECK constraints.
-- This down migration refuses to run while any row for added option-print tickers (IWM, NVDA)
-- exists in flow_option_prints, flow_option_gaps, flow_samples or flow_events.
-- No row deletes, truncation or cascading drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0095 row stays in drizzle.__drizzle_migrations.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
DO $$
DECLARE
  remaining bigint := 0;
BEGIN
  SELECT
    (SELECT count(*) FROM "public"."flow_option_prints" WHERE "symbol" in ('IWM', 'NVDA') OR "ticker" in ('IWM', 'NVDA'))
    + (SELECT count(*) FROM "public"."flow_option_gaps" WHERE "symbol" in ('IWM', 'NVDA'))
    + (SELECT count(*) FROM "public"."flow_samples" WHERE "symbol" in ('IWM', 'NVDA'))
    + (SELECT count(*) FROM "public"."flow_events" WHERE "symbol" in ('IWM', 'NVDA'))
  INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'cannot roll back 0095_flow_option_tickers while % rows exist for added option tickers (IWM, NVDA)', remaining;
  END IF;
END
$$;
ALTER TABLE "public"."flow_events" DROP CONSTRAINT "flow_events_check";
ALTER TABLE "public"."flow_events" ADD CONSTRAINT "flow_events_check" CHECK ("flow_events"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_events"."direction" in ('bullish', 'bearish', 'neutral') and "flow_events"."source" in ('ibkr', 'quantdata') and length("flow_events"."detail") <= 300 and length("flow_events"."key") <= 160);
ALTER TABLE "public"."flow_option_gaps" DROP CONSTRAINT "flow_option_gaps_check";
ALTER TABLE "public"."flow_option_gaps" ADD CONSTRAINT "flow_option_gaps_check" CHECK ("flow_option_gaps"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_option_gaps"."end_time" >= "flow_option_gaps"."start_time");
ALTER TABLE "public"."flow_option_prints" DROP CONSTRAINT "flow_option_prints_check";
ALTER TABLE "public"."flow_option_prints" ADD CONSTRAINT "flow_option_prints_check" CHECK ("flow_option_prints"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_option_prints"."ticker" in ('SPY', 'SPX', 'QQQ', 'NDX') and "flow_option_prints"."right" in ('call', 'put') and "flow_option_prints"."premium" >= 0 and length("flow_option_prints"."id") <= 64);
ALTER TABLE "public"."flow_samples" DROP CONSTRAINT "flow_samples_check";
ALTER TABLE "public"."flow_samples" ADD CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex', 'net_drift', 'market_premium') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300);
COMMIT;
