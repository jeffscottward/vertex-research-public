-- Guarded reversal of 0068_strategy_catalog_triple_rsi only.
-- Deletes the catalog row only while it was not edited and no preset, spec, backtest, backtest run,
-- optimization run, deployment request or Autopilot candidate references it (no silent SET NULL).
-- The backtest study in research_studies (id triple-rsi) is kept; it has no link to the row.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."strategies" s
    WHERE s."id" IN ('strategy-seed-triple-rsi')
      AND (
        s."updated_at" <> s."created_at"
        OR EXISTS (SELECT 1 FROM "public"."strategy_presets" p WHERE p."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_results" b WHERE b."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."backtest_runs" r WHERE r."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."optimization_runs" o WHERE o."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."strategy_specs" q WHERE q."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."deployment_requests" d WHERE d."strategy_id" = s."id")
        OR EXISTS (SELECT 1 FROM "public"."autopilot_candidates" a WHERE a."strategy_id" = s."id")
      )
  ) THEN
    RAISE EXCEPTION 'catalog strategy has operator edits or linked rows; refusing rollback';
  END IF;
END
$$;
DELETE FROM "public"."strategies" WHERE "id" IN ('strategy-seed-triple-rsi');
COMMIT;
