// What: pure rules for the Bookmap-style liquidity heatmap (flow-liquidity-heatmap.v1): time
// column bucketing, price-step sizing with guaranteed <= 80-bucket invariant, level sanitization,
// p95 intensity scaling, single-cell bid/ask merging, large-trade truncation, and active resting
// liquidity wall ranking.
// Research only: describes recorded CME L2 resting liquidity and executed large prints; never a
// trade signal.
// Used by: packages/api/src/server/flow-liquidity-heatmap.ts, packages/api/src/server/flow-collect.ts.

import {
  type FLOW_CAPTURE_MODES,
  FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS,
  FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS,
  FLOW_LIQUIDITY_HEATMAP_MAX_TRADES,
  FLOW_LIQUIDITY_HEATMAP_MAX_WALLS,
  FLOW_LIQUIDITY_HEATMAP_RULES_VERSION,
  FLOW_LIQUIDITY_HEATMAP_VERSION,
  type FLOW_SIGNING_METHODS,
  type FLOW_TRADE_SIDES,
  type FlowFreshness,
  type FlowLiquidityHeatmap,
  type FlowLiquidityHeatmapCaptureMode,
  type FlowLiquidityHeatmapCell,
  type FlowLiquidityHeatmapColumn,
  type FlowLiquidityHeatmapDomLevel,
  type FlowLiquidityHeatmapTrade,
  type FlowLiquidityHeatmapWall,
  type FlowTapeSymbol,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

export const FLOW_LIQUIDITY_HEATMAP_SAMPLE_SECONDS = 5;
export const FLOW_LIQUIDITY_HEATMAP_INTENSITY_QUANTILE = 0.95;
export const FLOW_BOOK_SNAPSHOT_MAX_LEVELS = 20;

const PRICE_STEP_MULTIPLIERS = [1, 2, 4, 8, 12, 20, 40, 80, 160] as const;

type CaptureKind = (typeof FLOW_CAPTURE_MODES)[number];
type TradeSideKind = (typeof FLOW_TRADE_SIDES)[number];
type TradeSigningKind = (typeof FLOW_SIGNING_METHODS)[number];

export type RawDepthLevel = Readonly<{
  price: number;
  size: number;
}>;

export type SanitizedDepthSide = Readonly<{
  best: number | null;
  prices: number[];
  sizes: number[];
}>;

/**
 * Filters raw L2 depth levels to strictly finite positive prices and scaled sizes, capped at
 * FLOW_BOOK_SNAPSHOT_MAX_LEVELS (20) per side to satisfy flow_book_snapshots_check.
 */
export const sanitizeDepthSide = (
  levels: readonly RawDepthLevel[],
  sizeMultiplier = 1
): SanitizedDepthSide => {
  const mult =
    Number.isFinite(sizeMultiplier) && sizeMultiplier > 0 ? sizeMultiplier : 1;
  const prices: number[] = [];
  const sizes: number[] = [];
  for (const level of levels) {
    if (prices.length >= FLOW_BOOK_SNAPSHOT_MAX_LEVELS) break;
    const size = level.size * mult;
    if (
      Number.isFinite(level.price) &&
      level.price > 0 &&
      Number.isFinite(size) &&
      size > 0
    ) {
      prices.push(level.price);
      sizes.push(size);
    }
  }
  return {
    best: prices[0] ?? null,
    prices,
    sizes,
  };
};

/**
 * Column width in seconds for a heatmap window. Guarantees <= 240 columns for every window in
 * [15, 390] minutes while letting 5-second streamed recording show 2x–12x finer granularity than
 * 1-minute sampling on 15m, 30m, 60m, and 120m windows.
 */
export const liquidityColumnSeconds = (
  minutes: number,
  hasStreamed: boolean
): number => {
  if (!hasStreamed) {
    if (minutes <= 120) return 60;
    if (minutes <= 240) return 120;
    return 180;
  }
  if (minutes <= 15) return 5;
  if (minutes <= 30) return 10;
  if (minutes <= 60) return 15;
  if (minutes <= 120) return 30;
  if (minutes <= 240) return 60;
  return 120;
};

export type LiquidityHeatmapAxis = Readonly<{
  axisEnd: Date;
  axisStart: Date;
  totalColumns: number;
}>;

/** Aligns the column axis cleanly to columnSeconds with totalColumns <= 240. */
export const liquidityHeatmapAxis = (
  windowEnd: Date,
  minutes: number,
  columnSeconds: number
): LiquidityHeatmapAxis => {
  const endSec =
    Math.floor(windowEnd.getTime() / 1000 / columnSeconds) * columnSeconds +
    columnSeconds;
  const totalColumns = Math.min(
    FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS,
    Math.max(1, Math.ceil((minutes * 60) / columnSeconds))
  );
  const startSec = endSec - totalColumns * columnSeconds;
  return {
    axisEnd: new Date(endSec * 1000),
    axisStart: new Date(startSec * 1000),
    totalColumns,
  };
};

const roundDecimals = (value: number): number =>
  Math.round(value * 1_000_000) / 1_000_000;

/**
 * Chooses the smallest integer multiple of minTick whose price grid covers [minPrice, maxPrice]
 * in at most FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS (80) rows, with a mathematical fallback so
 * wide price ranges never exceed the contract bound.
 */
export const choosePriceStep = (
  minPrice: number,
  maxPrice: number,
  minTick: number
): number => {
  const span = Math.max(0, maxPrice - minPrice);
  for (const mult of PRICE_STEP_MULTIPLIERS) {
    const step = roundDecimals(minTick * mult);
    const low = Math.floor(minPrice / step) * step;
    const high = Math.floor(maxPrice / step) * step;
    if (
      Math.round((high - low) / step) + 1 <=
      FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS
    ) {
      return step;
    }
  }
  const neededMult = Math.ceil(
    span / ((FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS - 1) * minTick)
  );
  return roundDecimals(Math.max(1, neededMult) * minTick);
};

/** Nearest-rank 95th percentile over positive finite numbers; returns 0 when empty. */
export const percentile95 = (values: readonly number[]): number => {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positive.length === 0) return 0;
  positive.sort((a, b) => a - b);
  const index = Math.min(
    positive.length - 1,
    Math.max(
      0,
      Math.ceil(positive.length * FLOW_LIQUIDITY_HEATMAP_INTENSITY_QUANTILE) - 1
    )
  );
  return positive[index] as number;
};

