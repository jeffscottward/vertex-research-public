/**
 * Trend Trio indicators in TradingView (Pine Script v6) conventions: SuperTrend, Ultimate MA, AlphaTrend,
 * Chandelier Exit and Slingshot, with the Pine building blocks they need.
 *
 * Operation-for-operation port of services/research/indicators/trend.py (same loops, same running-sum
 * order, same comparisons), so both languages give the same IEEE doubles. Reference values:
 * services/research/tests/fixtures/trend-indicator-reference.json. Formulas are re-implemented from their
 * public definitions; no Pine source is copied (authors, URLs and licences are in NOTICE).
 *
 * - Input: finite numbers in chronological order. Output: `Float64Array` of the same length; `NaN` is
 *   Pine's `na` (undefined).
 * - Windowed averages (sma, wma) use the last `length` values that are not `NaN` and are `NaN` at a bar
 *   whose own input is `NaN`.
 * - `rma` and `ema` start with the simple mean of the first `length` defined values, then recurse.
 * - `atr` uses a true range whose first bar is high - low; AlphaTrend uses the plain `ta.tr` (`NaN` on
 *   the first bar) and its simple mean.
 * - Directions use +1 for up and -1 for down (Slingshot: 0 when the averages are equal). Pine's own
 *   `ta.supertrend` returns the opposite sign; the script built-in keeps Pine's sign.
 */

export type Series = readonly number[] | Float64Array;
export const MA_TYPES = [
  "sma",
  "ema",
  "wma",
  "hull",
  "vwma",
  "rma",
  "tema",
  "t3",
] as const;
export type MaType = (typeof MA_TYPES)[number];
export type Momentum = "mfi" | "rsi";
export const MAX_LENGTH = 2000;

// Reads in range; out of range is NaN (no branch, same double otherwise).
const at = (src: Series, index: number): number => Number(src[index]);

const checkLength = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LENGTH) {
    throw new RangeError(`${name} must be an integer from 1 to ${MAX_LENGTH}`);
  }
  return value;
};

const checkPositive = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
};

const sameLength = (first: Series, ...rest: readonly Series[]): number => {
  const size = first.length;
  if (rest.some((s) => s.length !== size)) {
    throw new RangeError("input series must have the same length");
  }
  return size;
};

// Python's max/min of two: the first argument unless the second is strictly larger/smaller.
const pyMax = (a: number, b: number): number => (b > a ? b : a);
const pyMin = (a: number, b: number): number => (b < a ? b : a);
const nz = (x: number, fallback = 0): number =>
  Number.isNaN(x) ? fallback : x;

/** Pine `ta.sma`: mean of the last `length` defined values (running sum, oldest value removed). */
export const sma = (src: Series, length: number): Float64Array => {
  const span = checkLength("length", length);
  const out = new Float64Array(src.length).fill(Number.NaN);
  const window: number[] = [];
  let head = 0;
  let total = 0;
  for (let i = 0; i < src.length; i += 1) {
    const x = at(src, i);
    if (Number.isNaN(x)) continue;
    window.push(x);
    total += x;
    if (window.length - head > span) {
      total -= at(window, head);
      head += 1;
    }
    if (window.length - head === span) out[i] = total / span;
  }
  return out;
};

/** Pine `ta.wma`: weights 1..length over the last `length` defined values, the newest heaviest. */
export const wma = (src: Series, length: number): Float64Array => {
  const span = checkLength("length", length);
  const out = new Float64Array(src.length).fill(Number.NaN);
  const window: number[] = [];
  let head = 0;
  const divisor = (span * (span + 1)) / 2;
  for (let i = 0; i < src.length; i += 1) {
    const x = at(src, i);
    if (Number.isNaN(x)) continue;
    window.push(x);
    if (window.length - head > span) head += 1;
    if (window.length - head === span) {
      let weighted = 0;
      for (let k = 0; k < span; k += 1) {
        weighted += (k + 1) * at(window, head + k);
      }
      out[i] = weighted / divisor;
    }
  }
  return out;
};

