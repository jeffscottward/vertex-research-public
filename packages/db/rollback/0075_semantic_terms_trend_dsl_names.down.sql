-- Guarded reversal of 0075_semantic_terms_trend_dsl_names only.
-- Removes the DSL sentence from the three descriptions (back to the 0074 text) only while all three rows still have
-- the 0075 text (md5) and no operator mark (edit, certification or certification note); otherwise it changes nothing.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_terms" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF (
    SELECT count(*) FROM "public"."semantic_terms" t
    WHERE (
        (t."id" = 'supertrend' AND md5(t."description") = 'cc5c9f22f19c413e9b35702774fc61cd')
        OR (t."id" = 'alphatrend' AND md5(t."description") = '90bda954270d2312a63bf4fe9e89f38e')
        OR (t."id" = 'chandelier_exit' AND md5(t."description") = 'cfe0dbbb5b94d7128376cd8928c17a21')
      )
      AND t."updated_by" IS NULL AND NOT t."certified" AND t."certified_at" IS NULL
        AND t."certified_by" IS NULL AND t."certification_note" IS NULL
  ) <> 3 THEN
    RAISE EXCEPTION 'trend indicator term descriptions differ from 0075 or have operator marks; refusing rollback';
  END IF;
END
$$;
UPDATE "public"."semantic_terms"
SET "description" = left("description", length("description") - length(' In the strategy DSL it is the indicator "supertrend" with length (the ATR length), multiple (the factor) and output "line" or "direction", where direction is +1 in an up trend and -1 in a down trend (the opposite of the chart script sign): {"type": "indicator", "name": "supertrend", "length": 10, "multiple": 3, "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.')), "updated_at" = now()
WHERE "id" = 'supertrend';
UPDATE "public"."semantic_terms"
SET "description" = left("description", length("description") - length(' In the strategy DSL it is the indicator "alphaTrend" with length, multiple (the coefficient), momentum "mfi" or "rsi" and output "line" or "direction" (+1 up, -1 down): {"type": "indicator", "name": "alphaTrend", "length": 14, "multiple": 1, "momentum": "mfi", "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.')), "updated_at" = now()
WHERE "id" = 'alphatrend';
UPDATE "public"."semantic_terms"
SET "description" = left("description", length("description") - length(' In the strategy DSL it is the indicator "chandelierExit" with length, multiple and output "longStop", "shortStop" or "direction" (+1 up, -1 down): {"type": "indicator", "name": "chandelierExit", "length": 22, "multiple": 3, "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.')), "updated_at" = now()
WHERE "id" = 'chandelier_exit';
COMMIT;
