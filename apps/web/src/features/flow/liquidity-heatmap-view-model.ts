// What: pure view-model of the Bookmap-style liquidity heatmap panel of /flow
// (flow.liquidityHeatmap, flow-liquidity-heatmap.v1): the future that a page symbol shows, title,
// depth status line, capture badge, heat-tier color stops, trade-dot sizing, SVG plot geometry
// (heatmap cells, gap rects, segmented mid/BBO lines, trade dots, right-edge DOM bars, price/time
// ticks), keyboard/hover column inspection, wall table rows, and large-print table rows.
// Research only: resting book size and trade dots describe market depth and prints, never a signal.
// Used by: apps/web/src/components/portal/flow-liquidity-heatmap-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/designs/vertex-viz-liquidity-heatmap/design.md.
import {
  FLOW_GROUPS,
  FLOW_INSTRUMENTS,
  type FlowLiquidityHeatmap,
  type FlowLiquidityHeatmapCaptureMode,
  type FlowTapeSymbol,
} from "@darkfactory/api";

import {
  formatDuration,
  formatEtSeconds,
  formatNyTime,
  formatPrice,
} from "./format.ts";
import type { FlowSymbol, FlowWindowMinutes, Tone } from "./view-model.ts";

/** What the page asks flow.liquidityHeatmap for: one futures symbol and one window choice. */
export type LiquidityHeatmapRequest = Readonly<{
  minutes: FlowWindowMinutes;
  symbol: FlowTapeSymbol;
}>;

export type HeatTier = 0 | 1 | 2 | 3 | 4 | 5;
export type VisibleHeatTier = 1 | 2 | 3 | 4 | 5;

export type HeatTierStop = Readonly<{
  fill: string;
  label: string;
  opacity: number;
  tier: VisibleHeatTier;
}>;

/**
 * Five progressive thermal stops designed to stay legible over both dark and light card surfaces
 * while staying consistent with the Vertex gray/gold palette.
 */
export const HEAT_TIER_STOPS: readonly HeatTierStop[] = Object.freeze([
  { fill: "#334155", label: "<15% p95", opacity: 0.34, tier: 1 },
  { fill: "#0e7490", label: "15–35%", opacity: 0.56, tier: 2 },
  { fill: "#0d9488", label: "35–55%", opacity: 0.72, tier: 3 },
  { fill: "#ca8a04", label: "55–80%", opacity: 0.85, tier: 4 },
  { fill: "#f59e0b", label: "≥80% p95", opacity: 0.96, tier: 5 },
]);

export const HEAT_TIER_STYLE: Readonly<
  Record<VisibleHeatTier, Readonly<{ fill: string; opacity: number }>>
> = Object.freeze({
  1: { fill: "#334155", opacity: 0.34 },
  2: { fill: "#0e7490", opacity: 0.56 },
  3: { fill: "#0d9488", opacity: 0.72 },
  4: { fill: "#ca8a04", opacity: 0.85 },
  5: { fill: "#f59e0b", opacity: 0.96 },
});

const HEATMAP_PLOT_WIDTH = 920;
const HEATMAP_PLOT_HEIGHT = 340;
const HEATMAP_MARGIN_LEFT = 68;
const HEATMAP_MARGIN_RIGHT = 82;
const HEATMAP_MARGIN_TOP = 14;
const HEATMAP_MARGIN_BOTTOM = 28;
const HEATMAP_DOM_GAP = 8;
const HEATMAP_DOM_WIDTH = 66;
const HEATMAP_TABLE_TRADE_LIMIT = 20;

export const LIQUIDITY_HEATMAP_LOADING = "Loading liquidity heatmap…";
export const LIQUIDITY_HEATMAP_EMPTY =
  "No recorded L2 depth snapshots in this window yet.";

export const LIQUIDITY_HEATMAP_WALL_HEADERS = Object.freeze([
  "Price",
  "Side",
  "Resting size",
  "Persistence",
] as const);

export const LIQUIDITY_HEATMAP_TRADE_HEADERS = Object.freeze([
  "Time (ET)",
  "Side",
  "Price",
  "Size",
  "Signing",
] as const);

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const DEPTH_STATE_WORDS: Readonly<
  Record<FlowLiquidityHeatmap["depth"]["state"], string>
> = {
  closed: "market closed",
  fresh: "fresh",
  never: "never collected",
  stale: "stale",
};

