// Server-derived analytics for agent-reported backtests.
// Inputs are the stored (agent-reported) equity series and trades. Every value here is a deterministic
// function of those inputs: stochastic sections use a seeded generator whose seed is reported.
// Conventions: risk-free rate 0; returns are simple per-period returns of the equity series;
// annualization uses the observed frequency (periods / elapsed years), not an assumed calendar.

import {
  at as requireAt,
  mean,
  quantile,
  sorted as sortedCopy,
  stdev,
  timeMs,
} from "./quant-arrays.ts";
import { normalCdfPrecise } from "./quant-distributions.ts";
import {
  multipleTesting,
  type CurrentTrial,
  type MultipleTesting,
  type TrialLedger,
} from "./quant-multiple-testing.ts";
import {
  meanTTest,
  stationaryBootstrap,
  type MeanTTest,
  type StationaryBootstrapResult,
} from "./quant-significance.ts";

import {
  volatilityClustering,
  type VolatilityClustering,
} from "./quant-volatility.ts";

const BACKTEST_ANALYTICS_VERSION = "vertex-backtest-analytics-v2";
const ANALYTICS_RESAMPLES = 1000;
const MONTE_CARLO_PATHS = 1000;
const MONTE_CARLO_FAN_STEPS = 50;
const RUIN_FRACTION = 0.5;
const DISTRIBUTION_BINS = 20;
const DRAWDOWN_PERIODS_SHOWN = 10;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export type AnalyticsEquityPoint = Readonly<{ t: string; equity: number }>;
export type AnalyticsTrade = Readonly<{
  entry_t: string;
  exit_t: string;
  side: "long" | "short";
  pnl: number;
  commission?: number | undefined;
  regime?: string | undefined;
}>;

export type Interval = Readonly<{
  mean: number;
  p2_5: number;
  p50: number;
  p97_5: number;
}>;
export type Percentiles = Readonly<{
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}>;

export type ReturnStats = Readonly<{
  periods: number;
  periodsPerYear: number;
  totalReturn: number;
  cagr: number;
  annualVolatility: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number;
  skew: number | null;
  excessKurtosis: number | null;
  psr: number | null;
}>;

export type TradeStats = Readonly<{
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  kelly: number | null;
  longCount: number;
  shortCount: number;
  longNetPnl: number;
  shortNetPnl: number;
  avgHoldMinutes: number;
  totalCommission: number | null;
}>;

export type DrawdownPeriod = Readonly<{
  peakT: string;
  troughT: string;
  recoveryT: string | null;
  depth: number;
  declineMs: number;
  recoveryMs: number | null;
  underwaterMs: number;
}>;

export type DrawdownSummary = Readonly<{
  count: number;
  longestUnderwaterMs: number;
  avgRecoveryMs: number | null;
  ongoing: boolean;
  periods: DrawdownPeriod[];
}>;

export type PeriodReturn = Readonly<{
  year: number;
  month: number | null;
  return: number;
}>;
export type PnlBucket = Readonly<{
  key: string;
  trades: number;
  netPnl: number;
  winRate: number;
}>;
export type DistributionBin = Readonly<{
  from: number;
  to: number;
  count: number;
}>;
export type RegimeRow = Readonly<{
  regime: string;
  trades: number;
  winRate: number;
  netPnl: number;
  avgPnl: number;
  profitFactor: number | null;
}>;
export type FanPoint = Readonly<{ step: number } & Percentiles>;
export type MonteCarloRun = Readonly<{
  finalPnl: Percentiles;
  maxDrawdown: Percentiles;
  probabilityOfProfit: number;
  riskOfRuin: number;
  fan: FanPoint[];
}>;
export type BenchmarkStats = Readonly<{
  n: number;
  beta: number;
  alphaAnnual: number;
  correlation: number;
  rSquared: number;
  benchmarkReturn: number;
}>;

