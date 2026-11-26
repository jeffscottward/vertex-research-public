// What: pure rules of option print bubbles on the intraday price chart (option-bubbles.v1) for
// flow.optionBubbles: capping largest prints above the premium floor, mapping stored side/moneyness
// values to contract enums, directional sign via shared OPTION_SIDE_SIGN, clipped open collector
// gap bands, 1-minute underlying price points, and honest plotted/unplotted accounting.
// Pure; imports contract types and OPTION_SIDE_SIGN only.
// Research only: option print bubbles describe stored trades, never a trade signal.
// Doc: docs/vertex-rebuild/designs/vertex-viz-option-bubbles/design.md.
import {
  FLOW_MONEYNESS,
  FLOW_OPTION_BUBBLES_MAX_BUBBLES,
  FLOW_OPTION_BUBBLES_MAX_GAPS,
  FLOW_OPTION_BUBBLES_MAX_POINTS,
  FLOW_OPTION_SIDES,
  type FlowConsolidation,
  type FlowHedgingUnread,
  type FlowMoneyness,
  type FlowOptionBubblesGap,
  type FlowOptionBubblesItem,
  type FlowOptionBubblesMinPremiumUsd,
  type FlowOptionBubblesPricePoint,
  type FlowOptionBubblesRules,
  type FlowOptionBubblesTotals,
  type FlowOptionSentiment,
  type FlowOptionSide,
  type FlowOptionTicker,
} from "./contracts/flow.ts";
import {
  OPTION_SIDE_SIGN,
  oiFlags,
  type StoredMoneyness,
  type StoredOptionSide,
} from "./flow-options.ts";

/** Rules of flow.optionBubbles: collector stores >= $10,000 for 14 days; UI defaults to $250,000, max 120 bubbles. */
export const OPTION_BUBBLES_RULES: FlowOptionBubblesRules = Object.freeze({
  defaultMinPremiumUsd: 250_000,
  maxBubbles: FLOW_OPTION_BUBBLES_MAX_BUBBLES,
  retentionDays: 14,
  storedMinPremiumUsd: 10_000,
  version: "option-bubbles.v1",
});

/** One per-minute option-print summary row from Postgres (readOptionPrintMinutes). */
export type OptionBubblesMinuteRow = Readonly<{
  minute: Date;
  callPrints: number;
  putPrints: number;
  callPremium: number;
  putPremium: number;
  lastTradedAt: Date;
  lastPrice: number | null;
}>;

/** One big option print row from Postgres (readLargeOptionPrints). */
export type OptionBubblesPrintRow = Readonly<{
  id: string;
  ticker: FlowOptionTicker;
  tradedAt: Date;
  right: "call" | "put";
  strike: number;
  expiry: string;
  dte: number | null;
  size: number;
  price: number | null;
  premium: number;
  underlyingPrice: number | null;
  side: StoredOptionSide;
  sentiment: FlowOptionSentiment;
  consolidation: FlowConsolidation;
  moneyness: StoredMoneyness;
  unusual: boolean;
  goldenSweep: boolean;
  opening: boolean;
  volumeOverOi: boolean;
  /** Open interest on the print; 0 means the Opening and Vol > OI flags are not known. */
  openInterest: number | null;
  iv: number | null;
}>;

/** Open collector gap range (inclusive QuantData bounds). */
export type OptionBubblesGapRow = Readonly<{
  startTime: Date;
  endTime: Date;
}>;

export type OptionBubblesFoldInput = Readonly<{
  minutes: readonly OptionBubblesMinuteRow[];
  prints: readonly OptionBubblesPrintRow[];
  range: Readonly<{ from: Date; to: Date }>;
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd;
  gaps: readonly OptionBubblesGapRow[];
  maxBubbles?: number;
}>;

export type OptionBubblesFold = Readonly<{
  gaps: FlowOptionBubblesGap[];
  unread: FlowHedgingUnread | null;
  pricePoints: FlowOptionBubblesPricePoint[];
  bubbles: FlowOptionBubblesItem[];
  truncated: boolean;
  storedUntil: string | null;
  totals: FlowOptionBubblesTotals;
}>;

const MINUTE_MS = 60_000;

/**
 * Directional sign of one option print from the shared OPTION_SIDE_SIGN table:
 * +1 bullish (call at ask/above ask, or put at bid/below bid),
 * -1 bearish (put at ask/above ask, or call at bid/below bid),
 *  0 unsigned (mid or unknown).
 */
