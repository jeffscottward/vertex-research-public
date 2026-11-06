// What: footprint grid from signed prints: time buckets x price levels with sell (bid-hit) and
// buy (ask-lift) volume per cell, per-bucket delta and the point of control (POC) per bucket.
// It covers only the fetched tick window, never a full session.
// Used by: components/portal/order-flow-panel.tsx.
import {
  autoBucketSeconds,
  autoPriceStep,
  bucketCount,
  bucketStart,
  deriveTickSize,
  groupPrice,
  levelCount,
  MAX_BUCKETS,
} from "./price-grid.ts";
import type { SignedTrade } from "./trade-signing.ts";

/** Auto price step keeps the footprint to at most this many rows. */
const FOOTPRINT_MAX_LEVELS = 40;
/** Most rows a chosen price step may produce. */
const MAX_LEVELS = 400;

export type FootprintCell = Readonly<{
  price: number;
  buy: number;
  sell: number;
  /** Prints neither rule could sign (no quote and no earlier different price). */
  unsigned: number;
  volume: number;
  delta: number;
}>;

export type FootprintBucket = Readonly<{
  start: number;
  end: number;
  /** Price-level cells with volume, highest price first. */
  cells: readonly FootprintCell[];
  buy: number;
  sell: number;
  unsigned: number;
  volume: number;
  delta: number;
  trades: number;
  /** Level with the most volume; null for an empty bucket. */
  poc: number | null;
}>;

export type Footprint = Readonly<{
  bucketSeconds: number;
  priceStep: number;
  tickSize: number | null;
  /** Every level from the window high to low, highest first. */
  levels: readonly number[];
  buckets: readonly FootprintBucket[];
  maxCellVolume: number;
}>;

export type FootprintOptions = Readonly<{
  /** Omit for the automatic size (about 6-20 buckets over the window). */
  bucketSeconds?: number | undefined;
  /** Omit to use the tick (widened until at most 40 levels). */
  priceStep?: number | undefined;
  /** IBKR minTick; omit or null to derive the tick from the prints (gcd of price gaps). */
  tickSize?: number | null | undefined;
}>;

/**
 * Highest-volume level; ties go to the level nearest the middle of the bucket's range, then
 * the lower price, so the POC is stable whatever order the prints arrived in.
 */
export const pointOfControl = (
  levels: readonly { price: number; volume: number }[]
): number | null => {
  if (levels.length === 0) return null;
  const prices = levels.map((level) => level.price);
  const middle = (Math.max(...prices) + Math.min(...prices)) / 2;
  let best: { price: number; volume: number } | null = null;
  for (const level of levels) {
    if (level.volume <= 0) continue;
    if (
      best === null ||
      level.volume > best.volume ||
      (level.volume === best.volume &&
        (Math.abs(level.price - middle) < Math.abs(best.price - middle) ||
          (Math.abs(level.price - middle) === Math.abs(best.price - middle) &&
            level.price < best.price)))
    )
      best = level;
  }
  return best?.price ?? null;
};

export const buildFootprint = (
  trades: readonly SignedTrade[],
  options: FootprintOptions = {}
): Footprint | null => {
  if (trades.length === 0) return null;
  const tickSize =
    typeof options.tickSize === "number" && options.tickSize > 0
      ? options.tickSize
      : deriveTickSize(trades.map((trade) => trade.price));
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const trade of trades) {
    low = Math.min(low, trade.price);
    high = Math.max(high, trade.price);
    first = Math.min(first, trade.t);
    last = Math.max(last, trade.t);
  }
  // A chosen step or size that would explode the grid falls back to the automatic one.
  const chosenStep = options.priceStep;
  const priceStep =
    chosenStep !== undefined &&
    chosenStep > 0 &&
    levelCount(low, high, chosenStep) <= MAX_LEVELS
      ? chosenStep
      : autoPriceStep(tickSize ?? 0.01, low, high, FOOTPRINT_MAX_LEVELS);
  const chosenSeconds = options.bucketSeconds;
  const bucketSeconds =
    chosenSeconds !== undefined &&
    chosenSeconds > 0 &&
    bucketCount(first, last, chosenSeconds) <= MAX_BUCKETS
      ? chosenSeconds
      : autoBucketSeconds(first, last);

  const firstStart = bucketStart(first, bucketSeconds);
  const count = bucketCount(first, last, bucketSeconds);
  const grids = Array.from(
    { length: count },
    () => new Map<number, { buy: number; sell: number; unsigned: number }>()
  );
  const tradeCounts = new Array<number>(count).fill(0);
  for (const trade of trades) {
    const index =
      (bucketStart(trade.t, bucketSeconds) - firstStart) / bucketSeconds;
    const grid = grids[index];
    if (grid === undefined) continue;
    tradeCounts[index] = (tradeCounts[index] ?? 0) + 1;
    const price = groupPrice(trade.price, priceStep);
    const cell = grid.get(price) ?? { buy: 0, sell: 0, unsigned: 0 };
    if (trade.side === "buy") cell.buy += trade.size;
    else if (trade.side === "sell") cell.sell += trade.size;
    else cell.unsigned += trade.size;
    grid.set(price, cell);
  }

  let maxCellVolume = 0;
  const buckets = grids.map((grid, index): FootprintBucket => {
    const cells = [...grid.entries()]
      .map(([price, cell]) => {
        const volume = cell.buy + cell.sell + cell.unsigned;
        maxCellVolume = Math.max(maxCellVolume, volume);
        return { ...cell, delta: cell.buy - cell.sell, price, volume };
      })
      .sort((a, b) => b.price - a.price);
    const sum = (key: "buy" | "sell" | "unsigned") =>
      cells.reduce((total, cell) => total + cell[key], 0);
    const buy = sum("buy");
    const sell = sum("sell");
    const unsigned = sum("unsigned");
    const start = firstStart + index * bucketSeconds;
    return {
      buy,
      cells,
      delta: buy - sell,
      end: start + bucketSeconds,
      poc: pointOfControl(cells),
      sell,
      start,
      trades: tradeCounts[index] ?? 0,
      unsigned,
      volume: buy + sell + unsigned,
    };
  });

  const top = groupPrice(high, priceStep);
  const rows = levelCount(low, high, priceStep);
  const levels = Array.from({ length: rows }, (_, index) =>
    groupPrice(top - index * priceStep + priceStep / 2, priceStep)
  );
  return { bucketSeconds, buckets, levels, maxCellVolume, priceStep, tickSize };
};
