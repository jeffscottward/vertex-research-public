-- Guarded reversal of 0045_market_bar_futures_symbols only.
-- Refuses while any stored series symbol contains "=" (for example ES=F), so imported futures
-- bars are never silently discarded. Drizzle ledger reconciliation is deliberately not automated.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."market_bar_series" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."market_bar_series" WHERE position('=' in "symbol") > 0) THEN
    RAISE EXCEPTION 'market_bar_series has futures symbols with "="; refusing rollback';
  END IF;
END
$$;
ALTER TABLE "public"."market_bar_series" DROP CONSTRAINT "market_bar_series_text_check";
ALTER TABLE "public"."market_bar_series" ADD CONSTRAINT "market_bar_series_text_check" CHECK ("symbol" ~ '^[A-Z0-9.^-]{1,20}$' and "timeframe" in ('1d', '1m') and char_length(trim("source")) between 1 and 300 and "source_sha256" ~ '^[0-9a-f]{64}$');
COMMIT;
