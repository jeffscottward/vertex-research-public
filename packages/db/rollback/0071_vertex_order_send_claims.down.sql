-- Guarded reversal of 0071_vertex_order_send_claims only.
-- Roll the web build back first: a build that sends go-live drafts writes every go-live intent row
-- with a claim and refuses to send while this table is missing. Refuses while any claim has no
-- result or reconciliation row in audit_records written at or after it (a send in flight, or one
-- whose outcome was never written), so a claim that still blocks a second send is never silently
-- dropped. Such a claim clears by itself: the next order preview after the settle window reconciles
-- the intent and writes a vertex.order.reconciled row. The intent and outcome rows stay in
-- audit_records. Drops the table only (the primary key and the check go with it). No cascading
-- drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately not
-- automated: after this rollback the 0071 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0071 and the table stays missing. To re-apply, delete that ledger row (match
-- its hash) first; where the migration was applied by hand with psql (QuantVPS) there is no ledger
-- row, so run the migration file again. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."vertex_order_send_claims" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."vertex_order_send_claims" c
    WHERE NOT EXISTS (
      SELECT 1 FROM "public"."audit_records" a
      WHERE a."entity_type" = 'vertex_order'
        AND a."entity_id" = c."order_ref"
        AND a."action" IN ('vertex.order.result', 'vertex.order.reconciled')
        AND a."created_at" >= c."claimed_at"
    )
  ) THEN
    RAISE EXCEPTION 'vertex_order_send_claims has a send with no outcome; refusing rollback';
  END IF;
END
$$;
DROP TABLE "public"."vertex_order_send_claims";
COMMIT;
