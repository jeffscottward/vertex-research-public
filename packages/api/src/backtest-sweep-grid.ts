// Pure parameter sweep grid helpers: value ranges, row-major cell coordinates, neighbours and the
// neighbourhood robustness ranking. No engine and no I/O, so the browser can re-rank a finished
// sweep for another metric with the same code the server uses.
//
// Definitions:
// - Neighbours of a cell are the cells one step away in exactly one swept parameter.
// - The robust score of a cell is the lowest metric value over the cell and its neighbours that
//   have a value. Cells without a value (the engine rejected the parameters) are not ranked and
//   do not count as neighbours. Cells with no valued neighbour rank after all others.
// - A cell is an isolated spike when its value is above 0, at least one neighbour has a value and
//   the mean of those neighbour values is below `spikeRatio` (default 0.5) times the cell value.
// - Every sweep metric is higher-is-better. Drawdown is negative, so a value closer to 0 is higher.

import { INSTANT_BACKTEST_WINDOW_MAX } from "./contracts/instant-backtest.ts";

export const BACKTEST_SWEEP_PARAMS = [
  "fast",
  "slow",
  "entryLookback",
  "exitLookback",
  "trendSma",
  "stopLossPct",
  "takeProfitPct",
] as const;

export type BacktestSweepParam = (typeof BACKTEST_SWEEP_PARAMS)[number];
type RuleKind = "smaCross" | "breakout";

type ParamLimits = Readonly<{ integer: boolean; min: number; max: number }>;

const WINDOW: ParamLimits = {
  integer: true,
  max: INSTANT_BACKTEST_WINDOW_MAX,
  min: 1,
};

const PARAM_LIMITS: Readonly<Record<BacktestSweepParam, ParamLimits>> = {
  entryLookback: WINDOW,
  exitLookback: WINDOW,
  fast: WINDOW,
  slow: WINDOW,
  stopLossPct: { integer: false, max: 99, min: 0 },
  takeProfitPct: { integer: false, max: 10_000, min: 0 },
  trendSma: { ...WINDOW, min: 0 },
};

const RULE_PARAMS: Readonly<Record<RuleKind, readonly BacktestSweepParam[]>> = {
  breakout: ["entryLookback", "exitLookback", "trendSma"],
  smaCross: ["fast", "slow"],
};

/** Whether `param` can be swept for a rule of `kind` (risk settings apply to every rule). */
export const sweepParamApplies = (
  param: BacktestSweepParam,
  kind: RuleKind
): boolean =>
  param === "stopLossPct" ||
  param === "takeProfitPct" ||
  RULE_PARAMS[kind].includes(param);

export const sweepParamLimits = (param: BacktestSweepParam): ParamLimits =>
  PARAM_LIMITS[param];

type Range = Readonly<{ from: number; to: number; step: number }>;

// Absorbs binary rounding in (to - from) / step, for example 0.3 / 0.1 = 2.9999999999999996.
const STEP_EPSILON = 1e-9;
const VALUE_DECIMALS = 9;

/** Number of values from `from` to `to` (inclusive when on a step) in steps of `step`. */
export const sweepValueCount = (range: Range): number =>
  Math.floor((range.to - range.from) / range.step + STEP_EPSILON) + 1;

/** The values of one dimension, rounded to 9 decimals so 0.1 steps stay exact. */
export const sweepDimensionValues = (range: Range): number[] =>
  Array.from({ length: sweepValueCount(range) }, (_, index) =>
    Number((range.from + index * range.step).toFixed(VALUE_DECIMALS))
  );

/** Coordinates of cell `index` in a row-major grid (the last dimension changes fastest). */
export const sweepCoordinates = (
  index: number,
  shape: readonly number[]
): number[] => {
  const coordinates = new Array<number>(shape.length);
  let rest = index;
  for (let dimension = shape.length - 1; dimension >= 0; dimension -= 1) {
    const size = shape[dimension] as number;
    coordinates[dimension] = rest % size;
    rest = Math.floor(rest / size);
  }
  return coordinates;
};

/** Cell index of `coordinates` in a row-major grid. */
export const sweepIndex = (
  coordinates: readonly number[],
  shape: readonly number[]
): number =>
  shape.reduce(
    (index, size, dimension) =>
      index * size + (coordinates[dimension] as number),
    0
  );

