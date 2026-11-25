// What: pure view-model of the Option print bubbles panel on /flow (flow.optionBubbles,
// flow-option-bubbles.v1): symbol gating, titles, header/totals/rule/error copy, client-side
// right and side filters, SVG plot geometry (intraday underlying price line, open gap bands,
// sqrt-premium bubble sizing, call/put color + C/P glyph, ask/bid/mid stroke encoding), keyboard
// navigation, and pinned bubble inspector readout.
// Research only: option print bubbles describe stored trades, never a trade signal.
// Used by: apps/web/src/components/portal/flow-option-bubbles-panel.tsx,
// apps/web/src/components/portal/flow-workspace.tsx.
// See: docs/vertex-rebuild/designs/vertex-viz-option-bubbles/design.md.
import {
  FLOW_INSTRUMENTS,
  FLOW_OPTION_BUBBLES_MIN_PREMIUMS,
  FLOW_OPTION_BUBBLES_SYMBOLS,
  type FlowConsolidation,
  type FlowMoneyness,
  type FlowOptionBubbles,
  type FlowOptionBubblesItem,
  type FlowOptionBubblesMinPremiumUsd,
  type FlowOptionBubblesRules,
  type FlowOptionBubblesSymbol,
  type FlowOptionSide,
} from "@darkfactory/api";

import type { FlowControlFailure } from "./control-view-model.ts";
import {
  formatCount,
  formatEtSeconds,
  formatMoney,
  formatPrice,
} from "./format.ts";
import type { FlowSymbol } from "./view-model.ts";

/** What the page asks flow.optionBubbles for: one symbol with stored option prints and premium floor. */
export type OptionBubblesRequest = Readonly<{
  symbol: FlowOptionBubblesSymbol;
  minPremiumUsd?: FlowOptionBubblesMinPremiumUsd;
}>;

/** A failed flow.optionBubbles call: error code, message, and timestamp. */
export type FlowOptionBubblesFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

export type OptionBubblesRightFilter = "all" | "call" | "put";
export type OptionBubblesSideFilter = "all" | "ask" | "bid";
export type BubbleSideStyle = "filled" | "hollow" | "dashed";

export type OptionBubblesPriceTick = Readonly<{
  price: number;
  label: string;
  y: number;
}>;

export type OptionBubblesTimeTick = Readonly<{
  label: string;
  x: number;
}>;

export type OptionBubblesGapRect = Readonly<{
  x: number;
  width: number;
  startLabel: string;
  endLabel: string;
}>;

export type OptionBubblesPlotBubble = Readonly<{
  bubble: FlowOptionBubblesItem;
  cx: number;
  cy: number;
  r: number;
  sideStyle: BubbleSideStyle;
  halo: boolean;
  glyph: "C" | "P" | null;
  ariaLabel: string;
}>;

export type OptionBubblesSizeStop = Readonly<{
  premium: number;
  label: string;
  r: number;
}>;

export type OptionBubblesPlot = Readonly<{
  width: number;
  height: number;
  chartX: number;
  chartY: number;
  chartWidth: number;
  chartHeight: number;
  priceTicks: readonly OptionBubblesPriceTick[];
  timeTicks: readonly OptionBubblesTimeTick[];
  gapRects: readonly OptionBubblesGapRect[];
  priceSegments: readonly string[];
  priceDots: readonly Readonly<{ x: number; y: number }>[];
  latestSpot: Readonly<{ price: number; label: string; y: number }> | null;
  priceMax: number;
  priceMin: number;
  /** Plotted bubbles ordered chronologically (at asc, id asc) for keyboard navigation. */
  chronologicalBubbles: readonly OptionBubblesPlotBubble[];
  /** Same plotted bubbles ordered largest-first so smaller bubbles draw on top. */
  drawBubbles: readonly OptionBubblesPlotBubble[];
  /** All filtered bubbles (plotted + unplotted) sorted largest-first for the detail table. */
  tableBubbles: readonly FlowOptionBubblesItem[];
  sizeLegend: readonly OptionBubblesSizeStop[];
  scaleMax: number;
}>;

export type BubbleInspectorReadout = Readonly<{
  headline: string;
  executionLine: string;
  contextLine: string;
  flags: readonly string[];
}>;

