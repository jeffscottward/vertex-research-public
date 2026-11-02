// Server-derived optimizer analytics: parameter importance, 1-D score profiles and a 2-D heatmap.
// Pure and deterministic for one stored run; computed on every read and never stored.
//
// Score used: the trial's robust score; for Pareto runs (no single score) the first objective's value
// from trial.metrics. Only "ok" trials with a finite score count.
// Groups: a categorical dimension groups by distinct value. A numeric dimension groups by distinct
// value when it has at most PROFILE_BINS distinct values, otherwise into PROFILE_BINS equal-width bins
// over [min, max] (the last bin includes max).
// Importance of a dimension: population variance of the group mean scores (0 with fewer than two
// groups), normalized so all dimensions sum to 1 (all 0 when every variance is 0).
// Profiles: per numeric dimension, each group's [low, high], trial count, mean and best score.
// Heatmap: the two most important numeric dimensions with at least two groups each; cell = mean score
// of trials falling in (x group, y group), null when empty.
import type { OptimizationAnalyticsOutput } from "./contracts/optimizations.ts";

// Bounds-checked indexed read for analytics arrays whose length is already known.
const requireAt = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError("Analytics index out of range");
  }
  return value;
};

export const OPTIMIZATION_ANALYTICS_VERSION = "optimization-analytics-v1";
export const PROFILE_BINS = 10;

type ParamValue = number | boolean | string | null;
type Direction = "maximize" | "minimize";

export type AnalyticsTrial = Readonly<{
  params: Readonly<Record<string, ParamValue>>;
  score: number | null;
  status: "ok" | "failed";
  metrics?: Readonly<Record<string, number>> | undefined;
}>;

export type OptimizationAnalyticsInput = Readonly<{
  method: string;
  objectives: readonly Readonly<{ metric: string; direction: Direction }>[];
  trials: readonly AnalyticsTrial[];
}>;

interface Bin {
  low: number;
  high: number;
}
type Scored = Readonly<{
  params: Readonly<Record<string, ParamValue>>;
  score: number;
}>;

const mean = (values: readonly number[]): number => {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

// Population variance; 0 for fewer than two values.
export const populationVariance = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const center = mean(values);
  return (
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
    values.length
  );
};

const distinctNumbers = (values: readonly number[]): number[] => {
  return [...new Set(values)].sort((a, b) => a - b);
};

// Groups for a numeric dimension: one per distinct value, or PROFILE_BINS equal-width bins.
export const numericBins = (
  values: readonly number[],
  maxBins = PROFILE_BINS
): Readonly<{
  bins: Bin[];
  binned: boolean;
  locate: (value: number) => number;
}> => {
  const distinct = distinctNumbers(values);
  if (distinct.length <= maxBins) {
    const position = new Map(distinct.map((value, index) => [value, index]));
    return {
      bins: distinct.map((value) => ({ low: value, high: value })),
      binned: false,
      locate: (value) => position.get(value) ?? -1,
    };
  }
  const low = requireAt(distinct, 0);
  const high = requireAt(distinct, distinct.length - 1);
  const width = (high - low) / maxBins;
  const bins = Array.from({ length: maxBins }, (_, index) => ({
    low: low + width * index,
    high: index === maxBins - 1 ? high : low + width * (index + 1),
  }));
  return {
    bins,
    binned: true,
    locate: (value) =>
      Math.min(maxBins - 1, Math.max(0, Math.floor((value - low) / width))),
  };
};

const better =
  (direction: Direction) =>
  (a: number, b: number): number => {
    return direction === "maximize" ? Math.max(a, b) : Math.min(a, b);
  };

const scoredTrials = (
  input: OptimizationAnalyticsInput
): Readonly<{ scored: Scored[]; source: string }> => {
  const pareto = input.method === "pareto";
  const metric = input.objectives[0]?.metric ?? "";
  const source = pareto ? `objective:${metric}` : "score";
  const scored: Scored[] = [];
  for (const trial of input.trials) {
    if (trial.status !== "ok") continue;
    const value = pareto ? trial.metrics?.[metric] : trial.score;
    if (typeof value === "number" && Number.isFinite(value))
      scored.push({ params: trial.params, score: value });
  }
  return { scored, source };
};

const dimensionNames = (trials: readonly AnalyticsTrial[]): string[] => {
  const names = new Set<string>();
  for (const trial of trials) {
    for (const name of Object.keys(trial.params)) names.add(name);
  }
  return [...names].sort();
};

type Dimension = Readonly<{
  name: string;
  kind: "numeric" | "categorical";
  groupOf: (trial: Scored) => number;
  bins: Bin[];
  binned: boolean;
  groups: number;
}>;

