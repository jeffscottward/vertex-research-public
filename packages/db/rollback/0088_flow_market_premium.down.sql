-- Guarded reversal of 0088_flow_market_premium only. This file is not the rollback path: the rollback
-- is "deploy the previous app", which runs on the migrated database (the wider check and the new
-- table do not affect it).
-- Before this file runs, a person must delete the market_premium rows from flow_samples; else the
-- narrower check fails and the transaction rolls back. Dropping flow_market_premium and its
-- ledger loses the stored sessions; the gap fill can fetch them again only while QuantData keeps
-- them (at least 371 days on 2026-11-20). Keep the tables unless they must go: the previous app
-- runs on the migrated database.
-- No cascading drops, truncation or row deletes. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0088 row stays in drizzle.__drizzle_migrations.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
ALTER TABLE "public"."flow_samples" DROP CONSTRAINT "flow_samples_check";
ALTER TABLE "public"."flow_samples" ADD CONSTRAINT "flow_samples_check" CHECK ("flow_samples"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ') and "flow_samples"."source" in ('ticks', 'depth', 'options', 'gex', 'net_drift') and "flow_samples"."status" in ('ok', 'empty', 'unavailable', 'skipped') and "flow_samples"."items" >= 0 and length(coalesce("flow_samples"."message", '')) <= 300);
LOCK TABLE "public"."flow_market_premium", "public"."flow_market_premium_sessions" IN ACCESS EXCLUSIVE MODE;
DROP TABLE "public"."flow_market_premium";
DROP TABLE "public"."flow_market_premium_sessions";
COMMIT;
