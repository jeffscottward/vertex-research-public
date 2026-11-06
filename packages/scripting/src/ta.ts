// Technical-analysis kernels over one call site's state (Site). Each call records the current
// bar's inputs and returns the current bar's output; formulas follow the public Pine
// reference definitions (Wilder RMA seeded with an SMA, population standard deviation),
// with the one documented exception of the ema seed (see smoothed).

import type { Series, Site } from "./series.ts";

type Num = number | null;

// The last `len` recorded values, newest first; null if fewer exist or any is na.
const windowOf = (series: Series, len: number): number[] | null => {
  if (series.length < len) return null;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const value = series.back(i);
    if (typeof value !== "number") return null;
    out.push(value);
  }
  return out;
};

const mean = (values: readonly number[]): number => {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
};

export const sma = (
  site: Site,
  bar: number,
  key: string,
  src: Num,
  len: number
): Num => {
  const window = windowOf(site.record(key, bar, src), len);
  return window ? mean(window) : null;
};

// Exponential smoothing: next = alpha * src + (1 - alpha) * prev.
//
// Seeding: both ema and rma start from the SMA of the first `len` non-na values, so they are
// na for the first len - 1 bars. For ta.rma this is exactly the Pine reference code
// (`sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])`).
// The Pine reference example for ta.ema (`pine_ema`) seeds with the first source value
// instead; Vertex keeps the SMA seed for ema too, so its first few dozen values can differ
// slightly from that example before the two converge (the seed's weight decays by
// (1 - alpha) per bar).
//
// na mid-series (a known difference): an na input outputs na and leaves the running value
// untouched, and the next non-na input continues from it. In the Pine reference code the na
// propagates into sum, so na(sum[1]) re-seeds from ta.sma once `length` clean values exist
// again. Before the first seed, an na restarts the SMA window here too (windowOf needs
// `len` consecutive non-na values).
const smoothed = (
  site: Site,
  bar: number,
  key: string,
  src: Num,
  len: number,
  alpha: number
): Num => {
  const history = site.record(`${key}.src`, bar, src);
  const prev = site.previous<Num>(key, bar, null);
  let next: Num;
  if (src === null) next = prev;
  else if (prev === null) {
    const window = windowOf(history, len);
    next = window ? mean(window) : null;
  } else next = alpha * src + (1 - alpha) * prev;
  site.store(key, next);
  return src === null ? null : next;
};

export const ema = (
  site: Site,
  bar: number,
  key: string,
  src: Num,
  len: number
) => smoothed(site, bar, key, src, len, 2 / (len + 1));

export const rma = (
  site: Site,
  bar: number,
  key: string,
  src: Num,
  len: number
) => smoothed(site, bar, key, src, len, 1 / len);

export const wma = (site: Site, bar: number, src: Num, len: number): Num => {
  const window = windowOf(site.record("wma", bar, src), len);
  if (!window) return null;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += (window[i] ?? 0) * (len - i);
  return sum / ((len * (len + 1)) / 2);
};

export const vwma = (
  site: Site,
  bar: number,
  src: Num,
  volume: number,
  len: number
): Num => {
  const weighted = sma(
    site,
    bar,
    "pv",
    src === null ? null : src * volume,
    len
  );
  const vol = sma(site, bar, "v", volume, len);
  return weighted === null || vol === null || vol === 0 ? null : weighted / vol;
};

export const rsi = (site: Site, bar: number, src: Num, len: number): Num => {
  const prev = site.record("x", bar, src).back(1);
  const ok = src !== null && typeof prev === "number";
  const up = ok ? Math.max(src - prev, 0) : null;
  const down = ok ? Math.max(prev - src, 0) : null;
  const avgUp = rma(site, bar, "up", up, len);
  const avgDown = rma(site, bar, "down", down, len);
  if (avgUp === null || avgDown === null) return null;
  if (avgDown === 0) return 100;
  if (avgUp === 0) return 0;
  return 100 - 100 / (1 + avgUp / avgDown);
};

const stdevOf = (window: readonly number[]): number => {
  const avg = mean(window);
  let sum = 0;
  for (const value of window) sum += (value - avg) ** 2;
  return Math.sqrt(sum / window.length);
};

export const stdev = (site: Site, bar: number, src: Num, len: number): Num => {
  const window = windowOf(site.record("src", bar, src), len);
  return window ? stdevOf(window) : null;
};

export const extreme = (
  site: Site,
  bar: number,
  src: Num,
  len: number,
  pick: (a: number, b: number) => number
): Num => {
  const window = windowOf(site.record("src", bar, src), len);
  if (!window) return null;
  return window.reduce((a, b) => pick(a, b));
};

