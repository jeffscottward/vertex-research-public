// What: Seeded models behind the trading quant scenes: a cointegrated pair traded on a rolling
// z-score, a walk-forward Sharpe landscape of that rule over a spread whose mean-reversion speed
// drifts, and a static limit order book swept by a market buy. Pure functions of the param values.
import { gaussian, mulberry32 } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import { grid, nth } from "../scene-kit.ts";

const TRADING_DAYS = 252;
/** Shares of a bought or sold per share of b (the pair's known hedge ratio). */
export const PAIR_HEDGE = 1.2;
/** Shares of b in one unit of the spread position. */
export const PAIR_UNITS = 100;
/** Stationary standard deviation of the pair spread in dollars per share. */
const PAIR_SPREAD_SD = 2.5;
/** Daily volatility of stock a. */
const PAIR_DAILY_VOL = 0.015;

const bounded = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** Spread position after the close of a day: +1 long spread, -1 short spread, 0 flat. */
export const zRule = (
  position: number,
  z: number,
  entry: number,
  exit: number
): number => {
  if (position === 0) {
    if (z >= entry) return -1;
    if (z <= -entry) return 1;
    return 0;
  }
  if (position < 0) return z <= exit ? 0 : -1;
  return z >= -exit ? 0 : 1;
};

/**
 * Rolling z-score of each value against the `lookback` values before it: the mean and sample sd
 * (n - 1) of the previous L days, excluding today, so a sudden jump is not diluted by itself
 * (NaN before L earlier values exist).
 */
export const rollingZ = (
  values: readonly number[],
  lookback: number
): number[] => {
  const size = Math.max(Math.round(lookback), 2);
  let sum = 0;
  let squares = 0;
  return values.map((value, index) => {
    let score = Number.NaN;
    if (index >= size) {
      const mean = sum / size;
      const variance = Math.max((squares - size * mean * mean) / (size - 1), 0);
      const sd = Math.sqrt(variance);
      score = sd > 1e-9 ? (value - mean) / sd : 0;
      const old = nth(values, index - size);
      sum -= old;
      squares -= old * old;
    }
    sum += value;
    squares += value * value;
    return score;
  });
};

/** Cells of a Sharpe surface that lose money: Sharpe strictly below 0 (0 means it never traded). */
export const losingCells = (sharpes: readonly number[]): number =>
  sharpes.filter((value) => value < 0).length;

/** Annualized Sharpe ratio of daily returns (0 when they never vary). */
export const sharpe = (returns: readonly number[]): number => {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 1e-9 ? (mean / sd) * Math.sqrt(TRADING_DAYS) : 0;
};

export type PairsInputs = Readonly<{
  halfLife: number;
  entryZ: number;
  exitZ: number;
  lookback: number;
  costBps: number;
  days: number;
  seed: number;
}>;

export const pairsInputs = (values: ParamValues): PairsInputs => {
  const entryZ = bounded(num(values, "entryZ", 2), 0.25, 5);
  return {
    costBps: bounded(num(values, "costBps", 5), 0, 200),
    days: Math.round(bounded(num(values, "days", 250), 60, 1000)),
    entryZ,
    exitZ: bounded(num(values, "exitZ", 0.5), -entryZ, entryZ * 0.9),
    halfLife: bounded(num(values, "halfLife", 10), 1, 250),
    lookback: Math.round(bounded(num(values, "lookback", 30), 5, 120)),
    seed: Math.round(num(values, "seed", 7)),
  };
};

export type RoundTrip = Readonly<{
  side: 1 | -1;
  entryDay: number;
  entryZ: number;
  /** Exit day and z-score; null while the position is still open on the last day. */
  exit: Readonly<{ day: number; z: number }> | null;
  /** P&L after costs from the entry to the exit (or the last day while open). */
  pnl: number;
}>;

export type PairsPath = Readonly<{
  inputs: PairsInputs;
  a: number[];
  b: number[];
  spread: number[];
  z: number[];
  position: number[];
  /** Cumulative strategy P&L after costs in dollars (one unit = 100 shares of b). */
  pnl: number[];
  /** Cumulative trading costs in dollars. */
  costs: number[];
  trips: RoundTrip[];
}>;