export type StoredBookSnapshotInput = Readonly<{
  askPrices: readonly number[];
  askSizes: readonly number[];
  bestAsk: number | null;
  bestBid: number | null;
  bidPrices: readonly number[];
  bidSizes: readonly number[];
  capture: CaptureKind;
  capturedAt: Date;
  contract: string;
  minTick: number;
}>;

export type StoredLargeTradeInput = Readonly<{
  capture: CaptureKind;
  price: number;
  second: Date;
  seq: number;
  side: TradeSideKind;
  signing: TradeSigningKind;
  size: number;
}>;

export type BuildFlowLiquidityHeatmapInput = Readonly<{
  depth: FlowFreshness;
  largeTrades: readonly StoredLargeTradeInput[];
  minutes: number;
  now: Date;
  snapshots: readonly StoredBookSnapshotInput[];
  symbol: FlowTapeSymbol;
  windowEnd: Date;
  windowStart: Date;
}>;

const captureSummary = (
  snapshots: readonly StoredBookSnapshotInput[]
): FlowLiquidityHeatmapCaptureMode => {
  let hasStreamed = false;
  let hasSampled = false;
  for (const snap of snapshots) {
    if (snap.capture === "streamed") hasStreamed = true;
    else hasSampled = true;
  }
  if (hasStreamed && hasSampled) return "mixed";
  if (hasStreamed) return "streamed";
  if (hasSampled) return "sampled";
  return "none";
};

const preferSnapshot = (
  existing: StoredBookSnapshotInput | undefined,
  candidate: StoredBookSnapshotInput
): StoredBookSnapshotInput => {
  if (existing === undefined) return candidate;
  if (existing.capture === "streamed" && candidate.capture === "sampled")
    return existing;
  if (candidate.capture === "streamed" && existing.capture === "sampled")
    return candidate;
  return candidate.capturedAt.getTime() >= existing.capturedAt.getTime()
    ? candidate
    : existing;
};

type BucketSums = Readonly<{ ask: number; bid: number }>;

