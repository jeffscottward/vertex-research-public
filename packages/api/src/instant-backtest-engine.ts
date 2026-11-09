// Instant backtest engine: a deterministic, single-pass columnar backtest over typed arrays.
// Research and paper use only. It simulates fills on stored bars and never creates orders.
//
// Model:
// - Long by default (short with `side`), fully invested while in a position (or sized by riskPct
//   or a leverage series), flat (cash, 0% yield) otherwise. An optional closeAt mask exits an open
//   position at a bar's close (market on close, intraday sessions).
// - Signals use only data up to and including the close of bar i. Signal fills happen at the open
//   of bar i + 1, so a run never uses a future price.
// - Stop-loss and take-profit levels are checked inside each bar from the fill bar on. A gap
//   through the level fills at the open. When both levels are inside one bar, the stop fills first.
// - Cost is charged in basis points of the traded value on each side (entry and exit).
// - An optional cost profile adds half the spread and slippage to each fill price, then charges
//   commission and fees in money for the initial capital. Entries buy the most units whose value
//   plus charges fit the cash; an entry whose minimum charges exceed the cash is skipped. ATR
//   slippage uses the ATR up to the bar before the fill.
// - Equity is marked at each close. Statistics use simple per-bar returns, a risk-free rate of 0
//   and the observed bar frequency (bars per elapsed year) for annualization.

import {
  affordableUnits,
  averageTrueRange,
  type CostProfile,
  fillCosts,
} from "./backtest-costs.ts";

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const BPS = 10_000;
const PERCENT = 100;

export type BarColumns = Readonly<{
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** Optional bar volume. Only the strategy DSL rvol indicator reads it. */
  v?: Float64Array;
}>;

export type SmaCrossRule = Readonly<{
  kind: "smaCross";
  fast: number;
  slow: number;
}>;

export type BreakoutRule = Readonly<{
  kind: "breakout";
  entryLookback: number;
  exitLookback: number;
  /** 0 turns the trend filter off. */
  trendSma: number;
}>;

/**
 * Mean reversion on Wilder RSI: entry (1) on every bar with RSI below `oversold`, exit (-1) on
 * every bar with RSI above `overbought`. Engine only; the oRPC contract does not expose it yet.
 */
export type RsiReversionRule = Readonly<{
  kind: "rsiReversion";
  period: number;
  oversold: number;
  overbought: number;
}>;

export type InstantRule = SmaCrossRule | BreakoutRule | RsiReversionRule;

export type InstantRunParams = Readonly<{
  rule: InstantRule;
  /** Percent below the entry price; 0 turns the stop off. */
  stopLossPct: number;
  /** Percent above the entry price; 0 turns the target off. */
  takeProfitPct: number;
  costBps: number;
  /** Optional cost profile; `capital` converts unit equity to money for the charges. */
  costs?: Readonly<{ profile: CostProfile; capital: number }>;
}>;

/** Costs of one trade in unit equity (starting equity 1), both legs together. */
export type InstantTradeCosts = Readonly<{
  commission: number;
  fees: number;
  spread: number;
  slippage: number;
  /** The flat `costBps` charge. */
  bps: number;
  total: number;
}>;

export type InstantTrade = Readonly<{
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  /** Units held, for starting equity 1 (multiply by the capital for real units). */
  units: number;
  /** Net return of the trade after both cost legs. */
  netReturn: number;
  /** Change in equity (starting equity 1) from entry to exit, after both cost legs. */
  pnl: number;
  exitReason: "signal" | "stop" | "target" | "end";
  /** Only when a cost profile is set: charges of both legs and the P&L before them. */
  costs?: InstantTradeCosts;
  grossPnl?: number;
}>;

export type InstantStats = Readonly<{
  bars: number;
  totalReturn: number;
  cagr: number | null;
  maxDrawdown: number;
  sharpe: number | null;
  sortino: number | null;
  trades: number;
  winRate: number | null;
  profitFactor: number | null;
  exposure: number;
  buyHoldReturn: number;
  buyHoldMaxDrawdown: number;
}>;

export type InstantRunResult = Readonly<{
  equity: Float64Array;
  trades: readonly InstantTrade[];
  stats: InstantStats;
}>;

export class InstantBacktestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstantBacktestInputError";
  }
}

