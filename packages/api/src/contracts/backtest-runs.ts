import { oc } from "@orpc/contract";
import { z } from "zod";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import {
  BacktestRunCostsSchema,
  CostProfileInputSchema,
  CostProfileSchema,
} from "./backtest-cost-profiles.ts";
import { backtestSweepProcedure } from "./backtest-sweep.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import { forwardDriftContract } from "./forward-drift.ts";
import { strategyDefinitionsContract } from "./strategy-definitions.ts";
import {
  INSTANT_BACKTEST_TIMEFRAMES,
  InstantBacktestBreakoutSchema,
  InstantBacktestSmaCrossSchema,
} from "./instant-backtest.ts";

// Backtest runs: a queued job that runs the instant backtest engine over a date range of stored
// bars and stores an account-currency report tied to an immutable strategy revision (a SHA-256 of
// the strategy snapshot taken at submit time). `sweep` runs a parameter grid in the request and
// stores nothing (see ./backtest-sweep.ts). Operator-only; agent keys may call it (read keys
// only list, get and sweep). Research only; there is no order or broker path.

export const BACKTEST_RUN_ENGINE_VERSION = "instant-2";
export const BACKTEST_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export const BACKTEST_RUN_LIST_MAX = 100;
export const BACKTEST_RUN_DEFAULT_CAPITAL = 10_000;

export const BacktestRunSubmitInputSchema = z
  .object({
    costBps: z.number().min(0).max(500).default(0),
    /** Preset id or custom profile; the server stores the resolved profile in the spec. */
    costProfile: CostProfileInputSchema.optional(),
    from: CalendarDateSchema,
    initialCapital: z
      .number()
      .min(1)
      .max(1_000_000_000)
      .default(BACKTEST_RUN_DEFAULT_CAPITAL),
    rule: z.discriminatedUnion("kind", [
      InstantBacktestSmaCrossSchema,
      InstantBacktestBreakoutSchema,
      z
        .object({
          definition: StrategyDefinitionSchema,
          kind: z.literal("dsl"),
        })
        .strict(),
    ]),
    stopLossPct: z.number().min(0).max(99).default(0),
    strategyId: z.string().trim().min(1).max(128).nullable().optional(),
    symbol: z.string().regex(/^[A-Z0-9.^-]{1,20}$/u),
    takeProfitPct: z.number().min(0).max(10_000).default(0),
    timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
    to: CalendarDateSchema,
  })
  .strict()
  .refine((input) => input.from <= input.to, {
    message: "from must not be after to",
    path: ["to"],
  });

export const BacktestRunGetInputSchema = z
  .object({ id: z.string().trim().min(1).max(128) })
  .strict();

export const BacktestRunListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(BACKTEST_RUN_LIST_MAX).default(50),
    strategyId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const nullableNumber = z.number().nullable();

export const BacktestRunMetricsSchema = z.object({
  absoluteDrawdown: z.number(),
  averageLossTrade: nullableNumber,
  averageProfitTrade: nullableNumber,
  buyHoldReturn: z.number(),
  cagr: nullableNumber,
  expectedPayoff: nullableNumber,
  exposure: z.number(),
  finalEquity: z.number(),
  grossLoss: z.number(),
  grossProfit: z.number(),
  initialDeposit: z.number(),
  largestLossTrade: nullableNumber,
  largestProfitTrade: nullableNumber,
  lossTrades: z.number().int(),
  maxConsecutiveLosses: z.number().int(),
  maxConsecutiveLossesMoney: z.number(),
  maxConsecutiveWins: z.number().int(),
  maxDrawdownAbs: z.number(),
  maxDrawdownPct: z.number(),
  maximalConsecutiveLoss: z.number(),
  maximalConsecutiveLossCount: z.number().int(),
  netProfit: z.number(),
  profitFactor: nullableNumber,
  profitTrades: z.number().int(),
  recoveryFactor: nullableNumber,
  sharpe: nullableNumber,
  sortino: nullableNumber,
  totalReturn: z.number(),
  totalTrades: z.number().int(),
  winRate: nullableNumber,
});

