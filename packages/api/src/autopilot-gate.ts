// Autopilot evaluation and the fixed verification gate. Breeding sees only in-sample results
// (evaluateInSample runs on the in-sample bars alone). The gate runs the same definition over all
// bars once (the engine is causal) and judges the out-of-sample part, forward folds, a Monte Carlo
// trade bootstrap, costs, and the deflated Sharpe ratio and Benjamini-Hochberg q-value over every
// trial of the series. Pure and deterministic. A passed gate is a research result; it never
// authorizes a trade.

import {
  type AnalyticsEquityPoint,
  createRandom,
  monteCarlo,
  returnStats,
  seedFrom,
} from "./backtest-analytics.ts";
import {
  type BarColumns,
  downsampleIndexes,
  InstantBacktestInputError,
  type InstantRunResult,
} from "./instant-backtest-engine.ts";
import { at, mean, stdev } from "./quant-arrays.ts";
import {
  multipleTesting,
  type TrialReturns,
} from "./quant-multiple-testing.ts";
import type { StrategyDefinition } from "./strategy-dsl.ts";
import { runStrategyDefinition } from "./strategy-dsl-compile.ts";

export const AUTOPILOT_GATE = Object.freeze({
  version: "autopilot-gate-v1",
  /** Share of the bars used for breeding and selection; the rest is out of sample. */
  inSampleFraction: 0.6,
  /** The longest block indicator (250 bars) must fit into the in-sample bars. */
  minBars: 500,
  /** Trades needed for full fitness in sample; fewer trades scale the fitness down. */
  inSampleTradesForFullFitness: 15,
  oosSharpeMin: 0.5,
  forwardFolds: 3,
  monteCarloProfitMin: 0.8,
  monteCarloDrawdownP5Min: -0.35,
  deflatedSharpeMin: 0.95,
  fdrAlpha: 0.05,
  minTradesTotal: 30,
  minTradesOos: 8,
  minCostBps: 1,
  costStressMultiple: 2,
  neighbourShareMin: 0.75,
  neighbourSharpeRatio: 0.5,
  curvePoints: 300,
});

export type AutopilotGateCheckId =
  | "oosSharpe"
  | "forwardFolds"
  | "monteCarlo"
  | "deflatedSharpe"
  | "fdr"
  | "minTrades"
  | "costs"
  | "neighbours";

export type AutopilotGateCheck = Readonly<{
  id: AutopilotGateCheckId;
  label: string;
  passed: boolean;
  value: number | null;
  threshold: string;
  detail: string;
}>;

export type ReturnSummary = Omit<TrialReturns, "id">;

export type InSampleResult = Readonly<{
  fitness: number | null;
  sharpe: number | null;
  totalReturn: number;
  maxDrawdown: number;
  trades: number;
  periodsPerYear: number;
  skew: number | null;
  excessKurtosis: number | null;
  summary: ReturnSummary;
}>;

export type AutopilotLedger = Readonly<{
  key: string;
  /** Every trial on the series, including the candidate itself. */
  total: number;
  /** A sample of other trials, without the candidate. */
  others: readonly TrialReturns[];
}>;

export type GateReport = Readonly<{
  version: string;
  passed: boolean;
  checks: readonly AutopilotGateCheck[];
  splitT: string;
  oos: Readonly<{
    sharpe: number | null;
    totalReturn: number;
    cagr: number | null;
    maxDrawdown: number;
    trades: number;
  }>;
  folds: readonly Readonly<{ from: string; to: string; totalReturn: number }>[];
  monteCarlo: Readonly<{
    probabilityOfProfit: number;
    drawdownP5: number;
    finalP5: number;
    finalP50: number;
  }> | null;
  deflatedSharpe: Readonly<{
    probability: number;
    sharpe: number;
    expectedMaxSharpe: number;
    trials: number;
  }> | null;
  fdr: Readonly<{ qValue: number; tested: number; discoveries: number }> | null;
  costStress: Readonly<{ costBps: number; oosSharpe: number | null }>;
  tradesTotal: number;
  curve: readonly AnalyticsEquityPoint[];
}>;

