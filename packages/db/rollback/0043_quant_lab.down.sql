-- Guarded reversal of 0043_quant_lab only.
-- Refuses while any capture or spec row exists so research records are never silently discarded.
-- research_papers, strategies, agent_tasks and backtest_results rows are not touched. No cascading
-- drops, row deletion or truncation. Drizzle ledger reconciliation is deliberately not automated;
-- coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategy_specs", "public"."paper_captures" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."strategy_specs")
    OR EXISTS (SELECT 1 FROM "public"."paper_captures") THEN
    RAISE EXCEPTION 'quant lab tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."strategy_specs_paper_idx";
DROP INDEX "public"."strategy_specs_sha_unique_idx";
DROP TABLE "public"."strategy_specs";
DROP INDEX "public"."paper_captures_paper_idx";
DROP INDEX "public"."paper_captures_doi_version_unique_idx";
DROP TABLE "public"."paper_captures";
COMMIT;