export type BacktestAnalytics = Readonly<{
  method: Readonly<{
    version: string;
    seed: number;
    resamples: number;
    monteCarloPaths: number;
    ruinFraction: number;
    initialCapital: number | null;
    blockLength: number | null;
  }>;
  returns: ReturnStats | null;
  trades: TradeStats | null;
  drawdowns: DrawdownSummary | null;
  monthlyReturns: PeriodReturn[];
  yearlyReturns: PeriodReturn[];
  pnlBy: Readonly<{
    weekday: PnlBucket[];
    hour: PnlBucket[];
    month: PnlBucket[];
    year: PnlBucket[];
  }>;
  distribution: Readonly<{
    bins: DistributionBin[];
    mean: number;
    median: number;
    stdev: number;
  }> | null;
  regimes: RegimeRow[];
  bootstrap: Readonly<{
    sharpe: Interval | null;
    totalReturn: Interval | null;
    maxDrawdown: Interval | null;
    winRate: Interval | null;
    profitFactor: Interval | null;
    expectancy: Interval | null;
  }>;
  monteCarlo: Readonly<{
    reshuffle: MonteCarloRun;
    bootstrap: MonteCarloRun;
  }> | null;
  benchmark: BenchmarkStats | null;
  // H0: mean per-period return (or Sharpe) <= 0. Stationary bootstrap uses its own seeded stream.
  significance: Readonly<{
    tTest: MeanTTest | null;
    stationaryBootstrap: StationaryBootstrapResult | null;
  }>;
  // Deflated Sharpe and Benjamini-Hochberg across the strategy (or task) trial ledger.
  // Null only when the caller supplies no ledger.
  multipleTesting: MultipleTesting | null;
  // Ljung-Box on squared returns and GARCH(1,1) volatility forecast. Research display only.
  volatility: VolatilityClustering;
}>;

// ---------------------------------------------------------------------------
// Primitives

// biome-ignore-start lint/suspicious/noBitwiseOperators: FNV-1a hashing and mulberry32 are defined by 32-bit integer bit operations.
// FNV-1a 32-bit; stable seed from an identifier.
export const seedFrom = (value: string): number => {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash >>> 0;
};

// mulberry32: small, fast, deterministic PRNG in [0, 1).
export const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// biome-ignore-end lint/suspicious/noBitwiseOperators: end of deterministic hash/PRNG block.

const sum = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

// Linear-interpolated quantile of a sorted array (type 7); NaN for an empty array.
export const quantileSorted = (
  ordered: readonly number[],
  q: number
): number => (ordered.length === 0 ? Number.NaN : quantile(ordered, q));

const interval = (samples: readonly number[]): Interval | null => {
  const finite = samples.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const sorted = sortedCopy(finite);
  return {
    mean: mean(finite),
    p2_5: quantileSorted(sorted, 0.025),
    p50: quantileSorted(sorted, 0.5),
    p97_5: quantileSorted(sorted, 0.975),
  };
};

const percentiles = (samples: readonly number[]): Percentiles => {
  const sorted = sortedCopy(samples);
  return {
    p5: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p50: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
  };
};

// ---------------------------------------------------------------------------
// Equity-based statistics

const simpleReturns = (equity: readonly AnalyticsEquityPoint[]): number[] => {
  const returns: number[] = [];
  for (let index = 1; index < equity.length; index += 1) {
    returns.push(
      requireAt(equity, index).equity / requireAt(equity, index - 1).equity - 1
    );
  }
  return returns;
};

const maxDrawdownOf = (values: readonly number[]): number => {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
};

const compound = (returns: readonly number[]): number[] => {
  const path = [1];
  for (const value of returns)
    path.push(requireAt(path, path.length - 1) * (1 + value));
  return path;
};

const sharpeOf = (returns: readonly number[]): number | null => {
  const deviation = stdev(returns);
  return deviation === 0 ? null : mean(returns) / deviation;
};

// Moment-based skew and excess kurtosis (population moments).
const moments = (
  returns: readonly number[]
): Readonly<{ skew: number | null; excessKurtosis: number | null }> => {
  if (returns.length < 3) return { skew: null, excessKurtosis: null };
  const average = mean(returns);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of returns) {
    const delta = value - average;
    m2 += delta ** 2;
    m3 += delta ** 3;
    m4 += delta ** 4;
  }
  m2 /= returns.length;
  m3 /= returns.length;
  m4 /= returns.length;
  if (m2 === 0) return { skew: null, excessKurtosis: null };
  return { skew: m3 / m2 ** 1.5, excessKurtosis: m4 / m2 ** 2 - 3 };
};

// Probabilistic Sharpe ratio against SR* = 0 (Bailey and Lopez de Prado), per-period Sharpe.
const probabilisticSharpe = (
  sharpe: number,
  n: number,
  skew: number,
  excessKurtosis: number
): number | null => {
  if (n < 3) return null;
  const kurtosis = excessKurtosis + 3;
  const variance = 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2;
  if (!(variance > 0)) return null;
  return normalCdfPrecise((sharpe * Math.sqrt(n - 1)) / Math.sqrt(variance));
};

