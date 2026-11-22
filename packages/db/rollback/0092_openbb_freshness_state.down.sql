-- Guarded reversal of 0092_openbb_freshness_state only.
-- This file is not the primary rollback path: the primary rollback is "deploy the previous app";
-- it runs on the migrated database and ignores the openbb_freshness_state table.
-- Stop vertex-openbb-freshness.timer on QuantVPS before running this rollback so no tick waits on
-- the table lock (`systemctl stop vertex-openbb-freshness.timer`).
-- Dropping openbb_freshness_state discards any active or pending freshness alert state; the next
-- run after re-applying 0092 re-evaluates all 45 stored series from Postgres.
-- No cascading drops, truncation, or conditional drops. Drizzle ledger reconciliation is
-- deliberately not automated: after this rollback the 0092 row stays in drizzle.__drizzle_migrations,
-- so `db:migrate` skips 0092 and the table stays missing. To re-apply, delete that ledger row
-- (matching its hash) first, or apply 0092 alone again.
-- Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_freshness_state" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."openbb_freshness_state";
COMMIT;