const CAPTURE_WORDS: Readonly<Record<FlowLiquidityHeatmapCaptureMode, string>> =
  {
    mixed: "mixed streamed + sampled",
    none: "no recorded depth",
    sampled: "sampled 1m fallback",
    streamed: "streamed 5s L2",
  };

const CAPTURE_BADGES: Readonly<
  Record<
    FlowLiquidityHeatmapCaptureMode,
    Readonly<{ label: string; tone: Tone }>
  >
> = {
  mixed: { label: "Mixed L2", tone: "warning" },
  none: { label: "No depth", tone: "neutral" },
  sampled: { label: "Sampled 1m", tone: "info" },
  streamed: { label: "Streamed L2", tone: "success" },
};

/** The future of the symbol's index group: the L2 book that the panel shows for the symbol. */
export const heatmapSymbolOf = (symbol: FlowSymbol): FlowTapeSymbol =>
  FLOW_GROUPS[FLOW_INSTRUMENTS[symbol].group].future as FlowTapeSymbol;

/** "Liquidity heatmap (ES)", or "Liquidity heatmap (ES, the future of the S&P 500 group)". */
export const liquidityHeatmapTitle = (symbol: FlowSymbol): string => {
  const future = heatmapSymbolOf(symbol);
  if (future === symbol) return `Liquidity heatmap (${future})`;
  const group = FLOW_GROUPS[FLOW_INSTRUMENTS[symbol].group].label;
  return `Liquidity heatmap (${future}, the future of the ${group} group)`;
};

/** Status badge label and tone for the window's L2 capture mode. */
export const captureBadge = (
  capture: FlowLiquidityHeatmapCaptureMode
): Readonly<{ label: string; tone: Tone }> => CAPTURE_BADGES[capture];

/** Summary line of contract, freshness state, capture mode, coverage, and stale/never detail. */
export const depthStatusLine = (document: FlowLiquidityHeatmap): string => {
  const { message, state } = document.depth;
  const parts = [
    `CME L2 ${document.contract ?? document.symbol}: ${DEPTH_STATE_WORDS[state]}`,
    CAPTURE_WORDS[document.capture],
    `${document.totals.recordedColumns} of ${document.totals.totalColumns} columns (${Math.round(document.totals.coveragePct)}%)`,
    `${formatDuration(document.columnSeconds)} columns`,
  ];
  if ((state === "stale" || state === "never") && message !== null) {
    parts.push(`last read: ${message}`);
  }
  return parts.join(" · ");
};

/**
 * Maps a resting book size against the window p95 scale into discrete heat tiers 0..5.
 * Returns 0 when p95Size <= 0 or size <= 0 or either is non-finite.
 */
export const heatCellTier = (size: number, p95Size: number): HeatTier => {
  if (
    !(Number.isFinite(size) && Number.isFinite(p95Size)) ||
    size <= 0 ||
    p95Size <= 0
  ) {
    return 0;
  }
  const ratio = size / p95Size;
  if (ratio < 0.15) return 1;
  if (ratio < 0.35) return 2;
  if (ratio < 0.55) return 3;
  if (ratio < 0.8) return 4;
  return 5;
};

/** Trade bubble radius in SVG px, bounded to [3, 11]. */
export const tradeDotRadius = (size: number): number => {
  const safe = Number.isFinite(size) && size > 0 ? size : 0;
  return Math.min(11, Math.max(3, 2.5 + Math.sqrt(safe) * 0.6));
};

export type HeatmapGapRect = Readonly<{
  endIndex: number;
  startIndex: number;
  width: number;
  x: number;
}>;

export type HeatmapPlotCell = Readonly<{
  height: number;
  key: string;
  side: FlowLiquidityHeatmap["columns"][number]["cells"][number]["side"];
  size: number;
  tier: VisibleHeatTier;
  width: number;
  x: number;
  y: number;
}>;

export type HeatmapPoint = Readonly<{
  x: number;
  y: number;
}>;

export type HeatmapTradeDot = Readonly<{
  cx: number;
  cy: number;
  key: string;
  label: string;
  price: number;
  r: number;
  side: "buy" | "sell";
  size: number;
}>;

export type HeatmapDomBar = Readonly<{
  height: number;
  key: string;
  price: number;
  side: "bid" | "ask";
  size: number;
  width: number;
  x: number;
  y: number;
}>;

export type HeatmapPriceTick = Readonly<{
  label: string;
  price: number;
  y: number;
}>;

export type HeatmapTimeTick = Readonly<{
  label: string;
  x: number;
}>;

