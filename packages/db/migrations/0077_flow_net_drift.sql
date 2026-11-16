CREATE TABLE "flow_net_drift" (
	"filter_profile" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"net_call_premium" double precision NOT NULL,
	"net_call_volume" double precision NOT NULL,
	"net_put_premium" double precision NOT NULL,
	"net_put_volume" double precision NOT NULL,
	"part" text NOT NULL,
	"ticker" text NOT NULL,
	"underlying_price" double precision,
	CONSTRAINT "flow_net_drift_ticker_part_minute_pk" PRIMARY KEY("ticker","part","minute"),
	CONSTRAINT "flow_net_drift_check" CHECK ("flow_net_drift"."ticker" in ('SPY', 'SPX', 'QQQ', 'NDX') and "flow_net_drift"."part" in ('total', 'zero_dte') and length("flow_net_drift"."filter_profile") <= 40)
);
--> statement-breakpoint
ALTER TABLE "flow_book" DROP CONSTRAINT "flow_book_check";--> statement-breakpoint
ALTER TABLE "flow_events" DROP CONSTRAINT "flow_events_check";--> statement-breakpoint
ALTER TABLE "flow_gex" DROP CONSTRAINT "flow_gex_check";--> statement-breakpoint
ALTER TABLE "flow_minutes" DROP CONSTRAINT "flow_minutes_check";--> statement-breakpoint
ALTER TABLE "flow_option_gaps" DROP CONSTRAINT "flow_option_gaps_check";--> statement-breakpoint
ALTER TABLE "flow_option_prints" DROP CONSTRAINT "flow_option_prints_check";--> statement-breakpoint
ALTER TABLE "flow_samples" DROP CONSTRAINT "flow_samples_check";--> statement-breakpoint
ALTER TABLE "flow_book" ADD CONSTRAINT "flow_book_check" CHECK ("flow_book"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ'));--> statement-breakpoint
ALTER TABLE "flow_events" ADD CONSTRAINT "flow_events_check" CHECK ("flow_events"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_events"."direction" in ('bullish', 'bearish', 'neutral') and "flow_events"."source" in ('ibkr', 'quantdata') and length("flow_events"."detail") <= 300 and length("flow_events"."key") <= 160);--> statement-breakpoint
ALTER TABLE "flow_gex" ADD CONSTRAINT "flow_gex_check" CHECK ("flow_gex"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_gex"."ticker" in ('SPY', 'SPX', 'QQQ', 'NDX'));--> statement-breakpoint
ALTER TABLE "flow_minutes" ADD CONSTRAINT "flow_minutes_check" CHECK ("flow_minutes"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_minutes"."covered_seconds" between 0 and 60 and "flow_minutes"."volume" >= 0 and coalesce("flow_minutes"."absorption", 'buy') in ('buy', 'sell'));--> statement-breakpoint
ALTER TABLE "flow_option_gaps" ADD CONSTRAINT "flow_option_gaps_check" CHECK ("flow_option_gaps"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_option_gaps"."end_time" >= "flow_option_gaps"."start_time");--> statement-breakpoint
ALTER TABLE "flow_option_prints" ADD CONSTRAINT "flow_option_prints_check" CHECK ("flow_option_prints"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_option_prints"."ticker" in ('SPY', 'SPX', 'QQQ', 'NDX') and "flow_option_prints"."right" in ('call', 'put') and "flow_option_prints"."premium" >= 0 and length("flow_option_prints"."id") <= 64);--> statement-breakpoint
ALTER TABLE "flow_samples" ADD CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex', 'net_drift') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300);--> statement-breakpoint
-- App-role privileges, as in 0052_flow_pipeline: when an operator applies migrations as another role,
-- the app role "vertex_research" still gets the privileges the flow repository uses (flow.collect
-- upserts net drift buckets, flow.control reads them, prune deletes rows older than 730 days).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_net_drift" TO "vertex_research";
  END IF;
END
$$;
