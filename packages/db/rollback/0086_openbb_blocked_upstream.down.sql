-- Guarded reversal of 0086_openbb_blocked_upstream only.
-- Runs of status blocked_upstream become failed runs and keep their reason: the error text gets the
-- prefix "blocked_upstream: " (no run is deleted). Then the status check of 0064 is restored and the
-- index on (job, started_at) is dropped.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_ingest_runs" IN ACCESS EXCLUSIVE MODE;
UPDATE "public"."openbb_ingest_runs"
  SET "status" = 'failed',
      "error" = left('blocked_upstream: ' || coalesce("error", ''), 4000)
  WHERE "status" = 'blocked_upstream';
ALTER TABLE "public"."openbb_ingest_runs" DROP CONSTRAINT "openbb_ingest_runs_check";
ALTER TABLE "public"."openbb_ingest_runs" ADD CONSTRAINT "openbb_ingest_runs_check" CHECK ("openbb_ingest_runs"."job" ~ '^[a-z0-9-]{1,40}$' and "openbb_ingest_runs"."status" in ('ok', 'partial', 'failed') and "openbb_ingest_runs"."rows_received" >= 0 and "openbb_ingest_runs"."rows_written" >= 0 and "openbb_ingest_runs"."finished_at" >= "openbb_ingest_runs"."started_at" and ("openbb_ingest_runs"."error" is null or char_length("openbb_ingest_runs"."error") <= 4000) and ("openbb_ingest_runs"."openbb_version" is null or char_length(trim("openbb_ingest_runs"."openbb_version")) between 1 and 40));
DROP INDEX "public"."openbb_ingest_runs_job_started_at_idx";
COMMIT;
