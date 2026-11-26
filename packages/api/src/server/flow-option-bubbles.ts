// What: pure assembly of flow-option-bubbles.v1 (flow.optionBubbles) from stored per-minute
// underlying price summaries, top big option prints, open collector gaps, and options freshness.
// Used by: packages/api/src/server/flow.ts (the flow.optionBubbles handler).
// Research only: option print bubbles describe stored trades, never a trade signal.
// Doc: docs/vertex-rebuild/designs/vertex-viz-option-bubbles/design.md.
import {
  FLOW_OPTION_BUBBLES_VERSION,
  type FlowOptionBubbles,
  type FlowOptionBubblesMinPremiumUsd,
  type FlowOptionBubblesSymbol,
} from "../contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "../flow-features.ts";
import {
  foldOptionBubbles,
  OPTION_BUBBLES_RULES,
  type OptionBubblesGapRow,
  type OptionBubblesMinuteRow,
  type OptionBubblesPrintRow,
} from "../flow-option-bubbles-rules.ts";
import { optionsSessionRange } from "./flow-control.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

export type FlowOptionBubblesRows = Readonly<{
  symbol: FlowOptionBubblesSymbol;
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd;
  now: Date;
  /** New York date of the newest options session; null when no print is stored. */
  session: string | null;
  minutes: readonly OptionBubblesMinuteRow[];
  prints: readonly OptionBubblesPrintRow[];
  gaps: readonly OptionBubblesGapRow[];
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

/**
 * Builds flow-option-bubbles.v1 of one symbol. Without a session: empty pricePoints/bubbles/gaps
 * and zero totals. With a session: folds the session's underlying price path and top big prints
 * above minPremiumUsd with clipped open-gap metadata and options source freshness.
 */
export const buildFlowOptionBubbles = (
  rows: FlowOptionBubblesRows
): FlowOptionBubbles => {
  const options = buildSourceFreshness(rows, "options");
  const ticker = FLOW_INSTRUMENTS[rows.symbol].optionsTicker;

  if (rows.session === null) {
    return {
      bubbles: [],
      gaps: [],
      minPremiumUsd: rows.minPremiumUsd,
      options,
      pricePoints: [],
      rules: OPTION_BUBBLES_RULES,
      schemaVersion: FLOW_OPTION_BUBBLES_VERSION,
      session: null,
      sessionEnd: null,
      sessionStart: null,
      storedUntil: null,
      symbol: rows.symbol,
      ticker,
      totals: {
        askSidePremium: 0,
        bearishPremium: 0,
        bidSidePremium: 0,
        bullishPremium: 0,
        callBubbles: 0,
        callPremium: 0,
        latestPrice: null,
        maxBubblePremium: 0,
        plottedBubbles: 0,
        putBubbles: 0,
        putPremium: 0,
        sessionGrossPremium: 0,
        sessionPrints: 0,
        shownBubbles: 0,
        unplottedBubbles: 0,
        unsignedPremium: 0,
      },
      truncated: false,
      unread: null,
    };
  }

  const range = optionsSessionRange(rows.session);
  const folded = foldOptionBubbles({
    gaps: rows.gaps,
    minPremiumUsd: rows.minPremiumUsd,
    minutes: rows.minutes,
    prints: rows.prints,
    range,
  });

  return {
    bubbles: folded.bubbles,
    gaps: folded.gaps,
    minPremiumUsd: rows.minPremiumUsd,
    options,
    pricePoints: folded.pricePoints,
    rules: OPTION_BUBBLES_RULES,
    schemaVersion: FLOW_OPTION_BUBBLES_VERSION,
    session: rows.session,
    sessionEnd: range.to.toISOString(),
    sessionStart: range.from.toISOString(),
    storedUntil: folded.storedUntil,
    symbol: rows.symbol,
    ticker,
    totals: folded.totals,
    truncated: folded.truncated,
    unread: folded.unread,
  };
};
