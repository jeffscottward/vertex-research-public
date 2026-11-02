-- Guarded reversal of 0034_autopilot only.
-- Refuses while any Autopilot campaign or candidate exists, so trial ledgers (every candidate counts
-- as a trial for the deflated Sharpe ratio) are never silently discarded.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."autopilot_candidates", "public"."autopilot_campaigns" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."autopilot_candidates")
    OR EXISTS (SELECT 1 FROM "public"."autopilot_campaigns") THEN
    RAISE EXCEPTION 'autopilot_campaigns or autopilot_candidates is not empty; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."autopilot_candidates_series_idx";
DROP INDEX "public"."autopilot_candidates_fitness_idx";
DROP INDEX "public"."autopilot_candidates_genome_unique_idx";
DROP INDEX "public"."autopilot_campaigns_created_idx";
DROP INDEX "public"."autopilot_campaigns_due_idx";
DROP TABLE "public"."autopilot_candidates";
DROP TABLE "public"."autopilot_campaigns";
COMMIT;
