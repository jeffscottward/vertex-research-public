import {
  applySweepParams,
  assessSweepRobustness,
  type BacktestRunSubmitInput,
  type BacktestSweepCell,
  type BacktestSweepInput,
  BacktestSweepInputSchema,
  type BacktestSweepMetric,
  type BacktestSweepOutput,
  type BacktestSweepParam,
  type BacktestSweepRequest,
  type InstantBacktestSeries,
  type SweepRobustness,
  sweepCoordinates,
  sweepIndex,
} from "@darkfactory/api";

import {
  formatPercent,
  formatRatio,
  type InstantParams,
  toRunInput,
} from "./instant-backtest-workspace.tsx";
import { finiteRange, heatClass } from "./optimizations-model.ts";

// Pure helpers for the parameter sweep page: request building, client-side re-ranking for the
// selected metric (same code as the server), the heatmap slice and the "run full backtest"
// request for one cell. Research only; no order path.

export type SweepDimensionForm = Readonly<{
  param: BacktestSweepParam;
  from: number;
  to: number;
  step: number;
}>;

export type SweepForm = Readonly<{
  params: InstantParams;
  from: string;
  to: string;
  dimensions: readonly SweepDimensionForm[];
  metric: BacktestSweepMetric;
}>;

export const SWEEP_PARAM_LABELS: Readonly<Record<BacktestSweepParam, string>> =
  {
    entryLookback: "Entry lookback",
    exitLookback: "Exit lookback",
    fast: "Fast average",
    slow: "Slow average",
    stopLossPct: "Stop-loss %",
    takeProfitPct: "Take-profit %",
    trendSma: "Trend average",
  };

export const SWEEP_METRIC_LABELS: Readonly<
  Record<BacktestSweepMetric, string>
> = {
  cagr: "CAGR",
  maxDrawdown: "Max drawdown",
  profitFactor: "Profit factor",
  sharpe: "Sharpe ratio",
  sortino: "Sortino ratio",
  totalReturn: "Total return",
  winRate: "Win rate",
};

const PERCENT_METRIC: Readonly<Record<BacktestSweepMetric, boolean>> = {
  cagr: true,
  maxDrawdown: true,
  profitFactor: false,
  sharpe: false,
  sortino: false,
  totalReturn: true,
  winRate: true,
};

export const formatSweepMetric = (
  metric: BacktestSweepMetric,
  value: number | null
): string =>
  PERCENT_METRIC[metric] ? formatPercent(value) : formatRatio(value);

/** Default grid for a rule: two dimensions, 6 x 9 or 6 x 6 cells. */
export const defaultDimensions = (
  kind: InstantParams["ruleKind"]
): SweepDimensionForm[] =>
  kind === "smaCross"
    ? [
        { from: 5, param: "fast", step: 5, to: 30 },
        { from: 40, param: "slow", step: 20, to: 200 },
      ]
    : [
        { from: 10, param: "entryLookback", step: 10, to: 60 },
        { from: 5, param: "exitLookback", step: 5, to: 30 },
      ];

/** Builds the sweep request (defaults applied), or returns the first reason it cannot run. */
export const toSweepInput = (
  form: SweepForm,
  series: InstantBacktestSeries
): Readonly<{ input: BacktestSweepRequest }> | Readonly<{ error: string }> => {
  const base = toRunInput(form.params, series);
  if ("error" in base) return base;
  const input: BacktestSweepInput = {
    ...base.input,
    dimensions: [...form.dimensions],
    from: form.from,
    metric: form.metric,
    to: form.to,
  };
  const parsed = BacktestSweepInputSchema.safeParse(input);
  if (parsed.success) return { input: parsed.data };
  const issue = parsed.error.issues[0] as Readonly<{
    path: readonly PropertyKey[];
    message: string;
  }>;
  const position = issue.path[0] === "dimensions" ? issue.path[1] : undefined;
  return {
    error: `${typeof position === "number" ? `Dimension ${position + 1}: ` : ""}${issue.message}.`,
  };
};

const shapeOf = (output: BacktestSweepOutput): number[] =>
  output.dimensions.map((dimension) => dimension.values.length);

/** Re-ranks a finished sweep for `metric` in the browser. */
export const robustnessFor = (
  output: BacktestSweepOutput,
  metric: BacktestSweepMetric
): SweepRobustness =>
  assessSweepRobustness(
    shapeOf(output),
    output.cells.map((cell) => cell.metrics[metric]),
    output.spikeRatio
  );

