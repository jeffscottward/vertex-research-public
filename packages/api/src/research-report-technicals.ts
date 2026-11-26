import type { MarketBarColumns } from "@darkfactory/db/server";
import { sma } from "@darkfactory/shared/indicators";

import type {
  ResearchReportDataSource,
  ResearchReportFibonacci,
  ResearchReportFreshness,
  ResearchReportPivot,
  ResearchReportStoredTechnicals,
  ResearchReportTechnicals,
  ResearchReportTechnicalsCheck,
  ResearchReportTechnicalsRecomputed,
  ResearchReportTrendCheck,
  ResearchReportVolumeProfile,
  ResearchReportWeinstein,
} from "./contracts/research-reports.ts";
import {
  expectedFreshnessSession,
  nyseSessionsBehind,
} from "./price-freshness.ts";

// Technicals of a research dossier (merge plan P1-4). Pure functions only.
// The indicator math is a port of the old workspace builders `scripts/analyze-technicals.mjs`
// (`wilderRSI`, `wilderATR`, pivots, `fibonacciLevels`, weekly closes) and
// `scripts/workspace-analysis.mjs` (`completedBars`, `analyzeHistory`). The same order of
// floating-point operations is kept on purpose: the stored dossier values must recompute
// exactly (===) from the stored daily bars. The Weinstein stage and volume profile rules
// were decided from the trading knowledge bases (2026-11-16; see
// docs/vertex-rebuild/designs/research-report-technicals/design.md). Context markers only:
// no signal, no order, no trading permission.

export type DossierBar = Readonly<{
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

type Json = Readonly<Record<string, unknown>>;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nullable = (value: number | null | undefined): number | null =>
  finite(value) ? value : null;
/** Six decimals, like the old APP note (prices of pivots, Fibonacci and the profile). */
const round = (value: number): number => {
  const scaled = value * 1e6;
  // A finite price too large to scale stays as it is (it would otherwise become Infinity).
  return Number.isFinite(scaled) ? Math.round(scaled) / 1e6 : value;
};
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
const numberOrNaN = (value: unknown): number =>
  typeof value === "number" ? value : Number.NaN;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** Stored dates pass only as `YYYY-MM-DD`; other text is never passed on. */
const dateOrNull = (value: unknown): string | null =>
  typeof value === "string" && DATE.test(value) ? value : null;

const calendarDateOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const millis = Date.parse(`${value}T00:00:00Z`);
  return finite(millis) && new Date(millis).toISOString().slice(0, 10) === value
    ? value
    : null;
};

/** Maximum NYSE sessions behind expectedFreshnessSession before dossier price data is marked stale. */
const DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND = 2;

/** Evaluates how fresh a dossier's data date is against the latest expected finished NYSE session. */
export const evaluateDossierFreshness = (
  asOf: string | null,
  now: Date = new Date()
): ResearchReportFreshness => {
  const expectedSession = expectedFreshnessSession(now);
  const validDate = calendarDateOrNull(asOf);
  if (validDate === null) {
    return {
      asOf: null,
      expectedSession,
      isStale: false,
      maxSessionsBehind: DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND,
      sessionsBehind: null,
      status: "no_date",
    };
  }
  const sessionsBehind = nyseSessionsBehind(validDate, expectedSession);
  const isStale = sessionsBehind > DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND;
  return {
    asOf: validDate,
    expectedSession,
    isStale,
    maxSessionsBehind: DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND,
    sessionsBehind,
    status: isStale ? "stale" : "fresh",
  };
};

/** Converts columnar stored daily bars (`market_bars`) into ordered `DossierBar` records. */
export const marketBarColumnsToDossierBars = (
  columns: MarketBarColumns
): DossierBar[] => {
  const dates = new Set<string>();
  const bars: DossierBar[] = [];
  for (let index = 0; index < columns.t.length; index += 1) {
    const timestamp = columns.t[index];
    const close = columns.c[index];
    if (!(finite(timestamp) && finite(close))) continue;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (dates.has(date)) continue;
    dates.add(date);
    bars.push({
      close,
      date,
      high: numberOrNaN(columns.h[index]),
      low: numberOrNaN(columns.l[index]),
      volume: numberOrNaN(columns.v?.[index]),
    });
  }
  return bars;
};

/**
 * Completed daily bars in input order (port of `completedBars`): drops partial bars, bars
 * without a finite close or a valid calendar date, and repeated dates. Never fills gaps.
 */