export const BUBBLES_CHART_WIDTH = 1000;
export const BUBBLES_CHART_HEIGHT = 320;
const PLOT_LEFT = 72;
const PLOT_RIGHT = 968;
const PLOT_TOP = 24;
const PLOT_BOTTOM = 282;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
const MIN_BUBBLE_RADIUS = 5;
const MAX_BUBBLE_RADIUS = 22;
const GLYPH_MIN_RADIUS = 10;
const MAX_LINE_GAP_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const SESSION_TICK_OFFSETS_MIN = [0, 90, 180, 270, 360, 405] as const;

const etClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const OPTION_BUBBLES_LOADING = "Loading option print bubbles…";
export const OPTION_BUBBLES_MIN_PREMIUM_OPTIONS: readonly FlowOptionBubblesMinPremiumUsd[] =
  FLOW_OPTION_BUBBLES_MIN_PREMIUMS;

export const OPTION_BUBBLES_SIDE_LABELS: Readonly<
  Record<FlowOptionSide, string>
> = {
  above_ask: "Above ask",
  ask: "Ask",
  below_bid: "Below bid",
  bid: "Bid",
  mid: "Mid",
  not_classified: "Side not classified",
};

export const OPTION_BUBBLES_CONSOLIDATION_LABELS: Readonly<
  Record<FlowConsolidation, string>
> = {
  block: "Block",
  other: "Single",
  split: "Split",
  sweep: "Sweep",
};

const OPTION_BUBBLES_MONEYNESS_LABELS: Readonly<Record<FlowMoneyness, string>> =
  {
    atm: "ATM",
    itm: "ITM",
    not_reported: "Moneyness not reported",
    otm: "OTM",
  };

/** The symbol when option print bubbles exist for it (stored option prints), else null. */
export const optionBubblesSymbolOf = (
  symbol: FlowSymbol
): FlowOptionBubblesSymbol | null =>
  FLOW_OPTION_BUBBLES_SYMBOLS.find((candidate) => candidate === symbol) ?? null;

/** "Option print bubbles · SPY options" or "Option print bubbles · SPX options (ES)". */
export const optionBubblesTitle = (symbol: FlowOptionBubblesSymbol): string => {
  const ticker = FLOW_INSTRUMENTS[symbol].optionsTicker;
  return ticker === symbol
    ? `Option print bubbles · ${ticker} options`
    : `Option print bubbles · ${ticker} options (${symbol})`;
};

/** Compact label for the premium threshold buttons: "$100K", "$250K", "$500K", "$1M". */
export const formatThresholdLabel = (
  threshold: FlowOptionBubblesMinPremiumUsd
): string => formatMoney(threshold);

/** Empty state when no option print is stored in the 14-day retention window. */
export const optionBubblesEmptyLine = (
  symbol: FlowOptionBubblesSymbol
): string => `No option prints stored for ${symbol} in the last 14 days.`;

/** Empty state when the session has prints, but none meet the active threshold or filters. */
export const optionBubblesNoMatchesLine = (
  minPremiumUsd: FlowOptionBubblesMinPremiumUsd,
  rightFilter: OptionBubblesRightFilter,
  sideFilter: OptionBubblesSideFilter
): string => {
  const qualifiers: string[] = [];
  if (rightFilter !== "all")
    qualifiers.push(rightFilter === "call" ? "call" : "put");
  if (sideFilter !== "all")
    qualifiers.push(sideFilter === "ask" ? "ask-side" : "bid-side");
  const filterNote =
    qualifiers.length === 0 ? "" : ` matching ${qualifiers.join(" ")}`;
  return `No regular-session option prints >= ${formatMoney(minPremiumUsd)}${filterNote} in this session. Lower the minimum premium floor or widen the filters to inspect smaller prints.`;
};

