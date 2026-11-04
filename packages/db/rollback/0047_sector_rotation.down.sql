-- Guarded reversal of 0047_sector_rotation only.
-- Refuses while any sector rotation alert exists so the alert history (the insert-once record that
-- stops repeat notifications) is never silently discarded. Stored points are derived data: they are
-- recomputed from market bars by sectorRotation.collect, so they do not block the rollback.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."sector_rotation_alerts" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."sector_rotation_points" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."sector_rotation_alerts") THEN
    RAISE EXCEPTION 'sector_rotation_alerts is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."sector_rotation_points_timeframe_date_idx";
DROP TABLE "public"."sector_rotation_points";
DROP TABLE "public"."sector_rotation_alerts";
COMMIT;
