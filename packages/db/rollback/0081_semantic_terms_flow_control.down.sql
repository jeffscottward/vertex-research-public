-- Guarded reversal of 0081_semantic_terms_flow_control only.
-- Deletes the three vocabulary rows only while none was edited after the seed (updated_by stays null), certified,
-- given a certification decision or note (certified_at, certified_by, certification_note) or a SQL attribute
-- (no silent cascade).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_terms" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."semantic_terms" t
    WHERE t."id" IN ('options_net_drift', 'futures_deep_trades', 'flow_control_state')
      AND (
        t."updated_by" IS NOT NULL
        OR t."certified"
        OR t."certified_at" IS NOT NULL
        OR t."certified_by" IS NOT NULL
        OR t."certification_note" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "public"."semantic_sql_attributes" a WHERE a."term_id" = t."id")
      )
  ) THEN
    RAISE EXCEPTION 'flow control terms have operator edits or linked rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."semantic_terms" WHERE "id" IN ('options_net_drift', 'futures_deep_trades', 'flow_control_state');
COMMIT;