const recursive = (
  src: Series,
  length: number,
  alpha: number
): Float64Array => {
  const seed = sma(src, length);
  const out = new Float64Array(src.length).fill(Number.NaN);
  let previous = Number.NaN;
  for (let i = 0; i < src.length; i += 1) {
    out[i] = Number.isNaN(previous)
      ? at(seed, i)
      : alpha * at(src, i) + (1 - alpha) * previous;
    previous = at(out, i);
  }
  return out;
};

/** Pine `ta.rma` (Wilder): alpha 1/length, seeded with the simple mean. */
export const rma = (src: Series, length: number): Float64Array => {
  const span = checkLength("length", length);
  return recursive(src, span, 1 / span);
};

/** Pine `ta.ema`: alpha 2/(length + 1), seeded with the simple mean. */
export const ema = (src: Series, length: number): Float64Array => {
  const span = checkLength("length", length);
  return recursive(src, span, 2 / (span + 1));
};

/** Pine `ta.tr(handleNa)`: the first bar is high - low when `handleNa` is true, else `NaN`. */
export const trueRange = (
  high: Series,
  low: Series,
  close: Series,
  handleNa: boolean
): Float64Array => {
  const size = sameLength(high, low, close);
  const out = new Float64Array(size).fill(Number.NaN);
  for (let i = 0; i < size; i += 1) {
    if (i === 0) {
      out[i] = handleNa ? at(high, i) - at(low, i) : Number.NaN;
    } else {
      const previous = at(close, i - 1);
      out[i] = pyMax(
        pyMax(at(high, i) - at(low, i), Math.abs(at(high, i) - previous)),
        Math.abs(at(low, i) - previous)
      );
    }
  }
  return out;
};

/** Pine `ta.atr`: rma of the true range whose first bar is high - low. */
export const atr = (
  high: Series,
  low: Series,
  close: Series,
  length: number
): Float64Array => rma(trueRange(high, low, close, true), length);

const extreme = (
  src: Series,
  length: number,
  dominated: (kept: number, x: number) => boolean
): Float64Array => {
  const span = checkLength("length", length);
  const out = new Float64Array(src.length).fill(Number.NaN);
  const keep: number[] = [];
  let head = 0;
  for (let i = 0; i < src.length; i += 1) {
    const x = at(src, i);
    while (
      keep.length > head &&
      dominated(at(src, at(keep, keep.length - 1)), x)
    ) {
      keep.pop();
    }
    keep.push(i);
    if (at(keep, head) <= i - span) head += 1;
    if (i >= span - 1) out[i] = at(src, at(keep, head));
  }
  return out;
};

/** Pine `ta.highest`: highest of the last `length` values (`NaN` before `length` bars). */
export const highest = (src: Series, length: number): Float64Array =>
  extreme(src, length, (kept, x) => kept <= x);

/** Pine `ta.lowest`: lowest of the last `length` values (`NaN` before `length` bars). */
export const lowest = (src: Series, length: number): Float64Array =>
  extreme(src, length, (kept, x) => kept >= x);

const oscillator = (up: number, down: number): number => {
  if (down === 0) return up > 0 ? 100 : Number.NaN;
  return 100 - 100 / (1 + up / down);
};

/** Pine `ta.mfi`: rising flow sums volume x src on bars where src rose, falling flow where it fell. */
export const mfi = (
  src: Series,
  volume: Series,
  length: number
): Float64Array => {
  const size = sameLength(src, volume);
  const up = new Float64Array(size).fill(Number.NaN);
  const down = new Float64Array(size).fill(Number.NaN);
  const upBars = new Float64Array(size).fill(Number.NaN);
  const downBars = new Float64Array(size).fill(Number.NaN);
  for (let i = 1; i < size; i += 1) {
    const change = at(src, i) - at(src, i - 1);
    up[i] = change <= 0 ? 0 : at(volume, i) * at(src, i);
    down[i] = change >= 0 ? 0 : at(volume, i) * at(src, i);
    upBars[i] = at(up, i) > 0 ? 1 : 0;
    downBars[i] = at(down, i) > 0 ? 1 : 0;
  }
  const span = checkLength("length", length);
  const sumUp = sma(up, span);
  const sumDown = sma(down, span);
  // A window without any rising (falling) flow has a flow of exactly 0; the running sum can leave a remainder.
  const anyUp = sma(upBars, span);
  const anyDown = sma(downBars, span);
  const out = new Float64Array(size).fill(Number.NaN);
  for (let i = 0; i < size; i += 1) {
    if (!Number.isNaN(at(sumUp, i))) {
      const upper = at(anyUp, i) === 0 ? 0 : at(sumUp, i) * span;
      const lower = at(anyDown, i) === 0 ? 0 : at(sumDown, i) * span;
      out[i] = oscillator(upper, lower);
    }
  }
  return out;
};

