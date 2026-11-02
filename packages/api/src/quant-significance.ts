// Significance tests for a per-period return series.
// H0 for every p-value here: the true mean return (or Sharpe ratio) is zero or below.
// H1: it is above zero. p-values are one-sided; the t-test also reports the two-sided value.

import {
  at,
  hasSpread,
  mean,
  quantile,
  sorted,
  stdev,
} from "./quant-arrays.ts";
import { studentTCdf, studentTQuantile } from "./quant-distributions.ts";

export type MeanTTest = Readonly<{
  n: number;
  mean: number;
  stdError: number;
  t: number;
  df: number;
  pValue: number;
  pValueTwoSided: number;
  ciLower: number;
  ciUpper: number;
}>;

export type BootstrapTest = Readonly<{
  estimate: number;
  ciLower: number;
  ciUpper: number;
  pValue: number;
}>;

export type StationaryBootstrapResult = Readonly<{
  expectedBlockLength: number;
  resamples: number;
  mean: BootstrapTest;
  sharpe: BootstrapTest | null;
}>;

// One-sample Student t-test of the mean with a 95% confidence interval. Needs n >= 3 and spread.
export const meanTTest = (returns: readonly number[]): MeanTTest | null => {
  const n = returns.length;
  const deviation = stdev(returns);
  const average = mean(returns);
  if (n < 3 || !hasSpread(average, deviation)) return null;
  const stdError = deviation / Math.sqrt(n);
  const t = average / stdError;
  const df = n - 1;
  const critical = studentTQuantile(0.975, df);
  return {
    ciLower: average - critical * stdError,
    ciUpper: average + critical * stdError,
    df,
    mean: average,
    n,
    pValue: 1 - studentTCdf(t, df),
    pValueTwoSided: 2 * (1 - studentTCdf(Math.abs(t), df)),
    stdError,
    t,
  };
};

// Politis and Romano (1994) stationary bootstrap: blocks start at random positions, wrap around
// the series, and have geometric lengths with the given mean.
export const stationaryResample = (
  values: readonly number[],
  expectedBlockLength: number,
  random: () => number
): number[] => {
  const n = values.length;
  const restart = 1 / expectedBlockLength;
  const result: number[] = [];
  let index = Math.floor(random() * n);
  for (let step = 0; step < n; step += 1) {
    if (step > 0)
      index = random() < restart ? Math.floor(random() * n) : (index + 1) % n;
    result.push(at(values, index));
  }
  return result;
};

// Percentile interval plus a one-sided p-value from the centred bootstrap distribution:
// p = (1 + #{theta* - theta >= theta}) / (B + 1).
export const bootstrapTest = (
  estimate: number,
  samples: readonly number[]
): BootstrapTest | null => {
  const finite = samples.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const ordered = sorted(finite);
  const extreme = finite.filter((value) => value - estimate >= estimate).length;
  return {
    ciLower: quantile(ordered, 0.025),
    ciUpper: quantile(ordered, 0.975),
    estimate,
    pValue: (1 + extreme) / (1 + finite.length),
  };
};

const sharpeOf = (values: readonly number[]): number => {
  const deviation = stdev(values);
  const average = mean(values);
  return hasSpread(average, deviation) ? average / deviation : Number.NaN;
};

// Stationary bootstrap of the mean return and of the annualized Sharpe ratio.
// annualization: sqrt(periods per year); the mean stays per period.
export const stationaryBootstrap = (
  returns: readonly number[],
  expectedBlockLength: number,
  resamples: number,
  annualization: number,
  random: () => number
): StationaryBootstrapResult | null => {
  if (returns.length < 3) return null;
  const means: number[] = [];
  const sharpes: number[] = [];
  for (let index = 0; index < resamples; index += 1) {
    const sample = stationaryResample(returns, expectedBlockLength, random);
    means.push(mean(sample));
    sharpes.push(sharpeOf(sample) * annualization);
  }
  const meanTest = bootstrapTest(mean(returns), means);
  if (meanTest === null) return null;
  const sharpe = sharpeOf(returns);
  return {
    expectedBlockLength,
    mean: meanTest,
    resamples,
    sharpe: Number.isFinite(sharpe)
      ? bootstrapTest(sharpe * annualization, sharpes)
      : null,
  };
};
