-- Guarded reversal of 0103_research_papers_reel_links only.
-- Deletes the three reel DfDt0GDR8Oa learning links only while every seeded column matches
-- the exact 0103 seed tuple (including updated_at = created_at, stage = 'queued',
-- verdict = 'pending', empty metrics) and no agent_tasks, backtest_results, paper_captures
-- or strategy_specs row references any of them (no silent SET NULL or CASCADE).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."research_papers" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."research_papers" p
    JOIN (
      VALUES
        (
          'article-jpmorgan-python-training',
          'J.P. Morgan Python Training',
          'JPMorgan Chase (jpmorganchase)',
          2026,
          'https://github.com/jpmorganchase/python-training',
          'github:jpmorganchase/python-training',
          'article',
          'Learning material only (course notebooks), not a trading strategy whitepaper: no backtested alpha signal or execution specification.',
          'Python and pandas course notebooks from reel DfDt0GDR8Oa (candidate #6; Apache-2.0; pinned commit 0c536090 as evaluated 2026-10-30). Reference link only; no code copied into Vertex. See docs/vertex-rebuild/upstream-candidates-20261030.md.'
        ),
        (
          'article-quantopian-research-public',
          'Quantopian Lecture Series (research_public)',
          'Quantopian (quantopian)',
          2020,
          'https://github.com/quantopian/research_public',
          'github:quantopian/research_public',
          'article',
          'Learning material only: lecture notebooks depend on the retired Quantopian platform, and no repository license is stated, so no code is copied.',
          'Quantitative finance lecture notebooks from reel DfDt0GDR8Oa (candidate #7; no license stated; pinned commit e183ecd0 as evaluated 2026-10-30). Reference link only; no code copied into Vertex. See docs/vertex-rebuild/upstream-candidates-20261030.md.'
        ),
        (
          'article-firmai-financial-ml',
          'Financial Machine Learning (Curated List)',
          'FirmAI (firmai)',
          2025,
          'https://github.com/firmai/financial-machine-learning',
          'github:firmai/financial-machine-learning',
          'article',
          'Curated link list and learning material only, not a single strategy whitepaper; no repository license is stated, so no code is copied.',
          'Curated list of financial machine learning tools, papers and resources from reel DfDt0GDR8Oa (candidate #10; no license stated; pinned commit a0fda6ac as evaluated 2026-10-30). Reference link only; no code copied into Vertex. See docs/vertex-rebuild/upstream-candidates-20261030.md.'
        )
    ) AS seed("id", "title", "authors", "year", "source_url", "identifier", "kind", "blockers", "notes")
      ON p."id" = seed."id"
    WHERE
      p."updated_at" <> p."created_at"
      OR p."title" IS DISTINCT FROM seed."title"
      OR p."authors" IS DISTINCT FROM seed."authors"
      OR p."year" IS DISTINCT FROM seed."year"
      OR p."source_url" IS DISTINCT FROM seed."source_url"
      OR p."identifier" IS DISTINCT FROM seed."identifier"
      OR p."kind" IS DISTINCT FROM seed."kind"
      OR p."blockers" IS DISTINCT FROM seed."blockers"
      OR p."notes" IS DISTINCT FROM seed."notes"
      OR p."stage" <> 'queued'
      OR p."verdict" <> 'pending'
      OR p."reported_metrics" <> '{}'::jsonb
      OR p."reproduced_metrics" <> '{}'::jsonb
      OR EXISTS (SELECT 1 FROM "public"."agent_tasks" t WHERE t."paper_id" = p."id")
      OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."paper_id" = p."id")
      OR EXISTS (SELECT 1 FROM "public"."paper_captures" c WHERE c."paper_id" = p."id")
      OR EXISTS (SELECT 1 FROM "public"."strategy_specs" s WHERE s."paper_id" = p."id")
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