export const BacktestRunReportSchema = z.object({
  bars: z.number().int(),
  /** Present when the run had a cost profile: charges in money and the profit before them. */
  costs: BacktestRunCostsSchema.optional(),
  equity: z.array(
    z.object({ drawdownPct: z.number(), equity: z.number(), t: z.number() })
  ),
  firstT: z.number().int(),
  lastT: z.number().int(),
  metrics: BacktestRunMetricsSchema,
  prices: z.array(
    z.object({
      c: z.number(),
      h: z.number(),
      l: z.number(),
      o: z.number(),
      t: z.number(),
    })
  ),
  seriesSha256: z.string(),
  trades: z.array(
    z.object({
      balanceAfter: z.number(),
      costs: z.number().optional(),
      entryPrice: z.number(),
      entryT: z.number(),
      exitPrice: z.number(),
      exitReason: z.enum(["signal", "stop", "target", "end"]),
      exitT: z.number(),
      grossPnl: z.number().optional(),
      n: z.number().int(),
      netReturn: z.number(),
      pnl: z.number(),
      units: z.number(),
    })
  ),
  tradesTruncated: z.boolean(),
});

export const BacktestRunSpecSchema = z.object({
  costBps: z.number(),
  costProfile: CostProfileSchema.optional(),
  from: z.string(),
  initialCapital: z.number(),
  rule: z.discriminatedUnion("kind", [
    z.object({
      fast: z.number(),
      kind: z.literal("smaCross"),
      slow: z.number(),
    }),
    z.object({
      entryLookback: z.number(),
      exitLookback: z.number(),
      kind: z.literal("breakout"),
      trendSma: z.number(),
    }),
    z.object({ definition: StrategyDefinitionSchema, kind: z.literal("dsl") }),
  ]),
  stopLossPct: z.number(),
  symbol: z.string(),
  takeProfitPct: z.number(),
  timeframe: z.enum(INSTANT_BACKTEST_TIMEFRAMES),
  to: z.string(),
});

export const BacktestRunStrategySnapshotSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  params: z.array(z.unknown()),
  slug: z.string(),
  sourceRef: z.string().nullable(),
  updatedAt: z.string(),
});

export const BacktestRunSummarySchema = z.object({
  createdAt: z.date(),
  engineVersion: z.string(),
  error: z.string().nullable(),
  finishedAt: z.date().nullable(),
  id: z.string(),
  spec: BacktestRunSpecSchema,
  startedAt: z.date().nullable(),
  status: z.enum(BACKTEST_RUN_STATUS_VALUES),
  strategyId: z.string().nullable(),
  strategyRevision: z.string().nullable(),
  strategySnapshot: BacktestRunStrategySnapshotSchema.nullable(),
});

export const BacktestRunSchema = BacktestRunSummarySchema.extend({
  report: BacktestRunReportSchema.nullable(),
});

export const BacktestRunListOutputSchema = z.object({
  runs: z.array(BacktestRunSummarySchema).max(BACKTEST_RUN_LIST_MAX),
});

