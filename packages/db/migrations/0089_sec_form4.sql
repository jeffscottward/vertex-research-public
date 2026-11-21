CREATE TABLE "openbb_sec_form4_filings" (
	"accepted_at" timestamp with time zone,
	"accession_number" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"form_type" text NOT NULL,
	"index_day" date NOT NULL,
	"issuer_cik" text,
	"issuer_name" text,
	"issuer_symbol" text,
	"parser_version" text NOT NULL,
	"period_of_report" date,
	"plan_10b5_1" boolean,
	"reason" text,
	"row_count" integer NOT NULL,
	"status" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "openbb_sec_form4_filings_check" CHECK ("openbb_sec_form4_filings"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and "openbb_sec_form4_filings"."form_type" in ('4', '4/A') and "openbb_sec_form4_filings"."status" in ('parsed', 'unparsed') and ("openbb_sec_form4_filings"."reason" is null or "openbb_sec_form4_filings"."reason" in ('no_xml', 'too_large', 'not_found', 'layout_unknown')) and (("openbb_sec_form4_filings"."status" = 'parsed') = ("openbb_sec_form4_filings"."reason" is null)) and ("openbb_sec_form4_filings"."status" = 'parsed' or "openbb_sec_form4_filings"."row_count" = 0) and ("openbb_sec_form4_filings"."status" = 'unparsed' or ("openbb_sec_form4_filings"."accepted_at" is not null and "openbb_sec_form4_filings"."issuer_cik" is not null)) and "openbb_sec_form4_filings"."row_count" >= 0 and ("openbb_sec_form4_filings"."issuer_cik" is null or "openbb_sec_form4_filings"."issuer_cik" ~ '^[0-9]{1,10}$') and ("openbb_sec_form4_filings"."issuer_symbol" is null or "openbb_sec_form4_filings"."issuer_symbol" ~ '^[A-Z0-9.^=-]{1,16}$') and ("openbb_sec_form4_filings"."issuer_name" is null or char_length(trim("openbb_sec_form4_filings"."issuer_name")) between 1 and 200) and ("openbb_sec_form4_filings"."parser_version" is null or char_length(trim("openbb_sec_form4_filings"."parser_version")) between 1 and 20) and "openbb_sec_form4_filings"."url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_form4_index_days" (
	"complete" boolean NOT NULL,
	"entries_done" integer NOT NULL,
	"entries_listed" integer NOT NULL,
	"index_day" date PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openbb_sec_form4_index_days_check" CHECK ("openbb_sec_form4_index_days"."entries_listed" >= 0 and "openbb_sec_form4_index_days"."entries_done" between 0 and "openbb_sec_form4_index_days"."entries_listed" and "openbb_sec_form4_index_days"."complete" = ("openbb_sec_form4_index_days"."entries_done" = "openbb_sec_form4_index_days"."entries_listed"))
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_form4_owners" (
	"accession_number" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_director" boolean NOT NULL,
	"is_officer" boolean NOT NULL,
	"is_other" boolean NOT NULL,
	"is_ten_percent_owner" boolean NOT NULL,
	"officer_title" text,
	"owner_cik" text NOT NULL,
	"owner_name" text NOT NULL,
	CONSTRAINT "openbb_sec_form4_owners_accession_number_owner_cik_pk" PRIMARY KEY("accession_number","owner_cik"),
	CONSTRAINT "openbb_sec_form4_owners_check" CHECK ("openbb_sec_form4_owners"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and "openbb_sec_form4_owners"."owner_cik" ~ '^[0-9]{1,10}$' and ("openbb_sec_form4_owners"."owner_name" is null or char_length(trim("openbb_sec_form4_owners"."owner_name")) between 1 and 200) and ("openbb_sec_form4_owners"."officer_title" is null or char_length(trim("openbb_sec_form4_owners"."officer_title")) between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "openbb_sec_form4_transactions" (
	"accession_number" text NOT NULL,
	"acquired_disposed" text,
	"derivative" boolean NOT NULL,
	"direct_indirect" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price" double precision,
	"row_number" integer NOT NULL,
	"security_title" text NOT NULL,
	"shares" double precision,
	"shares_after" double precision,
	"transaction_code" text,
	"transaction_date" date,
	CONSTRAINT "openbb_sec_form4_transactions_accession_number_row_number_pk" PRIMARY KEY("accession_number","row_number"),
	CONSTRAINT "openbb_sec_form4_transactions_check" CHECK ("openbb_sec_form4_transactions"."accession_number" ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$' and "openbb_sec_form4_transactions"."row_number" >= 1 and ("openbb_sec_form4_transactions"."acquired_disposed" is null or "openbb_sec_form4_transactions"."acquired_disposed" in ('A', 'D')) and ("openbb_sec_form4_transactions"."direct_indirect" is null or "openbb_sec_form4_transactions"."direct_indirect" in ('D', 'I')) and ("openbb_sec_form4_transactions"."transaction_code" is null or "openbb_sec_form4_transactions"."transaction_code" in ('A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'O', 'P', 'S', 'U', 'V', 'W', 'X', 'Z')) and ("openbb_sec_form4_transactions"."security_title" is null or char_length(trim("openbb_sec_form4_transactions"."security_title")) between 1 and 200) and ("openbb_sec_form4_transactions"."price" is null or ("openbb_sec_form4_transactions"."price" > '-Infinity'::float8 and "openbb_sec_form4_transactions"."price" < 'Infinity'::float8)) and ("openbb_sec_form4_transactions"."shares" is null or ("openbb_sec_form4_transactions"."shares" > '-Infinity'::float8 and "openbb_sec_form4_transactions"."shares" < 'Infinity'::float8)) and ("openbb_sec_form4_transactions"."shares_after" is null or ("openbb_sec_form4_transactions"."shares_after" > '-Infinity'::float8 and "openbb_sec_form4_transactions"."shares_after" < 'Infinity'::float8)))
);
--> statement-breakpoint
CREATE INDEX "openbb_sec_form4_filings_accepted_at_idx" ON "openbb_sec_form4_filings" USING btree ("accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "openbb_sec_form4_filings_issuer_cik_idx" ON "openbb_sec_form4_filings" USING btree ("issuer_cik","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "openbb_sec_form4_filings_symbol_idx" ON "openbb_sec_form4_filings" USING btree ("issuer_symbol","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "openbb_sec_form4_filings_index_day_idx" ON "openbb_sec_form4_filings" USING btree ("index_day");--> statement-breakpoint
CREATE INDEX "openbb_sec_form4_transactions_purchase_idx" ON "openbb_sec_form4_transactions" USING btree ("accession_number") WHERE "openbb_sec_form4_transactions"."transaction_code" = 'P';--> statement-breakpoint
-- The OpenBB rig posts the sec-form4 job to openbb.ingest, which upserts these tables as
-- vertex_research (same grants as the other openbb tables in 0064).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "openbb_sec_form4_filings", "openbb_sec_form4_transactions", "openbb_sec_form4_owners", "openbb_sec_form4_index_days" TO "vertex_research";
  END IF;
END
$$;
