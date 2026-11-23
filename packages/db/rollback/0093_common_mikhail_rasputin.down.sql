-- Guarded reversal of 0093_common_mikhail_rasputin only.
-- Refuse to discard known source provenance. Export it or get approval to accept the loss before changing this guard.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (this file owns BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."openbb_option_iv_daily" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."openbb_option_iv_daily" WHERE "source" <> 'unknown'
  ) THEN
    RAISE EXCEPTION 'Refusing to drop known OpenBB IV source provenance; export it or accept the loss first.';
  END IF;
END;
$$;
ALTER TABLE "public"."openbb_option_iv_daily" DROP CONSTRAINT "openbb_option_iv_daily_check";
ALTER TABLE "public"."openbb_option_iv_daily" DROP COLUMN "source";
ALTER TABLE "public"."openbb_option_iv_daily" ADD CONSTRAINT "openbb_option_iv_daily_check" CHECK ("openbb_option_iv_daily"."underlying" ~ '^[A-Z0-9.^=-]{1,16}$' and ("openbb_option_iv_daily"."underlying_price" is null or ("openbb_option_iv_daily"."underlying_price" > '-Infinity'::float8 and "openbb_option_iv_daily"."underlying_price" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."atm_iv_30d" is null or ("openbb_option_iv_daily"."atm_iv_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."atm_iv_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."put_iv_25d_30d" is null or ("openbb_option_iv_daily"."put_iv_25d_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."put_iv_25d_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_iv_25d_30d" is null or ("openbb_option_iv_daily"."call_iv_25d_30d" > '-Infinity'::float8 and "openbb_option_iv_daily"."call_iv_25d_30d" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."net_gex" is null or ("openbb_option_iv_daily"."net_gex" > '-Infinity'::float8 and "openbb_option_iv_daily"."net_gex" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."gamma_flip" is null or ("openbb_option_iv_daily"."gamma_flip" > '-Infinity'::float8 and "openbb_option_iv_daily"."gamma_flip" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_wall" is null or ("openbb_option_iv_daily"."call_wall" > '-Infinity'::float8 and "openbb_option_iv_daily"."call_wall" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."put_wall" is null or ("openbb_option_iv_daily"."put_wall" > '-Infinity'::float8 and "openbb_option_iv_daily"."put_wall" < 'Infinity'::float8)) and ("openbb_option_iv_daily"."call_oi" is null or "openbb_option_iv_daily"."call_oi" >= 0) and ("openbb_option_iv_daily"."put_oi" is null or "openbb_option_iv_daily"."put_oi" >= 0) and ("openbb_option_iv_daily"."call_volume" is null or "openbb_option_iv_daily"."call_volume" >= 0) and ("openbb_option_iv_daily"."put_volume" is null or "openbb_option_iv_daily"."put_volume" >= 0) and ("openbb_option_iv_daily"."contracts" is null or "openbb_option_iv_daily"."contracts" >= 0));
COMMIT;
