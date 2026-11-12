-- Guarded reversal of 0067_deployment_request_options only.
-- Refuses while any deployment request carries an options block so recorded requests are never
-- silently changed. Drops the check, then the column; the table and its other checks (mode stays
-- paper) are untouched. Drizzle ledger reconciliation is deliberately not automated. Outside
-- discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."deployment_requests" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."deployment_requests" WHERE "options" IS NOT NULL) THEN
    RAISE EXCEPTION 'deployment_requests has rows with options; refusing rollback';
  END IF;
END
$$;
ALTER TABLE "public"."deployment_requests" DROP CONSTRAINT IF EXISTS "deployment_requests_options_check";
ALTER TABLE "public"."deployment_requests" DROP COLUMN IF EXISTS "options";
COMMIT;