export const completedBars = (history: unknown): DossierBar[] => {
  if (!Array.isArray(history)) return [];
  const dates = new Set<string>();
  const bars: DossierBar[] = [];
  for (const item of history) {
    const bar = record(item);
    if (bar === null || bar["isPartial"] === true) continue;
    const { close, date } = bar;
    if (!finite(close) || typeof date !== "string" || !DATE.test(date))
      continue;
    const millis = Date.parse(`${date}T00:00:00Z`);
    if (
      !finite(millis) ||
      new Date(millis).toISOString().slice(0, 10) !== date ||
      dates.has(date)
    )
      continue;
    dates.add(date);
    bars.push({
      close,
      date,
      high: numberOrNaN(bar["high"]),
      low: numberOrNaN(bar["low"]),
      volume: numberOrNaN(bar["volume"]),
    });
  }
  return bars;
};

/** High and low exist and contain the close. */
export const validRange = (bar: DossierBar): boolean =>
  finite(bar.high) &&
  finite(bar.low) &&
  bar.high >= bar.close &&
  bar.low <= bar.close &&
  bar.high >= bar.low;

/** Wilder RSI: seeded with the mean of `period` gains and losses, then the 1/period recursion. */
export const wilderRsi = (
  closes: readonly number[],
  period = 14
): (number | null)[] => {
  const result: (number | null)[] = closes.map(() => null);
  if (closes.length <= period || !closes.every(finite)) return result;
  const at = (index: number): number => closes[index] as number;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = at(index) - at(index - 1);
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  const value = (): number => {
    if (gain === 0 && loss === 0) return 50;
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  };
  result[period] = value();
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = at(index) - at(index - 1);
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = value();
  }
  return result;
};

/** Wilder ATR: the first true range is high - low; seeded with the mean of `period` ranges. */
export const wilderAtr = (
  bars: readonly DossierBar[],
  period = 14
): (number | null)[] => {
  const result: (number | null)[] = bars.map(() => null);
  if (
    bars.length < period ||
    !bars.every((bar) => finite(bar.high) && finite(bar.low))
  )
    return result;
  const ranges = bars.map((bar, index) => {
    const previous = bars[index - 1];
    return previous === undefined
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - previous.close),
          Math.abs(bar.low - previous.close)
        );
  });
  const seed = ranges.slice(0, period);
  let atr = seed.reduce((sum, range) => sum + range, 0) / seed.length;
  result[period - 1] = atr;
  for (let index = period; index < bars.length; index += 1) {
    atr = (atr * (period - 1) + (ranges[index] as number)) / period;
    result[index] = atr;
  }
  return result;
};

/** The stored indicator values, recomputed from the stored bars (port of `analyzeHistory`). */
export const recomputeIndicators = (
  bars: readonly DossierBar[]
): ResearchReportTechnicalsRecomputed => {
  const closes = bars.map((bar) => bar.close);
  const last = bars.at(-1);
  const atrAvailable = bars.length > 0 && bars.every(validRange);
  return {
    asOf: last?.date ?? null,
    atr14: atrAvailable ? nullable(wilderAtr(bars, 14).at(-1)) : null,
    latestClose: last?.close ?? null,
    rsi14: nullable(wilderRsi(closes, 14).at(-1)),
    sampleCount: bars.length,
    sma20: nullable(sma(closes, 20).at(-1)),
    sma50: nullable(sma(closes, 50).at(-1)),
    sma150: nullable(sma(closes, 150).at(-1)),
    sma200: nullable(sma(closes, 200).at(-1)),
  };
};

const TREND_CHECK_KEYS = [
  "closeAboveSma20",
  "closeAboveSma50",
  "closeAboveSma150",
  "closeAboveSma200",
  "sma50AboveSma150",
  "sma50AboveSma200",
  "sma150AboveSma200",
  "sma200Rising20Sessions",
] as const;

const SMA200_SLOPE_SESSIONS = 20;
const RANGE_52_WEEK_SESSIONS = 252;

const barHighOrClose = (bar: DossierBar): number =>
  finite(bar.high) ? bar.high : bar.close;
const barLowOrClose = (bar: DossierBar): number =>
  finite(bar.low) ? bar.low : bar.close;