export type LiquidityHeatmapPlot = Readonly<{
  bestAskSegments: readonly string[];
  bestBidSegments: readonly string[];
  cells: readonly HeatmapPlotCell[];
  chartHeight: number;
  chartWidth: number;
  chartX: number;
  chartY: number;
  columnCount: number;
  columnWidth: number;
  defaultInspectIndex: number | null;
  domBars: readonly HeatmapDomBar[];
  domWidth: number;
  domX: number;
  gapRects: readonly HeatmapGapRect[];
  height: number;
  midDots: readonly HeatmapPoint[];
  midSegments: readonly string[];
  priceTicks: readonly HeatmapPriceTick[];
  timeTicks: readonly HeatmapTimeTick[];
  tradeDots: readonly HeatmapTradeDot[];
  width: number;
}>;

const roundCoord = (value: number): number => Math.round(value * 100) / 100;

const buildSegments = (
  points: readonly (HeatmapPoint | null)[]
): Readonly<{ dots: HeatmapPoint[]; segments: string[] }> => {
  const segments: string[] = [];
  const dots: HeatmapPoint[] = [];
  let current: HeatmapPoint[] = [];
  const flush = () => {
    if (current.length >= 2) {
      segments.push(current.map((pt) => `${pt.x},${pt.y}`).join(" "));
    } else if (current.length === 1) {
      dots.push(current[0] as HeatmapPoint);
    }
    current = [];
  };
  for (const point of points) {
    if (point === null) {
      flush();
    } else {
      current.push(point);
    }
  }
  flush();
  return { dots, segments };
};

const pickTickIndices = (count: number, maxTicks: number): number[] => {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const target = Math.min(count, maxTicks);
  const indices: number[] = [];
  for (let i = 0; i < target; i++) {
    indices.push(Math.round((i * (count - 1)) / (target - 1)));
  }
  return indices;
};

/** X-center in SVG viewBox coordinates of a given column index. */
export const columnCenterX = (
  plot: Pick<LiquidityHeatmapPlot, "chartX" | "columnCount" | "columnWidth">,
  index: number
): number => {
  if (plot.columnCount <= 0) return plot.chartX;
  const clamped = Math.max(0, Math.min(plot.columnCount - 1, index));
  return roundCoord(plot.chartX + (clamped + 0.5) * plot.columnWidth);
};

/** Maps a normalized [0, 1] pointer fraction across the heatmap chart area to a column index. */
export const columnIndexFromRatio = (
  columnCount: number,
  ratio: number
): number | null => {
  if (columnCount <= 0) return null;
  const clamped = Math.max(0, Math.min(0.999_999, ratio));
  return Math.floor(clamped * columnCount);
};

type PlotCoords = Readonly<{
  chartHeight: number;
  chartWidth: number;
  chartX: number;
  chartY: number;
  columnWidth: number;
  domWidth: number;
  domX: number;
  priceCount: number;
  rowHeight: number;
  yOfBucket: (bucketIndex: number) => number;
  yOfPrice: (price: number) => number | null;
}>;

const createPlotCoords = (document: FlowLiquidityHeatmap): PlotCoords => {
  const chartX = HEATMAP_MARGIN_LEFT;
  const chartY = HEATMAP_MARGIN_TOP;
  const chartWidth =
    HEATMAP_PLOT_WIDTH - HEATMAP_MARGIN_LEFT - HEATMAP_MARGIN_RIGHT;
  const chartHeight =
    HEATMAP_PLOT_HEIGHT - HEATMAP_MARGIN_TOP - HEATMAP_MARGIN_BOTTOM;
  const domX = chartX + chartWidth + HEATMAP_DOM_GAP;
  const domWidth = HEATMAP_DOM_WIDTH;
  const columnCount = document.columns.length;
  const columnWidth = columnCount > 0 ? chartWidth / columnCount : chartWidth;
  const priceCount = document.priceLevels.length;
  const rowHeight = priceCount > 0 ? chartHeight / priceCount : chartHeight;

  const yOfBucket = (bucketIndex: number): number =>
    roundCoord(chartY + (priceCount - 1 - bucketIndex) * rowHeight);

  const yOfPrice = (price: number): number | null => {
    if (
      priceCount === 0 ||
      document.priceMin === null ||
      document.priceMax === null
    ) {
      return null;
    }
    if (document.priceMax <= document.priceMin) {
      return roundCoord(chartY + chartHeight / 2);
    }
    const clamped = Math.max(
      document.priceMin,
      Math.min(document.priceMax, price)
    );
    const fraction =
      (clamped - document.priceMin) / (document.priceMax - document.priceMin);
    return roundCoord(
      chartY +
        chartHeight -
        rowHeight / 2 -
        fraction * (chartHeight - rowHeight)
    );
  };

  return {
    chartHeight,
    chartWidth,
    chartX,
    chartY,
    columnWidth,
    domWidth,
    domX,
    priceCount,
    rowHeight,
    yOfBucket,
    yOfPrice,
  };
};

