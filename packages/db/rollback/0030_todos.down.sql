-- Guarded reversal of 0030_todos only.
-- Refuses while any to-do row exists so owner data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."todos" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."todos") THEN
    RAISE EXCEPTION 'todos is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."todos_user_status_due_idx";
DROP TABLE "public"."todos";
COMMIT;
