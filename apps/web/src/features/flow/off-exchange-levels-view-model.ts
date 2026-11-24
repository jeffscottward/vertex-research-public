// What: pure view-model and SVG geometry builder for FlowOffExchangeLevelsPanel on /flow
// (flow.offExchangeLevels, flow-off-exchange-levels.v1). Zero React or DOM dependencies.
// Used by: apps/web/src/components/portal/flow-off-exchange-levels-panel.tsx, flow-workspace.tsx.
// Research only: describes stored sampled FINRA TRF prints and lagged FINRA weekly OTC context.
import type {
  FlowDirection,
  FlowOffExchangeLevel,
  FlowOffExchangeLevels,
  FlowOffExchangePrint,
  FlowOffExchangeRange,
  FlowOffExchangeSymbol,
  FlowSymbol,
} from "@darkfactory/api";
import { loadFailedLabel } from "../../components/status-time.ts";
import type { FlowControlFailure } from "./control-view-model.ts";
import {
  formatAge,
  formatCount,
  formatDuration,
  formatMoney,
  formatNyDateTime,
  formatPrice,
  formatShare,
  formatSignedPrice,
} from "./format.ts";

export type OffExchangeLevelsRequest = Readonly<{
  symbol: FlowOffExchangeSymbol;
  range: FlowOffExchangeRange;
}>;

export type FlowOffExchangeLevelsFailure = FlowControlFailure &
  Readonly<{ failedAt: number }>;

export type OffExchangeRangeOption = Readonly<{
  value: FlowOffExchangeRange;
  label: string;
}>;

export const OFF_EXCHANGE_RANGE_OPTIONS: readonly OffExchangeRangeOption[] =
  Object.freeze([
    { label: "1d", value: "1d" },
    { label: "5d", value: "5d" },
    { label: "14d", value: "14d" },
  ]);

export const OFF_EXCHANGE_DEFAULT_RANGE: FlowOffExchangeRange = "5d";
export const OFF_EXCHANGE_LOADING = "Loading off-exchange print levels…";
export const OFF_EXCHANGE_NO_PRINTS =
  "No FINRA TRF prints ≥ 10,000 shares stored in this window.";
export const OFF_EXCHANGE_NO_FINRA =
  "No FINRA weekly OTC rows stored for SPY yet.";

export const OFF_EXCHANGE_CHART = Object.freeze({
  plotBottom: 272,
  plotLeft: 68,
  plotRight: 816,
  plotTop: 18,
  priceHeight: 300,
  railLeft: 826,
  railRight: 988,
  shareBottom: 60,
  shareHeight: 74,
  shareTop: 14,
  width: 1000,
});

export type PriceGridTick = Readonly<{
  price: number;
  y: number;
  label: string;
}>;

export type SessionDivider = Readonly<{
  session: string;
  x: number;
  label: string;
}>;

export type TimeAxisTick = Readonly<{
  x: number;
  label: string;
}>;

export type LevelLineGeometry = Readonly<{
  index: number;
  rank: number;
  price: number;
  y: number;
  bandTopY: number;
  bandHeight: number;
  startX: number;
  endX: number;
  strokeWidth: number;
  dominantDirection: FlowDirection;
  railBarWidth: number;
  railLabel: string;
  showRailLabel: boolean;
  ariaLabel: string;
}>;

export type PrintDotGeometry = Readonly<{
  key: string;
  x: number;
  y: number;
  radius: number;
  direction: FlowDirection;
  levelIndex: number | null;
  ariaLabel: string;
}>;

export type ShareBarGeometry = Readonly<{
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  share: number;
}>;

export type OffExchangePlot = Readonly<{
  priceGridTicks: readonly PriceGridTick[];
  sessionDividers: readonly SessionDivider[];
  timeTicks: readonly TimeAxisTick[];
  priceSegments: readonly string[];
  vwapSegments: readonly string[];
  spotLine: Readonly<{ price: number; y: number; label: string }> | null;
  levelLines: readonly LevelLineGeometry[];
  printDots: readonly PrintDotGeometry[];
  shareBars: readonly ShareBarGeometry[];
  shareMidY: number;
}>;

export type OffExchangePrintItemView = Readonly<{
  key: string;
  time: string;
  price: string;
  shares: string;
  notional: string;
  direction: FlowDirection;
}>;

