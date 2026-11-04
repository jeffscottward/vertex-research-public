// Frozen research backtest of the sector rotation map. Report only: nothing here creates,
// routes or simulates orders. Rule: each weekly close, hold the sectors in the leading
// quadrant with equal weight (SPY if none), and keep the weights for the next week.
import {
  type ClosePoint,
  computeTimeframePoints,
  toWeekly,
} from "../../packages/api/src/sector-rotation.ts";

export const BACKTEST_SECTORS = [
  "XLB",
  "XLC",
  "XLE",
  "XLF",
  "XLI",
  "XLK",
  "XLP",
  "XLRE",
  "XLU",
  "XLV",
  "XLY",
] as const;
const BACKTEST_BENCHMARK = "SPY";
/** Cost per unit of one-way turnover: 10 basis points. */
const COST_PER_TURNOVER = 0.001;
const WEEKS_PER_YEAR = 52;

export type Weights = Readonly<Record<string, number>>;

export type Metrics = Readonly<{
  averageTurnover: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  volatility: number;
}>;

export type BacktestResult = Readonly<{
  endDate: string;
  equalWeight: Metrics;
  rotation: Metrics;
  rotationShareInvested: number;
  spyBuyHold: Metrics;
  startDate: string;
  weeks: number;
}>;

/** Sum of |new − old| over all symbols (one-way turnover). */
export const turnover = (before: Weights, after: Weights): number => {
  const symbols = new Set([...Object.keys(before), ...Object.keys(after)]);
  let sum = 0;
  for (const symbol of symbols)
    sum += Math.abs((after[symbol] ?? 0) - (before[symbol] ?? 0));
  return sum;
};

/**
 * Weekly returns for a list of target weights. `targets[i]` is set at close `i` and earns the
 * return from close `i` to close `i + 1`; the cost of moving to it is charged in that week.
 * Turnover is measured against the weights after one week of price drift. The start state is
 * all cash, so the first rebalance has turnover 1.
 */
export const runWeights = (
  targets: readonly Weights[],
  closes: Readonly<Record<string, readonly number[]>>
): { returns: number[]; turnovers: number[] } => {
  const returns: number[] = [];
  const turnovers: number[] = [];
  let held: Weights = {};
  for (let index = 0; index + 1 < targets.length; index += 1) {
    const target = targets[index] as Weights;
    const traded = turnover(held, target);
    let gross = 0;
    const grown: Record<string, number> = {};
    for (const [symbol, weight] of Object.entries(target)) {
      const series = closes[symbol] as readonly number[];
      const growth = (series[index + 1] as number) / (series[index] as number);
      grown[symbol] = weight * growth;
      gross += weight * (growth - 1);
    }
    returns.push((1 + gross) * (1 - traded * COST_PER_TURNOVER) - 1);
    turnovers.push(traded);
    // Weights drift with prices until the next rebalance.
    held = Object.fromEntries(
      Object.entries(grown).map(([symbol, value]) => [
        symbol,
        value / (1 + gross),
      ])
    );
  }
  return { returns, turnovers };
};

/** CAGR, annualized volatility, Sharpe (rf 0), max drawdown, average turnover. */
export const metricsOf = (
  returns: readonly number[],
  turnovers: readonly number[],
  years: number
): Metrics => {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance * WEEKS_PER_YEAR);
  return {
    averageTurnover: turnovers.reduce((a, b) => a + b, 0) / turnovers.length,
    cagr: equity ** (1 / years) - 1,
    maxDrawdown,
    sharpe: volatility === 0 ? 0 : (mean * WEEKS_PER_YEAR) / volatility,
    volatility,
  };
};

const toPoints = (rows: readonly (readonly [string, number])[]): ClosePoint[] =>
  rows.map(([date, close]) => ({ close, date }));

/** Runs the full backtest on daily closes keyed by symbol. */
export const runBacktest = (
  daily: Readonly<Record<string, readonly (readonly [string, number])[]>>
): BacktestResult => {
  const benchmarkDaily = toPoints(
    daily[BACKTEST_BENCHMARK] as readonly (readonly [string, number])[]
  );
  const weeklyBench = toWeekly(benchmarkDaily);
  const quadrants = new Map<string, Map<string, string>>();
  const weeklyClose: Record<string, Map<string, number>> = {
    [BACKTEST_BENCHMARK]: new Map(weeklyBench.map((p) => [p.date, p.close])),
  };
  let start = "";
  for (const symbol of BACKTEST_SECTORS) {
    const closes = toPoints(
      daily[symbol] as readonly (readonly [string, number])[]
    );
    const points = computeTimeframePoints(closes, benchmarkDaily, "weekly", "");
    quadrants.set(symbol, new Map(points.map((p) => [p.date, p.quadrant])));
    weeklyClose[symbol] = new Map(
      toWeekly(closes).map((p) => [p.date, p.close])
    );
    const first = (points[0] as { date: string }).date;
    if (first > start) start = first;
  }
  // Weeks where the benchmark and every sector have a weekly close, from the start week.
  const dates = weeklyBench
    .map((p) => p.date)
    .filter(
      (date) =>
        date >= start &&
        BACKTEST_SECTORS.every((symbol) =>
          (weeklyClose[symbol] as Map<string, number>).has(date)
        )
    );
  const closes: Record<string, number[]> = {};
  for (const [symbol, map] of Object.entries(weeklyClose))
    closes[symbol] = dates.map((date) => map.get(date) as number);

  const equalTarget: Weights = Object.fromEntries(
    BACKTEST_SECTORS.map((symbol) => [symbol, 1 / BACKTEST_SECTORS.length])
  );
  let investedWeeks = 0;
  const rotationTargets = dates.map((date, index): Weights => {
    const leading = BACKTEST_SECTORS.filter(
      (symbol) =>
        (quadrants.get(symbol) as Map<string, string>).get(date) === "leading"
    );
    if (leading.length === 0) return { [BACKTEST_BENCHMARK]: 1 };
    if (index + 1 < dates.length) investedWeeks += 1;
    return Object.fromEntries(leading.map((s) => [s, 1 / leading.length]));
  });
  const startDate = dates[0] as string;
  const endDate = dates.at(-1) as string;
  const years =
    (Date.parse(endDate) - Date.parse(startDate)) / (365.25 * 86_400_000);
  const run = (targets: readonly Weights[]) => {
    const { returns, turnovers } = runWeights(targets, closes);
    return metricsOf(returns, turnovers, years);
  };
  return {
    endDate,
    equalWeight: run(dates.map(() => equalTarget)),
    rotation: run(rotationTargets),
    rotationShareInvested: investedWeeks / (dates.length - 1),
    spyBuyHold: run(dates.map(() => ({ [BACKTEST_BENCHMARK]: 1 }))),
    startDate,
    weeks: dates.length - 1,
  };
};