/** Simple moving average of `values`; NaN until `length` values are available. */
export const rollingMean = (
  values: Float64Array,
  length: number
): Float64Array => {
  const out = new Float64Array(values.length).fill(Number.NaN);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] as number;
    if (index >= length) sum -= values[index - length] as number;
    if (index >= length - 1) out[index] = sum / length;
  }
  return out;
};

/**
 * Highest (`direction` 1) or lowest (`direction` -1) value of the `length` bars BEFORE each bar,
 * excluding the bar itself. NaN until `length` prior bars exist. O(n) with a monotonic deque.
 */
export const priorExtreme = (
  values: Float64Array,
  length: number,
  direction: 1 | -1
): Float64Array => {
  const size = values.length;
  const out = new Float64Array(size).fill(Number.NaN);
  const deque = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < size; index += 1) {
    while (head < tail && (deque[head] as number) < index - length) head += 1;
    if (index >= length) out[index] = values[deque[head] as number] as number;
    const value = (values[index] as number) * direction;
    while (
      head < tail &&
      (values[deque[tail - 1] as number] as number) * direction <= value
    ) {
      tail -= 1;
    }
    deque[tail] = index;
    tail += 1;
  }
  return out;
};

const rsiOf = (gain: number, loss: number): number =>
  gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);

/**
 * Wilder RSI (TA-Lib RSI): average gain and loss seeded with the mean of the first `period`
 * changes, then smoothed as (previous·(period−1)+change)/period. NaN until bar `period`.
 * A window without any change gives 50.
 */
export const wilderRsi = (
  values: Float64Array,
  period: number
): Float64Array => {
  const result = new Float64Array(values.length).fill(Number.NaN);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = (values[index] as number) - (values[index - 1] as number);
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  result[period] = rsiOf(gain, loss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = (values[index] as number) - (values[index - 1] as number);
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiOf(gain, loss);
  }
  return result;
};

const assertWindow = (name: string, value: number, max: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new InstantBacktestInputError(
      `${name} must be an integer from 1 to ${max}`
    );
  }
};

const assertColumns = (bars: BarColumns): number => {
  const size = bars.c.length;
  if (
    bars.t.length !== size ||
    bars.o.length !== size ||
    bars.h.length !== size ||
    bars.l.length !== size
  ) {
    throw new InstantBacktestInputError("Bar columns must have equal length");
  }
  if (size < 2) throw new InstantBacktestInputError("At least 2 bars needed");
  return size;
};

/**
 * Entry (1) only on the bar where the fast average moves above the slow one (the first bar with
 * both averages counts when fast is already above). Exit (-1) on every bar with fast <= slow.
 * After a stop or target exit, the rule waits for the next cross up instead of buying again.
 */
const smaCrossSignals = (
  bars: BarColumns,
  rule: SmaCrossRule,
  size: number
): Int8Array => {
  assertWindow("fast", rule.fast, size);
  assertWindow("slow", rule.slow, size);
  if (rule.fast >= rule.slow) {
    throw new InstantBacktestInputError("fast must be shorter than slow");
  }
  const signals = new Int8Array(size);
  const fast = rollingMean(bars.c, rule.fast);
  const slow = rollingMean(bars.c, rule.slow);
  let wasAbove = false;
  for (let index = 0; index < size; index += 1) {
    const slowValue = slow[index] as number;
    if (Number.isNaN(slowValue)) continue;
    const above = (fast[index] as number) > slowValue;
    if (!above) signals[index] = -1;
    else if (!wasAbove) signals[index] = 1;
    wasAbove = above;
  }
  return signals;
};

/** Entry (1) above the prior high (and the trend average), exit (-1) below the prior low. */
const breakoutSignals = (
  bars: BarColumns,
  rule: BreakoutRule,
  size: number
): Int8Array => {
  assertWindow("entryLookback", rule.entryLookback, size);
  assertWindow("exitLookback", rule.exitLookback, size);
  if (rule.trendSma !== 0) assertWindow("trendSma", rule.trendSma, size);
  const signals = new Int8Array(size);
  const highs = priorExtreme(bars.h, rule.entryLookback, 1);
  const lows = priorExtreme(bars.l, rule.exitLookback, -1);
  const trend = rule.trendSma === 0 ? null : rollingMean(bars.c, rule.trendSma);
  for (let index = 0; index < size; index += 1) {
    const close = bars.c[index] as number;
    if (close < (lows[index] as number)) {
      signals[index] = -1;
      continue;
    }
    const trendValue = trend === null ? Number.NEGATIVE_INFINITY : trend[index];
    if (close > (highs[index] as number) && close > (trendValue as number)) {
      signals[index] = 1;
    }
  }
  return signals;
};

