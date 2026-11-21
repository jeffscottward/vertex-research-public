-- Reversal of 0091_flow_moneyness_not_reported only.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
UPDATE "flow_option_prints" SET "moneyness" = 'unknown' WHERE "moneyness" = 'not_reported';
