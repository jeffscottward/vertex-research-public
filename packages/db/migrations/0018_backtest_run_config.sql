-- Optional run assumptions and benchmark equity for agent-reported backtests.
-- Both columns are nullable; existing rows stay valid. Idempotent (IF NOT EXISTS) like 0017.
ALTER TABLE "backtest_results" ADD COLUMN IF NOT EXISTS "run_config" jsonb;
--> statement-breakpoint
ALTER TABLE "backtest_results" ADD COLUMN IF NOT EXISTS "benchmark" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_results_extras_check') THEN
    ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_extras_check" CHECK (("backtest_results"."run_config" is null or (jsonb_typeof("backtest_results"."run_config") = 'object' and octet_length("backtest_results"."run_config"::text) <= 2048)) and ("backtest_results"."benchmark" is null or (jsonb_typeof("backtest_results"."benchmark") = 'object' and octet_length("backtest_results"."benchmark"::text) <= 524288)));
  END IF;
END
$$;