const pushGap = (
  gapRects: HeatmapGapRect[],
  startIndex: number,
  endIndex: number,
  coords: PlotCoords
): void => {
  gapRects.push({
    endIndex,
    startIndex,
    width: roundCoord((endIndex - startIndex + 1) * coords.columnWidth),
    x: roundCoord(coords.chartX + startIndex * coords.columnWidth),
  });
};

const collectColumnCells = (
  col: FlowLiquidityHeatmap["columns"][number],
  colIdx: number,
  p95Size: number,
  coords: PlotCoords,
  out: HeatmapPlotCell[]
): void => {
  const x = roundCoord(coords.chartX + colIdx * coords.columnWidth);
  const width = roundCoord(Math.max(1, coords.columnWidth + 0.4));
  const height = roundCoord(Math.max(1, coords.rowHeight));
  for (const cell of col.cells) {
    const tier = heatCellTier(cell.s, p95Size);
    if (tier === 0) continue;
    out.push({
      height,
      key: `${colIdx}:${cell.p}`,
      side: cell.side,
      size: cell.s,
      tier,
      width,
      x,
      y: coords.yOfBucket(cell.p),
    });
  }
};

const buildColumnsLayer = (
  document: FlowLiquidityHeatmap,
  coords: PlotCoords
) => {
  const gapRects: HeatmapGapRect[] = [];
  const cells: HeatmapPlotCell[] = [];
  const midPoints: (HeatmapPoint | null)[] = [];
  const bidPoints: (HeatmapPoint | null)[] = [];
  const askPoints: (HeatmapPoint | null)[] = [];
  let defaultInspectIndex: number | null = null;
  let openGapStart: number | null = null;

  for (let colIdx = 0; colIdx < document.columns.length; colIdx++) {
    const col = document.columns[
      colIdx
    ] as FlowLiquidityHeatmap["columns"][number];
    if (col.state === "no_data") {
      openGapStart ??= colIdx;
      midPoints.push(null);
      bidPoints.push(null);
      askPoints.push(null);
      continue;
    }
    if (openGapStart !== null) {
      pushGap(gapRects, openGapStart, colIdx - 1, coords);
      openGapStart = null;
    }
    defaultInspectIndex = colIdx;
    const centerX = roundCoord(
      coords.chartX + (colIdx + 0.5) * coords.columnWidth
    );
    const pointAt = (price: number | null): HeatmapPoint | null => {
      const y = price === null ? null : coords.yOfPrice(price);
      return y === null ? null : { x: centerX, y };
    };
    midPoints.push(pointAt(col.mid));
    bidPoints.push(pointAt(col.bestBid));
    askPoints.push(pointAt(col.bestAsk));
    collectColumnCells(col, colIdx, document.scale.p95Size, coords, cells);
  }

  if (openGapStart !== null) {
    pushGap(gapRects, openGapStart, document.columns.length - 1, coords);
  }

  return {
    askBuilt: buildSegments(askPoints),
    bidBuilt: buildSegments(bidPoints),
    cells,
    defaultInspectIndex,
    gapRects,
    midBuilt: buildSegments(midPoints),
  };
};

const buildTradeDots = (
  document: FlowLiquidityHeatmap,
  coords: PlotCoords
): HeatmapTradeDot[] => {
  const axisStartMs = Date.parse(document.axisStart);
  const axisSpanMs = Math.max(1, Date.parse(document.axisEnd) - axisStartMs);
  const dots: HeatmapTradeDot[] = [];
  for (let i = 0; i < document.trades.length; i++) {
    const trade = document.trades[i] as FlowLiquidityHeatmap["trades"][number];
    const cy = coords.yOfPrice(trade.price);
    if (cy === null) continue;
    const ratio = Math.max(
      0,
      Math.min(1, (Date.parse(trade.t) - axisStartMs) / axisSpanMs)
    );
    dots.push({
      cx: roundCoord(coords.chartX + ratio * coords.chartWidth),
      cy,
      key: `${trade.t}:${i}`,
      label: `${trade.side === "buy" ? "Buy" : "Sell"} ${whole.format(trade.size)} @ ${formatPrice(trade.price)} (${formatEtSeconds(trade.t)})`,
      price: trade.price,
      r: roundCoord(tradeDotRadius(trade.size)),
      side: trade.side,
      size: trade.size,
    });
  }
  return dots;
};

