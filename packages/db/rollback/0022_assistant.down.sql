-- Guarded reversal of 0022_assistant only.
-- Refuses while any assistant thread, message or usage row exists so conversations and the budget
-- ledger are never silently discarded. Drizzle ledger reconciliation is deliberately not automated.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."assistant_usage", "public"."assistant_messages", "public"."assistant_threads" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."assistant_threads")
    OR EXISTS (SELECT 1 FROM "public"."assistant_messages")
    OR EXISTS (SELECT 1 FROM "public"."assistant_usage") THEN
    RAISE EXCEPTION 'assistant tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."assistant_usage";
DROP INDEX "public"."assistant_messages_thread_idx";
DROP TABLE "public"."assistant_messages";
DROP INDEX "public"."assistant_threads_user_idx";
DROP TABLE "public"."assistant_threads";
COMMIT;