export const returnStats = (
  equity: readonly AnalyticsEquityPoint[]
): ReturnStats | null => {
  if (equity.length < 3) return null;
  const elapsedYears =
    (timeMs(requireAt(equity, equity.length - 1).t) -
      timeMs(requireAt(equity, 0).t)) /
    YEAR_MS;
  if (!(elapsedYears > 0)) return null;
  const returns = simpleReturns(equity);
  const periodsPerYear = returns.length / elapsedYears;
  const totalReturn =
    requireAt(equity, equity.length - 1).equity / requireAt(equity, 0).equity -
    1;
  const cagr = (1 + totalReturn) ** (1 / elapsedYears) - 1;
  const deviation = stdev(returns);
  const perPeriodSharpe = sharpeOf(returns);
  let downside = 0;
  for (const value of returns) downside += Math.min(value, 0) ** 2;
  downside = Math.sqrt(downside / returns.length);
  const maxDrawdown = maxDrawdownOf(equity.map((point) => point.equity));
  const { skew, excessKurtosis } = moments(returns);
  return {
    periods: returns.length,
    periodsPerYear,
    totalReturn,
    cagr,
    annualVolatility: deviation * Math.sqrt(periodsPerYear),
    sharpe:
      perPeriodSharpe === null
        ? null
        : perPeriodSharpe * Math.sqrt(periodsPerYear),
    sortino:
      downside === 0
        ? null
        : (mean(returns) / downside) * Math.sqrt(periodsPerYear),
    calmar: maxDrawdown === 0 ? null : cagr / Math.abs(maxDrawdown),
    maxDrawdown,
    skew,
    excessKurtosis,
    psr:
      perPeriodSharpe === null || skew === null || excessKurtosis === null
        ? null
        : probabilisticSharpe(
            perPeriodSharpe,
            returns.length,
            skew,
            excessKurtosis
          ),
  };
};

// Drawdown periods: from a peak, through the lowest point, to the first value at or above that peak.
export const drawdownSummary = (
  equity: readonly AnalyticsEquityPoint[]
): DrawdownSummary | null => {
  if (equity.length < 2) return null;
  const periods: DrawdownPeriod[] = [];
  let peakIndex = 0;
  let troughIndex = 0;
  let inDrawdown = false;
  const close = (recoveryIndex: number | null) => {
    const peakMs = timeMs(requireAt(equity, peakIndex).t);
    const troughMs = timeMs(requireAt(equity, troughIndex).t);
    const endMs =
      recoveryIndex === null
        ? timeMs(requireAt(equity, equity.length - 1).t)
        : timeMs(requireAt(equity, recoveryIndex).t);
    return periods.push({
      peakT: requireAt(equity, peakIndex).t,
      troughT: requireAt(equity, troughIndex).t,
      recoveryT:
        recoveryIndex === null ? null : requireAt(equity, recoveryIndex).t,
      depth:
        requireAt(equity, troughIndex).equity /
          requireAt(equity, peakIndex).equity -
        1,
      declineMs: troughMs - peakMs,
      recoveryMs: recoveryIndex === null ? null : endMs - troughMs,
      underwaterMs: endMs - peakMs,
    });
  };
  for (let index = 1; index < equity.length; index += 1) {
    const value = requireAt(equity, index).equity;
    if (value >= requireAt(equity, peakIndex).equity) {
      if (inDrawdown) {
        close(index);
        inDrawdown = false;
      }
      peakIndex = index;
      troughIndex = index;
    } else {
      inDrawdown = true;
      if (value < requireAt(equity, troughIndex).equity) troughIndex = index;
    }
  }
  if (inDrawdown) close(null);
  const recovered = periods.filter((period) => period.recoveryMs !== null);
  return {
    count: periods.length,
    longestUnderwaterMs: periods.reduce(
      (longest, period) => Math.max(longest, period.underwaterMs),
      0
    ),
    avgRecoveryMs:
      recovered.length === 0
        ? null
        : mean(
            recovered.flatMap((period) =>
              period.recoveryMs === null ? [] : [period.recoveryMs]
            )
          ),
    ongoing: inDrawdown,
    periods: [...periods]
      .sort((left, right) => left.depth - right.depth)
      .slice(0, DRAWDOWN_PERIODS_SHOWN),
  };
};

