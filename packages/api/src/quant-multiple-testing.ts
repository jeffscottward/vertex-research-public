// Multiple-testing corrections for a set of backtests of one strategy (or one ledger task):
// the deflated Sharpe ratio (Bailey and Lopez de Prado 2014) and Benjamini-Hochberg q-values.

import { at, hasSpread, mean, timeMs } from "./quant-arrays.ts";
import {
  normalCdfPrecise,
  normalQuantile,
  studentTCdf,
} from "./quant-distributions.ts";

const EULER_GAMMA = 0.577_215_664_901_532_9;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const FDR_ALPHA = 0.05;

// Expected maximum Sharpe ratio of nTrials unskilled trials whose Sharpe ratios have the given
// variance (same units as the variance). One trial gives 0: nothing was selected.
export const expectedMaxSharpe = (
  nTrials: number,
  sharpeVariance: number
): number => {
  if (nTrials < 2) return 0;
  return (
    Math.sqrt(sharpeVariance) *
    ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / nTrials) +
      EULER_GAMMA * normalQuantile(1 - 1 / (nTrials * Math.E)))
  );
};

export type DeflatedSharpe = Readonly<{
  sharpe: number;
  trials: number;
  sharpeVariance: number;
  observations: number;
  expectedMaxSharpe: number;
  z: number;
  probability: number;
}>;

// All Sharpe inputs per observation (not annualized). kurtosis is raw (3 for normal returns).
export const deflatedSharpe = (
  input: Readonly<{
    sharpe: number;
    trials: number;
    sharpeVariance: number;
    observations: number;
    skew: number;
    kurtosis: number;
  }>
): DeflatedSharpe | null => {
  const benchmark = expectedMaxSharpe(input.trials, input.sharpeVariance);
  const radicand =
    1 -
    input.skew * input.sharpe +
    ((input.kurtosis - 1) / 4) * input.sharpe ** 2;
  if (input.observations < 2 || !(radicand > 0)) return null;
  const z =
    ((input.sharpe - benchmark) * Math.sqrt(input.observations - 1)) /
    Math.sqrt(radicand);
  return {
    expectedMaxSharpe: benchmark,
    observations: input.observations,
    probability: normalCdfPrecise(z),
    sharpe: input.sharpe,
    sharpeVariance: input.sharpeVariance,
    trials: input.trials,
    z,
  };
};

// Benjamini-Hochberg (1995) adjusted p-values (q-values), in input order.
export const benjaminiHochberg = (pValues: readonly number[]): number[] => {
  const m = pValues.length;
  const order = pValues
    .map((value, index) => ({ index, value }))
    .sort((left, right) => left.value - right.value);
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const entry = at(order, rank - 1);
    running = Math.min(running, (entry.value * m) / rank);
    adjusted[entry.index] = running;
  }
  return adjusted;
};

// Per-period return summary of one trial in the ledger (computed by the database for other trials).
export type TrialReturns = Readonly<{
  id: string;
  returns: number;
  meanReturn: number | null;
  stdReturn: number | null;
  firstT: string | null;
  lastT: string | null;
}>;

// Ledger scopes: one strategy or task of the agent ledger, or one Autopilot series (every
// candidate bred, mutated or tested on a symbol and timeframe).
export type LedgerScope = "strategy" | "task" | "autopilot";

export type TrialLedger<Scope extends LedgerScope = "strategy" | "task"> =
  Readonly<{
    scope: Scope;
    key: string;
    total: number;
    // Other trials in the scope, newest first; at most a bounded number.
    others: readonly TrialReturns[];
  }>;

type UsableTrial = Readonly<{
  id: string;
  annualSharpe: number;
  pValue: number;
}>;

