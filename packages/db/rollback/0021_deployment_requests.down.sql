-- Guarded reversal of 0021_deployment_requests only.
-- Refuses while any deployment request exists so operator decisions are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."deployment_requests" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."deployment_requests") THEN
    RAISE EXCEPTION 'deployment_requests is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."deployment_requests_strategy_idx";
DROP INDEX "public"."deployment_requests_status_idx";
DROP INDEX "public"."deployment_requests_created_idx";
DROP TABLE "public"."deployment_requests";
COMMIT;