// Calendar returns from period-end equity (UTC). The first period uses the first equity point as base.
export const calendarReturns = (
  equity: readonly AnalyticsEquityPoint[],
  unit: "month" | "year"
): PeriodReturn[] => {
  if (equity.length < 2) return [];
  const keyOf = (t: string) => {
    const date = new Date(timeMs(t));
    return unit === "year"
      ? `${date.getUTCFullYear()}`
      : `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
  };
  const ends = new Map<string, number>();
  for (const point of equity) ends.set(keyOf(point.t), point.equity);
  const rows: PeriodReturn[] = [];
  let base = requireAt(equity, 0).equity;
  for (const [key, end] of ends) {
    const [year, month] = key.split("-").map(Number);
    rows.push({
      year: year ?? Number.NaN,
      month: unit === "year" ? null : (month ?? Number.NaN),
      return: end / base - 1,
    });
    base = end;
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Trade-based statistics

export const tradeStats = (
  trades: readonly AnalyticsTrade[]
): TradeStats | null => {
  if (trades.length === 0) return null;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let streakWins = 0;
  let streakLosses = 0;
  let maxWins = 0;
  let maxLosses = 0;
  let largestWin: number | null = null;
  let largestLoss: number | null = null;
  let longCount = 0;
  let longNet = 0;
  let holdMs = 0;
  let commission = 0;
  let commissionSeen = false;
  for (const trade of trades) {
    if (trade.pnl > 0) {
      wins += 1;
      grossProfit += trade.pnl;
      streakWins += 1;
      streakLosses = 0;
      largestWin =
        largestWin === null ? trade.pnl : Math.max(largestWin, trade.pnl);
    } else if (trade.pnl < 0) {
      losses += 1;
      grossLoss += trade.pnl;
      streakLosses += 1;
      streakWins = 0;
      largestLoss =
        largestLoss === null ? trade.pnl : Math.min(largestLoss, trade.pnl);
    } else {
      streakWins = 0;
      streakLosses = 0;
    }
    maxWins = Math.max(maxWins, streakWins);
    maxLosses = Math.max(maxLosses, streakLosses);
    if (trade.side === "long") {
      longCount += 1;
      longNet += trade.pnl;
    }
    holdMs += timeMs(trade.exit_t) - timeMs(trade.entry_t);
    if (trade.commission !== undefined) {
      commissionSeen = true;
      commission += trade.commission;
    }
  }
  const netPnl = grossProfit + grossLoss;
  const winRate = wins / trades.length;
  const avgWin = wins === 0 ? null : grossProfit / wins;
  const avgLoss = losses === 0 ? null : grossLoss / losses;
  const payoffRatio =
    avgWin === null || avgLoss === null ? null : avgWin / Math.abs(avgLoss);
  return {
    count: trades.length,
    wins,
    losses,
    breakeven: trades.length - wins - losses,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor: grossLoss === 0 ? null : grossProfit / Math.abs(grossLoss),
    expectancy: netPnl / trades.length,
    avgWin,
    avgLoss,
    payoffRatio,
    largestWin,
    largestLoss,
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    kelly: payoffRatio === null ? null : winRate - (1 - winRate) / payoffRatio,
    longCount,
    shortCount: trades.length - longCount,
    longNetPnl: longNet,
    shortNetPnl: netPnl - longNet,
    avgHoldMinutes: holdMs / trades.length / 60_000,
    totalCommission: commissionSeen ? commission : null,
  };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const pnlBuckets = (
  trades: readonly AnalyticsTrade[],
  unit: "weekday" | "hour" | "month" | "year"
): PnlBucket[] => {
  const buckets = new Map<
    string,
    { trades: number; netPnl: number; wins: number; order: number }
  >();
  for (const trade of trades) {
    const date = new Date(timeMs(trade.exit_t));
    const [key, order] =
      unit === "weekday"
        ? [requireAt(WEEKDAYS, date.getUTCDay()), date.getUTCDay()]
        : unit === "hour"
          ? [String(date.getUTCHours()).padStart(2, "0"), date.getUTCHours()]
          : unit === "month"
            ? [
                `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
                date.getUTCFullYear() * 12 + date.getUTCMonth(),
              ]
            : [String(date.getUTCFullYear()), date.getUTCFullYear()];
    const bucket = buckets.get(key) ?? { trades: 0, netPnl: 0, wins: 0, order };
    bucket.trades += 1;
    bucket.netPnl += trade.pnl;
    if (trade.pnl > 0) bucket.wins += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((left, right) => left[1].order - right[1].order)
    .map(([key, bucket]) => ({
      key,
      trades: bucket.trades,
      netPnl: bucket.netPnl,
      winRate: bucket.wins / bucket.trades,
    }));
};

