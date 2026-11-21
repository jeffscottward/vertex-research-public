-- Reversal of 0086_sec_13f_full_books only.
-- Does not refuse when rows exist: the tables hold only public SEC and FINRA data the rig fetches
-- again. Short-volume rows with FINRA suffix symbols (lowercase or '/') are deleted, because the
-- restored CHECK refuses them. Drizzle ledger reconciliation is deliberately not automated.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_sec_13f_filings", "public"."openbb_cusip_symbols",
  "public"."openbb_sec_13f_holdings", "public"."openbb_short_volume_daily" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."openbb_sec_13f_filings";
DROP TABLE "public"."openbb_cusip_symbols";
DROP INDEX "public"."openbb_sec_13f_holdings_cusip_idx";
ALTER TABLE "public"."openbb_sec_13f_holdings" DROP CONSTRAINT "openbb_sec_13f_holdings_check";
ALTER TABLE "public"."openbb_sec_13f_holdings" DROP COLUMN "accession_number";
ALTER TABLE "public"."openbb_sec_13f_holdings" DROP COLUMN "filed_on";
ALTER TABLE "public"."openbb_sec_13f_holdings" ADD CONSTRAINT "openbb_sec_13f_holdings_check" CHECK ("openbb_sec_13f_holdings"."filer_cik" ~ '^[0-9]{1,10}$' and "openbb_sec_13f_holdings"."cusip" ~ '^[0-9A-Z]{9}$' and "openbb_sec_13f_holdings"."option_type" in ('put', 'call', '') and ("openbb_sec_13f_holdings"."symbol" is null or "openbb_sec_13f_holdings"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$') and ("openbb_sec_13f_holdings"."filer_name" is null or char_length(trim("openbb_sec_13f_holdings"."filer_name")) between 1 and 200) and ("openbb_sec_13f_holdings"."issuer" is null or char_length(trim("openbb_sec_13f_holdings"."issuer")) between 1 and 200) and ("openbb_sec_13f_holdings"."asset_class" is null or char_length(trim("openbb_sec_13f_holdings"."asset_class")) between 1 and 40) and ("openbb_sec_13f_holdings"."shares" is null or "openbb_sec_13f_holdings"."shares" >= 0) and ("openbb_sec_13f_holdings"."value" is null or ("openbb_sec_13f_holdings"."value" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."value" < 'Infinity'::float8)) and ("openbb_sec_13f_holdings"."weight" is null or ("openbb_sec_13f_holdings"."weight" > '-Infinity'::float8 and "openbb_sec_13f_holdings"."weight" < 'Infinity'::float8)));
DELETE FROM "public"."openbb_short_volume_daily" WHERE "symbol" !~ '^[A-Z0-9.^=-]{1,16}$';
ALTER TABLE "public"."openbb_short_volume_daily" DROP CONSTRAINT "openbb_short_volume_daily_check";
ALTER TABLE "public"."openbb_short_volume_daily" ADD CONSTRAINT "openbb_short_volume_daily_check" CHECK ("openbb_short_volume_daily"."symbol" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_short_volume_daily"."short_volume" is null or "openbb_short_volume_daily"."short_volume" >= 0) and ("openbb_short_volume_daily"."short_exempt_volume" is null or "openbb_short_volume_daily"."short_exempt_volume" >= 0) and ("openbb_short_volume_daily"."total_volume" is null or "openbb_short_volume_daily"."total_volume" >= 0));
COMMIT;
