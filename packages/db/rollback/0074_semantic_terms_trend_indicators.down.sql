-- Guarded reversal of 0074_semantic_terms_trend_indicators only.
-- Deletes the five vocabulary rows only while none was edited after the seed (updated_by stays null), certified
-- or given a SQL attribute (no silent cascade).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_terms" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."semantic_terms" t
    WHERE t."id" IN ('supertrend', 'ultimate_ma', 'alphatrend', 'chandelier_exit', 'slingshot')
      AND (
        t."updated_by" IS NOT NULL
        OR t."certified"
        OR EXISTS (SELECT 1 FROM "public"."semantic_sql_attributes" a WHERE a."term_id" = t."id")
      )
  ) THEN
    RAISE EXCEPTION 'trend indicator terms have operator edits or linked rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."semantic_terms" WHERE "id" IN ('supertrend', 'ultimate_ma', 'alphatrend', 'chandelier_exit', 'slingshot');
COMMIT;
