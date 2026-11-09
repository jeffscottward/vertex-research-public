import {
  type BarColumns,
  InstantBacktestInputError,
  type InstantRunResult,
  type PositionManagement,
  priorExtreme,
  rollingMean,
  runSignalBacktest,
  type SignalRunOptions,
} from "./instant-backtest-engine.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  type CalendarWindowFilter,
  type IvRankFilter,
  type SectorQuadrantFilter,
  type SeriesFilter,
  STRATEGY_CALENDAR_INTRADAY_REFUSAL,
  STRATEGY_IV_INDEX,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyExpr,
  type StrategyManagement,
  type StrategyOptions,
  type StrategyPortfolio,
  type StrategyRefusal,
  type StrategySeriesReader,
  type StrategySeriesRef,
  type StrategyServerSupport,
  resolveStrategySeries,
  serverStrategyRefusal,
  type VolRegimeFilter,
} from "./strategy-dsl.ts";

// Compiles a validated strategy definition to engine signals and runs it. Indicator values are NaN
// until enough bars exist; any comparison with NaN is false. highest and lowest use the bars
// BEFORE the signal bar (a Donchian channel), so "close > highest(high, 20)" is a breakout.

const FIELD_KEY = { close: "c", high: "h", low: "l", open: "o" } as const;
const MINUTES_PER_DAY = 1440;
const MINUTE_MS = 60_000;

/** Exponential average seeded with the simple average of the first `length` values. */
export const exponentialMean = (
  values: Float64Array,
  length: number
): Float64Array => {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (values.length < length) return out;
  const alpha = 2 / (length + 1);
  let value = 0;
  for (let index = 0; index < length; index += 1)
    value += values[index] as number;
  value /= length;
  out[length - 1] = value;
  for (let index = length; index < values.length; index += 1) {
    value += alpha * ((values[index] as number) - value);
    out[index] = value;
  }
  return out;
};

/** Wilder smoothing: simple average seed, then value += (x - value) / length. Starts at `offset`. */
const wilder = (
  values: Float64Array,
  length: number,
  offset: number
): Float64Array => {
  const out = new Float64Array(values.length).fill(Number.NaN);
  const seedEnd = offset + length;
  if (values.length < seedEnd) return out;
  let value = 0;
  for (let index = offset; index < seedEnd; index += 1)
    value += values[index] as number;
  value /= length;
  out[seedEnd - 1] = value;
  for (let index = seedEnd; index < values.length; index += 1) {
    value += ((values[index] as number) - value) / length;
    out[index] = value;
  }
  return out;
};

/** Wilder RSI (0 to 100). 100 when there are no losses in the window. */
export const relativeStrength = (
  values: Float64Array,
  length: number
): Float64Array => {
  const size = values.length;
  const gains = new Float64Array(size);
  const losses = new Float64Array(size);
  for (let index = 1; index < size; index += 1) {
    const change = (values[index] as number) - (values[index - 1] as number);
    gains[index] = change > 0 ? change : 0;
    losses[index] = change < 0 ? -change : 0;
  }
  const up = wilder(gains, length, 1);
  const down = wilder(losses, length, 1);
  const out = new Float64Array(size).fill(Number.NaN);
  for (let index = 0; index < size; index += 1) {
    const loss = down[index] as number;
    if (Number.isNaN(loss)) continue;
    out[index] =
      loss === 0 ? 100 : 100 - 100 / (1 + (up[index] as number) / loss);
  }
  return out;
};

/** Exact two-pass mean and sum of squared deviations of values[start..end]. */
const exactWindow = (
  values: Float64Array,
  start: number,
  end: number
): readonly [average: number, squares: number] => {
  let sum = 0;
  for (let at = start; at <= end; at += 1) sum += values[at] as number;
  const average = sum / (end - start + 1);
  let squares = 0;
  for (let at = start; at <= end; at += 1) {
    const delta = (values[at] as number) - average;
    squares += delta * delta;
  }
  return [average, squares];
};

/** Welford update of a sliding window: `incoming` replaces `outgoing`. */
const slideWindow = (
  average: number,
  squares: number,
  incoming: number,
  outgoing: number,
  length: number
): readonly [average: number, squares: number] => {
  const next = average + (incoming - outgoing) / length;
  return [
    next,
    Math.max(
      0,
      squares + (incoming - outgoing) * (incoming - next + outgoing - average)
    ),
  ];
};

/**
 * Mean and sample standard deviation (ddof 1) of each full window of `length` values, NaN before
 * bar `length - 1` and for a window with a value that is not finite. Sliding Welford update with an
 * exact two-pass recompute every `length` bars (and after a gap), so rounding drift stays bounded:
 * O(bars). A flat window (all values equal) has deviation exactly 0.
 */
const rollingMoments = (
  values: Float64Array,
  length: number
): Readonly<{ mean: Float64Array; deviation: Float64Array }> => {
  const size = values.length;
  const mean = new Float64Array(size).fill(Number.NaN);
  const deviation = new Float64Array(size).fill(Number.NaN);
  let bad = 0; // values in the window that are not finite
  let run = 0; // equal values ending at the bar
  let state: readonly [average: number, squares: number] | undefined; // previous window
  for (let index = 0; index < size; index += 1) {
    const value = values[index] as number;
    if (!Number.isFinite(value)) bad += 1;
    if (index >= length && !Number.isFinite(values[index - length] as number))
      bad -= 1;
    run = index > 0 && value === values[index - 1] ? run + 1 : 1;
    if (index < length - 1) continue;
    if (bad > 0) {
      state = undefined;
      continue;
    }
    const start = index - length + 1;
    state =
      state === undefined || start % length === 0
        ? exactWindow(values, start, index)
        : slideWindow(
            state[0],
            state[1],
            value,
            values[index - length] as number,
            length
          );
    const flat = run >= length;
    mean[index] = flat ? value : state[0];
    deviation[index] = flat ? 0 : Math.sqrt(state[1] / (length - 1));
  }
  return { deviation, mean };
};

/**
 * Rolling z-score (gs-quant `zscores`): (x - mean) / sample deviation of the `length` values ending
 * at the bar, the bar included. NaN before bar `length - 1` and for a flat window.
 */
export const rollingZScore = (
  values: Float64Array,
  length: number
): Float64Array => {
  const { mean, deviation } = rollingMoments(values, length);
  const out = new Float64Array(values.length).fill(Number.NaN);
  for (let index = length - 1; index < values.length; index += 1) {
    const spread = deviation[index] as number;
    if (spread > 0)
      out[index] =
        ((values[index] as number) - (mean[index] as number)) / spread;
  }
  return out;
};

/** Bars per year used to annualize realizedVol (daily bars). */
export const REALIZED_VOL_PERIODS_PER_YEAR = 252;

/**
 * Annualized realized volatility in percent (gs-quant `volatility`): sample deviation of the
 * `length` simple returns ending at the bar × √252 × 100. NaN before bar `length` and when a
 * window contains a return from a non-positive price.
 */