export type OffExchangeLevelRowView = Readonly<{
  index: number;
  rank: number;
  price: string;
  bandRange: string;
  spotDelta: string;
  spotRelation: "above" | "below" | "at" | "no_spot";
  notional: string;
  shares: string;
  prints: number;
  sideMix: string;
  dominantDirection: FlowDirection;
  firstAt: string;
  lastAt: string;
  levelPrints: readonly OffExchangePrintItemView[];
}>;

export type FinraWeekBarView = Readonly<{
  weekStart: string;
  shortWeek: string;
  atsShares: string;
  nonAtsShares: string;
  totalShares: string;
  atsShare: string;
  x: number;
  width: number;
  atsY: number;
  atsHeight: number;
  nonAtsY: number;
  nonAtsHeight: number;
}>;

export type OffExchangeFinraSummary = Readonly<{
  latestWeekStart: string;
  latestLastUpdated: string | null;
  atsShares: string;
  nonAtsShares: string;
  totalShares: string;
  atsShare: string;
  avgAtsTradeSize: string;
  bars: readonly FinraWeekBarView[];
}>;

const REGULAR_SESSION_MINUTES = 390;
const SESSION_OPEN_ET_MINUTE = 9 * 60 + 30;
const RAIL_LABEL_MIN_GAP_PX = 16;

const directionWord = (direction: FlowDirection): string => {
  if (direction === "bullish") return "buy-skewed";
  if (direction === "bearish") return "sell-skewed";
  return "mixed";
};

const shortDay = (isoDate: string): string => isoDate.slice(5);

const formatSignedPercent = (value: number | null): string => {
  if (value === null) return "no spot";
  const pct = (Math.abs(value) * 100).toFixed(2);
  if (value > 0) return `+${pct}%`;
  if (value < 0) return `−${pct}%`;
  return "0.00%";
};

const NY_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

const NY_TIME_24_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});

const nyDateOf = (iso: string): string => NY_DATE_FORMAT.format(new Date(iso));

const nyMinuteOfDay = (iso: string): number => {
  const [hour, minute] = NY_TIME_24_FORMAT.format(new Date(iso)).split(":");
  return Number(hour) * 60 + Number(minute);
};
const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const offExchangeSymbolOf = (
  symbol: FlowSymbol
): FlowOffExchangeSymbol | null => (symbol === "SPY" ? "SPY" : null);

export const offExchangeTitle = (symbol: FlowOffExchangeSymbol): string =>
  `Off-exchange print levels (${symbol})`;

export const offExchangeHeaderLine = (
  response: FlowOffExchangeLevels
): string => {
  const parts: string[] = [
    `Sampled IBKR FINRA TRF (≥ ${formatCount(response.rules.minPrintShares)} sh)`,
  ];
  if (response.sessions.length === 1) {
    parts.push(`Session ${response.sessions[0]}`);
  } else if (response.sessions.length > 1) {
    parts.push(
      `${response.sessions.length} sessions (${response.sessions[0]} to ${response.sessions.at(-1)})`
    );
  } else {
    parts.push("No stored tick sessions");
  }
  if (response.latestPrice !== null) {
    parts.push(`Latest ${formatPrice(response.latestPrice)}`);
  }
  parts.push(
    `Ticks ${response.ticks.state} (${formatAge(response.ticks.ageSeconds)})`
  );
  return parts.join(" · ");
};

export const offExchangeTotalsLine = (
  response: FlowOffExchangeLevels
): string => {
  const { totals } = response;
  const parts = [
    `${totals.prints} prints`,
    `${formatMoney(totals.totalNotional)} notional`,
    `${formatCount(totals.totalShares)} shares`,
    `${response.levels.length} levels`,
    `Sampled FINRA TRF share ${formatShare(totals.sampledOffExchangeShare)} (${formatDuration(totals.coveredSeconds)} covered)`,
  ];
  return parts.join(" · ");
};

