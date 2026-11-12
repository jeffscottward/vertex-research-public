-- Guarded reversal of 0067_golive_drafts only.
-- Refuses while any go-live draft is approved, so a stored owner approval is never silently
-- discarded. Proposed, rejected and expired drafts, the generator run rows and the plan versions do
-- not block the rollback: the rig generator sends the drafts again and scripts/golive/seed-plan.ts
-- writes the plan again. No cascading drops, truncation or conditional drops. Drizzle ledger
-- reconciliation is deliberately not automated; coordinate it separately before re-application.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."golive_drafts" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."golive_draft_runs" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "public"."golive_plans" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."golive_drafts" WHERE "state" = 'approved') THEN
    RAISE EXCEPTION 'golive_drafts has an approved draft; refusing rollback';
  END IF;
END
$$;
DROP INDEX "public"."golive_drafts_trading_day_idx";
DROP TABLE "public"."golive_drafts";
DROP TABLE "public"."golive_draft_runs";
DROP INDEX "public"."golive_plans_in_force_idx";
DROP INDEX "public"."golive_plans_version_idx";
DROP TABLE "public"."golive_plans";
COMMIT;