export const bubbleDirectionalSign = (
  right: "call" | "put",
  side: StoredOptionSide
): -1 | 0 | 1 => {
  const sideSign = Object.hasOwn(OPTION_SIDE_SIGN, side)
    ? OPTION_SIDE_SIGN[side]
    : 0;
  if (sideSign === 0) return 0;
  return (sideSign * (right === "call" ? 1 : -1)) as -1 | 1;
};

interface ClippedGap {
  endMs: number;
  startMs: number;
}

const clipSessionGaps = (
  gaps: readonly OptionBubblesGapRow[],
  fromMs: number,
  toMs: number
): ClippedGap[] => {
  const clipped: ClippedGap[] = [];
  for (const gap of gaps) {
    const startMs = gap.startTime.getTime();
    const endMs = gap.endTime.getTime();
    if (startMs >= toMs || endMs < fromMs) continue;
    clipped.push({
      endMs: Math.min(endMs, toMs),
      startMs: Math.max(startMs, fromMs),
    });
  }
  clipped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return clipped;
};

const minuteOverlapsGap = (
  minuteStartMs: number,
  gaps: readonly ClippedGap[]
): boolean => {
  const minuteEndMs = minuteStartMs + MINUTE_MS;
  return gaps.some(
    (gap) =>
      gap.startMs < minuteEndMs &&
      (gap.endMs > minuteStartMs ||
        (gap.endMs === gap.startMs && gap.startMs === minuteStartMs))
  );
};

const buildUnreadSummary = (
  clipped: readonly ClippedGap[]
): FlowHedgingUnread | null => {
  const [first] = clipped;
  if (first === undefined) return null;
  let latest = first.endMs;
  for (const gap of clipped) {
    if (gap.endMs > latest) latest = gap.endMs;
  }
  return {
    from: new Date(first.startMs).toISOString(),
    ranges: clipped.length,
    to: new Date(latest).toISOString(),
  };
};

/**
 * Folds per-minute option print summaries, top big option prints, and open collector gaps of one
 * options session [09:30, 16:15) New York time into the bounded option-bubbles.v1 payload.
 */