const describeDimension = (
  name: string,
  scored: readonly Scored[]
): Dimension => {
  const present = scored.filter((trial) => Object.hasOwn(trial.params, name));
  const values = present.map((trial) => trial.params[name]);
  const isNumeric =
    values.length > 0 && values.every((value) => typeof value === "number");
  if (isNumeric) {
    const { bins, binned, locate } = numericBins(values as number[]);
    return {
      name,
      kind: "numeric",
      bins,
      binned,
      groups: bins.length,
      groupOf: (trial) =>
        Object.hasOwn(trial.params, name)
          ? locate(trial.params[name] as number)
          : -1,
    };
  }
  const keys = [
    ...new Set(values.map((value) => JSON.stringify(value))),
  ].sort();
  const position = new Map(keys.map((key, index) => [key, index]));
  return {
    name,
    kind: "categorical",
    bins: [],
    binned: false,
    groups: keys.length,
    groupOf: (trial) =>
      Object.hasOwn(trial.params, name)
        ? (position.get(JSON.stringify(trial.params[name])) ?? -1)
        : -1,
  };
};

const groupScores = (
  dimension: Dimension,
  scored: readonly Scored[]
): number[][] => {
  const groups: number[][] = Array.from({ length: dimension.groups }, () => []);
  for (const trial of scored) {
    const group = dimension.groupOf(trial);
    if (group >= 0) groups[group]?.push(trial.score);
  }
  return groups;
};

export const computeOptimizationAnalytics = (
  input: OptimizationAnalyticsInput
): OptimizationAnalyticsOutput => {
  const direction = input.objectives[0]?.direction ?? "maximize";
  const pick = better(direction);
  const { scored, source } = scoredTrials(input);
  const ok = input.trials.filter((trial) => trial.status === "ok").length;
  const dimensions = dimensionNames(input.trials).map((name) =>
    describeDimension(name, scored)
  );
  const grouped = new Map(
    dimensions.map((dimension) => [
      dimension.name,
      groupScores(dimension, scored),
    ])
  );
  const variances = dimensions.map((dimension) => {
    const means = (grouped.get(dimension.name) ?? [])
      .filter((scores) => scores.length > 0)
      .map(mean);
    return populationVariance(means);
  });
  const total = variances.reduce((sum, value) => sum + value, 0);
  const importance = dimensions
    .map((dimension, index) => ({
      name: dimension.name,
      kind: dimension.kind,
      groups: (grouped.get(dimension.name) ?? []).filter(
        (scores) => scores.length > 0
      ).length,
      variance: requireAt(variances, index),
      importance: total > 0 ? requireAt(variances, index) / total : 0,
    }))
    .sort(
      (a, b) => b.importance - a.importance || a.name.localeCompare(b.name)
    );
  const numeric = dimensions.filter(
    (dimension) => dimension.kind === "numeric"
  );
  const profiles = numeric.map((dimension) => ({
    name: dimension.name,
    binned: dimension.binned,
    bins: dimension.bins.map((bin, index) => {
      const scores = grouped.get(dimension.name)?.[index] ?? [];
      return {
        low: bin.low,
        high: bin.high,
        count: scores.length,
        meanScore: scores.length === 0 ? null : mean(scores),
        bestScore: scores.length === 0 ? null : scores.reduce(pick),
      };
    }),
  }));
  const ranked = importance
    .map((entry) => numeric.find((dimension) => dimension.name === entry.name))
    .filter(
      (dimension): dimension is Dimension =>
        dimension !== undefined && dimension.bins.length >= 2
    );
  let heatmap: OptimizationAnalyticsOutput["heatmap"] = null;
  if (ranked.length >= 2) {
    const [x, y] = [requireAt(ranked, 0), requireAt(ranked, 1)];
    const sums = y.bins.map(() => x.bins.map(() => 0));
    const counts = y.bins.map(() => x.bins.map(() => 0));
    for (const trial of scored) {
      const column = x.groupOf(trial);
      const row = y.groupOf(trial);
      if (column < 0 || row < 0) continue;
      const sumRow = requireAt(sums, row);
      const countRow = requireAt(counts, row);
      sumRow[column] = requireAt(sumRow, column) + trial.score;
      countRow[column] = requireAt(countRow, column) + 1;
    }
    const meanScores = sums.map((cells, row) =>
      cells.map((sum, column) => {
        const count = requireAt(requireAt(counts, row), column);
        return count === 0 ? null : sum / count;
      })
    );
    heatmap = {
      x: x.name,
      y: y.name,
      xBins: x.bins.map((bin) => ({ ...bin })),
      yBins: y.bins.map((bin) => ({ ...bin })),
      meanScores,
      counts,
      filledCells: counts.flat().filter((count) => count > 0).length,
    };
  }
  return {
    version: OPTIMIZATION_ANALYTICS_VERSION,
    direction,
    scoreSource: source,
    trials: {
      stored: input.trials.length,
      ok,
      failed: input.trials.length - ok,
      scored: scored.length,
    },
    importance,
    profiles,
    heatmap,
  };
};