export const pnlDistribution = (
  trades: readonly AnalyticsTrade[]
): BacktestAnalytics["distribution"] => {
  if (trades.length === 0) return null;
  const values = trades.map((trade) => trade.pnl);
  const sorted = sortedCopy(values);
  const low = requireAt(sorted, 0);
  const high = requireAt(sorted, sorted.length - 1);
  const width = high === low ? 1 : (high - low) / DISTRIBUTION_BINS;
  const binCount = high === low ? 1 : DISTRIBUTION_BINS;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    from: low + index * width,
    to: low + (index + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - low) / width));
    requireAt(bins, index).count += 1;
  }
  return {
    bins,
    mean: mean(values),
    median: quantileSorted(sorted, 0.5),
    stdev: stdev(values),
  };
};

export const regimeRows = (trades: readonly AnalyticsTrade[]): RegimeRow[] => {
  const groups = new Map<string, number[]>();
  for (const trade of trades) {
    if (trade.regime === undefined || trade.regime === "") continue;
    const values = groups.get(trade.regime) ?? [];
    values.push(trade.pnl);
    groups.set(trade.regime, values);
  }
  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([regime, values]) => {
      const profit = sum(values.filter((value) => value > 0));
      const loss = sum(values.filter((value) => value < 0));
      return {
        regime,
        trades: values.length,
        winRate: values.filter((value) => value > 0).length / values.length,
        netPnl: profit + loss,
        avgPnl: (profit + loss) / values.length,
        profitFactor: loss === 0 ? null : profit / Math.abs(loss),
      };
    });
};

// ---------------------------------------------------------------------------
// Resampling

// Circular block bootstrap of a return series. Block length ~ n^(1/3) keeps short-range dependence.
const blockLengthFor = (n: number): number =>
  Math.max(1, Math.round(n ** (1 / 3)));

export const blockResample = (
  values: readonly number[],
  blockLength: number,
  random: () => number
): number[] => {
  const result: number[] = [];
  while (result.length < values.length) {
    const start = Math.floor(random() * values.length);
    for (
      let offset = 0;
      offset < blockLength && result.length < values.length;
      offset += 1
    ) {
      result.push(requireAt(values, (start + offset) % values.length));
    }
  }
  return result;
};

const resample = <T>(values: readonly T[], random: () => number): T[] => {
  return Array.from({ length: values.length }, () =>
    requireAt(values, Math.floor(random() * values.length))
  );
};

const shuffled = <T>(values: readonly T[], random: () => number): T[] => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = requireAt(copy, index);
    copy[index] = requireAt(copy, swap);
    copy[swap] = held;
  }
  return copy;
};

const profitFactorOf = (values: readonly number[]): number => {
  let profit = 0;
  let loss = 0;
  for (const value of values) {
    if (value > 0) {
      profit += value;
    } else loss += value;
  }
  return loss === 0 ? Number.NaN : profit / Math.abs(loss);
};

