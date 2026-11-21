-- Card vertex-status-api-guard: the moneyness the provider did not report is named "not_reported", not "unknown".
UPDATE "flow_option_prints" SET "moneyness" = 'not_reported' WHERE "moneyness" = 'unknown';
