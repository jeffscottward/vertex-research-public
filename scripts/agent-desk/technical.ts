// Technical analyst and backtest agents for the paper agent desk (ported from vertex-research PR #2).
//
// Rule under test (2026-10-16 reel brief DekKdTQorlC, Jordi Visser's example):
//   1. The completed close is above the 200-session SMA.
//   2. The 200-session SMA is rising (higher than `slopeLookback` sessions ago).
//   3. The ~3-month rate of change (ROC, `rocPeriod` sessions) has reset close to zero
//      (|ROC| <= `resetBandPct`) after a high reading (max ROC over the previous
//      `peakLookback` sessions >= `priorPeakMinPct`).
// The rule is a research filter. It is not an order signal and sends nothing to a broker.

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** True for a real calendar date in YYYY-MM-DD form (2026-02-31 is rejected). */
export const isCalendarDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

/** The YYYY-MM-DD prefix of an ISO date or timestamp, or null. */
export const dayOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return isCalendarDay(day) ? day : null;
};

export const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS
  );

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const roundTo = (value: number | null, digits = 4): number | null =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export type Rule = Readonly<{
  smaPeriod: number;
  slopeLookback: number;
  rocPeriod: number;
  resetBandPct: number;
  priorPeakMinPct: number;
  peakLookback: number;
}>;

export type BacktestSettings = Readonly<{
  holdSessions: number;
  costBpsPerSide: number;
  minClosedTrades: number;
}>;

export const DEFAULT_RULE: Rule = Object.freeze({
  peakLookback: 63,
  priorPeakMinPct: 10,
  resetBandPct: 3,
  rocPeriod: 63,
  slopeLookback: 20,
  smaPeriod: 200,
});

export const DEFAULT_BACKTEST: BacktestSettings = Object.freeze({
  costBpsPerSide: 5,
  holdSessions: 63,
  minClosedTrades: 5,
});

const INTEGER_KEYS: Readonly<Record<string, true>> = {
  holdSessions: true,
  minClosedTrades: true,
  peakLookback: true,
  rocPeriod: true,
  slopeLookback: true,
  smaPeriod: true,
};

const checkParameters = <T extends Record<string, number>>(values: T): T => {
  for (const [key, value] of Object.entries(values)) {
    const positiveInteger = Number.isInteger(value) && value >= 1;
    const integer = INTEGER_KEYS[key] === true;
    const valid = integer
      ? positiveInteger
      : isFiniteNumber(value) && value >= 0;
    if (!valid) {
      throw new TypeError(
        `Parameter ${key} must be ${integer ? "a positive integer" : "a non-negative number"}`
      );
    }
  }
  return Object.freeze({ ...values });
};

export const ruleParameters = (overrides: Partial<Rule> = {}): Rule =>
  checkParameters({ ...DEFAULT_RULE, ...overrides });

export const backtestParameters = (
  overrides: Partial<BacktestSettings> = {}
): BacktestSettings => checkParameters({ ...DEFAULT_BACKTEST, ...overrides });

/** Index of the first bar at which every rule input is known. */
export const firstEvaluableIndex = (rule: Rule): number =>
  Math.max(
    rule.smaPeriod - 1 + rule.slopeLookback,
    rule.rocPeriod + rule.peakLookback
  );

export type Bar = Readonly<{
  date: string;
  open: number | null;
  close: number;
}>;

/**
 * Keeps completed daily bars with a finite positive close in strictly increasing date order.
 * Partial, duplicate, out-of-order and malformed records are dropped; gaps are not filled,
 * so periods count observed sessions, not calendar days.
 */
export const completedBars = (history: readonly unknown[]): Bar[] => {
  const bars: Bar[] = [];
  for (const entry of history) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const bar = entry as Record<string, unknown>;
    const close = bar["close"];
    const date = bar["date"];
    if (bar["isPartial"] === true) continue;
    if (!(isFiniteNumber(close) && close > 0 && isCalendarDay(date))) continue;
    const previous = bars.at(-1);
    if (previous !== undefined && date <= previous.date) continue;
    const open = bar["open"];
    bars.push({
      close,
      date,
      open: isFiniteNumber(open) && open > 0 ? open : null,
    });
  }
  return bars;
};

