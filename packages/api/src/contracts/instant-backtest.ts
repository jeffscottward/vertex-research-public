import {
  BACKTEST_UNIVERSE_IDS,
  BAR_SYMBOL_PATTERN,
} from "@darkfactory/shared/universes";
import { oc } from "@orpc/contract";
import { z } from "zod";

import { EngineComparisonTimingSchema } from "./engine-comparison.ts";

// Instant backtest: re-runs a parameterized rule over stored bars on each request and returns
// summary statistics plus a chart-sized equity curve. Research and paper use only; no order path.

export const INSTANT_BACKTEST_TIMEFRAMES = ["1d", "1m"] as const;
export const INSTANT_BACKTEST_EQUITY_MAX_POINTS = 2000;
export const INSTANT_BACKTEST_WINDOW_MAX = 5000;

const symbolSchema = z.string().regex(BAR_SYMBOL_PATTERN);
const window = z.number().int().min(1).max(INSTANT_BACKTEST_WINDOW_MAX);

export const InstantBacktestSmaCrossSchema = z
  .object({
    fast: window,
    kind: z.literal("smaCross"),
    slow: window,
  })
  .strict()
  .refine((rule) => rule.fast < rule.slow, {
    message: "fast must be shorter than slow",
    path: ["fast"],
  });

export const InstantBacktestBreakoutSchema = z
  .object({
    entryLookback: window,
    exitLookback: window,
    kind: z.literal("breakout"),
    trendSma: z.number().int().min(0).max(INSTANT_BACKTEST_WINDOW_MAX),
  })
  .strict();

export const InstantBacktestRunInputSchema = z
  .object({
    costBps: z.number().min(0).max(500),
    rule: z.discriminatedUnion("kind", [
      InstantBacktestSmaCrossSchema,
      InstantBacktestBreakoutSchema,
    ]),
    stopLossPct: z.number().min(0).max(99),
    symbol: symbolSchema,
    takeProfitPct: z.number().min(0).max(10_000),
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
  })
  .strict();

export const InstantBacktestSeriesSchema = z
  .object({
    barCount: z.number().int().min(2),
    firstT: z.number().int(),
    importedAt: z.string(),
    lastT: z.number().int(),
    source: z.string().max(300),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    symbol: symbolSchema,
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
  })
  .strict();

const nullableNumber = z.number().nullable();

export const InstantBacktestStatsSchema = z
  .object({
    bars: z.number().int().min(2),
    buyHoldMaxDrawdown: z.number().max(0),
    buyHoldReturn: z.number(),
    cagr: nullableNumber,
    exposure: z.number().min(0).max(1),
    maxDrawdown: z.number().max(0),
    profitFactor: nullableNumber,
    sharpe: nullableNumber,
    sortino: nullableNumber,
    totalReturn: z.number(),
    trades: z.number().int().nonnegative(),
    winRate: nullableNumber,
  })
  .strict();

export const InstantBacktestRunOutputSchema = z
  .object({
    /** Engine comparison on: the TypeScript engine timing and the queued Nautilus group. */
    comparison: EngineComparisonTimingSchema.optional(),
    equity: z
      .array(z.object({ equity: z.number(), t: z.number().int() }).strict())
      .min(2)
      .max(INSTANT_BACKTEST_EQUITY_MAX_POINTS),
    series: InstantBacktestSeriesSchema,
    stats: InstantBacktestStatsSchema,
    timing: z
      .object({
        cache: z.enum(["hit", "miss"]),
        computeMs: z.number().nonnegative(),
        loadMs: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const InstantBacktestSeriesListOutputSchema = z
  .object({ series: z.array(InstantBacktestSeriesSchema).max(100) })
  .strict();

export const BacktestUniverseMemberSchema = z
  .object({
    market: z.string().min(1).max(100),
    /** Timeframes with stored bars for this symbol; empty until the bars are imported. */
    storedTimeframes: z.array(z.enum(INSTANT_BACKTEST_TIMEFRAMES)).max(2),
    symbol: symbolSchema,
    twin: symbolSchema,
  })
  .strict();

export const BacktestUniverseSchema = z
  .object({
    description: z.string().min(1).max(500),
    id: z.enum(BACKTEST_UNIVERSE_IDS),
    label: z.string().min(1).max(100),
    members: z.array(BacktestUniverseMemberSchema).min(1).max(50),
  })
  .strict();

export const InstantBacktestUniversesOutputSchema = z
  .object({
    /** Preselected in every backtest, sweep and Autopilot form. */
    defaultUniverseId: z.enum(BACKTEST_UNIVERSE_IDS),
    universes: z.array(BacktestUniverseSchema).min(1).max(20),
  })
  .strict();

export const INSTANT_BACKTEST_ERRORS = {
  BAD_REQUEST: { message: "Invalid backtest parameters", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "No stored bars for this series", status: 404 },
  STORAGE_ERROR: {
    message: "Bar storage request failed. Nothing was changed. Try again.",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const instantBacktest = oc.errors(INSTANT_BACKTEST_ERRORS);

const series = instantBacktest
  .route({
    method: "GET",
    operationId: "instantBacktest.series",
    path: "/instant-backtest/series",
    summary: "List stored bar series available to the instant backtest",
    tags: ["Instant backtest"],
  })
  .output(InstantBacktestSeriesListOutputSchema);

const run = instantBacktest
  .route({
    method: "POST",
    operationId: "instantBacktest.run",
    path: "/instant-backtest/run",
    summary:
      "Run a parameterized long-only rule over stored bars (research only, no orders)",
    tags: ["Instant backtest"],
  })
  .input(InstantBacktestRunInputSchema)
  .output(InstantBacktestRunOutputSchema);

const universes = instantBacktest
  .route({
    method: "GET",
    operationId: "instantBacktest.universes",
    path: "/instant-backtest/universes",
    summary:
      "List named backtest universes, the default (Core 7 futures) and which members have stored bars",
    tags: ["Instant backtest"],
  })
  .output(InstantBacktestUniversesOutputSchema);

export const instantBacktestContract = { run, series, universes };

export type InstantBacktestRunInput = z.input<
  typeof InstantBacktestRunInputSchema
>;
export type InstantBacktestRunOutput = z.infer<
  typeof InstantBacktestRunOutputSchema
>;
export type InstantBacktestSeries = z.infer<typeof InstantBacktestSeriesSchema>;
export type InstantBacktestUniversesOutput = z.infer<
  typeof InstantBacktestUniversesOutputSchema
>;
export type InstantBacktestSeriesListOutput = z.infer<
  typeof InstantBacktestSeriesListOutputSchema
>;
