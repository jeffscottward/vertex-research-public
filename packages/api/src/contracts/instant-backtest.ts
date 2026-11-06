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
    kind: z.literal("smaCross"),
    fast: window,
    slow: window,
  })
  .strict()
  .refine((rule) => rule.fast < rule.slow, {
    message: "fast must be shorter than slow",
    path: ["fast"],
  });

export const InstantBacktestBreakoutSchema = z
  .object({
    kind: z.literal("breakout"),
    entryLookback: window,
    exitLookback: window,
    trendSma: z.number().int().min(0).max(INSTANT_BACKTEST_WINDOW_MAX),
  })
  .strict();

export const InstantBacktestRunInputSchema = z
  .object({
    symbol: symbolSchema,
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
    rule: z.discriminatedUnion("kind", [
      InstantBacktestSmaCrossSchema,
      InstantBacktestBreakoutSchema,
    ]),
    stopLossPct: z.number().min(0).max(99),
    takeProfitPct: z.number().min(0).max(10_000),
    costBps: z.number().min(0).max(500),
  })
  .strict();

export const InstantBacktestSeriesSchema = z
  .object({
    symbol: symbolSchema,
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
    source: z.string().max(300),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    barCount: z.number().int().min(2),
    firstT: z.number().int(),
    lastT: z.number().int(),
    importedAt: z.string(),
  })
  .strict();

const nullableNumber = z.number().nullable();

export const InstantBacktestStatsSchema = z
  .object({
    bars: z.number().int().min(2),
    totalReturn: z.number(),
    cagr: nullableNumber,
    maxDrawdown: z.number().max(0),
    sharpe: nullableNumber,
    sortino: nullableNumber,
    trades: z.number().int().nonnegative(),
    winRate: nullableNumber,
    profitFactor: nullableNumber,
    exposure: z.number().min(0).max(1),
    buyHoldReturn: z.number(),
    buyHoldMaxDrawdown: z.number().max(0),
  })
  .strict();

export const InstantBacktestRunOutputSchema = z
  .object({
    series: InstantBacktestSeriesSchema,
    stats: InstantBacktestStatsSchema,
    equity: z
      .array(z.object({ t: z.number().int(), equity: z.number() }).strict())
      .min(2)
      .max(INSTANT_BACKTEST_EQUITY_MAX_POINTS),
    timing: z
      .object({
        cache: z.enum(["hit", "miss"]),
        loadMs: z.number().nonnegative(),
        computeMs: z.number().nonnegative(),
      })
      .strict(),
    /** Engine comparison on: the TypeScript engine timing and the queued Nautilus group. */
    comparison: EngineComparisonTimingSchema.optional(),
  })
  .strict();

export const InstantBacktestSeriesListOutputSchema = z
  .object({ series: z.array(InstantBacktestSeriesSchema).max(100) })
  .strict();

export const BacktestUniverseMemberSchema = z
  .object({
    symbol: symbolSchema,
    market: z.string().min(1).max(100),
    twin: symbolSchema,
    /** Timeframes with stored bars for this symbol; empty until the bars are imported. */
    storedTimeframes: z.array(z.enum(INSTANT_BACKTEST_TIMEFRAMES)).max(2),
  })
  .strict();

export const BacktestUniverseSchema = z
  .object({
    id: z.enum(BACKTEST_UNIVERSE_IDS),
    label: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
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
  BAD_REQUEST: { status: 400, message: "Invalid backtest parameters" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "No stored bars for this series" },
  STORAGE_ERROR: { status: 503, message: "Bar storage unavailable" },
} as const;

const instantBacktest = oc.errors(INSTANT_BACKTEST_ERRORS);

const series = instantBacktest
  .route({
    method: "GET",
    path: "/instant-backtest/series",
    operationId: "instantBacktest.series",
    summary: "List stored bar series available to the instant backtest",
    tags: ["Instant backtest"],
  })
  .output(InstantBacktestSeriesListOutputSchema);

const run = instantBacktest
  .route({
    method: "POST",
    path: "/instant-backtest/run",
    operationId: "instantBacktest.run",
    summary:
      "Run a parameterized long-only rule over stored bars (research only, no orders)",
    tags: ["Instant backtest"],
  })
  .input(InstantBacktestRunInputSchema)
  .output(InstantBacktestRunOutputSchema);

const universes = instantBacktest
  .route({
    method: "GET",
    path: "/instant-backtest/universes",
    operationId: "instantBacktest.universes",
    summary:
      "List named backtest universes, the default (Core 7 futures) and which members have stored bars",
    tags: ["Instant backtest"],
  })
  .output(InstantBacktestUniversesOutputSchema);

export const instantBacktestContract = { series, run, universes };

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