/** Simple moving average; null until `period` values are present. */
const sma = (values: readonly number[], period: number): (number | null)[] => {
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period] as number;
    return index + 1 >= period ? total / period : null;
  });
};

const rocSeries = (
  values: readonly number[],
  period: number
): (number | null)[] =>
  values.map((value, index) =>
    index >= period
      ? (value / (values[index - period] as number) - 1) * 100
      : null
  );

export type RuleChecks = Readonly<{
  closeAboveSma: boolean | null;
  smaRising: boolean | null;
  rocNearZero: boolean | null;
  priorRocHigh: boolean | null;
}>;

export type RulePoint = Readonly<{
  date: string;
  close: number;
  sma: number | null;
  smaSlopeFrom: number | null;
  roc: number | null;
  priorRocPeak: number | null;
  known: boolean;
  checks: RuleChecks;
  signal: boolean;
}>;

const compare = <T>(
  value: T | null,
  test: (value: T) => boolean
): boolean | null => (value === null ? null : test(value));

/** Per-bar evaluation of the rule. Each point uses only bars at or before its own index. */
export const ruleSeries = (bars: readonly Bar[], rule: Rule): RulePoint[] => {
  const closes = bars.map((bar) => bar.close);
  const average = sma(closes, rule.smaPeriod);
  const roc = rocSeries(closes, rule.rocPeriod);
  const firstKnown = firstEvaluableIndex(rule);
  return bars.map((bar, index) => {
    const smaNow = average[index] ?? null;
    const smaThen =
      index >= rule.slopeLookback
        ? (average[index - rule.slopeLookback] ?? null)
        : null;
    const rocNow = roc[index] ?? null;
    const window = roc.slice(Math.max(0, index - rule.peakLookback), index);
    const priorRocPeak =
      index >= rule.rocPeriod + rule.peakLookback
        ? Math.max(...(window as number[]))
        : null;
    const checks: RuleChecks = {
      closeAboveSma: compare(smaNow, (value) => bar.close > value),
      priorRocHigh: compare(
        priorRocPeak,
        (value) => value >= rule.priorPeakMinPct
      ),
      rocNearZero: compare(
        rocNow,
        (value) => Math.abs(value) <= rule.resetBandPct
      ),
      smaRising: smaThen === null ? null : (smaNow as number) > smaThen,
    };
    const known = index >= firstKnown;
    return {
      checks,
      close: bar.close,
      date: bar.date,
      known,
      priorRocPeak,
      roc: rocNow,
      signal: known && Object.values(checks).every((value) => value === true),
      sma: smaNow,
      smaSlopeFrom: smaThen,
    };
  });
};

export type Fill = Readonly<{
  date: string;
  price: number;
  basis: "open" | "close";
}>;

const nextFill = (bar: Bar): Fill =>
  bar.open === null
    ? { basis: "close", date: bar.date, price: bar.close }
    : { basis: "open", date: bar.date, price: bar.open };

export type TradeState =
  | Readonly<{ state: "pending-entry"; signalDate: string }>
  | Readonly<{
      state: "open" | "pending-exit";
      signalDate: string;
      entry: Fill;
      heldSessions: number;
      mark: Readonly<{ date: string; close: number; returnPct: number }>;
      exitSignalDate: string | null;
    }>
  | Readonly<{
      state: "closed";
      signalDate: string;
      entry: Fill;
      heldSessions: number;
      exit: Fill & Readonly<{ reason: "close-below-sma" | "hold-period" }>;
      exitIndex: number;
      returnPct: number;
    }>;

const netReturnPct = (
  entry: number,
  exit: number,
  costBpsPerSide: number
): number => {
  const cost = costBpsPerSide / 10_000;
  return (((exit / entry) * (1 - cost)) / (1 + cost) - 1) * 100;
};

/**
 * Replays one trade from a signal at the close of bar `signalIndex`:
 * - entry at the open of the next bar (its close when the open is missing);
 * - a close below the SMA (the entry bar included) exits at the open of the following bar;
 * - otherwise the trade exits at the close of its `holdSessions`-th bar (entry bar = 1).
 * The paper book and the backtest both use this function, so their fills agree.
 */
