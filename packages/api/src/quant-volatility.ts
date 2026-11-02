// Volatility clustering for a per-period return series: Ljung-Box test on squared returns and a
// Gaussian GARCH(1,1) fit with variance targeting (Engle and Mezrich 1996).
// Research display only. The forecasts are not a sizing input.

import { at, mean } from "./quant-arrays.ts";
import { chiSquareSurvival } from "./quant-distributions.ts";

const GARCH_MIN_RETURNS = 50;
const LJUNG_BOX_MIN_VALUES = 20;
const VOL_FORECAST_HORIZON = 21;
const MAX_PERSISTENCE = 0.9999;

export type LjungBox = Readonly<{
  n: number;
  lags: number;
  q: number;
  pValue: number;
}>;

// Ljung and Box (1978) Q statistic on the demeaned series with lags = min(10, floor(n / 5)).
// H0: no autocorrelation up to that lag. Chi-square with `lags` degrees of freedom.
export const ljungBox = (values: readonly number[]): LjungBox | null => {
  const n = values.length;
  if (n < LJUNG_BOX_MIN_VALUES) return null;
  const average = mean(values);
  const centred = values.map((value) => value - average);
  let denominator = 0;
  for (const value of centred) denominator += value * value;
  if (denominator === 0) return null;
  const lags = Math.min(10, Math.floor(n / 5));
  let q = 0;
  for (let lag = 1; lag <= lags; lag += 1) {
    let numerator = 0;
    for (let index = lag; index < n; index += 1)
      numerator += at(centred, index) * at(centred, index - lag);
    q += (numerator / denominator) ** 2 / (n - lag);
  }
  q *= n * (n + 2);
  return { n, lags, q, pValue: chiSquareSurvival(q, lags) };
};

export type NelderMeadResult = Readonly<{
  point: number[];
  value: number;
  iterations: number;
  converged: boolean;
}>;

interface Vertex {
  point: number[];
  value: number;
}

// Point on the line from `from` towards `to`, scaled by factor (negative factors reflect).
const move = (from: readonly number[], to: readonly number[], factor: number) =>
  from.map((value, index) => value + factor * (at(to, index) - value));

// One Nelder-Mead step: reflection, expansion or contraction; null asks for a shrink.
const replaceWorst = (
  objective: (point: readonly number[]) => number,
  centroid: readonly number[],
  worst: Vertex,
  bestValue: number,
  secondWorstValue: number
): Vertex | null => {
  const reflected = move(centroid, worst.point, -1);
  const reflectedValue = objective(reflected);
  if (reflectedValue < bestValue) {
    const expanded = move(centroid, worst.point, -2);
    const expandedValue = objective(expanded);
    return expandedValue < reflectedValue
      ? { point: expanded, value: expandedValue }
      : { point: reflected, value: reflectedValue };
  }
  if (reflectedValue < secondWorstValue)
    return { point: reflected, value: reflectedValue };
  const outside = reflectedValue < worst.value;
  const contracted = outside
    ? move(centroid, reflected, 0.5)
    : move(centroid, worst.point, 0.5);
  const contractedValue = objective(contracted);
  return contractedValue < (outside ? reflectedValue : worst.value)
    ? { point: contracted, value: contractedValue }
    : null;
};

// Nelder-Mead simplex minimizer (reflection 1, expansion 2, contraction 0.5, shrink 0.5).
export const nelderMead = (
  objective: (point: readonly number[]) => number,
  start: readonly number[],
  options: Readonly<{ step: number; tolerance: number; maxIterations: number }>
): NelderMeadResult => {
  const dimension = start.length;
  let simplex = [
    { point: [...start], value: objective(start) },
    ...start.map((_, axis) => {
      const point = start.map((value, index) =>
        index === axis ? value + options.step : value
      );
      return { point, value: objective(point) };
    }),
  ];
  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    simplex.sort((left, right) => left.value - right.value);
    const best = at(simplex, 0);
    const worst = at(simplex, dimension);
    if (worst.value - best.value <= options.tolerance)
      return {
        point: best.point,
        value: best.value,
        iterations: iteration,
        converged: true,
      };
    const centroid = best.point.map(
      (_, index) =>
        simplex
          .slice(0, dimension)
          .reduce((total, vertex) => total + at(vertex.point, index), 0) /
        dimension
    );
    const replacement = replaceWorst(
      objective,
      centroid,
      worst,
      best.value,
      at(simplex, dimension - 1).value
    );
    if (replacement === null) {
      simplex = simplex.map((vertex, index) => {
        if (index === 0) return vertex;
        const point = move(best.point, vertex.point, 0.5);
        return { point, value: objective(point) };
      });
    } else simplex[dimension] = replacement;
  }
  simplex.sort((left, right) => left.value - right.value);
  const best = at(simplex, 0);
  return {
    point: best.point,
    value: best.value,
    iterations: options.maxIterations,
    converged: false,
  };
};

