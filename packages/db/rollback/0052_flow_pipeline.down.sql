-- Guarded reversal of 0052_flow_pipeline only.
-- The flow tables hold derived, regenerable data (sampled IBKR ticks and depth, QuantData option
-- prints and GEX snapshots, pruned after 14 days), so the rollback drops them without a data check.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0052 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0052 and the tables stay missing (flow.snapshot answers STORAGE_ERROR).
-- To re-apply, delete that ledger row (match its hash) first, then run `db:migrate`.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_samples", "public"."flow_minutes", "public"."flow_book",
  "public"."flow_option_prints", "public"."flow_events", "public"."flow_gex" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_gex";
DROP TABLE "public"."flow_events";
DROP TABLE "public"."flow_option_prints";
DROP TABLE "public"."flow_book";
DROP TABLE "public"."flow_minutes";
DROP TABLE "public"."flow_samples";
COMMIT;
