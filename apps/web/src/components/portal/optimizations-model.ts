// Pure optimizer-run view helpers: tabs, labels, formatting, trial sort/filter and heatmap shading.
import type { OptimizationRunOutput } from "@darkfactory/api";

export const OPTIMIZATION_TABS = [
  "overview",
  "trials",
  "importance",
  "profiles",
  "pareto",
  "folds",
] as const;
export type OptimizationTab = (typeof OPTIMIZATION_TABS)[number];
export const OPTIMIZATION_TAB_LABELS: Readonly<
  Record<OptimizationTab, string>
> = Object.freeze({
  overview: "Overview",
  trials: "Trials",
  importance: "Importance",
  profiles: "Profiles",
  pareto: "Pareto",
  folds: "Folds",
});
export const isOptimizationTab = (value: unknown): value is OptimizationTab => {
  return (
    typeof value === "string" &&
    (OPTIMIZATION_TABS as readonly string[]).includes(value)
  );
};

type RunShape = Pick<OptimizationRunOutput, "method" | "validation">;

// Pareto appears only for Pareto runs and Folds only for walk-forward validation.
export const availableTabs = (run: RunShape): OptimizationTab[] => {
  return OPTIMIZATION_TABS.filter((tab) => {
    if (tab === "pareto") return run.method === "pareto";
    if (tab === "folds") return run.validation.mode === "walk_forward";
    return true;
  });
};

// WAI-ARIA tabs keys: Left/Right wrap around, Home and End jump to the ends; other keys return null.
export const tabKeyTarget = <Tab extends string>(
  key: string,
  current: Tab,
  tabs: readonly Tab[]
): Tab | null => {
  const index = Math.max(0, tabs.indexOf(current));
  switch (key) {
    case "ArrowRight": {
      return tabs[(index + 1) % tabs.length] ?? null;
    }
    case "ArrowLeft": {
      return tabs[(index - 1 + tabs.length) % tabs.length] ?? null;
    }
    case "Home": {
      return tabs[0] ?? null;
    }
    case "End": {
      return tabs.at(-1) ?? null;
    }
    default: {
      return null;
    }
  }
};

export const METHOD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  grid: "Grid",
  random: "Random",
  tpe: "TPE",
  evolution: "Evolution",
  pareto: "Pareto (NSGA-II)",
  market_only: "Market only",
});

export const VALIDATION_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    single: "Single",
    is_oos: "IS / OOS",
    walk_forward: "Walk-forward",
  });

export const STOP_REASON_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    completed: "Completed",
    budget: "Trial budget",
    time_budget: "Time budget",
    exhausted: "Search space exhausted",
  });

const DASH = "—";

export const formatScore = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  if (Number.isInteger(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e9))
    return value.toExponential(3);
  return value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
};

// Tiny or near-certain probabilities keep their side of 0 and 1 instead of rounding to them.
export const formatProbability = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  if (value > 0 && value < 0.0005) return "<0.1%";
  if (value < 1 && value > 0.9995) return ">99.9%";
  return `${(value * 100).toFixed(1)}%`;
};

export const formatMetricMap = (
  metrics: Readonly<Record<string, number>>,
  limit = 8
): string => {
  return (
    Object.entries(metrics)
      .slice(0, limit)
      .map(([key, value]) => `${key}=${formatScore(value)}`)
      .join(", ") || DASH
  );
};

export const formatParamValue = (
  value: number | boolean | string | null | undefined
): string => {
  if (value === undefined) return DASH;
  if (value === null) return "null";
  if (typeof value === "number") return formatScore(value);
  return String(value);
};

export const formatBinRange = (
  bin: Readonly<{ low: number; high: number }>
): string => {
  return bin.low === bin.high
    ? formatScore(bin.low)
    : `${formatScore(bin.low)} – ${formatScore(bin.high)}`;
};

export const formatMarkets = (
  markets: readonly string[],
  shown = 3
): string => {
  return markets.length <= shown
    ? markets.join(", ")
    : `${markets.slice(0, shown).join(", ")} +${markets.length - shown}`;
};

export const paramsJson = (
  params: Readonly<Record<string, unknown>>
): string => {
  return JSON.stringify(params, null, 2);
};

export const TRIAL_ROWS_SHOWN = 500;
export const TRIAL_ORDERS = ["best", "worst", "index"] as const;
export type TrialOrder = (typeof TRIAL_ORDERS)[number];
export const TRIAL_STATUS_FILTERS = ["all", "ok", "failed"] as const;
export type TrialStatusFilter = (typeof TRIAL_STATUS_FILTERS)[number];

type SortableTrial = Readonly<{
  index: number;
  score: number | null;
  status: "ok" | "failed";
}>;

// "best" puts the best score first for the run's direction; missing scores always sort last.
export const sortTrials = <T extends SortableTrial>(
  trials: readonly T[],
  direction: "maximize" | "minimize",
  order: TrialOrder,
  status: TrialStatusFilter
): T[] => {
  const filtered = trials.filter(
    (trial) => status === "all" || trial.status === status
  );
  if (order === "index") return [...filtered].sort((a, b) => a.index - b.index);
  const sign = (order === "best") === (direction === "maximize") ? -1 : 1;
  return [...filtered].sort((a, b) => {
    if (a.score === null && b.score === null) return a.index - b.index;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return sign * (a.score - b.score) || a.index - b.index;
  });
};

const HEAT_CLASSES = [
  "bg-primary/5",
  "bg-primary/15",
  "bg-primary/30",
  "bg-primary/45",
  "bg-primary/60",
] as const;

// Shade a heatmap cell by rank within [min, max]; the better end for the run's direction is darker.
export const heatClass = (
  value: number | null,
  min: number,
  max: number,
  direction: "maximize" | "minimize"
): string => {
  if (value === null || !Number.isFinite(value)) return "";
  const span = max - min;
  const position = span <= 0 ? 1 : (value - min) / span;
  const goodness = direction === "maximize" ? position : 1 - position;
  return (
    HEAT_CLASSES[
      Math.min(
        HEAT_CLASSES.length - 1,
        Math.floor(goodness * HEAT_CLASSES.length)
      )
    ] ?? ""
  );
};

export const finiteRange = (
  values: readonly (number | null)[]
): Readonly<{ min: number; max: number }> | null => {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value)
  );
  if (finite.length === 0) return null;
  return { min: Math.min(...finite), max: Math.max(...finite) };
};
