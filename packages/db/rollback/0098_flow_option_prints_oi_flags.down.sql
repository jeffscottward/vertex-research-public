-- Guarded reversal of 0098_flow_option_prints_oi_flags only. The normal rollback path is to deploy
-- the previous app, which runs cleanly against nullable opening/volume_over_oi because
-- flow_option_prints_check restricts NULL flags to open_interest = 0 rows.
-- This down migration refuses to run while any row has NULL opening or volume_over_oi.
-- No row deletes, updates, truncation or cascading drops. Drizzle ledger reconciliation is
-- deliberately not automated: after this rollback the 0098 row stays in drizzle.__drizzle_migrations.
-- Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
DO $$
DECLARE
  remaining bigint := 0;
BEGIN
  SELECT count(*)
    FROM "public"."flow_option_prints"
    WHERE "opening" IS NULL OR "volume_over_oi" IS NULL
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'cannot roll back 0098_flow_option_prints_oi_flags while % rows have NULL opening or volume_over_oi', remaining;
  END IF;
END
$$;
ALTER TABLE "public"."flow_option_prints" DROP CONSTRAINT "flow_option_prints_check";
ALTER TABLE "public"."flow_option_prints" ALTER COLUMN "opening" SET NOT NULL;
ALTER TABLE "public"."flow_option_prints" ALTER COLUMN "volume_over_oi" SET NOT NULL;
ALTER TABLE "public"."flow_option_prints" ADD CONSTRAINT "flow_option_prints_check" CHECK ("flow_option_prints"."symbol" in ('SPY', 'ES', 'QQQ', 'NQ', 'IWM', 'NVDA') and "flow_option_prints"."ticker" in ('SPY', 'SPX', 'QQQ', 'NDX', 'IWM', 'NVDA') and "flow_option_prints"."right" in ('call', 'put') and "flow_option_prints"."premium" >= 0 and length("flow_option_prints"."id") <= 64);
COMMIT;