/** Pine `ta.rsi`: Wilder averages of gains and losses from the second bar. */
export const rsi = (src: Series, length: number): Float64Array => {
  const size = src.length;
  const gains = new Float64Array(size).fill(Number.NaN);
  const losses = new Float64Array(size).fill(Number.NaN);
  for (let i = 1; i < size; i += 1) {
    gains[i] = pyMax(at(src, i) - at(src, i - 1), 0);
    losses[i] = pyMax(at(src, i - 1) - at(src, i), 0);
  }
  const avgUp = rma(gains, length);
  const avgDown = rma(losses, length);
  const out = new Float64Array(size).fill(Number.NaN);
  for (let i = 0; i < size; i += 1) {
    const u = at(avgUp, i);
    if (!Number.isNaN(u)) out[i] = oscillator(u, at(avgDown, i));
  }
  return out;
};

export type SuperTrend = Readonly<{
  line: Float64Array;
  direction: Float64Array;
}>;

/** Pine `ta.supertrend(factor, length)`: line and direction (+1 up / -1 down), `NaN` while the ATR is. */
export const supertrend = (
  high: Series,
  low: Series,
  close: Series,
  length = 10,
  factor = 3
): SuperTrend => {
  const size = sameLength(high, low, close);
  const mult = checkPositive("factor", factor);
  const atrS = atr(high, low, close, length);
  const line = new Float64Array(size).fill(Number.NaN);
  const direction = new Float64Array(size).fill(Number.NaN);
  let prevLower = Number.NaN;
  let prevUpper = Number.NaN;
  let prevLine = Number.NaN;
  for (let i = 0; i < size; i += 1) {
    const a = at(atrS, i);
    const mid = (at(high, i) + at(low, i)) / 2;
    let upper = mid + mult * a;
    let lower = mid - mult * a;
    const pLower = nz(prevLower);
    const pUpper = nz(prevUpper);
    const closePrev = i > 0 ? at(close, i - 1) : Number.NaN;
    if (!(lower > pLower || closePrev < pLower)) lower = pLower;
    if (!(upper < pUpper || closePrev > pUpper)) upper = pUpper;
    let up: boolean;
    if (i === 0 || Number.isNaN(at(atrS, i - 1))) up = false;
    else if (prevLine === pUpper) up = at(close, i) > upper;
    else up = !(at(close, i) < lower);
    const value = up ? lower : upper;
    if (!Number.isNaN(a)) {
      line[i] = value;
      direction[i] = up ? 1 : -1;
    }
    prevLower = lower;
    prevUpper = upper;
    prevLine = value;
  }
  return { direction, line };
};

const hull = (src: Series, length: number): Float64Array => {
  const half = wma(src, Math.max(Math.floor(length / 2), 1));
  const full = wma(src, length);
  const inner = half.map((h, i) => 2 * h - at(full, i));
  return wma(inner, Math.max(Math.round(Math.sqrt(length)), 1));
};

const tilson = (src: Series, length: number, factor: number): Float64Array => {
  const e1 = ema(src, length);
  const e2 = ema(e1, length);
  return e1.map((x, i) => x * (1 + factor) - at(e2, i) * factor);
};

