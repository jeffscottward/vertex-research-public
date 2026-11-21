-- Guarded reversal of 0083_flow_capture_streamed only.
-- This file is not the rollback path: the rollback is "deploy the previous app". The previous app
-- writes capture 'sampled' only and works with the wider check, so it runs on the migrated database.
-- This file deletes every deep trade with capture 'streamed'. These rows cannot be fetched again.
-- Run it only on an explicit owner decision. Check
-- `select count(*) from flow_large_trades where capture = 'streamed'` first.
-- It then restores the check that permits capture 'sampled' only. Rows with capture 'sampled' stay.
-- No cascading drops, truncation or conditional drops. Drizzle ledger reconciliation is deliberately
-- not automated: after this rollback the 0083 row stays in drizzle.__drizzle_migrations, so
-- `db:migrate` skips 0083 and the narrow check stays. To re-apply, delete that ledger row (match its
-- hash) first, or apply 0083 alone again.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."flow_large_trades" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "public"."flow_large_trades" WHERE "capture" = 'streamed';
ALTER TABLE "public"."flow_large_trades" DROP CONSTRAINT "flow_large_trades_check";
ALTER TABLE "public"."flow_large_trades" ADD CONSTRAINT "flow_large_trades_check" CHECK ("flow_large_trades"."symbol" in ('ES', 'NQ') and "flow_large_trades"."side" in ('buy', 'sell') and "flow_large_trades"."signing" in ('quote', 'tick') and "flow_large_trades"."capture" in ('sampled') and "flow_large_trades"."seq" >= 0 and "flow_large_trades"."price" > 0 and "flow_large_trades"."limit_size" > 0 and "flow_large_trades"."size" >= "flow_large_trades"."limit_size");
COMMIT;