export const foldOptionBubbles = (
  input: OptionBubblesFoldInput
): OptionBubblesFold => {
  const requestedCap =
    input.maxBubbles !== undefined && Number.isFinite(input.maxBubbles)
      ? Math.trunc(input.maxBubbles)
      : FLOW_OPTION_BUBBLES_MAX_BUBBLES;
  const maxBubbles = Math.min(
    Math.max(1, requestedCap),
    FLOW_OPTION_BUBBLES_MAX_BUBBLES
  );
  const fromMs = input.range.from.getTime();
  const toMs = input.range.to.getTime();

  const clippedGaps = clipSessionGaps(input.gaps, fromMs, toMs);
  const gaps: FlowOptionBubblesGap[] = clippedGaps
    .slice(0, FLOW_OPTION_BUBBLES_MAX_GAPS)
    .map((gap) => ({
      end: new Date(gap.endMs).toISOString(),
      start: new Date(gap.startMs).toISOString(),
    }));
  const unread = buildUnreadSummary(clippedGaps);

  let sessionPrints = 0;
  let sessionGrossPremium = 0;
  let newestMs: number | null = null;
  let latestPrice: number | null = null;

  const sortedMinutes = [...input.minutes].sort(
    (a, b) => a.minute.getTime() - b.minute.getTime()
  );
  const pricePoints: FlowOptionBubblesPricePoint[] = [];

  for (const row of sortedMinutes) {
    sessionPrints += row.callPrints + row.putPrints;
    sessionGrossPremium += row.callPremium + row.putPremium;
    const tradedMs = row.lastTradedAt.getTime();
    newestMs = newestMs === null ? tradedMs : Math.max(newestMs, tradedMs);
    const minuteMs = row.minute.getTime();
    const price =
      row.lastPrice !== null &&
      Number.isFinite(row.lastPrice) &&
      row.lastPrice > 0
        ? row.lastPrice
        : null;
    if (
      price !== null &&
      minuteMs >= fromMs &&
      minuteMs < toMs &&
      pricePoints.length < FLOW_OPTION_BUBBLES_MAX_POINTS
    ) {
      pricePoints.push({
        minute: row.minute.toISOString(),
        price,
        unread: minuteOverlapsGap(minuteMs, clippedGaps),
      });
      latestPrice = price;
    }
  }

  const eligiblePrints = input.prints.filter((print) => {
    const tradedMs = print.tradedAt.getTime();
    return (
      tradedMs >= fromMs &&
      tradedMs < toMs &&
      Number.isFinite(print.premium) &&
      print.premium >= input.minPremiumUsd &&
      Number.isFinite(print.strike) &&
      print.strike > 0
    );
  });
  // Keep largest prints first when capping, breaking ties identically to SQL (tradedAt desc, id desc).
  const rankedPrints = [...eligiblePrints].sort(
    (a, b) =>
      b.premium - a.premium ||
      b.tradedAt.getTime() - a.tradedAt.getTime() ||
      (b.id < a.id ? -1 : 1)
  );
  const truncated = rankedPrints.length > maxBubbles;
  const keptPrints = rankedPrints.slice(0, maxBubbles);

  // Return chronologically (at asc, id asc) for deterministic chart/keyboard navigation.
  keptPrints.sort(
    (a, b) =>
      a.tradedAt.getTime() - b.tradedAt.getTime() || (a.id < b.id ? -1 : 1)
  );

  let plottedBubbles = 0;
  let unplottedBubbles = 0;
  let callBubbles = 0;
  let putBubbles = 0;
  let callPremium = 0;
  let putPremium = 0;
  let askSidePremium = 0;
  let bidSidePremium = 0;
  let unsignedPremium = 0;
  let bullishPremium = 0;
  let bearishPremium = 0;
  let maxBubblePremium = 0;
  let latestBubblePrice: number | null = null;

  const bubbles: FlowOptionBubblesItem[] = keptPrints.map((print) => {
    const tradedMs = print.tradedAt.getTime();
    newestMs = newestMs === null ? tradedMs : Math.max(newestMs, tradedMs);

    const underlyingPrice =
      print.underlyingPrice !== null &&
      Number.isFinite(print.underlyingPrice) &&
      print.underlyingPrice > 0
        ? print.underlyingPrice
        : null;
    if (underlyingPrice === null) {
      unplottedBubbles += 1;
    } else {
      plottedBubbles += 1;
      latestBubblePrice = underlyingPrice;
    }

    const side: FlowOptionSide =
      FLOW_OPTION_SIDES.find((value) => value === print.side) ??
      "not_classified";
    const directionalSign = bubbleDirectionalSign(print.right, print.side);

    if (print.right === "call") {
      callBubbles += 1;
      callPremium += print.premium;
    } else {
      putBubbles += 1;
      putPremium += print.premium;
    }

    if (side === "ask" || side === "above_ask") askSidePremium += print.premium;
    else if (side === "bid" || side === "below_bid")
      bidSidePremium += print.premium;
    else unsignedPremium += print.premium;

    if (directionalSign > 0) bullishPremium += print.premium;
    else if (directionalSign < 0) bearishPremium += print.premium;

    if (print.premium > maxBubblePremium) maxBubblePremium = print.premium;

    const moneyness: FlowMoneyness =
      FLOW_MONEYNESS.find((value) => value === print.moneyness) ??
      "not_reported";
    const dte =
      print.dte !== null && Number.isFinite(print.dte) && print.dte >= 0
        ? print.dte
        : null;
    const iv = print.iv !== null && Number.isFinite(print.iv) ? print.iv : null;
    const price =
      print.price !== null && Number.isFinite(print.price) ? print.price : null;

    return {
      at: print.tradedAt.toISOString(),
      consolidation: print.consolidation,
      contract: `${print.ticker} ${print.expiry} ${print.strike}${print.right === "call" ? "C" : "P"}`,
      directionalSign,
      dte,
      expiry: print.expiry,
      goldenSweep: print.goldenSweep,
      id: print.id,
      iv,
      moneyness,
      premium: print.premium,
      price,
      right: print.right,
      sentiment: print.sentiment,
      side,
      size: print.size,
      strike: print.strike,
      underlyingPrice,
      unusual: print.unusual,
      ...oiFlags(print),
    };
  });

  return {
    bubbles,
    gaps,
    pricePoints,
    storedUntil: newestMs === null ? null : new Date(newestMs).toISOString(),
    totals: {
      askSidePremium,
      bearishPremium,
      bidSidePremium,
      bullishPremium,
      callBubbles,
      callPremium,
      latestPrice: latestPrice ?? latestBubblePrice,
      maxBubblePremium,
      plottedBubbles,
      putBubbles,
      putPremium,
      sessionGrossPremium,
      sessionPrints,
      shownBubbles: bubbles.length,
      unplottedBubbles,
      unsignedPremium,
    },
    truncated,
    unread,
  };
};