// Gaussian GARCH(1,1) negative log-likelihood (without the n * log(2 pi) / 2 constant) of
// demeaned returns, with omega = variance * (1 - alpha - beta) and sigma^2_1 = variance.
export const garchNegativeLogLikelihood = (
  residuals: readonly number[],
  variance: number,
  alpha: number,
  beta: number
): Readonly<{ value: number; nextVariance: number }> => {
  const omega = variance * (1 - alpha - beta);
  let conditional = variance;
  let total = 0;
  for (const residual of residuals) {
    total += Math.log(conditional) + (residual * residual) / conditional;
    conditional = omega + alpha * residual * residual + beta * conditional;
  }
  return { value: 0.5 * total, nextVariance: conditional };
};

export type Garch11 = Readonly<{
  n: number;
  omega: number;
  alpha: number;
  beta: number;
  persistence: number;
  halfLifePeriods: number;
  logLikelihood: number;
  converged: boolean;
  longRunVolAnnual: number;
  nextPeriodVol: number;
  nextPeriodVolAnnual: number;
  horizonPeriods: number;
  horizonVolAnnual: number;
}>;

const logistic = (value: number): number => 1 / (1 + Math.exp(-value));
const logit = (value: number): number => Math.log(value / (1 - value));

// (persistence, alpha share) -> (alpha, beta) keeps alpha, beta >= 0 and alpha + beta < 1.
const parameters = (point: readonly number[]) => {
  const persistence = MAX_PERSISTENCE * logistic(at(point, 0));
  const alpha = persistence * logistic(at(point, 1));
  return { alpha, beta: persistence - alpha, persistence };
};

// Maximum-likelihood fit from three deterministic starting points; keeps the best.
export const fitGarch11 = (
  returns: readonly number[],
  periodsPerYear: number
): Garch11 | null => {
  const n = returns.length;
  if (n < GARCH_MIN_RETURNS) return null;
  const average = mean(returns);
  const residuals = returns.map((value) => value - average);
  const variance =
    residuals.reduce((total, value) => total + value * value, 0) / n;
  // Constant returns leave only rounding noise (about 1e-36); treat that as no variation.
  if (!(variance > Number.EPSILON ** 2)) return null;
  const objective = (point: readonly number[]) => {
    const { alpha, beta } = parameters(point);
    return garchNegativeLogLikelihood(residuals, variance, alpha, beta).value;
  };
  const fits = [0.5, 0.9, 0.98].map((startPersistence) =>
    nelderMead(
      objective,
      [logit(startPersistence / MAX_PERSISTENCE), logit(0.1)],
      { step: 0.5, tolerance: 1e-10, maxIterations: 2000 }
    )
  );
  const fit = fits.reduce((best, candidate) =>
    candidate.value < best.value ? candidate : best
  );
  const { alpha, beta, persistence } = parameters(fit.point);
  const { nextVariance } = garchNegativeLogLikelihood(
    residuals,
    variance,
    alpha,
    beta
  );
  let horizonVariance = 0;
  for (let step = 0; step < VOL_FORECAST_HORIZON; step += 1)
    horizonVariance +=
      variance + persistence ** step * (nextVariance - variance);
  horizonVariance /= VOL_FORECAST_HORIZON;
  return {
    n,
    omega: variance * (1 - persistence),
    alpha,
    beta,
    persistence,
    halfLifePeriods: Math.log(0.5) / Math.log(persistence),
    logLikelihood: -fit.value - 0.5 * n * Math.log(2 * Math.PI),
    converged: fits.every((candidate) => candidate.converged),
    longRunVolAnnual: Math.sqrt(variance * periodsPerYear),
    nextPeriodVol: Math.sqrt(nextVariance),
    nextPeriodVolAnnual: Math.sqrt(nextVariance * periodsPerYear),
    horizonPeriods: VOL_FORECAST_HORIZON,
    horizonVolAnnual: Math.sqrt(horizonVariance * periodsPerYear),
  };
};

export type VolatilityClustering = Readonly<{
  ljungBoxSquared: LjungBox | null;
  garch: Garch11 | null;
  garchReason: string | null;
}>;

export const volatilityClustering = (
  returns: readonly number[],
  periodsPerYear: number | null
): VolatilityClustering => {
  const average = mean(returns);
  const squared = returns.map((value) => (value - average) ** 2);
  const garch =
    periodsPerYear === null ? null : fitGarch11(returns, periodsPerYear);
  return {
    ljungBoxSquared: ljungBox(squared),
    garch,
    garchReason:
      garch === null
        ? returns.length < GARCH_MIN_RETURNS || periodsPerYear === null
          ? `GARCH(1,1) needs at least ${GARCH_MIN_RETURNS} returns.`
          : "The returns have no variation."
        : null,
  };
};
