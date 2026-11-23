// What: pure rules of the strike × time options flow heatmap (strike-heatmap.v1) for
// flow.strikeHeatmap: directional signed net premium using OPTION_SIDE_SIGN, session slot
// aggregation with carried-forward spot and open-gap flags, top-N strike selection, and
// omitted-strike accounting.
// Pure; imports contract types and OPTION_SIDE_SIGN only.
// Research only: the heatmap describes stored option prints, never a trade signal.
// Doc: docs/vertex-rebuild/designs/vertex-viz-flow-strike-time-heatmap/design.md.
import {
  FLOW_STRIKE_HEATMAP_MAX_SLOTS,
  FLOW_STRIKE_HEATMAP_MAX_STRIKES,
  type FlowStrikeHeatmapBucketMinutes,
  type FlowStrikeHeatmapCell,
  type FlowStrikeHeatmapRules,
  type FlowStrikeHeatmapSlot,
  type FlowStrikeHeatmapStrike,
  type FlowStrikeHeatmapTotals,
} from "./contracts/flow.ts";
import { OPTION_SIDE_SIGN, type StoredOptionSide } from "./flow-options.ts";

/** Rules of flow.strikeHeatmap: stored prints >= $10,000, 14-day retention, top 20 strikes, 15m default. */
export const STRIKE_HEATMAP_RULES: FlowStrikeHeatmapRules = Object.freeze({
  defaultBucketMinutes: 15,
  maxStrikes: FLOW_STRIKE_HEATMAP_MAX_STRIKES,
  minPremiumUsd: 10_000,
  retentionDays: 14,
  version: "strike-heatmap.v1",
});

/** One domain-agnostic (strike, slotIndex, right, side) aggregate row from Postgres. */
export type StrikeHeatmapBucketRow = Readonly<{
  strike: number;
  slotIndex: number;
  right: "call" | "put";
  side: StoredOptionSide;
  premium: number;
  prints: number;
  volume: number;
  lastTradedAt: Date;
}>;

/** Newest positive finite underlying price inside one time slot from Postgres. */
export type StrikeHeatmapSlotPriceRow = Readonly<{
  slotIndex: number;
  price: number;
  pricedAt: Date;
}>;

/** Open collector gap range (inclusive QuantData bounds). */
export type StrikeHeatmapGapRow = Readonly<{
  startTime: Date;
  endTime: Date;
}>;

export type StrikeHeatmapFoldInput = Readonly<{
  buckets: readonly StrikeHeatmapBucketRow[];
  slotPrices: readonly StrikeHeatmapSlotPriceRow[];
  range: Readonly<{ from: Date; to: Date }>;
  bucketMinutes: FlowStrikeHeatmapBucketMinutes;
  gaps: readonly StrikeHeatmapGapRow[];
  maxStrikes?: number;
}>;

export type StrikeHeatmapFold = Readonly<{
  slots: FlowStrikeHeatmapSlot[];
  strikes: FlowStrikeHeatmapStrike[];
  cells: FlowStrikeHeatmapCell[];
  storedUntil: string | null;
  totals: FlowStrikeHeatmapTotals;
}>;

const MINUTE_MS = 60_000;

/**
 * Directional sign of one option print from the shared OPTION_SIDE_SIGN table:
 * +1 bullish (call at ask/above ask, or put at bid/below bid),
 * -1 bearish (put at ask/above ask, or call at bid/below bid),
 *  0 unsigned (mid or unknown).
 */
export const directionalSignOf = (
  right: "call" | "put",
  side: StoredOptionSide
): number => {
  const sideSign = OPTION_SIDE_SIGN[side];
  return sideSign === 0 ? 0 : sideSign * (right === "call" ? 1 : -1);
};

const slotOverlapsGap = (
  slotStartMs: number,
  slotEndMs: number,
  gap: StrikeHeatmapGapRow
): boolean => {
  const gapStartMs = gap.startTime.getTime();
  const gapEndMs = gap.endTime.getTime();
  return (
    gapStartMs < slotEndMs &&
    (gapEndMs > slotStartMs ||
      (gapEndMs === gapStartMs && gapStartMs === slotStartMs))
  );
};

