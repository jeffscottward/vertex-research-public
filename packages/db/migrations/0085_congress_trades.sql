CREATE TABLE "openbb_congress_filings" (
	"amends" boolean NOT NULL,
	"chamber" text NOT NULL,
	"doc_id" text NOT NULL,
	"filed_on" date NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member" text NOT NULL,
	"parser_version" text NOT NULL,
	"reason" text,
	"row_count" integer NOT NULL,
	"state_district" text,
	"status" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "openbb_congress_filings_chamber_doc_id_pk" PRIMARY KEY("chamber","doc_id"),
	CONSTRAINT "openbb_congress_filings_check" CHECK ("openbb_congress_filings"."chamber" in ('house', 'senate') and (("openbb_congress_filings"."chamber" = 'house' and "openbb_congress_filings"."doc_id" ~ '^[0-9]{1,12}$') or ("openbb_congress_filings"."chamber" = 'senate' and "openbb_congress_filings"."doc_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) and ("openbb_congress_filings"."member" is null or char_length(trim("openbb_congress_filings"."member")) between 1 and 200) and ("openbb_congress_filings"."state_district" is null or char_length(trim("openbb_congress_filings"."state_district")) between 1 and 10) and "openbb_congress_filings"."url" ~ '^https://' and "openbb_congress_filings"."status" in ('parsed', 'unparsed') and (("openbb_congress_filings"."status" = 'parsed' and "openbb_congress_filings"."reason" is null) or ("openbb_congress_filings"."status" = 'unparsed' and "openbb_congress_filings"."reason" in ('scanned_image', 'no_transactions', 'layout_unknown'))) and "openbb_congress_filings"."row_count" >= 0 and ("openbb_congress_filings"."status" = 'parsed' or "openbb_congress_filings"."row_count" = 0) and ("openbb_congress_filings"."parser_version" is null or char_length(trim("openbb_congress_filings"."parser_version")) between 1 and 20))
);
--> statement-breakpoint
CREATE TABLE "openbb_congress_trades" (
	"amount_high" bigint,
	"amount_label" text NOT NULL,
	"amount_low" bigint,
	"asset" text NOT NULL,
	"asset_type" text,
	"chamber" text NOT NULL,
	"doc_id" text NOT NULL,
	"filed_on" date NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holder" text,
	"member" text NOT NULL,
	"row_number" integer NOT NULL,
	"ticker" text,
	"transaction_date" date,
	"transaction_type" text NOT NULL,
	CONSTRAINT "openbb_congress_trades_chamber_doc_id_row_number_pk" PRIMARY KEY("chamber","doc_id","row_number"),
	CONSTRAINT "openbb_congress_trades_check" CHECK ("openbb_congress_trades"."chamber" in ('house', 'senate') and (("openbb_congress_trades"."chamber" = 'house' and "openbb_congress_trades"."doc_id" ~ '^[0-9]{1,12}$') or ("openbb_congress_trades"."chamber" = 'senate' and "openbb_congress_trades"."doc_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) and "openbb_congress_trades"."row_number" >= 1 and ("openbb_congress_trades"."member" is null or char_length(trim("openbb_congress_trades"."member")) between 1 and 200) and ("openbb_congress_trades"."holder" is null or "openbb_congress_trades"."holder" in ('self', 'spouse', 'joint', 'dependent')) and ("openbb_congress_trades"."ticker" is null or "openbb_congress_trades"."ticker" ~ '^[A-Z0-9.^=-]{1,16}$') and char_length("openbb_congress_trades"."asset") <= 500 and ("openbb_congress_trades"."asset_type" is null or char_length(trim("openbb_congress_trades"."asset_type")) between 1 and 40) and "openbb_congress_trades"."transaction_type" in ('purchase', 'sale', 'sale_partial', 'exchange', 'other') and ("openbb_congress_trades"."amount_label" is null or char_length(trim("openbb_congress_trades"."amount_label")) between 1 and 60) and ("openbb_congress_trades"."amount_low" is null or "openbb_congress_trades"."amount_low" >= 0) and ("openbb_congress_trades"."amount_high" is null or "openbb_congress_trades"."amount_high" >= 0))
);
--> statement-breakpoint
CREATE INDEX "openbb_congress_filings_filed_on_idx" ON "openbb_congress_filings" USING btree ("filed_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "openbb_congress_trades_filed_on_idx" ON "openbb_congress_trades" USING btree ("filed_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "openbb_congress_trades_ticker_idx" ON "openbb_congress_trades" USING btree ("ticker","filed_on" DESC NULLS LAST);--> statement-breakpoint
-- The OpenBB rig posts the congress-house and congress-senate jobs to openbb.ingest, which upserts
-- these tables as vertex_research (same grants as the other openbb tables in 0064).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_congress_trades", "openbb_congress_filings" TO "vertex_research";
  END IF;
END
$$;