const computeSma200Slope = (
  bars: readonly DossierBar[],
  closes: readonly number[],
  currentSma200: number | null,
  lastDate: string
): ResearchReportStoredTechnicals["sma200Slope"] => {
  const earlierIndex = bars.length - 1 - SMA200_SLOPE_SESSIONS;
  if (currentSma200 === null || earlierIndex < 0) return null;
  const earlierSma200 = nullable(sma(closes, 200)[earlierIndex]);
  if (earlierSma200 === null) return null;
  return {
    change: round(currentSma200 - earlierSma200),
    changePct:
      earlierSma200 > 0
        ? round((100 * (currentSma200 - earlierSma200)) / earlierSma200)
        : null,
    fromDate: (bars[earlierIndex] as DossierBar).date,
    toDate: lastDate,
  };
};

const computeRange52Week = (
  bars: readonly DossierBar[]
): NonNullable<ResearchReportStoredTechnicals["range52Week"]> => {
  const yearSlice = bars.slice(-RANGE_52_WEEK_SESSIONS);
  const firstYear = yearSlice[0] as DossierBar;
  let high52 = barHighOrClose(firstYear);
  let high52Date = firstYear.date;
  let low52 = barLowOrClose(firstYear);
  let low52Date = firstYear.date;
  for (const bar of yearSlice) {
    const high = barHighOrClose(bar);
    const low = barLowOrClose(bar);
    if (high > high52) {
      high52 = high;
      high52Date = bar.date;
    }
    if (low < low52) {
      low52 = low;
      low52Date = bar.date;
    }
  }
  return {
    high: round(high52),
    highDate: high52Date,
    low: round(low52),
    lowDate: low52Date,
    sampleCount: yearSlice.length,
  };
};

const computeMaximumObservedHigh = (
  bars: readonly DossierBar[],
  lastClose: number
): NonNullable<ResearchReportStoredTechnicals["maximumObservedHigh"]> => {
  const firstBar = bars[0] as DossierBar;
  let maxHigh = barHighOrClose(firstBar);
  let maxHighDate = firstBar.date;
  for (const bar of bars) {
    const high = barHighOrClose(bar);
    if (high > maxHigh) {
      maxHigh = high;
      maxHighDate = bar.date;
    }
  }
  return {
    date: maxHighDate,
    drawdownPct:
      maxHigh > 0 ? round((100 * (lastClose - maxHigh)) / maxHigh) : null,
    price: round(maxHigh),
  };
};

const isAbove = (left: number | null, right: number | null): boolean | null =>
  left === null || right === null ? null : left > right;

/** Full indicator set and trend checks computed directly from daily bars. */
export const computeFullIndicators = (
  bars: readonly DossierBar[]
): ResearchReportStoredTechnicals | null => {
  const last = bars.at(-1);
  if (last === undefined) return null;
  const closes = bars.map((bar) => bar.close);
  const core = recomputeIndicators(bars);
  const sma200Slope = computeSma200Slope(bars, closes, core.sma200, last.date);
  const trendValues: Readonly<
    Record<ResearchReportTrendCheck["key"], boolean | null>
  > = {
    closeAboveSma20: isAbove(last.close, core.sma20),
    closeAboveSma50: isAbove(last.close, core.sma50),
    closeAboveSma150: isAbove(last.close, core.sma150),
    closeAboveSma200: isAbove(last.close, core.sma200),
    sma50AboveSma150: isAbove(core.sma50, core.sma150),
    sma50AboveSma200: isAbove(core.sma50, core.sma200),
    sma150AboveSma200: isAbove(core.sma150, core.sma200),
    sma200Rising20Sessions:
      sma200Slope === null ? null : sma200Slope.change > 0,
  };
  return {
    ...core,
    maximumObservedHigh: computeMaximumObservedHigh(bars, last.close),
    range52Week: computeRange52Week(bars),
    sma200Slope,
    trendChecks: TREND_CHECK_KEYS.map((key) => ({
      key,
      passed: trendValues[key],
    })),
  };
};

const storedNumber = (data: Json, key: string): number | null =>
  nullable(data[key] as number | null | undefined);

