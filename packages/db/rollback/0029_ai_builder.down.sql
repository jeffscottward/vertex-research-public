-- Guarded reversal of 0029_ai_builder only.
-- Refuses while any assistant action or saved strategy definition revision exists, so confirm-card
-- history and saved definitions are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."assistant_actions", "public"."strategy_definition_revisions" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."assistant_actions")
    OR EXISTS (SELECT 1 FROM "public"."strategy_definition_revisions") THEN
    RAISE EXCEPTION 'assistant_actions or strategy_definition_revisions is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."strategy_definition_revisions_created_idx";
DROP INDEX "public"."strategy_definition_revisions_revision_unique_idx";
DROP INDEX "public"."assistant_actions_thread_idx";
DROP TABLE "public"."strategy_definition_revisions";
DROP TABLE "public"."assistant_actions";
COMMIT;
