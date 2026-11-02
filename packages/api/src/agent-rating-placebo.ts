// Rating replay and shuffled-rating placebo for an agent rating series.
//
// Adapted from Glassbench (https://github.com/davidalmeida90/glassbench), Copyright 2026 David Arias,
// Apache License 2.0, commit 255414b3f38b5def667d3b75faf1dfd7c0d25c9b, file backend/deskapp/simulate.py
// (simulate in rating mode, metrics, ma_decisions, placebo, band). See NOTICE and
// licenses/glassbench-APACHE-2.0.txt.
// Modified: translated from Python to TypeScript; rating mode only (the trader-levels mode is not
// ported); typed-array replay; placebo bands only at the charted points; random draws use the seeded
// mulberry32 stream of backtest-analytics.ts instead of Python's random.Random(7); the agents
// percentile counts ties as half; placebo work is bounded by bars times simulations.
//
// Bars: `t` is the bar open time in ms since the epoch, and the UTC calendar date of `t` must be the
// trading date of the bar (daily bars stamped at UTC midnight or during the UTC trading day, as
// imported by vertex:bars:import). A bar stamped at local midnight east of UTC would map to the
// previous date.
//
// Research only. A rating is a research stance label. Nothing here creates, sizes or sends an order.

import {
  createRandom,
  quantileSorted,
  seedFrom,
} from "./backtest-analytics.ts";
import {
  AGENT_RATING_DECISIONS_MAX,
  AGENT_RATING_DECISIONS_MIN,
  AGENT_RATING_VALUES,
  type AgentRating,
  RATING_EVALUATION_EQUITY_MAX_POINTS,
  type RatingEvaluationOutput,
} from "./contracts/agent-ops.ts";
import { downsampleIndexes } from "./instant-backtest-engine.ts";
import { mean, stdev } from "./quant-arrays.ts";

/** Daily bar columns (MarketBarColumns satisfies this): t is the bar open time in ms since the epoch. */
export type RatingBars = Readonly<{
  t: ArrayLike<number>;
  o: ArrayLike<number>;
  c: ArrayLike<number>;
}>;

export type RatingSeriesInput = Readonly<{
  symbol: string;
  timeframe: string;
  costBps: number;
  decisions: readonly Readonly<{ date: string; rating: AgentRating | null }>[];
}>;

type ReadyEvaluation = Extract<RatingEvaluationOutput, { status: "ready" }>;
type StrategyOutput = ReadyEvaluation["strategies"][number];

export const PLACEBO_SIMS = 1000;
/** Upper bound on simulated bar steps (simulations times bars) for one placebo; keeps a read cheap. */
const PLACEBO_MAX_STEPS = 5_000_000;
const MA_FAST = 50;
const MA_SLOW = 200;
const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;
const START_EQUITY = 100;
const EPSILON = 1e-9;

// Rating codes follow AGENT_RATING_VALUES; NULL_CODE marks a failed run. Target weight per code:
// buy 100%, overweight 50%, hold keeps the position, underweight and sell flat, failed keeps.
const BUY_CODE = 0;
const SELL_CODE = 4;
const NULL_CODE = AGENT_RATING_VALUES.length;
const TARGETS = Float64Array.of(1, 0.5, Number.NaN, 0, 0, Number.NaN);
const STRATEGY_LABELS: Readonly<Record<StrategyOutput["key"], string>> = {
  agents_rating: "Agents rating only",
  buy_hold: "Buy and hold",
  ma_cross: "50/200-day MA rule",
};

// Fill schedule shared by every ordering of the same dates: slot k trades at the open of bar
// fillBars[k] with the rating of decision slotDecision[k].
type Plan = Readonly<{
  start: number;
  size: number;
  fillBars: Int32Array;
  slotDecision: Int32Array;
}>;

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

// Last bar whose UTC date is on or before `date`; -1 when every bar is later.
const barOnOrBefore = (t: ArrayLike<number>, date: string): number => {
  const end = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  let low = 0;
  let high = t.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((t[middle] as number) < end) low = middle + 1;
    else high = middle;
  }
  return low - 1;
};

// A decision trades at the next bar's open; a later decision on the same bar replaces the earlier one.
const planFor = (decisionBars: Int32Array, size: number): Plan => {
  const fills = new Map<number, number>();
  decisionBars.forEach((bar, decision) => {
    if (bar + 1 < size) fills.set(bar + 1, decision);
  });
  return {
    start: decisionBars[0] as number,
    size,
    fillBars: Int32Array.from(fills.keys()),
    slotDecision: Int32Array.from(fills.values()),
  };
};

