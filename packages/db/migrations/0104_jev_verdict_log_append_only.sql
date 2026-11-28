-- Append-only enforcement for jev_verdict_log (card vertex-jev-verdict-log-owner-grants).
-- On production the migrations run as the app role "vertex_research", so that role owns the
-- table and the SELECT+INSERT-only grant of 0082 does not limit it (an owner has every
-- privilege). These triggers fire for every role, the owner included, so UPDATE, DELETE and
-- TRUNCATE fail. Only a DDL change (DROP TRIGGER / DISABLE TRIGGER) can remove the guard;
-- the app has no code path that runs DDL. Same pattern as the 0008 immutable audit tables.
CREATE FUNCTION jev_verdict_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'jev_verdict_log is append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jev_verdict_log_immutable
BEFORE UPDATE OR DELETE ON "jev_verdict_log"
FOR EACH ROW EXECUTE FUNCTION jev_verdict_log_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jev_verdict_log_no_truncate
BEFORE TRUNCATE ON "jev_verdict_log"
FOR EACH STATEMENT EXECUTE FUNCTION jev_verdict_log_reject_mutation();
