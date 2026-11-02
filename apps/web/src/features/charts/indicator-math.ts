// Display-only indicator math for chart overlays.
// The formulas match services/research/indicators/core.py (TA-Lib conventions,
// checked against TA-Lib C 0.8.1; see that module for the documented differences).
// Values are IEEE doubles for drawing. They are never exact trading inputs.
// Output arrays align with the input; null marks warmup or an undefined value.

export type Line = (number | null)[];
export type OhlcInput = Readonly<{
  high: readonly number[];
  low: readonly number[];
  close: readonly number[];
}>;

export const MAX_INDICATOR_PERIOD = 2000;

const period = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INDICATOR_PERIOD)
    throw new RangeError(
      `${name} must be an integer 1..${MAX_INDICATOR_PERIOD}`
    );
  return value;
};

const positive = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive finite number`);
  return value;
};

const finite = (values: readonly number[]): readonly number[] => {
  if (!values.every((value) => Number.isFinite(value)))
    throw new RangeError("Indicator input must be finite numbers");
  return values;
};

// Checked index access. A missing or null value inside a window is a bug,
// so it throws (as the Python kernels do) instead of counting as 0.
export const valueAt = (
  values: readonly (number | null)[],
  index: number
): number => {
  const value = values[index];
  if (typeof value !== "number")
    throw new RangeError(`Indicator input is undefined at bar ${index}`);
  return value;
};

const bars = ({ high, low, close }: OhlcInput): OhlcInput => {
  finite(high);
  finite(low);
  finite(close);
  if (high.length !== low.length || high.length !== close.length)
    throw new RangeError("high, low and close must have the same length");
  const ordered = close.every(
    (value, index) =>
      valueAt(low, index) <= value && value <= valueAt(high, index)
  );
  if (!ordered) throw new RangeError("Each bar needs low <= close <= high");
  return { close, high, low };
};

const empty = (length: number): Line =>
  Array.from({ length }, (): number | null => null);

const sum = (values: readonly (number | null)[], from: number, to: number) => {
  let total = 0;
  for (let index = from; index <= to; index += 1)
    total += valueAt(values, index);
  return total;
};

// EMA seeded at seedIndex with the SMA of the `span` values ending there.
const seededEma = (
  values: readonly (number | null)[],
  span: number,
  seedIndex: number,
  alpha: number
): Line => {
  const out = empty(values.length);
  if (seedIndex >= values.length) return out;
  let previous = sum(values, seedIndex - span + 1, seedIndex) / span;
  out[seedIndex] = previous;
  for (let index = seedIndex + 1; index < values.length; index += 1) {
    previous += alpha * (valueAt(values, index) - previous);
    out[index] = previous;
  }
  return out;
};

// Trailing mean; `first` is the first index whose window is fully defined.
const rollingMean = (
  values: readonly (number | null)[],
  span: number,
  first: number
): Line => {
  const out = empty(values.length);
  if (first >= values.length) return out;
  let total = sum(values, first - span + 1, first);
  out[first] = total / span;
  for (let index = first + 1; index < values.length; index += 1) {
    total += valueAt(values, index) - valueAt(values, index - span);
    out[index] = total / span;
  }
  return out;
};

export const sma = (values: readonly number[], length: number): Line => {
  const span = period("period", length);
  return rollingMean(finite(values), span, span - 1);
};

export const ema = (values: readonly number[], length: number): Line => {
  const span = period("period", length);
  return seededEma(finite(values), span, span - 1, 2 / (span + 1));
};

// Wilder smoothing (RMA): SMA seed, then (previous*(n-1)+value)/n.
export const smma = (values: readonly number[], length: number): Line => {
  const span = period("period", length);
  return seededEma(finite(values), span, span - 1, 1 / span);
};

// Weights 1..n, newest bar heaviest (TA-Lib WMA).
export const lwma = (values: readonly number[], length: number): Line => {
  const span = period("period", length);
  const data = finite(values);
  const out = empty(data.length);
  if (data.length < span) return out;
  const divisor = (span * (span + 1)) / 2;
  let windowSum = 0;
  let weighted = 0;
  for (let index = 0; index < span; index += 1) {
    windowSum += valueAt(data, index);
    weighted += (index + 1) * valueAt(data, index);
  }
  out[span - 1] = weighted / divisor;
  for (let index = span; index < data.length; index += 1) {
    weighted += span * valueAt(data, index) - windowSum;
    windowSum += valueAt(data, index) - valueAt(data, index - span);
    out[index] = weighted / divisor;
  }
  return out;
};

export const trueRange = (input: OhlcInput): Line => {
  const { high, low, close } = bars(input);
  const out = empty(close.length);
  for (let index = 1; index < close.length; index += 1) {
    const previous = valueAt(close, index - 1);
    out[index] = Math.max(
      valueAt(high, index) - valueAt(low, index),
      Math.abs(valueAt(high, index) - previous),
      Math.abs(valueAt(low, index) - previous)
    );
  }
  return out;
};

// Wilder ATR (TA-Lib ATR) or the plain mean of true range; both start at bar n.
export const atr = (
  input: OhlcInput,
  length: number,
  method: "wilder" | "sma" = "wilder"
): Line => {
  const span = period("period", length);
  const ranges = trueRange(input);
  return method === "sma"
    ? rollingMean(ranges, span, span)
    : seededEma(ranges, span, span, 1 / span);
};

export type Bands = Readonly<{ middle: Line; upper: Line; lower: Line }>;

// SMA middle band +/- k population standard deviations (TA-Lib BBANDS).
export const bollinger = (
  values: readonly number[],
  length: number,
  deviations: number
): Bands => {
  const span = period("period", length);
  const width = positive("deviations", deviations);
  const data = finite(values);
  const middle = empty(data.length);
  const upper = empty(data.length);
  const lower = empty(data.length);
  for (let index = span - 1; index < data.length; index += 1) {
    const mean = sum(data, index - span + 1, index) / span;
    let squares = 0;
    for (let inner = index - span + 1; inner <= index; inner += 1)
      squares += (valueAt(data, inner) - mean) ** 2;
    const deviation = Math.sqrt(squares / span);
    middle[index] = mean;
    upper[index] = mean + width * deviation;
    lower[index] = mean - width * deviation;
  }
  return { lower, middle, upper };
};

// Wilder Parabolic SAR (TA-Lib SAR). Bar 0 is warmup.
export const parabolicSar = (
  input: Readonly<{ high: readonly number[]; low: readonly number[] }>,
  acceleration: number,
  maximum: number
): Line => {
  const { high, low } = bars({ ...input, close: input.high });
  const step = positive("acceleration", acceleration);
  const limit = positive("maximum", maximum);
  if (step > limit)
    throw new RangeError("acceleration must not exceed maximum");
  const out = empty(high.length);
  if (high.length < 2) return out;
  const upMove = valueAt(high, 1) - valueAt(high, 0);
  const downMove = valueAt(low, 0) - valueAt(low, 1);
  let long = !(downMove > 0 && downMove > upMove);
  let extreme = long ? valueAt(high, 1) : valueAt(low, 1);
  let sar = long ? valueAt(low, 0) : valueAt(high, 0);
  let factor = step;
  let newHigh = valueAt(high, 1);
  let newLow = valueAt(low, 1);
  for (let index = 1; index < high.length; index += 1) {
    const previousHigh = newHigh;
    const previousLow = newLow;
    newHigh = valueAt(high, index);
    newLow = valueAt(low, index);
    if (long) {
      if (newLow <= sar) {
        long = false;
        sar = Math.max(extreme, previousHigh, newHigh);
        out[index] = sar;
        factor = step;
        extreme = newLow;
        sar = Math.max(sar + factor * (extreme - sar), previousHigh, newHigh);
      } else {
        out[index] = sar;
        if (newHigh > extreme) {
          extreme = newHigh;
          factor = Math.min(factor + step, limit);
        }
        sar = Math.min(sar + factor * (extreme - sar), previousLow, newLow);
      }
    } else if (newHigh >= sar) {
      long = true;
      sar = Math.min(extreme, previousLow, newLow);
      out[index] = sar;
      factor = step;
      extreme = newHigh;
      sar = Math.min(sar + factor * (extreme - sar), previousLow, newLow);
    } else {
      out[index] = sar;
      if (newLow < extreme) {
        extreme = newLow;
        factor = Math.min(factor + step, limit);
      }
      sar = Math.max(sar + factor * (extreme - sar), previousHigh, newHigh);
    }
  }
  return out;
};

export type Macd = Readonly<{ macd: Line; signal: Line; histogram: Line }>;

// Both EMAs are seeded at bar slow-1 (TA-Lib MACD); the line starts there.
export const macd = (
  values: readonly number[],
  fast: number,
  slow: number,
  signal: number
): Macd => {
  const fastSpan = period("fast", fast);
  const slowSpan = period("slow", slow);
  const signalSpan = period("signal", signal);
  if (fastSpan >= slowSpan)
    throw new RangeError("fast must be shorter than slow");
  const data = finite(values);
  const start = slowSpan - 1;
  const quick = seededEma(data, fastSpan, start, 2 / (fastSpan + 1));
  const steady = seededEma(data, slowSpan, start, 2 / (slowSpan + 1));
  const line = quick.map((value, index) => {
    const other = steady[index] ?? null;
    return value === null || other === null ? null : value - other;
  });
  const trigger = seededEma(
    line,
    signalSpan,
    start + signalSpan - 1,
    2 / (signalSpan + 1)
  );
  const histogram = line.map((value, index) => {
    const other = trigger[index] ?? null;
    return value === null || other === null ? null : value - other;
  });
  return { histogram, macd: line, signal: trigger };
};

export type Stochastic = Readonly<{ k: Line; d: Line }>;

// Slow stochastic with SMA smoothing (TA-Lib STOCH). A zero range gives raw %K 50.
export const stochastic = (
  input: OhlcInput,
  kPeriod: number,
  kSmoothing: number,
  dPeriod: number
): Stochastic => {
  const { high, low, close } = bars(input);
  const kSpan = period("kPeriod", kPeriod);
  const smoothSpan = period("kSmoothing", kSmoothing);
  const dSpan = period("dPeriod", dPeriod);
  const raw = empty(close.length);
  for (let index = kSpan - 1; index < close.length; index += 1) {
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let inner = index - kSpan + 1; inner <= index; inner += 1) {
      highest = Math.max(highest, valueAt(high, inner));
      lowest = Math.min(lowest, valueAt(low, inner));
    }
    const spread = highest - lowest;
    raw[index] =
      spread === 0 ? 50 : (100 * (valueAt(close, index) - lowest)) / spread;
  }
  const kFirst = kSpan + smoothSpan - 2;
  const k = rollingMean(raw, smoothSpan, kFirst);
  return { d: rollingMean(k, dSpan, kFirst + dSpan - 1), k };
};

export type Directional = Readonly<{ plusDi: Line; minusDi: Line; adx: Line }>;

// Directional movement and true range of bar `index` against bar `index - 1`.
const directionalMove = (
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  index: number
) => {
  const upMove = valueAt(high, index) - valueAt(high, index - 1);
  const downMove = valueAt(low, index - 1) - valueAt(low, index);
  const previous = valueAt(close, index - 1);
  return {
    minusMove: downMove > 0 && downMove > upMove ? downMove : 0,
    plusMove: upMove > 0 && upMove > downMove ? upMove : 0,
    range: Math.max(
      valueAt(high, index) - valueAt(low, index),
      Math.abs(valueAt(high, index) - previous),
      Math.abs(valueAt(low, index) - previous)
    ),
  };
};

// Wilder +DI/-DI/ADX with TA-Lib smoothing: seed sums over bars 1..n-1.
export const adx = (input: OhlcInput, length: number): Directional => {
  const { high, low, close } = bars(input);
  const span = period("period", length);
  const plusDi = empty(close.length);
  const minusDi = empty(close.length);
  const line = empty(close.length);
  let plusSum = 0;
  let minusSum = 0;
  let rangeSum = 0;
  let dxTotal = 0;
  let average: number | null = null;
  for (let index = 1; index < close.length; index += 1) {
    const { plusMove, minusMove, range } = directionalMove(
      high,
      low,
      close,
      index
    );
    if (index < span) {
      plusSum += plusMove;
      minusSum += minusMove;
      rangeSum += range;
      continue;
    }
    plusSum += plusMove - plusSum / span;
    minusSum += minusMove - minusSum / span;
    rangeSum += range - rangeSum / span;
    const plus = rangeSum === 0 ? 0 : (100 * plusSum) / rangeSum;
    const minus = rangeSum === 0 ? 0 : (100 * minusSum) / rangeSum;
    plusDi[index] = plus;
    minusDi[index] = minus;
    const total = plus + minus;
    const dx = total === 0 ? 0 : (100 * Math.abs(plus - minus)) / total;
    if (index < 2 * span - 1) dxTotal += dx;
    else {
      average =
        average === null
          ? (dxTotal + dx) / span
          : (average * (span - 1) + dx) / span;
      line[index] = average;
    }
  }
  return { adx: line, minusDi, plusDi };
};

export type VolumeBar = Readonly<{ timestamp: number; volume: number }>;

const newYorkParts = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

type SessionSlot = Readonly<{ session: string; slot: number }>;

// Session key (New York calendar date) and slot (New York minutes since midnight).
const sessionSlot = (timestamp: number): SessionSlot => {
  const part: Record<string, string> = Object.fromEntries(
    newYorkParts.formatToParts(timestamp).map((item) => [item.type, item.value])
  );
  return {
    session: `${part["year"]}-${part["month"]}-${part["day"]}`,
    slot: Number(part["hour"]) * 60 + Number(part["minute"]),
  };
};

interface Session {
  cums: number[];
  slots: number[];
}

// Cumulative session volume through the last bar with slot <= `slot` (0 if none).
const cumAsOf = ({ slots, cums }: Session, slot: number): number => {
  let value = 0;
  for (
    let index = 0;
    index < slots.length && valueAt(slots, index) <= slot;
    index += 1
  )
    value = valueAt(cums, index);
  return value;
};

// Relative volume at time of day: session volume so far divided by the mean
// volume of the previous `lookback` sessions up to the same New York time.
// Bars are taken in input order; they are never sorted. When every session
// has one bar (daily bars), every bar uses slot 0, so the value is volume /
// mean volume of the previous `lookback` bars, also when a fixed UTC bar time
// moves in New York time at a daylight saving change.
export const rvolAtTime = (
  input: readonly VolumeBar[],
  lookback: number
): Line => {
  const span = period("lookback", lookback);
  finite(input.map((bar) => bar.timestamp));
  if (!finite(input.map((bar) => bar.volume)).every((value) => value >= 0))
    throw new RangeError("volume must not be negative");
  const out = empty(input.length);
  const places = input.map((bar) => sessionSlot(bar.timestamp));
  const keys = places.map((place) => place.session);
  const oneBarSessions = keys.every(
    (session, index) => index === 0 || session !== keys[index - 1]
  );
  const sessions: Session[] = [];
  let key: string | null = null;
  let current: Session = { cums: [], slots: [] };
  input.forEach((bar, index) => {
    const place = places[index] as SessionSlot;
    const slot = oneBarSessions ? 0 : place.slot;
    if (place.session !== key) {
      key = place.session;
      current = { cums: [], slots: [] };
      sessions.push(current);
    }
    const cum = (current.cums.at(-1) ?? 0) + bar.volume;
    current.cums.push(cum);
    current.slots.push(slot);
    const previous = sessions.slice(-1 - span, -1);
    if (previous.length < span) return;
    const mean =
      previous.reduce((total, item) => total + cumAsOf(item, slot), 0) / span;
    if (mean > 0) out[index] = cum / mean;
  });
  return out;
};