export const realizedVolatility = (
  values: Float64Array,
  length: number
): Float64Array => {
  const size = values.length;
  const out = new Float64Array(size).fill(Number.NaN);
  const returns = new Float64Array(size).fill(Number.NaN);
  for (let index = 1; index < size; index += 1) {
    const previous = values[index - 1] as number;
    const current = values[index] as number;
    if (previous > 0 && current > 0) returns[index] = current / previous - 1;
  }
  const scale = 100 * Math.sqrt(REALIZED_VOL_PERIODS_PER_YEAR);
  const { deviation } = rollingMoments(returns, length);
  for (let index = length; index < size; index += 1)
    out[index] = scale * (deviation[index] as number);
  return out;
};

/** Wilder average true range. The first bar's true range is high - low. */
export const averageTrueRange = (
  bars: BarColumns,
  length: number
): Float64Array => {
  const size = bars.c.length;
  const ranges = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const high = bars.h[index] as number;
    const low = bars.l[index] as number;
    if (index === 0) {
      ranges[index] = high - low;
      continue;
    }
    const previous = bars.c[index - 1] as number;
    ranges[index] = Math.max(
      high - low,
      Math.abs(high - previous),
      Math.abs(low - previous)
    );
  }
  return wilder(ranges, length, 0);
};

/** Wilder ADX line with TA-Lib smoothing. DX is 0 when +DI and -DI are both 0. */
export const averageDirectionalIndex = (
  bars: BarColumns,
  length: number
): Float64Array => {
  const size = bars.c.length;
  const out = new Float64Array(size).fill(Number.NaN);
  let plusSum = 0;
  let minusSum = 0;
  let rangeSum = 0;
  let dxTotal = 0;
  let average = Number.NaN;
  for (let index = 1; index < size; index += 1) {
    const high = bars.h[index] as number;
    const low = bars.l[index] as number;
    const previous = bars.c[index - 1] as number;
    const upMove = high - (bars.h[index - 1] as number);
    const downMove = (bars.l[index - 1] as number) - low;
    const plusMove = upMove > 0 && upMove > downMove ? upMove : 0;
    const minusMove = downMove > 0 && downMove > upMove ? downMove : 0;
    const range = Math.max(
      high - low,
      Math.abs(high - previous),
      Math.abs(low - previous)
    );
    if (index < length) {
      plusSum += plusMove;
      minusSum += minusMove;
      rangeSum += range;
      continue;
    }
    plusSum += plusMove - plusSum / length;
    minusSum += minusMove - minusSum / length;
    rangeSum += range - rangeSum / length;
    const plus = rangeSum === 0 ? 0 : (100 * plusSum) / rangeSum;
    const minus = rangeSum === 0 ? 0 : (100 * minusSum) / rangeSum;
    const total = plus + minus;
    const dx = total === 0 ? 0 : (100 * Math.abs(plus - minus)) / total;
    if (index < 2 * length - 1) {
      dxTotal += dx;
      continue;
    }
    average = Number.isNaN(average)
      ? (dxTotal + dx) / length
      : (average * (length - 1) + dx) / length;
    out[index] = average;
  }
  return out;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
  minute: "numeric",
  month: "numeric",
  timeZone: "America/New_York",
  year: "numeric",
});

/** New York local time minus UTC, in ms, for the UTC hour that holds `t`. */
const newYorkOffset = (t: number, cache: Map<number, number>): number => {
  const hour = Math.floor(t / HOUR_MS);
  const cached = cache.get(hour);
  if (cached !== undefined) return cached;
  const parts = new Map(
    NEW_YORK.formatToParts(hour * HOUR_MS).map((part) => [
      part.type,
      Number(part.value),
    ])
  );
  const local = Date.UTC(
    parts.get("year") as number,
    (parts.get("month") as number) - 1,
    parts.get("day") as number,
    parts.get("hour") as number,
    parts.get("minute") as number
  );
  const offset = local - hour * HOUR_MS;
  cache.set(hour, offset);
  return offset;
};

/** Cumulative session volume through the last bar with slot <= `slot` (0 when there is none). */
const cumulativeAsOf = (
  slots: readonly number[],
  totals: readonly number[],
  slot: number
): number => {
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((slots[middle] as number) <= slot) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? 0 : (totals[low - 1] as number);
};

/**
 * Relative volume at time. Session = New York calendar date of the bar, slot = New York minute of
 * day. Value = session volume so far / mean volume of the `lookback` previous sessions through the
 * same slot. NaN with fewer than `lookback` previous sessions or a zero mean. Input is chronological.
 * When every session has exactly one bar (daily bars), every bar uses slot 0, so the value is volume
 * / mean volume of the previous `lookback` bars, also when a fixed UTC bar time moves in New York time
 * at a daylight saving change.
 */
export const relativeVolumeAtTime = (
  t: Float64Array,
  volume: Float64Array,
  lookback: number
): Float64Array => {
  const size = t.length;
  const out = new Float64Array(size).fill(Number.NaN);
  // The New York UTC offset changes only on whole UTC hours, so one lookup per UTC hour is enough.
  const offsets = new Map<number, number>();
  const days = new Float64Array(size);
  const slots = new Float64Array(size);
  let oneBarSessions = true;
  for (let index = 0; index < size; index += 1) {
    const local =
      (t[index] as number) + newYorkOffset(t[index] as number, offsets);
    const day = Math.floor(local / DAY_MS);
    days[index] = day;
    slots[index] = Math.floor((local - day * DAY_MS) / MINUTE_MS);
    if (index > 0 && days[index - 1] === day) oneBarSessions = false;
  }
  if (oneBarSessions) slots.fill(0);
  const sessions: { slots: number[]; totals: number[] }[] = [];
  let current = { slots: [] as number[], totals: [] as number[] };
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    const slot = slots[index] as number;
    if (index === 0 || days[index] !== days[index - 1]) {
      if (index > 0) sessions.push(current);
      current = { slots: [], totals: [] };
      total = 0;
    }
    total += volume[index] as number;
    current.slots.push(slot);
    current.totals.push(total);
    if (sessions.length < lookback) continue;
    let sum = 0;
    for (
      let back = sessions.length - lookback;
      back < sessions.length;
      back += 1
    ) {
      const session = sessions[back] as (typeof sessions)[number];
      sum += cumulativeAsOf(session.slots, session.totals, slot);
    }
    if (sum !== 0) out[index] = total / (sum / lookback);
  }
  return out;
};

/** Series value `offset` bars ago; NaN before the first available bar. */
const shift = (values: Float64Array, offset: number): Float64Array => {
  const out = new Float64Array(values.length).fill(Number.NaN);
  if (offset < values.length)
    out.set(values.subarray(0, values.length - offset), offset);
  return out;
};

type SeriesCache = Map<string, Float64Array>;
type LeafExpr = Extract<
  StrategyExpr,
  { type: "price" | "const" | "indicator" }
>;
type TreeExpr = Exclude<StrategyExpr, LeafExpr>;

