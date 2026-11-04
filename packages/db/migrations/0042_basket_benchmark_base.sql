-- Benchmark (SPY) close on the basket base date. Nullable, so existing rows stay valid; the API
-- fills it at the next valuation while the base date is still inside the one-year history window.
ALTER TABLE "baskets" ADD COLUMN "benchmark_base_price" numeric;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_benchmark_base_price_check" CHECK ("baskets"."benchmark_base_price" is null or "baskets"."benchmark_base_price" > 0);