// Monte Carlo over trade P&L sequences starting from capital. Drawdown is measured on account equity.
// `paths` defaults to the analytics path count; the setup replay passes its own.
export const monteCarlo = (
  pnls: readonly number[],
  capital: number,
  mode: "reshuffle" | "bootstrap",
  random: () => number,
  paths = MONTE_CARLO_PATHS
): MonteCarloRun => {
  const fanSteps = Math.min(MONTE_CARLO_FAN_STEPS, pnls.length);
  const stepIndexes = Array.from(
    { length: fanSteps },
    (_, index) => Math.round(((index + 1) * pnls.length) / fanSteps) - 1
  );
  const fanSamples: number[][] = stepIndexes.map(() => []);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let profitable = 0;
  let ruined = 0;
  for (let path = 0; path < paths; path += 1) {
    const sequence =
      mode === "reshuffle" ? shuffled(pnls, random) : resample(pnls, random);
    let equity = capital;
    let peak = capital;
    let worst = 0;
    let ruin = false;
    let fanCursor = 0;
    for (let index = 0; index < sequence.length; index += 1) {
      equity += requireAt(sequence, index);
      peak = Math.max(peak, equity);
      worst = Math.min(worst, peak > 0 ? equity / peak - 1 : -1);
      if (equity <= capital * RUIN_FRACTION) ruin = true;
      if (fanCursor < stepIndexes.length && stepIndexes[fanCursor] === index) {
        fanSamples[fanCursor]?.push(equity - capital);
        fanCursor += 1;
      }
    }
    finals.push(equity - capital);
    drawdowns.push(worst);
    if (equity > capital) profitable += 1;
    if (ruin) ruined += 1;
  }
  return {
    finalPnl: percentiles(finals),
    maxDrawdown: percentiles(drawdowns),
    probabilityOfProfit: profitable / paths,
    riskOfRuin: ruined / paths,
    fan: stepIndexes.map((tradeIndex, index) => ({
      step: tradeIndex + 1,
      ...percentiles(requireAt(fanSamples, index)),
    })),
  };
};

// ---------------------------------------------------------------------------
// Benchmark comparison: per-period returns over timestamps present in both series; OLS beta.

export const benchmarkStats = (
  equity: readonly AnalyticsEquityPoint[],
  benchmark: readonly AnalyticsEquityPoint[],
  periodsPerYear: number | null
): BenchmarkStats | null => {
  const byTime = new Map(
    benchmark.map((point) => [timeMs(point.t), point.equity])
  );
  const aligned = equity.flatMap((point) => {
    const other = byTime.get(timeMs(point.t));
    return other === undefined
      ? []
      : [{ strategy: point.equity, benchmark: other }];
  });
  if (aligned.length < 3) return null;
  const strategyReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  for (let index = 1; index < aligned.length; index += 1) {
    strategyReturns.push(
      requireAt(aligned, index).strategy /
        requireAt(aligned, index - 1).strategy -
        1
    );
    benchmarkReturns.push(
      requireAt(aligned, index).benchmark /
        requireAt(aligned, index - 1).benchmark -
        1
    );
  }
  const strategyMean = mean(strategyReturns);
  const benchmarkMean = mean(benchmarkReturns);
  let covariance = 0;
  let benchmarkVariance = 0;
  let strategyVariance = 0;
  for (let index = 0; index < strategyReturns.length; index += 1) {
    const ds = requireAt(strategyReturns, index) - strategyMean;
    const db = requireAt(benchmarkReturns, index) - benchmarkMean;
    covariance += ds * db;
    benchmarkVariance += db * db;
    strategyVariance += ds * ds;
  }
  if (benchmarkVariance === 0 || strategyVariance === 0) return null;
  const beta = covariance / benchmarkVariance;
  const correlation =
    covariance / Math.sqrt(benchmarkVariance * strategyVariance);
  return {
    n: strategyReturns.length,
    beta,
    alphaAnnual: (strategyMean - beta * benchmarkMean) * (periodsPerYear ?? 1),
    correlation,
    rSquared: correlation ** 2,
    benchmarkReturn:
      requireAt(aligned, aligned.length - 1).benchmark /
        requireAt(aligned, 0).benchmark -
      1,
  };
};

// ---------------------------------------------------------------------------
// Entry point

export type BacktestAnalyticsInput = Readonly<{
  id: string;
  equity: readonly AnalyticsEquityPoint[];
  trades: readonly AnalyticsTrade[];
  initialCapital?: number | null;
  benchmark?: readonly AnalyticsEquityPoint[] | null;
  ledger?: TrialLedger | null;
}>;

// This backtest's own trial figures for the multiple-testing section; null without moments.
const currentTrial = (
  id: string,
  equity: readonly AnalyticsEquityPoint[],
  series: readonly number[],
  returns: ReturnStats | null
): CurrentTrial | null => {
  if (
    returns === null ||
    returns.skew === null ||
    returns.excessKurtosis === null
  )
    return null;
  return {
    returns: {
      id,
      returns: series.length,
      meanReturn: mean(series),
      stdReturn: stdev(series),
      firstT: requireAt(equity, 0).t,
      lastT: requireAt(equity, equity.length - 1).t,
    },
    periodsPerYear: returns.periodsPerYear,
    skew: returns.skew,
    excessKurtosis: returns.excessKurtosis,
  };
};

