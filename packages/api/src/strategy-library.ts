// Strategy library read rules: latest-backtest return statistics and board sort order.
// Statistics come from returnStats over the latest linked backtest's reported equity, the same
// derivation the backtest detail view uses; reported metrics are never used for sorting.
import {
  returnStats,
  type AnalyticsEquityPoint,
} from "./backtest-analytics.ts";
import type {
  StrategyLatestBacktestOutput,
  StrategySortValue,
} from "./contracts/strategy-library.ts";

export type LatestBacktestInput = Readonly<{
  id: string;
  createdAt: Date;
  maxDrawdown: number | null;
  equity: readonly AnalyticsEquityPoint[];
}>;

export const latestBacktestStats = (
  row: LatestBacktestInput
): StrategyLatestBacktestOutput => {
  const stats = returnStats(row.equity);
  return {
    id: row.id,
    createdAt: row.createdAt,
    sharpe: stats?.sharpe ?? null,
    totalReturn: stats?.totalReturn ?? null,
    cagr: stats?.cagr ?? null,
    maxDrawdown: stats?.maxDrawdown ?? row.maxDrawdown ?? null,
  };
};

type Sortable = Readonly<{
  id: string;
  name: string;
  updatedAt: Date;
  latestBacktest: StrategyLatestBacktestOutput | null;
}>;

const byName = (left: Sortable, right: Sortable): number => {
  return (
    left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
};

const byUpdated = (left: Sortable, right: Sortable): number => {
  return (
    right.updatedAt.getTime() - left.updatedAt.getTime() ||
    right.id.localeCompare(left.id)
  );
};

// Descending by value; strategies without a value (no linked backtest or too few points) go last.
const byMetric =
  (pick: (latest: StrategyLatestBacktestOutput) => number | null) =>
  (left: Sortable, right: Sortable): number => {
    const a = left.latestBacktest === null ? null : pick(left.latestBacktest);
    const b = right.latestBacktest === null ? null : pick(right.latestBacktest);
    if (a === null && b === null) return byName(left, right);
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a || byName(left, right);
  };

export const sortStrategies = <T extends Sortable>(
  rows: readonly T[],
  sort: StrategySortValue = "updated"
): T[] => {
  const copy = [...rows];
  switch (sort) {
    case "name": {
      copy.sort(byName);
      break;
    }
    case "sharpe": {
      copy.sort(byMetric((latest) => latest.sharpe));
      break;
    }
    case "return": {
      copy.sort(byMetric((latest) => latest.totalReturn));
      break;
    }
    default: {
      copy.sort(byUpdated);
    }
  }
  return copy;
};
