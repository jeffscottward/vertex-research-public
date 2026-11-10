// What: exhaustion runs — consecutive time buckets that keep pushing price to new highs (or lows)
// while traded volume and the delta in the push direction both shrink ("higher price, less
// fuel"). Research display only; a heuristic flag, not a signal.
// Used by: components/portal/order-flow-views.tsx (DeltaChart).
import type { SignedTrade } from "@darkfactory/api";
import { bucketStart } from "./price-grid.ts";

export type ExhaustionRun = Readonly<{
  direction: "up" | "down";
  /** Start of the first and last bucket in the run (epoch seconds, like trade.t). */
  start: number;
  end: number;
  /** Number of buckets in the run (≥ minBuckets). */
  buckets: number;
  /** Volume and push-direction delta of the first and last bucket. */
  firstVolume: number;
  lastVolume: number;
  firstDelta: number;
  lastDelta: number;
}>;

interface Bar {
  delta: number;
  high: number;
  low: number;
  start: number;
  volume: number;
}

const bars = (trades: readonly SignedTrade[], seconds: number): Bar[] => {
  const byStart = new Map<number, Bar>();
  for (const trade of trades) {
    const start = bucketStart(trade.t, seconds);
    const bar = byStart.get(start) ?? {
      delta: 0,
      high: trade.price,
      low: trade.price,
      start,
      volume: 0,
    };
    bar.high = Math.max(bar.high, trade.price);
    bar.low = Math.min(bar.low, trade.price);
    bar.volume += trade.size;
    if (trade.side === "buy") bar.delta += trade.size;
    else if (trade.side === "sell") bar.delta -= trade.size;
    byStart.set(start, bar);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
};

const continues = (prev: Bar, next: Bar, direction: "up" | "down") =>
  next.volume < prev.volume &&
  (direction === "up"
    ? next.high > prev.high && next.delta < prev.delta
    : next.low < prev.low && next.delta > prev.delta);

/** Find maximal exhaustion runs of at least `minBuckets` traded buckets. */
export const findExhaustion = (
  trades: readonly SignedTrade[],
  bucketSeconds: number,
  minBuckets = 3
): readonly ExhaustionRun[] => {
  if (bucketSeconds <= 0 || trades.length === 0) return [];
  const series = bars(trades, bucketSeconds);
  const runs: ExhaustionRun[] = [];
  for (const direction of ["up", "down"] as const) {
    let from = 0;
    for (let index = 1; index <= series.length; index += 1) {
      const prev = series[index - 1];
      const next = series[index];
      if (
        next !== undefined &&
        prev !== undefined &&
        next.start - prev.start === bucketSeconds &&
        continues(prev, next, direction)
      )
        continue;
      const first = series[from];
      const last = series[index - 1];
      if (
        first !== undefined &&
        last !== undefined &&
        index - from >= minBuckets
      ) {
        const sign = direction === "up" ? 1 : -1;
        runs.push({
          buckets: index - from,
          direction,
          end: last.start,
          firstDelta: sign * first.delta,
          firstVolume: first.volume,
          lastDelta: sign * last.delta,
          lastVolume: last.volume,
          start: first.start,
        });
      }
      from = index;
    }
  }
  return runs.sort((a, b) => a.start - b.start);
};