export const simulateTrade = (
  bars: readonly Bar[],
  series: readonly RulePoint[],
  signalIndex: number,
  settings: BacktestSettings
): TradeState => {
  const signalDate = (bars[signalIndex] as Bar).date;
  const entryBar = bars[signalIndex + 1];
  if (entryBar === undefined) return { signalDate, state: "pending-entry" };
  const entry = nextFill(entryBar);
  let index = signalIndex + 1;
  for (; index < bars.length; index++) {
    const bar = bars[index] as Bar;
    const held = index - signalIndex;
    const average = (series[index] as RulePoint).sma;
    const exitBar = bars[index + 1];
    const belowSma = average !== null && bar.close < average;
    if (belowSma && exitBar !== undefined) {
      const exit = nextFill(exitBar);
      return closed(
        signalDate,
        entry,
        held,
        { ...exit, reason: "close-below-sma" },
        index + 1,
        settings
      );
    }
    if (belowSma)
      return marked("pending-exit", signalDate, entry, held, bar, bar.date);
    if (held >= settings.holdSessions) {
      const exit: Fill = { basis: "close", date: bar.date, price: bar.close };
      return closed(
        signalDate,
        entry,
        held,
        { ...exit, reason: "hold-period" },
        index,
        settings
      );
    }
  }
  const last = bars.at(-1) as Bar;
  return marked("open", signalDate, entry, index - signalIndex - 1, last, null);
};

const marked = (
  state: "open" | "pending-exit",
  signalDate: string,
  entry: Fill,
  heldSessions: number,
  bar: Bar,
  exitSignalDate: string | null
): TradeState => ({
  entry,
  exitSignalDate,
  heldSessions,
  mark: {
    close: bar.close,
    date: bar.date,
    returnPct: roundTo((bar.close / entry.price - 1) * 100) as number,
  },
  signalDate,
  state,
});

const closed = (
  signalDate: string,
  entry: Fill,
  heldSessions: number,
  exit: Fill & Readonly<{ reason: "close-below-sma" | "hold-period" }>,
  exitIndex: number,
  settings: BacktestSettings
): TradeState => ({
  entry,
  exit,
  exitIndex,
  heldSessions,
  returnPct: roundTo(
    netReturnPct(entry.price, exit.price, settings.costBpsPerSide)
  ) as number,
  signalDate,
  state: "closed",
});

export type TechnicalResult = Readonly<{
  agent: "technical";
  status: "unavailable" | "insufficient-data" | "evaluated";
  rule: Rule;
  sampleCount: number;
  requiredSamples: number;
  reason: string | null;
  barDate: string | null;
  staleDays: number | null;
  stale: boolean;
  close: number | null;
  sma: number | null;
  rocPct: number | null;
  priorRocPeakPct: number | null;
  checks: RuleChecks | null;
  signal: boolean;
}>;

/** Technical analyst agent: evaluates the rule on the latest completed bar at or before `asOf`. */
export const technicalAgent = (
  bars: readonly Bar[],
  series: readonly RulePoint[],
  {
    asOf,
    rule,
    maxStaleDays = 5,
  }: Readonly<{ asOf: string; rule: Rule; maxStaleDays?: number }>
): TechnicalResult => {
  const requiredSamples = firstEvaluableIndex(rule) + 1;
  const latest = series.at(-1);
  const base = {
    agent: "technical",
    requiredSamples,
    rule,
    sampleCount: bars.length,
  } as const;
  if (latest === undefined) {
    return {
      ...base,
      barDate: null,
      checks: null,
      close: null,
      priorRocPeakPct: null,
      reason: "No completed daily bars at or before the run date.",
      rocPct: null,
      signal: false,
      sma: null,
      stale: true,
      staleDays: null,
      status: "unavailable",
    };
  }
  const staleDays = daysBetween(latest.date, asOf);
  return {
    ...base,
    barDate: latest.date,
    checks: latest.checks,
    close: roundTo(latest.close),
    priorRocPeakPct: roundTo(latest.priorRocPeak),
    reason: latest.known
      ? null
      : `Rule needs ${requiredSamples} completed bars; ${bars.length} observed.`,
    rocPct: roundTo(latest.roc),
    signal: latest.signal,
    sma: roundTo(latest.sma),
    stale: staleDays > maxStaleDays,
    staleDays,
    status: latest.known ? "evaluated" : "insufficient-data",
  };
};

