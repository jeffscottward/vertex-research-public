// Parameter sweep runner: one instant backtest per grid cell over the same bars, then the
// neighbourhood robustness ranking for the requested metric. Pure and deterministic; the caller
// loads the bars and checks the size budget. Research only; it never creates orders.

import {
  applySweepParams,
  assessSweepRobustness,
  sweepCoordinates,
  sweepDimensionValues,
} from "./backtest-sweep-grid.ts";
import {
  BACKTEST_SWEEP_SPIKE_RATIO,
  type BacktestSweepCell,
  type BacktestSweepOutput,
  type BacktestSweepRequest,
} from "./contracts/backtest-sweep.ts";
import { measureWall, type WallTime } from "./engine-comparison.ts";
import {
  type BarColumns,
  InstantBacktestInputError,
  type InstantRunParams,
  type InstantRunResult,
  runInstantBacktest,
} from "./instant-backtest-engine.ts";

const NO_METRICS: BacktestSweepCell["metrics"] = {
  cagr: null,
  maxDrawdown: null,
  profitFactor: null,
  sharpe: null,
  sortino: null,
  totalReturn: null,
  winRate: null,
};

export type BacktestSweepGrid = Pick<
  BacktestSweepOutput,
  "cells" | "dimensions" | "ranking"
>;

/** One evaluated cell for an observer (engine comparison): its settings, result and wall time. */
export type SweepCellRun = Readonly<{
  index: number;
  params: readonly number[];
  settings: InstantRunParams;
  result: InstantRunResult;
  wall: WallTime;
}>;

export type SweepObserver = Readonly<{
  clock: () => number;
  onCell: (cell: SweepCellRun) => void;
}>;

export const runBacktestSweep = (
  bars: BarColumns,
  request: Pick<
    BacktestSweepRequest,
    | "costBps"
    | "dimensions"
    | "metric"
    | "rule"
    | "stopLossPct"
    | "takeProfitPct"
  >,
  observer?: SweepObserver
): BacktestSweepGrid => {
  const dimensions = request.dimensions.map((dimension) => ({
    param: dimension.param,
    values: sweepDimensionValues(dimension),
  }));
  const shape = dimensions.map((dimension) => dimension.values.length);
  const size = shape.reduce((product, length) => product * length, 1);
  const evaluated = Array.from({ length: size }, (_, index) => {
    const coordinates = sweepCoordinates(index, shape);
    const params = coordinates.map(
      (position, dimension) => dimensions[dimension]?.values[position] as number
    );
    const settings = applySweepParams(
      request,
      dimensions.map((dimension, position) => ({
        param: dimension.param,
        value: params[position] as number,
      }))
    );
    try {
      const run: InstantRunParams = { ...settings, costBps: request.costBps };
      let stats: InstantRunResult["stats"];
      if (observer === undefined) stats = runInstantBacktest(bars, run).stats;
      else {
        const measured = measureWall(observer.clock, () =>
          runInstantBacktest(bars, run)
        );
        stats = measured.value.stats;
        observer.onCell({
          index,
          params,
          result: measured.value,
          settings: run,
          wall: measured,
        });
      }
      return {
        coordinates,
        error: null,
        metrics: {
          cagr: stats.cagr,
          maxDrawdown: stats.maxDrawdown,
          profitFactor: stats.profitFactor,
          sharpe: stats.sharpe,
          sortino: stats.sortino,
          totalReturn: stats.totalReturn,
          winRate: stats.winRate,
        },
        params,
        trades: stats.trades,
      };
    } catch (error) {
      if (!(error instanceof InstantBacktestInputError)) throw error;
      return {
        coordinates,
        error: error.message,
        metrics: NO_METRICS,
        params,
        trades: null,
      };
    }
  });
  const robustness = assessSweepRobustness(
    shape,
    evaluated.map((cell) => cell.metrics[request.metric]),
    BACKTEST_SWEEP_SPIKE_RATIO
  );
  const cells = evaluated.map((cell, index) => ({
    ...cell,
    robustness: {
      neighbourMean: robustness.neighbourMean[index] as number | null,
      neighbours: robustness.neighbours[index] as number,
      rank: robustness.rank[index] as number | null,
      spike: robustness.spike[index] as boolean,
      worst: robustness.worst[index] as number | null,
    },
  }));
  return { cells, dimensions, ranking: [...robustness.ranking] };
};
