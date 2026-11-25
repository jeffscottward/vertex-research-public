-- Guarded reversal of 0095_flow_gex_king_node only.
-- This file is not the rollback path: the rollback is "deploy the previous app"; it runs on the
-- migrated database and ignores the nullable column.
-- flow_gex.king_node holds the largest-|GEX| strike recorded at each GEX snapshot. Dropping it loses
-- stored king_node values for good; check `select count(king_node) from flow_gex` first and drop
-- only when it is 0 or the loss is accepted.
-- No cascading drops, truncation or conditional drops.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
ALTER TABLE "public"."flow_gex" DROP COLUMN "king_node";
COMMIT;
