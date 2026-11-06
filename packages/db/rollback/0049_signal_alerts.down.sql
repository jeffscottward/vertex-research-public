-- Guarded reversal of 0049_signal_alerts only.
-- Refuses while any signal alert rule exists so owner rules and their fire history are never
-- silently discarded.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."signal_alert_rules" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."signal_alert_events" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."signal_alert_rules") THEN
    RAISE EXCEPTION 'signal_alert_rules is not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."signal_alert_events";
DROP TABLE "public"."signal_alert_rules";
COMMIT;