export const splitIndex = (size: number): number =>
  Math.floor(size * AUTOPILOT_GATE.inSampleFraction);

const iso = (bars: BarColumns, index: number): string =>
  new Date(bars.t[index] as number).toISOString();

const slice = (bars: BarColumns, end: number): BarColumns => ({
  c: bars.c.subarray(0, end),
  h: bars.h.subarray(0, end),
  l: bars.l.subarray(0, end),
  o: bars.o.subarray(0, end),
  t: bars.t.subarray(0, end),
});

const points = (
  bars: BarColumns,
  equity: Float64Array,
  from: number,
  to: number
): AnalyticsEquityPoint[] => {
  const result: AnalyticsEquityPoint[] = [];
  for (let index = from; index < to; index += 1)
    result.push({ equity: equity[index] as number, t: iso(bars, index) });
  return result;
};

const statsOf = (series: readonly AnalyticsEquityPoint[]) => {
  const stats = returnStats(series);
  if (stats === null)
    throw new InstantBacktestInputError("Bar times must increase");
  return stats;
};

// Engine equity starts at 1 and stays above 0 (long only, no leverage).
const summaryOf = (series: readonly AnalyticsEquityPoint[]): ReturnSummary => {
  const returns = series
    .slice(1)
    .map((point, index) => point.equity / at(series, index).equity - 1);
  return {
    firstT: at(series, 0).t,
    lastT: at(series, series.length - 1).t,
    meanReturn: mean(returns),
    returns: returns.length,
    stdReturn: stdev(returns),
  };
};

const requireBars = (bars: BarColumns): void => {
  if (bars.c.length < AUTOPILOT_GATE.minBars)
    throw new InstantBacktestInputError(
      `Autopilot needs at least ${AUTOPILOT_GATE.minBars} bars; got ${bars.c.length}`
    );
};

/** Runs the definition on the in-sample bars only and scores it. Breeding uses nothing else. */
export const evaluateInSample = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number
): InSampleResult => {
  requireBars(bars);
  const end = splitIndex(bars.c.length);
  const inSample = slice(bars, end);
  const run = runStrategyDefinition(inSample, definition, costBps);
  const series = points(inSample, run.equity, 0, end);
  const stats = statsOf(series);
  const trades = run.trades.length;
  return {
    excessKurtosis: stats.excessKurtosis,
    fitness:
      stats.sharpe === null || trades === 0
        ? null
        : stats.sharpe *
          Math.min(1, trades / AUTOPILOT_GATE.inSampleTradesForFullFitness),
    maxDrawdown: stats.maxDrawdown,
    periodsPerYear: stats.periodsPerYear,
    sharpe: stats.sharpe,
    skew: stats.skew,
    summary: summaryOf(series),
    totalReturn: stats.totalReturn,
    trades,
  };
};

const outOfSample = (bars: BarColumns, run: InstantRunResult, end: number) =>
  statsOf(points(bars, run.equity, end - 1, bars.c.length));

/** Annualized out-of-sample Sharpe ratio of a full run; used for parameter neighbours. */
export const outOfSampleSharpe = (
  bars: BarColumns,
  definition: StrategyDefinition,
  costBps: number
): number | null => {
  requireBars(bars);
  return outOfSample(
    bars,
    runStrategyDefinition(bars, definition, costBps),
    splitIndex(bars.c.length)
  ).sharpe;
};

const format = (value: number | null, digits = 2): string =>
  value === null ? "n/a" : value.toFixed(digits);

const check = (
  id: AutopilotGateCheckId,
  label: string,
  passed: boolean,
  value: number | null,
  threshold: string,
  detail: string
): AutopilotGateCheck => ({ detail, id, label, passed, threshold, value });

const foldsOf = (bars: BarColumns, equity: Float64Array, end: number) => {
  const size = bars.c.length;
  const width = Math.floor((size - end) / AUTOPILOT_GATE.forwardFolds);
  return Array.from({ length: AUTOPILOT_GATE.forwardFolds }, (_, fold) => {
    const from = end + fold * width;
    const to = fold === AUTOPILOT_GATE.forwardFolds - 1 ? size : from + width;
    return {
      from: iso(bars, from),
      to: iso(bars, to - 1),
      totalReturn:
        (equity[to - 1] as number) / (equity[from - 1] as number) - 1,
    };
  });
};

