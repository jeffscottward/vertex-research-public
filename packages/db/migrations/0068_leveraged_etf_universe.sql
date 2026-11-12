CREATE TABLE "leveraged_etf_universe" (
	"symbol" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"product_type" text NOT NULL,
	"leverage" numeric(4, 2) NOT NULL,
	"underlying" text,
	"listing_exchange" text NOT NULL,
	"options_listed" boolean NOT NULL,
	"quoted_at" timestamp with time zone,
	"quote_session" text,
	"spot" numeric,
	"nearest_expiries" jsonb NOT NULL,
	"window_expiry" date,
	"total_open_interest" integer,
	"band_open_interest" integer,
	"half_spread_pct" numeric,
	"option_gate" text NOT NULL,
	"option_gate_reasons" jsonb NOT NULL,
	"gate_version" integer NOT NULL,
	"gate_min_band_open_interest" integer NOT NULL,
	"gate_max_half_spread_pct" numeric NOT NULL,
	"gate_min_window_days" integer NOT NULL,
	"gate_max_window_days" integer NOT NULL,
	"gate_band_pct" numeric NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leveraged_etf_universe_fund_check" CHECK ("leveraged_etf_universe"."symbol" ~ '^[A-Z][A-Z0-9.]{0,9}$' and char_length("leveraged_etf_universe"."name") between 1 and 200 and "leveraged_etf_universe"."product_type" in ('etf', 'etn') and "leveraged_etf_universe"."leverage" between -5 and 5 and "leveraged_etf_universe"."leverage" not in (0, 1) and ("leveraged_etf_universe"."underlying" is null or char_length("leveraged_etf_universe"."underlying") between 1 and 20) and char_length("leveraged_etf_universe"."listing_exchange") between 1 and 20),
	CONSTRAINT "leveraged_etf_universe_options_check" CHECK (case when jsonb_typeof("leveraged_etf_universe"."nearest_expiries") <> 'array' then false when "leveraged_etf_universe"."options_listed" then "leveraged_etf_universe"."quoted_at" is not null and "leveraged_etf_universe"."quote_session" is not null and "leveraged_etf_universe"."quote_session" in ('regular', 'closed') and "leveraged_etf_universe"."spot" is not null and "leveraged_etf_universe"."spot" > 0 and "leveraged_etf_universe"."total_open_interest" is not null and "leveraged_etf_universe"."total_open_interest" >= 0 and jsonb_array_length("leveraged_etf_universe"."nearest_expiries") between 1 and 4 and ("leveraged_etf_universe"."window_expiry" is null) = ("leveraged_etf_universe"."band_open_interest" is null) and ("leveraged_etf_universe"."band_open_interest" is null or "leveraged_etf_universe"."band_open_interest" >= 0) and ("leveraged_etf_universe"."half_spread_pct" is null or ("leveraged_etf_universe"."window_expiry" is not null and "leveraged_etf_universe"."half_spread_pct" between 0 and 100)) else "leveraged_etf_universe"."quoted_at" is null and "leveraged_etf_universe"."quote_session" is null and "leveraged_etf_universe"."spot" is null and "leveraged_etf_universe"."window_expiry" is null and "leveraged_etf_universe"."total_open_interest" is null and "leveraged_etf_universe"."band_open_interest" is null and "leveraged_etf_universe"."half_spread_pct" is null and jsonb_array_length("leveraged_etf_universe"."nearest_expiries") = 0 end),
	CONSTRAINT "leveraged_etf_universe_gate_check" CHECK ("leveraged_etf_universe"."gate_version" >= 1 and "leveraged_etf_universe"."gate_min_band_open_interest" >= 0 and "leveraged_etf_universe"."gate_max_half_spread_pct" > 0 and "leveraged_etf_universe"."gate_min_window_days" >= 0 and "leveraged_etf_universe"."gate_max_window_days" >= "leveraged_etf_universe"."gate_min_window_days" and "leveraged_etf_universe"."gate_band_pct" > 0 and case when jsonb_typeof("leveraged_etf_universe"."option_gate_reasons") <> 'array' then false when "leveraged_etf_universe"."option_gate" = 'pass' then "leveraged_etf_universe"."options_listed" and "leveraged_etf_universe"."quote_session" = 'regular' and "leveraged_etf_universe"."option_gate_reasons" = '[]'::jsonb when "leveraged_etf_universe"."option_gate" = 'spread-not-measured' then "leveraged_etf_universe"."options_listed" and "leveraged_etf_universe"."quote_session" = 'closed' and "leveraged_etf_universe"."option_gate_reasons" = '["market-closed-at-quote"]'::jsonb when "leveraged_etf_universe"."option_gate" = 'fail' then jsonb_array_length("leveraged_etf_universe"."option_gate_reasons") >= 1 else false end)
);
--> statement-breakpoint
CREATE INDEX "leveraged_etf_universe_option_gate_idx" ON "leveraged_etf_universe" USING btree ("option_gate");--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: when an operator applies migrations as another
-- role, the app role "vertex_research" still gets the privileges the leveraged ETF universe
-- repository uses (replaceUniverse, which `bun run vertex:leveraged-etf-universe:import` calls:
-- select for the newest generated_at, insert and update for the upsert, delete for funds that left
-- the universe). The read-only role "vertex_semantic_reader" gets nothing here: it reads only the
-- tables of certified semantic terms (0056_semantic_layer), and no term reads this table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "leveraged_etf_universe" TO "vertex_research";
  END IF;
END
$$;
