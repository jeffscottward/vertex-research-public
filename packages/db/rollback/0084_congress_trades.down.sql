-- Reversal of 0084_congress_trades only.
-- Does not refuse when rows exist: the tables hold only public filings the rig can fetch again.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_congress_trades", "public"."openbb_congress_filings" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."openbb_congress_trades";
DROP TABLE "public"."openbb_congress_filings";
COMMIT;
