// What: footprint grid from signed prints: time buckets x price levels with sell (bid-hit) and
// buy (ask-lift) volume per cell, per-bucket delta, point of control (POC), diagonal stacked
// imbalances (≥3:1 across ≥3 adjacent price steps) and absorption (shared rules from @darkfactory/api).
// It covers only the fetched tick window, never a full session.
// Used by: components/portal/order-flow-panel.tsx.
import {
  type AbsorptionSide,
  absorptionOf,
  findStacks,
  type SignedTrade,
} from "@darkfactory/api";
import { defined } from "./defined.ts";
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

/** Auto price step keeps the footprint to at most this many rows. */
const FOOTPRINT_MAX_LEVELS = 40;
/** Most rows a chosen price step may produce. */
const MAX_LEVELS = 400;

export type FootprintCellImbalance = "buy" | "sell" | "both" | null;

export type FootprintCell = Readonly<{
  price: number;
  buy: number;
  sell: number;
  /** Prints neither rule could sign (no quote and no earlier different price). */
  unsigned: number;
  volume: number;
  delta: number;
  /** Present when this price level belongs to a ≥3-level diagonal imbalance stack. */
  stackedImbalance: FootprintCellImbalance;
}>;

export type FootprintStackedImbalance = Readonly<{
  side: "buy" | "sell";
  lowPrice: number;
  highPrice: number;
  levels: number;
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
  open: number | null;
  close: number | null;
  /** Level with the most volume; null for an empty bucket. */
  poc: number | null;
  /** Diagonal imbalance stacks (≥3:1 on ≥3 adjacent price steps) inside this bucket. */
  stackedImbalances: readonly FootprintStackedImbalance[];
  /** Strong one-sided aggression (30+ prints, |delta| ≥ 40% of volume) that did not move price its way. */
  absorption: AbsorptionSide | null;
}>;

export type Footprint = Readonly<{
  bucketSeconds: number;
  priceStep: number;
  tickSize: number;
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
  prints: readonly SignedTrade[],
  options: FootprintOptions = {}
): Footprint | null => {
  const trades = prints.filter((trade) => Number.isFinite(trade.price));
  if (trades.length === 0) return null;
  const tickSize =
    typeof options.tickSize === "number" && options.tickSize > 0
      ? options.tickSize
      : // Finite prices only, so a tick size always exists.
        (deriveTickSize(trades.map((trade) => trade.price)) as number);
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
      : autoPriceStep(tickSize, low, high, FOOTPRINT_MAX_LEVELS);
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
  const opens = new Array<number | null>(count).fill(null);
  const closes = new Array<number | null>(count).fill(null);
  const ordered = [...trades].sort((a, b) => a.t - b.t);
  for (const trade of ordered) {
    const index =
      (bucketStart(trade.t, bucketSeconds) - firstStart) / bucketSeconds;
    const grid = defined(grids[index], "footprint bucket");
    tradeCounts[index] = defined(tradeCounts[index], "bucket count") + 1;
    if (opens[index] === null) opens[index] = trade.price;
    closes[index] = trade.price;
    const price = groupPrice(trade.price, priceStep);
    const cell = grid.get(price) ?? { buy: 0, sell: 0, unsigned: 0 };
    if (trade.side === "buy") cell.buy += trade.size;
    else if (trade.side === "sell") cell.sell += trade.size;
    else cell.unsigned += trade.size;
    grid.set(price, cell);
  }

  let maxCellVolume = 0;
  const buckets = grids.map((grid, index): FootprintBucket => {
    const stepLevels = new Map<number, { buy: number; sell: number }>();
    for (const [price, cell] of grid.entries())
      stepLevels.set(Math.round(price / priceStep), {
        buy: cell.buy,
        sell: cell.sell,
      });
    const runs = findStacks(stepLevels);
    const buyStackIndices = new Set<number>();
    const sellStackIndices = new Set<number>();
    const stackedImbalances: FootprintStackedImbalance[] = runs.map((run) => {
      const target = run.side === "buy" ? buyStackIndices : sellStackIndices;
      for (let step = run.startIndex; step <= run.endIndex; step += 1)
        target.add(step);
      return {
        highPrice: groupPrice(run.endIndex * priceStep, priceStep),
        levels: run.levels,
        lowPrice: groupPrice(run.startIndex * priceStep, priceStep),
        side: run.side,
      };
    });
    const cells = [...grid.entries()]
      .map(([price, cell]) => {
        const volume = cell.buy + cell.sell + cell.unsigned;
        maxCellVolume = Math.max(maxCellVolume, volume);
        const stepIndex = Math.round(price / priceStep);
        const inBuy = buyStackIndices.has(stepIndex);
        const inSell = sellStackIndices.has(stepIndex);
        const stackedImbalance: FootprintCellImbalance =
          inBuy && inSell ? "both" : inBuy ? "buy" : inSell ? "sell" : null;
        return {
          ...cell,
          delta: cell.buy - cell.sell,
          price,
          stackedImbalance,
          volume,
        };
      })
      .sort((a, b) => b.price - a.price);
    const sum = (key: "buy" | "sell" | "unsigned") =>
      cells.reduce((total, cell) => total + cell[key], 0);
    const buy = sum("buy");
    const sell = sum("sell");
    const unsigned = sum("unsigned");
    const delta = buy - sell;
    const volume = buy + sell + unsigned;
    const bucketTrades = defined(tradeCounts[index], "bucket count");
    const open = opens[index] ?? null;
    const close = closes[index] ?? null;
    const start = firstStart + index * bucketSeconds;
    return {
      absorption:
        open === null || close === null
          ? null
          : absorptionOf(bucketTrades, volume, delta, open, close),
      buy,
      cells,
      close,
      delta,
      end: start + bucketSeconds,
      open,
      poc: pointOfControl(cells),
      sell,
      stackedImbalances,
      start,
      trades: bucketTrades,
      unsigned,
      volume,
    };
  });

  const top = groupPrice(high, priceStep);
  const rows = levelCount(low, high, priceStep);
  const levels = Array.from({ length: rows }, (_, index) =>
    groupPrice(top - index * priceStep + priceStep / 2, priceStep)
  );
  return { bucketSeconds, buckets, levels, maxCellVolume, priceStep, tickSize };
};