const rsiReversionSignals = (
  bars: BarColumns,
  rule: RsiReversionRule,
  size: number
): Int8Array => {
  assertWindow("period", rule.period, size - 1);
  const level = (name: string, value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new InstantBacktestInputError(`${name} must be from 0 to 100`);
    }
  };
  level("oversold", rule.oversold);
  level("overbought", rule.overbought);
  if (rule.oversold >= rule.overbought) {
    throw new InstantBacktestInputError("oversold must be below overbought");
  }
  const signals = new Int8Array(size);
  const rsi = wilderRsi(bars.c, rule.period);
  for (let index = rule.period; index < size; index += 1) {
    const value = rsi[index] as number;
    if (value < rule.oversold) signals[index] = 1;
    else if (value > rule.overbought) signals[index] = -1;
  }
  return signals;
};

export const signalsFor = (
  bars: BarColumns,
  rule: InstantRule,
  size: number
): Int8Array => {
  switch (rule.kind) {
    case "smaCross":
      return smaCrossSignals(bars, rule, size);
    case "breakout":
      return breakoutSignals(bars, rule, size);
    case "rsiReversion":
      return rsiReversionSignals(bars, rule, size);
  }
};

const assertParams = (params: InstantRunParams): void => {
  const percent = (name: string, value: number, max: number) => {
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new InstantBacktestInputError(`${name} must be from 0 to ${max}`);
    }
  };
  percent("stopLossPct", params.stopLossPct, 99);
  percent("takeProfitPct", params.takeProfitPct, 10_000);
  percent("costBps", params.costBps, 500);
  if (params.costs !== undefined) {
    const capital = params.costs.capital;
    if (!Number.isFinite(capital) || capital <= 0) {
      throw new InstantBacktestInputError("capital must be above 0");
    }
  }
};

interface Legs {
  bps: number;
  commission: number;
  fees: number;
  slippage: number;
  spread: number;
}

interface PositionState {
  entryCash: number;
  entryIndex: number;
  entryPrice: number;
  /** Stop set at entry, and the highest high and close since entry (stop management). */
  initialStop: number;
  legs: Legs | null;
  maxClose: number;
  maxHigh: number;
  /** Cash not used by the position (0 when fully invested). */
  rest: number;
  /** Cash committed to the position, including the entry costs. */
  spent: number;
  /** Stop and target price levels; NaN when off. */
  stop: number;
  target: number;
  units: number;
}

const drawdownOf = (series: Float64Array): number => {
  let peak = series[0] as number;
  let worst = 0;
  for (const value of series) {
    if (value > peak) peak = value;
    const drawdown = value / peak - 1;
    if (drawdown < worst) worst = drawdown;
  }
  return worst;
};

const ratioStats = (
  equity: Float64Array,
  years: number
): Pick<InstantStats, "sharpe" | "sortino"> => {
  const periods = equity.length - 1;
  let sum = 0;
  let downsideSquares = 0;
  for (let index = 1; index <= periods; index += 1) {
    const change =
      (equity[index] as number) / (equity[index - 1] as number) - 1;
    sum += change;
    if (change < 0) downsideSquares += change * change;
  }
  const mean = sum / periods;
  let squares = 0;
  for (let index = 1; index <= periods; index += 1) {
    const change =
      (equity[index] as number) / (equity[index - 1] as number) - 1;
    squares += (change - mean) * (change - mean);
  }
  const annualizer = years > 0 ? Math.sqrt(periods / years) : 0;
  const deviation = periods > 1 ? Math.sqrt(squares / (periods - 1)) : 0;
  const downside = Math.sqrt(downsideSquares / periods);
  return {
    sharpe:
      deviation > 0 && annualizer > 0 ? (mean / deviation) * annualizer : null,
    sortino:
      downside > 0 && annualizer > 0 ? (mean / downside) * annualizer : null,
  };
};