// src - src[len], over this call site's own history.
export const change = (site: Site, bar: number, src: Num, len: number): Num => {
  const past = site.record("src", bar, src).back(len);
  return src === null || typeof past !== "number" ? null : src - past;
};

export const roc = (site: Site, bar: number, src: Num, len: number): Num => {
  const past = site.record("src", bar, src).back(len);
  if (src === null || typeof past !== "number" || past === 0) return null;
  return (100 * (src - past)) / past;
};

export type CrossKind = "over" | "under" | "any";

export const cross = (
  site: Site,
  bar: number,
  a: Num,
  b: Num,
  kind: CrossKind
): boolean => {
  const sa = site.record("a", bar, a);
  const sb = site.record("b", bar, b);
  const a1 = sa.back(1);
  const b1 = sb.back(1);
  if (
    a === null ||
    b === null ||
    typeof a1 !== "number" ||
    typeof b1 !== "number"
  )
    return false;
  const over = a > b && a1 <= b1;
  const under = a < b && a1 >= b1;
  if (kind === "over") return over;
  if (kind === "under") return under;
  return over || under;
};

export const macd = (
  site: Site,
  bar: number,
  src: Num,
  fast: number,
  slow: number,
  signal: number
): [Num, Num, Num] => {
  const f = ema(site, bar, "fast", src, fast);
  const s = ema(site, bar, "slow", src, slow);
  const line = f === null || s === null ? null : f - s;
  const sig = ema(site, bar, "signal", line, signal);
  const hist = line === null || sig === null ? null : line - sig;
  return [line, sig, hist];
};

export const bb = (
  site: Site,
  bar: number,
  src: Num,
  len: number,
  mult: number
): [Num, Num, Num] => {
  const window = windowOf(site.record("src", bar, src), len);
  if (!window) return [null, null, null];
  const basis = mean(window);
  const dev = mult * stdevOf(window);
  return [basis, basis + dev, basis - dev];
};

export const stoch = (
  site: Site,
  bar: number,
  src: Num,
  high: Num,
  low: Num,
  len: number
): Num => {
  site.record("src", bar, src);
  const highs = windowOf(site.record("high", bar, high), len);
  const lows = windowOf(site.record("low", bar, low), len);
  if (src === null || !highs || !lows) return null;
  const hh = Math.max(...highs);
  const ll = Math.min(...lows);
  return hh === ll ? null : (100 * (src - ll)) / (hh - ll);
};

export const cci = (site: Site, bar: number, src: Num, len: number): Num => {
  const window = windowOf(site.record("src", bar, src), len);
  if (src === null || !window) return null;
  const avg = mean(window);
  let dev = 0;
  for (const value of window) dev += Math.abs(value - avg);
  dev /= len;
  return dev === 0 ? null : (src - avg) / (0.015 * dev);
};

// Pivot at `right` bars back: strictly above every left-side value and at least every
// right-side value (so a flat top yields one pivot). Low pivots mirror it.
export const pivot = (
  site: Site,
  bar: number,
  src: Num,
  left: number,
  right: number,
  high: boolean
): Num => {
  const window = windowOf(site.record("src", bar, src), left + right + 1);
  if (!window) return null;
  const center = window[right] ?? 0;
  for (let i = 0; i < window.length; i++) {
    if (i === right) continue;
    const value = window[i] ?? 0;
    const leftSide = i > right;
    const beaten = high
      ? value > center || (leftSide && value === center)
      : value < center || (leftSide && value === center);
    if (beaten) return null;
  }
  return center;
};

// Source values from the bars where `cond` held, newest last: occurrence n is O(1).
export const valuewhen = (
  site: Site,
  bar: number,
  cond: boolean,
  src: Num,
  occurrence: number
): Num => {
  const hits = site.series("hits");
  if (cond) hits.set(bar, src);
  const value = hits.back(occurrence);
  return typeof value === "number" ? value : null;
};

export const barssince = (site: Site, bar: number, cond: boolean): Num => {
  const prev = site.previous<Num>("count", bar, null);
  const next = cond ? 0 : prev === null ? null : prev + 1;
  site.store("count", next);
  return next;
};

// Running total; na contributes nothing.
export const cum = (site: Site, bar: number, src: Num): number => {
  const total = site.previous("sum", bar, 0) + (src ?? 0);
  site.store("sum", total);
  return total;
};

export const sum = (site: Site, bar: number, src: Num, len: number): Num => {
  const window = windowOf(site.record("src", bar, src), len);
  return window ? window.reduce((a, b) => a + b, 0) : null;
};

// Last non-na value seen at this call site.
export const fixnan = (site: Site, bar: number, src: Num): Num => {
  const last = site.previous<Num>("last", bar, null);
  const next = src ?? last;
  site.store("last", next);
  return next;
};
