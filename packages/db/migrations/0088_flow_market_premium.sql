CREATE TABLE "flow_market_premium" (
	"bearish_premium" double precision NOT NULL,
	"bullish_premium" double precision NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"filter_profile" text NOT NULL,
	"premium" double precision NOT NULL,
	"session_date" date NOT NULL,
	"ticker" text NOT NULL,
	"trade_count" integer NOT NULL,
	"volume" bigint NOT NULL,
	CONSTRAINT "flow_market_premium_session_date_ticker_pk" PRIMARY KEY("session_date","ticker"),
	CONSTRAINT "flow_market_premium_check" CHECK ("flow_market_premium"."ticker" ~ '^[A-Z0-9.^=-]{1,16}$' and "flow_market_premium"."bullish_premium" >= 0 and "flow_market_premium"."bearish_premium" >= 0 and "flow_market_premium"."premium" >= 0 and "flow_market_premium"."trade_count" >= 0 and "flow_market_premium"."volume" >= 0 and length("flow_market_premium"."filter_profile") <= 40)
);
--> statement-breakpoint
CREATE TABLE "flow_market_premium_sessions" (
	"attempts" integer NOT NULL,
	"captured_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_message" text NOT NULL,
	"session_date" date PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"tickers" integer NOT NULL,
	CONSTRAINT "flow_market_premium_sessions_check" CHECK ("flow_market_premium_sessions"."status" in ('complete', 'partial', 'no_data', 'unavailable') and "flow_market_premium_sessions"."attempts" >= 1 and "flow_market_premium_sessions"."tickers" >= 0 and length("flow_market_premium_sessions"."last_message") <= 300 and ("flow_market_premium_sessions"."captured_at" is not null) = ("flow_market_premium_sessions"."status" in ('complete', 'partial')))
);
--> statement-breakpoint
ALTER TABLE "flow_samples" DROP CONSTRAINT "flow_samples_check";--> statement-breakpoint
ALTER TABLE "flow_samples" ADD CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex', 'net_drift', 'market_premium') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300);--> statement-breakpoint
-- App-role privileges, as in 0052_flow_pipeline: when an operator applies migrations as another role,
-- the app role "vertex_research" still gets the privileges the flow repository uses (flow.collect
-- upserts rows and ledger rows and deletes the rows of older captures of a session;
-- smartMoney.ranking reads both tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_market_premium" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "flow_market_premium_sessions" TO "vertex_research";
  END IF;
END
$$;
