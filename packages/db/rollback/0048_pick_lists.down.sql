-- Guarded reversal of 0048_pick_lists only.
-- Refuses while any pick list exists so imported snapshots (dated provenance that cannot be
-- re-fetched for past dates) are never silently discarded.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."pick_lists" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."pick_list_snapshots" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."pick_list_members" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."pick_lists") THEN
    RAISE EXCEPTION 'pick_lists is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."pick_list_members";
DROP TABLE "public"."pick_list_snapshots";
DROP TABLE "public"."pick_lists";
COMMIT;