/** Seeded pair: a is a random walk, b = hedge·a + an Ornstein-Uhlenbeck spread, traded on z. */
export const pairsPath = (values: ParamValues): PairsPath => {
  const inputs = pairsInputs(values);
  const random = mulberry32(inputs.seed);
  const phi = 0.5 ** (1 / inputs.halfLife);
  const shock = PAIR_SPREAD_SD * Math.sqrt(1 - phi * phi);
  const a = [100];
  const spread = [PAIR_SPREAD_SD * 0.5 * gaussian(random)];
  for (let day = 1; day <= inputs.days; day += 1) {
    a.push(
      nth(a, -1) *
        Math.exp(-0.5 * PAIR_DAILY_VOL ** 2 + PAIR_DAILY_VOL * gaussian(random))
    );
    spread.push(phi * nth(spread, -1) + shock * gaussian(random));
  }
  const b = a.map((price, day) => PAIR_HEDGE * price + nth(spread, day));
  const z = rollingZ(spread, inputs.lookback);
  const position: number[] = [];
  const pnl: number[] = [];
  const costs: number[] = [];
  let trips: RoundTrip[] = [];
  const rate = inputs.costBps / 10_000;
  z.forEach((score, day) => {
    const before = day === 0 ? 0 : nth(position, day - 1);
    const after = Number.isNaN(score)
      ? 0
      : zRule(before, score, inputs.entryZ, inputs.exitZ);
    position.push(after);
    const notional = (nth(b, day) + PAIR_HEDGE * nth(a, day)) * PAIR_UNITS;
    const cost = Math.abs(after - before) * rate * notional;
    const move =
      day === 0 ? 0 : (nth(spread, day) - nth(spread, day - 1)) * PAIR_UNITS;
    pnl.push((day === 0 ? 0 : nth(pnl, -1)) + before * move - cost);
    costs.push((day === 0 ? 0 : nth(costs, -1)) + cost);
    if (before === 0 && after !== 0)
      trips.push({
        entryDay: day,
        entryZ: score,
        exit: null,
        pnl: 0,
        side: after > 0 ? 1 : -1,
      });
    else if (before !== 0 && after === 0)
      trips = [
        ...trips.slice(0, -1),
        { ...nth(trips, -1), exit: { day, z: score } },
      ];
  });
  trips = trips.map((trip) => ({
    ...trip,
    pnl: nth(pnl, trip.exit?.day ?? inputs.days) - nth(pnl, trip.entryDay - 1),
  }));
  return { a, b, costs, inputs, pnl, position, spread, trips, z };
};

/** Lookbacks (days) and entry thresholds (|z|) of the landscape grid. */
export const LANDSCAPE_LOOKBACKS = [5, 10, 15, 20, 30, 40, 50, 60] as const;
export const LANDSCAPE_ENTRIES = grid(0.5, 2.25, 8);
export const LANDSCAPE_WINDOWS = 16;
/** Days before the first window that fill the longest lookback. */
const LANDSCAPE_WARMUP = 60;
/** Dollars traded per unit of spread position change (two $100 legs). */
const LANDSCAPE_NOTIONAL = 200;
/** Stationary sd of the mean-reverting part of the spread, dollars per $100 leg. */
const LANDSCAPE_SPREAD_SD = 0.5;
/** Daily sd of the spread's random-walk drift, in units of the mean-reverting sd. */
const LANDSCAPE_DRIFT = 0.05;

export type LandscapeInputs = Readonly<{
  window: number;
  costBps: number;
  regimeShift: number;
  seed: number;
}>;

const landscapeInputs = (values: ParamValues): LandscapeInputs => ({
  costBps: bounded(num(values, "costBps", 5), 0, 100),
  regimeShift: bounded(num(values, "regimeShift", 1), 0, 2),
  seed: Math.round(num(values, "seed", 11)),
  window: Math.round(bounded(num(values, "window", 120), 40, 250)),
});

export type Cell = Readonly<{
  lookback: number;
  entry: number;
  /** Position of the cell in the grid: surface[entryIndex][lookbackIndex]. */
  lookbackIndex: number;
  entryIndex: number;
  sharpe: number;
}>;

export type LandscapeWindow = Readonly<{
  index: number;
  /** First and last walk-forward day of the rolling window (day 0 = end of warm-up). */
  start: number;
  end: number;
  /** Spread half-life at the middle of the window, days. */
  halfLife: number;
  /** Annualized Sharpe after costs, surface[entryIndex][lookbackIndex]. */
  surface: number[][];
  /** Best cell in hindsight on this window. */
  best: Cell;
  /** The previous window's best cell (what the model trades now) on this window; null at first. */
  model: Cell | null;
  /** Daily out-of-sample returns of the walk-forward model from the second window to this one. */
  outOfSample: number[];
}>;

