-- Guarded reversal of 0050_plays only.
-- Refuses while any play exists so operator-entered plays are never silently discarded.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."plays" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."plays") THEN
    RAISE EXCEPTION 'plays is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."plays";
COMMIT;