/** Reads the stored technicals dataset defensively: a field with another shape becomes null. */
export const readStoredTechnicals = (
  data: unknown
): ResearchReportStoredTechnicals => {
  const body = record(data) ?? {};
  const slope = record(body["sma200Slope"]);
  const range = record(body["range52Week"]);
  const high = record(body["maximumObservedHigh"]);
  const checks = record(body["trendChecks"]) ?? {};
  const sampleCount = storedNumber(body, "sampleCount");
  return {
    asOf: dateOrNull(body["asOf"]),
    atr14: storedNumber(body, "atr14"),
    latestClose: storedNumber(body, "latestClose"),
    maximumObservedHigh:
      high === null || !finite(high["price"])
        ? null
        : {
            date: dateOrNull(high["date"]),
            drawdownPct: storedNumber(high, "drawdownPct"),
            price: high["price"],
          },
    range52Week:
      range === null || !finite(range["low"]) || !finite(range["high"])
        ? null
        : {
            high: range["high"],
            highDate: dateOrNull(range["highDate"]),
            low: range["low"],
            lowDate: dateOrNull(range["lowDate"]),
            sampleCount: storedNumber(range, "sampleCount"),
          },
    rsi14: storedNumber(body, "rsi14"),
    sampleCount:
      sampleCount !== null &&
      Number.isSafeInteger(sampleCount) &&
      sampleCount >= 0
        ? sampleCount
        : null,
    sma20: storedNumber(body, "sma20"),
    sma50: storedNumber(body, "sma50"),
    sma150: storedNumber(body, "sma150"),
    sma200: storedNumber(body, "sma200"),
    sma200Slope:
      slope === null || !finite(slope["change"])
        ? null
        : {
            change: slope["change"],
            changePct: storedNumber(slope, "changePct"),
            fromDate: dateOrNull(slope["fromDate"]),
            toDate: dateOrNull(slope["toDate"]),
          },
    trendChecks: TREND_CHECK_KEYS.map(
      (key): ResearchReportTrendCheck => ({
        key,
        passed: typeof checks[key] === "boolean" ? checks[key] : null,
      })
    ),
  };
};

const CHECKED_FIELDS = [
  "asOf",
  "sampleCount",
  "latestClose",
  "rsi14",
  "atr14",
  "sma20",
  "sma50",
  "sma150",
  "sma200",
] as const;

/** Compares the stored values with the recomputed ones exactly (the port's proof). */
export const compareWithStored = (
  stored: ResearchReportStoredTechnicals,
  recomputed: ResearchReportTechnicalsRecomputed | null
): ResearchReportTechnicalsCheck => {
  // A dossier without a stored sample count does not have the workspace-analysis shape
  // (the flat APP report); there is nothing to compare.
  if (
    recomputed === null ||
    recomputed.sampleCount === 0 ||
    stored.sampleCount === null
  )
    return { mismatches: [], status: "unavailable" };
  const mismatches = CHECKED_FIELDS.filter(
    (field) => stored[field] !== recomputed[field]
  );
  return { mismatches, status: mismatches.length === 0 ? "match" : "mismatch" };
};

const PIVOT_LOOKBACK_SESSIONS = 60;

/**
 * Swing pivots of the last 60 sessions (port of the old APP note): a bar whose low (high) is
 * strictly below (above) the two bars on each side, confirmed by the second bar after it.
 */
export const swingPivots = (
  bars: readonly DossierBar[]
): ResearchReportPivot[] => {
  const pivots: ResearchReportPivot[] = [];
  const at = (index: number): DossierBar => bars[index] as DossierBar;
  for (
    let index = Math.max(2, bars.length - PIVOT_LOOKBACK_SESSIONS);
    index < bars.length - 2;
    index += 1
  ) {
    const bar = at(index);
    const around = [-2, -1, 1, 2].map((offset) => at(index + offset));
    const confirmedOn = at(index + 2).date;
    if (around.every((other) => bar.low < other.low))
      pivots.push({
        confirmedOn,
        date: bar.date,
        kind: "support",
        price: round(bar.low),
      });
    if (around.every((other) => bar.high > other.high))
      pivots.push({
        confirmedOn,
        date: bar.date,
        kind: "resistance",
        price: round(bar.high),
      });
  }
  return pivots;
};

/** The newest support below and the newest resistance above the close. */
export const candidatePivots = (
  pivots: readonly ResearchReportPivot[],
  close: number
): Readonly<{
  support: ResearchReportPivot | null;
  resistance: ResearchReportPivot | null;
}> => {
  const newestFirst = [...pivots].reverse();
  return {
    resistance:
      newestFirst.find(
        (pivot) => pivot.kind === "resistance" && pivot.price > close
      ) ?? null,
    support:
      newestFirst.find(
        (pivot) => pivot.kind === "support" && pivot.price < close
      ) ?? null,
  };
};

