-- Guarded reversal of 0014_watchlist_items only.
-- Refuses when any watchlist row exists so user data is never silently discarded.
-- No cascading drops, row deletion, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."watchlist_items" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."watchlist_items") THEN
    RAISE EXCEPTION 'watchlist_items is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."watchlist_items_user_symbol_unique_idx";
DROP TABLE "public"."watchlist_items";
COMMIT;
