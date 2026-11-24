// What: pure view-model of the Big futures trades bubbles chart on /flow
// (flow.tradeBubbles, flow-trade-bubbles.v1): header/rule/status copy, side and size-multiple
// filtering, area-proportional bubble radius scaling, SVG price-chart + bubbles plot geometry
// (1-minute OHLC candles, VWAP line, paint-ordered buy/sell bubbles, axes, gridlines), keyboard
// bubble selection, and top-prints table rows.
// Research only: describes recorded CME futures prices and deep prints; never a trade signal.
// Used by: apps/web/src/components/portal/flow-trade-bubbles-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.

import type {
  FlowFreshness,
  FlowTapeSymbol,
  FlowTradeBubble,
  FlowTradeBubbles,
  FlowTradeBubblesCaptureMode,
} from "@darkfactory/api";

import {
  formatAge,
  formatCount,
  formatEtSeconds,
  formatNyTime,
  formatPrice,
  formatSigned,
} from "./format.ts";
import type { FlowSymbol, FlowWindowMinutes, Tone } from "./view-model.ts";

/** Request sent to flow.tradeBubbles for one futures symbol and window length. */
export type TradeBubblesRequest = Readonly<{
  minutes: FlowWindowMinutes;
  symbol: FlowTapeSymbol;
}>;

export const TRADE_BUBBLES_SIDE_FILTERS = ["all", "buy", "sell"] as const;
export type TradeBubblesSideFilter =
  (typeof TRADE_BUBBLES_SIDE_FILTERS)[number];

export const TRADE_BUBBLES_SIZE_FILTERS = ["all", "2x", "3x"] as const;
export type TradeBubblesSizeFilter =
  (typeof TRADE_BUBBLES_SIZE_FILTERS)[number];

export const TRADE_BUBBLES_LOADING = "Loading big futures trades…";
export const TRADE_BUBBLES_EMPTY =
  "No recorded ES/NQ minute bars or deep trades in this window yet.";

export const TRADE_BUBBLES_TABLE_HEADERS = Object.freeze([
  "Time (ET)",
  "Side",
  "Contracts",
  "Multiple",
  "Price",
  "Signing",
  "Capture",
] as const);

const PLOT_WIDTH = 880;
const PLOT_HEIGHT = 320;
const MARGIN_LEFT = 68;
const MARGIN_RIGHT = 20;
const MARGIN_TOP = 16;
const MARGIN_BOTTOM = 30;
const MIN_BUBBLE_RADIUS = 5.5;
const MAX_BUBBLE_RADIUS = 22;
const LABEL_MIN_RADIUS = 11.5;
const TABLE_LIMIT = 15;

export type TradeBubblesBadge = Readonly<{
  label: string;
  tone: Tone;
}>;

export const tradeBubblesTitle = (
  pageSymbol: FlowSymbol,
  futureSymbol: FlowTapeSymbol
): string =>
  pageSymbol === futureSymbol
    ? `Big futures trades (${futureSymbol})`
    : `Big futures trades (${futureSymbol} · ${pageSymbol} group)`;

export const tradeBubblesRuleLine = (doc: FlowTradeBubbles): string =>
  `${doc.symbol} deep trades: single prints ≥ ${formatCount(doc.rules.deepTradeLimit)} contracts (measured ${doc.rules.deepTradeLimitMeasuredOn}, ~0.1% largest prints). Bubble area scales with contract size; solid rings are buy-initiated, dashed rings are sell-initiated.`;

export const tradeBubblesCaptureBadge = (
  mode: FlowTradeBubblesCaptureMode
): TradeBubblesBadge => {
  switch (mode) {
    case "streamed":
      return { label: "Streamed tape", tone: "success" };
    case "sampled":
      return { label: "Sampled tape", tone: "warning" };
    case "mixed":
      return { label: "Mixed tape", tone: "warning" };
    case "none":
      return { label: "No deep prints", tone: "neutral" };
  }
};

export const tradeBubblesTapeBadge = (
  tape: FlowFreshness
): TradeBubblesBadge => {
  switch (tape.state) {
    case "fresh":
      return {
        label: `Tape fresh (${formatAge(tape.ageSeconds)})`,
        tone: "success",
      };
    case "stale":
      return {
        label: `Tape stale (${formatAge(tape.ageSeconds)})`,
        tone: "warning",
      };
    case "closed":
      return { label: "Market closed", tone: "neutral" };
    case "never":
      return { label: "No tape sample", tone: "warning" };
  }
};

