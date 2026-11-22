// What: the rules of the hedging pressure line (hedging-pressure.v1) for flow.hedgingPressure: the
// sign of a print by its aggressor side, the Black-Scholes delta of a print at its trade time, and
// the fold of one options session's prints into running sums per minute.
// Pure; imports contract types, the stored print row, the side sign table and the pricing model.
// Research only: the line is an estimate of dealer hedging, never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md ("Hedging pressure (SPY, ES)").
import type {
  FlowHedgingMinute,
  FlowHedgingPoint,
  FlowHedgingPressureRules,
  FlowHedgingTotals,
} from "./contracts/flow.ts";
import { type FlowOptionPrintRow, OPTION_SIDE_SIGN } from "./flow-options.ts";
import { OPTIONS_CHAIN_RISK_FREE_RATE } from "./options-chain-merge.ts";
import { bsDelta } from "./options-engine/pricing.ts";

/**
 * Version 1. The rate is the options chain assumption. The yield is the SPY yield of the pricing
 * model (DIVIDEND_YIELD in options-engine/pricing.ts; the test pins the two equal); SPX has the
 * same index yield. The fallback volatility replaces the vendor placeholder IV (0.0477%) of deep
 * in-the-money prints.
 */
export const HEDGING_PRESSURE_RULES: FlowHedgingPressureRules = Object.freeze({
  dividendYield: 0.015,
  rate: OPTIONS_CHAIN_RISK_FREE_RATE,
  version: "hedging-pressure.v1",
  volFallback: 0.2,
});

/** Most prints of one session that the fold reads (about 7.8 times the busiest stored day). */
export const HEDGING_READ_CAP = 200_000;

/** The stored fields of a print that the line uses. */
export type HedgingPrint = Pick<
  FlowOptionPrintRow,
  | "tradedAt"
  | "right"
  | "strike"
  | "dte"
  | "iv"
  | "underlyingPrice"
  | "side"
  | "size"
>;

/** A stored IV below this (percent) is the vendor placeholder, not a solved volatility. */
const IV_FLOOR_PERCENT = 1;
const DAYS_PER_YEAR = 365;
const CONTRACT_MULTIPLIER = 100;
const MINUTE_MS = 60_000;

/** +1 when the customer bought, -1 when the customer sold, 0 for no sign (mid and unknown). */
export const printSign = (side: HedgingPrint["side"]): number =>
  OPTION_SIDE_SIGN[side];

/**
 * The delta of a print at its trade time, or null when it cannot be priced: a missing IV, days to
 * expiry or underlying price, or an input that the model refuses (not finite, a spot, strike or
 * volatility of 0 or less). `ivAdjusted`: the IV was below 1% and the fallback volatility was used.
 */
export const printDelta = (
  print: Pick<
    HedgingPrint,
    "right" | "strike" | "dte" | "iv" | "underlyingPrice"
  >,
  rules: FlowHedgingPressureRules = HEDGING_PRESSURE_RULES
): Readonly<{ delta: number; ivAdjusted: boolean }> | null => {
  const { dte, iv, underlyingPrice } = print;
  if (iv === null || dte === null || underlyingPrice === null) return null;
  const ivAdjusted = iv < IV_FLOOR_PERCENT;
  const sigma = ivAdjusted ? rules.volFallback : iv / 100;
  try {
    const delta = bsDelta(
      print.right,
      underlyingPrice,
      print.strike,
      Math.max(dte, 0) / DAYS_PER_YEAR,
      rules.rate,
      rules.dividendYield,
      sigma
    );
    return { delta, ivAdjusted };
  } catch {
    return null;
  }
};

export type HedgingFold = Readonly<{
  totals: FlowHedgingTotals;
  points: FlowHedgingPoint[];
  /** Trade time of the newest counted print; null without one. */
  storedUntil: string | null;
}>;

/** The point with the largest minuteNet above 0, or below 0 for `direction` -1; the first wins. */
const largestMinute = (
  points: readonly FlowHedgingPoint[],
  direction: 1 | -1
): FlowHedgingMinute | null => {
  let best: FlowHedgingPoint | null = null;
  for (const point of points)
    if (point.minuteNet * direction > (best?.minuteNet ?? 0) * direction)
      best = point;
  return best === null
    ? null
    : { minute: best.minute, minuteNet: best.minuteNet };
};

/**
 * Folds the prints of one options session (already limited to the session) in trade time order;
 * equal times keep the input order. Per print: count it; no sign: not signed; no delta: not
 * priced; else add sign × delta × size × 100 × underlying price to the running sums. One point
 * per minute with at least one counted print, holding the running sums at the end of the minute.
 * A point's price is the newest underlying price above 0 of any print up to the end of its
 * minute; as a counted print always has a price, a point never carries a price from an earlier
 * minute.
 */
export const foldHedgingPressure = (
  prints: readonly HedgingPrint[],
  rules: FlowHedgingPressureRules = HEDGING_PRESSURE_RULES
): HedgingFold => {
  const ordered = [...prints].sort(
    (a, b) => a.tradedAt.getTime() - b.tradedAt.getTime()
  );
  const totals = {
    calls: 0,
    gross: 0,
    ivAdjusted: 0,
    net: 0,
    notPriced: 0,
    notSigned: 0,
    prints: 0,
    puts: 0,
    signed: 0,
  };
  const points: FlowHedgingPoint[] = [];
  let price: number | null = null;
  let storedUntil: Date | null = null;

  for (const print of ordered) {
    totals.prints += 1;
    const { underlyingPrice } = print;
    const minute = new Date(
      Math.floor(print.tradedAt.getTime() / MINUTE_MS) * MINUTE_MS
    ).toISOString();
    if (
      underlyingPrice !== null &&
      Number.isFinite(underlyingPrice) &&
      underlyingPrice > 0
    )
      price = underlyingPrice;
    const last = points.at(-1);
    if (last?.minute === minute) last.price = price;

    const sign = printSign(print.side);
    if (sign === 0) {
      totals.notSigned += 1;
      continue;
    }
    totals.signed += 1;
    const priced = printDelta(print, rules);
    // A print with a delta has an underlying price; the second test only narrows the type.
    if (priced === null || underlyingPrice === null) {
      totals.notPriced += 1;
      continue;
    }
    if (priced.ivAdjusted) totals.ivAdjusted += 1;
    const notional =
      sign * priced.delta * print.size * CONTRACT_MULTIPLIER * underlyingPrice;
    totals.net += notional;
    if (print.right === "call") totals.calls += notional;
    else totals.puts += notional;
    totals.gross += Math.abs(notional);
    storedUntil = print.tradedAt;

    const point: FlowHedgingPoint =
      last?.minute === minute
        ? last
        : { calls: 0, minute, minuteNet: 0, net: 0, price, prints: 0, puts: 0 };
    if (point !== last) points.push(point);
    point.minuteNet += notional;
    point.prints += 1;
    point.net = totals.net;
    point.calls = totals.calls;
    point.puts = totals.puts;
  }

  return {
    points,
    storedUntil: storedUntil?.toISOString() ?? null,
    totals: {
      ...totals,
      largestFall: largestMinute(points, -1),
      largestRise: largestMinute(points, 1),
    },
  };
};
