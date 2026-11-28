-- Reversal of 0104_jev_verdict_log_append_only only: removes the append-only triggers.
-- Rows are not changed. Drizzle ledger reconciliation is deliberately not automated.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS jev_verdict_log_no_truncate ON "public"."jev_verdict_log";
DROP TRIGGER IF EXISTS jev_verdict_log_immutable ON "public"."jev_verdict_log";
DROP FUNCTION IF EXISTS "public".jev_verdict_log_reject_mutation();
COMMIT;