/** What series expressions and filters read: the bar dates and the series input. */
type SeriesFrame = Readonly<{
  barDates: readonly string[];
  /** StrategySeriesInput.calendar and the calendar position of each bar, when given. */
  calendar: Readonly<{ at: Int32Array; dates: readonly string[] }> | undefined;
  input: StrategySeriesInput | undefined;
  intraday: boolean;
}>;

/** Evaluation state of one compile: the bars, the series cache and the (lazy) series frame. */
type ExprContext = Readonly<{
  bars: BarColumns;
  cache: SeriesCache;
  frame: () => SeriesFrame;
}>;

// Indicator timeframe "1d" (strategy-dsl.ts STRATEGY_INDICATOR_TIMEFRAMES).

/** A session day starts at 17:00 New York: the day key is the New York date of t + 7 hours. */
const SESSION_DAY_SHIFT_MS = 7 * HOUR_MS;

/** Daily bars built from the signal bars, and the daily index of every signal bar. */
type SessionDays = Readonly<{ bars: BarColumns; day: Int32Array }>;

/**
 * Daily bars of the signal bars: one per session day (New York date of t + 7 hours, so US
 * regular-hours bars keep their date and FX or futures days start at 17:00 New York). Daily bar =
 * first open, highest high, lowest low, last close and summed volume (when present) of its signal
 * bars; its time is the time of its first signal bar. Input is chronological.
 */
const sessionDailyBars = (bars: BarColumns): SessionDays => {
  const size = bars.c.length;
  const offsets = new Map<number, number>();
  const day = new Int32Array(size);
  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  let key = Number.NaN;
  for (let index = 0; index < size; index += 1) {
    const shifted = (bars.t[index] as number) + SESSION_DAY_SHIFT_MS;
    const next = Math.floor(
      (shifted + newYorkOffset(shifted, offsets)) / DAY_MS
    );
    const high = bars.h[index] as number;
    const low = bars.l[index] as number;
    const volume = bars.v === undefined ? 0 : (bars.v[index] as number);
    if (next === key) {
      const last = c.length - 1;
      if (high > (h[last] as number)) h[last] = high;
      if (low < (l[last] as number)) l[last] = low;
      v[last] = (v[last] as number) + volume;
    } else {
      key = next;
      t.push(bars.t[index] as number);
      o.push(bars.o[index] as number);
      h.push(high);
      l.push(low);
      v.push(volume);
      c.push(0);
    }
    c[c.length - 1] = bars.c[index] as number;
    day[index] = c.length - 1;
  }
  return {
    bars: {
      c: Float64Array.from(c),
      h: Float64Array.from(h),
      l: Float64Array.from(l),
      o: Float64Array.from(o),
      t: Float64Array.from(t),
      ...(bars.v === undefined ? {} : { v: Float64Array.from(v) }),
    },
    day,
  };
};

const sessionDays = new WeakMap<SeriesCache, SessionDays>();

/**
 * Indicator on daily bars, mapped to the signal bars without look-ahead: a bar of day D reads
 * highest and lowest at day D (their window is the days before D) and every other indicator at day
 * D - 1, the last completed day (NaN on the first day).
 */
const dailyIndicator = (
  bars: BarColumns,
  expr: Extract<StrategyExpr, { type: "indicator" }>,
  cache: SeriesCache
): Float64Array => {
  let days = sessionDays.get(cache);
  if (days === undefined) {
    days = sessionDailyBars(bars);
    sessionDays.set(cache, days);
  }
  const count = days.bars.c.length;
  if (expr.length > count) {
    throw new InstantBacktestInputError(
      `${expr.name} length ${expr.length} is longer than the ${count} daily bars`
    );
  }
  const daily = evaluateCurrent(
    days.bars,
    {
      length: expr.length,
      name: expr.name,
      source: expr.source,
      type: "indicator",
    },
    new Map()
  );
  const lag = expr.name === "highest" || expr.name === "lowest" ? 0 : 1;
  const out = new Float64Array(bars.c.length);
  for (let index = 0; index < out.length; index += 1) {
    const at = (days.day[index] as number) - lag;
    out[index] = at < 0 ? Number.NaN : (daily[at] as number);
  }
  return out;
};