export const offExchangeOmittedLine = (
  response: FlowOffExchangeLevels
): string | null => {
  const parts: string[] = [];
  if (response.totals.omittedLevels > 0) {
    parts.push(
      `Showing top ${response.levels.length} of ${response.totals.totalClusterCount} price bands (${response.totals.omittedLevels} smaller bands omitted).`
    );
  }
  if (response.totals.omittedPrints > 0) {
    parts.push(
      `Showing newest ${response.prints.length} of ${response.totals.prints} prints on the chart (${response.totals.omittedPrints} older prints still counted in level totals).`
    );
  }
  if (response.totals.truncated) {
    parts.push(
      `Reached the ${formatCount(response.rules.readCap)}-print read cap; oldest prints in the range may be excluded.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
};

export const offExchangeEmptyLine = (
  response: FlowOffExchangeLevels
): string => {
  if (response.bars.length === 0 && response.prints.length === 0) {
    return `No stored ${response.symbol} tick minutes or off-exchange prints yet.`;
  }
  return OFF_EXCHANGE_NO_PRINTS;
};

export const offExchangeFailureLine = (
  failure: FlowOffExchangeLevelsFailure,
  response: FlowOffExchangeLevels | null,
  refreshMs: number
): string => {
  const retry = `retrying every ${Math.round(refreshMs / 1000)} s`;
  if (response === null) {
    return `${loadFailedLabel(failure.failedAt)} · Off-exchange levels not loaded: ${failure.code}: ${failure.message} · ${retry}`;
  }
  return `${loadFailedLabel(failure.failedAt)} · Refresh failed: ${failure.code}: ${failure.message} · showing stored ${response.range} view · ${retry}`;
};

export const offExchangeRuleText = (response: FlowOffExchangeLevels): string =>
  `Clusters sampled IBKR FINRA TRF prints ≥ ${formatCount(response.rules.minPrintShares)} shares into $${response.rules.clusterStep.toFixed(2)} bands (VWAP level price, top ${response.rules.maxLevels} by notional) over ${response.bucketMinutes}m bars; FINRA weekly OTC context is a lagged public report. Research view only; never a trade signal or order input.`;

export const offExchangeAriaLabel = (
  response: FlowOffExchangeLevels
): string => {
  const top = response.levels[0];
  const topSummary =
    top === undefined
      ? "no print levels"
      : `largest level #1 at $${formatPrice(top.price)} with ${formatMoney(top.totalNotional)}`;
  return `${offExchangeTitle(response.symbol)}, ${response.range} window, ${response.bars.length} price bars, ${response.levels.length} off-exchange print levels, ${topSummary}.`;
};

export const nextOffExchangeLevelIndex = (
  key: string,
  current: number | null,
  count: number
): number | null | undefined => {
  if (count <= 0) return undefined;
  if (key === "Escape") return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") {
    return current === null ? 0 : Math.min(count - 1, current + 1);
  }
  if (key === "ArrowUp") {
    return current === null ? count - 1 : Math.max(0, current - 1);
  }
  return undefined;
};

const buildPriceBounds = (
  response: FlowOffExchangeLevels
): Readonly<{ minPrice: number; maxPrice: number; priceSpan: number }> => {
  const priceValues: number[] = [];
  for (const bar of response.bars) {
    priceValues.push(bar.low, bar.high);
  }
  for (const level of response.levels) {
    priceValues.push(level.bandLow, level.bandHigh);
  }
  for (const print of response.prints) {
    priceValues.push(print.price);
  }
  const rawMin = Math.min(...priceValues);
  const rawMax = Math.max(...priceValues);
  const rawSpan = rawMax - rawMin;
  const pad = rawSpan > 0 ? Math.max(rawSpan * 0.08, 0.25) : 1;
  const minPrice = rawMin - pad;
  const maxPrice = rawMax + pad;
  return { maxPrice, minPrice, priceSpan: maxPrice - minPrice };
};

const buildTimeAxis = (
  sessionList: readonly string[],
  totalMinutesSpan: number,
  plotLeft: number,
  plotWidth: number
): Readonly<{
  sessionDividers: SessionDivider[];
  timeTicks: TimeAxisTick[];
}> => {
  const sessionDividers: SessionDivider[] = [];
  const timeTicks: TimeAxisTick[] = [];
  if (sessionList.length === 1) {
    const day = sessionList[0] as string;
    const marks: readonly [number, string][] = [
      [0, "09:30"],
      [90, "11:00"],
      [180, "12:30"],
      [270, "14:00"],
      [360, "15:30"],
    ];
    for (const [offset, label] of marks) {
      const x =
        Math.round((plotLeft + (offset / totalMinutesSpan) * plotWidth) * 10) /
        10;
      timeTicks.push({ label: `${label} ET`, x });
    }
    sessionDividers.push({ label: shortDay(day), session: day, x: plotLeft });
    return { sessionDividers, timeTicks };
  }
  for (let i = 0; i < sessionList.length; i += 1) {
    const day = sessionList[i] as string;
    const startX =
      Math.round(
        (plotLeft +
          ((i * REGULAR_SESSION_MINUTES) / totalMinutesSpan) * plotWidth) *
          10
      ) / 10;
    if (i > 0) {
      sessionDividers.push({ label: shortDay(day), session: day, x: startX });
    }
    const centerX =
      Math.round(
        (plotLeft +
          (((i + 0.5) * REGULAR_SESSION_MINUTES) / totalMinutesSpan) *
            plotWidth) *
          10
      ) / 10;
    timeTicks.push({ label: shortDay(day), x: centerX });
  }
  return { sessionDividers, timeTicks };
};

const buildPriceSegments = (
  response: FlowOffExchangeLevels,
  xOf: (session: string, iso: string) => number,
  yOf: (price: number) => number
): Readonly<{ priceSegments: string[]; vwapSegments: string[] }> => {
  const priceSegments: string[] = [];
  const vwapSegments: string[] = [];
  const maxGapMs = response.bucketMinutes * 2 * 60_000;
  let currentPricePoints: string[] = [];
  let currentVwapPoints: string[] = [];
  let prevSession: string | null = null;
  let prevMs = 0;

  const flushSegments = () => {
    if (currentPricePoints.length > 0) {
      priceSegments.push(currentPricePoints.join(" "));
      vwapSegments.push(currentVwapPoints.join(" "));
      currentPricePoints = [];
      currentVwapPoints = [];
    }
  };

  for (const bar of response.bars) {
    const ms = Date.parse(bar.start);
    if (
      prevSession !== null &&
      (bar.session !== prevSession || ms - prevMs > maxGapMs)
    ) {
      flushSegments();
    }
    const x = xOf(bar.session, bar.start);
    currentPricePoints.push(`${x},${yOf(bar.close)}`);
    currentVwapPoints.push(`${x},${yOf(bar.vwap)}`);
    prevSession = bar.session;
    prevMs = ms;
  }
  flushSegments();
  return { priceSegments, vwapSegments };
};

const buildLevelLines = (
  levels: readonly FlowOffExchangeLevel[],
  sessionList: readonly string[],
  sessionIndex: ReadonlyMap<string, number>,
  xOf: (session: string, iso: string) => number,
  yOf: (price: number) => number,
  plotRight: number,
  railWidth: number
): LevelLineGeometry[] => {
  const maxLevelNotional = Math.max(
    1,
    ...levels.map((level) => level.totalNotional)
  );
  const placedLabelYs: number[] = [];
  return levels.map((level, index) => {
    const y = yOf(level.price);
    const bandTopY = yOf(level.bandHigh);
    const bandBottomY = yOf(level.bandLow);
    const bandHeight = Math.max(
      4,
      Math.round((bandBottomY - bandTopY) * 10) / 10
    );
    const firstSession = nyDateOf(level.firstAt);
    const matchedSession = sessionIndex.has(firstSession)
      ? firstSession
      : (sessionList[0] as string);
    const startX = xOf(matchedSession, level.firstAt);
    const weight = level.totalNotional / maxLevelNotional;
    const strokeWidth = Math.round((1.5 + weight * 2) * 10) / 10;
    const railBarWidth = Math.max(12, Math.round(weight * railWidth));
    const collides = placedLabelYs.some(
      (usedY) => Math.abs(usedY - y) < RAIL_LABEL_MIN_GAP_PX
    );
    if (!collides) placedLabelYs.push(y);

    return {
      ariaLabel: `Level #${level.rank} at $${formatPrice(level.price)}, ${formatMoney(level.totalNotional)} (${formatCount(level.totalShares)} shares, ${level.prints} prints, ${directionWord(level.dominantDirection)})`,
      bandHeight,
      bandTopY,
      dominantDirection: level.dominantDirection,
      endX: plotRight,
      index,
      price: level.price,
      railBarWidth,
      railLabel: `$${formatPrice(level.price)} · ${formatMoney(level.totalNotional)}`,
      rank: level.rank,
      showRailLabel: !collides,
      startX,
      strokeWidth,
      y,
    };
  });
};

const buildShareBars = (
  bars: FlowOffExchangeLevels["bars"],
  xOf: (session: string, iso: string) => number,
  plotWidth: number,
  shareTop: number,
  shareBottom: number
): ShareBarGeometry[] => {
  const shareSpan = shareBottom - shareTop;
  const barWidth = clamp(
    Math.round((plotWidth / Math.max(24, bars.length * 1.4)) * 10) / 10,
    2,
    12
  );
  const shareBars: ShareBarGeometry[] = [];
  for (const bar of bars) {
    if (bar.offExchangeShare === null) continue;
    const height = Math.max(
      1,
      Math.round(bar.offExchangeShare * shareSpan * 10) / 10
    );
    const centerX = xOf(bar.session, bar.start);
    shareBars.push({
      height,
      key: bar.start,
      share: bar.offExchangeShare,
      width: barWidth,
      x: Math.round((centerX - barWidth / 2) * 10) / 10,
      y: Math.round((shareBottom - height) * 10) / 10,
    });
  }
  return shareBars;
};

export const buildOffExchangePlot = (
  response: FlowOffExchangeLevels
): OffExchangePlot | null => {
  if (response.bars.length === 0 && response.prints.length === 0) return null;

  const {
    plotBottom,
    plotLeft,
    plotRight,
    plotTop,
    railLeft,
    railRight,
    shareBottom,
    shareTop,
  } = OFF_EXCHANGE_CHART;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const railWidth = railRight - railLeft;

  const sessionList =
    response.sessions.length > 0
      ? response.sessions
      : [...new Set(response.prints.map((p) => p.session))].sort();
  const sessionIndex = new Map<string, number>(
    sessionList.map((day, idx) => [day, idx])
  );
  const totalMinutesSpan = Math.max(
    1,
    sessionList.length * REGULAR_SESSION_MINUTES
  );

  const xOf = (session: string, iso: string): number => {
    const sIdx = sessionIndex.get(session) ?? 0;
    const minOffset = clamp(
      nyMinuteOfDay(iso) - SESSION_OPEN_ET_MINUTE,
      0,
      REGULAR_SESSION_MINUTES
    );
    const ratio =
      (sIdx * REGULAR_SESSION_MINUTES + minOffset) / totalMinutesSpan;
    return Math.round((plotLeft + ratio * plotWidth) * 10) / 10;
  };

  const { maxPrice, priceSpan } = buildPriceBounds(response);
  const yOf = (price: number): number =>
    Math.round((plotTop + ((maxPrice - price) / priceSpan) * plotHeight) * 10) /
    10;

  const priceGridTicks: PriceGridTick[] = Array.from({ length: 5 }, (_, i) => {
    const price = maxPrice - (priceSpan * i) / 4;
    return { label: `$${formatPrice(price)}`, price, y: yOf(price) };
  });
  const { sessionDividers, timeTicks } = buildTimeAxis(
    sessionList,
    totalMinutesSpan,
    plotLeft,
    plotWidth
  );
  const { priceSegments, vwapSegments } = buildPriceSegments(
    response,
    xOf,
    yOf
  );
  const spotLine =
    response.latestPrice === null
      ? null
      : {
          label: `Spot $${formatPrice(response.latestPrice)}`,
          price: response.latestPrice,
          y: yOf(response.latestPrice),
        };
  const levelLines = buildLevelLines(
    response.levels,
    sessionList,
    sessionIndex,
    xOf,
    yOf,
    plotRight,
    railWidth
  );

  const maxPrintNotional = Math.max(
    1,
    ...response.prints.map((print) => print.notional)
  );
  const printDots: PrintDotGeometry[] = response.prints.map((print) => {
    const weight = Math.sqrt(print.notional / maxPrintNotional);
    const radius = Math.round((3.5 + weight * 5) * 10) / 10;
    return {
      ariaLabel: `${formatCount(print.size)} shares at $${formatPrice(print.price)} (${formatMoney(print.notional)}), ${print.direction}, ${formatNyDateTime(print.at)}`,
      direction: print.direction,
      key: print.key,
      levelIndex: print.levelIndex,
      radius,
      x: xOf(print.session, print.at),
      y: yOf(print.price),
    };
  });

  const shareBars = buildShareBars(
    response.bars,
    xOf,
    plotWidth,
    shareTop,
    shareBottom
  );

  return {
    levelLines,
    priceGridTicks,
    priceSegments,
    printDots,
    sessionDividers,
    shareBars,
    shareMidY:
      Math.round((shareTop + (shareBottom - shareTop) * 0.5) * 10) / 10,
    spotLine,
    timeTicks,
    vwapSegments,
  };
};

const spotRelationOf = (
  distance: number | null
): "above" | "below" | "at" | "no_spot" => {
  if (distance === null) return "no_spot";
  if (distance > 0.005) return "above";
  if (distance < -0.005) return "below";
  return "at";
};

const formatPrintItem = (
  print: FlowOffExchangePrint
): OffExchangePrintItemView => ({
  direction: print.direction,
  key: print.key,
  notional: formatMoney(print.notional),
  price: `$${formatPrice(print.price)}`,
  shares: formatCount(print.size),
  time: formatNyDateTime(print.at),
});

export const buildOffExchangeLevelRows = (
  response: FlowOffExchangeLevels
): OffExchangeLevelRowView[] => {
  const printsByLevel = new Map<number, OffExchangePrintItemView[]>();
  for (const print of response.prints) {
    if (print.levelIndex === null) continue;
    const list = printsByLevel.get(print.levelIndex) ?? [];
    list.push(formatPrintItem(print));
    printsByLevel.set(print.levelIndex, list);
  }

  return response.levels.map((level: FlowOffExchangeLevel, index) => {
    const relation = spotRelationOf(level.distanceFromSpot);
    const spotDelta =
      level.distanceFromSpot === null
        ? "no spot"
        : `${formatSignedPrice(level.distanceFromSpot)} (${formatSignedPercent(level.distancePct)})`;
    const buyPct = Math.round((level.buyShares / level.totalShares) * 100);
    const sellPct = Math.round((level.sellShares / level.totalShares) * 100);
    return {
      bandRange: `$${formatPrice(level.bandLow)}–$${formatPrice(level.bandHigh)}`,
      dominantDirection: level.dominantDirection,
      firstAt: formatNyDateTime(level.firstAt),
      index,
      lastAt: formatNyDateTime(level.lastAt),
      levelPrints: [...(printsByLevel.get(index) ?? [])].reverse().slice(0, 8),
      notional: formatMoney(level.totalNotional),
      price: `$${formatPrice(level.price)}`,
      prints: level.prints,
      rank: level.rank,
      shares: formatCount(level.totalShares),
      sideMix: `${buyPct}% buy / ${sellPct}% sell`,
      spotDelta,
      spotRelation: relation,
    };
  });
};

export const buildOffExchangeFinraSummary = (
  response: FlowOffExchangeLevels
): OffExchangeFinraSummary | null => {
  const latest = response.finraWeekly.at(-1);
  if (latest === undefined) return null;

  const maxTotal = Math.max(
    1,
    ...response.finraWeekly.map((week) => week.totalShares)
  );
  const chartHeight = 46;
  const chartWidth = 320;
  const step = chartWidth / response.finraWeekly.length;
  const width = Math.max(14, Math.min(30, Math.round(step * 0.68)));

  const bars: FinraWeekBarView[] = response.finraWeekly.map((week, i) => {
    const totalH = Math.max(
      2,
      Math.round((week.totalShares / maxTotal) * chartHeight)
    );
    const atsH =
      week.totalShares > 0
        ? Math.round((week.atsShares / week.totalShares) * totalH)
        : 0;
    const nonAtsH = Math.max(0, totalH - atsH);
    const x = Math.round(i * step + (step - width) / 2);
    return {
      atsHeight: atsH,
      atsShare: formatShare(week.atsShare),
      atsShares: formatCount(week.atsShares),
      atsY: chartHeight - atsH,
      nonAtsHeight: nonAtsH,
      nonAtsShares: formatCount(week.nonAtsShares),
      nonAtsY: chartHeight - atsH - nonAtsH,
      shortWeek: shortDay(week.weekStart),
      totalShares: formatCount(week.totalShares),
      weekStart: week.weekStart,
      width,
      x,
    };
  });

  return {
    atsShare: formatShare(latest.atsShare),
    atsShares: formatCount(latest.atsShares),
    avgAtsTradeSize:
      latest.avgAtsTradeSize === null
        ? "no value"
        : `${Math.round(latest.avgAtsTradeSize)} sh/trade`,
    bars,
    latestLastUpdated: latest.lastUpdated,
    latestWeekStart: latest.weekStart,
    nonAtsShares: formatCount(latest.nonAtsShares),
    totalShares: formatCount(latest.totalShares),
  };
};
