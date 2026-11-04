-- Guarded reversal of 0042_basket_benchmark_base only.
-- Refuses while any basket carries a benchmark base price so stored data is never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."baskets" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."baskets" WHERE "benchmark_base_price" IS NOT NULL) THEN
    RAISE EXCEPTION 'baskets has benchmark_base_price data; refusing rollback';
  END IF;
END
$$;
ALTER TABLE "public"."baskets" DROP CONSTRAINT "baskets_benchmark_base_price_check";
ALTER TABLE "public"."baskets" DROP COLUMN "benchmark_base_price";
COMMIT;