/** Weight of the position in the book; 0 when the book has no positive value (as Glassbench Book.weight). */
export const positionWeight = (exposure: number, value: number): number =>
  value > 0 ? exposure / value : 0;

// Every open and close from the first decision bar to the last bar, and every close the 200-day
// average reads before it, must be a positive finite price.
const pricesUsable = (bars: RatingBars, start: number, size: number) => {
  const usable = (price: number) => Number.isFinite(price) && price > 0;
  for (let bar = Math.max(0, start + 1 - MA_SLOW); bar < size; bar += 1) {
    if (!usable(bars.c[bar] as number)) return false;
    if (bar >= start && !usable(bars.o[bar] as number)) return false;
  }
  return true;
};

// Replays one ordering of rating codes into `equity` (and `weights`, when given) from the start bar.
// Writes [trades, costs] into `totals`. Allocates nothing, so the placebo loop reuses its buffers.
const replay = (
  bars: RatingBars,
  plan: Plan,
  codes: Uint8Array,
  costBps: number,
  equity: Float64Array,
  weights: Float64Array | null,
  totals: Float64Array
): void => {
  const rate = costBps / 10_000;
  let cash = START_EQUITY;
  let shares = 0;
  let slot = 0;
  totals.fill(0);
  equity[0] = START_EQUITY;
  if (weights !== null) weights[0] = 0;
  for (let bar = plan.start + 1; bar < plan.size; bar += 1) {
    if (plan.fillBars[slot] === bar) {
      const decision = plan.slotDecision[slot] as number;
      const target = TARGETS[codes[decision] as number] as number;
      slot += 1;
      const price = bars.o[bar] as number;
      const value = cash + shares * price;
      const before = positionWeight(shares * price, value);
      if (!Number.isNaN(target) && Math.abs(target - before) >= EPSILON) {
        const next = (target * value) / price;
        const cost = Math.abs(next - shares) * price * rate;
        cash -= (next - shares) * price + cost;
        shares = next;
        totals[0] = (totals[0] as number) + 1;
        totals[1] = (totals[1] as number) + cost;
      }
    }
    const close = bars.c[bar] as number;
    const value = cash + shares * close;
    equity[bar - plan.start] = value;
    if (weights !== null)
      weights[bar - plan.start] = positionWeight(shares * close, value);
  }
};

const metricsOf = (
  equity: Float64Array,
  weights: Float64Array,
  totals: Float64Array
): StrategyOutput["metrics"] => {
  const days = equity.length - 1;
  const first = equity[0] as number;
  const last = equity[days] as number;
  const returns: number[] = [];
  let peak = first;
  let maxDrawdown = 0;
  let exposure = 0;
  for (let index = 1; index <= days; index += 1) {
    const value = equity[index] as number;
    returns.push(value / (equity[index - 1] as number) - 1);
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
    // A full buy pays its commission from cash, so the raw weight can sit just above 1; cap it.
    exposure += Math.min(1, Math.max(0, weights[index] as number));
  }
  const deviation = stdev(returns);
  return {
    totalReturn: last / first - 1,
    annualReturn: (last / first) ** (TRADING_DAYS / days) - 1,
    volatility: days > 1 ? deviation * Math.sqrt(TRADING_DAYS) : null,
    sharpe:
      deviation > 0
        ? (mean(returns) / deviation) * Math.sqrt(TRADING_DAYS)
        : null,
    maxDrawdown,
    timeInMarket: exposure / days,
    trades: totals[0] as number,
    costDrag: (totals[1] as number) / first,
    days,
  };
};

// Number of distinct orderings of a multiset (n! / prod(k!)), or Infinity once it exceeds `limit`.
const distinctOrderings = (
  counts: readonly number[],
  limit: number
): number => {
  let total = 1;
  let seen = 0;
  for (const count of counts) {
    for (let index = 1; index <= count; index += 1) {
      seen += 1;
      total = (total * seen) / index;
      if (total > limit) return Number.POSITIVE_INFINITY;
    }
  }
  return Math.round(total);
};

// Steps `values` to its next lexicographic ordering; false after the last one.
const nextOrdering = (values: Uint8Array): boolean => {
  let pivot = values.length - 2;
  while (
    pivot >= 0 &&
    (values[pivot] as number) >= (values[pivot + 1] as number)
  )
    pivot -= 1;
  if (pivot < 0) return false;
  let swap = values.length - 1;
  while ((values[swap] as number) <= (values[pivot] as number)) swap -= 1;
  const held = values[pivot] as number;
  values[pivot] = values[swap] as number;
  values[swap] = held;
  values.subarray(pivot + 1).reverse();
  return true;
};