export const tradeBubblesKey = (bubble: FlowTradeBubble): string =>
  `${bubble.second}#${bubble.seq}`;

export const filterTradeBubbles = (
  bubbles: readonly FlowTradeBubble[],
  sideFilter: TradeBubblesSideFilter,
  sizeFilter: TradeBubblesSizeFilter
): FlowTradeBubble[] => {
  const minMultiple = sizeFilter === "3x" ? 3 : sizeFilter === "2x" ? 2 : 0;
  return bubbles.filter((bubble) => {
    if (sideFilter !== "all" && bubble.side !== sideFilter) return false;
    return bubble.sizeMultiple >= minMultiple;
  });
};

/** Area-proportional radius bounded to [5.5, 22] px using the window p95 as reference. */
export const tradeBubbleRadius = (size: number, refSize: number): number => {
  const safeRef = Math.max(1, refSize);
  const ratio = Math.max(0.15, Math.min(2.25, size / safeRef));
  const normalized =
    (Math.sqrt(ratio) - Math.sqrt(0.15)) / (1.5 - Math.sqrt(0.15));
  const clamped = Math.max(0, Math.min(1, normalized));
  return (
    Math.round(
      (MIN_BUBBLE_RADIUS + clamped * (MAX_BUBBLE_RADIUS - MIN_BUBBLE_RADIUS)) *
        10
    ) / 10
  );
};

export type TradeBubblePlotCandle = Readonly<{
  bodyHeight: number;
  bodyWidth: number;
  bodyX: number;
  bodyY: number;
  direction: "up" | "down" | "flat";
  key: string;
  label: string;
  wickX: number;
  wickY1: number;
  wickY2: number;
}>;

export type TradeBubblePlotPoint = Readonly<{
  bubble: FlowTradeBubble;
  cx: number;
  cy: number;
  key: string;
  label: string;
  r: number;
  showSizeLabel: boolean;
}>;

export type TradeBubblesPlotTick = Readonly<{
  label: string;
  pos: number;
}>;

export type TradeBubblesPlot = Readonly<{
  bubbles: readonly TradeBubblePlotPoint[];
  candles: readonly TradeBubblePlotCandle[];
  chartHeight: number;
  chartWidth: number;
  chartX: number;
  chartY: number;
  chronologicalKeys: readonly string[];
  closeLinePoints: string | null;
  height: number;
  priceMax: number;
  priceMin: number;
  priceTicks: readonly TradeBubblesPlotTick[];
  timeTicks: readonly TradeBubblesPlotTick[];
  vwapLinePoints: string | null;
  width: number;
}>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

const computePlotPriceBounds = (
  doc: FlowTradeBubbles,
  filteredBubbles: readonly FlowTradeBubble[]
): Readonly<{ min: number; max: number }> | null => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of doc.candles) {
    min = Math.min(min, candle.low);
    max = Math.max(max, candle.high);
  }
  for (const bubble of filteredBubbles) {
    min = Math.min(min, bubble.price);
    max = Math.max(max, bubble.price);
  }
  if (!(Number.isFinite(min) && Number.isFinite(max))) {
    if (doc.priceRange === null) return null;
    min = doc.priceRange.min;
    max = doc.priceRange.max;
  }
  const span = max - min;
  const pad = Math.max(doc.tickSize * 2, span * 0.08);
  return { max: max + pad, min: Math.max(0.01, min - pad) };
};