export type Landscape = Readonly<{
  inputs: LandscapeInputs;
  /** Walk-forward days covered by all windows. */
  horizon: number;
  /** Days the rolling window moves between refits. */
  step: number;
  windows: LandscapeWindow[];
}>;

/** Half-life of the spread on a day: drifts between fast and slow regimes by regimeShift. */
const halfLifeAt = (
  day: number,
  total: number,
  shift: number,
  phase: number
): number =>
  8 *
  Math.exp(shift * Math.log(4) * Math.sin((2 * Math.PI * day) / total + phase));

/** Daily returns of the z-score rule (exit at the mean) over days [start, end). */
const ruleReturns = (
  spread: readonly number[],
  z: readonly number[],
  start: number,
  end: number,
  entry: number,
  cost: number
): number[] => {
  const returns: number[] = [];
  let position = 0;
  for (let day = start; day < end; day += 1) {
    const next = zRule(position, nth(z, day), entry, 0);
    returns.push(
      position * (nth(spread, day) - nth(spread, day - 1)) -
        Math.abs(next - position) * cost
    );
    position = next;
  }
  return returns;
};

const bestOf = (surface: readonly (readonly number[])[]): Cell => {
  let best = { entryIndex: 0, lookbackIndex: 0 };
  surface.forEach((row, entryIndex) => {
    row.forEach((value, lookbackIndex) => {
      if (value > nth(nth(surface, best.entryIndex), best.lookbackIndex))
        best = { entryIndex, lookbackIndex };
    });
  });
  return cellAt(surface, best.entryIndex, best.lookbackIndex);
};

const cellAt = (
  surface: readonly (readonly number[])[],
  entryIndex: number,
  lookbackIndex: number
): Cell => ({
  entry: nth(LANDSCAPE_ENTRIES, entryIndex),
  entryIndex,
  lookback: nth(LANDSCAPE_LOOKBACKS, lookbackIndex),
  lookbackIndex,
  sharpe: nth(nth(surface, entryIndex), lookbackIndex),
});

/** Walk-forward Sharpe landscapes: one 8×8 surface per window and the lagging model choice. */
export const landscape = (values: ParamValues): Landscape => {
  const inputs = landscapeInputs(values);
  const random = mulberry32(inputs.seed);
  const phase = 2 * Math.PI * random();
  const step = Math.round(inputs.window / 4);
  const horizon = inputs.window + (LANDSCAPE_WINDOWS - 1) * step;
  const total = LANDSCAPE_WARMUP + horizon;
  const halfLife = (day: number) =>
    halfLifeAt(day, total, inputs.regimeShift, phase);
  // Spread = scale · (OU part with the drifting half-life + a slow random-walk drift that a long
  // lookback mistakes for a stretched spread).
  let reverting = gaussian(random);
  let drift = 0;
  const spread = [LANDSCAPE_SPREAD_SD * reverting];
  for (let day = 1; day <= total; day += 1) {
    const phi = 0.5 ** (1 / halfLife(day));
    reverting = phi * reverting + Math.sqrt(1 - phi * phi) * gaussian(random);
    drift += LANDSCAPE_DRIFT * gaussian(random);
    spread.push(LANDSCAPE_SPREAD_SD * (reverting + drift));
  }
  const scores = LANDSCAPE_LOOKBACKS.map((lookback) =>
    rollingZ(spread, lookback)
  );
  const cost = (inputs.costBps / 10_000) * LANDSCAPE_NOTIONAL;
  const windows: LandscapeWindow[] = [];
  for (let index = 0; index < LANDSCAPE_WINDOWS; index += 1) {
    const end = inputs.window + index * step;
    const first = LANDSCAPE_WARMUP + 1 + end - inputs.window;
    const last = LANDSCAPE_WARMUP + 1 + end;
    const surface = LANDSCAPE_ENTRIES.map((entry) =>
      scores.map((z) =>
        sharpe(ruleReturns(spread, z, first, last, entry, cost))
      )
    );
    const previous = windows.at(-1)?.best;
    const newest =
      previous === undefined
        ? []
        : ruleReturns(
            spread,
            nth(scores, previous.lookbackIndex),
            last - step,
            last,
            previous.entry,
            cost
          );
    windows.push({
      best: bestOf(surface),
      end,
      halfLife: halfLife(last - inputs.window / 2),
      index,
      model:
        previous === undefined
          ? null
          : cellAt(surface, previous.entryIndex, previous.lookbackIndex),
      outOfSample: [...(windows.at(-1)?.outOfSample ?? []), ...newest],
      start: end - inputs.window,
      surface,
    });
  }
  return { horizon, inputs, step, windows };
};

