CREATE TABLE "openbb_cusip_symbols" (
	"cusip" text NOT NULL,
	"last_seen" date NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "openbb_cusip_symbols_cusip_symbol_pk" PRIMARY KEY("cusip","symbol"),
	CONSTRAINT "openbb_cusip_symbols_check" CHECK ("openbb_cusip_symbols"."cusip" ~ '^[0-9A-Z]{9}$' and "openbb_cusip_symbols"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$')
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_13f_filings" (
	"accession_number" text PRIMARY KEY NOT NULL,
	"filed_on" date NOT NULL,
	"filer_cik" text NOT NULL,
	"filer_name" text NOT NULL,
	"period_ending" date NOT NULL,
	"rows" bigint NOT NULL,
	CONSTRAINT "openbb_sec_13f_filings_check" CHECK ("openbb_sec_13f_filings"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and "openbb_sec_13f_filings"."filer_cik" ~ '^[0-9]{1,10}$' and ("openbb_sec_13f_filings"."filer_name" is null or char_length(trim("openbb_sec_13f_filings"."filer_name")) between 1 and 200) and ("openbb_sec_13f_filings"."rows" is null or "openbb_sec_13f_filings"."rows" >= 0))
);
--> statement-breakpoint
ALTER TABLE "openbb_sec_13f_holdings" DROP CONSTRAINT "openbb_sec_13f_holdings_check";--> statement-breakpoint
ALTER TABLE "openbb_short_volume_daily" DROP CONSTRAINT "openbb_short_volume_daily_check";--> statement-breakpoint
ALTER TABLE "openbb_sec_13f_holdings" ADD COLUMN "accession_number" text;--> statement-breakpoint
ALTER TABLE "openbb_sec_13f_holdings" ADD COLUMN "filed_on" date;--> statement-breakpoint
CREATE INDEX "openbb_cusip_symbols_symbol_idx" ON "openbb_cusip_symbols" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "openbb_sec_13f_filings_filer_period_idx" ON "openbb_sec_13f_filings" USING btree ("filer_cik","period_ending");--> statement-breakpoint
CREATE INDEX "openbb_sec_13f_holdings_cusip_idx" ON "openbb_sec_13f_holdings" USING btree ("cusip");--> statement-breakpoint
ALTER TABLE "openbb_sec_13f_holdings" ADD CONSTRAINT "openbb_sec_13f_holdings_check" CHECK ("openbb_sec_13f_holdings"."filer_cik" ~ '^[0-9]{1,10}$' and "openbb_sec_13f_holdings"."cusip" ~ '^[0-9A-Z]{9}$' and ("openbb_sec_13f_holdings"."accession_number" is null or "openbb_sec_13f_holdings"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$') and "openbb_sec_13f_holdings"."option_type" in ('put', 'call', '') and ("openbb_sec_13f_holdings"."symbol" is null or "openbb_sec_13f_holdings"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$') and ("openbb_sec_13f_holdings"."filer_name" is null or char_length(trim("openbb_sec_13f_holdings"."filer_name")) between 1 and 200) and ("openbb_sec_13f_holdings"."issuer" is null or char_length(trim("openbb_sec_13f_holdings"."issuer")) between 1 and 200) and ("openbb_sec_13f_holdings"."asset_class" is null or char_length(trim("openbb_sec_13f_holdings"."asset_class")) between 1 and 40) and ("openbb_sec_13f_holdings"."shares" is null or "openbb_sec_13f_holdings"."shares" >= 0) and ("openbb_sec_13f_holdings"."value" is null or ("openbb_sec_13f_holdings"."value" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."value" < 'Infinity'::float8)) and ("openbb_sec_13f_holdings"."weight" is null or ("openbb_sec_13f_holdings"."weight" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."weight" < 'Infinity'::float8)));--> statement-breakpoint
ALTER TABLE "openbb_short_volume_daily" ADD CONSTRAINT "openbb_short_volume_daily_check" CHECK ("openbb_short_volume_daily"."symbol" ~ '^[A-Za-z0-9./^=-]{1,16}$' and ("openbb_short_volume_daily"."short_volume" is null or "openbb_short_volume_daily"."short_volume" >= 0) and ("openbb_short_volume_daily"."short_exempt_volume" is null or "openbb_short_volume_daily"."short_exempt_volume" >= 0) and ("openbb_short_volume_daily"."total_volume" is null or "openbb_short_volume_daily"."total_volume" >= 0));--> statement-breakpoint
-- Seed the CUSIP-to-ticker map from the fails-to-deliver rows already stored; sec-ftd adds the rest.
INSERT INTO "openbb_cusip_symbols" ("cusip", "last_seen", "symbol")
SELECT "cusip", max("settlement_date"), "symbol" FROM "openbb_sec_ftd"
WHERE "cusip" ~ '^[0-9A-Z]{9}$' AND "symbol" ~ '^[A-Z0-9.^=-]{1,16}$'
GROUP BY "cusip", "symbol"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Smart-money PR 5 (docs/vertex-rebuild/designs/smart-money/plan-pr5.md). The rig posts sec-13f and
-- sec-ftd to openbb.ingest, which upserts these tables as vertex_research (same grants as the other
-- openbb tables in 0064).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_sec_13f_filings", "openbb_cusip_symbols" TO "vertex_research";
  END IF;
END
$$;
