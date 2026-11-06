import { BAR_SYMBOL_PATTERN } from "@darkfactory/shared/universes";
import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  BACKTEST_SWEEP_PARAMS,
  sweepParamApplies,
  sweepParamLimits,
  sweepValueCount,
} from "../backtest-sweep-grid.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import { EngineComparisonTimingSchema } from "./engine-comparison.ts";
import {
  INSTANT_BACKTEST_TIMEFRAMES,
  InstantBacktestBreakoutSchema,
  InstantBacktestSmaCrossSchema,
} from "./instant-backtest.ts";

// Parameter sweep: runs the instant backtest engine once for every point of a grid over 1 to 4
// numeric parameters, inside the request, and ranks each grid cell by the lowest metric value in
// its neighbourhood (the cell and the cells one step away in one parameter). A cell whose
// neighbours average less than half of its own positive value is an isolated spike. Nothing is
// stored. Operator-only; agent keys (read or write) may call it. Research only; no order path.

export const BACKTEST_SWEEP_METRICS = [
  "totalReturn",
  "cagr",
  "sharpe",
  "sortino",
  "profitFactor",
  "winRate",
  "maxDrawdown",
] as const;
export const BACKTEST_SWEEP_MAX_DIMENSIONS = 4;
export const BACKTEST_SWEEP_MAX_VALUES = 50;
export const BACKTEST_SWEEP_MAX_CELLS = 1000;
/** Upper limit of grid cells multiplied by bars in the date range, checked before any run. */
export const BACKTEST_SWEEP_MAX_BAR_STEPS = 20_000_000;
export const BACKTEST_SWEEP_SPIKE_RATIO = 0.5;

export const BacktestSweepDimensionSchema = z
  .object({
    from: z.number(),
    param: z.enum(BACKTEST_SWEEP_PARAMS),
    step: z.number().positive(),
    to: z.number(),
  })
  .strict();

export const BacktestSweepInputSchema = z
  .object({
    costBps: z.number().min(0).max(500).default(0),
    dimensions: z
      .array(BacktestSweepDimensionSchema)
      .min(1)
      .max(BACKTEST_SWEEP_MAX_DIMENSIONS),
    from: CalendarDateSchema,
    metric: z.enum(BACKTEST_SWEEP_METRICS).default("totalReturn"),
    rule: z.discriminatedUnion("kind", [
      InstantBacktestSmaCrossSchema,
      InstantBacktestBreakoutSchema,
    ]),
    stopLossPct: z.number().min(0).max(99).default(0),
    symbol: z.string().regex(BAR_SYMBOL_PATTERN),
    takeProfitPct: z.number().min(0).max(10_000).default(0),
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
    to: CalendarDateSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.from > input.to)
      context.addIssue({
        code: "custom",
        message: "from must not be after to",
        path: ["to"],
      });
    const seen = new Set<string>();
    let cells = 1;
    for (const [index, dimension] of input.dimensions.entries()) {
      const path = ["dimensions", index];
      const issue = (message: string, field: string) =>
        context.addIssue({ code: "custom", message, path: [...path, field] });
      if (!sweepParamApplies(dimension.param, input.rule.kind)) {
        issue(
          `${dimension.param} does not apply to the ${input.rule.kind} rule`,
          "param"
        );
        continue;
      }
      if (seen.has(dimension.param)) {
        issue(`${dimension.param} appears more than once`, "param");
        continue;
      }
      seen.add(dimension.param);
      const limits = sweepParamLimits(dimension.param);
      if (dimension.from > dimension.to) {
        issue("from must not be more than to", "to");
        continue;
      }
      if (
        limits.integer &&
        !(
          Number.isInteger(dimension.from) &&
          Number.isInteger(dimension.to) &&
          Number.isInteger(dimension.step)
        )
      ) {
        issue(`${dimension.param} needs whole numbers`, "step");
        continue;
      }
      if (dimension.from < limits.min || dimension.to > limits.max) {
        issue(
          `${dimension.param} must be from ${limits.min} to ${limits.max}`,
          "from"
        );
        continue;
      }
      const count = sweepValueCount(dimension);
      if (count > BACKTEST_SWEEP_MAX_VALUES) {
        issue(
          `A dimension may have at most ${BACKTEST_SWEEP_MAX_VALUES} values; this one has ${count}`,
          "step"
        );
        continue;
      }
      cells *= count;
    }
    if (cells > BACKTEST_SWEEP_MAX_CELLS)
      context.addIssue({
        code: "custom",
        message: `A sweep may have at most ${BACKTEST_SWEEP_MAX_CELLS} cells; this one has ${cells}`,
        path: ["dimensions"],
      });
  });

