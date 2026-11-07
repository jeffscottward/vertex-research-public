-- Guarded reversal of 0050_research_studies only.
-- Refuses while any imported study exists (a row other than the seeded adx-rvol-filters study, or the
-- seeded row after an import replaced it), so imported studies are never silently discarded. The
-- seeded row comes back when the migration is applied again.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."research_studies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."research_studies"
    WHERE "id" <> 'adx-rvol-filters' OR "updated_at" <> "created_at"
  ) THEN
    RAISE EXCEPTION 'research_studies holds imported studies; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."research_studies";
COMMIT;