/** The eight averages of CM_Ultimate_MA_MTF_V2: 1 sma, 2 ema, 3 wma, 4 hull, 5 vwma, 6 rma, 7 tema, 8 t3. */
export const movingAverage = (
  close: Series,
  volume: Series | null,
  maType: MaType,
  length: number,
  t3Factor = 0.7
): Float64Array => {
  const span = checkLength("length", length);
  switch (maType) {
    case "sma":
      return sma(close, span);
    case "ema":
      return ema(close, span);
    case "wma":
      return wma(close, span);
    case "hull":
      return hull(close, span);
    case "vwma": {
      if (volume === null) throw new RangeError("vwma needs volume");
      sameLength(close, volume);
      const weighted = sma(
        Float64Array.from(close, (x, i) => x * at(volume, i)),
        span
      );
      const base = sma(volume, span);
      return weighted.map((w, i) =>
        at(base, i) === 0 ? Number.NaN : w / at(base, i)
      );
    }
    case "rma":
      return rma(close, span);
    case "tema": {
      const e1 = ema(close, span);
      const e2 = ema(e1, span);
      const e3 = ema(e2, span);
      return e1.map((x, i) => 3 * (x - at(e2, i)) + at(e3, i));
    }
    case "t3": {
      const factor = checkPositive("t3_factor", t3Factor);
      return tilson(
        tilson(tilson(close, span, factor), span, factor),
        span,
        factor
      );
    }
    default:
      throw new RangeError(`ma_type must be one of ${MA_TYPES.join(", ")}`);
  }
};

export type UltimateMa = Readonly<{
  value: Float64Array;
  direction: Float64Array;
}>;

/** Ultimate MA: value and direction (+1 when the value is >= its value `smoothing` bars ago, else -1). */
export const ultimateMa = (
  close: Series,
  volume: Series | null,
  maType: MaType = "sma",
  length = 20,
  smoothing = 2,
  t3Factor = 0.7
): UltimateMa => {
  const lag = checkLength("smoothing", smoothing);
  const value = movingAverage(close, volume, maType, length, t3Factor);
  const direction = new Float64Array(value.length).fill(Number.NaN);
  for (let i = lag; i < value.length; i += 1) {
    const now = at(value, i);
    const then = at(value, i - lag);
    if (!(Number.isNaN(now) || Number.isNaN(then))) {
      direction[i] = now >= then ? 1 : -1;
    }
  }
  return { direction, value };
};

export type AlphaTrend = Readonly<{
  line: Float64Array;
  direction: Float64Array;
}>;

// AlphaTrend's momentum: MFI of hlc3 with volume, or RSI of close.
const momentumOf = (
  high: Series,
  low: Series,
  close: Series,
  volume: Series | null,
  span: number,
  momentum: Momentum
): Float64Array => {
  if (momentum === "rsi") return rsi(close, span);
  if (momentum !== "mfi") {
    throw new RangeError("momentum must be mfi or rsi");
  }
  if (volume === null) {
    throw new RangeError(
      "AlphaTrend momentum mfi needs volume; use momentum rsi"
    );
  }
  sameLength(close, volume);
  const hlc3 = Float64Array.from(
    high,
    (h, i) => (h + at(low, i) + at(close, i)) / 3
  );
  return mfi(hlc3, volume, span);
};

// +1 when the line is above its value 2 bars ago, -1 below, else by the line 1 bar ago
// against 3 bars ago; NaN until 4 defined values.
const alphaDirection = (line: Float64Array): Float64Array => {
  const direction = new Float64Array(line.length).fill(Number.NaN);
  for (let i = 3; i < line.length; i += 1) {
    const a0 = at(line, i);
    const a1 = at(line, i - 1);
    const a2 = at(line, i - 2);
    const a3 = at(line, i - 3);
    if (
      Number.isNaN(a0) ||
      Number.isNaN(a1) ||
      Number.isNaN(a2) ||
      Number.isNaN(a3)
    ) {
      continue;
    }
    if (a0 > a2) direction[i] = 1;
    else if (a0 < a2) direction[i] = -1;
    else direction[i] = a1 > a3 ? 1 : -1;
  }
  return direction;
};