const nullableNumber = z.number().nullable();

export const BacktestSweepMetricsSchema = z.object({
  cagr: nullableNumber,
  maxDrawdown: nullableNumber,
  profitFactor: nullableNumber,
  sharpe: nullableNumber,
  sortino: nullableNumber,
  totalReturn: nullableNumber,
  winRate: nullableNumber,
});

export const BacktestSweepRobustnessSchema = z.object({
  /** Mean metric value of the neighbours that have a value; null when none has one. */
  neighbourMean: nullableNumber,
  /** Neighbours that have a value. */
  neighbours: z.number().int().nonnegative(),
  /** 1 is the best robust score; null when the cell has no value. */
  rank: z.number().int().positive().nullable(),
  spike: z.boolean(),
  /** Lowest value over the cell and its neighbours that have a value. */
  worst: nullableNumber,
});

export const BacktestSweepCellSchema = z.object({
  coordinates: z.array(z.number().int().nonnegative()),
  /** The engine's reason when it rejects the parameters (for example fast >= slow). */
  error: z.string().nullable(),
  metrics: BacktestSweepMetricsSchema,
  /** One value per dimension, in dimension order. */
  params: z.array(z.number()),
  robustness: BacktestSweepRobustnessSchema,
  trades: z.number().int().nonnegative().nullable(),
});

export const BacktestSweepOutputSchema = z.object({
  bars: z.number().int(),
  /** Row-major: the last dimension changes fastest. */
  cells: z.array(BacktestSweepCellSchema).max(BACKTEST_SWEEP_MAX_CELLS),
  /**
   * Engine comparison on: the TypeScript timing, the queued Nautilus group, the cells queued
   * (the first ENGINE_COMPARISON_SWEEP_CELLS_MAX cells without an engine error) and those left out.
   */
  comparison: EngineComparisonTimingSchema.extend({
    dropped: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
  }).optional(),
  computeMs: z.number().nonnegative(),
  dimensions: z.array(
    z.object({
      param: z.enum(BACKTEST_SWEEP_PARAMS),
      values: z.array(z.number()),
    })
  ),
  engineVersion: z.string(),
  firstT: z.number().int(),
  from: z.string(),
  lastT: z.number().int(),
  metric: z.enum(BACKTEST_SWEEP_METRICS),
  /** Cell indexes with a robust score, best first. */
  ranking: z.array(z.number().int().nonnegative()),
  seriesSha256: z.string(),
  spikeRatio: z.number(),
  symbol: z.string(),
  timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
  to: z.string(),
});

export const BACKTEST_SWEEP_ERRORS = {
  BAD_REQUEST: { message: "Invalid parameter sweep", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "No stored bars for this series", status: 404 },
  STORAGE_ERROR: { message: "Bar storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

export const backtestSweepProcedure = oc
  .errors(BACKTEST_SWEEP_ERRORS)
  .route({
    method: "POST",
    operationId: "backtestRuns.sweep",
    path: "/backtest-runs/sweep",
    summary:
      "Run a grid of backtests over stored bars and rank each cell by the worst value in its neighbourhood (research only, no orders)",
    tags: ["Backtest runs"],
  })
  .input(BacktestSweepInputSchema)
  .output(BacktestSweepOutputSchema);

export type BacktestSweepMetric = (typeof BACKTEST_SWEEP_METRICS)[number];
export type BacktestSweepInput = z.input<typeof BacktestSweepInputSchema>;
export type BacktestSweepRequest = z.infer<typeof BacktestSweepInputSchema>;
export type BacktestSweepOutput = z.infer<typeof BacktestSweepOutputSchema>;
export type BacktestSweepCell = z.infer<typeof BacktestSweepCellSchema>;