const evaluateLeaf = (
  bars: BarColumns,
  expr: LeafExpr,
  cache: SeriesCache
): Float64Array => {
  const current = evaluateCurrent(bars, expr, cache);
  if (expr.type === "const") return current;
  const offset = expr.offset ?? 0;
  if (offset === 0) return current;
  const key =
    expr.type === "price"
      ? `price:${expr.field}@${offset}`
      : `${indicatorKey(expr)}@${offset}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const series = shift(current, offset);
  cache.set(key, series);
  return series;
};

const indicatorKey = (
  expr: Extract<StrategyExpr, { type: "indicator" }>
): string =>
  `${expr.name}:${expr.length}:${expr.source}${expr.timeframe === undefined ? "" : `:${expr.timeframe}`}`;

const evaluateCurrent = (
  bars: BarColumns,
  expr: LeafExpr,
  cache: SeriesCache
): Float64Array => {
  const size = bars.c.length;
  if (expr.type === "price") return bars[FIELD_KEY[expr.field]];
  if (expr.type === "const") return new Float64Array(size).fill(expr.value);
  if (expr.timeframe !== undefined) {
    const key = indicatorKey(expr);
    const series = cache.get(key) ?? dailyIndicator(bars, expr, cache);
    cache.set(key, series);
    return series;
  }
  if (expr.length > size) {
    throw new InstantBacktestInputError(
      `${expr.name} length ${expr.length} is longer than the ${size} bars`
    );
  }
  const key = indicatorKey(expr);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const source = bars[FIELD_KEY[expr.source]];
  const series = {
    adx: () => averageDirectionalIndex(bars, expr.length),
    atr: () => averageTrueRange(bars, expr.length),
    ema: () => exponentialMean(source, expr.length),
    highest: () => priorExtreme(source, expr.length, 1),
    lowest: () => priorExtreme(source, expr.length, -1),
    realizedVol: () => realizedVolatility(source, expr.length),
    rsi: () => relativeStrength(source, expr.length),
    rvol: () => {
      if (bars.v === undefined)
        throw new InstantBacktestInputError("rvol needs bar volume");
      return relativeVolumeAtTime(bars.t, bars.v, expr.length);
    },
    sma: () => rollingMean(source, expr.length),
    zscore: () => rollingZScore(source, expr.length),
  }[expr.name]();
  cache.set(key, series);
  return series;
};

/**
 * Values of an expression on each bar (NaN = not available). Leaves use the indicator cache; every
 * other node is memoized by its canonical JSON within one compile.
 */
const evaluate = (context: ExprContext, expr: StrategyExpr): Float64Array => {
  if (
    expr.type === "price" ||
    expr.type === "const" ||
    expr.type === "indicator"
  )
    return evaluateLeaf(context.bars, expr, context.cache);
  const key = `expr:${canonicalJson(expr)}`;
  const cached = context.cache.get(key);
  if (cached !== undefined) return cached;
  const values = evaluateTree(context, expr);
  context.cache.set(key, values);
  return values;
};

const finiteOrNaN = (value: number): number =>
  Number.isFinite(value) ? value : Number.NaN;

const MATH: Readonly<
  Record<
    Extract<StrategyExpr, { type: "math" }>["op"],
    (left: number, right: number) => number
  >
> = {
  add: (left, right) => left + right,
  div: (left, right) => left / right,
  mul: (left, right) => left * right,
  sub: (left, right) => left - right,
};

/** Sample standard deviation of the last `length` one-bar simple returns (NaN when one is missing). */
const returnDeviation = (
  values: Float64Array,
  length: number
): Float64Array => {
  const returns = new Float64Array(values.length).fill(Number.NaN);
  for (let index = 1; index < values.length; index += 1)
    returns[index] = finiteOrNaN(
      (values[index] as number) / (values[index - 1] as number) - 1
    );
  return rollingMoments(returns, length).deviation;
};

/**
 * a0 + a1 × x[t] by least squares of y[s] on x[s − lag] over the `length` bars s ending at t
 * (two-pass sums in bar order). NaN when a value is missing or the x window is flat.
 */
const regressionSeries = (
  y: Float64Array,
  x: Float64Array,
  length: number,
  lag: number
): Float64Array => {
  const out = new Float64Array(y.length).fill(Number.NaN);
  for (let index = length - 1 + lag; index < y.length; index += 1) {
    const first = index - length + 1;
    let sumX = 0;
    let sumY = 0;
    for (let at = first; at <= index; at += 1) {
      sumX += x[at - lag] as number;
      sumY += y[at] as number;
    }
    const current = x[index] as number;
    if (
      !(
        Number.isFinite(sumX) &&
        Number.isFinite(sumY) &&
        Number.isFinite(current)
      )
    )
      continue;
    const meanX = sumX / length;
    const meanY = sumY / length;
    let squares = 0;
    let products = 0;
    for (let at = first; at <= index; at += 1) {
      const deltaX = (x[at - lag] as number) - meanX;
      squares += deltaX * deltaX;
      products += deltaX * ((y[at] as number) - meanY);
    }
    if (!(squares > 0)) continue;
    const slope = products / squares;
    const intercept = meanY - slope * meanX;
    out[index] = finiteOrNaN(intercept + slope * current);
  }
  return out;
};

/**
 * Mean of the finite values at this and earlier bars in the UTC calendar month `monthsAhead` after
 * the bar's month; NaN with fewer than `minCount` values.
 */
const seasonalSeries = (
  values: Float64Array,
  t: Float64Array,
  monthsAhead: number,
  minCount: number
): Float64Array => {
  const out = new Float64Array(values.length).fill(Number.NaN);
  const sums = new Float64Array(12);
  const counts = new Float64Array(12);
  for (let index = 0; index < values.length; index += 1) {
    const month = new Date(t[index] as number).getUTCMonth();
    const value = values[index] as number;
    if (Number.isFinite(value)) {
      sums[month] = (sums[month] as number) + value;
      counts[month] = (counts[month] as number) + 1;
    }
    const target = (month + monthsAhead) % 12;
    const count = counts[target] as number;
    if (count >= minCount) out[index] = (sums[target] as number) / count;
  }
  return out;
};

const evaluateTree = (context: ExprContext, expr: TreeExpr): Float64Array => {
  const size = context.bars.c.length;
  switch (expr.type) {
    case "series":
      return shift(
        seriesValues(context.frame(), expr.series),
        expr.offset ?? 0
      );
    case "math": {
      const left = evaluate(context, expr.left);
      const right = evaluate(context, expr.right);
      const apply = MATH[expr.op];
      return Float64Array.from({ length: size }, (_, index) =>
        finiteOrNaN(apply(left[index] as number, right[index] as number))
      );
    }
    case "change": {
      const of = evaluate(context, expr.of);
      const offset = expr.offset ?? 0;
      const out = new Float64Array(size).fill(Number.NaN);
      for (let index = offset + expr.length; index < size; index += 1)
        out[index] = finiteOrNaN(
          (of[index - offset] as number) /
            (of[index - offset - expr.length] as number) -
            1
        );
      return out;
    }
    case "returnStdev":
      return returnDeviation(evaluate(context, expr.of), expr.length);
    case "regression":
      return regressionSeries(
        evaluate(context, expr.y),
        evaluate(context, expr.x),
        expr.length,
        expr.lag
      );
    default:
      return seasonalSeries(
        evaluate(context, expr.of),
        context.bars.t,
        expr.monthsAhead,
        expr.minCount
      );
  }
};

const compare = (op: StrategyCondition["op"], left: number, right: number) => {
  switch (op) {
    case ">":
    case "crossesAbove":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
    case "crossesBelow":
      return left < right;
    default:
      return left <= right;
  }
};

/** 1 where `left op right` holds. A cross is true when the relation holds now but not on the previous bar. */
const compareSeries = (
  op: StrategyCondition["op"],
  left: Float64Array,
  right: Float64Array
): Uint8Array => {
  if (op === "breaksAbove" || op === "breaksBelow")
    return breakSeries(op, left, right);
  const out = new Uint8Array(left.length);
  const cross = op === "crossesAbove" || op === "crossesBelow";
  let previous = false;
  for (let index = 0; index < left.length; index += 1) {
    const now = compare(op, left[index] as number, right[index] as number);
    out[index] = (cross ? now && !previous : now) ? 1 : 0;
    previous = now;
  }
  return out;
};

/**
 * breaksAbove at bar i: left[i] > right[i] and left[i - 1] <= right[i] (the previous left against
 * the current right). breaksBelow: left[i] < right[i] and left[i - 1] >= right[i]. False at bar 0
 * and whenever a value is NaN.
 */
const breakSeries = (
  op: "breaksAbove" | "breaksBelow",
  left: Float64Array,
  right: Float64Array
): Uint8Array => {
  const out = new Uint8Array(left.length);
  for (let index = 1; index < left.length; index += 1) {
    const now = left[index] as number;
    const level = right[index] as number;
    const before = left[index - 1] as number;
    const fired =
      op === "breaksAbove"
        ? now > level && before <= level
        : now < level && before >= level;
    if (fired) out[index] = 1;
  }
  return out;
};

/**
 * oncePerLevel: drops a bar where the condition holds when the same right value (exact double)
 * already made it hold on an earlier bar. Changes `fired` in place.
 */
const oncePerLevel = (fired: Uint8Array, right: Float64Array): Uint8Array => {
  const levels = new Set<number>();
  for (let index = 0; index < fired.length; index += 1) {
    if (fired[index] !== 1) continue;
    const level = right[index] as number;
    if (levels.has(level)) fired[index] = 0;
    else levels.add(level);
  }
  return fired;
};

/** Boolean series of one condition on the bars. */
const conditionSeries = (
  context: ExprContext,
  condition: StrategyCondition
): Uint8Array => {
  const left = evaluate(context, condition.left);
  const right = evaluate(context, condition.right);
  const fired = compareSeries(condition.op, left, right);
  return condition.oncePerLevel === true ? oncePerLevel(fired, right) : fired;
};

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

/** True when the bar's UTC minute of day is in [start, end); wraps past midnight when end < start. */
const inSession = (
  t: number,
  session: NonNullable<StrategyDefinition["session"]>
): boolean => {
  const minute =
    ((Math.floor(t / MINUTE_MS) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const start = minutesOf(session.startUtc);
  const end = minutesOf(session.endUtc);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
};

/** One stored sector rotation point, reduced to what a filter needs. */
export type SectorQuadrantPoint = Readonly<{
  /** YYYY-MM-DD of the period close. */
  date: string;
  quadrant: SectorQuadrantFilter["quadrants"][number];
}>;

/** Series by `${sector}:${timeframe}` (for example "XLK:weekly"), sorted by date ascending. */
export type SectorQuadrantSeries = Readonly<
  Record<string, readonly SectorQuadrantPoint[]>
>;

/** A definition has a sector filter, but its series was not given. */
export class SectorQuadrantDataError extends InstantBacktestInputError {
  constructor(sector: string, timeframe: string) {
    super(`Sector quadrant data is not available for ${sector} (${timeframe})`);
    this.name = "SectorQuadrantDataError";
  }
}

export const sectorQuadrantKey = (filter: SectorQuadrantFilter): string =>
  `${filter.sector}:${filter.timeframe}`;

/**
 * Daily values of external series (STRATEGY_SERIES_IDS): series id → YYYY-MM-DD date → value (the
 * close). Values that are not finite count as missing.
 */
export type StrategySeriesContext = Readonly<
  Record<string, Readonly<Record<string, number>>>
>;

/** What the ivRank, vixTermStructure, volRegime and series filters and series expressions read. */
export type StrategySeriesInput = Readonly<{
  /**
   * Trading dates (YYYY-MM-DD, ascending, no repeats) to align every series on before reading it at
   * the bar dates, so the carry counts calendar dates rather than bars (for example month-end bars).
   * Every bar date must be in it. Without it the series align on the bar dates.
   */
  calendar?: readonly string[];
  context: StrategySeriesContext;
  /**
   * Traded symbol; ivRank reads its implied-volatility index (STRATEGY_IV_INDEX) and the relative
   * refs $tr, $iv and $future resolve with it (resolveStrategySeries).
   */
  symbol?: string;
}>;

/** A definition has a filter on a series that was not given. */
export class StrategySeriesDataError extends InstantBacktestInputError {
  constructor(series: string) {
    super(`Series data is not available for ${series}`);
    this.name = "StrategySeriesDataError";
  }
}

/** An engine refuses the definition: `code` is STRATEGY_OPTIONS_UNSUPPORTED or STRATEGY_SERIES_FILTERS_UNSUPPORTED. */
export class StrategyUnsupportedError extends InstantBacktestInputError {
  readonly code: StrategyRefusal["code"];
  constructor(refusal: StrategyRefusal) {
    super(refusal.message);
    this.name = "StrategyUnsupportedError";
    this.code = refusal.code;
  }
}

/**
 * Throws StrategyUnsupportedError when a server path cannot run the definition or filters (on
 * `timeframe`, when given) with what it loads (`support`, see serverStrategyRefusal). Research
 * runners call compileStrategy instead.
 */
export const assertServerRunnable = (
  definition: StrategySeriesReader,
  timeframe?: string,
  support?: StrategyServerSupport
): void => {
  const refusal = serverStrategyRefusal(definition, timeframe, support);
  if (refusal !== undefined) throw new StrategyUnsupportedError(refusal);
};

/**
 * Most trading days (distinct bar dates) a series value is carried past its date, as in the
 * research loader (qc_ports data.align). Older values are missing.
 */
export const STRATEGY_SERIES_MAX_FILL_DAYS = 5;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

type DailySeries = Readonly<{ dates: readonly string[]; values: Float64Array }>;

/** The finite values of one context series, by date ascending. */
const dailySeries = (
  input: StrategySeriesInput | undefined,
  id: string
): DailySeries => {
  const byDate = input?.context[id];
  if (byDate === undefined) throw new StrategySeriesDataError(id);
  const dates: string[] = [];
  for (const date of Object.keys(byDate).sort()) {
    if (!DATE_PATTERN.test(date))
      throw new InstantBacktestInputError(
        `Series ${id} has a date that is not YYYY-MM-DD: ${date}`
      );
    if (Number.isFinite(byDate[date])) dates.push(date);
  }
  return {
    dates,
    values: Float64Array.from(dates, (date) => byDate[date] as number),
  };
};

/**
 * The value of a daily series on each bar: the latest value dated on or before the bar date. A
 * daily value is known after its close, so an intraday bar uses only values dated before its date.
 * A value is carried for at most STRATEGY_SERIES_MAX_FILL_DAYS later bar dates without a newer
 * one (the carry restarts whenever a newer value becomes usable). `exact` (daily bars) needs a
 * value dated on the bar date itself; otherwise NaN.
 */
const alignSeries = (
  series: DailySeries,
  values: Float64Array,
  barDates: readonly string[],
  intraday: boolean,
  exact: boolean
): Float64Array => {
  const { dates } = series;
  const out = new Float64Array(barDates.length).fill(Number.NaN);
  let next = 0;
  let age = 0;
  let previousDate: string | undefined;
  for (let index = 0; index < barDates.length; index += 1) {
    const date = barDates[index] as string;
    const before = next;
    while (
      next < dates.length &&
      (intraday
        ? (dates[next] as string) < date
        : (dates[next] as string) <= date)
    )
      next += 1;
    if (next > before) age = 0;
    else if (date !== previousDate) age += 1;
    previousDate = date;
    if (next === 0 || age > STRATEGY_SERIES_MAX_FILL_DAYS) continue;
    if (exact && !intraday && dates[next - 1] !== date) continue;
    out[index] = values[next - 1] as number;
  }
  return out;
};

/** The series id a ref reads for the traded symbol (relative refs need a mapped symbol). */
const seriesId = (
  ref: StrategySeriesRef,
  input: StrategySeriesInput | undefined
): string => {
  const symbol = input?.symbol;
  const id = resolveStrategySeries(ref, symbol);
  if (id !== undefined) return id;
  throw new InstantBacktestInputError(
    symbol === undefined
      ? `${ref} needs the traded symbol`
      : `${ref} has no series for ${symbol}`
  );
};

/** Calendar position of each bar date; the calendar must be ascending dates holding every bar date. */
const calendarPositions = (
  dates: readonly string[],
  barDates: readonly string[]
): Int32Array => {
  const positions = new Map<string, number>();
  dates.forEach((date, index) => {
    if (
      !DATE_PATTERN.test(date) ||
      (index > 0 && date <= (dates[index - 1] as string))
    )
      throw new InstantBacktestInputError(
        `The calendar must hold ascending YYYY-MM-DD dates without repeats: ${date}`
      );
    positions.set(date, index);
  });
  return Int32Array.from(barDates, (date) => {
    const at = positions.get(date);
    if (at === undefined)
      throw new InstantBacktestInputError(
        `Bar date ${date} is not in the calendar`
      );
    return at;
  });
};

const seriesFrame = (
  bars: BarColumns,
  input: StrategySeriesInput | undefined
): SeriesFrame => {
  const barDates = Array.from(bars.t, (t) =>
    new Date(t).toISOString().slice(0, 10)
  );
  const dates = input?.calendar;
  return {
    barDates,
    calendar:
      dates === undefined
        ? undefined
        : { at: calendarPositions(dates, barDates), dates },
    input,
    intraday: isIntraday(bars.t),
  };
};

/** alignSeries on the bar dates, or on the calendar and then read at the bar dates. */
const alignOn = (
  frame: SeriesFrame,
  series: DailySeries,
  values: Float64Array,
  exact: boolean
): Float64Array => {
  const { calendar } = frame;
  if (calendar === undefined)
    return alignSeries(series, values, frame.barDates, frame.intraday, exact);
  const aligned = alignSeries(
    series,
    values,
    calendar.dates,
    frame.intraday,
    exact
  );
  return Float64Array.from(calendar.at, (at) => aligned[at] as number);
};

/** The value of a series ref on each bar, aligned like the series filter (carried, not exact). */
const seriesValues = (
  frame: SeriesFrame,
  ref: StrategySeriesRef
): Float64Array => {
  const series = dailySeries(frame.input, seriesId(ref, frame.input));
  return alignOn(frame, series, series.values, false);
};

/** 100 × (v − min) / (max − min) over the `length` values ending at each value; NaN when flat. */
export const ivRankSeries = (
  values: Float64Array,
  length: number
): Float64Array => {
  const highest = priorExtreme(values, length - 1, 1);
  const lowest = priorExtreme(values, length - 1, -1);
  const out = new Float64Array(values.length).fill(Number.NaN);
  for (let index = length - 1; index < values.length; index += 1) {
    const value = values[index] as number;
    const high = Math.max(highest[index] as number, value);
    const low = Math.min(lowest[index] as number, value);
    if (high > low) out[index] = (100 * (value - low)) / (high - low);
  }
  return out;
};

/** VIX / VIX3M on the dates where both have a value (and VIX3M is above 0). */
const termRatioSeries = (
  input: StrategySeriesInput | undefined
): DailySeries => {
  const vix = dailySeries(input, "VIX");
  const vix3m = dailySeries(input, "VIX3M");
  const dates: string[] = [];
  const ratios: number[] = [];
  let other = 0;
  vix.dates.forEach((date, index) => {
    while (other < vix3m.dates.length && (vix3m.dates[other] as string) < date)
      other += 1;
    const denominator = vix3m.values[other] as number;
    if (vix3m.dates[other] !== date || !(denominator > 0)) return;
    dates.push(date);
    ratios.push((vix.values[index] as number) / denominator);
  });
  return { dates, values: Float64Array.from(ratios) };
};

/** True when `value` is a number in [min, max]; a missing bound is open. */
const within = (
  value: number,
  min: number | undefined,
  max: number | undefined
): boolean =>
  !Number.isNaN(value) &&
  (min === undefined || value >= min) &&
  (max === undefined || value <= max);

const maskOf = (size: number, pass: (index: number) => boolean): Uint8Array =>
  Uint8Array.from({ length: size }, (_, index) => (pass(index) ? 1 : 0));

/** 0 Sunday to 6 Saturday of a UTC day number (days since 1970-01-01, a Thursday). */
const weekday = (day: number): number => (((day + 4) % 7) + 7) % 7;

const utcDay = (year: number, month: number, date: number): number =>
  Date.UTC(year, month, date) / DAY_MS;

/** UTC day of the `n`th `day` (0 Sunday to 6 Saturday) of a month (0 January). */
const nthWeekday = (year: number, month: number, day: number, n: number) => {
  const first = utcDay(year, month, 1);
  return first + ((day - weekday(first) + 7) % 7) + 7 * (n - 1);
};

const lastWeekday = (year: number, month: number, day: number): number => {
  const last = utcDay(year, month + 1, 1) - 1;
  return last - ((weekday(last) - day + 7) % 7);
};

/** A Saturday holiday is observed on Friday, a Sunday holiday on Monday. */
const observed = (day: number): number => {
  const of = weekday(day);
  if (of === 6) return day - 1;
  return of === 0 ? day + 1 : day;
};

/** Gregorian Easter Sunday (anonymous Gregorian algorithm) as a UTC day. */
const easterSunday = (year: number): number => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const h =
    (19 * a +
      b -
      Math.floor(b / 4) -
      Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) +
      15) %
    30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return utcDay(year, month - 1, ((h + l - 7 * m + 114) % 31) + 1);
};

/**
 * Special NYSE full-day closures since 1998 (not set by the holiday rules): September 11 attacks,
 * the national days of mourning for Presidents Reagan, Ford, G. H. W. Bush and Carter, and
 * Hurricane Sandy. Python mirror: signals.NYSE_SPECIAL_CLOSURES.
 */
export const NYSE_SPECIAL_CLOSURES: readonly string[] = [
  "2001-09-11",
  "2001-09-12",
  "2001-09-13",
  "2001-09-14",
  "2004-06-11",
  "2007-01-02",
  "2012-10-29",
  "2012-10-30",
  "2018-12-05",
  "2025-01-09",
];

const holidayCache = new Map<number, ReadonlySet<number>>();

/**
 * Regular NYSE full-day holidays of a year as UTC days, the rules since 1998 (the same rules as
 * the research calendar, qc_ports calendar.is_nyse_holiday): New Year (not observed on a Saturday),
 * Martin Luther King Jr. Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from
 * 2022), Independence Day, Labor Day, Thanksgiving and Christmas, plus the special closures of
 * NYSE_SPECIAL_CLOSURES in that year.
 */
export const nyseHolidays = (year: number): ReadonlySet<number> => {
  const cached = holidayCache.get(year);
  if (cached !== undefined) return cached;
  const days = new Set<number>([
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    easterSunday(year) - 2,
    lastWeekday(year, 4, 1),
    observed(utcDay(year, 6, 4)),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4),
    observed(utcDay(year, 11, 25)),
  ]);
  const newYear = utcDay(year, 0, 1);
  if (weekday(newYear) !== 6) days.add(observed(newYear));
  if (year >= 2022) days.add(observed(utcDay(year, 5, 19)));
  for (const date of NYSE_SPECIAL_CLOSURES)
    if (date.startsWith(`${year}-`)) days.add(Date.parse(date) / DAY_MS);
  holidayCache.set(year, days);
  return days;
};

/** A weekday that is not an NYSE holiday (UTC day number). */
export const isNyseTradingDay = (day: number): boolean => {
  const of = weekday(day);
  return (
    of >= 1 &&
    of <= 5 &&
    !nyseHolidays(new Date(day * DAY_MS).getUTCFullYear()).has(day)
  );
};

/** First and last UTC day number of the month holding `day`, and its month (1 to 12). */
const monthOf = (
  day: number
): Readonly<{ first: number; last: number; month: number }> => {
  const date = new Date(day * DAY_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    first: Date.UTC(year, month, 1) / DAY_MS,
    last: Date.UTC(year, month + 1, 1) / DAY_MS - 1,
    month: month + 1,
  };
};

/**
 * 1 on daily bars inside the calendar window (see CalendarWindowFilterSchema). Trading days come
 * from the NYSE holiday rules, not from the bars; a bar on a day that does not trade is outside
 * the turnOfMonth and opexWeek windows.
 */
const calendarMask = (
  filter: CalendarWindowFilter,
  days: Float64Array
): Uint8Array => {
  const count = (from: number, to: number): number => {
    let total = 0;
    for (let day = from; day <= to; day += 1)
      if (isNyseTradingDay(day)) total += 1;
    return total;
  };
  return maskOf(days.length, (index) => {
    const day = days[index] as number;
    const month = monthOf(day);
    if (filter.window === "months") return filter.months.includes(month.month);
    if (!isNyseTradingDay(day)) return false;
    if (filter.window === "turnOfMonth")
      return (
        -count(day, month.last) >= filter.fromDay ||
        count(month.first, day) <= filter.toDay
      );
    const thirdFriday = month.first + ((5 - weekday(month.first) + 7) % 7) + 14;
    let expiry = thirdFriday;
    while (!isNyseTradingDay(expiry)) expiry -= 1;
    let start = thirdFriday - 5; // the Sunday before the week
    while (!isNyseTradingDay(start)) start -= 1;
    return day >= start && day <= expiry;
  });
};

/** ivRank mask: the traded symbol's IV index rank on the bar date is within [min, max]. */
const ivRankMask = (filter: IvRankFilter, frame: SeriesFrame): Uint8Array => {
  const { input } = frame;
  const symbol = input?.symbol;
  if (symbol === undefined)
    throw new InstantBacktestInputError("ivRank needs the traded symbol");
  if (!Object.hasOwn(STRATEGY_IV_INDEX, symbol))
    throw new InstantBacktestInputError(
      `ivRank has no implied-volatility index for ${symbol}`
    );
  const index = dailySeries(input, STRATEGY_IV_INDEX[symbol] as string);
  const rank = alignOn(
    frame,
    index,
    ivRankSeries(index.values, filter.length),
    true
  );
  return maskOf(frame.barDates.length, (at) =>
    within(rank[at] as number, filter.min, filter.max)
  );
};

/** volRegime mask: VIX, VIX / VIX3M and the SPY trend on the bar date. */
const volRegimeMask = (
  filter: VolRegimeFilter,
  frame: SeriesFrame
): Uint8Array => {
  const { input } = frame;
  const vix = dailySeries(input, "VIX");
  const ratio = termRatioSeries(input);
  const spy = dailySeries(input, "SPY");
  const average = rollingMean(spy.values, filter.trendLength);
  const trend = spy.values.map((close, index) =>
    close > (average[index] as number) ? 1 : 0
  );
  const vixOn = alignOn(frame, vix, vix.values, true);
  const ratioOn = alignOn(frame, ratio, ratio.values, true);
  const trendOn = alignOn(frame, spy, trend, true);
  return maskOf(
    frame.barDates.length,
    (at) =>
      (vixOn[at] as number) <= filter.maxVix &&
      (ratioOn[at] as number) <= filter.maxTermRatio &&
      trendOn[at] === 1
  );
};

/** series mask: the condition evaluated on the series, each side aligned to the bars. */
const seriesMask = (filter: SeriesFilter, context: ExprContext): Uint8Array => {
  const frame = context.frame();
  const series = dailySeries(frame.input, seriesId(filter.series, frame.input));
  if (series.values.length === 0) return new Uint8Array(frame.barDates.length);
  const { values } = series;
  const columns: BarColumns = {
    c: values,
    h: values,
    l: values,
    o: values,
    t: Float64Array.from(series.dates, (date) =>
      Date.parse(`${date}T00:00:00Z`)
    ),
  };
  // The condition reads the close only (no series expressions), so the frame is never read here.
  const own: ExprContext = {
    bars: columns,
    cache: new Map(),
    frame: context.frame,
  };
  const side = (expr: StrategyExpr) =>
    alignOn(frame, series, evaluate(own, expr), false);
  return compareSeries(
    filter.condition.op,
    side(filter.condition.left),
    side(filter.condition.right)
  );
};

/** Smallest gap between bars below this means intraday bars. */
const INTRADAY_GAP_MS = 20 * HOUR_MS;

const isIntraday = (t: Float64Array): boolean => {
  for (let index = 1; index < t.length; index += 1) {
    if ((t[index] as number) - (t[index - 1] as number) < INTRADAY_GAP_MS)
      return true;
  }
  return false;
};

/**
 * 1 on bars where the filter passes. A point is known after its period closes, so a daily or
 * weekly bar (signal at its close) may use a point of the same date, and an intraday bar uses only
 * points dated before its date. No usable point means 0 (no entry).
 */
const filterSeries = (
  t: Float64Array,
  filter: SectorQuadrantFilter,
  points: readonly SectorQuadrantPoint[],
  intraday: boolean
): Uint8Array => {
  const allowed = new Set<string>(filter.quadrants);
  const out = new Uint8Array(t.length);
  let next = 0;
  let quadrant: string | undefined;
  for (let index = 0; index < t.length; index += 1) {
    const date = new Date(t[index] as number).toISOString().slice(0, 10);
    while (next < points.length) {
      const point = points[next] as SectorQuadrantPoint;
      if (intraday ? point.date >= date : point.date > date) break;
      quadrant = point.quadrant;
      next += 1;
    }
    if (quadrant !== undefined && allowed.has(quadrant)) out[index] = 1;
  }
  return out;
};

const filterMasks = (
  context: ExprContext,
  definition: StrategyDefinition,
  sectorQuadrants: SectorQuadrantSeries | undefined
): Uint8Array[] => {
  const filters = definition.filters ?? [];
  if (filters.length === 0) return [];
  const { bars } = context;
  const frame = context.frame();
  const { barDates, intraday } = frame;
  return filters.map((filter) => {
    switch (filter.type) {
      case "sectorQuadrant": {
        const points = sectorQuadrants?.[sectorQuadrantKey(filter)];
        if (points === undefined)
          throw new SectorQuadrantDataError(filter.sector, filter.timeframe);
        return filterSeries(bars.t, filter, points, intraday);
      }
      case "ivRank":
        return ivRankMask(filter, frame);
      case "vixTermStructure": {
        const ratio = termRatioSeries(frame.input);
        const on = alignOn(frame, ratio, ratio.values, true);
        return maskOf(barDates.length, (at) =>
          within(on[at] as number, filter.minRatio, filter.maxRatio)
        );
      }
      case "volRegime":
        return volRegimeMask(filter, frame);
      case "calendarWindow":
        // Fail closed: the UTC date of an intraday bar is not its exchange session.
        if (intraday)
          throw new StrategyUnsupportedError(
            STRATEGY_CALENDAR_INTRADAY_REFUSAL
          );
        return calendarMask(
          filter,
          bars.t.map((t) => Math.floor(t / DAY_MS))
        );
      default:
        return seriesMask(filter, context);
    }
  });
};

export type CompiledStrategy = Readonly<{
  signals: Int8Array;
  /** 1 on every bar where any exit condition holds, also when the entry conditions hold. */
  exits: Uint8Array;
  stopDistance?: Float64Array;
  targetDistance?: Float64Array;
  /** The definition's options block, unchanged, for the options runner. */
  options?: StrategyOptions;
  /** Stop management for the engine (trail ATR on the signal bars), when the definition has it. */
  management?: PositionManagement;
  /** The definition's portfolio block, unchanged, for the options runner. */
  portfolio?: StrategyPortfolio;
}>;

const distanceSeries = (
  bars: BarColumns,
  level: StrategyDefinition["stopLoss"],
  cache: SeriesCache
): Float64Array | undefined => {
  if (level.kind !== "atr") return undefined;
  const atr = evaluateLeaf(
    bars,
    { length: level.length, name: "atr", source: "close", type: "indicator" },
    cache
  );
  return atr.map((value) => value * level.multiple);
};

/** The engine form of the definition's management: the trail ATR is the DSL ATR of the bars. */
const managementOf = (
  bars: BarColumns,
  management: StrategyManagement | undefined,
  cache: SeriesCache
): PositionManagement | undefined => {
  if (management === undefined) return undefined;
  const { breakevenR, trail } = management;
  return {
    ...(breakevenR === undefined ? {} : { breakevenR }),
    ...(trail === undefined
      ? {}
      : {
          trail: {
            activateR: trail.activateR,
            atr: evaluateLeaf(
              bars,
              {
                length: trail.length,
                name: "atr",
                source: "close",
                type: "indicator",
              },
              cache
            ),
            multiple: trail.multiple,
          },
        }),
  };
};

/** A fresh evaluation context; the series frame is built on first use. */
const expressionContext = (
  bars: BarColumns,
  seriesInput: StrategySeriesInput | undefined
): ExprContext => {
  let frame: SeriesFrame | undefined;
  return {
    bars,
    cache: new Map(),
    frame: () => {
      frame ??= seriesFrame(bars, seriesInput);
      return frame;
    },
  };
};

/**
 * Values of one expression on each bar, NaN where not available, with the semantics of a condition
 * side (series expressions read `seriesInput`). For portfolio selection scores.
 */
export const evaluateStrategyExpression = (
  bars: BarColumns,
  expr: StrategyExpr,
  seriesInput?: StrategySeriesInput
): Float64Array => evaluate(expressionContext(bars, seriesInput), expr).slice();

/**
 * Compiles a validated definition to signals: 1 when every entry condition and filter holds, at
 * least one entry.any condition holds (when there are any) and the bar is in the session,
 * otherwise -1 when any exit condition holds, otherwise 0. The exit mask keeps exits
 * on bars where the entry conditions also hold, so an open position still exits there.
 */
export const compileStrategy = (
  bars: BarColumns,
  definition: StrategyDefinition,
  sectorQuadrants?: SectorQuadrantSeries,
  seriesInput?: StrategySeriesInput
): CompiledStrategy => {
  const size = bars.c.length;
  const context = expressionContext(bars, seriesInput);
  const { cache } = context;
  const filters = filterMasks(context, definition, sectorQuadrants);
  const entries = [
    ...definition.entry.all.map((condition) =>
      conditionSeries(context, condition)
    ),
    ...filters,
  ];
  const exits = definition.exit.any.map((condition) =>
    conditionSeries(context, condition)
  );
  const anyOf = (definition.entry.any ?? []).map((condition) =>
    conditionSeries(context, condition)
  );
  const signals = new Int8Array(size);
  const exitMask = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    const enter =
      entries.every((series) => series[index] === 1) &&
      (anyOf.length === 0 || anyOf.some((series) => series[index] === 1)) &&
      (definition.session === undefined ||
        inSession(bars.t[index] as number, definition.session));
    const exit = exits.some((series) => series[index] === 1);
    if (exit) exitMask[index] = 1;
    if (enter) signals[index] = 1;
    else if (exit) signals[index] = -1;
  }
  const stopDistance = distanceSeries(bars, definition.stopLoss, cache);
  const targetDistance = distanceSeries(bars, definition.takeProfit, cache);
  const management = managementOf(bars, definition.management, cache);
  return {
    exits: exitMask,
    signals,
    ...(stopDistance === undefined ? {} : { stopDistance }),
    ...(targetDistance === undefined ? {} : { targetDistance }),
    ...(definition.options === undefined
      ? {}
      : { options: definition.options }),
    ...(definition.portfolio === undefined
      ? {}
      : { portfolio: definition.portfolio }),
    ...(management === undefined ? {} : { management }),
  };
};

/**
 * Compiles and runs a validated definition on the equity engine of the server paths. Starting
 * equity is 1. Refuses (StrategyUnsupportedError) an options block always, and filters and
 * expressions that read series unless `support.series` (then `seriesInput` is their input).
 */
export const runStrategyDefinition = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number,
  costs?: NonNullable<SignalRunOptions["costs"]>,
  sectorQuadrants?: SectorQuadrantSeries,
  timeframe?: string,
  support?: StrategyServerSupport,
  seriesInput?: StrategySeriesInput
): InstantRunResult => {
  // The equity engine would trade the underlying of an options block, so options are refused
  // whatever `support` says (the options runner is separate; callers that want only the signals
  // call compileStrategy). With a known timeframe it also refuses calendar filters on intraday
  // timeframes; compile still checks the bar spacing when the timeframe is not given.
  const series = support?.series === true;
  assertServerRunnable(definition, timeframe, series ? { series } : {});
  const compiled = compileStrategy(
    bars,
    definition,
    sectorQuadrants,
    series ? seriesInput : undefined
  );
  return runSignalBacktest(bars, compiled.signals, {
    costBps,
    ...(costs === undefined ? {} : { costs }),
    exits: compiled.exits,
    stopLossPct:
      definition.stopLoss.kind === "pct" ? definition.stopLoss.pct : 0,
    takeProfitPct:
      definition.takeProfit.kind === "pct" ? definition.takeProfit.pct : 0,
    ...(compiled.stopDistance === undefined
      ? {}
      : { stopDistance: compiled.stopDistance }),
    ...(compiled.targetDistance === undefined
      ? {}
      : { targetDistance: compiled.targetDistance }),
    ...(definition.sizing.mode === "riskPct"
      ? { riskPct: definition.sizing.riskPct }
      : {}),
    ...(compiled.management === undefined
      ? {}
      : { management: compiled.management }),
    ...(definition.sizing.mode === "riskPct" &&
    definition.sizing.maxLeverage !== undefined
      ? { maxLeverage: definition.sizing.maxLeverage }
      : {}),
  });
};