/** Error banner copy, noting when a previous threshold view remains on screen. */
export const optionBubblesFailureLine = (
  failure: FlowOptionBubblesFailure,
  refreshMs: number,
  displayedMinPremiumUsd: FlowOptionBubblesMinPremiumUsd | null,
  requestedMinPremiumUsd: FlowOptionBubblesMinPremiumUsd
): string => {
  const nextAt = etClock.format(new Date(failure.failedAt + refreshMs));
  const keptNote =
    displayedMinPremiumUsd !== null &&
    displayedMinPremiumUsd !== requestedMinPremiumUsd
      ? ` Showing previous >= ${formatMoney(displayedMinPremiumUsd)} view.`
      : "";
  return `Option print bubbles failed (${failure.code}): ${failure.message}.${keptNote} Retry now or wait for ${nextAt} ET.`;
};

/** Header metadata line: session date, premium floor, newest print time, freshness, and open gap notice. */
export const optionBubblesHeaderLine = (
  response: FlowOptionBubbles
): string => {
  const parts: string[] = [
    `Session ${response.session ?? "none"}`,
    `floor >= ${formatMoney(response.minPremiumUsd)}`,
  ];
  if (response.storedUntil !== null)
    parts.push(
      `prints through ${etClock.format(new Date(response.storedUntil))} ET`
    );
  parts.push(`options ${response.options.state}`);
  if (response.unread !== null) {
    parts.push(
      `Incomplete: prints of ${etClock.format(new Date(response.unread.from))}–${etClock.format(new Date(response.unread.to))} ET not read yet (${response.unread.ranges} open ${response.unread.ranges === 1 ? "gap" : "gaps"})`
    );
  }
  return parts.join(" · ");
};

/** Totals summary line for the active threshold and returned bubbles. */
export const optionBubblesTotalsLine = (
  response: FlowOptionBubbles
): string => {
  const { totals } = response;
  const shownWord = totals.shownBubbles === 1 ? "big print" : "big prints";
  return `${whole.format(totals.shownBubbles)} ${shownWord} >= ${formatMoney(response.minPremiumUsd)} (of ${whole.format(totals.sessionPrints)} session prints, ${formatMoney(totals.sessionGrossPremium)} gross) · Calls ${formatMoney(totals.callPremium)} (${whole.format(totals.callBubbles)}) · Puts ${formatMoney(totals.putPremium)} (${whole.format(totals.putBubbles)}) · Ask-side ${formatMoney(totals.askSidePremium)} · Bid-side ${formatMoney(totals.bidSidePremium)}`;
};

/** Optional disclosure line when bubbles were capped or lacked underlyingPrice. */
export const optionBubblesDisclosureLine = (
  response: FlowOptionBubbles
): string | null => {
  const notes: string[] = [];
  if (response.truncated) {
    notes.push(
      `Showing the top ${response.rules.maxBubbles} prints by premium (more prints met >= ${formatMoney(response.minPremiumUsd)}).`
    );
  }
  if (response.totals.unplottedBubbles > 0) {
    const count = response.totals.unplottedBubbles;
    notes.push(
      `${whole.format(count)} big ${count === 1 ? "print" : "prints"} reported no underlying price and ${count === 1 ? "is" : "are"} listed in the table below rather than placed on the price axis.`
    );
  }
  return notes.length === 0 ? null : notes.join(" ");
};

/** Rule disclosure line matching the server rules object. */
export const optionBubblesRuleText = (rules: FlowOptionBubblesRules): string =>
  `Rules ${rules.version}: stored QuantData prints >= ${formatMoney(rules.storedMinPremiumUsd)} over the last ${rules.retentionDays} days, capped to the top ${rules.maxBubbles} prints meeting the selected floor. Bubble radius scales with square root of premium (area proportional to premium); calls are green (C), puts are red (P); filled circles are ask/above-ask, hollow rings are bid/below-bid, dashed rings are mid or side not classified. Research view only.`;
/** Maps contract aggressor side to bubble visual encoding (never color alone). */
export const bubbleSideStyleOf = (side: FlowOptionSide): BubbleSideStyle => {
  if (side === "ask" || side === "above_ask") return "filled";
  if (side === "bid" || side === "below_bid") return "hollow";
  return "dashed";
};

