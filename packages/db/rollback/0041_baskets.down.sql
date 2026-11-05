-- Guarded reversal of 0041_baskets only.
-- Refuses while any basket or member row exists so user data is never silently discarded.
-- No cascading drops, row deletion or truncation. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."basket_members", "public"."baskets" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."baskets")
    OR EXISTS (SELECT 1 FROM "public"."basket_members") THEN
    RAISE EXCEPTION 'basket tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."basket_members";
DROP INDEX "public"."baskets_user_symbol_unique_idx";
DROP TABLE "public"."baskets";
COMMIT;
