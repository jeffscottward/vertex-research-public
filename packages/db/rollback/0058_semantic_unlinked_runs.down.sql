-- Guarded reversal of 0058_semantic_unlinked_runs only.
-- Refuses while either run-spec SQL attribute carries operator work: an edit (updated_by set), a
-- certification, or a certification note other than the seed's (a certification removed with a note). Deletes the two run_spec attributes, then restores the 0056 shape (one SQL attribute per
-- term). The per-strategy attributes of 0056 are untouched. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_sql_attributes" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."semantic_sql_attributes" WHERE "grain" = 'run_spec' AND ("updated_by" IS NOT NULL OR "certified" OR "certified_by" IS NOT NULL OR "certification_note" IS DISTINCT FROM 'Needs owner certification: written by the agent in migration 0058 (card vertex-semantic-unlinked-runs); not certified by the agent.'))
    OR EXISTS (SELECT 1 FROM "public"."semantic_sql_attributes" WHERE "grain" = 'run_spec' AND "id" NOT IN ('backtest_sharpe_run_spec', 'backtest_max_drawdown_run_spec')) THEN
    RAISE EXCEPTION 'run-spec SQL attributes have operator work or unknown rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."semantic_sql_attributes" WHERE "grain" = 'run_spec' AND "id" IN ('backtest_sharpe_run_spec', 'backtest_max_drawdown_run_spec');
ALTER TABLE "public"."semantic_sql_attributes" DROP CONSTRAINT "semantic_sql_attributes_grain_check";
DROP INDEX "public"."semantic_sql_attributes_term_grain_idx";
ALTER TABLE "public"."semantic_sql_attributes" DROP COLUMN "grain";
CREATE UNIQUE INDEX "semantic_sql_attributes_term_idx" ON "public"."semantic_sql_attributes" USING btree ("term_id");
COMMIT;
