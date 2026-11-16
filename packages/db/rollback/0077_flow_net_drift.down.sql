-- Guarded reversal of 0077_flow_net_drift only. This file is not the rollback path: the rollback is
-- "deploy the previous app", which runs on the migrated database (the wider checks and the new
-- table do not affect it).
-- Before this file runs, a person must delete the rows with symbol QQQ or NQ from the seven flow
-- tables and the net_drift rows from flow_samples; else the narrower checks fail and the
-- transaction rolls back. Dropping flow_net_drift loses the stored net drift series for good.
-- No cascading drops, truncation or row deletes. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0077 row stays in drizzle.__drizzle_migrations.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
ALTER TABLE "public"."flow_book" DROP CONSTRAINT "flow_book_check";
ALTER TABLE "public"."flow_book" ADD CONSTRAINT "flow_book_check" CHECK ("flow_book"."symbol" in ('SPY', 'ES'));
ALTER TABLE "public"."flow_events" DROP CONSTRAINT "flow_events_check";
ALTER TABLE "public"."flow_events" ADD CONSTRAINT "flow_events_check" CHECK ("flow_events"."symbol" in ('SPY', 'ES') and "flow_events"."direction" in ('bullish', 'bearish', 'neutral') and "flow_events"."source" in ('ibkr', 'quantdata') and length("flow_events"."detail") <= 300 and length("flow_events"."key") <= 160);
ALTER TABLE "public"."flow_gex" DROP CONSTRAINT "flow_gex_check";
ALTER TABLE "public"."flow_gex" ADD CONSTRAINT "flow_gex_check" CHECK ("flow_gex"."symbol" in ('SPY', 'ES') and "flow_gex"."ticker" in ('SPY', 'SPX'));
ALTER TABLE "public"."flow_minutes" DROP CONSTRAINT "flow_minutes_check";
ALTER TABLE "public"."flow_minutes" ADD CONSTRAINT "flow_minutes_check" CHECK ("flow_minutes"."symbol" in ('SPY', 'ES') and "flow_minutes"."covered_seconds" between 0 and 60 and "flow_minutes"."volume" >= 0 and coalesce("flow_minutes"."absorption", 'buy') in ('buy', 'sell'));
ALTER TABLE "public"."flow_option_gaps" DROP CONSTRAINT "flow_option_gaps_check";
ALTER TABLE "public"."flow_option_gaps" ADD CONSTRAINT "flow_option_gaps_check" CHECK ("flow_option_gaps"."symbol" in ('SPY', 'ES') and "flow_option_gaps"."end_time" >= "flow_option_gaps"."start_time");
ALTER TABLE "public"."flow_option_prints" DROP CONSTRAINT "flow_option_prints_check";
ALTER TABLE "public"."flow_option_prints" ADD CONSTRAINT "flow_option_prints_check" CHECK ("flow_option_prints"."symbol" in ('SPY', 'ES') and "flow_option_prints"."ticker" in ('SPY', 'SPX') and "flow_option_prints"."right" in ('call', 'put') and "flow_option_prints"."premium" >= 0 and length("flow_option_prints"."id") <= 64);
ALTER TABLE "public"."flow_samples" DROP CONSTRAINT "flow_samples_check";
ALTER TABLE "public"."flow_samples" ADD CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300);
LOCK TABLE "public"."flow_net_drift" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_net_drift";
COMMIT;
