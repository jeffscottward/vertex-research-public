// What: pure SVG view-model for drawing gamma flip, call wall, put wall, max pain, and king node
// on /flow price charts:
// 1) `buildFlowGexPriceChart(snapshot)`: dedicated intraday price path + full 5-level gamma ladder
//    inside GexPanel (works for SPY, QQQ, ES, and NQ).
// 2) `buildFlowPriceOverlayLevels(...)`: horizontal level lines + off-scale edge summaries overlaid
//    on existing /flow intraday price charts (FlowTradeBubblesPanel for ES/NQ,
//    FlowOptionBubblesPanel for SPY/QQQ) without squashing the intraday candle/bubble Y-axis.
// Display only: research context, never a trade signal or order input.
// Used by: components/portal/flow-gamma-levels-chart.tsx,
// components/portal/flow-trade-bubbles-panel.tsx,
// components/portal/flow-option-bubbles-panel.tsx.

import type { FlowGex, FlowSnapshot, FlowSymbol } from "@darkfactory/api";

import {
  extractGammaLevelEntries,
  GAMMA_LEVEL_META,
  type GammaLevelEntry,
  type GammaLevelKind,
  type GammaLevelsOverlay,
  gammaLevelsFromFlowGex,
  groupCoincidentGammaLevels,
  resolveGammaLabelY,
} from "../charts/gamma-levels-overlay.ts";
import { formatNyTime, formatPrice } from "./format.ts";

export const FLOW_GAMMA_COLOR_VAR: Readonly<Record<GammaLevelKind, string>> =
  Object.freeze({
    callWall: "var(--success)",
    flip: "var(--warning)",
    kingNode: "var(--chart-5)",
    maxPain: "var(--info)",
    putWall: "var(--destructive)",
  });

export type SvgGammaLevelLine = Readonly<{
  key: string;
  price: number;
  y: number;
  labelY: number;
  pillText: string;
  shortLabel: string;
  glyphs: string;
  color: string;
  accentColor: string;
  dashArray: string | undefined;
  strokeWidth: number;
  hasKingNode: boolean;
  isMergedWithKing: boolean;
  primaryKind: GammaLevelKind;
}>;

export type OffScaleGammaLevel = Readonly<{
  key: string;
  price: number;
  priceText: string;
  pillText: string;
  glyphs: string;
  shortLabel: string;
  color: string;
  dashArray: string | undefined;
  strokeWidth: number;
  distanceText: string | null;
}>;

export type FlowPriceOverlayLevels = Readonly<{
  overlay: GammaLevelsOverlay;
  entries: readonly GammaLevelEntry[];
  visibleLines: readonly SvgGammaLevelLine[];
  offScaleAbove: readonly OffScaleGammaLevel[];
  offScaleBelow: readonly OffScaleGammaLevel[];
}>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

const formatSignedPct = (
  price: number,
  referencePrice: number | null
): string | null => {
  if (
    referencePrice === null ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  )
    return null;
  const pct = ((price - referencePrice) / referencePrice) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
};

/**
 * Computes SVG line geometry for gamma levels over an existing /flow price chart's Y-axis.
 * Levels within `[priceMin, priceMax]` plot as full-width horizontal lines with de-overlapped
 * right-edge labels; levels outside the intraday range collect into `offScaleAbove`/`offScaleBelow`.
 */
