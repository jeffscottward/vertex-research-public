-- Guarded reversal of 0027_forward_drift only.
-- Refuses while any drift monitor exists so recorded paper series and alerts are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."forward_drift_monitors", "public"."forward_drift_alerts" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."forward_drift_monitors") THEN
    RAISE EXCEPTION 'forward_drift_monitors is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."forward_drift_monitors_baseline_idx";
DROP INDEX "public"."forward_drift_monitors_created_idx";
DROP INDEX "public"."forward_drift_alerts_monitor_idx";
DROP INDEX "public"."forward_drift_alerts_created_idx";
DROP TABLE "public"."forward_drift_alerts";
DROP TABLE "public"."forward_drift_monitors";
COMMIT;
