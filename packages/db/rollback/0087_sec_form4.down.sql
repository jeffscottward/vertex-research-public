-- Reversal of 0087_sec_form4 only.
-- Does not refuse when rows exist: the tables hold only public filings the rig can fetch again.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_sec_form4_transactions", "public"."openbb_sec_form4_owners", "public"."openbb_sec_form4_filings", "public"."openbb_sec_form4_index_days" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."openbb_sec_form4_transactions";
DROP TABLE "public"."openbb_sec_form4_owners";
DROP TABLE "public"."openbb_sec_form4_filings";
DROP TABLE "public"."openbb_sec_form4_index_days";
COMMIT;