const aggregateSnapshotCells = (
  snap: StoredBookSnapshotInput,
  priceMin: number,
  priceStep: number,
  priceCount: number
): Map<number, BucketSums> => {
  const map = new Map<number, { ask: number; bid: number }>();
  const add = (price: number, size: number, side: "bid" | "ask") => {
    const raw = Math.floor((price - priceMin + 1e-9) / priceStep);
    const idx = Math.min(priceCount - 1, Math.max(0, raw));
    const current = map.get(idx) ?? { ask: 0, bid: 0 };
    if (side === "bid") current.bid += size;
    else current.ask += size;
    map.set(idx, current);
  };
  for (let i = 0; i < snap.bidPrices.length; i += 1) {
    add(snap.bidPrices[i] as number, snap.bidSizes[i] as number, "bid");
  }
  for (let i = 0; i < snap.askPrices.length; i += 1) {
    add(snap.askPrices[i] as number, snap.askSizes[i] as number, "ask");
  }
  return map;
};

type PriceGrid = Readonly<{
  minTick: number;
  newestSnap: StoredBookSnapshotInput | null;
  priceLevels: number[];
  priceMax: number | null;
  priceMin: number | null;
  priceStep: number;
}>;

const buildPriceGrid = (
  byCol: ReadonlyMap<number, StoredBookSnapshotInput>,
  keptTrades: readonly StoredLargeTradeInput[],
  defaultMinTick: number
): PriceGrid => {
  let newestSnap: StoredBookSnapshotInput | null = null;
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  const expand = (p: number) => {
    if (p < minPrice) minPrice = p;
    if (p > maxPrice) maxPrice = p;
  };
  for (const snap of byCol.values()) {
    if (
      newestSnap === null ||
      snap.capturedAt.getTime() > newestSnap.capturedAt.getTime()
    ) {
      newestSnap = snap;
    }
    for (const p of snap.bidPrices) expand(p);
    for (const p of snap.askPrices) expand(p);
  }
  for (const trade of keptTrades) expand(trade.price);

  const minTick = newestSnap?.minTick ?? defaultMinTick;
  if (!(Number.isFinite(minPrice) && Number.isFinite(maxPrice))) {
    return {
      minTick,
      newestSnap,
      priceLevels: [],
      priceMax: null,
      priceMin: null,
      priceStep: minTick,
    };
  }
  const priceStep = choosePriceStep(minPrice, maxPrice, minTick);
  const low = roundDecimals(Math.floor(minPrice / priceStep) * priceStep);
  const high = roundDecimals(Math.floor(maxPrice / priceStep) * priceStep);
  const count = Math.min(
    FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS,
    Math.round((high - low) / priceStep) + 1
  );
  const priceLevels = Array.from({ length: count }, (_, i) =>
    roundDecimals(low + i * priceStep)
  );
  return {
    minTick,
    newestSnap,
    priceLevels,
    priceMax: priceLevels.at(-1) as number,
    priceMin: priceLevels[0] as number,
    priceStep,
  };
};

type BuiltColumns = Readonly<{
  allCellSizes: number[];
  askPresence: Map<number, number>;
  bidPresence: Map<number, number>;
  columns: FlowLiquidityHeatmapColumn[];
  latestColMaps: Map<number, BucketSums> | null;
  latestColMid: number | null;
  maxSize: number;
  recordedColumns: number;
}>;

const emitColumnCells = (
  sums: ReadonlyMap<number, BucketSums>,
  bidPresence: Map<number, number>,
  askPresence: Map<number, number>,
  allCellSizes: number[]
): Readonly<{ cells: FlowLiquidityHeatmapCell[]; colMax: number }> => {
  const cells: FlowLiquidityHeatmapCell[] = [];
  let colMax = 0;
  for (const [p, entry] of [...sums.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.bid > 0) bidPresence.set(p, (bidPresence.get(p) ?? 0) + 1);
    if (entry.ask > 0) askPresence.set(p, (askPresence.get(p) ?? 0) + 1);
    const total = roundDecimals(entry.bid + entry.ask);
    const side =
      entry.bid > 0 && entry.ask > 0 ? "both" : entry.bid > 0 ? "bid" : "ask";
    cells.push({ p, s: total, side });
    allCellSizes.push(total);
    if (total > colMax) colMax = total;
  }
  return { cells, colMax };
};