/** Filters bubbles by right (call/put) and aggressor side (ask/bid). */
export const filterOptionBubbles = (
  bubbles: readonly FlowOptionBubblesItem[],
  rightFilter: OptionBubblesRightFilter,
  sideFilter: OptionBubblesSideFilter
): FlowOptionBubblesItem[] =>
  bubbles.filter((bubble) => {
    if (rightFilter !== "all" && bubble.right !== rightFilter) return false;
    if (
      sideFilter === "ask" &&
      bubble.side !== "ask" &&
      bubble.side !== "above_ask"
    )
      return false;
    if (
      sideFilter === "bid" &&
      bubble.side !== "bid" &&
      bubble.side !== "below_bid"
    )
      return false;
    return true;
  });

/** Sorts filtered big option prints largest-first for the detail table. */
export const sortOptionBubblesForTable = (
  bubbles: readonly FlowOptionBubblesItem[]
): FlowOptionBubblesItem[] =>
  [...bubbles].sort(
    (a, b) =>
      b.premium - a.premium ||
      Date.parse(b.at) - Date.parse(a.at) ||
      (b.id < a.id ? -1 : 1)
  );

/** Computes perceptual area-proportional bubble radius clamped to [5, 22]. */
export const bubbleRadiusFor = (premium: number, scaleMax: number): number => {
  const ratio = scaleMax > 0 ? Math.max(0, Math.min(1, premium / scaleMax)) : 0;
  return (
    Math.round(
      (MIN_BUBBLE_RADIUS +
        Math.sqrt(ratio) * (MAX_BUBBLE_RADIUS - MIN_BUBBLE_RADIUS)) *
        10
    ) / 10
  );
};

/** Accessible aria-label for a plotted option print bubble. */
export const bubbleAriaLabel = (
  bubble: FlowOptionBubblesItem,
  ticker: string
): string => {
  const rightWord = bubble.right === "call" ? "Call" : "Put";
  const sideLabel = OPTION_BUBBLES_SIDE_LABELS[bubble.side];
  const priceText =
    bubble.underlyingPrice === null
      ? "underlying price not reported"
      : `${ticker} ${formatPrice(bubble.underlyingPrice)}`;
  return `${bubble.contract} ${rightWord}, ${formatMoney(bubble.premium)}, ${sideLabel}, ${formatEtSeconds(bubble.at)}, ${priceText}`;
};

/** Structured readout for the pinned inspector strip. */
export const describeSelectedBubble = (
  bubble: FlowOptionBubblesItem,
  ticker: string
): BubbleInspectorReadout => {
  const rightWord = bubble.right === "call" ? "Call" : "Put";
  const sideLabel = OPTION_BUBBLES_SIDE_LABELS[bubble.side];
  const signLabel =
    bubble.directionalSign > 0
      ? "Bullish flow"
      : bubble.directionalSign < 0
        ? "Bearish flow"
        : "Unsigned flow";
  const optionPrice =
    bubble.price === null
      ? "option price not reported"
      : `@ $${formatPrice(bubble.price)}`;
  const underlyingText =
    bubble.underlyingPrice === null
      ? `${ticker} price not reported`
      : `${ticker} ${formatPrice(bubble.underlyingPrice)}`;
  const dteText =
    bubble.dte === null ? "DTE not reported" : `${Math.round(bubble.dte)} DTE`;
  const ivText =
    bubble.iv === null ? "IV not reported" : `IV ${bubble.iv.toFixed(1)}%`;

  const flags: string[] = [];
  if (bubble.goldenSweep) flags.push("Golden sweep");
  if (bubble.unusual) flags.push("Unusual");
  if (bubble.volumeOverOi) flags.push("Vol > OI");
  if (bubble.opening) flags.push("Opening");

  return {
    contextLine: `${underlyingText} · ${OPTION_BUBBLES_CONSOLIDATION_LABELS[bubble.consolidation]} · ${OPTION_BUBBLES_MONEYNESS_LABELS[bubble.moneyness]} · ${dteText} · ${ivText}`,
    executionLine: `${formatMoney(bubble.premium)} · ${formatCount(bubble.size)} contracts ${optionPrice} · ${sideLabel} (${signLabel})`,
    flags,
    headline: `${bubble.contract} (${rightWord}) · ${formatEtSeconds(bubble.at)}`,
  };
};

/**
 * Keyboard movement across chronologically ordered plotted bubbles.
 * Returns the next bubble id, "clear" on Escape, or undefined when the key is unrelated.
 */