/** Builds responsive SVG geometry for the price chart and big futures trade bubbles. */
export const buildTradeBubblesPlot = (
  doc: FlowTradeBubbles,
  filteredBubbles: readonly FlowTradeBubble[]
): TradeBubblesPlot | null => {
  const bounds = computePlotPriceBounds(doc, filteredBubbles);
  if (bounds === null) return null;

  const chartX = MARGIN_LEFT;
  const chartY = MARGIN_TOP;
  const chartWidth = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const chartHeight = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  const startMs = Date.parse(doc.windowStart);
  const endMs = Date.parse(doc.windowEnd);
  const timeSpan = Math.max(60_000, endMs - startMs);
  const priceSpan = Math.max(doc.tickSize, bounds.max - bounds.min);

  const xOf = (ms: number): number => {
    const ratio = Math.max(0, Math.min(1, (ms - startMs) / timeSpan));
    return round1(chartX + ratio * chartWidth);
  };
  const yOf = (price: number): number => {
    const ratio = Math.max(0, Math.min(1, (price - bounds.min) / priceSpan));
    return round1(chartY + (1 - ratio) * chartHeight);
  };

  const priceTicks: TradeBubblesPlotTick[] = [];
  const priceTickCount = 5;
  for (let i = 0; i < priceTickCount; i += 1) {
    const frac = i / (priceTickCount - 1);
    const price = bounds.max - frac * (bounds.max - bounds.min);
    priceTicks.push({
      label: formatPrice(price),
      pos: round1(chartY + frac * chartHeight),
    });
  }

  const timeTicks: TradeBubblesPlotTick[] = [];
  const timeTickCount = 5;
  for (let i = 0; i < timeTickCount; i += 1) {
    const frac = i / (timeTickCount - 1);
    const ms = startMs + frac * timeSpan;
    timeTicks.push({
      label: formatNyTime(new Date(ms).toISOString()),
      pos: round1(chartX + frac * chartWidth),
    });
  }

  const minuteWidth = (60_000 / timeSpan) * chartWidth;
  const bodyWidth = round1(Math.max(2, Math.min(10, minuteWidth * 0.68)));

  const candles: TradeBubblePlotCandle[] = doc.candles.map((candle) => {
    const centerMs = Date.parse(candle.minute) + 30_000;
    const wickX = xOf(centerMs);
    const yOpen = yOf(candle.open);
    const yClose = yOf(candle.close);
    const yHigh = yOf(candle.high);
    const yLow = yOf(candle.low);
    const direction =
      candle.close > candle.open
        ? "up"
        : candle.close < candle.open
          ? "down"
          : "flat";
    return {
      bodyHeight: round1(Math.max(1.5, Math.abs(yClose - yOpen))),
      bodyWidth,
      bodyX: round1(wickX - bodyWidth / 2),
      bodyY: round1(Math.min(yOpen, yClose)),
      direction,
      key: candle.minute,
      label: `${formatNyTime(candle.minute)} ET · O ${formatPrice(candle.open)} H ${formatPrice(candle.high)} L ${formatPrice(candle.low)} C ${formatPrice(candle.close)} · VWAP ${formatPrice(candle.vwap)}`,
      wickX,
      wickY1: yHigh,
      wickY2: yLow,
    };
  });

  const vwapLinePoints =
    doc.candles.length >= 2
      ? doc.candles
          .map(
            (candle) =>
              `${xOf(Date.parse(candle.minute) + 30_000)},${yOf(candle.vwap)}`
          )
          .join(" ")
      : null;

  const closeLinePoints =
    doc.candles.length >= 2
      ? doc.candles
          .map(
            (candle) =>
              `${xOf(Date.parse(candle.minute) + 30_000)},${yOf(candle.close)}`
          )
          .join(" ")
      : doc.candles.length === 0 && filteredBubbles.length >= 2
        ? filteredBubbles
            .map(
              (bubble) =>
                `${xOf(Date.parse(bubble.second))},${yOf(bubble.price)}`
            )
            .join(" ")
        : null;

  const refSize = doc.totals.p95Size ?? doc.rules.deepTradeLimit;
  const chronologicalPoints: TradeBubblePlotPoint[] = filteredBubbles.map(
    (bubble) => {
      const r = tradeBubbleRadius(bubble.size, refSize);
      return {
        bubble,
        cx: xOf(Date.parse(bubble.second)),
        cy: yOf(bubble.price),
        key: tradeBubblesKey(bubble),
        label: describeTradeBubble(bubble),
        r,
        showSizeLabel: r >= LABEL_MIN_RADIUS,
      };
    }
  );

  // Paint largest bubbles first so smaller bubbles sitting near the same price remain clickable.
  const paintOrdered = [...chronologicalPoints].sort(
    (a, b) => b.bubble.size - a.bubble.size
  );

  return {
    bubbles: paintOrdered,
    candles,
    chartHeight,
    chartWidth,
    chartX,
    chartY,
    chronologicalKeys: chronologicalPoints.map((point) => point.key),
    closeLinePoints,
    height: PLOT_HEIGHT,
    priceMax: bounds.max,
    priceMin: bounds.min,
    priceTicks,
    timeTicks,
    vwapLinePoints,
    width: PLOT_WIDTH,
  };
};

