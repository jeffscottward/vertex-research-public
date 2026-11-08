-- Guarded reversal of 0053_flow_option_gaps only.
-- flow_option_gaps holds the option-print ranges capped collector runs left unread. Dropping it gives
-- those ranges up for good (their prints are never fetched; options totals then miss them), so check
-- `select count(*) from flow_option_gaps` first and roll back only when it is 0 or the loss is accepted.
-- Deploy the previous collector first; this one cannot read options without the table (samples
-- turn "unavailable").
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