const buildDomBars = (
  document: FlowLiquidityHeatmap,
  coords: PlotCoords
): HeatmapDomBar[] => {
  const maxDomSize = document.currentDom.reduce(
    (max, level) => Math.max(max, level.bidSize, level.askSize),
    0
  );
  if (maxDomSize <= 0) return [];
  const bars: HeatmapDomBar[] = [];
  for (const level of document.currentDom) {
    const baseY = coords.yOfBucket(level.p);
    const hasBid = level.bidSize > 0;
    const hasAsk = level.askSize > 0;
    const barH = roundCoord(
      Math.max(
        1,
        hasBid && hasAsk ? coords.rowHeight / 2 - 0.5 : coords.rowHeight - 1
      )
    );
    if (hasAsk) {
      bars.push({
        height: barH,
        key: `ask:${level.p}`,
        price: level.price,
        side: "ask",
        size: level.askSize,
        width: roundCoord(
          Math.max(2, (level.askSize / maxDomSize) * coords.domWidth)
        ),
        x: coords.domX,
        y: roundCoord(baseY + 0.5),
      });
    }
    if (hasBid) {
      bars.push({
        height: barH,
        key: `bid:${level.p}`,
        price: level.price,
        side: "bid",
        size: level.bidSize,
        width: roundCoord(
          Math.max(2, (level.bidSize / maxDomSize) * coords.domWidth)
        ),
        x: coords.domX,
        y: roundCoord(hasAsk ? baseY + coords.rowHeight / 2 : baseY + 0.5),
      });
    }
  }
  return bars;
};

/** Builds all deterministic SVG plot geometry for a FlowLiquidityHeatmap document. */
export const buildLiquidityHeatmapPlot = (
  document: FlowLiquidityHeatmap
): LiquidityHeatmapPlot => {
  const coords = createPlotCoords(document);
  const columnsLayer = buildColumnsLayer(document, coords);
  const priceTicks: HeatmapPriceTick[] = pickTickIndices(
    coords.priceCount,
    6
  ).map((idx) => {
    const price = document.priceLevels[idx] as number;
    return {
      label: formatPrice(price),
      price,
      y: roundCoord(coords.yOfBucket(idx) + coords.rowHeight / 2),
    };
  });
  const timeTicks: HeatmapTimeTick[] = pickTickIndices(
    document.columns.length,
    6
  ).map((idx) => {
    const col = document.columns[
      idx
    ] as FlowLiquidityHeatmap["columns"][number];
    return {
      label: formatNyTime(col.t),
      x: roundCoord(coords.chartX + (idx + 0.5) * coords.columnWidth),
    };
  });

  return {
    bestAskSegments: columnsLayer.askBuilt.segments,
    bestBidSegments: columnsLayer.bidBuilt.segments,
    cells: columnsLayer.cells,
    chartHeight: coords.chartHeight,
    chartWidth: coords.chartWidth,
    chartX: coords.chartX,
    chartY: coords.chartY,
    columnCount: document.columns.length,
    columnWidth: coords.columnWidth,
    defaultInspectIndex: columnsLayer.defaultInspectIndex,
    domBars: buildDomBars(document, coords),
    domWidth: coords.domWidth,
    domX: coords.domX,
    gapRects: columnsLayer.gapRects,
    height: HEATMAP_PLOT_HEIGHT,
    midDots: columnsLayer.midBuilt.dots,
    midSegments: columnsLayer.midBuilt.segments,
    priceTicks,
    timeTicks,
    tradeDots: buildTradeDots(document, coords),
    width: HEATMAP_PLOT_WIDTH,
  };
};

export type ColumnInspection = Readonly<{
  bestAskLabel: string;
  bestBidLabel: string;
  captureLabel: string;
  cellCount: number;
  index: number;
  midLabel: string;
  spreadLabel: string;
  state: FlowLiquidityHeatmap["columns"][number]["state"];
  timeLabel: string;
  topLevelLabel: string;
}>;

