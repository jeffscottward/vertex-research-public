-- Guarded reversal of 0028_paper_forward_runner only.
-- Refuses while any paper runner is running so a scheduled runner is never silently orphaned.
-- Recorded paper points and trades stay on the monitor; only the runner state columns are removed.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."forward_drift_monitors" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."forward_drift_monitors" WHERE "paper_status" = 'running') THEN
    RAISE EXCEPTION 'a paper runner is running; stop it before rollback';
  END IF;
END
$$;
ALTER TABLE "public"."forward_drift_monitors" DROP CONSTRAINT "forward_drift_monitors_paper_note_check";
ALTER TABLE "public"."forward_drift_monitors" DROP CONSTRAINT "forward_drift_monitors_paper_status_check";
ALTER TABLE "public"."forward_drift_monitors" DROP COLUMN "paper_ticked_at";
ALTER TABLE "public"."forward_drift_monitors" DROP COLUMN "paper_status";
ALTER TABLE "public"."forward_drift_monitors" DROP COLUMN "paper_note";
COMMIT;