export const nextBubbleKeyTarget = (
  ids: readonly string[],
  currentId: string,
  key: string
): string | "clear" | undefined => {
  if (key === "Escape") return "clear";
  const currentIndex = ids.indexOf(currentId);
  if (currentIndex < 0) return undefined;
  if (key === "ArrowLeft") return ids[Math.max(0, currentIndex - 1)];
  if (key === "ArrowRight")
    return ids[Math.min(ids.length - 1, currentIndex + 1)];
  if (key === "Home") return ids[0];
  if (key === "End") return ids.at(-1);
  return undefined;
};

/** Accessible summary for the SVG chart root element. */
export const optionBubblesChartAriaLabel = (
  response: FlowOptionBubbles,
  plottedCount: number
): string => {
  const printWord =
    plottedCount === 1 ? "big option print" : "big option prints";
  return `${response.ticker} intraday price chart for session ${response.session ?? "none"} with ${plottedCount} ${printWord} >= ${formatMoney(response.minPremiumUsd)} overlaid as proportional bubbles`;
};

/** Builds the complete SVG plot geometry for FlowOptionBubblesPanel. */
export const buildOptionBubblesPlot = (
  response: FlowOptionBubbles,
  rightFilter: OptionBubblesRightFilter,
  sideFilter: OptionBubblesSideFilter
): OptionBubblesPlot | null => {
  if (response.sessionStart === null || response.sessionEnd === null)
    return null;

  const filtered = filterOptionBubbles(
    response.bubbles,
    rightFilter,
    sideFilter
  );
  const plottedSource: { bubble: FlowOptionBubblesItem; price: number }[] = [];
  for (const bubble of filtered) {
    if (bubble.underlyingPrice !== null)
      plottedSource.push({ bubble, price: bubble.underlyingPrice });
  }
  if (response.pricePoints.length === 0 && plottedSource.length === 0)
    return null;

  const startMs = Date.parse(response.sessionStart);
  const endMs = Date.parse(response.sessionEnd);
  const spanMs = Math.max(1, endMs - startMs);

  const xOf = (ms: number): number => {
    const ratio = Math.max(0, Math.min(1, (ms - startMs) / spanMs));
    return Math.round((PLOT_LEFT + ratio * PLOT_WIDTH) * 10) / 10;
  };

  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;
  for (const point of response.pricePoints) {
    if (point.price < rawMin) rawMin = point.price;
    if (point.price > rawMax) rawMax = point.price;
  }
  for (const { price } of plottedSource) {
    if (price < rawMin) rawMin = price;
    if (price > rawMax) rawMax = price;
  }
  if (response.totals.latestPrice !== null) {
    if (response.totals.latestPrice < rawMin)
      rawMin = response.totals.latestPrice;
    if (response.totals.latestPrice > rawMax)
      rawMax = response.totals.latestPrice;
  }

  const rawSpan = rawMax - rawMin;
  const pad = Math.max(rawSpan * 0.14, rawMin * 0.0008, 0.25);
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;
  const ySpan = yMax - yMin;

  const yOf = (price: number): number => {
    const ratio = (price - yMin) / ySpan;
    return Math.round((PLOT_BOTTOM - ratio * PLOT_HEIGHT) * 10) / 10;
  };

  const priceTicks: OptionBubblesPriceTick[] = [0, 1, 2, 3, 4].map((index) => {
    const price = yMax - (index / 4) * ySpan;
    return {
      label: formatPrice(price),
      price,
      y: yOf(price),
    };
  });

  const timeTicks: OptionBubblesTimeTick[] = SESSION_TICK_OFFSETS_MIN.map(
    (offset, index) => {
      const ms = startMs + offset * MINUTE_MS;
      const clockLabel = etClock.format(new Date(ms));
      return {
        label:
          index === SESSION_TICK_OFFSETS_MIN.length - 1
            ? `${clockLabel} ET`
            : clockLabel,
        x: xOf(ms),
      };
    }
  );

  const gapSpans = response.gaps.map((gap) => ({
    end: gap.end,
    endMs: Date.parse(gap.end),
    start: gap.start,
    startMs: Date.parse(gap.start),
  }));
  const gapRects: OptionBubblesGapRect[] = gapSpans.map((span) => {
    const rawX1 = xOf(span.startMs);
    const rawX2 = xOf(span.endMs);
    const x1 = Math.min(PLOT_RIGHT - 3, rawX1);
    const width = Math.min(
      PLOT_RIGHT - x1,
      Math.max(3, Math.round((rawX2 - rawX1) * 10) / 10)
    );
    return {
      endLabel: etClock.format(new Date(span.end)),
      startLabel: etClock.format(new Date(span.start)),
      width,
      x: x1,
    };
  });

  // Segment underlying price path so open gaps, unread minutes, or >5m holes never draw false bridges.
  const priceSegments: string[] = [];
  const priceDots: { x: number; y: number }[] = [];
  let currentRun: { x: number; y: number }[] = [];
  let prevMs: number | null = null;
  let prevUnread = false;

  const flushRun = (): void => {
    if (currentRun.length >= 2) {
      priceSegments.push(currentRun.map((pt) => `${pt.x},${pt.y}`).join(" "));
    } else if (currentRun.length === 1) {
      priceDots.push(...currentRun);
    }
    currentRun = [];
  };

  for (const point of response.pricePoints) {
    const ms = Date.parse(point.minute);
    const pt = { x: xOf(ms), y: yOf(point.price) };
    const previousMs = prevMs;
    if (
      previousMs !== null &&
      (point.unread ||
        prevUnread ||
        ms - previousMs > MAX_LINE_GAP_MS ||
        gapSpans.some((gap) => gap.endMs > previousMs && gap.startMs < ms))
    ) {
      flushRun();
    }
    currentRun.push(pt);
    prevMs = ms;
    prevUnread = point.unread;
  }
  flushRun();
  const latestSpot =
    response.totals.latestPrice === null
      ? null
      : {
          label: formatPrice(response.totals.latestPrice),
          price: response.totals.latestPrice,
          y: yOf(response.totals.latestPrice),
        };

  let maxPlottedPremium = 0;
  for (const { bubble } of plottedSource) {
    if (bubble.premium > maxPlottedPremium) maxPlottedPremium = bubble.premium;
  }
  const scaleMax = Math.max(maxPlottedPremium, response.minPremiumUsd * 4);

  const chronologicalBubbles: OptionBubblesPlotBubble[] = plottedSource.map(
    ({ bubble, price }) => {
      const r = bubbleRadiusFor(bubble.premium, scaleMax);
      return {
        ariaLabel: bubbleAriaLabel(bubble, response.ticker),
        bubble,
        cx: xOf(Date.parse(bubble.at)),
        cy: yOf(price),
        glyph:
          r >= GLYPH_MIN_RADIUS ? (bubble.right === "call" ? "C" : "P") : null,
        halo: bubble.side === "above_ask" || bubble.goldenSweep,
        r,
        sideStyle: bubbleSideStyleOf(bubble.side),
      };
    }
  );

  // Draw largest bubbles first so smaller bubbles render on top and stay clickable.
  const drawBubbles = [...chronologicalBubbles].sort(
    (a, b) =>
      b.bubble.premium - a.bubble.premium ||
      (a.bubble.id < b.bubble.id ? -1 : 1)
  );

  const tableBubbles = sortOptionBubblesForTable(filtered);
  const midPremium = Math.round((response.minPremiumUsd + scaleMax) / 2);
  const sizeLegend: OptionBubblesSizeStop[] = [
    response.minPremiumUsd,
    midPremium,
    scaleMax,
  ].map((premium) => ({
    label: formatMoney(premium),
    premium,
    r: bubbleRadiusFor(premium, scaleMax),
  }));

  return {
    chartHeight: PLOT_HEIGHT,
    chartWidth: PLOT_WIDTH,
    chartX: PLOT_LEFT,
    chartY: PLOT_TOP,
    chronologicalBubbles,
    drawBubbles,
    gapRects,
    height: BUBBLES_CHART_HEIGHT,
    latestSpot,
    priceDots,
    priceMax: yMax,
    priceMin: yMin,
    priceSegments,
    priceTicks,
    scaleMax,
    sizeLegend,
    tableBubbles,
    timeTicks,
    width: BUBBLES_CHART_WIDTH,
  };
};
