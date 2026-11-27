-- Seed: three learning links from reel DfDt0GDR8Oa (candidates 6, 7 and 10).
-- Card vertex-repos-reel-library-links; docs/vertex-rebuild/upstream-candidates-20261030.md.
-- Stable ids and identifiers; skips any row whose id, identifier or source_url already exists.
-- Existing rows are never overwritten; research/reference only.
INSERT INTO "public"."research_papers" ("id", "title", "authors", "year", "source_url", "identifier", "kind", "stage", "verdict", "blockers", "notes")
SELECT
  v."id",
  v."title",
  v."authors",
  v."year",
  v."source_url",
  v."identifier",
  v."kind",
  v."stage",
  v."verdict",
  v."blockers",
  v."notes"
FROM (
  VALUES
    (
      'article-jpmorgan-python-training',
      'J.P. Morgan Python Training',
      'JPMorgan Chase (jpmorganchase)',
      2026,
      'https://github.com/jpmorganchase/python-training',
      'github:jpmorganchase/python-training',
      'article',
      'queued',
      'pending',
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
      'queued',
      'pending',
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
      'queued',
      'pending',
      'Curated link list and learning material only, not a single strategy whitepaper; no repository license is stated, so no code is copied.',
      'Curated list of financial machine learning tools, papers and resources from reel DfDt0GDR8Oa (candidate #10; no license stated; pinned commit a0fda6ac as evaluated 2026-10-30). Reference link only; no code copied into Vertex. See docs/vertex-rebuild/upstream-candidates-20261030.md.'
    )
) AS v("id", "title", "authors", "year", "source_url", "identifier", "kind", "stage", "verdict", "blockers", "notes")
WHERE NOT EXISTS (
  SELECT 1
  FROM "public"."research_papers" existing
  WHERE lower(existing."source_url") IN (lower(v."source_url"), lower(v."source_url") || '/')
)
ON CONFLICT DO NOTHING;
