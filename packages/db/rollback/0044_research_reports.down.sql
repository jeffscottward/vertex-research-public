-- Guarded reversal of 0044_research_reports only.
-- Refuses while any research report row exists, so imported research is never silently discarded.
-- Re-import is possible from the source workspace (bun run vertex:research-reports:import).
-- No cascading drops, row deletion or truncation. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."research_report_datasets", "public"."research_report_revisions",
  "public"."research_reports", "public"."research_report_categories",
  "public"."research_company_research" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."research_reports")
    OR EXISTS (SELECT 1 FROM "public"."research_report_revisions")
    OR EXISTS (SELECT 1 FROM "public"."research_report_datasets")
    OR EXISTS (SELECT 1 FROM "public"."research_report_categories")
    OR EXISTS (SELECT 1 FROM "public"."research_company_research") THEN
    RAISE EXCEPTION 'research report tables are not empty; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."research_report_datasets";
DROP TABLE "public"."research_report_revisions";
DROP TABLE "public"."research_reports";
DROP TABLE "public"."research_report_categories";
DROP INDEX "public"."research_company_research_report_idx";
DROP TABLE "public"."research_company_research";
COMMIT;
