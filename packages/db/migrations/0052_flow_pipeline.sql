CREATE TABLE "flow_book" (
	"ask_size" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"best_ask" double precision,
	"best_bid" double precision,
	"bid_size" double precision NOT NULL,
	"levels" integer NOT NULL,
	"pressure" double precision,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_book_symbol_at_pk" PRIMARY KEY("symbol","at"),
	CONSTRAINT "flow_book_check" CHECK ("flow_book"."symbol" in ('SPY', 'ES'))
);
--> statement-breakpoint
CREATE TABLE "flow_events" (
	"at" timestamp with time zone NOT NULL,
	"detail" text NOT NULL,
	"direction" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"premium" double precision,
	"price" double precision,
	"size" double precision,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_events_symbol_key_pk" PRIMARY KEY("symbol","key"),
	CONSTRAINT "flow_events_check" CHECK ("flow_events"."symbol" in ('SPY', 'ES') and "flow_events"."direction" in ('bullish', 'bearish', 'neutral') and "flow_events"."source" in ('ibkr', 'quantdata') and length("flow_events"."detail") <= 300 and length("flow_events"."key") <= 160)
);
--> statement-breakpoint
CREATE TABLE "flow_gex" (
	"at" timestamp with time zone NOT NULL,
	"basis" double precision,
	"call_wall" double precision,
	"flip" double precision,
	"iv_regime" text NOT NULL,
	"max_pain" double precision,
	"net_dex" double precision,
	"put_wall" double precision,
	"regime" text NOT NULL,
	"spot" double precision,
	"symbol" text NOT NULL,
	"ticker" text NOT NULL,
	"total_gex" double precision,
	"zero_dte_share" double precision,
	CONSTRAINT "flow_gex_symbol_at_pk" PRIMARY KEY("symbol","at"),
	CONSTRAINT "flow_gex_check" CHECK ("flow_gex"."symbol" in ('SPY', 'ES') and "flow_gex"."ticker" in ('SPY', 'SPX'))
);
--> statement-breakpoint
CREATE TABLE "flow_minutes" (
	"absorption" text,
	"buy_volume" double precision NOT NULL,
	"close" double precision NOT NULL,
	"covered_seconds" integer NOT NULL,
	"delta" double precision NOT NULL,
	"high" double precision NOT NULL,
	"large_print_volume" double precision NOT NULL,
	"large_prints" integer NOT NULL,
	"low" double precision NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"off_exchange_volume" double precision NOT NULL,
	"open" double precision NOT NULL,
	"sell_volume" double precision NOT NULL,
	"stacked_buy" integer NOT NULL,
	"stacked_sell" integer NOT NULL,
	"symbol" text NOT NULL,
	"trades" integer NOT NULL,
	"volume" double precision NOT NULL,
	"vwap" double precision NOT NULL,
	CONSTRAINT "flow_minutes_symbol_minute_pk" PRIMARY KEY("symbol","minute"),
	CONSTRAINT "flow_minutes_check" CHECK ("flow_minutes"."symbol" in ('SPY', 'ES') and "flow_minutes"."covered_seconds" between 0 and 60 and "flow_minutes"."volume" >= 0 and coalesce("flow_minutes"."absorption", 'buy') in ('buy', 'sell'))
);
--> statement-breakpoint
CREATE TABLE "flow_option_prints" (
	"ask" double precision,
	"bid" double precision,
	"consolidation" text NOT NULL,
	"dte" double precision,
	"expiry" date NOT NULL,
	"golden_sweep" boolean NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"iv" double precision,
	"moneyness" text NOT NULL,
	"moneyness_pct" double precision,
	"open_interest" double precision,
	"opening" boolean NOT NULL,
	"premium" double precision NOT NULL,
	"price" double precision,
	"right" text NOT NULL,
	"sentiment" text NOT NULL,
	"side" text NOT NULL,
	"size" integer NOT NULL,
	"strike" double precision NOT NULL,
	"symbol" text NOT NULL,
	"ticker" text NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"underlying_price" double precision,
	"unusual" boolean NOT NULL,
	"volume" double precision,
	"volume_over_oi" boolean NOT NULL,
	CONSTRAINT "flow_option_prints_check" CHECK ("flow_option_prints"."symbol" in ('SPY', 'ES') and "flow_option_prints"."ticker" in ('SPY', 'SPX') and "flow_option_prints"."right" in ('call', 'put') and "flow_option_prints"."premium" >= 0 and length("flow_option_prints"."id") <= 64)
);
--> statement-breakpoint
CREATE TABLE "flow_samples" (
	"at" timestamp with time zone NOT NULL,
	"items" integer NOT NULL,
	"message" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "flow_samples_symbol_source_at_pk" PRIMARY KEY("symbol","source","at"),
	CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300)
);
--> statement-breakpoint
CREATE INDEX "flow_events_symbol_time_idx" ON "flow_events" USING btree ("symbol","at");--> statement-breakpoint
CREATE INDEX "flow_option_prints_symbol_time_idx" ON "flow_option_prints" USING btree ("symbol","traded_at");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the flow repository uses (flow.collect
-- inserts and upserts samples, minutes, book snapshots, option prints, events and GEX snapshots and
-- deletes rows older than 14 days; flow.snapshot reads them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_samples", "flow_minutes", "flow_book", "flow_option_prints", "flow_events", "flow_gex" TO "vertex_research";
  END IF;
END
$$;