export const buildFlowPriceOverlayLevels = (
  input: Readonly<{
    symbol: string;
    gex: FlowGex | null;
    priceMin: number;
    priceMax: number;
    chartY: number;
    chartHeight: number;
    referencePrice?: number | null;
    pricePrecision?: number;
  }>
): FlowPriceOverlayLevels | null => {
  const overlay = gammaLevelsFromFlowGex(input.symbol, input.gex);
  if (overlay === null) return null;
  const span = input.priceMax - input.priceMin;
  if (!Number.isFinite(span) || span <= 0 || input.chartHeight <= 0)
    return null;

  const precision = input.pricePrecision ?? 2;
  const ref = input.referencePrice ?? overlay.spot;
  const groups = groupCoincidentGammaLevels(overlay, precision);
  const entries = extractGammaLevelEntries(overlay, ref);
  const kingColor = FLOW_GAMMA_COLOR_VAR.kingNode;

  const inRange: {
    group: (typeof groups)[number];
    y: number;
  }[] = [];
  const offScaleAbove: OffScaleGammaLevel[] = [];
  const offScaleBelow: OffScaleGammaLevel[] = [];

  for (const group of groups) {
    const meta = GAMMA_LEVEL_META[group.primaryKind];
    const color = FLOW_GAMMA_COLOR_VAR[group.primaryKind];
    const strokeWidth = group.hasKingNode
      ? Math.max(meta.strokeWidth, 2.25)
      : meta.strokeWidth;
    if (group.price > input.priceMax) {
      offScaleAbove.push({
        color,
        dashArray: meta.svgDashArray,
        distanceText: formatSignedPct(group.price, ref),
        glyphs: group.glyphs,
        key: group.key,
        pillText: group.pillText,
        price: group.price,
        priceText: group.price.toFixed(precision),
        shortLabel: group.shortLabel,
        strokeWidth,
      });
    } else if (group.price < input.priceMin) {
      offScaleBelow.push({
        color,
        dashArray: meta.svgDashArray,
        distanceText: formatSignedPct(group.price, ref),
        glyphs: group.glyphs,
        key: group.key,
        pillText: group.pillText,
        price: group.price,
        priceText: group.price.toFixed(precision),
        shortLabel: group.shortLabel,
        strokeWidth,
      });
    } else {
      const ratio = (group.price - input.priceMin) / span;
      const y = round1(input.chartY + (1 - ratio) * input.chartHeight);
      inRange.push({ group, y });
    }
  }

  const minLabelY = input.chartY + 10;
  const maxLabelY = Math.max(minLabelY, input.chartY + input.chartHeight - 10);
  const placed = resolveGammaLabelY(
    inRange.map((item) => ({ id: item.group.key, idealY: item.y })),
    minLabelY,
    maxLabelY,
    18
  );

  const visibleLines: SvgGammaLevelLine[] = inRange.map(({ group, y }) => {
    const meta = GAMMA_LEVEL_META[group.primaryKind];
    return {
      accentColor: kingColor,
      color: FLOW_GAMMA_COLOR_VAR[group.primaryKind],
      dashArray: meta.svgDashArray,
      glyphs: group.glyphs,
      hasKingNode: group.hasKingNode,
      isMergedWithKing: group.hasKingNode && group.kinds.length > 1,
      key: group.key,
      labelY: round1(placed[group.key] as number),
      pillText: group.pillText,
      price: group.price,
      primaryKind: group.primaryKind,
      shortLabel: group.shortLabel,
      strokeWidth: group.hasKingNode
        ? Math.max(meta.strokeWidth, 2.25)
        : meta.strokeWidth,
      y,
    };
  });

  return {
    entries,
    offScaleAbove,
    offScaleBelow,
    overlay,
    visibleLines,
  };
};

// --- Dedicated GexPanel intraday price + gamma levels chart ------------------------------------

const CHART_WIDTH = 720;
const CHART_HEIGHT = 240;
const PAD_LEFT = 68;
const PAD_RIGHT = 14;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

export type GexPriceChartTick = Readonly<{
  pos: number;
  label: string;
}>;

export type GexPriceChartTimeTick = Readonly<{
  pos: number;
  label: string;
  anchor: "start" | "middle" | "end";
}>;

export type FlowGexPriceChart = Readonly<{
  width: number;
  height: number;
  chartX: number;
  chartY: number;
  chartWidth: number;
  chartHeight: number;
  symbol: FlowSymbol;
  overlay: GammaLevelsOverlay;
  entries: readonly GammaLevelEntry[];
  lines: readonly SvgGammaLevelLine[];
  priceSegments: readonly string[];
  vwapSegments: readonly string[];
  spotX: number | null;
  spotY: number | null;
  spotLabel: string | null;
  lastPrice: number | null;
  priceTicks: readonly GexPriceChartTick[];
  timeTicks: readonly GexPriceChartTimeTick[];
  hasMinuteSeries: boolean;
  ariaLabel: string;
}>;

const buildPolylineSegments = (
  points: readonly Readonly<{ ms: number; price: number }>[],
  xOf: (ms: number) => number,
  yOf: (price: number) => number
): readonly string[] => {
  if (points.length === 0) return [];
  const segments: string[] = [];
  let current: string[] = [];
  let prevMs: number | null = null;
  for (const pt of points) {
    // Break line across gaps > 3 minutes so missing tape is never silently interpolated.
    if (prevMs !== null && pt.ms - prevMs > 180_000) {
      if (current.length >= 2) segments.push(current.join(" "));
      current = [];
    }
    current.push(`${xOf(pt.ms)},${yOf(pt.price)}`);
    prevMs = pt.ms;
  }
  if (current.length >= 2) segments.push(current.join(" "));
  return segments;
};

/**
 * Builds the dedicated GEX-levels-on-price chart for `GexPanel` on /flow.
 * Fits BOTH the intraday close/VWAP price path (or spot when no minute closes exist yet)
 * AND all non-null gamma levels so the full gamma ladder around price is visible at once.
 */