const FIBONACCI_WINDOW = 252;
const FIBONACCI_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/**
 * Fibonacci retracement of the largest swing in the trailing window (port of
 * `fibonacciLevels`). Up swing (high after low): levels measured down from the high.
 */
export const fibonacciLevels = (
  bars: readonly DossierBar[],
  close: number,
  window = FIBONACCI_WINDOW
): ResearchReportFibonacci | null => {
  // Bars without a high and a low (kept for the close) cannot set the swing.
  const slice = bars
    .slice(-window)
    .filter((bar) => finite(bar.high) && finite(bar.low));
  const first = slice[0];
  if (first === undefined || slice.length < 20 || !finite(close)) return null;
  let high = first;
  let low = first;
  for (const bar of slice) {
    if (bar.high > high.high) high = bar;
    if (bar.low < low.low) low = bar;
  }
  const range = high.high - low.low;
  if (!(range > 0 && finite(range))) return null;
  const direction = high.date >= low.date ? "up" : "down";
  const levels = FIBONACCI_RATIOS.map((ratio) => ({
    price: round(
      direction === "up" ? high.high - ratio * range : low.low + ratio * range
    ),
    ratio,
  }));
  const below = levels
    .filter((level) => level.price < close)
    .sort((a, b) => b.price - a.price)[0];
  const above = levels
    .filter((level) => level.price > close)
    .sort((a, b) => a.price - b.price)[0];
  return {
    direction,
    levels,
    nearestAbove: above ?? null,
    nearestBelow: below ?? null,
    swingHigh: { date: high.date, price: round(high.high) },
    swingLow: { date: low.date, price: round(low.low) },
    window: slice.length,
  };
};

export type WeeklyClose = Readonly<{ week: string; close: number }>;

/**
 * Closes of complete weeks (port of `weeklyCloses`): each week is keyed by its Friday. A week
 * is complete when a later bar exists (so a Friday holiday does not drop it) or when its
 * Friday 21:00 UTC is not after `now`. The last bar of a week gives its close.
 */
