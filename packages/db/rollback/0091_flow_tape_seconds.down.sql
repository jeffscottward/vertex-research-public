-- Guarded reversal of 0091_flow_tape_seconds only.
-- This file is not the rollback path: the rollback is "deploy the previous app"; it runs on the
-- migrated database and ignores the table.
-- flow_tape_seconds holds the per-second counts of the streamed tape. Dropping it loses them for
-- good (single prints exist only in the memory of vertex-history, so the counts cannot be collected
-- again): check `select count(*) from flow_tape_seconds` first and drop only when it is 0 or the
-- loss is accepted. Stop the collector first (`systemctl stop vertex-flow.timer`): its per-second
-- write would wait for the lock of this file.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0091 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0091 and the table stays missing. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0091 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_tape_seconds" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_tape_seconds";
COMMIT;