const buildHeatmapColumns = (
  axisStartSec: number,
  columnSeconds: number,
  totalColumns: number,
  byCol: ReadonlyMap<number, StoredBookSnapshotInput>,
  grid: PriceGrid
): BuiltColumns => {
  const allCellSizes: number[] = [];
  const bidPresence = new Map<number, number>();
  const askPresence = new Map<number, number>();
  const columns: FlowLiquidityHeatmapColumn[] = [];
  let maxSize = 0;
  let recordedColumns = 0;
  let latestColMaps: Map<number, BucketSums> | null = null;
  let latestColMid: number | null = null;

  for (let col = 0; col < totalColumns; col += 1) {
    const t = new Date(
      (axisStartSec + col * columnSeconds) * 1000
    ).toISOString();
    const snap = byCol.get(col);
    if (snap === undefined || grid.priceMin === null) {
      columns.push({
        bestAsk: null,
        bestBid: null,
        capture: null,
        cells: [],
        mid: null,
        state: "no_data",
        t,
      });
      continue;
    }
    recordedColumns += 1;
    const mid =
      snap.bestBid !== null && snap.bestAsk !== null
        ? roundDecimals((snap.bestBid + snap.bestAsk) / 2)
        : null;
    const sums = aggregateSnapshotCells(
      snap,
      grid.priceMin,
      grid.priceStep,
      grid.priceLevels.length
    );
    const { cells, colMax } = emitColumnCells(
      sums,
      bidPresence,
      askPresence,
      allCellSizes
    );
    if (colMax > maxSize) maxSize = colMax;
    latestColMaps = sums;
    latestColMid = mid;
    columns.push({
      bestAsk: snap.bestAsk,
      bestBid: snap.bestBid,
      capture: snap.capture,
      cells,
      mid,
      state: "recorded",
      t,
    });
  }
  return {
    allCellSizes,
    askPresence,
    bidPresence,
    columns,
    latestColMaps,
    latestColMid,
    maxSize,
    recordedColumns,
  };
};

const rankActiveDomAndWalls = (
  built: BuiltColumns,
  priceLevels: readonly number[]
): Readonly<{
  currentDom: FlowLiquidityHeatmapDomLevel[];
  walls: FlowLiquidityHeatmapWall[];
}> => {
  const currentDom: FlowLiquidityHeatmapDomLevel[] = [];
  const wallCandidates: FlowLiquidityHeatmapWall[] = [];
  if (built.latestColMaps === null || built.recordedColumns === 0) {
    return { currentDom, walls: [] };
  }
  for (const [p, entry] of [...built.latestColMaps.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    const price = priceLevels[p] as number;
    currentDom.push({
      askSize: roundDecimals(entry.ask),
      bidSize: roundDecimals(entry.bid),
      p,
      price,
    });
    if (entry.bid > 0) {
      const columnsPresent = built.bidPresence.get(p) as number;
      wallCandidates.push({
        columnsPresent,
        persistencePct: Math.round(
          (columnsPresent / built.recordedColumns) * 100
        ),
        price,
        side: "bid",
        size: roundDecimals(entry.bid),
      });
    }
    if (entry.ask > 0) {
      const columnsPresent = built.askPresence.get(p) as number;
      wallCandidates.push({
        columnsPresent,
        persistencePct: Math.round(
          (columnsPresent / built.recordedColumns) * 100
        ),
        price,
        side: "ask",
        size: roundDecimals(entry.ask),
      });
    }
  }
  const refMid = built.latestColMid;
  wallCandidates.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (b.persistencePct !== a.persistencePct)
      return b.persistencePct - a.persistencePct;
    if (refMid !== null) {
      const distDiff = Math.abs(a.price - refMid) - Math.abs(b.price - refMid);
      if (distDiff !== 0) return distDiff;
    }
    if (b.price !== a.price) return b.price - a.price;
    return a.side.localeCompare(b.side);
  });
  return {
    currentDom,
    walls: wallCandidates.slice(0, FLOW_LIQUIDITY_HEATMAP_MAX_WALLS),
  };
};

/**
 * Pure assembly of flow-liquidity-heatmap.v1 from stored L2 snapshots, large trades, and depth
 * freshness. Never invents prints or forward-fills missing columns.
 */