export const BACKTEST_RUN_ERRORS = {
  BAD_REQUEST: { message: "Invalid backtest run", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Backtest run or strategy not found", status: 404 },
  STORAGE_ERROR: { message: "Backtest storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const backtestRuns = oc.errors(BACKTEST_RUN_ERRORS);

const submit = backtestRuns
  .route({
    method: "POST",
    operationId: "backtestRuns.submit",
    path: "/backtest-runs",
    summary:
      "Queue a backtest of a rule over a date range of stored bars (research only, no orders)",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunSubmitInputSchema)
  .output(BacktestRunSchema);

const get = backtestRuns
  .route({
    method: "GET",
    operationId: "backtestRuns.get",
    path: "/backtest-runs/{id}",
    summary: "Read one backtest run with its report when it has finished",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunGetInputSchema)
  .output(BacktestRunSchema);

const list = backtestRuns
  .route({
    method: "GET",
    operationId: "backtestRuns.list",
    path: "/backtest-runs",
    summary: "List backtest runs, newest first, without reports",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunListInputSchema)
  .output(BacktestRunListOutputSchema);

export const BACKTEST_COMBO_SLOTS_MAX = 10;

export const BacktestComboInputSchema = z
  .object({
    deposit: z.number().min(1).max(1_000_000_000),
    slots: z
      .array(
        z
          .object({
            // Pins the slot to the run's strategy revision; a mismatch is rejected.
            expectedRevision: z
              .string()
              .regex(/^[0-9a-f]{64}$/u)
              .nullable()
              .optional(),
            runId: z.string().trim().min(1).max(128),
            weight: z.number().min(0).max(1),
          })
          .strict()
      )
      .min(1)
      .max(BACKTEST_COMBO_SLOTS_MAX)
      .refine(
        (slots) =>
          new Set(slots.map((slot) => slot.runId)).size === slots.length,
        { message: "Each run may appear once" }
      )
      .refine(
        (slots) =>
          slots.reduce((sum, slot) => sum + slot.weight, 0) <= 1 + 1e-9,
        { message: "Weights must not add up to more than 1" }
      ),
  })
  .strict();

const ComboStatsSchema = z.object({
  cagr: nullableNumber,
  maxDrawdownPct: z.number(),
  sharpe: nullableNumber,
  totalReturn: z.number(),
});

export const BacktestComboSchema = z.object({
  cash: z.number(),
  correlation: z.array(z.array(nullableNumber)),
  deposit: z.number(),
  diversification: z.object({
    combinedDrawdownPct: z.number(),
    diversified: z.boolean(),
    ratio: nullableNumber,
    weightedSlotDrawdownPct: z.number(),
  }),
  drawdownOverlap: z.array(z.array(z.number())),
  finalEquity: z.number(),
  jointDrawdownShare: z.number(),
  netProfit: z.number(),
  points: z.array(
    z.object({ drawdownPct: z.number(), equity: z.number(), t: z.number() })
  ),
  slots: z.array(
    z.object({
      allocation: z.number(),
      engineVersion: z.string(),
      full: ComboStatsSchema,
      label: z.string(),
      pnl: z.number(),
      recent: ComboStatsSchema,
      runId: z.string(),
      seriesSha256: z.string(),
      strategyRevision: z.string().nullable(),
      verdict: z.enum(["robust", "degrading", "insufficient"]),
      verdictReason: z.string(),
      weight: z.number(),
    })
  ),
  stats: ComboStatsSchema,
});

const combine = backtestRuns
  .route({
    method: "POST",
    operationId: "backtestRuns.combine",
    path: "/backtest-runs/combine",
    summary:
      "Combine finished backtest runs on one shared deposit with weights (research only, no orders)",
    tags: ["Backtest runs"],
  })
  .input(BacktestComboInputSchema)
  .output(BacktestComboSchema);

export const backtestRunsContract = {
  combine,
  definitions: strategyDefinitionsContract,
  drift: forwardDriftContract,
  get,
  list,
  submit,
  sweep: backtestSweepProcedure,
};

export type BacktestRunSubmitInput = z.input<
  typeof BacktestRunSubmitInputSchema
>;
export type BacktestComboInput = z.input<typeof BacktestComboInputSchema>;
export type BacktestCombo = z.infer<typeof BacktestComboSchema>;
export type BacktestRun = z.infer<typeof BacktestRunSchema>;
export type BacktestRunSummary = z.infer<typeof BacktestRunSummarySchema>;
export type BacktestRunReportOutput = z.infer<typeof BacktestRunReportSchema>;
