-- Guarded reversal of 0046_click_log only.
-- Refuses while any click row exists, so recorded clicks are never silently discarded. Clicks are
-- debug data kept 14 days: wait for retention, or delete them on purpose before the rollback.
-- No cascading drops, row deletion or truncation. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."ui_click_events" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."ui_click_events") THEN
    RAISE EXCEPTION 'ui_click_events is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."ui_click_events";
COMMIT;
