-- OpenBB data sources (card vertex-openbb, docs/vertex-rebuild/openbb.md): Cboe vol curve and option
-- IV summaries, CFTC COT, Fed/Treasury/OECD/FRED macro points, event calendar, FINRA and SEC data,
-- Fama-French factors. Written only through oRPC openbb.ingest (upsert by primary key) from
-- `bun run vertex:openbb:tick`. Research input only; nothing here places orders.
CREATE TABLE "openbb_cot_positions" (
	"category" text NOT NULL,
	"long" bigint NOT NULL,
	"market" text NOT NULL,
	"market_code" text NOT NULL,
	"open_interest" bigint NOT NULL,
	"report_date" date NOT NULL,
	"report_type" text NOT NULL,
	"short" bigint NOT NULL,
	"spreading" bigint,
	CONSTRAINT "openbb_cot_positions_report_date_market_code_category_pk" PRIMARY KEY("report_date","market_code","category"),
	CONSTRAINT "openbb_cot_positions_check" CHECK ("openbb_cot_positions"."market_code" ~ '^[0-9A-Z]{1,12}$' and "openbb_cot_positions"."market" ~ '^[A-Z0-9]{1,8}$' and "openbb_cot_positions"."category" in ('dealer', 'asset_manager', 'leveraged_funds', 'producer_merchant', 'swap_dealer', 'managed_money', 'other_reportables', 'nonreportable') and "openbb_cot_positions"."report_type" in ('tff', 'disaggregated') and ("openbb_cot_positions"."long" is null or "openbb_cot_positions"."long" >= 0) and ("openbb_cot_positions"."short" is null or "openbb_cot_positions"."short" >= 0) and ("openbb_cot_positions"."spreading" is null or "openbb_cot_positions"."spreading" >= 0) and ("openbb_cot_positions"."open_interest" is null or "openbb_cot_positions"."open_interest" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_event_calendar" (
	"date" date NOT NULL,
	"detail" text,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"time" text,
	"title" text NOT NULL,
	CONSTRAINT "openbb_event_calendar_source_event_key_pk" PRIMARY KEY("source","event_key"),
	CONSTRAINT "openbb_event_calendar_check" CHECK (("openbb_event_calendar"."source" is null or char_length(trim("openbb_event_calendar"."source")) between 1 and 80) and ("openbb_event_calendar"."event_key" is null or char_length(trim("openbb_event_calendar"."event_key")) between 1 and 200) and ("openbb_event_calendar"."time" is null or "openbb_event_calendar"."time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and "openbb_event_calendar"."kind" ~ '^[a-z0-9_]{1,40}$' and ("openbb_event_calendar"."title" is null or char_length(trim("openbb_event_calendar"."title")) between 1 and 300) and ("openbb_event_calendar"."detail" is null or char_length("openbb_event_calendar"."detail") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "openbb_factor_returns" (
	"date" date NOT NULL,
	"factor" text NOT NULL,
	"frequency" text NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "openbb_factor_returns_date_frequency_factor_pk" PRIMARY KEY("date","frequency","factor"),
	CONSTRAINT "openbb_factor_returns_check" CHECK ("openbb_factor_returns"."frequency" in ('daily', 'monthly') and "openbb_factor_returns"."factor" in ('mkt_rf', 'smb', 'hml', 'rmw', 'cma', 'rf', 'mom') and ("openbb_factor_returns"."value" is null or ("openbb_factor_returns"."value" > '-Infinity'::float8 and "openbb_factor_returns"."value" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE TABLE "openbb_finra_otc_weekly" (
	"last_updated" date,
	"shares" bigint NOT NULL,
	"symbol" text NOT NULL,
	"tier" text NOT NULL,
	"trades" bigint NOT NULL,
	"venue" text NOT NULL,
	"week_start" date NOT NULL,
	CONSTRAINT "openbb_finra_otc_weekly_week_start_symbol_venue_pk" PRIMARY KEY("week_start","symbol","venue"),
	CONSTRAINT "openbb_finra_otc_weekly_check" CHECK ("openbb_finra_otc_weekly"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and "openbb_finra_otc_weekly"."venue" in ('ats', 'non_ats') and ("openbb_finra_otc_weekly"."tier" is null or char_length(trim("openbb_finra_otc_weekly"."tier")) between 1 and 20) and ("openbb_finra_otc_weekly"."shares" is null or "openbb_finra_otc_weekly"."shares" >= 0) and ("openbb_finra_otc_weekly"."trades" is null or "openbb_finra_otc_weekly"."trades" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_ingest_runs" (
	"error" text,
	"finished_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"openbb_version" text,
	"rows_received" integer NOT NULL,
	"rows_written" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "openbb_ingest_runs_check" CHECK ("openbb_ingest_runs"."job" ~ '^[a-z0-9-]{1,40}$' and "openbb_ingest_runs"."status" in ('ok', 'partial', 'failed') and "openbb_ingest_runs"."rows_received" >= 0 and "openbb_ingest_runs"."rows_written" >= 0 and "openbb_ingest_runs"."finished_at" >= "openbb_ingest_runs"."started_at" and ("openbb_ingest_runs"."error" is null or char_length("openbb_ingest_runs"."error") <= 4000) and ("openbb_ingest_runs"."openbb_version" is null or char_length(trim("openbb_ingest_runs"."openbb_version")) between 1 and 40))
);
--> statement-breakpoint
CREATE TABLE "openbb_macro_points" (
	"date" date NOT NULL,
	"series_id" text NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "openbb_macro_points_series_id_date_pk" PRIMARY KEY("series_id","date"),
	CONSTRAINT "openbb_macro_points_check" CHECK (("openbb_macro_points"."value" is null or ("openbb_macro_points"."value" > '-Infinity'::float8 and "openbb_macro_points"."value" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE TABLE "openbb_macro_series" (
	"first_date" date NOT NULL,
	"frequency" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"last_date" date NOT NULL,
	"name" text NOT NULL,
	"point_count" integer NOT NULL,
	"source" text NOT NULL,
	"unit" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openbb_macro_series_check" CHECK ("openbb_macro_series"."id" ~ '^[A-Z0-9_]{1,40}$' and ("openbb_macro_series"."source" is null or char_length(trim("openbb_macro_series"."source")) between 1 and 80) and ("openbb_macro_series"."name" is null or char_length(trim("openbb_macro_series"."name")) between 1 and 200) and ("openbb_macro_series"."unit" is null or char_length(trim("openbb_macro_series"."unit")) between 1 and 40) and ("openbb_macro_series"."frequency" is null or char_length(trim("openbb_macro_series"."frequency")) between 1 and 20) and "openbb_macro_series"."point_count" >= 1 and "openbb_macro_series"."first_date" <= "openbb_macro_series"."last_date")
);
--> statement-breakpoint
CREATE TABLE "openbb_option_iv_daily" (
	"as_of" date NOT NULL,
	"atm_iv_30d" double precision,
	"call_iv_25d_30d" double precision,
	"call_oi" bigint NOT NULL,
	"call_volume" bigint NOT NULL,
	"call_wall" double precision,
	"contracts" integer NOT NULL,
	"gamma_flip" double precision,
	"net_gex" double precision,
	"put_iv_25d_30d" double precision,
	"put_oi" bigint NOT NULL,
	"put_volume" bigint NOT NULL,
	"put_wall" double precision,
	"underlying" text NOT NULL,
	"underlying_price" double precision NOT NULL,
	CONSTRAINT "openbb_option_iv_daily_as_of_underlying_pk" PRIMARY KEY("as_of","underlying"),
	CONSTRAINT "openbb_option_iv_daily_check" CHECK ("openbb_option_iv_daily"."underlying" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_option_iv_daily"."underlying_price" is null or ("openbb_option_iv_daily"."underlying_price" > '-Infinity'::float8 and "openbb_option_iv_daily"."underlying_price" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."atm_iv_30d" is null or ("openbb_option_iv_daily"."atm_iv_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."atm_iv_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."put_iv_25d_30d" is null or ("openbb_option_iv_daily"."put_iv_25d_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."put_iv_25d_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_iv_25d_30d" is null or ("openbb_option_iv_daily"."call_iv_25d_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."call_iv_25d_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."net_gex" is null or ("openbb_option_iv_daily"."net_gex" > '-Infinity'::float8 and "openbb_option_iv_daily"."net_gex" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."gamma_flip" is null or ("openbb_option_iv_daily"."gamma_flip" > '-Infinity'::float8 and "openbb_option_iv_daily"."gamma_flip" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_wall" is null or ("openbb_option_iv_daily"."call_wall" > '-Infinity'::float8 and "openbb_option_iv_daily"."call_wall" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."put_wall" is null or ("openbb_option_iv_daily"."put_wall" > '-Infinity'::float8 and "openbb_option_iv_daily"."put_wall" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_oi" is null or "openbb_option_iv_daily"."call_oi" >= 0) and ("openbb_option_iv_daily"."put_oi" is null or "openbb_option_iv_daily"."put_oi" >= 0) and ("openbb_option_iv_daily"."call_volume" is null or "openbb_option_iv_daily"."call_volume" >= 0) and ("openbb_option_iv_daily"."put_volume" is null or "openbb_option_iv_daily"."put_volume" >= 0) and ("openbb_option_iv_daily"."contracts" is null or "openbb_option_iv_daily"."contracts" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_option_iv_term" (
	"as_of" date NOT NULL,
	"atm_iv" double precision,
	"atm_strike" double precision,
	"call_oi" bigint NOT NULL,
	"call_volume" bigint NOT NULL,
	"dte" integer NOT NULL,
	"expiration" date NOT NULL,
	"put_oi" bigint NOT NULL,
	"put_volume" bigint NOT NULL,
	"underlying" text NOT NULL,
	CONSTRAINT "openbb_option_iv_term_as_of_underlying_expiration_pk" PRIMARY KEY("as_of","underlying","expiration"),
	CONSTRAINT "openbb_option_iv_term_check" CHECK ("openbb_option_iv_term"."underlying" ~ '^[A-Z0-9.^=-]{1,16}$' and "openbb_option_iv_term"."expiration" >= "openbb_option_iv_term"."as_of" and ("openbb_option_iv_term"."dte" is null or "openbb_option_iv_term"."dte" >= 0) and ("openbb_option_iv_term"."atm_strike" is null or ("openbb_option_iv_term"."atm_strike" > '-Infinity'::float8 and "openbb_option_iv_term"."atm_strike" < 'Infinity'::float8)) and ("openbb_option_iv_term"."atm_iv" is null or ("openbb_option_iv_term"."atm_iv" > '-Infinity'::float8 and "openbb_option_iv_term"."atm_iv" < 'Infinity'::float8)) and ("openbb_option_iv_term"."call_oi" is null or "openbb_option_iv_term"."call_oi" >= 0) and ("openbb_option_iv_term"."put_oi" is null or "openbb_option_iv_term"."put_oi" >= 0) and ("openbb_option_iv_term"."call_volume" is null or "openbb_option_iv_term"."call_volume" >= 0) and ("openbb_option_iv_term"."put_volume" is null or "openbb_option_iv_term"."put_volume" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_13f_holdings" (
	"asset_class" text,
	"cusip" text NOT NULL,
	"filer_cik" text NOT NULL,
	"filer_name" text NOT NULL,
	"issuer" text NOT NULL,
	"option_type" text NOT NULL,
	"period_ending" date NOT NULL,
	"shares" bigint,
	"symbol" text,
	"value" double precision NOT NULL,
	"weight" double precision,
	CONSTRAINT "openbb_sec_13f_holdings_filer_cik_period_ending_cusip_option_type_pk" PRIMARY KEY("filer_cik","period_ending","cusip","option_type"),
	CONSTRAINT "openbb_sec_13f_holdings_check" CHECK ("openbb_sec_13f_holdings"."filer_cik" ~ '^[0-9]{1,10}$' and "openbb_sec_13f_holdings"."cusip" ~ '^[0-9A-Z]{9}$' and "openbb_sec_13f_holdings"."option_type" in ('put', 'call', '') and ("openbb_sec_13f_holdings"."symbol" is null or "openbb_sec_13f_holdings"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$') and ("openbb_sec_13f_holdings"."filer_name" is null or char_length(trim("openbb_sec_13f_holdings"."filer_name")) between 1 and 200) and ("openbb_sec_13f_holdings"."issuer" is null or char_length(trim("openbb_sec_13f_holdings"."issuer")) between 1 and 200) and ("openbb_sec_13f_holdings"."asset_class" is null or char_length(trim("openbb_sec_13f_holdings"."asset_class")) between 1 and 40) and ("openbb_sec_13f_holdings"."shares" is null or "openbb_sec_13f_holdings"."shares" >= 0) and ("openbb_sec_13f_holdings"."value" is null or ("openbb_sec_13f_holdings"."value" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."value" < 'Infinity'::float8)) and ("openbb_sec_13f_holdings"."weight" is null or ("openbb_sec_13f_holdings"."weight" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."weight" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_filings" (
	"accession_number" text NOT NULL,
	"cik" text NOT NULL,
	"description" text NOT NULL,
	"filing_date" date NOT NULL,
	"form_type" text NOT NULL,
	"report_date" date,
	"symbol" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "openbb_sec_filings_accession_number_symbol_pk" PRIMARY KEY("accession_number","symbol"),
	CONSTRAINT "openbb_sec_filings_check" CHECK ("openbb_sec_filings"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and "openbb_sec_filings"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and "openbb_sec_filings"."cik" ~ '^[0-9]{1,10}$' and ("openbb_sec_filings"."form_type" is null or char_length(trim("openbb_sec_filings"."form_type")) between 1 and 20) and "openbb_sec_filings"."url" ~ '^https://' and char_length("openbb_sec_filings"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_ftd" (
	"cusip" text NOT NULL,
	"price" double precision,
	"quantity" bigint NOT NULL,
	"settlement_date" date NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "openbb_sec_ftd_settlement_date_symbol_pk" PRIMARY KEY("settlement_date","symbol"),
	CONSTRAINT "openbb_sec_ftd_check" CHECK ("openbb_sec_ftd"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and "openbb_sec_ftd"."cusip" ~ '^[0-9A-Z]{9}$' and ("openbb_sec_ftd"."quantity" is null or "openbb_sec_ftd"."quantity" >= 0) and ("openbb_sec_ftd"."price" is null or ("openbb_sec_ftd"."price" > '-Infinity'::float8 and "openbb_sec_ftd"."price" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_insider_trades" (
	"accession_number" text NOT NULL,
	"acquired_disposed" text,
	"filing_date" date NOT NULL,
	"owner_name" text NOT NULL,
	"owner_title" text,
	"price" double precision,
	"row_number" integer NOT NULL,
	"shares" double precision,
	"shares_after" double precision,
	"symbol" text NOT NULL,
	"transaction_code" text,
	"transaction_date" date,
	"url" text,
	CONSTRAINT "openbb_sec_insider_trades_accession_number_row_number_pk" PRIMARY KEY("accession_number","row_number"),
	CONSTRAINT "openbb_sec_insider_trades_check" CHECK ("openbb_sec_insider_trades"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and ("openbb_sec_insider_trades"."row_number" is null or "openbb_sec_insider_trades"."row_number" >= 0) and "openbb_sec_insider_trades"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_sec_insider_trades"."owner_name" is null or char_length(trim("openbb_sec_insider_trades"."owner_name")) between 1 and 200) and ("openbb_sec_insider_trades"."owner_title" is null or char_length(trim("openbb_sec_insider_trades"."owner_title")) between 1 and 200) and ("openbb_sec_insider_trades"."transaction_code" is null or char_length(trim("openbb_sec_insider_trades"."transaction_code")) between 1 and 10) and ("openbb_sec_insider_trades"."shares" is null or ("openbb_sec_insider_trades"."shares" > '-Infinity'::float8 and "openbb_sec_insider_trades"."shares" < 'Infinity'::float8)) and ("openbb_sec_insider_trades"."price" is null or ("openbb_sec_insider_trades"."price" > '-Infinity'::float8 and "openbb_sec_insider_trades"."price" < 'Infinity'::float8)) and ("openbb_sec_insider_trades"."shares_after" is null or ("openbb_sec_insider_trades"."shares_after" > '-Infinity'::float8 and "openbb_sec_insider_trades"."shares_after" < 'Infinity'::float8)) and ("openbb_sec_insider_trades"."acquired_disposed" is null or "openbb_sec_insider_trades"."acquired_disposed" in ('A', 'D')) and ("openbb_sec_insider_trades"."url" is null or "openbb_sec_insider_trades"."url" ~ '^https://'))
);
--> statement-breakpoint
CREATE TABLE "openbb_short_interest" (
	"avg_daily_volume" bigint,
	"days_to_cover" double precision,
	"previous_short_interest" bigint,
	"settlement_date" date NOT NULL,
	"short_interest" bigint NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "openbb_short_interest_settlement_date_symbol_pk" PRIMARY KEY("settlement_date","symbol"),
	CONSTRAINT "openbb_short_interest_check" CHECK ("openbb_short_interest"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_short_interest"."short_interest" is null or "openbb_short_interest"."short_interest" >= 0) and ("openbb_short_interest"."previous_short_interest" is null or "openbb_short_interest"."previous_short_interest" >= 0) and ("openbb_short_interest"."avg_daily_volume" is null or "openbb_short_interest"."avg_daily_volume" >= 0) and ("openbb_short_interest"."days_to_cover" is null or ("openbb_short_interest"."days_to_cover" > '-Infinity'::float8 and "openbb_short_interest"."days_to_cover" < 'Infinity'::float8)) and ("openbb_short_interest"."days_to_cover" is null or "openbb_short_interest"."days_to_cover" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_short_volume_daily" (
	"date" date NOT NULL,
	"short_exempt_volume" bigint NOT NULL,
	"short_volume" bigint NOT NULL,
	"symbol" text NOT NULL,
	"total_volume" bigint NOT NULL,
	CONSTRAINT "openbb_short_volume_daily_date_symbol_pk" PRIMARY KEY("date","symbol"),
	CONSTRAINT "openbb_short_volume_daily_check" CHECK ("openbb_short_volume_daily"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_short_volume_daily"."short_volume" is null or "openbb_short_volume_daily"."short_volume" >= 0) and ("openbb_short_volume_daily"."short_exempt_volume" is null or "openbb_short_volume_daily"."short_exempt_volume" >= 0) and ("openbb_short_volume_daily"."total_volume" is null or "openbb_short_volume_daily"."total_volume" >= 0))
);
--> statement-breakpoint
CREATE TABLE "openbb_vx_curve" (
	"as_of" date NOT NULL,
	"contract_month" text NOT NULL,
	"price" double precision NOT NULL,
	CONSTRAINT "openbb_vx_curve_as_of_contract_month_pk" PRIMARY KEY("as_of","contract_month"),
	CONSTRAINT "openbb_vx_curve_check" CHECK ("openbb_vx_curve"."contract_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ("openbb_vx_curve"."price" is null or ("openbb_vx_curve"."price" > '-Infinity'::float8 and "openbb_vx_curve"."price" < 'Infinity'::float8)))
);
--> statement-breakpoint
ALTER TABLE "openbb_macro_points" ADD CONSTRAINT "openbb_macro_points_series_id_openbb_macro_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."openbb_macro_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openbb_sec_13f_holdings_symbol_idx" ON "openbb_sec_13f_holdings" USING btree ("symbol");
--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: the openbb repository reads and upserts (insert +
-- update) the data tables (nothing prunes them; DELETE is there for operator cleanup), appends one
-- row per job run to openbb_ingest_runs (insert-only ledger), and openbb.ingest upserts Cboe vol
-- index closes into the market daily series tables (upsertPoints), which 0060 granted without UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT ON TABLE "openbb_ingest_runs" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_vx_curve", "openbb_option_iv_daily", "openbb_option_iv_term", "openbb_cot_positions", "openbb_macro_series", "openbb_macro_points", "openbb_event_calendar", "openbb_finra_otc_weekly", "openbb_short_interest", "openbb_short_volume_daily", "openbb_sec_filings", "openbb_sec_insider_trades", "openbb_sec_ftd", "openbb_sec_13f_holdings", "openbb_factor_returns" TO "vertex_research";
    GRANT UPDATE ON TABLE "market_daily_series", "market_daily_points" TO "vertex_research";
  END IF;
END
$$;
