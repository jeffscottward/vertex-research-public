-- Guarded rollback for 0100_semantic_terms_smart_money.sql.
-- Run with `psql -v ON_ERROR_STOP=1 -f packages/db/rollback/0100_semantic_terms_smart_money.down.sql`
-- (without --single-transaction, because this script manages its own BEGIN/COMMIT).
-- Refuses if any operator edited or recertified the five smart-money terms, their SQL attributes,
-- or their relationships, or if any other SQL attribute uses the five added grains.
-- Revokes the 11 smart-money SELECT grants from vertex_semantic_reader and restores the 0058 grain check.
-- Drizzle ledger reconciliation is deliberately not automated: after this rollback the 0100 row stays in
-- drizzle.__drizzle_migrations, so `db:migrate` skips 0100; delete that row before re-applying.
BEGIN;

DO $$
DECLARE
  seed_note CONSTANT text := 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).';
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."semantic_terms"
    WHERE "id" IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume')
      AND ("updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0100' OR "certification_note" IS DISTINCT FROM seed_note)
  ) OR EXISTS (
    SELECT 1 FROM "public"."semantic_sql_attributes"
    WHERE "id" IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume')
      AND ("updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0100' OR "certification_note" IS DISTINCT FROM seed_note)
  ) OR EXISTS (
    SELECT 1 FROM "public"."semantic_relationships"
    WHERE "id" IN ('flow_market_premium_session', 'congress_trades_filing', 'form4_transactions_filing', 'form4_owners_filing', 'sec_13f_holdings_filing')
      AND ("updated_by" IS NOT NULL OR NOT "certified" OR "certified_by" IS DISTINCT FROM 'migration 0100' OR "certification_note" IS DISTINCT FROM seed_note)
  ) OR EXISTS (
    SELECT 1 FROM "public"."semantic_sql_attributes"
    WHERE "grain" IN ('ticker', 'filing_trade', 'issuer_cluster', 'filer_position', 'ticker_session')
      AND "id" NOT IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume')
  ) OR EXISTS (
    SELECT 1 FROM "public"."semantic_sql_attributes"
    WHERE "term_id" IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume')
      AND "id" NOT IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume')
  ) THEN
    RAISE EXCEPTION 'smart-money semantic terms have operator edits or unknown grain rows; refusing rollback';
  END IF;

  DELETE FROM "public"."semantic_relationships"
  WHERE "id" IN ('flow_market_premium_session', 'congress_trades_filing', 'form4_transactions_filing', 'form4_owners_filing', 'sec_13f_holdings_filing');

  DELETE FROM "public"."semantic_sql_attributes"
  WHERE "id" IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume');

  DELETE FROM "public"."semantic_terms"
  WHERE "id" IN ('large_options_premium_ranking', 'congress_trades', 'insider_cluster_buys', 'institutional_13f_changes', 'short_volume');

  ALTER TABLE "public"."semantic_sql_attributes" DROP CONSTRAINT "semantic_sql_attributes_grain_check";
  ALTER TABLE "public"."semantic_sql_attributes" ADD CONSTRAINT "semantic_sql_attributes_grain_check"
    CHECK ("semantic_sql_attributes"."grain" in ('strategy', 'run_spec', 'candidate', 'request', 'monitor'));

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader') THEN
    REVOKE SELECT ON TABLE "public"."flow_market_premium", "public"."flow_market_premium_sessions", "public"."openbb_congress_trades", "public"."openbb_congress_filings", "public"."openbb_sec_form4_filings", "public"."openbb_sec_form4_transactions", "public"."openbb_sec_form4_owners", "public"."openbb_sec_13f_filings", "public"."openbb_sec_13f_holdings", "public"."openbb_cusip_symbols", "public"."openbb_short_volume_daily" FROM "vertex_semantic_reader";
  END IF;
END
$$;

COMMIT;
