-- Guarded reversal of 0053_flow_option_gaps only.
-- flow_option_gaps holds derived, regenerable bookkeeping (option-print ranges a capped collector run
-- left unfetched), so the rollback drops it without a data check; the collector then only reads new
-- windows, as before 0053. Deploy the previous collector first: this one needs the table.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0053 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0053 and the table stays missing. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0053 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_option_gaps" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_option_gaps";
COMMIT;