/** Returns a formatted summary of one column for hover / keyboard inspection. */
export const inspectColumnSummary = (
  document: FlowLiquidityHeatmap,
  index: number
): ColumnInspection | null => {
  if (index < 0 || index >= document.columns.length) return null;
  const col = document.columns[
    index
  ] as FlowLiquidityHeatmap["columns"][number];
  const spread =
    col.bestBid !== null && col.bestAsk !== null
      ? Math.max(0, col.bestAsk - col.bestBid)
      : null;

  let topCell: FlowLiquidityHeatmap["columns"][number]["cells"][number] | null =
    null;
  for (const cell of col.cells) {
    if (topCell === null || cell.s > topCell.s) {
      topCell = cell;
    }
  }
  const topPrice =
    topCell === null ? null : (document.priceLevels[topCell.p] ?? null);
  const topLevelLabel =
    topCell === null || topPrice === null
      ? "No resting depth"
      : `${whole.format(topCell.s)} ${topCell.side} @ ${formatPrice(topPrice)}`;

  const captureLabel =
    col.state === "no_data"
      ? "No data gap"
      : col.capture === "streamed"
        ? "Streamed"
        : "Sampled";

  return {
    bestAskLabel: formatPrice(col.bestAsk, "No ask"),
    bestBidLabel: formatPrice(col.bestBid, "No bid"),
    captureLabel,
    cellCount: col.cells.length,
    index,
    midLabel: formatPrice(col.mid, "No price"),
    spreadLabel: spread === null ? "No spread" : spread.toFixed(2),
    state: col.state,
    timeLabel: formatEtSeconds(col.t),
    topLevelLabel,
  };
};

export type LiquidityWallRow = Readonly<{
  key: string;
  persistence: string;
  price: string;
  side: "Bid" | "Ask";
  size: string;
}>;

/** Formats persistent resting walls for the accessible wall table. */
export const wallRows = (
  document: FlowLiquidityHeatmap
): readonly LiquidityWallRow[] =>
  document.walls.map((wall) => ({
    key: `${wall.side}:${wall.price}`,
    persistence: `${Math.round(wall.persistencePct)}% (${wall.columnsPresent} col)`,
    price: formatPrice(wall.price),
    side: wall.side === "bid" ? "Bid" : "Ask",
    size: whole.format(wall.size),
  }));

export type LiquidityTradeRow = Readonly<{
  key: string;
  price: string;
  side: "Buy" | "Sell";
  signing: "Quote" | "Tick";
  size: string;
  time: string;
}>;

/** Formats up to HEATMAP_TABLE_TRADE_LIMIT newest large prints for the accessible print table. */
export const tradeRows = (
  document: FlowLiquidityHeatmap
): readonly LiquidityTradeRow[] =>
  [...document.trades]
    .reverse()
    .slice(0, HEATMAP_TABLE_TRADE_LIMIT)
    .map((trade, index) => ({
      key: `${trade.t}:${trade.price}:${trade.size}:${index}`,
      price: formatPrice(trade.price),
      side: trade.side === "buy" ? "Buy" : "Sell",
      signing: trade.signing === "quote" ? "Quote" : "Tick",
      size: whole.format(trade.size),
      time: formatEtSeconds(trade.t),
    }));

/** Accessible label for the liquidity heatmap SVG graphic. */
export const heatmapAriaLabel = (document: FlowLiquidityHeatmap): string => {
  if (document.totals.recordedColumns === 0) {
    return `${document.symbol} liquidity heatmap: no recorded L2 depth snapshots in this window.`;
  }
  return `${document.symbol} Bookmap-style liquidity heatmap from ${formatNyTime(document.axisStart)} to ${formatNyTime(document.axisEnd)}: ${document.totals.recordedColumns} of ${document.totals.totalColumns} columns recorded (${CAPTURE_WORDS[document.capture]}), ${document.walls.length} resting walls, ${document.totals.largeTrades} large prints.`;
};

/** Method and limits sentence below the liquidity heatmap. */
export const heatmapRuleLine = (document: FlowLiquidityHeatmap): string =>
  `Color scale normalizes to the window 95th percentile (${whole.format(document.scale.p95Size)} contracts; max ${whole.format(document.scale.maxSize)}). Trade dots show prints ≥ ${whole.format(document.rules.largeTradeLimit)} contracts (${document.totals.largeTrades} in window${document.tradesTruncated ? `; newest ${whole.format(document.trades.length)} plotted` : ""}). Read-only research view; not a trade signal.`;