// Multiple testing needs the caller's trial ledger; without one the section is null.
const ledgerTesting = (
  input: BacktestAnalyticsInput,
  series: readonly number[],
  returns: ReturnStats | null
): MultipleTesting | null =>
  input.ledger === undefined || input.ledger === null
    ? null
    : multipleTesting(
        input.ledger,
        currentTrial(input.id, input.equity, series, returns)
      );

export const computeBacktestAnalytics = (
  input: BacktestAnalyticsInput
): BacktestAnalytics => {
  const seed = seedFrom(input.id);
  const random = createRandom(seed);
  const returns = returnStats(input.equity);
  const trades = tradeStats(input.trades);
  const series = simpleReturns(input.equity);
  const blockLength = series.length >= 3 ? blockLengthFor(series.length) : null;
  const capital = input.initialCapital ?? input.equity[0]?.equity ?? null;
  const pnls = input.trades.map((trade) => trade.pnl);

  const sharpeSamples: number[] = [];
  const totalReturnSamples: number[] = [];
  const drawdownSamples: number[] = [];
  if (returns !== null && blockLength !== null) {
    for (let index = 0; index < ANALYTICS_RESAMPLES; index += 1) {
      const sample = blockResample(series, blockLength, random);
      const sharpe = sharpeOf(sample);
      sharpeSamples.push(
        sharpe === null
          ? Number.NaN
          : sharpe * Math.sqrt(returns.periodsPerYear)
      );
      const path = compound(sample);
      totalReturnSamples.push(requireAt(path, path.length - 1) - 1);
      drawdownSamples.push(maxDrawdownOf(path));
    }
  }

  const winRateSamples: number[] = [];
  const profitFactorSamples: number[] = [];
  const expectancySamples: number[] = [];
  if (pnls.length > 0) {
    for (let index = 0; index < ANALYTICS_RESAMPLES; index += 1) {
      const sample = resample(pnls, random);
      winRateSamples.push(
        sample.filter((value) => value > 0).length / sample.length
      );
      profitFactorSamples.push(profitFactorOf(sample));
      expectancySamples.push(mean(sample));
    }
  }

  const canSimulate = pnls.length >= 2 && capital !== null && capital > 0;
  return {
    method: {
      version: BACKTEST_ANALYTICS_VERSION,
      seed,
      resamples: ANALYTICS_RESAMPLES,
      monteCarloPaths: MONTE_CARLO_PATHS,
      ruinFraction: RUIN_FRACTION,
      initialCapital: capital,
      blockLength,
    },
    returns,
    trades,
    drawdowns: drawdownSummary(input.equity),
    monthlyReturns: calendarReturns(input.equity, "month"),
    yearlyReturns: calendarReturns(input.equity, "year"),
    pnlBy: {
      weekday: pnlBuckets(input.trades, "weekday"),
      hour: pnlBuckets(input.trades, "hour"),
      month: pnlBuckets(input.trades, "month"),
      year: pnlBuckets(input.trades, "year"),
    },
    distribution: pnlDistribution(input.trades),
    regimes: regimeRows(input.trades),
    bootstrap: {
      sharpe: interval(sharpeSamples),
      totalReturn: interval(totalReturnSamples),
      maxDrawdown: interval(drawdownSamples),
      winRate: interval(winRateSamples),
      profitFactor: interval(profitFactorSamples),
      expectancy: interval(expectancySamples),
    },
    monteCarlo: canSimulate
      ? {
          reshuffle: monteCarlo(pnls, capital, "reshuffle", random),
          bootstrap: monteCarlo(pnls, capital, "bootstrap", random),
        }
      : null,
    benchmark:
      input.benchmark === undefined ||
      input.benchmark === null ||
      returns === null
        ? null
        : benchmarkStats(input.equity, input.benchmark, returns.periodsPerYear),
    multipleTesting: ledgerTesting(input, series, returns),
    volatility: volatilityClustering(series, returns?.periodsPerYear ?? null),
    significance: {
      tTest: meanTTest(series),
      stationaryBootstrap:
        returns === null || blockLength === null
          ? null
          : stationaryBootstrap(
              series,
              blockLength,
              ANALYTICS_RESAMPLES,
              Math.sqrt(returns.periodsPerYear),
              createRandom(seedFrom(`${input.id}:significance`))
            ),
    },
  };
};
