-- Optional agent rating series for a backtest result (research stance labels; never an order).
-- Nullable, so existing rows stay valid. Idempotent (IF NOT EXISTS) like 0018.
ALTER TABLE "backtest_results" ADD COLUMN IF NOT EXISTS "rating_series" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_results_rating_series_check') THEN
    ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_rating_series_check" CHECK ("backtest_results"."rating_series" is null or (jsonb_typeof("backtest_results"."rating_series") = 'object' and octet_length("backtest_results"."rating_series"::text) <= 65536));
  END IF;
END
$$;
