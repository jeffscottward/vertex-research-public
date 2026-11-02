-- Guarded reversal of 0015_agent_ops_ledger only.
-- Refuses when any agent task or event exists, or when research_papers holds rows other than the four
-- seeded references, so operator data is never silently discarded. Seeded rows are removed explicitly.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."agent_task_events", "public"."agent_tasks", "public"."research_papers" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."agent_task_events") THEN
    RAISE EXCEPTION 'agent_task_events is not empty; refusing rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."agent_tasks") THEN
    RAISE EXCEPTION 'agent_tasks is not empty; refusing rollback';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."research_papers"
    WHERE "id" NOT IN ('paper-orca-2604-17251', 'paper-hmm-rl-2605-27848', 'paper-jump-model-2402-05272', 'article-ruuj-hmm-regimes-20260707')
  ) THEN
    RAISE EXCEPTION 'research_papers holds operator rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."research_papers"
  WHERE "id" IN ('paper-orca-2604-17251', 'paper-hmm-rl-2605-27848', 'paper-jump-model-2402-05272', 'article-ruuj-hmm-regimes-20260707');
DROP INDEX "public"."agent_task_events_at_idx";
DROP INDEX "public"."agent_task_events_task_at_idx";
DROP TABLE "public"."agent_task_events";
DROP INDEX "public"."agent_tasks_paper_idx";
DROP INDEX "public"."agent_tasks_updated_idx";
DROP INDEX "public"."agent_tasks_kind_updated_idx";
DROP INDEX "public"."agent_tasks_status_updated_idx";
DROP TABLE "public"."agent_tasks";
DROP INDEX "public"."research_papers_stage_updated_idx";
DROP INDEX "public"."research_papers_identifier_unique_idx";
DROP TABLE "public"."research_papers";
COMMIT;