/**
 * Run statistics from the unit equity series and the trades. Exported so the API can recompute
 * the statistics of a result from another engine (the Nautilus worker) instead of trusting them.
 */
export const summarize = (
  bars: BarColumns,
  equity: Float64Array,
  trades: readonly InstantTrade[],
  barsInPosition: number
): InstantStats => {
  const size = equity.length;
  const first = equity[0] as number;
  const last = equity[size - 1] as number;
  const years =
    ((bars.t[size - 1] as number) - (bars.t[0] as number)) / YEAR_MS;
  // Profit factor uses equity P&L per trade, so later trades on a larger account weigh more.
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const trade of trades) {
    if (trade.pnl > 0) {
      wins += 1;
      grossWin += trade.pnl;
    } else {
      grossLoss -= trade.pnl;
    }
  }
  // A very short series can make the annualized growth overflow; report it as not available.
  const growth = years > 0 ? (last / first) ** (1 / years) - 1 : Number.NaN;
  return {
    bars: size,
    cagr: Number.isFinite(growth) ? growth : null,
    maxDrawdown: drawdownOf(equity),
    totalReturn: last / first - 1,
    ...ratioStats(equity, years),
    buyHoldMaxDrawdown: drawdownOf(bars.c),
    buyHoldReturn: (bars.c[size - 1] as number) / (bars.c[0] as number) - 1,
    exposure: barsInPosition / size,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    trades: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : null,
  };
};

/**
 * Bars that end with an open position (the `barsInPosition` of summarize), from the trades of a
 * finished run. Trades never overlap. A trade holds from its entry bar to the bar before its exit
 * bar (an exit fills during the bar); a trade closed after the last bar (`end`) holds that bar too.
 */
export const barsInPositionOf = (trades: readonly InstantTrade[]): number =>
  trades.reduce(
    (total, trade) =>
      total +
      trade.exitIndex -
      trade.entryIndex +
      (trade.exitReason === "end" ? 1 : 0),
    0
  );

/**
 * A stop or target level: entry ± a distance (above when `above`), else entry × a percent factor
 * (NaN when the factor is 0, no level).
 */
const levelAt = (
  entryPrice: number,
  distance: number | undefined,
  factor: number,
  above: boolean
): number => {
  if (distance === undefined)
    return factor > 0 ? entryPrice * factor : Number.NaN;
  return above ? entryPrice + distance : entryPrice - distance;
};

/** Runs one backtest. Starting equity is 1. Throws InstantBacktestInputError on bad input. */
export const runInstantBacktest = (
  bars: BarColumns,
  params: InstantRunParams
): InstantRunResult => {
  const size = assertColumns(bars);
  assertParams(params);
  const signals = signalsFor(bars, params.rule, size);
  return runSignalBacktest(bars, signals, {
    costBps: params.costBps,
    stopLossPct: params.stopLossPct,
    takeProfitPct: params.takeProfitPct,
    ...(params.costs === undefined ? {} : { costs: params.costs }),
  });
};

export type SignalRunOptions = Readonly<{
  costBps: number;
  /** Percent below the entry price; 0 turns the percent stop off. */
  stopLossPct: number;
  /** Percent above the entry price; 0 turns the percent target off. */
  takeProfitPct: number;
  /** Optional cost profile; `capital` converts unit equity to money for the charges. */
  costs?: NonNullable<InstantRunParams["costs"]>;
  /**
   * Price distance below the entry price for the stop, read at the signal bar. Replaces the
   * percent stop. A missing value (NaN or not above 0) on the signal bar blocks that entry.
   */
  stopDistance?: Float64Array;
  /** Price distance above the entry price for the target, read at the signal bar. Replaces the percent target. */
  targetDistance?: Float64Array;
  /** Bars (1) on which to exit while in a position, in addition to -1 signals. */
  exits?: Uint8Array;
  /**
   * Percent of equity to lose when the stop fills, before costs and gaps. Undefined means fully
   * invested. Needs a stop; the position is capped at the available cash.
   */
  riskPct?: number;
  /**
   * Time exit: once a position has been held this many bars (the fill bar counts as one), it exits
   * at the next open as a signal exit. Undefined means no time limit.
   */
  maxHoldBars?: number;
  /**
   * With riskPct: the position cost is capped at cash × maxLeverage instead of the cash (1 to 50).
   * The borrowed part makes the unused cash negative; no financing is charged. A gap can then
   * take equity to 0 or below: see the ruin rule of runSignalBacktest.
   */
  maxLeverage?: number;
  /** Stop management of the open position (see PositionManagement). Long positions only. */
  management?: PositionManagement;
  /**
   * "short" sells at the entry and buys back at the exit: P&L = units × (entry - exit), the
   * percent and distance stops sit above the entry and the targets below it, a bar whose high
   * reaches the stop exits there (stop first, a gap fills at the open) and riskPct sizes by the
   * stop distance above the entry. Undefined means long.
   */
  side?: "long" | "short";
  /**
   * Market on close: at the close of a bar with 1, an open position exits at that close (reason
   * "signal", costs as for any fill), and that bar takes no entry signal.
   */
  closeAt?: Uint8Array;
  /**
   * Volatility-target sizing: the position cost is cash × leverage, read at the signal bar (above
   * 1 borrows like maxLeverage). A missing value (NaN or not above 0) blocks that entry. Excludes
   * riskPct.
   */
  leverage?: Float64Array;
}>;

