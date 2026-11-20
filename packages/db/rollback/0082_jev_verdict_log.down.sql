-- Guarded reversal of 0082_jev_verdict_log only. This file is not the rollback path: the rollback is
-- "deploy the previous app", which runs on the migrated database (the previous app does not know
-- the table and never writes it).
-- Dropping jev_verdict_log loses every logged JEV verdict for good: verdicts made before the log
-- existed are not kept anywhere else. Export first, as the database owner:
--   \copy (SELECT * FROM jev_verdict_log ORDER BY decided_at, id) TO 'jev_verdict_log.csv' CSV HEADER
-- Then set the confirmation in the same session: SET vertex.jev_verdict_log_exported = 'yes';
-- Without it this transaction stops while the table holds rows.
-- No cascading drops or truncation. Drizzle ledger reconciliation is deliberately not automated:
-- after this rollback the 0082 row stays in drizzle.__drizzle_migrations.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."jev_verdict_log")
     AND coalesce(current_setting('vertex.jev_verdict_log_exported', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'jev_verdict_log holds rows: export them, then SET vertex.jev_verdict_log_exported = ''yes''';
  END IF;
END
$$;
DROP TABLE "public"."jev_verdict_log";
COMMIT;