type Placebo = ReadyEvaluation["placebo"];

const placeboOf = (
  bars: RatingBars,
  plan: Plan,
  codes: Uint8Array,
  costBps: number,
  points: Int32Array,
  agentsFinal: number,
  seedKey: string,
  maxSteps: number
): Placebo => {
  const days = plan.size - plan.start - 1;
  const counts = Array.from({ length: NULL_CODE + 1 }, () => 0);
  for (const code of codes) counts[code] = (counts[code] as number) + 1;
  const maxSims = Math.max(
    1,
    Math.min(PLACEBO_SIMS, Math.floor(maxSteps / days))
  );
  const distinct = distinctOrderings(counts, maxSims);
  const exhaustive = distinct <= maxSims;
  const sims = exhaustive ? distinct : maxSims;
  const seed = seedFrom(seedKey);
  const order = Uint8Array.from(codes);
  const curve = new Float64Array(days + 1);
  const totals = new Float64Array(2);
  const sampled = new Float64Array(sims * points.length);
  const record = (sim: number): void => {
    replay(bars, plan, order, costBps, curve, null, totals);
    points.forEach((point, index) => {
      sampled[sim * points.length + index] = curve[point] as number;
    });
  };
  if (exhaustive) {
    order.sort();
    let sim = 0;
    do {
      record(sim);
      sim += 1;
    } while (nextOrdering(order));
  } else {
    const random = createRandom(seed);
    for (let sim = 0; sim < sims; sim += 1) {
      order.set(codes);
      // Fisher-Yates, as random.shuffle in Glassbench.
      for (let index = order.length - 1; index > 0; index -= 1) {
        const pick = Math.floor(random() * (index + 1));
        [order[index], order[pick]] = [
          order[pick] as number,
          order[index] as number,
        ];
      }
      record(sim);
    }
  }
  const column: number[] = Array.from({ length: sims }, () => 0);
  const p5: number[] = [];
  const p50: number[] = [];
  const p95: number[] = [];
  points.forEach((_, index) => {
    for (let sim = 0; sim < sims; sim += 1)
      column[sim] = sampled[sim * points.length + index] as number;
    column.sort((left, right) => left - right);
    p5.push(quantileSorted(column, 0.05));
    p50.push(quantileSorted(column, 0.5));
    p95.push(quantileSorted(column, 0.95));
  });
  // After the loop `column` holds the sorted final equities (the last point is the last bar).
  let below = 0;
  let ties = 0;
  for (const final of column) {
    if (Math.abs(final - agentsFinal) <= EPSILON) ties += 1;
    else if (final < agentsFinal) below += 1;
  }
  return {
    sims,
    exhaustive,
    seed,
    p5: p5.map(round4),
    p50: p50.map(round4),
    p95: p95.map(round4),
    finalP5: p5.at(-1) as number,
    finalP50: p50.at(-1) as number,
    finalP95: p95.at(-1) as number,
    agentsPercentile: ((below + ties / 2) / sims) * 100,
  };
};

const averageClose = (
  close: ArrayLike<number>,
  last: number,
  length: number
) => {
  let total = 0;
  for (let index = last - length + 1; index <= last; index += 1)
    total += close[index] as number;
  return total / length;
};

// 50-day versus 200-day simple moving average of closes up to each decision bar: buy above, else sell.
// Null when the first decision has fewer than 200 bars of history.
const maCodes = (
  close: ArrayLike<number>,
  decisionBars: Int32Array
): Uint8Array | null => {
  if ((decisionBars[0] as number) + 1 < MA_SLOW) return null;
  return Uint8Array.from(decisionBars, (bar) =>
    averageClose(close, bar, MA_FAST) > averageClose(close, bar, MA_SLOW)
      ? BUY_CODE
      : SELL_CODE
  );
};

