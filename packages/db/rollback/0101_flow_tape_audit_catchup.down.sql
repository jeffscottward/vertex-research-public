-- Guarded reversal of 0101_flow_tape_audit_catchup only.
-- This file is not the rollback path: the rollback is "deploy the previous app"; it runs on the
-- migrated database and ignores both tables.
-- flow_tape_audits holds the checks of the streamed tape against IBKR history; dropping it loses
-- them for good. flow_tape_gaps holds the ranges that the catch-up still reads; dropping it only
-- ends the catch-up of those ranges. Check `select count(*) from flow_tape_audits` first and drop
-- only when it is 0 or the loss is accepted. Stop the collector first
-- (`systemctl stop vertex-flow.timer`): its writes would wait for the locks of this file.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0101 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0101 and the tables stay missing. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0101 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_tape_audits", "public"."flow_tape_gaps" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_tape_audits";
DROP TABLE "public"."flow_tape_gaps";
COMMIT;
