-- Guarded reversal of 0093_option_chain_snapshots only.
-- This file is not the routine rollback path: the routine rollback is "deploy the previous app",
-- which runs on the migrated database and ignores these tables.
-- Refuses while any snapshot row exists so stored historical option-chain quotes are never
-- silently discarded. No cascading drops, truncation or conditional drops. Drizzle ledger
-- reconciliation is deliberately not automated; coordinate it separately before re-application.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."option_chain_snapshot_quotes" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."option_chain_snapshots" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."option_chain_snapshots") THEN
    RAISE EXCEPTION 'option_chain_snapshots is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."option_chain_snapshots_underlying_day_idx";
DROP INDEX "public"."option_chain_snapshots_underlying_at_idx";
DROP INDEX "public"."option_chain_snapshots_at_underlying_expiry_idx";
DROP TABLE "public"."option_chain_snapshot_quotes";
DROP TABLE "public"."option_chain_snapshots";
COMMIT;
