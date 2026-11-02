import {
  type BarColumns,
  InstantBacktestInputError,
  type InstantRunResult,
  priorExtreme,
  rollingMean,
  runSignalBacktest,
  type SignalRunOptions,
} from "./instant-backtest-engine.ts";
import type {
  StrategyCondition,
  StrategyDefinition,
  StrategyExpr,
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
    rsi: () => relativeStrength(source, expr.length),
    rvol: () => {
      if (bars.v === undefined)
        throw new InstantBacktestInputError("rvol needs bar volume");
      return relativeVolumeAtTime(bars.t, bars.v, expr.length);
    },
    sma: () => rollingMean(source, expr.length),
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

/** Boolean series of one condition. A cross is true when the relation holds now but not on the previous bar. */
const conditionSeries = (
  bars: BarColumns,
  condition: StrategyCondition,
  cache: SeriesCache
): Uint8Array => {
  const left = evaluate(bars, condition.left, cache);
  const right = evaluate(bars, condition.right, cache);
  const out = new Uint8Array(left.length);
  const cross =
    condition.op === "crossesAbove" || condition.op === "crossesBelow";
  let previous = false;
  for (let index = 0; index < left.length; index += 1) {
    const now = compare(
      condition.op,
      left[index] as number,
      right[index] as number
    );
    out[index] = (cross ? now && !previous : now) ? 1 : 0;
    previous = now;
  }
  return out;
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

export type CompiledStrategy = Readonly<{
  signals: Int8Array;
  /** 1 on every bar where any exit condition holds, also when the entry conditions hold. */
  exits: Uint8Array;
  stopDistance?: Float64Array;
  targetDistance?: Float64Array;
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
 * Compiles a validated definition to signals: 1 when every entry condition holds (and the bar is in
 * the session), otherwise -1 when any exit condition holds, otherwise 0. The exit mask keeps exits
 * on bars where the entry conditions also hold, so an open position still exits there.
 */
export const compileStrategy = (
  bars: BarColumns,
  definition: StrategyDefinition
): CompiledStrategy => {
  const size = bars.c.length;
  const cache: SeriesCache = new Map();
  const entries = definition.entry.all.map((condition) =>
    conditionSeries(bars, condition, cache)
  );
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
  };
};

/** Compiles and runs a validated definition. Starting equity is 1. */
export const runStrategyDefinition = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number,
  costs?: NonNullable<SignalRunOptions["costs"]>
): InstantRunResult => {
  const compiled = compileStrategy(bars, definition);
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