/**
 * Moves the stop of an open position up at the close of every bar it is open (the entry bar
 * included), after that bar's stop and target check, with R = entry price - initial stop (> 0).
 * breakevenR: once the highest high since entry reaches entry + breakevenR × R, stop = max(stop,
 * entry). trail: once the highest high reaches entry + activateR × R, stop = max(stop, highest
 * close since entry - multiple × atr[i]); a NaN ATR leaves the stop. The new stop applies from the
 * next bar. Without a stop (NaN) nothing moves.
 */
export type PositionManagement = Readonly<{
  breakevenR?: number;
  trail?: Readonly<{ activateR: number; multiple: number; atr: Float64Array }>;
}>;

const assertSignalOptions = (
  size: number,
  signals: Int8Array,
  options: SignalRunOptions
): void => {
  if (signals.length !== size) {
    throw new InstantBacktestInputError("Signals must match the bar count");
  }
  assertParams({ ...options, rule: { fast: 1, kind: "smaCross", slow: 2 } });
  const { maxHoldBars, riskPct } = options;
  if (
    riskPct !== undefined &&
    !(Number.isFinite(riskPct) && riskPct > 0 && riskPct <= 100)
  ) {
    throw new InstantBacktestInputError(
      "riskPct must be above 0 and at most 100"
    );
  }
  if (
    maxHoldBars !== undefined &&
    !(Number.isInteger(maxHoldBars) && maxHoldBars >= 1)
  ) {
    throw new InstantBacktestInputError(
      "maxHoldBars must be a whole number of at least 1"
    );
  }
  assertManagementOptions(size, options);
  assertSideOptions(size, options);
};

const positive = (name: string, value: number | undefined): void => {
  if (value !== undefined && !(Number.isFinite(value) && value > 0))
    throw new InstantBacktestInputError(`${name} must be above 0`);
};

/** Checks maxLeverage (needs riskPct, 1 to 50) and the management levels and ATR length. */
const assertManagementOptions = (
  size: number,
  options: SignalRunOptions
): void => {
  const { management, maxLeverage } = options;
  if (maxLeverage !== undefined) {
    if (options.riskPct === undefined)
      throw new InstantBacktestInputError("maxLeverage needs riskPct");
    if (!(maxLeverage >= 1 && maxLeverage <= 50))
      throw new InstantBacktestInputError("maxLeverage must be from 1 to 50");
  }
  positive("breakevenR", management?.breakevenR);
  const trail = management?.trail;
  if (trail === undefined) return;
  positive("trail activateR", trail.activateR);
  positive("trail multiple", trail.multiple);
  if (trail.atr.length !== size)
    throw new InstantBacktestInputError("trail ATR must match the bar count");
};

