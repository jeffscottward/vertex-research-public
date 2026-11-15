// What: volume delta (buy minus sell volume) per time bucket and the cumulative volume delta
// (CVD) series over the fetched tick window. CVD starts at 0 at the window's first print; it is
// not a session CVD. Unsigned prints count toward volume but not delta.
// Used by: components/portal/order-flow-panel.tsx.
import {
  autoBucketSeconds,
  bucketCount,
  bucketStart,
  MAX_BUCKETS,
} from "./price-grid.ts";
import type { SignedTrade } from "@darkfactory/api";
import { defined } from "./defined.ts";

export type DeltaBucket = Readonly<{
  start: number;
  end: number;
  buy: number;
  sell: number;
  unsigned: number;
  volume: number;
  delta: number;
  /** CVD at the end of this bucket. */
  cvd: number;
}>;

export type CvdPoint = Readonly<{ t: number; cvd: number }>;

export type DeltaSeries = Readonly<{
  bucketSeconds: number;
  buckets: readonly DeltaBucket[];
  /** CVD after each print, oldest first. */
  points: readonly CvdPoint[];
  cvd: number;
  minCvd: number;
  maxCvd: number;
  maxAbsDelta: number;
}>;

export const buildDeltaSeries = (
  trades: readonly SignedTrade[],
  bucketSeconds?: number
): DeltaSeries | null => {
  if (trades.length === 0) return null;
  const ordered = [...trades].sort((a, b) => a.t - b.t);
  const first = defined(ordered[0], "first trade").t;
  const last = defined(ordered.at(-1), "last trade").t;
  const seconds =
    bucketSeconds !== undefined &&
    bucketSeconds > 0 &&
    bucketCount(first, last, bucketSeconds) <= MAX_BUCKETS
      ? bucketSeconds
      : autoBucketSeconds(first, last);
  const firstStart = bucketStart(first, seconds);
  const totals = Array.from(
    { length: bucketCount(first, last, seconds) },
    () => ({ buy: 0, sell: 0, unsigned: 0 })
  );
  const points: CvdPoint[] = [];
  let running = 0;
  let minCvd = 0;
  let maxCvd = 0;
  for (const trade of ordered) {
    const total = defined(
      totals[(bucketStart(trade.t, seconds) - firstStart) / seconds],
      "delta bucket"
    );
    if (trade.side === "buy") {
      total.buy += trade.size;
      running += trade.size;
    } else if (trade.side === "sell") {
      total.sell += trade.size;
      running -= trade.size;
    } else total.unsigned += trade.size;
    minCvd = Math.min(minCvd, running);
    maxCvd = Math.max(maxCvd, running);
    points.push({ cvd: running, t: trade.t });
  }
  let cvd = 0;
  let maxAbsDelta = 0;
  const buckets = totals.map((total, index): DeltaBucket => {
    const delta = total.buy - total.sell;
    cvd += delta;
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta));
    const start = firstStart + index * seconds;
    return {
      ...total,
      cvd,
      delta,
      end: start + seconds,
      start,
      volume: total.buy + total.sell + total.unsigned,
    };
  });
  return {
    bucketSeconds: seconds,
    buckets,
    cvd,
    maxAbsDelta,
    maxCvd,
    minCvd,
    points,
  };
};