export const describeTradeBubble = (bubble: FlowTradeBubble): string =>
  `${formatEtSeconds(bubble.second)} ET · ${bubble.side === "buy" ? "Buy" : "Sell"} ${formatCount(bubble.size)} contracts (${bubble.sizeMultiple.toFixed(1)}×) at ${formatPrice(bubble.price)} · ${bubble.signing}-signed · ${bubble.capture}`;

export type TradeBubbleTableRow = Readonly<{
  captureLabel: string;
  contractsLabel: string;
  key: string;
  multipleLabel: string;
  priceLabel: string;
  side: "buy" | "sell";
  sideLabel: string;
  signingLabel: string;
  timeLabel: string;
}>;

/** Top deep prints by contract size (breaking ties by newest second then seq) for the table. */
export const tradeBubblesTableRows = (
  filteredBubbles: readonly FlowTradeBubble[]
): TradeBubbleTableRow[] =>
  [...filteredBubbles]
    .sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size;
      const timeDiff = Date.parse(b.second) - Date.parse(a.second);
      if (timeDiff !== 0) return timeDiff;
      return b.seq - a.seq;
    })
    .slice(0, TABLE_LIMIT)
    .map((bubble) => ({
      captureLabel: bubble.capture === "streamed" ? "Streamed" : "Sampled",
      contractsLabel: formatCount(bubble.size),
      key: tradeBubblesKey(bubble),
      multipleLabel: `${bubble.sizeMultiple.toFixed(1)}×`,
      priceLabel: formatPrice(bubble.price),
      side: bubble.side,
      sideLabel: bubble.side === "buy" ? "Buy" : "Sell",
      signingLabel: bubble.signing === "quote" ? "Quote" : "Tick",
      timeLabel: formatEtSeconds(bubble.second),
    }));

export type TradeBubblesSummary = Readonly<{
  buyContracts: string;
  buyPrints: string;
  largestPrint: string;
  netContracts: string;
  netTone: Tone;
  sellContracts: string;
  sellPrints: string;
  shownLabel: string;
}>;

export const summarizeTradeBubbles = (
  doc: FlowTradeBubbles,
  filteredBubbles: readonly FlowTradeBubble[]
): TradeBubblesSummary => {
  let buyTrades = 0;
  let sellTrades = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  let largest: FlowTradeBubble | null = null;

  for (const bubble of filteredBubbles) {
    if (bubble.side === "buy") {
      buyTrades += 1;
      buyVolume += bubble.size;
    } else {
      sellTrades += 1;
      sellVolume += bubble.size;
    }
    if (largest === null || bubble.size >= largest.size) largest = bubble;
  }

  const net = buyVolume - sellVolume;
  const netTone: Tone =
    net > 0 ? "success" : net < 0 ? "destructive" : "neutral";
  const shownLabel =
    filteredBubbles.length === doc.totals.totalTrades
      ? `${formatCount(filteredBubbles.length)} prints`
      : `${formatCount(filteredBubbles.length)} of ${formatCount(doc.totals.totalTrades)} prints`;
  return {
    buyContracts: formatCount(buyVolume),
    buyPrints: formatCount(buyTrades),
    largestPrint:
      largest === null
        ? "None"
        : `${largest.side === "buy" ? "Buy" : "Sell"} ${formatCount(largest.size)} @ ${formatPrice(largest.price)}`,
    netContracts: formatSigned(net),
    netTone,
    sellContracts: formatCount(sellVolume),
    sellPrints: formatCount(sellTrades),
    shownLabel,
  };
};

export const moveBubbleSelection = (
  keys: readonly string[],
  currentKey: string | null,
  direction: "prev" | "next" | "first" | "last"
): string | null => {
  let targetIndex = 0;
  if (direction === "last") {
    targetIndex = keys.length - 1;
  } else if (direction !== "first") {
    const index = currentKey === null ? -1 : keys.indexOf(currentKey);
    if (index === -1) {
      targetIndex = direction === "next" ? 0 : keys.length - 1;
    } else {
      targetIndex =
        direction === "next"
          ? Math.min(keys.length - 1, index + 1)
          : Math.max(0, index - 1);
    }
  }
  return keys[targetIndex] ?? null;
};