/** Checks the side (short: no management, a target below 100%) and the closeAt and leverage arrays. */
const assertSideOptions = (size: number, options: SignalRunOptions): void => {
  const { closeAt, leverage, side } = options;
  if (side !== undefined && side !== "long" && side !== "short")
    throw new InstantBacktestInputError("side must be long or short");
  if (side === "short") {
    if (options.management !== undefined)
      throw new InstantBacktestInputError(
        "management raises a long stop; a short position takes none"
      );
    if (options.takeProfitPct >= PERCENT)
      throw new InstantBacktestInputError(
        "takeProfitPct must be below 100 for a short position"
      );
  }
  if (closeAt !== undefined && closeAt.length !== size)
    throw new InstantBacktestInputError("closeAt must match the bar count");
  if (leverage === undefined) return;
  if (leverage.length !== size)
    throw new InstantBacktestInputError("leverage must match the bar count");
  if (options.riskPct !== undefined)
    throw new InstantBacktestInputError("leverage sizing excludes riskPct");
};

/** Distance at the signal bar; NaN when missing or not above 0. */
const distanceAt = (series: Float64Array | undefined, index: number) => {
  const value = series === undefined ? Number.NaN : (series[index] as number);
  return value > 0 ? value : Number.NaN;
};

/**
 * Runs the fill and accounting model over precomputed signals: 1 enters while flat, -1 exits while
 * in a position, 0 does nothing. Signals act at the open of the next bar. Ruin rule: when equity
 * marked at a bar's close (cash, or unused cash + units × close in a position) is at or below 0,
 * an open position exits at that close (reason "stop") and the run takes no further entries. A
 * short position keeps the sale proceeds in its unused cash and is marked at unused cash - units ×
 * close.
 */