/** Indexes of the cells one step away from `index` in exactly one dimension, ascending. */
export const sweepNeighbours = (
  index: number,
  shape: readonly number[]
): number[] => {
  const coordinates = sweepCoordinates(index, shape);
  const neighbours: number[] = [];
  let stride = 1;
  for (let dimension = shape.length - 1; dimension >= 0; dimension -= 1) {
    const position = coordinates[dimension] as number;
    if (position > 0) neighbours.push(index - stride);
    if (position < (shape[dimension] as number) - 1)
      neighbours.push(index + stride);
    stride *= shape[dimension] as number;
  }
  return neighbours.sort((left, right) => left - right);
};

export type SweepRobustness = Readonly<{
  /** Lowest value over the cell and its neighbours with a value; null when the cell has none. */
  worst: readonly (number | null)[];
  /** Mean of the neighbours with a value; null when none has one. */
  neighbourMean: readonly (number | null)[];
  /** Number of neighbours with a value. */
  neighbours: readonly number[];
  spike: readonly boolean[];
  /** 1-based rank by robust score; null for cells without a value. */
  rank: readonly (number | null)[];
  /** Ranked cell indexes, best first. */
  ranking: readonly number[];
}>;

/**
 * Scores every cell of a sweep by its neighbourhood. Ranking: cells with at least one valued
 * neighbour first, then higher robust score, then higher own value, then lower cell index, so
 * equal inputs always give the same order.
 */
export const assessSweepRobustness = (
  shape: readonly number[],
  values: readonly (number | null)[],
  spikeRatio = 0.5
): SweepRobustness => {
  const size = shape.reduce((product, length) => product * length, 1);
  if (values.length !== size)
    throw new RangeError(
      `Expected ${size} sweep values for the grid, received ${values.length}`
    );
  const own = values.map((value) =>
    value !== null && Number.isFinite(value) ? value : null
  );
  const worst: (number | null)[] = [];
  const neighbourMean: (number | null)[] = [];
  const neighbours: number[] = [];
  const spike: boolean[] = [];
  for (let index = 0; index < size; index += 1) {
    const value = own[index] as number | null;
    const valued = sweepNeighbours(index, shape)
      .map((neighbour) => own[neighbour] as number | null)
      .filter((entry): entry is number => entry !== null);
    const mean =
      valued.length === 0
        ? null
        : valued.reduce((sum, entry) => sum + entry, 0) / valued.length;
    neighbours.push(valued.length);
    neighbourMean.push(mean);
    worst.push(value === null ? null : Math.min(value, ...valued));
    spike.push(
      value !== null && value > 0 && mean !== null && mean < spikeRatio * value
    );
  }
  // A cell without any valued neighbour has no evidence of stability, so it ranks after every
  // cell that has one, whatever its own value.
  const ranking = own
    .map((value, index) => ({
      index,
      unsupported: neighbours[index] === 0 ? 1 : 0,
      value,
      worst: worst[index],
    }))
    .filter(
      (
        entry
      ): entry is {
        index: number;
        unsupported: number;
        value: number;
        worst: number;
      } => entry.value !== null
    )
    .sort(
      (left, right) =>
        left.unsupported - right.unsupported ||
        right.worst - left.worst ||
        right.value - left.value ||
        left.index - right.index
    )
    .map((entry) => entry.index);
  const rank: (number | null)[] = new Array<number | null>(size).fill(null);
  for (const [position, index] of ranking.entries()) rank[index] = position + 1;
  return { neighbourMean, neighbours, rank, ranking, spike, worst };
};

type SweepRule =
  | Readonly<{ kind: "smaCross"; fast: number; slow: number }>
  | Readonly<{
      kind: "breakout";
      entryLookback: number;
      exitLookback: number;
      trendSma: number;
    }>;

export type SweepBase = Readonly<{
  rule: SweepRule;
  stopLossPct: number;
  takeProfitPct: number;
}>;

/**
 * Applies one cell's parameter values to the base rule and risk settings. The sweep and the
 * "run full backtest" request both use it, so a full run tests exactly the cell's settings.
 */
export const applySweepParams = (
  base: SweepBase,
  params: readonly Readonly<{ param: BacktestSweepParam; value: number }>[]
): SweepBase => {
  const rule: Record<string, unknown> = { ...base.rule };
  let { stopLossPct, takeProfitPct } = base;
  for (const { param, value } of params) {
    if (param === "stopLossPct") stopLossPct = value;
    else if (param === "takeProfitPct") takeProfitPct = value;
    else rule[param] = value;
  }
  return { rule: rule as SweepRule, stopLossPct, takeProfitPct };
};
