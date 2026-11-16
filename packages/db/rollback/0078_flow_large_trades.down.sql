-- Guarded reversal of 0078_flow_large_trades only.
-- This file is not the rollback path: the rollback is "deploy the previous app"; it runs on the
-- migrated database and ignores the table.
-- flow_large_trades holds every stored deep trade. Dropping it loses them for good (they cannot be
-- fetched again), so check `select count(*) from flow_large_trades` first and drop only when it is 0
-- or the loss is accepted.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0078 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0078 and the table stays missing. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0078 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_large_trades" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_large_trades";
COMMIT;
