-- Guarded reversal of 0084_semantic_terms_flow_streamed_tape only.
-- Puts the 0081 text back into the two descriptions only while both rows still have the 0084 text (md5) and no
-- operator mark (edit, certification or certification note); otherwise it changes nothing.
-- Drizzle ledger reconciliation is deliberately not automated. Outside discoverable migrations.
-- Run with `psql -v ON_ERROR_STOP=1` WITHOUT `--single-transaction` (the file has its own BEGIN/COMMIT).
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE "public"."semantic_terms" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF (
    SELECT count(*) FROM "public"."semantic_terms" t
    WHERE (
        (t."id" = 'futures_deep_trades' AND md5(t."description") = '260e81ee7246cab5aa5f0e7840958664')
        OR (t."id" = 'flow_control_state' AND md5(t."description") = 'd34dd3b6fd2c80b5519a24e6bbbd6c84')
      )
      AND t."updated_by" IS NULL AND NOT t."certified" AND t."certified_at" IS NULL
        AND t."certified_by" IS NULL AND t."certification_note" IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'flow control term descriptions differ from 0084 or have operator marks; refusing rollback';
  END IF;
END
$$;
UPDATE "public"."semantic_terms"
SET "description" = 'Futures deep trades: single large trade prints on the futures ES (S&P 500) and NQ (Nasdaq 100). One deep trade is one print at or above the deep-trade size limit of its market; the limit in force is the field limitSize of the tool answer. Unit: contracts. Sign: buy means the print was signed as buyer-initiated, sell as seller-initiated; netVolume is buy volume minus sell volume and is positive when large buying leads. Horizon: the regular session, 09:30 to 16:00 New York; sums start at 09:30. Coverage caveat: the tape is sampled, not complete. The field coverage gives the seconds seen and their approximate share of the rule window; busy periods are seen least, because each fetch holds a fixed number of prints. Every sum is a sum of the sampled trades only, so it is a lower bound, and a minute that was not sampled is a gap, not zero. Sides come from the quote rule where the sampled quotes cover a print, else from the tick rule, which follows the last price change; each trade carries its signing method. Vertex has no market-by-order data, so the size of resting orders is not shown. Vertex has no stored query for this term. Call the tool flow_control with group sp500 (ES) or nasdaq100 (NQ) and read deepTrades and futures. The futures side itself has no state on a sampled tape (reason sampled_tape): report the trades and the coverage, not a state. Research input only; not a trade instruction.', "updated_at" = now()
WHERE "id" = 'futures_deep_trades';
UPDATE "public"."semantic_terms"
SET "description" = 'Flow control state: for one index group (sp500: ES futures with SPX and SPY options; nasdaq100: NQ futures with QQQ and NDX options), one state for the options side (from options_net_drift) and one for the futures side. States: buyers, sellers, balanced, mixed or no_data; no_data always has a reason (market_closed, source_unavailable, storage_failed, stale, gap, session_start, sampled_tape, not_collected). The futures state needs the full futures tape with quote-rule sides. Vertex samples the tape, so in this version the futures side is no_data with the reason sampled_tape, and the agreement of the two sides is not_comparable: it is not computed. The deep trades are still listed (see futures_deep_trades). Sign: buyers is bullish, sellers is bearish. Unit: none; the options side carries its measured ratio and the limit it is compared with, and the field rules holds every number of the rule with its version. Horizon: a trailing window inside the regular session, anchored at 09:30 New York; since is the start of the present state. Coverage caveat: the options side is complete for the vendor filter; the futures side has no state on a sampled tape. The field study says whether the continuation rule was tested and with what verdict. Vertex has no stored query for this term. Call the tool flow_control with group sp500 or nasdaq100. Read the enums, not the label text. For a no_data side report the reason and do not estimate. A state describes recent flow; it is never a trade instruction.', "updated_at" = now()
WHERE "id" = 'flow_control_state';
COMMIT;
