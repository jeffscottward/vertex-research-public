-- Reversal of 0090_golive_single_leg only.
-- Refuses when a single long option draft (longCall, longPut) exists: such a row has no short
-- strike, so the old NOT NULL and the old structure list cannot hold it. Remove those rows by
-- hand first (an owner decision: they may be approved drafts).
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."golive_drafts" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."golive_drafts" WHERE "structure" IN ('longCall', 'longPut') OR "short_strike" IS NULL) THEN
    RAISE EXCEPTION '0090 rollback refused: single long option drafts exist';
  END IF;
END
$$;
ALTER TABLE "public"."golive_drafts" DROP CONSTRAINT "golive_drafts_short_strike_check";
ALTER TABLE "public"."golive_drafts" DROP CONSTRAINT "golive_drafts_fields_check";
ALTER TABLE "public"."golive_drafts" ADD CONSTRAINT "golive_drafts_fields_check" CHECK ("golive_drafts"."kind" in ('entry', 'exit') and "golive_drafts"."structure" in ('callDebitVertical', 'putDebitVertical', 'putCreditVertical', 'callCreditVertical') and "golive_drafts"."state" in ('proposed', 'approved', 'rejected', 'expired') and ("golive_drafts"."entry_basis" is null or "golive_drafts"."entry_basis" in ('signal_today', 'model_holds_account_does_not')) and ("golive_drafts"."exit_reason" is null or "golive_drafts"."exit_reason" in ('loser_3_trading_days_before_expiry', 'winner_expiry_day_1545_et', 'monthly_roll')) and ("golive_drafts"."node_badge_at_decision" is null or "golive_drafts"."node_badge_at_decision" in ('running-disarmed', 'running-armed', 'down', 'unknown')) and "golive_drafts"."exit_rule" = 'owner_standing_rule_v1' and "golive_drafts"."expiry" ~ '^[0-9]{8}$' and "golive_drafts"."long_strike" > 0 and "golive_drafts"."long_strike" < 'Infinity'::double precision and "golive_drafts"."short_strike" > 0 and "golive_drafts"."short_strike" < 'Infinity'::double precision and "golive_drafts"."long_strike" <> "golive_drafts"."short_strike" and char_length("golive_drafts"."sleeve_key") between 1 and 40 and char_length("golive_drafts"."symbol") between 1 and 10 and jsonb_typeof("golive_drafts"."signal_facts") = 'array');
ALTER TABLE "public"."golive_drafts" ALTER COLUMN "short_strike" SET NOT NULL;
COMMIT;