export const buildFlowLiquidityHeatmap = (
  input: BuildFlowLiquidityHeatmapInput
): FlowLiquidityHeatmap => {
  const instrument = FLOW_INSTRUMENTS[input.symbol];
  const largeTradeLimit = instrument.deepTradeLimit as number;
  const streamedColumnSeconds = liquidityColumnSeconds(input.minutes, true);
  const streamedAxis = liquidityHeatmapAxis(
    input.windowEnd,
    input.minutes,
    streamedColumnSeconds
  );
  const streamedStartSec = Math.floor(streamedAxis.axisStart.getTime() / 1000);
  const streamedEndSec = Math.floor(streamedAxis.axisEnd.getTime() / 1000);
  const hasStreamed = input.snapshots.some((snap) => {
    if (snap.capture !== "streamed") return false;
    const sec = Math.floor(snap.capturedAt.getTime() / 1000);
    return sec >= streamedStartSec && sec < streamedEndSec;
  });
  const columnSeconds = hasStreamed
    ? streamedColumnSeconds
    : liquidityColumnSeconds(input.minutes, false);
  const axis = hasStreamed
    ? streamedAxis
    : liquidityHeatmapAxis(input.windowEnd, input.minutes, columnSeconds);
  const axisStartSec = Math.floor(axis.axisStart.getTime() / 1000);
  const axisEndSec = Math.floor(axis.axisEnd.getTime() / 1000);

  const snapshotsInWindow: StoredBookSnapshotInput[] = [];
  const byCol = new Map<number, StoredBookSnapshotInput>();
  for (const snap of input.snapshots) {
    const sec = Math.floor(snap.capturedAt.getTime() / 1000);
    if (sec < axisStartSec || sec >= axisEndSec) continue;
    snapshotsInWindow.push(snap);
    const col = Math.floor((sec - axisStartSec) / columnSeconds);
    byCol.set(col, preferSnapshot(byCol.get(col), snap));
  }
  const capture = captureSummary(snapshotsInWindow);

  const tradesInWindow = input.largeTrades
    .filter((trade) => {
      const sec = Math.floor(trade.second.getTime() / 1000);
      return sec >= axisStartSec && sec < axisEndSec;
    })
    .sort((a, b) => a.second.getTime() - b.second.getTime() || a.seq - b.seq);
  const tradesTruncated =
    tradesInWindow.length > FLOW_LIQUIDITY_HEATMAP_MAX_TRADES;
  const keptTrades = tradesTruncated
    ? tradesInWindow.slice(-FLOW_LIQUIDITY_HEATMAP_MAX_TRADES)
    : tradesInWindow;
  const trades: FlowLiquidityHeatmapTrade[] = keptTrades.map((trade) => ({
    capture: trade.capture,
    price: trade.price,
    side: trade.side,
    signing: trade.signing,
    size: trade.size,
    t: trade.second.toISOString(),
  }));

  const grid = buildPriceGrid(byCol, keptTrades, instrument.minTick);
  const built = buildHeatmapColumns(
    axisStartSec,
    columnSeconds,
    axis.totalColumns,
    byCol,
    grid
  );
  const { currentDom, walls } = rankActiveDomAndWalls(built, grid.priceLevels);

  return {
    axisEnd: axis.axisEnd.toISOString(),
    axisStart: axis.axisStart.toISOString(),
    capture,
    columnSeconds,
    columns: built.columns,
    contract: grid.newestSnap?.contract ?? null,
    currentDom,
    depth: input.depth,
    minTick: grid.minTick,
    priceLevels: grid.priceLevels,
    priceMax: grid.priceMax,
    priceMin: grid.priceMin,
    priceStep: grid.priceStep,
    rules: {
      intensityQuantile: FLOW_LIQUIDITY_HEATMAP_INTENSITY_QUANTILE,
      largeTradeLimit,
      maxColumns: FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS,
      maxPriceBuckets: FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS,
      sampleSeconds: FLOW_LIQUIDITY_HEATMAP_SAMPLE_SECONDS,
      version: FLOW_LIQUIDITY_HEATMAP_RULES_VERSION,
    },
    scale: {
      maxSize: roundDecimals(built.maxSize),
      p95Size: roundDecimals(percentile95(built.allCellSizes)),
      totalCells: built.allCellSizes.length,
    },
    schemaVersion: FLOW_LIQUIDITY_HEATMAP_VERSION,
    symbol: input.symbol,
    totals: {
      coveragePct: Math.round(
        (built.recordedColumns / axis.totalColumns) * 100
      ),
      largeTrades: tradesInWindow.length,
      recordedColumns: built.recordedColumns,
      snapshots: snapshotsInWindow.length,
      totalColumns: axis.totalColumns,
    },
    trades,
    tradesTruncated,
    walls,
    windowEnd: input.windowEnd.toISOString(),
    windowStart: input.windowStart.toISOString(),
  };
};

/** Short non-sensitive note for a failed book-snapshot write in a flow_samples message. */
export const bookSnapshotsFailureNote = (error: unknown): string => {
  const label =
    error instanceof Error
      ? "causeName" in error && typeof error.causeName === "string"
        ? error.causeName
        : error.name
      : typeof error;
  return `; book snapshots not stored (${label.slice(0, 40)})`;
};