export const buildFlowGexPriceChart = (
  snapshot: FlowSnapshot
): FlowGexPriceChart | null => {
  const overlay = gammaLevelsFromFlowGex(snapshot.symbol, snapshot.gex);
  if (overlay === null) return null;

  const closePoints: { ms: number; price: number }[] = [];
  const vwapPoints: { ms: number; price: number }[] = [];
  for (const minute of snapshot.minutes) {
    const ms = Date.parse(minute.minute);
    if (!Number.isFinite(ms)) continue;
    if (
      minute.close !== null &&
      Number.isFinite(minute.close) &&
      minute.close > 0
    )
      closePoints.push({ ms, price: minute.close });
    if (minute.vwap !== null && Number.isFinite(minute.vwap) && minute.vwap > 0)
      vwapPoints.push({ ms, price: minute.vwap });
  }
  closePoints.sort((a, b) => a.ms - b.ms);
  vwapPoints.sort((a, b) => a.ms - b.ms);

  const lastClose = closePoints.at(-1)?.price ?? null;
  const referencePrice = lastClose ?? overlay.spot;
  const entries = extractGammaLevelEntries(overlay, referencePrice);

  const allPrices: number[] = entries.map((entry) => entry.price);
  for (const pt of closePoints) allPrices.push(pt.price);
  for (const pt of vwapPoints) allPrices.push(pt.price);
  if (overlay.spot !== null) allPrices.push(overlay.spot);

  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const pad = Math.max((rawMax - rawMin) * 0.1, Math.max(rawMax * 0.004, 0.5));
  const priceMin = rawMin - pad;
  const priceMax = rawMax + pad;
  const priceSpan = priceMax - priceMin;

  const startMs = Date.parse(snapshot.windowStart);
  const endMs = Date.parse(snapshot.windowEnd);
  const timeSpan = Math.max(60_000, endMs - startMs);

  const xOf = (ms: number): number => {
    const ratio = Math.max(0, Math.min(1, (ms - startMs) / timeSpan));
    return round1(PAD_LEFT + ratio * PLOT_WIDTH);
  };
  const yOf = (price: number): number => {
    const ratio = Math.max(0, Math.min(1, (price - priceMin) / priceSpan));
    return round1(PAD_TOP + (1 - ratio) * PLOT_HEIGHT);
  };
  const overlayGeometry = buildFlowPriceOverlayLevels({
    chartHeight: PLOT_HEIGHT,
    chartY: PAD_TOP,
    gex: snapshot.gex,
    priceMax,
    priceMin,
    referencePrice,
    symbol: snapshot.symbol,
  }) as FlowPriceOverlayLevels;
  const priceTicks: GexPriceChartTick[] = [];
  for (let i = 0; i < 5; i += 1) {
    const frac = i / 4;
    const price = priceMax - frac * priceSpan;
    priceTicks.push({
      label: formatPrice(price),
      pos: round1(PAD_TOP + frac * PLOT_HEIGHT),
    });
  }

  const timeTicks: GexPriceChartTimeTick[] = [];
  for (let i = 0; i < 3; i += 1) {
    const frac = i / 2;
    const ms = startMs + frac * timeSpan;
    timeTicks.push({
      anchor: i === 0 ? "start" : i === 2 ? "end" : "middle",
      label: formatNyTime(new Date(ms).toISOString()),
      pos: round1(PAD_LEFT + frac * PLOT_WIDTH),
    });
  }

  const priceSegments = buildPolylineSegments(closePoints, xOf, yOf);
  const vwapSegments = buildPolylineSegments(vwapPoints, xOf, yOf);
  const hasMinuteSeries = closePoints.length > 0;
  const lastClosePoint = closePoints.at(-1) ?? null;
  const spotPrice = lastClose ?? overlay.spot;
  const spotX =
    spotPrice === null
      ? null
      : lastClosePoint === null
        ? PAD_LEFT + 8
        : xOf(lastClosePoint.ms);
  const spotY = spotPrice === null ? null : yOf(spotPrice);
  const spotLabel =
    spotPrice === null
      ? null
      : `${lastClose === null ? "Spot" : "Last"} ${formatPrice(spotPrice)}`;

  const levelSummary = entries
    .map((entry) => `${entry.label} ${formatPrice(entry.price)}`)
    .join(", ");

  return {
    ariaLabel: `${snapshot.symbol} intraday price with gamma levels: ${levelSummary}`,
    chartHeight: PLOT_HEIGHT,
    chartWidth: PLOT_WIDTH,
    chartX: PAD_LEFT,
    chartY: PAD_TOP,
    entries,
    hasMinuteSeries,
    height: CHART_HEIGHT,
    lastPrice: referencePrice,
    lines: overlayGeometry.visibleLines,
    overlay,
    priceSegments,
    priceTicks,
    spotLabel,
    spotX,
    spotY,
    symbol: snapshot.symbol,
    timeTicks,
    vwapSegments,
    width: CHART_WIDTH,
  };
};