/**
 * AlphaTrend line and direction. Momentum `mfi` (MFI of hlc3, needs volume) or `rsi` (RSI of close),
 * bullish at >= 50. Direction: +1 when the line is above its value 2 bars ago, -1 below, else +1 when
 * the line 1 bar ago is above its value 3 bars ago, else -1 (`NaN` until 4 defined values).
 */
export const alphaTrend = (
  high: Series,
  low: Series,
  close: Series,
  volume: Series | null,
  length = 14,
  coeff = 1,
  momentum: Momentum = "mfi"
): AlphaTrend => {
  const size = sameLength(high, low, close);
  const span = checkLength("length", length);
  const mult = checkPositive("coeff", coeff);
  const mom = momentumOf(high, low, close, volume, span, momentum);
  const band = sma(trueRange(high, low, close, false), span);
  const line = new Float64Array(size).fill(Number.NaN);
  let previous = Number.NaN;
  for (let i = 0; i < size; i += 1) {
    const prev = nz(previous);
    let value: number;
    if (at(mom, i) >= 50) {
      const upT = at(low, i) - at(band, i) * mult;
      value = upT < prev ? prev : upT;
    } else {
      const downT = at(high, i) + at(band, i) * mult;
      value = downT > prev ? prev : downT;
    }
    line[i] = value;
    previous = value;
  }
  return { direction: alphaDirection(line), line };
};

export type ChandelierExit = Readonly<{
  longStop: Float64Array;
  shortStop: Float64Array;
  direction: Float64Array;
}>;

/**
 * Chandelier Exit: long stop = highest high - multiple x ATR, raised while the previous close stays above
 * the previous long stop; short stop mirrors it; direction starts +1, turns +1 when the close is above
 * the previous short stop and -1 when it is below the previous long stop.
 */
export const chandelierExit = (
  high: Series,
  low: Series,
  close: Series,
  length = 22,
  multiple = 3
): ChandelierExit => {
  const size = sameLength(high, low, close);
  const mult = checkPositive("multiple", multiple);
  const atrS = atr(high, low, close, length);
  const top = highest(high, length);
  const bottom = lowest(low, length);
  const longStop = new Float64Array(size).fill(Number.NaN);
  const shortStop = new Float64Array(size).fill(Number.NaN);
  const direction = new Float64Array(size).fill(Number.NaN);
  let state = 1;
  for (let i = 0; i < size; i += 1) {
    const band = mult * at(atrS, i);
    let longNow = at(top, i) - band;
    let shortNow = at(bottom, i) + band;
    const longPrev = i > 0 ? nz(at(longStop, i - 1), longNow) : longNow;
    const shortPrev = i > 0 ? nz(at(shortStop, i - 1), shortNow) : shortNow;
    const closePrev = i > 0 ? at(close, i - 1) : Number.NaN;
    if (closePrev > longPrev) longNow = pyMax(longNow, longPrev);
    if (closePrev < shortPrev) shortNow = pyMin(shortNow, shortPrev);
    longStop[i] = longNow;
    shortStop[i] = shortNow;
    if (at(close, i) > shortPrev) state = 1;
    else if (at(close, i) < longPrev) state = -1;
    if (!Number.isNaN(longNow)) direction[i] = state;
  }
  return { direction, longStop, shortStop };
};

export type Slingshot = Readonly<{
  fast: Float64Array;
  slow: Float64Array;
  direction: Float64Array;
}>;

/** Slingshot: fast EMA, slow EMA and direction (+1 / -1 / 0 when equal). */
export const slingshot = (close: Series, fast = 38, slow = 62): Slingshot => {
  const quick = ema(close, fast);
  const steady = ema(close, slow);
  const direction = new Float64Array(close.length).fill(Number.NaN);
  for (let i = 0; i < close.length; i += 1) {
    const q = at(quick, i);
    const s = at(steady, i);
    if (!(Number.isNaN(q) || Number.isNaN(s))) {
      direction[i] = q > s ? 1 : q < s ? -1 : 0;
    }
  }
  return { direction, fast: quick, slow: steady };
};
