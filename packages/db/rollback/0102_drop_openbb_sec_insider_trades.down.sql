-- Reversal of 0102_drop_openbb_sec_insider_trades only.
-- Recreates the empty table with the exact columns, primary key, CHECK constraint, and guarded
-- vertex_research grant from 0064_openbb_sources.sql. Restore rows data-only from backup before
-- redeploying a pre-0102 build. Drizzle ledger reconciliation is deliberately not automated.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
CREATE TABLE "public"."openbb_sec_insider_trades" (
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
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."openbb_sec_insider_trades" TO "vertex_research";
  END IF;
END
$$;
COMMIT;
