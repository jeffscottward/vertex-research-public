-- Guarded reversal of 0103_research_papers_reel_links only.
-- Deletes the three reel DfDt0GDR8Oa learning links only while none of them was edited
-- (updated_at = created_at, stage = 'queued', verdict = 'pending', empty metrics) and no
-- agent_tasks, backtest_results, paper_captures or strategy_specs row references any of them
-- (no silent SET NULL or CASCADE).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."research_papers" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."research_papers" p
    WHERE p."id" IN (
      'article-jpmorgan-python-training',
      'article-quantopian-research-public',
      'article-firmai-financial-ml'
    )
      AND (
        p."updated_at" <> p."created_at"
        OR p."stage" <> 'queued'
        OR p."verdict" <> 'pending'
        OR p."reported_metrics" <> '{}'::jsonb
        OR p."reproduced_metrics" <> '{}'::jsonb
        OR EXISTS (SELECT 1 FROM "public"."agent_tasks" t WHERE t."paper_id" = p."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."paper_id" = p."id")
        OR EXISTS (SELECT 1 FROM "public"."paper_captures" c WHERE c."paper_id" = p."id")
        OR EXISTS (SELECT 1 FROM "public"."strategy_specs" s WHERE s."paper_id" = p."id")
      )
  ) THEN
    RAISE EXCEPTION 'reel learning link has operator edits or linked rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."research_papers"
WHERE "id" IN (
  'article-jpmorgan-python-training',
  'article-quantopian-research-public',
  'article-firmai-financial-ml'
);
COMMIT;