export type BookInputs = Readonly<{
  orderSize: number;
  levelSize: number;
  levels: number;
  tickSize: number;
  spreadTicks: number;
  depthGrowth: number;
  mid: number;
}>;

export const bookInputs = (values: ParamValues): BookInputs => {
  const tickSize = bounded(num(values, "tickSize", 0.01), 0.0001, 100);
  const spreadTicks = Math.round(bounded(num(values, "spreadTicks", 3), 1, 50));
  const levels = Math.round(bounded(num(values, "levels", 12), 1, 40));
  return {
    depthGrowth: bounded(num(values, "depthGrowth", 10.3), -50, 200),
    levelSize: Math.round(bounded(num(values, "levelSize", 1690), 1, 1e7)),
    levels,
    mid: Math.max(
      Math.min(num(values, "mid", 97.615), 1e6),
      tickSize * (spreadTicks + 2 * levels + 2)
    ),
    orderSize: Math.round(bounded(num(values, "orderSize", 20_000), 0, 1e12)),
    spreadTicks,
    tickSize,
  };
};

export type BookLevel = Readonly<{ price: number; size: number }>;

export type Book = Readonly<{
  inputs: BookInputs;
  /** Best first. */
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number;
  bestAsk: number;
  mid: number;
  askDepth: number;
}>;

/** Static book: best bid on the tick grid below mid, asks spreadTicks above, sizes growing by level. */
export const orderBook = (values: ParamValues): Book => {
  const inputs = bookInputs(values);
  const tick = inputs.tickSize;
  const bidTicks = Math.round(inputs.mid / tick - inputs.spreadTicks / 2);
  const askTicks = bidTicks + inputs.spreadTicks;
  const size = (level: number) =>
    Math.max(
      Math.round(inputs.levelSize * (1 + inputs.depthGrowth / 100) ** level),
      1
    );
  const levels = Array.from({ length: inputs.levels }, (_, level) => level);
  const bids = levels.map((level) => ({
    price: (bidTicks - level) * tick,
    size: size(level),
  }));
  const asks = levels.map((level) => ({
    price: (askTicks + level) * tick,
    size: size(level),
  }));
  const bestBid = nth(bids, 0).price;
  const bestAsk = nth(asks, 0).price;
  return {
    askDepth: asks.reduce((sum, level) => sum + level.size, 0),
    asks,
    bestAsk,
    bestBid,
    bids,
    inputs,
    mid: (bestBid + bestAsk) / 2,
  };
};

export type Sweep = Readonly<{
  filled: number;
  /** Shares of the order the book could not fill. */
  unfilled: number;
  /** Volume-weighted fill price (the best ask before any share fills). */
  average: number;
  /** Shares taken at each ask level, best first. */
  taken: number[];
  levelsTouched: number;
  /** Price of the last level touched (best ask before any share fills). */
  lastPrice: number;
  /** Best ask left after the sweep (null when the book is empty). */
  newBestAsk: number | null;
}>;

/** A market buy of `shares` against the asks in price priority. */
export const sweep = (book: Book, shares: number): Sweep => {
  let left = Math.max(shares, 0);
  let paid = 0;
  const taken = book.asks.map((level) => {
    const take = Math.min(left, level.size);
    left -= take;
    paid += take * level.price;
    return take;
  });
  const filled = Math.max(shares, 0) - left;
  const touched = taken.filter((take) => take > 0).length;
  const rest = book.asks.find((level, index) => level.size > nth(taken, index));
  return {
    average: filled > 0 ? paid / filled : book.bestAsk,
    filled,
    lastPrice: touched > 0 ? nth(book.asks, touched - 1).price : book.bestAsk,
    levelsTouched: touched,
    newBestAsk: rest === undefined ? null : rest.price,
    taken,
    unfilled: left,
  };
};

/** Slippage of a market buy: average fill minus the best ask before the order, dollars per share. */
export const slippage = (book: Book, shares: number): number =>
  sweep(book, shares).average - book.bestAsk;