interface MutableFlowSums {
  bullishPremium: number;
  bearishPremium: number;
  callPremium: number;
  putPremium: number;
  grossPremium: number;
  prints: number;
  unsignedPrints: number;
  volume: number;
}

interface MutableCellSums extends MutableFlowSums {
  strike: number;
  slotIndex: number;
}

const emptySums = (): MutableFlowSums => ({
  bearishPremium: 0,
  bullishPremium: 0,
  callPremium: 0,
  grossPremium: 0,
  prints: 0,
  putPremium: 0,
  unsignedPrints: 0,
  volume: 0,
});

const addRow = (target: MutableFlowSums, row: StrikeHeatmapBucketRow): void => {
  const sign = directionalSignOf(row.right, row.side);
  if (sign > 0) target.bullishPremium += row.premium;
  else if (sign < 0) target.bearishPremium += row.premium;
  else target.unsignedPrints += row.prints;

  if (row.right === "call") target.callPremium += row.premium;
  else target.putPremium += row.premium;

  target.grossPremium += row.premium;
  target.prints += row.prints;
  target.volume += row.volume;
};

const getOrCreateSums = (
  map: Map<number, MutableFlowSums>,
  key: number
): MutableFlowSums => {
  let sums = map.get(key);
  if (sums === undefined) {
    sums = emptySums();
    map.set(key, sums);
  }
  return sums;
};

const emptyTotals = (): FlowStrikeHeatmapTotals => ({
  bearishPremium: 0,
  bullishPremium: 0,
  callPremium: 0,
  grossPremium: 0,
  latestPrice: null,
  netPremium: 0,
  omittedGrossPremium: 0,
  omittedNetPremium: 0,
  omittedPrints: 0,
  omittedStrikes: 0,
  prints: 0,
  putPremium: 0,
  shownStrikes: 0,
  totalStrikes: 0,
  unsignedPrints: 0,
  volume: 0,
});

const isValidBucketRow = (
  row: StrikeHeatmapBucketRow,
  maxSlots: number
): boolean =>
  Number.isFinite(row.strike) &&
  row.strike > 0 &&
  Number.isInteger(row.slotIndex) &&
  row.slotIndex >= 0 &&
  row.slotIndex < maxSlots &&
  Number.isFinite(row.premium) &&
  row.premium >= 0 &&
  Number.isInteger(row.prints) &&
  row.prints > 0 &&
  Number.isInteger(row.volume) &&
  row.volume >= 0 &&
  Number.isFinite(row.lastTradedAt.getTime());

const accumulateBuckets = (rows: readonly StrikeHeatmapBucketRow[]) => {
  let lastPrintSlot = 0;
  let storedUntilMs = Number.NEGATIVE_INFINITY;
  const sessionSums = emptySums();
  const slotSumsByIndex = new Map<number, MutableFlowSums>();
  const strikeSumsByPrice = new Map<number, MutableFlowSums>();
  const cellSumsByKey = new Map<string, MutableCellSums>();

  for (const row of rows) {
    if (row.slotIndex > lastPrintSlot) lastPrintSlot = row.slotIndex;
    const tradedMs = row.lastTradedAt.getTime();
    if (tradedMs > storedUntilMs) storedUntilMs = tradedMs;

    addRow(sessionSums, row);
    addRow(getOrCreateSums(slotSumsByIndex, row.slotIndex), row);
    addRow(getOrCreateSums(strikeSumsByPrice, row.strike), row);

    const key = `${row.strike}:${row.slotIndex}`;
    let cellSums = cellSumsByKey.get(key);
    if (cellSums === undefined) {
      cellSums = {
        ...emptySums(),
        slotIndex: row.slotIndex,
        strike: row.strike,
      };
      cellSumsByKey.set(key, cellSums);
    }
    addRow(cellSums, row);
  }

  return {
    cellSumsByKey,
    lastPrintSlot,
    sessionSums,
    slotSumsByIndex,
    storedUntilMs,
    strikeSumsByPrice,
  };
};

