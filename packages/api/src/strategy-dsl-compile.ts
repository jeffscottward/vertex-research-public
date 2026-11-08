import {
  type BarColumns,
  InstantBacktestInputError,
  type InstantRunResult,
  priorExtreme,
  rollingMean,
  runSignalBacktest,
  type SignalRunOptions,
} from "./instant-backtest-engine.ts";
import {
  type CalendarWindowFilter,
  type IvRankFilter,
  type SectorQuadrantFilter,
  type SeriesFilter,
  STRATEGY_IV_INDEX,
  STRATEGY_OPTIONS_REFUSAL,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyExpr,
  type StrategyFilter,
  type StrategyOptions,
  type StrategyRefusal,
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

const evaluate = (
  bars: BarColumns,
  expr: StrategyExpr,
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
): string => `${expr.name}:${expr.length}:${expr.source}`;

const evaluateCurrent = (
  bars: BarColumns,
  expr: StrategyExpr,
  cache: SeriesCache
): Float64Array => {
  const size = bars.c.length;
  if (expr.type === "price") return bars[FIELD_KEY[expr.field]];
  if (expr.type === "const") return new Float64Array(size).fill(expr.value);
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

/** Boolean series of one condition on the bars. */
const conditionSeries = (
  bars: BarColumns,
  condition: StrategyCondition,
  cache: SeriesCache
): Uint8Array =>
  compareSeries(
    condition.op,
    evaluate(bars, condition.left, cache),
    evaluate(bars, condition.right, cache)
  );

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

/** What the ivRank, vixTermStructure, volRegime and series filters read. */
export type StrategySeriesInput = Readonly<{
  context: StrategySeriesContext;
  /** Traded symbol; ivRank reads its implied-volatility index (STRATEGY_IV_INDEX). */
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

/** Throws StrategyUnsupportedError when the server engines cannot run the definition or filters. */
export const assertServerRunnable = (
  definition: Readonly<{
    filters?: readonly StrategyFilter[] | undefined;
    options?: StrategyOptions | undefined;
  }>
): void => {
  const refusal = serverStrategyRefusal(definition);
  if (refusal !== undefined) throw new StrategyUnsupportedError(refusal);
};

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
 * `exact` (daily bars) needs a value dated on the bar date itself; otherwise NaN.
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
  for (let index = 0; index < barDates.length; index += 1) {
    const date = barDates[index] as string;
    while (
      next < dates.length &&
      (intraday
        ? (dates[next] as string) < date
        : (dates[next] as string) <= date)
    )
      next += 1;
    if (next === 0) continue;
    if (exact && !intraday && dates[next - 1] !== date) continue;
    out[index] = values[next - 1] as number;
  }
  return out;
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

/**
 * Trading-day test of the bars: inside the bar date range a day trades when it has a bar; outside
 * it every weekday trades (holidays there are unknown).
 */
const tradingDays = (days: Float64Array): ((day: number) => boolean) => {
  const known = new Set<number>(days);
  const first = days[0] as number;
  const last = days.at(-1) as number;
  return (day) =>
    day >= first && day <= last
      ? known.has(day)
      : weekday(day) >= 1 && weekday(day) <= 5;
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

/** 1 on bars inside the calendar window (see CalendarWindowFilterSchema). */
const calendarMask = (
  filter: CalendarWindowFilter,
  days: Float64Array
): Uint8Array => {
  const trades = tradingDays(days);
  const count = (from: number, to: number): number => {
    let total = 0;
    for (let day = from; day <= to; day += 1) if (trades(day)) total += 1;
    return total;
  };
  return maskOf(days.length, (index) => {
    const day = days[index] as number;
    const month = monthOf(day);
    if (filter.window === "months") return filter.months.includes(month.month);
    if (filter.window === "turnOfMonth")
      return (
        -count(day, month.last) >= filter.fromDay ||
        count(month.first, day) <= filter.toDay
      );
    const thirdFriday = month.first + ((5 - weekday(month.first) + 7) % 7) + 14;
    let expiry = thirdFriday;
    while (!trades(expiry)) expiry -= 1;
    let start = thirdFriday - 5; // the Sunday before the week
    while (!trades(start)) start -= 1;
    return day >= start && day <= expiry;
  });
};

/** ivRank mask: the traded symbol's IV index rank on the bar date is within [min, max]. */
const ivRankMask = (
  filter: IvRankFilter,
  input: StrategySeriesInput | undefined,
  barDates: readonly string[],
  intraday: boolean
): Uint8Array => {
  const symbol = input?.symbol;
  if (symbol === undefined)
    throw new InstantBacktestInputError("ivRank needs the traded symbol");
  if (!Object.hasOwn(STRATEGY_IV_INDEX, symbol))
    throw new InstantBacktestInputError(
      `ivRank has no implied-volatility index for ${symbol}`
    );
  const index = dailySeries(input, STRATEGY_IV_INDEX[symbol] as string);
  const rank = alignSeries(
    index,
    ivRankSeries(index.values, filter.length),
    barDates,
    intraday,
    true
  );
  return maskOf(barDates.length, (at) =>
    within(rank[at] as number, filter.min, filter.max)
  );
};

/** volRegime mask: VIX, VIX / VIX3M and the SPY trend on the bar date. */
const volRegimeMask = (
  filter: VolRegimeFilter,
  input: StrategySeriesInput | undefined,
  barDates: readonly string[],
  intraday: boolean
): Uint8Array => {
  const vix = dailySeries(input, "VIX");
  const ratio = termRatioSeries(input);
  const spy = dailySeries(input, "SPY");
  const average = rollingMean(spy.values, filter.trendLength);
  const trend = spy.values.map((close, index) =>
    close > (average[index] as number) ? 1 : 0
  );
  const vixOn = alignSeries(vix, vix.values, barDates, intraday, true);
  const ratioOn = alignSeries(ratio, ratio.values, barDates, intraday, true);
  const trendOn = alignSeries(spy, trend, barDates, intraday, true);
  return maskOf(
    barDates.length,
    (at) =>
      (vixOn[at] as number) <= filter.maxVix &&
      (ratioOn[at] as number) <= filter.maxTermRatio &&
      trendOn[at] === 1
  );
};

/** series mask: the condition evaluated on the series, each side aligned to the bars. */
const seriesMask = (
  filter: SeriesFilter,
  input: StrategySeriesInput | undefined,
  barDates: readonly string[],
  intraday: boolean
): Uint8Array => {
  const series = dailySeries(input, filter.series);
  if (series.values.length === 0) return new Uint8Array(barDates.length);
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
  const cache: SeriesCache = new Map();
  const side = (expr: StrategyExpr) =>
    alignSeries(
      series,
      evaluate(columns, expr, cache),
      barDates,
      intraday,
      false
    );
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
  bars: BarColumns,
  definition: StrategyDefinition,
  sectorQuadrants: SectorQuadrantSeries | undefined,
  seriesInput: StrategySeriesInput | undefined
): Uint8Array[] => {
  const filters = definition.filters ?? [];
  if (filters.length === 0) return [];
  const intraday = isIntraday(bars.t);
  const barDates = Array.from(bars.t, (t) =>
    new Date(t).toISOString().slice(0, 10)
  );
  return filters.map((filter) => {
    switch (filter.type) {
      case "sectorQuadrant": {
        const points = sectorQuadrants?.[sectorQuadrantKey(filter)];
        if (points === undefined)
          throw new SectorQuadrantDataError(filter.sector, filter.timeframe);
        return filterSeries(bars.t, filter, points, intraday);
      }
      case "ivRank":
        return ivRankMask(filter, seriesInput, barDates, intraday);
      case "vixTermStructure": {
        const ratio = termRatioSeries(seriesInput);
        const on = alignSeries(ratio, ratio.values, barDates, intraday, true);
        return maskOf(barDates.length, (at) =>
          within(on[at] as number, filter.minRatio, filter.maxRatio)
        );
      }
      case "volRegime":
        return volRegimeMask(filter, seriesInput, barDates, intraday);
      case "calendarWindow":
        return calendarMask(
          filter,
          bars.t.map((t) => Math.floor(t / DAY_MS))
        );
      default:
        return seriesMask(filter, seriesInput, barDates, intraday);
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
}>;

const distanceSeries = (
  bars: BarColumns,
  level: StrategyDefinition["stopLoss"],
  cache: SeriesCache
): Float64Array | undefined => {
  if (level.kind !== "atr") return undefined;
  const atr = evaluate(
    bars,
    { length: level.length, name: "atr", source: "close", type: "indicator" },
    cache
  );
  return atr.map((value) => value * level.multiple);
};

/**
 * Compiles a validated definition to signals: 1 when every entry condition and filter holds (and the bar is in
 * the session), otherwise -1 when any exit condition holds, otherwise 0. The exit mask keeps exits
 * on bars where the entry conditions also hold, so an open position still exits there.
 */
export const compileStrategy = (
  bars: BarColumns,
  definition: StrategyDefinition,
  sectorQuadrants?: SectorQuadrantSeries,
  seriesInput?: StrategySeriesInput
): CompiledStrategy => {
  const size = bars.c.length;
  const cache: SeriesCache = new Map();
  const filters = filterMasks(bars, definition, sectorQuadrants, seriesInput);
  const entries = [
    ...definition.entry.all.map((condition) =>
      conditionSeries(bars, condition, cache)
    ),
    ...filters,
  ];
  const exits = definition.exit.any.map((condition) =>
    conditionSeries(bars, condition, cache)
  );
  const signals = new Int8Array(size);
  const exitMask = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    const enter =
      entries.every((series) => series[index] === 1) &&
      (definition.session === undefined ||
        inSession(bars.t[index] as number, definition.session));
    const exit = exits.some((series) => series[index] === 1);
    if (exit) exitMask[index] = 1;
    if (enter) signals[index] = 1;
    else if (exit) signals[index] = -1;
  }
  const stopDistance = distanceSeries(bars, definition.stopLoss, cache);
  const targetDistance = distanceSeries(bars, definition.takeProfit, cache);
  return {
    exits: exitMask,
    signals,
    ...(stopDistance === undefined ? {} : { stopDistance }),
    ...(targetDistance === undefined ? {} : { targetDistance }),
    ...(definition.options === undefined
      ? {}
      : { options: definition.options }),
  };
};

/** Compiles and runs a validated definition. Starting equity is 1. */
export const runStrategyDefinition = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number,
  costs?: NonNullable<SignalRunOptions["costs"]>,
  sectorQuadrants?: SectorQuadrantSeries,
  seriesInput?: StrategySeriesInput
): InstantRunResult => {
  // The equity engine would trade the underlying, not the spread: options run elsewhere.
  if (definition.options !== undefined)
    throw new StrategyUnsupportedError(STRATEGY_OPTIONS_REFUSAL);
  const compiled = compileStrategy(
    bars,
    definition,
    sectorQuadrants,
    seriesInput
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
  });
};