// A trial is usable with three or more returns, spread and a positive elapsed time.
export const usableTrial = (trial: TrialReturns): UsableTrial | null => {
  const { meanReturn, stdReturn, firstT, lastT } = trial;
  if (
    trial.returns < 3 ||
    meanReturn === null ||
    stdReturn === null ||
    !hasSpread(meanReturn, stdReturn) ||
    firstT === null ||
    lastT === null
  )
    return null;
  const years = (timeMs(lastT) - timeMs(firstT)) / YEAR_MS;
  if (!(years > 0)) return null;
  const perPeriod = meanReturn / stdReturn;
  return {
    annualSharpe: perPeriod * Math.sqrt(trial.returns / years),
    id: trial.id,
    pValue:
      1 - studentTCdf(perPeriod * Math.sqrt(trial.returns), trial.returns - 1),
  };
};

export type MultipleTesting<Scope extends LedgerScope = "strategy" | "task"> =
  Readonly<{
    ledger: Readonly<{
      scope: Scope;
      key: string;
      trials: number;
      usableTrials: number;
      sampled: number;
    }>;
    deflatedSharpe: DeflatedSharpe | null;
    deflatedSharpeReason: string | null;
    benjaminiHochberg: Readonly<{
      alpha: number;
      tested: number;
      discoveries: number;
      qValue: number;
    }> | null;
    benjaminiHochbergReason: string | null;
  }>;

// The current backtest's own figures, from its equity series.
export type CurrentTrial = Readonly<{
  returns: TrialReturns;
  periodsPerYear: number;
  skew: number;
  excessKurtosis: number;
}>;

export const multipleTesting = <Scope extends LedgerScope>(
  ledger: TrialLedger<Scope>,
  current: CurrentTrial | null
): MultipleTesting<Scope> => {
  const self = current === null ? null : usableTrial(current.returns);
  const usable = ledger.others.flatMap((trial) => {
    const result = usableTrial(trial);
    return result === null ? [] : [result];
  });
  const all = self === null ? usable : [self, ...usable];
  const summary = {
    key: ledger.key,
    sampled: ledger.others.length + 1,
    scope: ledger.scope,
    trials: ledger.total,
    usableTrials: all.length,
  };
  if (current === null || self === null) {
    const reason =
      "This backtest needs at least three equity returns with variation and elapsed time.";
    return {
      benjaminiHochberg: null,
      benjaminiHochbergReason: reason,
      deflatedSharpe: null,
      deflatedSharpeReason: reason,
      ledger: summary,
    };
  }
  const annual = all.map((trial) => trial.annualSharpe);
  const average = mean(annual);
  const variance =
    annual.length < 2
      ? 0
      : annual.reduce((total, value) => total + (value - average) ** 2, 0) /
        (annual.length - 1);
  const varianceKnown = ledger.total === 1 || annual.length >= 2;
  const dsr = varianceKnown
    ? deflatedSharpe({
        kurtosis: current.excessKurtosis + 3,
        observations: current.returns.returns,
        sharpe: self.annualSharpe / Math.sqrt(current.periodsPerYear),
        sharpeVariance: variance / current.periodsPerYear,
        skew: current.skew,
        trials: ledger.total,
      })
    : null;
  // Results outside the sampled set count as tests with p = 1, which keeps q conservative.
  const unseen = Math.max(0, ledger.total - summary.sampled);
  const qValues = benjaminiHochberg([
    ...all.map((trial) => trial.pValue),
    ...new Array<number>(unseen).fill(1),
  ]);
  return {
    benjaminiHochberg: {
      alpha: FDR_ALPHA,
      discoveries: qValues.filter((value) => value <= FDR_ALPHA).length,
      qValue: at(qValues, 0),
      tested: qValues.length,
    },
    benjaminiHochbergReason: null,
    deflatedSharpe: dsr,
    deflatedSharpeReason: varianceKnown
      ? dsr === null
        ? "The skew and kurtosis of the returns make the deflation term undefined."
        : null
      : "Other trials exist, but none has usable returns, so the Sharpe variance across trials is unknown.",
    ledger: summary,
  };
};