// Next-period return of each decision: decision bar close to the next decision bar close (or the
// last bar for the final decision). Null when both fall on the same bar.
const byRatingOf = (
  close: ArrayLike<number>,
  decisionBars: Int32Array,
  codes: Uint8Array
): ReadyEvaluation["byRating"] => {
  const last = close.length - 1;
  const forward = Array.from(decisionBars, (bar, index) => {
    const next = decisionBars[index + 1] ?? last;
    return next > bar
      ? (close[next] as number) / (close[bar] as number) - 1
      : null;
  });
  return AGENT_RATING_VALUES.flatMap((rating, code) => {
    const rows = forward.filter((_, index) => codes[index] === code);
    if (rows.length === 0) return [];
    const measured = rows.filter((value) => value !== null);
    const hits =
      rating === "hold"
        ? null
        : measured.filter((value) =>
            rating === "buy" || rating === "overweight" ? value > 0 : value < 0
          ).length;
    return [
      {
        rating,
        decisions: rows.length,
        hitRate:
          hits === null || measured.length === 0
            ? null
            : hits / measured.length,
        averageNextReturn: measured.length === 0 ? null : mean(measured),
      },
    ];
  });
};

/**
 * Replays an agent rating series against daily bars with Glassbench's rating-only rules and compares it
 * with buy and hold, a 50/200-day moving-average rule and the same ratings shuffled across the same dates.
 * Pure and deterministic for one (bars, series, seedKey).
 */
export const evaluateAgentRatings = (
  input: Readonly<{
    bars: RatingBars;
    series: RatingSeriesInput;
    seedKey: string;
    maxPlaceboSteps?: number;
  }>
): RatingEvaluationOutput => {
  const { bars, series } = input;
  if (series.decisions.length > AGENT_RATING_DECISIONS_MAX)
    throw new RangeError(
      `A rating series has at most ${AGENT_RATING_DECISIONS_MAX} decisions`
    );
  const size = bars.t.length;
  if (size === 0) return { status: "unavailable", reason: "no_bars" };
  if (series.decisions.length < AGENT_RATING_DECISIONS_MIN)
    return { status: "unavailable", reason: "too_few_decisions" };
  // The contract and the repository already require strictly increasing dates; the sort keeps the
  // replay correct for a row written outside them.
  const decisions = [...series.decisions].sort((left, right) =>
    left.date.localeCompare(right.date)
  );
  const decisionBars = Int32Array.from(decisions, (decision) =>
    barOnOrBefore(bars.t, decision.date)
  );
  // Dates are sorted, so every later decision also falls inside the history.
  const start = decisionBars[0] as number;
  if (start < 0 || start + 1 >= size)
    return { status: "unavailable", reason: "outside_history" };
  if (!pricesUsable(bars, start, size))
    return { status: "unavailable", reason: "bad_bars" };
  const plan = planFor(decisionBars, size);

  const codes = Uint8Array.from(decisions, (decision) =>
    decision.rating === null
      ? NULL_CODE
      : AGENT_RATING_VALUES.indexOf(decision.rating)
  );
  const days = size - start - 1;
  const points = Int32Array.from(
    downsampleIndexes(days + 1, RATING_EVALUATION_EQUITY_MAX_POINTS)
  );
  const equity = new Float64Array(days + 1);
  const weights = new Float64Array(days + 1);
  const totals = new Float64Array(2);
  const strategy = (
    key: StrategyOutput["key"],
    strategyPlan: Plan,
    strategyCodes: Uint8Array
  ): StrategyOutput => {
    replay(
      bars,
      strategyPlan,
      strategyCodes,
      series.costBps,
      equity,
      weights,
      totals
    );
    return {
      key,
      label: STRATEGY_LABELS[key],
      metrics: metricsOf(equity, weights, totals),
      equity: Array.from(points, (point) => ({
        t: dateOf(bars.t[start + point] as number),
        equity: round4(equity[point] as number),
      })),
    };
  };

  const agents = strategy("agents_rating", plan, codes);
  const agentsFinal = equity[days] as number;
  const buyHold = strategy(
    "buy_hold",
    {
      ...plan,
      fillBars: Int32Array.of(start + 1),
      slotDecision: Int32Array.of(0),
    },
    Uint8Array.of(BUY_CODE)
  );
  const ma = maCodes(bars.c, decisionBars);
  const strategies =
    ma === null
      ? [agents, buyHold]
      : [agents, buyHold, strategy("ma_cross", plan, ma)];

  return {
    status: "ready",
    symbol: series.symbol,
    timeframe: series.timeframe,
    costBps: series.costBps,
    startDate: dateOf(bars.t[start] as number),
    endDate: dateOf(bars.t[size - 1] as number),
    days,
    strategies,
    placebo: placeboOf(
      bars,
      plan,
      codes,
      series.costBps,
      points,
      agentsFinal,
      input.seedKey,
      input.maxPlaceboSteps ?? PLACEBO_MAX_STEPS
    ),
    byRating: byRatingOf(bars.c, decisionBars, codes),
    failedDecisions: codes.filter((code) => code === NULL_CODE).length,
  };
};