const curveOf = (bars: BarColumns, equity: Float64Array) =>
  downsampleIndexes(bars.c.length, AUTOPILOT_GATE.curvePoints).map((index) => ({
    equity: equity[index] as number,
    t: iso(bars, index),
  }));

/**
 * Runs the fixed gate (all checks except the neighbour check, which the refine step adds). The
 * ledger total must count every trial on the series: every bred, random and neighbour candidate.
 */
export const evaluateGate = (
  input: Readonly<{
    bars: BarColumns;
    definition: StrategyDefinition;
    costBps: number;
    inSample: InSampleResult;
    ledger: AutopilotLedger;
    seed: string;
  }>
): GateReport => {
  const { bars, costBps, definition, inSample, ledger } = input;
  const gate = AUTOPILOT_GATE;
  requireBars(bars);
  const end = splitIndex(bars.c.length);
  const run = runStrategyDefinition(bars, definition, costBps);
  const oos = outOfSample(bars, run, end);
  const oosTrades = run.trades.filter((trade) => trade.entryIndex >= end);
  const folds = foldsOf(bars, run.equity, end);
  const monte =
    oosTrades.length === 0
      ? null
      : monteCarlo(
          oosTrades.map((trade) => trade.netReturn),
          1,
          "bootstrap",
          createRandom(seedFrom(input.seed))
        );
  const stressBps =
    Math.max(costBps, gate.minCostBps) * gate.costStressMultiple;
  const stressed = outOfSample(
    bars,
    runStrategyDefinition(bars, definition, stressBps),
    end
  );
  const testing = multipleTesting(
    {
      key: ledger.key,
      others: ledger.others,
      scope: "autopilot",
      total: ledger.total,
    },
    {
      excessKurtosis: inSample.excessKurtosis ?? 0,
      periodsPerYear: inSample.periodsPerYear,
      returns: { id: "candidate", ...inSample.summary },
      skew: inSample.skew ?? 0,
    }
  );
  const dsr = testing.deflatedSharpe;
  const fdr = testing.benjaminiHochberg;
  const oosSharpe = oos.sharpe;
  const profitableFolds = folds.filter((fold) => fold.totalReturn > 0).length;
  const checks: AutopilotGateCheck[] = [
    check(
      "oosSharpe",
      "Out-of-sample Sharpe",
      oosSharpe !== null && oosSharpe >= gate.oosSharpeMin,
      oosSharpe,
      `>= ${gate.oosSharpeMin}`,
      `Annualized Sharpe ratio on the last ${Math.round((1 - gate.inSampleFraction) * 100)}% of the bars: ${format(oosSharpe)}.`
    ),
    check(
      "forwardFolds",
      "Forward folds profitable",
      profitableFolds === gate.forwardFolds,
      profitableFolds,
      `${gate.forwardFolds} of ${gate.forwardFolds}`,
      `Fold returns: ${folds.map((fold) => `${(fold.totalReturn * 100).toFixed(1)}%`).join(", ")}.`
    ),
    check(
      "monteCarlo",
      "Monte Carlo trade bootstrap",
      monte !== null &&
        monte.probabilityOfProfit >= gate.monteCarloProfitMin &&
        monte.maxDrawdown.p5 >= gate.monteCarloDrawdownP5Min,
      monte?.probabilityOfProfit ?? null,
      `P(profit) >= ${gate.monteCarloProfitMin}, 5th percentile drawdown >= ${gate.monteCarloDrawdownP5Min * 100}%`,
      monte === null
        ? "No out-of-sample trades to resample."
        : `P(profit) ${format(monte.probabilityOfProfit)}, 5th percentile drawdown ${(monte.maxDrawdown.p5 * 100).toFixed(1)}% over 1000 bootstrap paths of ${oosTrades.length} trades.`
    ),
    check(
      "deflatedSharpe",
      "Deflated Sharpe ratio",
      dsr !== null && dsr.probability >= gate.deflatedSharpeMin,
      dsr?.probability ?? null,
      `>= ${gate.deflatedSharpeMin}`,
      dsr === null
        ? String(testing.deflatedSharpeReason)
        : `In-sample Sharpe deflated for ${ledger.total} trials on this series (expected maximum ${format(dsr.expectedMaxSharpe, 4)} per bar).`
    ),
    check(
      "fdr",
      "Benjamini-Hochberg q-value",
      fdr !== null && fdr.qValue <= gate.fdrAlpha,
      fdr?.qValue ?? null,
      `<= ${gate.fdrAlpha}`,
      fdr === null
        ? String(testing.benjaminiHochbergReason)
        : `${fdr.tested} tests, ${fdr.discoveries} discoveries at ${gate.fdrAlpha}.`
    ),
    check(
      "minTrades",
      "Minimum trades",
      run.trades.length >= gate.minTradesTotal &&
        oosTrades.length >= gate.minTradesOos,
      run.trades.length,
      `>= ${gate.minTradesTotal} in total, >= ${gate.minTradesOos} out of sample`,
      `${run.trades.length} trades in total, ${oosTrades.length} out of sample.`
    ),
    check(
      "costs",
      "Costs and cost stress",
      costBps >= gate.minCostBps &&
        stressed.sharpe !== null &&
        stressed.sharpe > 0,
      stressed.sharpe,
      `cost >= ${gate.minCostBps} bps per side; out-of-sample Sharpe > 0 at ${gate.costStressMultiple}x cost`,
      `Run cost ${costBps} bps per side; at ${stressBps} bps the out-of-sample Sharpe is ${format(stressed.sharpe)}.`
    ),
  ];
  return {
    checks,
    costStress: { costBps: stressBps, oosSharpe: stressed.sharpe },
    curve: curveOf(bars, run.equity),
    deflatedSharpe:
      dsr === null
        ? null
        : {
            expectedMaxSharpe: dsr.expectedMaxSharpe,
            probability: dsr.probability,
            sharpe: dsr.sharpe,
            trials: dsr.trials,
          },
    fdr:
      fdr === null
        ? null
        : {
            discoveries: fdr.discoveries,
            qValue: fdr.qValue,
            tested: fdr.tested,
          },
    folds,
    monteCarlo:
      monte === null
        ? null
        : {
            drawdownP5: monte.maxDrawdown.p5,
            finalP5: monte.finalPnl.p5,
            finalP50: monte.finalPnl.p50,
            probabilityOfProfit: monte.probabilityOfProfit,
          },
    oos: {
      cagr: oos.cagr,
      maxDrawdown: oos.maxDrawdown,
      sharpe: oosSharpe,
      totalReturn: oos.totalReturn,
      trades: oosTrades.length,
    },
    passed: checks.every((item) => item.passed),
    splitT: iso(bars, end),
    tradesTotal: run.trades.length,
    version: gate.version,
  };
};

/**
 * Refine step: the parameter neighbours must hold up. A neighbour passes when its out-of-sample
 * Sharpe is at least half of the candidate's and above 0. The check passes when at least 75% of the
 * neighbours pass. A candidate without neighbours fails: nothing shows that it is stable.
 */
export const neighbourCheck = (
  candidateSharpe: number | null,
  neighbours: readonly (number | null)[]
): AutopilotGateCheck => {
  const gate = AUTOPILOT_GATE;
  const floor =
    candidateSharpe === null
      ? null
      : candidateSharpe * gate.neighbourSharpeRatio;
  const held = neighbours.filter(
    (sharpe) =>
      floor !== null && sharpe !== null && sharpe > 0 && sharpe >= floor
  ).length;
  const share = neighbours.length === 0 ? 0 : held / neighbours.length;
  return check(
    "neighbours",
    "Parameter neighbourhood",
    neighbours.length > 0 && share >= gate.neighbourShareMin,
    share,
    `>= ${gate.neighbourShareMin * 100}% of neighbours keep >= ${gate.neighbourSharpeRatio * 100}% of the out-of-sample Sharpe`,
    `${held} of ${neighbours.length} neighbours hold up.`
  );
};
