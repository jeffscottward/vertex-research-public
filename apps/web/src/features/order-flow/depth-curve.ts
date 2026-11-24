// What: pure cumulative bid/ask depth-curve geometry from a DepthLadder snapshot (chart F3).
// Aggregates multi-venue SMART rows at identical prices, computes nice axes and exact step-area
// SVG paths for normal, one-sided, locked, crossed and zero-size books.
// Used by: components/portal/depth-curve-chart.tsx.
import { defined } from "./defined.ts";
import type { DepthLadder, LadderRow, LadderSide } from "./depth-ladder.ts";
import { decimalsOf } from "./price-grid.ts";

export const DEPTH_CURVE_WIDTH = 720;
export const DEPTH_CURVE_HEIGHT = 240;

const PLOT_LEFT = 56;
const PLOT_RIGHT = 704;
const PLOT_TOP = 26;
const PLOT_BOTTOM = 206;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

export interface DepthCurveLevel {
  readonly price: number;
  readonly size: number;
  readonly cumulative: number;
  readonly venues: readonly string[];
  readonly x: number;
  readonly y: number;
}

export interface DepthCurveTick {
  readonly value: number;
  readonly label: string;
  readonly pos: number;
}

export interface DepthCurveSpreadBand {
  readonly x: number;
  readonly width: number;
}

export interface DepthCurveMidMarker {
  readonly x: number;
  readonly label: string;
  readonly state: "normal" | "locked" | "crossed";
}

export interface DepthCurve {
  readonly width: number;
  readonly height: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly bids: readonly DepthCurveLevel[];
  readonly asks: readonly DepthCurveLevel[];
  readonly bidLinePath: string;
  readonly bidAreaPath: string;
  readonly askLinePath: string;
  readonly askAreaPath: string;
  readonly bestBidPoint: DepthCurveLevel | null;
  readonly bestAskPoint: DepthCurveLevel | null;
  readonly spreadBand: DepthCurveSpreadBand | null;
  readonly midMarker: DepthCurveMidMarker | null;
  readonly xTicks: readonly DepthCurveTick[];
  readonly yTicks: readonly DepthCurveTick[];
  readonly yMax: number;
  readonly totalBid: number;
  readonly totalAsk: number;
  readonly bidSharePct: number | null;
  readonly askSharePct: number | null;
  readonly ariaLabel: string;
}

export interface DepthCurveOptions {
  readonly digits: number;
  readonly minTick: number | null;
  readonly symbol: string;
  readonly unit: "shares" | "contracts";
}

interface RawLevel {
  readonly price: number;
  size: number;
  cumulative: number;
  readonly venues: string[];
}

const roundCoord = (value: number): number => Number(value.toFixed(2));
/** Price formatted to at least `digits` decimals, widened for half-tick mids or sub-penny quotes. */
export const formatDepthPrice = (value: number, digits: number): string =>
  value.toFixed(Math.min(Math.max(digits, decimalsOf(value)), 6));