const buildSlots = (
  fromMs: number,
  toMs: number,
  bucketMs: number,
  maxSlots: number,
  lastPrintSlot: number,
  slotSumsByIndex: ReadonlyMap<number, MutableFlowSums>,
  slotPrices: readonly StrikeHeatmapSlotPriceRow[],
  gaps: readonly StrikeHeatmapGapRow[]
): Readonly<{ slots: FlowStrikeHeatmapSlot[]; latestPrice: number | null }> => {
  let lastGapSlot = -1;
  const unreadBySlot = new Array<boolean>(maxSlots).fill(false);
  for (let index = 0; index < maxSlots; index += 1) {
    const slotStartMs = fromMs + index * bucketMs;
    const slotEndMs = Math.min(toMs, slotStartMs + bucketMs);
    if (gaps.some((gap) => slotOverlapsGap(slotStartMs, slotEndMs, gap))) {
      unreadBySlot[index] = true;
      lastGapSlot = index;
    }
  }

  const slotCount = Math.max(lastPrintSlot, lastGapSlot) + 1;
  const rawPriceBySlot = new Map<number, number>();
  for (const row of slotPrices) {
    if (
      Number.isInteger(row.slotIndex) &&
      row.slotIndex >= 0 &&
      row.slotIndex < slotCount &&
      Number.isFinite(row.price) &&
      row.price > 0
    ) {
      rawPriceBySlot.set(row.slotIndex, row.price);
    }
  }

  let carriedPrice: number | null = null;
  const slots: FlowStrikeHeatmapSlot[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const slotPrice = rawPriceBySlot.get(index);
    if (slotPrice !== undefined) carriedPrice = slotPrice;

    const slotStartMs = fromMs + index * bucketMs;
    const slotEndMs = Math.min(toMs, slotStartMs + bucketMs);
    const sums = slotSumsByIndex.get(index) ?? emptySums();
    slots.push({
      bearishPremium: sums.bearishPremium,
      bullishPremium: sums.bullishPremium,
      end: new Date(slotEndMs).toISOString(),
      grossPremium: sums.grossPremium,
      index,
      netPremium: sums.bullishPremium - sums.bearishPremium,
      price: carriedPrice,
      prints: sums.prints,
      start: new Date(slotStartMs).toISOString(),
      unread: unreadBySlot[index] === true,
      unsignedPrints: sums.unsignedPrints,
      volume: sums.volume,
    });
  }

  return { latestPrice: carriedPrice, slots };
};

const rankStrikes = (
  strikes: FlowStrikeHeatmapStrike[],
  latestPrice: number | null
): void => {
  strikes.sort((a, b) => {
    if (b.grossPremium !== a.grossPremium)
      return b.grossPremium - a.grossPremium;
    const absDiff = Math.abs(b.netPremium) - Math.abs(a.netPremium);
    if (absDiff !== 0) return absDiff;
    if (latestPrice !== null) {
      const distDiff =
        Math.abs(a.strike - latestPrice) - Math.abs(b.strike - latestPrice);
      if (distDiff !== 0) return distDiff;
    }
    return b.strike - a.strike;
  });
};

