-- Guarded reversal of 0040_price_alert_rules only.
-- Refuses while any price alert rule exists so owner data is never silently discarded.
-- No cascading drops, row deletion, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."price_alert_rules" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."price_alert_rules") THEN
    RAISE EXCEPTION 'price_alert_rules is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."price_alert_rules_status_updated_idx";
DROP INDEX "public"."price_alert_rules_user_created_idx";
DROP TABLE "public"."price_alert_rules";
COMMIT;
