// What: pure rules of the put/call premium and volume ratio lines (put-call-ratio.v1) for
// flow.putCallRatio: ratio division, intraday running cumulative fold over per-minute option print
// sums, and daily session fold with incomplete-gap flags.
// Pure; imports contract types only.
// Research only: the ratios describe stored option prints, never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md ("Put/call ratio (SPY, ES)").
import type {
  FlowPutCallRatioDay,
  FlowPutCallRatioMinute,
  FlowPutCallRatioPoint,
  FlowPutCallRatioRules,
  FlowPutCallRatioTotals,
} from "./contracts/flow.ts";

/** Rules of flow.putCallRatio: stored prints >= $10,000, 14-day retention, parity at 1.00. */
export const PUT_CALL_RATIO_RULES: FlowPutCallRatioRules = Object.freeze({
  minPremiumUsd: 10_000,
  parity: 1,
  retentionDays: 14,
  version: "put-call-ratio.v1",
});

/** Calendar days read before the newest session; covers the full 14-day retention window. */
export const PUT_CALL_RATIO_LOOKBACK_DAYS = 20;

/** One minute of aggregated option prints (matches FlowOptionPrintMinuteRecord). */
export type PutCallMinuteRow = Readonly<{
  minute: Date;
  callPrints: number;
  putPrints: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  lastTradedAt: Date;
  lastPrice: number | null;
}>;

/** One regular options session of aggregated option prints (matches FlowOptionPrintDayRecord). */
export type PutCallDayRow = Readonly<{
  session: string;
  callPrints: number;
  putPrints: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  lastPrice: number | null;
}>;

export type PutCallSessionFold = Readonly<{
  points: FlowPutCallRatioPoint[];
  storedUntil: string | null;
  totals: FlowPutCallRatioTotals;
}>;

/** Put divided by call; null when call is zero or negative so division by zero never happens. */
export const putCallRatioOf = (put: number, call: number): number | null =>
  call > 0 ? put / call : null;

const extremeRatio = (
  points: readonly FlowPutCallRatioPoint[],
  pick: (point: FlowPutCallRatioPoint) => number | null,
  direction: 1 | -1
): FlowPutCallRatioMinute | null => {
  let best: FlowPutCallRatioMinute | null = null;
  for (const point of points) {
    const ratio = pick(point);
    if (ratio === null) continue;
    if (
      best === null ||
      (direction === 1 ? ratio > best.ratio : ratio < best.ratio)
    )
      best = { minute: point.minute, ratio };
  }
  return best;
};

/**
 * Folds one session's per-minute option print aggregates (ascending by minute) into running
 * cumulative sums and running put/call ratios. Carries forward the newest positive underlying
 * price across minutes.
 */
export const foldPutCallSession = (
  minutes: readonly PutCallMinuteRow[]
): PutCallSessionFold => {
  let callPrints = 0;
  let putPrints = 0;
  let callPremium = 0;
  let putPremium = 0;
  let callVolume = 0;
  let putVolume = 0;
  let price: number | null = null;
  let storedUntilMs: number | null = null;
  const points: FlowPutCallRatioPoint[] = [];

  for (const row of minutes) {
    callPrints += row.callPrints;
    putPrints += row.putPrints;
    callPremium += row.callPremium;
    putPremium += row.putPremium;
    callVolume += row.callVolume;
    putVolume += row.putVolume;
    if (row.lastPrice !== null && row.lastPrice > 0) price = row.lastPrice;
    const tradedMs = row.lastTradedAt.getTime();
    if (storedUntilMs === null || tradedMs > storedUntilMs)
      storedUntilMs = tradedMs;

    points.push({
      callPremium,
      callVolume,
      minute: row.minute.toISOString(),
      premiumRatio: putCallRatioOf(putPremium, callPremium),
      price,
      prints: row.callPrints + row.putPrints,
      putPremium,
      putVolume,
      volumeRatio: putCallRatioOf(putVolume, callVolume),
    });
  }

  return {
    points,
    storedUntil:
      storedUntilMs === null ? null : new Date(storedUntilMs).toISOString(),
    totals: {
      callPremium,
      callPrints,
      callVolume,
      premiumHigh: extremeRatio(points, (point) => point.premiumRatio, 1),
      premiumLow: extremeRatio(points, (point) => point.premiumRatio, -1),
      premiumRatio: putCallRatioOf(putPremium, callPremium),
      prints: callPrints + putPrints,
      putPremium,
      putPrints,
      putVolume,
      volumeHigh: extremeRatio(points, (point) => point.volumeRatio, 1),
      volumeLow: extremeRatio(points, (point) => point.volumeRatio, -1),
      volumeRatio: putCallRatioOf(putVolume, callVolume),
    },
  };
};

/**
 * Turns per-session daily aggregates (oldest first) into FlowPutCallRatioDay entries, attaching
 * each session's ratios and whether an open collector gap overlaps that session.
 */
export const foldPutCallDays = (
  days: readonly PutCallDayRow[],
  isIncomplete: (session: string) => boolean
): FlowPutCallRatioDay[] =>
  days.map((day) => ({
    callPremium: day.callPremium,
    callPrints: day.callPrints,
    callVolume: day.callVolume,
    incomplete: isIncomplete(day.session),
    premiumRatio: putCallRatioOf(day.putPremium, day.callPremium),
    price: day.lastPrice !== null && day.lastPrice > 0 ? day.lastPrice : null,
    prints: day.callPrints + day.putPrints,
    putPremium: day.putPremium,
    putPrints: day.putPrints,
    putVolume: day.putVolume,
    session: day.session,
    volumeRatio: putCallRatioOf(day.putVolume, day.callVolume),
  }));