export const weeklyCloses = (
  bars: readonly DossierBar[],
  now: string
): WeeklyClose[] => {
  const weeks = new Map<string, number>();
  const nowMillis = Date.parse(now);
  const lastDate = bars.at(-1)?.date ?? "";
  for (const bar of bars) {
    const day = new Date(`${bar.date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + ((5 - day.getUTCDay() + 7) % 7));
    const friday = day.toISOString().slice(0, 10);
    if (lastDate > friday || Date.parse(`${friday}T21:00:00Z`) <= nowMillis)
      weeks.set(friday, bar.close);
  }
  return [...weeks].map(([week, close]) => ({ close, week }));
};

const WEINSTEIN_RULE = Object.freeze({
  /** |4-week change of the 30-week SMA| at or below this percentage is flat. */
  flatBandPct: 1,
  /** Only the last 104 complete weeks are classified, so the result does not depend on how far back the stored history starts. */
  historyWeeks: 104,
  minimumWeeks: 34,
  slopeWeeks: 4,
  smaWeeks: 30,
});

const STAGE_LABELS = {
  1: "Stage 1: basing",
  2: "Stage 2: advancing",
  3: "Stage 3: topping",
  4: "Stage 4: declining",
} as const;

const formatWeinsteinResult = (
  latest: WeeklyClose,
  completeWeeks: number,
  sma30: number,
  slopePct: number,
  stage: 1 | 2 | 3 | 4 | null,
  asOf?: string
): ResearchReportWeinstein => ({
  asOf: asOf ?? latest.week,
  completeWeeks,
  isStale: false,
  label:
    stage === null
      ? "Stage 1 or 3: unresolved (no earlier Stage 2 or 4)"
      : STAGE_LABELS[stage],
  sma30: round(sma30),
  sma30ChangePct: round(slopePct),
  stage,
  staleReason: null,
  weekEnding: latest.week,
  weeklyClose: round(latest.close),
});

/**
 * Weinstein stage from complete weekly closes (KB rule, 2026-11-16): Stage 2 when the close is
 * above a rising 30-week SMA, Stage 4 when it is below a falling one. Any other week is Stage 3
 * after a Stage 2, Stage 1 after a Stage 4, and unresolved before the first Stage 2 or 4.
 */
export const weinsteinStage = (
  weeks: readonly WeeklyClose[],
  asOf?: string
): ResearchReportWeinstein | null => {
  const { flatBandPct, historyWeeks, minimumWeeks, slopeWeeks, smaWeeks } =
    WEINSTEIN_RULE;
  if (weeks.length < minimumWeeks) return null;
  const averages = sma(
    weeks.map((week) => week.close),
    smaWeeks
  );
  let decided: 2 | 4 | null = null;
  let stage: 1 | 2 | 3 | 4 | null = null;
  let slopePct = 0;
  for (
    let index = Math.max(minimumWeeks, weeks.length - historyWeeks + 1) - 1;
    index < weeks.length;
    index += 1
  ) {
    const average = averages[index] as number;
    const earlier = averages[index - slopeWeeks] as number;
    slopePct = 100 * (average / earlier - 1);
    // Continuous futures can trade at or below zero, and extreme values can overflow; a
    // percentage slope is then undefined.
    if (
      !(
        finite(average) &&
        finite(earlier) &&
        earlier > 0 &&
        average > 0 &&
        finite(slopePct)
      )
    )
      return null;
    const close = (weeks[index] as WeeklyClose).close;
    if (close > average && slopePct > flatBandPct) decided = 2;
    else if (close < average && slopePct < -flatBandPct) decided = 4;
    else {
      stage = decided === 2 ? 3 : decided === 4 ? 1 : null;
      continue;
    }
    stage = decided;
  }
  const latest = weeks.at(-1) as WeeklyClose;
  return formatWeinsteinResult(
    latest,
    weeks.length,
    averages.at(-1) as number,
    slopePct,
    stage,
    asOf
  );
};

const VOLUME_PROFILE_RULE = Object.freeze({
  bins: 50,
  minimumSessions: 20,
  sessions: 63,
  valueAreaPct: 70,
});

/** Bump when a rule or window changes, so a saved value can be tied to the method that made it. */
export const TECHNICALS_METHOD = Object.freeze({
  fibonacciWindowSessions: FIBONACCI_WINDOW,
  freshnessMaxSessionsBehind: DOSSIER_TECHNICALS_MAX_SESSIONS_BEHIND,
  pivotLookbackSessions: PIVOT_LOOKBACK_SESSIONS,
  version: 1,
  volumeProfile: VOLUME_PROFILE_RULE,
  weinstein: WEINSTEIN_RULE,
});

/** Spreads each day's volume evenly over the bins that its high-low range covers. */
const spreadVolume = (
  window: readonly DossierBar[],
  low: number,
  width: number,
  binCount: number
): number[] => {
  const volumes = Array.from({ length: binCount }, () => 0);
  const binOf = (price: number): number =>
    Math.min(binCount - 1, Math.floor((price - low) / width));
  for (const bar of window) {
    const first = binOf(bar.low);
    const last = binOf(bar.high);
    for (let bin = first; bin <= last; bin += 1) {
      const overlap =
        Math.min(low + (bin + 1) * width, bar.high) -
        Math.max(low + bin * width, bar.low);
      // A day with high = low has no overlap length: all of its volume goes to its bin.
      const share =
        bar.high === bar.low ? 1 : Math.max(overlap, 0) / (bar.high - bar.low);
      volumes[bin] = (volumes[bin] as number) + bar.volume * share;
    }
  }
  return volumes;
};

/**
 * Grows the value area from the POC: the neighbouring bin with more volume joins first (the
 * upper one on a tie) until the area holds `targetPct` of all volume.
 */
const valueArea = (
  volumes: readonly number[],
  poc: number,
  targetPct: number
): Readonly<{ bottom: number; top: number; inside: number }> => {
  const total = volumes.reduce((sum, volume) => sum + volume, 0);
  const volumeAt = (bin: number): number => volumes[bin] ?? -1;
  let bottom = poc;
  let top = poc;
  let inside = volumeAt(poc);
  // Bounded by the bin count: the area never grows past every bin.
  while (
    inside < (total * targetPct) / 100 &&
    top - bottom + 1 < volumes.length
  ) {
    if (volumeAt(top + 1) >= volumeAt(bottom - 1)) {
      top += 1;
      inside += volumeAt(top);
    } else {
      bottom -= 1;
      inside += volumeAt(bottom);
    }
  }
  return { bottom, inside, top };
};

/**
 * Volume profile from daily bars (KB rule, 2026-11-16): the last 63 sessions, 50 equal price
 * bins from the window low to the window high, each day's volume spread evenly over its
 * high-low range. The point of control (POC) is the bin with the most volume (the lower bin on
 * a tie); the value area holds 70% of the volume around it.
 */
export const volumeProfile = (
  bars: readonly DossierBar[],
  close: number
): ResearchReportVolumeProfile | null => {
  const {
    bins: binCount,
    minimumSessions,
    sessions,
    valueAreaPct,
  } = VOLUME_PROFILE_RULE;
  const window = bars.slice(-sessions);
  if (
    window.length < minimumSessions ||
    !window.every(
      (bar) => validRange(bar) && finite(bar.volume) && bar.volume >= 0
    )
  )
    return null;
  const low = Math.min(...window.map((bar) => bar.low));
  const high = Math.max(...window.map((bar) => bar.high));
  if (!(high > low && finite(high - low))) return null;
  const width = (high - low) / binCount;
  const volumes = spreadVolume(window, low, width, binCount);
  const total = volumes.reduce((sum, volume) => sum + volume, 0);
  if (!(total > 0 && Number.isSafeInteger(Math.round(total)))) return null;
  const poc = volumes.indexOf(Math.max(...volumes));
  const area = valueArea(volumes, poc, valueAreaPct);
  const edge = (bin: number): number => round(low + bin * width);
  const valueAreaLow = edge(area.bottom);
  const valueAreaHigh = edge(area.top + 1);
  return {
    bins: volumes.map((volume, bin) => ({
      high: edge(bin + 1),
      low: edge(bin),
      volume: Math.round(volume),
    })),
    binWidth: round(width),
    closeLocation:
      close > valueAreaHigh
        ? "above"
        : close < valueAreaLow
          ? "below"
          : "inside",
    endDate: (window.at(-1) as DossierBar).date,
    high: round(high),
    low: round(low),
    poc: {
      high: edge(poc + 1),
      low: edge(poc),
      volume: Math.round(volumes[poc] as number),
    },
    sessions: window.length,
    startDate: (window[0] as DossierBar).date,
    totalVolume: Math.round(total),
    valueAreaHigh,
    valueAreaLow,
    valueAreaVolumePct: round((100 * area.inside) / total),
  };
};

/** Inputs of one dossier technicals build: stored revision datasets plus optional fresher daily bars. */
export type ResearchReportTechnicalsInput = Readonly<{
  assetType: string | null;
  liveBars?: readonly DossierBar[] | null;
  liveBarsCollectedAt?: string | null;
  market: unknown;
  now?: Date;
  technicals: unknown;
}>;

const applyWeinsteinFreshness = (
  rawWeinstein: ResearchReportWeinstein | null,
  freshness: ResearchReportFreshness,
  lastDate: string,
  warnings: string[]
): ResearchReportWeinstein | null => {
  if (!freshness.isStale) return rawWeinstein;
  const staleReason = `Daily bars end ${lastDate} (${freshness.sessionsBehind} NYSE sessions behind ${freshness.expectedSession}; limit is ${freshness.maxSessionsBehind} sessions).`;
  warnings.push(
    `Price data is stale: ${staleReason} Indicators and Weinstein stage reflect that date, not the current market.`
  );
  if (rawWeinstein === null) return null;
  return {
    ...rawWeinstein,
    asOf: lastDate,
    isStale: true,
    label: `${rawWeinstein.label} (stale; data as of ${lastDate})`,
    staleReason,
  };
};

const appendMarkerWarnings = ({
  assetType,
  fibonacci,
  profile,
  rawWeinstein,
  warnings,
  weekCount,
}: Readonly<{
  assetType: string | null;
  fibonacci: ResearchReportFibonacci | null;
  profile: ResearchReportVolumeProfile | null;
  rawWeinstein: ResearchReportWeinstein | null;
  warnings: string[];
  weekCount: number;
}>): void => {
  if (rawWeinstein === null)
    warnings.push(
      weekCount < WEINSTEIN_RULE.minimumWeeks
        ? `Weinstein stage needs ${WEINSTEIN_RULE.minimumWeeks} complete weeks; this revision has ${weekCount}.`
        : "Weinstein stage unavailable: the 30-week SMA or its slope is not a finite positive value inside the classified window."
    );
  if (fibonacci === null)
    warnings.push("Fibonacci levels need at least 20 bars with a price range.");
  if (profile === null)
    warnings.push(
      `The volume profile needs ${VOLUME_PROFILE_RULE.minimumSessions} or more recent bars, each with a valid range and volume.`
    );
  if (assetType === "future")
    warnings.push(
      "Continuous futures bars can contain roll gaps; a roll inside a window can distort pivots, Fibonacci levels and the volume profile."
    );
};

const normalizeInstant = (value: unknown): string | null => {
  const millis =
    typeof value === "string" && ISO_INSTANT.test(value)
      ? Date.parse(value)
      : Number.NaN;
  return finite(millis) ? new Date(millis).toISOString() : null;
};

/**
 * The technicals view of one dossier. Week completeness uses the active bar set's collection
 * time (else the last bar's date at 21:00 UTC), kept separate from wall-clock `now`, which is
 * used solely to evaluate staleness against the expected NYSE session.
 */
export const buildResearchReportTechnicals = ({
  assetType,
  liveBars,
  liveBarsCollectedAt,
  market,
  now = new Date(),
  technicals,
}: ResearchReportTechnicalsInput): Omit<
  ResearchReportTechnicals,
  "dataRevision" | "reportId"
> => {
  const stored = readStoredTechnicals(technicals);
  const marketBody = record(market);
  const storedBars = completedBars(marketBody?.["history"]);
  const storedLast = storedBars.at(-1);
  const live = liveBars ?? [];
  const liveLast = live.at(-1);
  const useLiveBars =
    liveLast !== undefined &&
    (storedLast === undefined || liveLast.date > storedLast.date);
  const bars = useLiveBars ? live : storedBars;
  const barsSource: ResearchReportDataSource = useLiveBars
    ? "market_bars"
    : "revision";
  const last = bars.at(-1);
  const warnings: string[] = [];
  if (last === undefined) {
    const dataDate = stored.asOf;
    const freshness = evaluateDossierFreshness(dataDate, now);
    warnings.push(
      "No stored daily bars in this revision: pivots, Weinstein stage, Fibonacci levels and the volume profile are unavailable."
    );
    return {
      bars: null,
      check: compareWithStored(stored, null),
      current: null,
      dataDate,
      fibonacci: null,
      freshness,
      method: TECHNICALS_METHOD,
      pivots: null,
      recomputed: null,
      stored,
      volumeProfile: null,
      warnings,
      weinstein: null,
    };
  }
  // Only a parseable ISO instant passes, normalized to UTC.
  const collectedAt = useLiveBars
    ? normalizeInstant(liveBarsCollectedAt)
    : normalizeInstant(marketBody?.["collectedAt"]);
  const weekCompletenessAt = collectedAt ?? `${last.date}T21:00:00Z`;
  const storedRecomputed =
    storedBars.length > 0 ? recomputeIndicators(storedBars) : null;
  const check = compareWithStored(stored, storedRecomputed);
  if (check.status === "mismatch")
    warnings.push(
      `Recomputed values differ from the stored values (${check.mismatches.join(", ")}): the stored bars may not be the bars behind the stored indicators.`
    );
  const current = computeFullIndicators(bars);
  const pivots = swingPivots(bars);
  const candidates = candidatePivots(pivots, last.close);
  const weeks = weeklyCloses(bars, weekCompletenessAt);
  const rawWeinstein = weinsteinStage(weeks, last.date);
  const fibonacci = fibonacciLevels(bars, last.close);
  const profile = volumeProfile(bars, last.close);
  const dataDate = last.date;
  const freshness = evaluateDossierFreshness(dataDate, now);
  const weinstein = applyWeinsteinFreshness(
    rawWeinstein,
    freshness,
    last.date,
    warnings
  );
  appendMarkerWarnings({
    assetType,
    fibonacci,
    profile,
    rawWeinstein,
    warnings,
    weekCount: weeks.length,
  });
  return {
    bars: {
      collectedAt,
      count: bars.length,
      firstDate: (bars[0] as DossierBar).date,
      lastDate: last.date,
      source: barsSource,
    },
    check,
    current,
    dataDate,
    fibonacci,
    freshness,
    method: TECHNICALS_METHOD,
    pivots: {
      candidateResistance: candidates.resistance,
      candidateSupport: candidates.support,
      items: pivots,
      lookbackSessions: PIVOT_LOOKBACK_SESSIONS,
    },
    recomputed: storedRecomputed,
    stored,
    volumeProfile: profile,
    warnings,
    weinstein,
  };
};
