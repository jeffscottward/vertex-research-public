-- Guarded reversal of 0066_breadth_90 only.
-- Refuses while any breadth-90 event exists so the event history (the insert-once record of ARMED,
-- FORMING, FIRED and THRUST sessions) is never silently discarded. Stored sessions and the status
-- row are derived data: the rig tick (scripts/breadth-90) pushes them again through breadth90.collect,
-- so they do not block the rollback. No cascading drops, truncation or conditional drops. Drizzle
-- ledger reconciliation is deliberately not automated; coordinate it separately before
-- re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."breadth90_events" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."breadth90_days" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."breadth90_status" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."breadth90_events") THEN
    RAISE EXCEPTION 'breadth90_events is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."breadth90_events_date_idx";
DROP INDEX "public"."breadth90_events_kind_date_tier_idx";
DROP TABLE "public"."breadth90_events";
DROP TABLE "public"."breadth90_status";
DROP TABLE "public"."breadth90_days";
COMMIT;