const selectStrikesAndCells = (
  strikeSumsByPrice: ReadonlyMap<number, MutableFlowSums>,
  cellSumsByKey: ReadonlyMap<string, MutableCellSums>,
  maxStrikes: number,
  latestPrice: number | null
) => {
  const allStrikes: FlowStrikeHeatmapStrike[] = Array.from(
    strikeSumsByPrice.entries(),
    ([strike, sums]) => ({
      bearishPremium: sums.bearishPremium,
      bullishPremium: sums.bullishPremium,
      callPremium: sums.callPremium,
      grossPremium: sums.grossPremium,
      netPremium: sums.bullishPremium - sums.bearishPremium,
      prints: sums.prints,
      putPremium: sums.putPremium,
      strike,
      unsignedPrints: sums.unsignedPrints,
      volume: sums.volume,
    })
  );

  rankStrikes(allStrikes, latestPrice);
  const strikes = allStrikes.slice(0, maxStrikes);
  const omitted = allStrikes.slice(maxStrikes);
  const keptStrikeSet = new Set(strikes.map((entry) => entry.strike));

  strikes.sort((a, b) => b.strike - a.strike);

  const cells: FlowStrikeHeatmapCell[] = [];
  for (const entry of cellSumsByKey.values()) {
    if (!keptStrikeSet.has(entry.strike)) continue;
    cells.push({
      bearishPremium: entry.bearishPremium,
      bullishPremium: entry.bullishPremium,
      callPremium: entry.callPremium,
      grossPremium: entry.grossPremium,
      netPremium: entry.bullishPremium - entry.bearishPremium,
      prints: entry.prints,
      putPremium: entry.putPremium,
      slotIndex: entry.slotIndex,
      strike: entry.strike,
      unsignedPrints: entry.unsignedPrints,
      volume: entry.volume,
    });
  }
  cells.sort((a, b) => b.strike - a.strike || a.slotIndex - b.slotIndex);

  let omittedGrossPremium = 0;
  let omittedNetPremium = 0;
  let omittedPrints = 0;
  for (const entry of omitted) {
    omittedGrossPremium += entry.grossPremium;
    omittedNetPremium += entry.netPremium;
    omittedPrints += entry.prints;
  }

  return {
    cells,
    omittedGrossPremium,
    omittedNetPremium,
    omittedPrints,
    omittedStrikes: omitted.length,
    strikes,
    totalStrikes: allStrikes.length,
  };
};

/**
 * Folds domain-agnostic (strike, slotIndex, right, side) aggregates and per-slot underlying prices
 * into the bounded strike × time heatmap document for one regular options session.
 */
export const foldStrikeHeatmap = (
  input: StrikeHeatmapFoldInput
): StrikeHeatmapFold => {
  const fromMs = input.range.from.getTime();
  const toMs = input.range.to.getTime();
  const bucketMs = input.bucketMinutes * MINUTE_MS;
  const maxSlots = Math.min(
    FLOW_STRIKE_HEATMAP_MAX_SLOTS,
    Math.max(0, Math.ceil((toMs - fromMs) / bucketMs))
  );
  const maxStrikes = Math.min(
    FLOW_STRIKE_HEATMAP_MAX_STRIKES,
    Math.max(1, input.maxStrikes ?? STRIKE_HEATMAP_RULES.maxStrikes)
  );

  const validBuckets = input.buckets.filter((row) =>
    isValidBucketRow(row, maxSlots)
  );
  if (validBuckets.length === 0) {
    return {
      cells: [],
      slots: [],
      storedUntil: null,
      strikes: [],
      totals: emptyTotals(),
    };
  }

  const acc = accumulateBuckets(validBuckets);
  const { slots, latestPrice } = buildSlots(
    fromMs,
    toMs,
    bucketMs,
    maxSlots,
    acc.lastPrintSlot,
    acc.slotSumsByIndex,
    input.slotPrices,
    input.gaps
  );
  const selection = selectStrikesAndCells(
    acc.strikeSumsByPrice,
    acc.cellSumsByKey,
    maxStrikes,
    latestPrice
  );

  return {
    cells: selection.cells,
    slots,
    storedUntil: new Date(acc.storedUntilMs).toISOString(),
    strikes: selection.strikes,
    totals: {
      bearishPremium: acc.sessionSums.bearishPremium,
      bullishPremium: acc.sessionSums.bullishPremium,
      callPremium: acc.sessionSums.callPremium,
      grossPremium: acc.sessionSums.grossPremium,
      latestPrice,
      netPremium:
        acc.sessionSums.bullishPremium - acc.sessionSums.bearishPremium,
      omittedGrossPremium: selection.omittedGrossPremium,
      omittedNetPremium: selection.omittedNetPremium,
      omittedPrints: selection.omittedPrints,
      omittedStrikes: selection.omittedStrikes,
      prints: acc.sessionSums.prints,
      putPremium: acc.sessionSums.putPremium,
      shownStrikes: selection.strikes.length,
      totalStrikes: selection.totalStrikes,
      unsignedPrints: acc.sessionSums.unsignedPrints,
      volume: acc.sessionSums.volume,
    },
  };
};
