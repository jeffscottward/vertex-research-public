-- Data: the strategy DSL indicator of SuperTrend, AlphaTrend and Chandelier Exit in their term descriptions
-- (card vertex-trend-terms-dsl-names; the DSL names arrived with PR #244, after the 0074 seed).
-- Each UPDATE appends one sentence (joined by one space) to the 0074 text. Guard: the row still has the 0074 text
-- (md5) and no operator mark (edit, certification or certification note); other rows are left alone, so a second
-- run changes nothing. updated_at moves, so a certify call from a page that loaded the old text is refused.
UPDATE "semantic_terms"
SET "description" = "description" || ' In the strategy DSL it is the indicator "supertrend" with length (the ATR length), multiple (the factor) and output "line" or "direction", where direction is +1 in an up trend and -1 in a down trend (the opposite of the chart script sign): {"type": "indicator", "name": "supertrend", "length": 10, "multiple": 3, "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.', "updated_at" = now()
WHERE "id" = 'supertrend' AND md5("description") = '1e753394be20acfaaacaa94dc8426e32'
  AND "updated_by" IS NULL AND NOT "certified" AND "certified_at" IS NULL
  AND "certified_by" IS NULL AND "certification_note" IS NULL;
--> statement-breakpoint
UPDATE "semantic_terms"
SET "description" = "description" || ' In the strategy DSL it is the indicator "alphaTrend" with length, multiple (the coefficient), momentum "mfi" or "rsi" and output "line" or "direction" (+1 up, -1 down): {"type": "indicator", "name": "alphaTrend", "length": 14, "multiple": 1, "momentum": "mfi", "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.', "updated_at" = now()
WHERE "id" = 'alphatrend' AND md5("description") = 'feef3addb9dd92b001b35ef3a8b9589a'
  AND "updated_by" IS NULL AND NOT "certified" AND "certified_at" IS NULL
  AND "certified_by" IS NULL AND "certification_note" IS NULL;
--> statement-breakpoint
UPDATE "semantic_terms"
SET "description" = "description" || ' In the strategy DSL it is the indicator "chandelierExit" with length, multiple and output "longStop", "shortStop" or "direction" (+1 up, -1 down): {"type": "indicator", "name": "chandelierExit", "length": 22, "multiple": 3, "output": "direction"}. For now it runs only in research runs on the rig (a server backtest refuses it), and frame monthly bars do not have it.', "updated_at" = now()
WHERE "id" = 'chandelier_exit' AND md5("description") = '15846362e90195315bd35d6c8fd3f49c'
  AND "updated_by" IS NULL AND NOT "certified" AND "certified_at" IS NULL
  AND "certified_by" IS NULL AND "certification_note" IS NULL;
