-- Guarded reversal of 0067_market_notes only.
-- Refuses while any market note exists so the owner's notes (the source text, the claims and the
-- evidence recorded for them) are never silently discarded. No cascading drops, truncation or
-- conditional drops. Drizzle ledger reconciliation is deliberately not automated; coordinate it
-- separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."market_notes" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."market_notes") THEN
    RAISE EXCEPTION 'market_notes is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."market_notes_received_at_idx";
DROP INDEX "public"."market_notes_source_key_idx";
DROP TABLE "public"."market_notes";
COMMIT;
