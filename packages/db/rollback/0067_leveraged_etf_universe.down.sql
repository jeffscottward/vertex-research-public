-- Reversal of 0067_leveraged_etf_universe only.
-- The rows are derived data: `bun run vertex:leveraged-etf-universe:import` replaces the whole table
-- from the next universe document, so stored rows do not block the rollback and no guard query is
-- needed. No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is
-- deliberately not automated: after this rollback the 0067 row stays in
-- drizzle.__drizzle_migrations, so `db:migrate` skips 0067 and the table stays missing. To re-apply,
-- delete that ledger row (match its hash) first, then run `db:migrate`. Outside discoverable
-- migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."leveraged_etf_universe" IN ACCESS EXCLUSIVE MODE;
DROP INDEX "public"."leveraged_etf_universe_option_gate_idx";
DROP TABLE "public"."leveraged_etf_universe";
COMMIT;