/** Compact Y-axis label for cumulative size (0, 500, 1.3K, 2.5M). */
export const formatCompactSize = (value: number): string => {
  if (value === 0) return "0";
  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${millions}M`;
  }
  if (value >= 1000) {
    const thousands = (value / 1000).toFixed(1).replace(/\.0$/, "");
    return `${thousands}K`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const aggregateSide = (
  rows: readonly LadderRow[],
  side: LadderSide
): RawLevel[] => {
  // depth is already 0..N best-first in IBKR order, preserving venue order at equal prices.
  const ordered = rows
    .filter((row) => row.side === side)
    .sort((a, b) => a.depth - b.depth);
  const levels: RawLevel[] = [];
  let running = 0;
  for (const row of ordered) {
    running += row.size;
    const prev = levels.at(-1);
    if (prev !== undefined && prev.price === row.price) {
      prev.size += row.size;
      prev.cumulative = running;
      if (row.venue !== null && !prev.venues.includes(row.venue)) {
        prev.venues.push(row.venue);
      }
    } else {
      levels.push({
        cumulative: running,
        price: row.price,
        size: row.size,
        venues: row.venue === null ? [] : [row.venue],
      });
    }
  }
  return levels;
};

const computeYScale = (
  maxCumulative: number
): Readonly<{ yMax: number; tickValues: readonly number[] }> => {
  if (maxCumulative <= 0) return { tickValues: [0, 1], yMax: 1 };
  const rawStep = maxCumulative / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let niceUnit = 10;
  if (normalized <= 1) niceUnit = 1;
  else if (normalized <= 2) niceUnit = 2;
  else if (normalized <= 2.5) niceUnit = 2.5;
  else if (normalized <= 5) niceUnit = 5;
  const step = niceUnit * magnitude;
  const tickCount = Math.ceil(maxCumulative / step);
  const tickValues = Array.from({ length: tickCount + 1 }, (_, i) => i * step);
  return { tickValues, yMax: step * tickCount };
};

const computePriceDomain = (
  prices: readonly number[],
  minTick: number | null
): Readonly<{
  minPrice: number;
  maxPrice: number;
  xMin: number;
  xMax: number;
}> => {
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const span = maxPrice - minPrice;
  const tick =
    minTick !== null && Number.isFinite(minTick) && minTick > 0
      ? minTick
      : null;
  const pad =
    span === 0
      ? (tick ?? Math.max(Math.abs(minPrice) * 0.001, 0.01))
      : Math.min(Math.max(span * 0.06, tick ?? 0), span * 0.25);
  return {
    maxPrice,
    minPrice,
    xMax: maxPrice + pad,
    xMin: minPrice - pad,
  };
};

const buildBidPaths = (
  bids: readonly DepthCurveLevel[]
): Readonly<{ line: string; area: string }> => {
  if (bids.length === 0) return { area: "", line: "" };
  const outer = defined(bids.at(-1), "outer bid");
  const best = defined(bids[0], "best bid");
  const segments: string[] = [`M ${PLOT_LEFT} ${outer.y}`];
  for (let i = bids.length - 1; i >= 1; i -= 1) {
    const curr = defined(bids[i], "bid level");
    const next = defined(bids[i - 1], "inner bid level");
    segments.push(`L ${curr.x} ${curr.y}`, `L ${curr.x} ${next.y}`);
  }
  segments.push(`L ${best.x} ${best.y}`, `L ${best.x} ${PLOT_BOTTOM}`);
  const line = segments.join(" ");
  const area = `M ${PLOT_LEFT} ${PLOT_BOTTOM} L ${PLOT_LEFT} ${outer.y} ${segments.slice(1).join(" ")} Z`;
  return { area, line };
};

const buildAskPaths = (
  asks: readonly DepthCurveLevel[]
): Readonly<{ line: string; area: string }> => {
  if (asks.length === 0) return { area: "", line: "" };
  const best = defined(asks[0], "best ask");
  const outer = defined(asks.at(-1), "outer ask");
  const segments: string[] = [
    `M ${best.x} ${PLOT_BOTTOM}`,
    `L ${best.x} ${best.y}`,
  ];
  for (let i = 1; i < asks.length; i += 1) {
    const prev = defined(asks[i - 1], "inner ask level");
    const curr = defined(asks[i], "ask level");
    segments.push(`L ${curr.x} ${prev.y}`, `L ${curr.x} ${curr.y}`);
  }
  segments.push(`L ${PLOT_RIGHT} ${outer.y}`);
  const line = segments.join(" ");
  const area = `${line} L ${PLOT_RIGHT} ${PLOT_BOTTOM} Z`;
  return { area, line };
};

const buildXTicks = (
  minPrice: number,
  maxPrice: number,
  digits: number,
  xOf: (price: number) => number
): DepthCurveTick[] => {
  const candidates =
    minPrice === maxPrice
      ? [minPrice]
      : [0, 0.25, 0.5, 0.75, 1].map(
          (t) => minPrice + (maxPrice - minPrice) * t
        );
  const ticks: DepthCurveTick[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const label = value.toFixed(digits);
    const snapped = Number(label);
    if (snapped < minPrice || snapped > maxPrice || seen.has(label)) continue;
    seen.add(label);
    ticks.push({ label, pos: xOf(snapped), value: snapped });
  }
  if (ticks.length === 0) {
    const mid = (minPrice + maxPrice) / 2;
    ticks.push({
      label: formatDepthPrice(mid, digits),
      pos: xOf(mid),
      value: mid,
    });
  }
  return ticks;
};

const buildAriaLabel = (
  ladder: DepthLadder,
  options: DepthCurveOptions
): string => {
  const { digits, symbol, unit } = options;
  let stateText: string;
  if (ladder.bookState === "normal" && ladder.spread !== null) {
    stateText = `spread ${ladder.spread.toFixed(digits)}`;
  } else if (ladder.bookState === "locked") {
    stateText = "locked book";
  } else if (ladder.bookState === "crossed") {
    stateText = "crossed book";
  } else {
    stateText = ladder.bestBid === null ? "asks only" : "bids only";
  }
  const bidText = ladder.totalBid.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  const askText = ladder.totalAsk.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  return `${symbol} cumulative order-book depth curve: ${bidText} bid ${unit}, ${askText} ask ${unit}, ${stateText}`;
};

export const buildDepthCurve = (
  ladder: DepthLadder,
  options: DepthCurveOptions
): DepthCurve | null => {
  if (ladder.rows.length === 0) return null;

  const rawBids = aggregateSide(ladder.rows, "bid");
  const rawAsks = aggregateSide(ladder.rows, "ask");
  const allPrices = [
    ...rawBids.map((level) => level.price),
    ...rawAsks.map((level) => level.price),
  ];
  const { minPrice, maxPrice, xMin, xMax } = computePriceDomain(
    allPrices,
    options.minTick
  );
  const { yMax, tickValues } = computeYScale(ladder.maxCumulative);

  const xOf = (price: number): number =>
    roundCoord(PLOT_LEFT + ((price - xMin) / (xMax - xMin)) * PLOT_WIDTH);
  const yOf = (cumulative: number): number =>
    roundCoord(PLOT_BOTTOM - (cumulative / yMax) * PLOT_HEIGHT);

  const toLevel = (raw: RawLevel): DepthCurveLevel => ({
    cumulative: raw.cumulative,
    price: raw.price,
    size: raw.size,
    venues: raw.venues,
    x: xOf(raw.price),
    y: yOf(raw.cumulative),
  });

  const bids = rawBids.map(toLevel);
  const asks = rawAsks.map(toLevel);
  const bidPaths = buildBidPaths(bids);
  const askPaths = buildAskPaths(asks);

  let midMarker: DepthCurveMidMarker | null = null;
  if (ladder.bookState !== null && ladder.mid !== null) {
    const midPrice = formatDepthPrice(ladder.mid, options.digits);
    const prefix =
      ladder.bookState === "normal"
        ? "Mid"
        : ladder.bookState === "locked"
          ? "Locked"
          : "Crossed";
    midMarker = {
      label: `${prefix} ${midPrice}`,
      state: ladder.bookState,
      x: xOf(ladder.mid),
    };
  }

  let spreadBand: DepthCurveSpreadBand | null = null;
  if (
    ladder.bookState === "normal" &&
    ladder.bestBid !== null &&
    ladder.bestAsk !== null
  ) {
    const x = xOf(ladder.bestBid);
    spreadBand = {
      width: Math.max(1, roundCoord(xOf(ladder.bestAsk) - x)),
      x,
    };
  }

  const bidSharePct =
    ladder.bidShare === null ? null : Math.round(ladder.bidShare * 100);
  const askSharePct = bidSharePct === null ? null : 100 - bidSharePct;

  return {
    ariaLabel: buildAriaLabel(ladder, options),
    askAreaPath: askPaths.area,
    askLinePath: askPaths.line,
    asks,
    askSharePct,
    bestAskPoint: asks[0] ?? null,
    bestBidPoint: bids[0] ?? null,
    bidAreaPath: bidPaths.area,
    bidLinePath: bidPaths.line,
    bids,
    bidSharePct,
    height: DEPTH_CURVE_HEIGHT,
    midMarker,
    plotBottom: PLOT_BOTTOM,
    plotLeft: PLOT_LEFT,
    plotRight: PLOT_RIGHT,
    plotTop: PLOT_TOP,
    spreadBand,
    totalAsk: ladder.totalAsk,
    totalBid: ladder.totalBid,
    width: DEPTH_CURVE_WIDTH,
    xTicks: buildXTicks(minPrice, maxPrice, options.digits, xOf),
    yMax,
    yTicks: tickValues.map((value) => ({
      label: formatCompactSize(value),
      pos: yOf(value),
      value,
    })),
  };
};
