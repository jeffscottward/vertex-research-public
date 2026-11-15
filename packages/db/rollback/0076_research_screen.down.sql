-- Reversal of 0076_research_screen only.
-- No emptiness guard, on purpose: every row here is derived. The rows, the stored bars and the
-- Swinglytics snapshot are filled again by the next runs. The history of runs and the last tick
-- are lost, which is accepted for a rollback.
-- Rows and bars go first (they reference the runs), then runs, scheduler and Swinglytics.
-- No cascading drops, row deletion or truncation. Drizzle ledger reconciliation is deliberately
-- not automated; coordinate it separately before re-application. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."research_screen_rows", "public"."research_screen_bars",
  "public"."research_screen_runs", "public"."research_screen_scheduler",
  "public"."research_screen_swinglytics" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."research_screen_rows";
DROP TABLE "public"."research_screen_bars";
DROP TABLE "public"."research_screen_runs";
DROP TABLE "public"."research_screen_scheduler";
DROP TABLE "public"."research_screen_swinglytics";
COMMIT;