type ClosedTrade = Extract<TradeState, { state: "closed" }>;

export type BacktestResult = Readonly<{
  agent: "backtest";
  status: "insufficient-data" | "evaluated";
  settings: BacktestSettings;
  window: Readonly<{ start: string; end: string }> | null;
  closedTrades: number;
  openTrade: Exclude<TradeState, ClosedTrade> | null;
  winRatePct: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  compoundedReturnPct: number | null;
  maxClosedTradeDrawdownPct: number | null;
  buyHoldSameWindowPct: number | null;
  sampleSufficient: boolean;
  positiveExpectancy: boolean | null;
  trades: readonly ClosedTrade[];
  limits: string;
}>;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

const summarize = (returns: readonly number[]) => {
  if (returns.length === 0) {
    return {
      compoundedReturnPct: null,
      maxClosedTradeDrawdownPct: null,
      mean: null,
      meanReturnPct: null,
      medianReturnPct: null,
      winRatePct: null,
    };
  }
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, (equity / peak - 1) * 100);
  }
  const mean =
    returns.reduce((total, value) => total + value, 0) / returns.length;
  return {
    compoundedReturnPct: roundTo((equity - 1) * 100, 3),
    maxClosedTradeDrawdownPct: roundTo(drawdown, 3),
    mean,
    meanReturnPct: roundTo(mean, 3),
    medianReturnPct: roundTo(median(returns), 3),
    winRatePct: roundTo(
      (returns.filter((value) => value > 0).length / returns.length) * 100,
      2
    ),
  };
};

/**
 * Backtest agent: replays the rule on the completed bars with `simulateTrade`. After an exit, the
 * next signal may come no earlier than the bar after the exit bar. A trade still open at the end
 * is reported separately and is excluded from closed-trade statistics.
 * Results measure the underlying price move only: no dividends, option pricing, slippage model,
 * survivorship correction or out-of-sample split. They are a process check, not a forecast.
 */
export const backtestAgent = (
  bars: readonly Bar[],
  series: readonly RulePoint[],
  settings: BacktestSettings
): BacktestResult => {
  const trades: ClosedTrade[] = [];
  let openTrade: Exclude<TradeState, ClosedTrade> | null = null;
  for (let index = 0; index < bars.length && openTrade === null; index++) {
    if (!(series[index] as RulePoint).signal) continue;
    const trade = simulateTrade(bars, series, index, settings);
    if (trade.state === "closed") {
      trades.push(trade);
      index = trade.exitIndex;
    } else {
      openTrade = trade;
    }
  }
  const firstKnown = series.find((point) => point.known);
  const last = bars.at(-1);
  const stats = summarize(trades.map((trade) => trade.returnPct));
  const sampleSufficient = trades.length >= settings.minClosedTrades;
  return {
    agent: "backtest",
    buyHoldSameWindowPct:
      firstKnown === undefined
        ? null
        : roundTo(((last as Bar).close / firstKnown.close - 1) * 100, 3),
    closedTrades: trades.length,
    compoundedReturnPct: stats.compoundedReturnPct,
    limits:
      "Underlying open/close prices only; in-sample; no dividends, option pricing, taxes or survivorship correction. Not a forecast.",
    maxClosedTradeDrawdownPct: stats.maxClosedTradeDrawdownPct,
    meanReturnPct: stats.meanReturnPct,
    medianReturnPct: stats.medianReturnPct,
    openTrade,
    positiveExpectancy: sampleSufficient ? (stats.mean as number) > 0 : null,
    sampleSufficient,
    settings,
    status: firstKnown === undefined ? "insufficient-data" : "evaluated",
    trades: trades.slice(-10),
    window:
      firstKnown === undefined
        ? null
        : { end: (last as Bar).date, start: firstKnown.date },
    winRatePct: stats.winRatePct,
  };
};
