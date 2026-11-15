-- Guarded reversal of 0057_strategy_catalog_qc_ports only.
-- Deletes the catalog rows only while none was edited or is referenced by a preset, spec, backtest,
-- backtest run, optimization run, deployment request or Autopilot candidate (no silent SET NULL).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."strategy_definition_revisions" d WHERE d."created_by" = 'migration:0061'
  ) THEN
    RAISE EXCEPTION 'the qc-port definitions of 0061 still exist; roll back 0061 first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."strategies" s
    WHERE s."id" IN ('strategy-seed-qc-iv-rank-gate', 'strategy-seed-qc-turn-of-the-month', 'strategy-seed-qc-opex-week', 'strategy-seed-qc-regime-put-vrp', 'strategy-seed-qc-futures-trend-carry', 'strategy-seed-qc-vix-term-gate', 'strategy-seed-qc-asset-class-trend', 'strategy-seed-qc-momentum-rotation', 'strategy-seed-qc-gold-fed-model', 'strategy-seed-qc-oil-predicts-equity', 'strategy-seed-qc-same-month-seasonality')
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
DELETE FROM "public"."strategies" WHERE "id" IN ('strategy-seed-qc-iv-rank-gate', 'strategy-seed-qc-turn-of-the-month', 'strategy-seed-qc-opex-week', 'strategy-seed-qc-regime-put-vrp', 'strategy-seed-qc-futures-trend-carry', 'strategy-seed-qc-vix-term-gate', 'strategy-seed-qc-asset-class-trend', 'strategy-seed-qc-momentum-rotation', 'strategy-seed-qc-gold-fed-model', 'strategy-seed-qc-oil-predicts-equity', 'strategy-seed-qc-same-month-seasonality');
COMMIT;
