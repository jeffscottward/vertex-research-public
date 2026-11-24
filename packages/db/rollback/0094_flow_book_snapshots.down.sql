-- Guarded reversal of 0094_flow_book_snapshots only.
-- This file is not the rollback path: the rollback is "deploy the previous app"; it runs on the
-- migrated database and ignores the table.
-- flow_book_snapshots holds recorded CME L2 order book snapshots for ES and NQ. Dropping it loses
-- stored depth history for good: check `select count(*) from flow_book_snapshots` first and drop
-- only when it is 0 or the loss is accepted. Stop the collector first
-- (`systemctl stop vertex-flow.timer`): its depth snapshot write would wait for the lock of this
-- file.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0094 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0094 and the table stays missing. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0094 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_book_snapshots" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_book_snapshots";
COMMIT;