/** "fast 10, slow 120" for one cell. */
export const describeCell = (
  output: BacktestSweepOutput,
  index: number
): string =>
  output.dimensions
    .map(
      (dimension, position) =>
        `${dimension.param} ${(output.cells[index] as BacktestSweepCell).params[position]}`
    )
    .join(", ");

export type HeatmapAxes = Readonly<{
  /** Dimension shown as columns. */
  x: number;
  /** Dimension shown as rows; null for a one-dimension sweep. */
  y: number | null;
  /** Coordinate per dimension; used for the dimensions that are not on an axis. */
  fixed: readonly number[];
}>;

/** Columns = last dimension, rows = first, other dimensions fixed at the best-ranked cell. */
export const defaultAxes = (output: BacktestSweepOutput): HeatmapAxes => {
  const count = output.dimensions.length;
  const best = output.ranking[0];
  return {
    fixed:
      best === undefined
        ? output.dimensions.map(() => 0)
        : sweepCoordinates(best, shapeOf(output)),
    x: count - 1,
    y: count > 1 ? 0 : null,
  };
};

/** Moves a dimension to an axis; when the other axis holds it, the two axes swap. */
export const moveAxis = (
  axes: HeatmapAxes,
  axis: "x" | "y",
  dimension: number
): HeatmapAxes => {
  const other = axis === "x" ? axes.y : axes.x;
  const current = axis === "x" ? axes.x : axes.y;
  if (other === dimension)
    return axis === "x"
      ? { ...axes, x: dimension, y: current }
      : { ...axes, x: current as number, y: dimension };
  return { ...axes, [axis]: dimension };
};

export type HeatCell = Readonly<{
  index: number;
  value: number | null;
  heat: string;
  rank: number | null;
  spike: boolean;
  error: string | null;
}>;

export type HeatmapView = Readonly<{
  xValues: readonly number[];
  /** One entry per row; null for a one-dimension sweep. */
  yValues: readonly (number | null)[];
  rows: readonly (readonly HeatCell[])[];
}>;

/**
 * The 2-D slice through the grid for the chosen axes. `mode` "worst" colours each cell by the
 * lowest value in its neighbourhood instead of its own value. Stronger colour is better within
 * the slice.
 */
export const heatmapView = (
  output: BacktestSweepOutput,
  robustness: SweepRobustness,
  metric: BacktestSweepMetric,
  mode: "value" | "worst",
  axes: HeatmapAxes
): HeatmapView => {
  const shape = shapeOf(output);
  const valuesOf = (dimension: number): readonly number[] =>
    (output.dimensions[dimension] as BacktestSweepOutput["dimensions"][number])
      .values;
  const xValues = valuesOf(axes.x);
  const yValues: readonly (number | null)[] =
    axes.y === null ? [null] : valuesOf(axes.y);
  const indexes = yValues.map((_yValue, row) =>
    xValues.map((_xValue, column) => {
      const coordinates = [...axes.fixed];
      coordinates[axes.x] = column;
      if (axes.y !== null) coordinates[axes.y] = row;
      return sweepIndex(coordinates, shape);
    })
  );
  const shown = (index: number): number | null =>
    mode === "value"
      ? (output.cells[index] as BacktestSweepCell).metrics[metric]
      : (robustness.worst[index] as number | null);
  const range = finiteRange(indexes.flat().map(shown));
  return {
    rows: indexes.map((row) =>
      row.map((index) => {
        const value = shown(index);
        return {
          error: (output.cells[index] as BacktestSweepCell).error,
          heat:
            range === null
              ? ""
              : heatClass(value, range.min, range.max, "maximize"),
          index,
          rank: robustness.rank[index] as number | null,
          spike: robustness.spike[index] === true,
          value,
        };
      })
    ),
    xValues,
    yValues,
  };
};

/** The backtest run request for one cell: the sweep request with the cell's values applied. */
export const cellSubmitInput = (
  request: BacktestSweepRequest,
  output: BacktestSweepOutput,
  index: number
): BacktestRunSubmitInput => {
  const cell = output.cells[index] as BacktestSweepCell;
  const settings = applySweepParams(
    request,
    output.dimensions.map((dimension, position) => ({
      param: dimension.param,
      value: cell.params[position] as number,
    }))
  );
  return {
    costBps: request.costBps,
    from: request.from,
    rule: settings.rule,
    stopLossPct: settings.stopLossPct,
    symbol: request.symbol,
    takeProfitPct: settings.takeProfitPct,
    timeframe: request.timeframe,
    to: request.to,
  };
};