export const runSignalBacktest = (
  bars: BarColumns,
  signals: Int8Array,
  options: SignalRunOptions
): InstantRunResult => {
  const size = assertColumns(bars);
  assertSignalOptions(size, signals, options);
  const cost = options.costBps / BPS;
  const short = options.side === "short";
  // A long stop sits below the entry and its target above; a short one the other way round.
  const stopFactor =
    options.stopLossPct > 0
      ? short
        ? 1 + options.stopLossPct / PERCENT
        : 1 - options.stopLossPct / PERCENT
      : 0;
  const targetFactor =
    options.takeProfitPct > 0
      ? short
        ? 1 - options.takeProfitPct / PERCENT
        : 1 + options.takeProfitPct / PERCENT
      : 0;
  const equity = new Float64Array(size);
  const trades: InstantTrade[] = [];
  let cash = 1;
  let position: PositionState | null = null;
  let pending: 1 | -1 | 0 = 0;
  /** Set once equity marked at a close falls to 0 or below (see the ruin rule below). */
  let ruined = false;
  let pendingStop = Number.NaN;
  let pendingTarget = Number.NaN;
  let pendingLeverage = Number.NaN;
  let barsInPosition = 0;
  const costs = options.costs ?? null;
  const slip = costs?.profile.slippage;
  const atr =
    slip?.kind === "atr"
      ? averageTrueRange(bars.h, bars.l, bars.c, slip.period)
      : null;
  const atrBefore = (index: number): number =>
    atr === null || index === 0 ? Number.NaN : (atr[index - 1] as number);
  /** Equity with an open position at `price`: a short owes its units back. */
  const markOf = (held: PositionState, price: number): number =>
    short ? held.rest - held.units * price : held.rest + held.units * price;

  const exitPosition = (
    index: number,
    price: number,
    reason: InstantTrade["exitReason"]
  ) => {
    const open = position as PositionState;
    let fill = price;
    let legs: Legs | null = null;
    // A long sells its units; a short buys them back, so its proceeds are below 0.
    let proceeds: number;
    if (costs === null || open.legs === null) {
      proceeds = short
        ? -(open.units * price * (1 + cost))
        : open.units * price * (1 - cost);
    } else {
      const { capital, profile } = costs;
      const order = fillCosts(
        profile,
        short ? "buy" : "sell",
        open.units * capital,
        price,
        atrBefore(index)
      );
      fill = order.price;
      proceeds =
        (short
          ? -(open.units * fill * (1 + cost))
          : open.units * fill * (1 - cost)) -
        (order.commission + order.fees) / capital;
      legs = {
        bps: open.legs.bps + open.units * fill * cost,
        commission: open.legs.commission + order.commission / capital,
        fees: open.legs.fees + order.fees / capital,
        slippage: open.legs.slippage + order.slippage / capital,
        spread: open.legs.spread + order.spread / capital,
      };
    }
    cash = open.rest + proceeds;
    const pnl = cash - open.entryCash;
    const total =
      legs === null
        ? 0
        : legs.commission + legs.fees + legs.spread + legs.slippage + legs.bps;
    trades.push({
      entryIndex: open.entryIndex,
      entryPrice: open.entryPrice,
      exitIndex: index,
      exitPrice: fill,
      exitReason: reason,
      netReturn: short ? pnl / open.spent : proceeds / open.spent - 1,
      pnl,
      units: open.units,
      ...(legs === null
        ? {}
        : { costs: { ...legs, total }, grossPnl: pnl + total }),
    });
    position = null;
  };

  /**
   * Cash to commit: all of it, cash × leverage (volatility target), or the amount that loses
   * riskPct of equity at the stop, capped at the cash (times maxLeverage when set).
   */
  const spendFor = (open: number, stop: number): number => {
    if (options.leverage !== undefined) return cash * pendingLeverage;
    if (options.riskPct === undefined) return cash;
    const perUnit = short ? stop - open : open - stop;
    if (!(perUnit > 0)) return 0;
    const riskUnits = (cash * options.riskPct) / PERCENT / perUnit;
    const cap =
      options.maxLeverage === undefined ? cash : cash * options.maxLeverage;
    return Math.min(cap, (riskUnits * open) / (1 - cost));
  };

  const enter = (index: number, open: number) => {
    // A configured distance level or leverage that is not available yet (too few bars) blocks
    // the entry, so a position never opens without the stop, target or size the strategy asked for.
    if (
      (options.stopDistance !== undefined && Number.isNaN(pendingStop)) ||
      (options.targetDistance !== undefined && Number.isNaN(pendingTarget)) ||
      (options.leverage !== undefined && Number.isNaN(pendingLeverage))
    )
      return;
    const levels = (entryPrice: number) => ({
      stop: levelAt(
        entryPrice,
        options.stopDistance === undefined ? undefined : pendingStop,
        stopFactor,
        short
      ),
      target: levelAt(
        entryPrice,
        options.targetDistance === undefined ? undefined : pendingTarget,
        targetFactor,
        !short
      ),
    });
    if (costs === null) {
      const { stop, target } = levels(open);
      const spent = spendFor(open, stop);
      if (spent <= 0) return;
      const units = (spent * (1 - cost)) / open;
      position = {
        entryCash: cash,
        entryIndex: index,
        entryPrice: open,
        initialStop: stop,
        legs: null,
        maxClose: Number.NEGATIVE_INFINITY,
        maxHigh: Number.NEGATIVE_INFINITY,
        // A short keeps the sale proceeds, less the flat cost, as unused cash.
        rest: short ? cash + units * open - spent * cost : cash - spent,
        spent,
        stop,
        target,
        units,
      };
      return;
    }
    const { capital, profile } = costs;
    const atrNow = atrBefore(index);
    const side = short ? "sell" : "buy";
    const quote = fillCosts(profile, side, 0, open, atrNow);
    const quoted = levels(quote.price);
    const spent = spendFor(quote.price, quoted.stop);
    // A short is sized like a long of the same notional.
    const units = affordableUnits(
      profile,
      spent * (1 - cost),
      quote.price,
      capital
    );
    if (!(units > 0)) return;
    const order = fillCosts(profile, side, units * capital, open, atrNow);
    const level = levels(order.price);
    position = {
      entryCash: cash,
      entryIndex: index,
      entryPrice: order.price,
      initialStop: level.stop,
      legs: {
        bps: spent * cost,
        commission: order.commission / capital,
        fees: order.fees / capital,
        slippage: order.slippage / capital,
        spread: order.spread / capital,
      },
      maxClose: Number.NEGATIVE_INFINITY,
      maxHigh: Number.NEGATIVE_INFINITY,
      rest: short
        ? cash +
          units * order.price -
          spent * cost -
          (order.commission + order.fees) / capital
        : cash - spent,
      spent,
      units,
      ...level,
    };
  };

  const management = options.management;
  /** Stop management at the close of bar `index` (see PositionManagement). */
  const manage = (index: number) => {
    const held = position;
    if (held === null || management === undefined) return;
    const { breakevenR, trail } = management;
    // A NaN price is skipped, here and in the Python engine.
    const high = bars.h[index] as number;
    const close = bars.c[index] as number;
    if (!Number.isNaN(high)) held.maxHigh = Math.max(held.maxHigh, high);
    if (!Number.isNaN(close)) held.maxClose = Math.max(held.maxClose, close);
    const risk = held.entryPrice - held.initialStop;
    if (!(risk > 0)) return;
    if (
      breakevenR !== undefined &&
      held.maxHigh >= held.entryPrice + breakevenR * risk
    )
      held.stop = Math.max(held.stop, held.entryPrice);
    if (
      trail !== undefined &&
      held.maxHigh >= held.entryPrice + trail.activateR * risk
    ) {
      const trailAtr = trail.atr[index] as number;
      if (!Number.isNaN(trailAtr))
        held.stop = Math.max(
          held.stop,
          held.maxClose - trail.multiple * trailAtr
        );
    }
  };

  /** Stop first: a bar reaching the stop exits there (at the open on a gap), else at the target. */
  const checkLevels = (index: number, open: number, held: PositionState) => {
    const high = bars.h[index] as number;
    const low = bars.l[index] as number;
    if (short) {
      if (!Number.isNaN(held.stop) && high >= held.stop)
        exitPosition(index, Math.max(open, held.stop), "stop");
      else if (!Number.isNaN(held.target) && low <= held.target)
        exitPosition(index, Math.min(open, held.target), "target");
      return;
    }
    if (!Number.isNaN(held.stop) && low <= held.stop)
      exitPosition(index, Math.min(open, held.stop), "stop");
    else if (!Number.isNaN(held.target) && high >= held.target)
      exitPosition(index, Math.max(open, held.target), "target");
  };

  for (let index = 0; index < size; index += 1) {
    const open = bars.o[index] as number;
    // A pending entry exists only while flat and a pending exit only while in a position.
    if (pending === 1) enter(index, open);
    else if (pending === -1) exitPosition(index, open, "signal");
    pending = 0;
    if (position !== null) checkLevels(index, open, position);
    manage(index);
    // Ruin: equity marked at the close at or below 0 (possible with maxLeverage, usually after a
    // gap through the stop) ends trading: an open position exits at that close as a stop, and
    // the run takes no further entries.
    const close = bars.c[index] as number;
    const marked = position === null ? cash : markOf(position, close);
    if (marked <= 0) {
      if (position !== null) exitPosition(index, close, "stop");
      ruined = true;
    }
    // Market on close: the bar is held, then the position exits at its close.
    const closing = options.closeAt?.[index] === 1;
    if (closing && position !== null) {
      barsInPosition += 1;
      exitPosition(index, close, "signal");
    }
    const signal = signals[index] as number;
    if (index < size - 1) {
      if (signal === 1 && position === null && !ruined && !closing) {
        pending = 1;
        pendingStop = distanceAt(options.stopDistance, index);
        pendingTarget = distanceAt(options.targetDistance, index);
        pendingLeverage = distanceAt(options.leverage, index);
      }
      // A time exit counts the fill bar as the first bar held.
      if (
        position !== null &&
        (signal === -1 ||
          options.exits?.[index] === 1 ||
          (options.maxHoldBars !== undefined &&
            index - (position as PositionState).entryIndex + 1 >=
              options.maxHoldBars))
      )
        pending = -1;
    }
    if (position !== null) barsInPosition += 1;
    equity[index] = position === null ? cash : markOf(position, close);
  }
  if (position !== null) {
    exitPosition(size - 1, bars.c[size - 1] as number, "end");
    equity[size - 1] = cash;
  }
  return {
    equity,
    stats: summarize(bars, equity, trades, barsInPosition),
    trades,
  };
};

/**
 * Reduces a series to at most `maxPoints` indexes for charting: the last bar of each equal-size
 * bucket, always including the first and last bar. Statistics never use the reduced series.
 */
export const downsampleIndexes = (
  size: number,
  maxPoints: number
): number[] => {
  if (maxPoints < 2) throw new RangeError("maxPoints must be at least 2");
  if (size <= maxPoints) return Array.from({ length: size }, (_, i) => i);
  const bucket = Math.ceil((size - 1) / (maxPoints - 1));
  const indexes = [0];
  for (let index = bucket; index < size - 1; index += bucket) {
    indexes.push(index);
  }
  indexes.push(size - 1);
  return indexes;
};
