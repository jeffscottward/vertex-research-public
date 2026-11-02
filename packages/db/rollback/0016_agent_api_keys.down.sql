-- Guarded reversal of 0016_agent_api_keys only.
-- Refuses while any API key row exists so issued agent credentials are never silently discarded;
-- revoke keys from the Agent runs page first. Drizzle ledger reconciliation is deliberately not
-- automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."apikey" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."apikey") THEN
    RAISE EXCEPTION 'apikey is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."apikey_key_idx";
DROP INDEX "public"."apikey_reference_id_idx";
DROP INDEX "public"."apikey_config_id_idx";
DROP TABLE "public"."apikey";
COMMIT;
