-- Guarded reversal of 0056_semantic_layer only.
-- Refuses while any term, SQL attribute or relationship carries operator work: updated_by set, a removed
-- certification, or certified_by other than the seed's 'migration 0056'. Revokes the CONNECT, USAGE and
-- SELECT grants of "vertex_semantic_reader" in this database but keeps the role: it is cluster-wide and
-- other databases on the server may use it. No cascading drops outside these three tables. Drizzle
-- ledger reconciliation is deliberately not automated; coordinate it separately before re-application.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_terms", "public"."semantic_sql_attributes", "public"."semantic_relationships" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."semantic_terms" WHERE "updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0056')
    OR EXISTS (SELECT 1 FROM "public"."semantic_sql_attributes" WHERE "updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0056')
    OR EXISTS (SELECT 1 FROM "public"."semantic_relationships" WHERE "updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0056') THEN
    RAISE EXCEPTION 'semantic layer has operator edits; refusing rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader') THEN
    REVOKE SELECT ON TABLE "public"."strategies", "public"."backtest_runs", "public"."autopilot_campaigns", "public"."autopilot_candidates", "public"."deployment_requests", "public"."forward_drift_monitors" FROM "vertex_semantic_reader";
    REVOKE USAGE ON SCHEMA "public" FROM "vertex_semantic_reader";
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM "vertex_semantic_reader"', current_database());
  END IF;
END
$$;
DROP TABLE "public"."semantic_sql_attributes";
DROP TABLE "public"."semantic_relationships";
DROP TABLE "public"."semantic_terms";
COMMIT;
