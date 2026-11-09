import { oc } from "@orpc/contract";
import { z } from "zod";

// Workspace-scoped agent operations ledger and research paper library.
// Any authenticated session reads and writes; rows carry no owner. No orders, intents or execution linkage.

export const AGENT_TASK_KIND_VALUES = [
  "research",
  "paper",
  "strategy",
  "backtest",
  "forward_test",
  "optimization",
  "deployment",
  "data",
  "ops",
] as const;
export const AGENT_TASK_STATUS_VALUES = [
  "queued",
  "running",
  "needs_review",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const AGENT_TASK_EVENT_LEVEL_VALUES = ["info", "warn", "error"] as const;
export const RESEARCH_PAPER_KIND_VALUES = ["paper", "article"] as const;
export const RESEARCH_PAPER_STAGE_VALUES = [
  "queued",
  "ingested",
  "spec_extracted",
  "implemented",
  "backtested",
  "forward_tested",
  "verdict",
] as const;
export const RESEARCH_PAPER_VERDICT_VALUES = [
  "pending",
  "promising",
  "inconclusive",
  "rejected",
] as const;
export const AGENT_TASK_ATTENTION_STATUSES = [
  "needs_review",
  "blocked",
  "failed",
] as const;
export const AGENT_TASK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const AGENT_TASK_TITLE_MAX = 300;
export const AGENT_TASK_AGENT_MAX = 100;
export const AGENT_TASK_SUMMARY_MAX = 4000;
export const AGENT_EVENT_MESSAGE_MAX = 2000;
export const AGENT_METRICS_MAX_KEYS = 40;
export const AGENT_LINKS_MAX = 20;
export const AGENT_TASKS_LIST_MAX = 200;
export const RESEARCH_PAPER_TEXT_MAX = 4000;
const AGENT_METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const ID_MAX = 128;

export const AgentTaskKindSchema = z.enum(AGENT_TASK_KIND_VALUES);
export const AgentTaskStatusSchema = z.enum(AGENT_TASK_STATUS_VALUES);
export const AgentTaskEventLevelSchema = z.enum(AGENT_TASK_EVENT_LEVEL_VALUES);
export const ResearchPaperKindSchema = z.enum(RESEARCH_PAPER_KIND_VALUES);
export const ResearchPaperStageSchema = z.enum(RESEARCH_PAPER_STAGE_VALUES);
export const ResearchPaperVerdictSchema = z.enum(RESEARCH_PAPER_VERDICT_VALUES);

const IdSchema = z.string().trim().min(1).max(ID_MAX);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
// Blank strings clear the field (null); undefined leaves it unchanged.
const clearableText = (max: number) => {
  return z.union([z.string().max(max), z.null()]).transform((value) => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });
};

const httpUrl = (value: string): boolean => {
  if (/^\/(?!\/)/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

export const AgentMetricsSchema = z
  .record(
    z.string().regex(AGENT_METRIC_KEY_PATTERN),
    z.union([z.number().finite(), z.string().max(200)])
  )
  .refine((value) => Object.keys(value).length <= AGENT_METRICS_MAX_KEYS, {
    message: `At most ${AGENT_METRICS_MAX_KEYS} metrics`,
  });

export const AgentLinkSchema = z
  .object({
    label: requiredText(100),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine(httpUrl, { message: "Expected an http(s) URL or a portal path" }),
  })
  .strict();

export const AgentLinksSchema = z.array(AgentLinkSchema).max(AGENT_LINKS_MAX);

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  kind: AgentTaskKindSchema,
  agent: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  status: AgentTaskStatusSchema,
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  paperId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});

export const AgentTaskEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  at: z.date(),
  level: AgentTaskEventLevelSchema,
  message: z.string(),
});

export const AgentTaskEventWithTaskSchema = AgentTaskEventSchema.extend({
  taskTitle: z.string(),
  taskKind: AgentTaskKindSchema,
});

export const ResearchPaperSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  authors: z.string().nullable(),
  year: z.number().int().nullable(),
  sourceUrl: z.string().nullable(),
  identifier: z.string().nullable(),
  kind: ResearchPaperKindSchema,
  stage: ResearchPaperStageSchema,
  verdict: ResearchPaperVerdictSchema,
  blockers: z.string().nullable(),
  notes: z.string().nullable(),
  reportedMetrics: z.record(z.string(), z.union([z.number(), z.string()])),
  reproducedMetrics: z.record(z.string(), z.union([z.number(), z.string()])),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ---------------------------------------------------------------------------
// Backtest results: agents report, operators read. Values are agent-reported and unverified.
// drawdown is derived server-side from equity and is not an accepted input field.
export const BACKTEST_EQUITY_MAX_POINTS = 5000;
export const BACKTEST_TRADES_MAX = 2000;
export const BACKTEST_FOLDS_MAX = 100;
export const BACKTEST_LIST_MAX = 200;
const BACKTEST_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const BACKTEST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const backtestTimeMs = (value: string): number => {
  return Date.parse(
    BACKTEST_DATE_PATTERN.test(value) ? `${value}T00:00:00Z` : value
  );
};

const BacktestTimeSchema = z
  .string()
  .regex(BACKTEST_TIME_PATTERN, {
    message: "Expected YYYY-MM-DD or a zoned ISO datetime",
  })
  .refine((value) => Number.isFinite(backtestTimeMs(value)), {
    message: "Invalid time",
  });
const BacktestDateSchema = z
  .string()
  .regex(BACKTEST_DATE_PATTERN, { message: "Expected YYYY-MM-DD" })
  .refine((value) => Number.isFinite(backtestTimeMs(value)), {
    message: "Invalid date",
  });
const finiteNumber = z.number().finite();
const positiveNumber = z.number().finite().positive();
const nonDecreasingTimes = (times: readonly string[]): boolean => {
  return times.every((time, index) => {
    const previous = times[index - 1];
    return (
      previous === undefined || backtestTimeMs(time) > backtestTimeMs(previous)
    );
  });
};

export const BacktestEquityPointSchema = z
  .object({ t: BacktestTimeSchema, equity: positiveNumber })
  .strict();
export const BacktestDrawdownPointSchema = z.object({
  t: z.string(),
  drawdown: z.number(),
});
export const BacktestTradeSchema = z
  .object({
    entry_t: BacktestTimeSchema,
    exit_t: BacktestTimeSchema,
    side: z.enum(["long", "short"]),
    qty: positiveNumber,
    entry_px: positiveNumber,
    exit_px: positiveNumber,
    pnl: finiteNumber,
    sl: positiveNumber.optional(),
    tp: positiveNumber.optional(),
    commission: z.number().finite().nonnegative().optional(),
    regime: requiredText(40).optional(),
    symbol: requiredText(40).optional(),
  })
  .strict()
  .refine(
    (trade) => backtestTimeMs(trade.exit_t) >= backtestTimeMs(trade.entry_t),
    { message: "exit_t must not precede entry_t", path: ["exit_t"] }
  );
export const BACKTEST_FILL_MODEL_VALUES = ["bar", "tick", "l2"] as const;
const nonNegativeNumber = z.number().finite().nonnegative();
export const BacktestRunConfigSchema = z
  .object({
    initialCapital: positiveNumber.optional(),
    commissionPerContract: nonNegativeNumber.optional(),
    commissionPerTrade: nonNegativeNumber.optional(),
    commissionPercent: nonNegativeNumber.optional(),
    slippagePercent: nonNegativeNumber.optional(),
    timeframe: requiredText(16).optional(),
    fillModel: z.enum(BACKTEST_FILL_MODEL_VALUES).optional(),
    leverage: positiveNumber.optional(),
  })
  .strict();
export const BacktestBenchmarkSchema = z
  .object({
    label: requiredText(120),
    points: z
      .array(BacktestEquityPointSchema)
      .min(1)
      .max(BACKTEST_EQUITY_MAX_POINTS)
      .refine((points) => nonDecreasingTimes(points.map((point) => point.t)), {
        message: "benchmark timestamps must be strictly increasing",
      }),
  })
  .strict();

// Agent ratings: one research stance per decision date on the Glassbench five-tier scale. A rating is a
// research label only. It never authorizes, creates or sizes an order; nothing here reaches an order path.
// The server replays the ratings against stored daily bars on read (agent-rating-placebo.ts).
export const AGENT_RATING_VALUES = [
  "buy",
  "overweight",
  "hold",
  "underweight",
  "sell",
] as const;
export const AGENT_RATING_TIMEFRAMES = ["1d"] as const;
export const AGENT_RATING_DECISIONS_MIN = 2;
export const AGENT_RATING_DECISIONS_MAX = 520;
export const AGENT_RATING_COST_BPS_MAX = 500;
export const AgentRatingSchema = z.enum(AGENT_RATING_VALUES);
// Short run reference (for example a UUID); the pattern keeps 520 decisions inside the 64 KiB column check.
const AGENT_RATING_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
// rating null: the run failed or its rating could not be parsed. It keeps the position, is counted as
// failed and is never read as hold.
export const AgentRatingDecisionSchema = z
  .object({
    date: BacktestDateSchema,
    rating: AgentRatingSchema.nullable(),
    runId: z
      .string()
      .regex(AGENT_RATING_RUN_ID_PATTERN, {
        message: "runId must be 1-40 letters, digits, '.', '_', ':' or '-'",
      })
      .nullable()
      .optional(),
  })
  .strict();
// The replay uses stored daily bars only: 252 trading days per year and 50/200-day moving averages.
export const BacktestRatingSeriesSchema = z
  .object({
    costBps: z
      .number()
      .finite()
      .min(0)
      .max(AGENT_RATING_COST_BPS_MAX)
      .default(10),
    decisions: z
      .array(AgentRatingDecisionSchema)
      .min(AGENT_RATING_DECISIONS_MIN)
      .max(AGENT_RATING_DECISIONS_MAX)
      .refine(
        (decisions) => nonDecreasingTimes(decisions.map((row) => row.date)),
        { message: "decision dates must be strictly increasing" }
      ),
    symbol: requiredText(32),
    timeframe: z.enum(AGENT_RATING_TIMEFRAMES).default("1d"),
  })
  .strict();
// Named predicate: a multi-line inline && chain followed by the options argument compiles to a
// comma expression in Civet, which always returns the (truthy) options object.
const foldWindowsOrdered = (fold: {
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
}): boolean => {
  const trainStart = backtestTimeMs(fold.train_start);
  const trainEnd = backtestTimeMs(fold.train_end);
  const testStart = backtestTimeMs(fold.test_start);
  const testEnd = backtestTimeMs(fold.test_end);
  return trainStart < trainEnd && trainEnd <= testStart && testStart < testEnd;
};

export const BacktestFoldSchema = z
  .object({
    label: requiredText(64),
    train_start: BacktestTimeSchema,
    train_end: BacktestTimeSchema,
    test_start: BacktestTimeSchema,
    test_end: BacktestTimeSchema,
    metrics: AgentMetricsSchema.optional().default({}),
  })
  .strict()
  .refine(foldWindowsOrdered, {
    message: "Expected train_start < train_end <= test_start < test_end",
  });
const BacktestSplitWindowSchema = z
  .object({
    start: BacktestTimeSchema,
    end: BacktestTimeSchema,
    metrics: AgentMetricsSchema.optional().default({}),
  })
  .strict()
  .refine(
    (window) => backtestTimeMs(window.start) < backtestTimeMs(window.end),
    { message: "start must precede end" }
  );
export const BacktestIsSplitSchema = z
  .object({
    in_sample: BacktestSplitWindowSchema,
    out_of_sample: BacktestSplitWindowSchema,
  })
  .strict()
  .refine(
    (split) =>
      backtestTimeMs(split.out_of_sample.start) >=
      backtestTimeMs(split.in_sample.end),
    {
      message: "out_of_sample must start at or after in_sample ends",
    }
  );

const nonDecreasing = <T>(
  rows: readonly T[],
  time: (row: T) => string,
  strict: boolean
): boolean => {
  return rows.every((row, index) => {
    const previousRow = rows[index - 1];
    if (index === 0 || previousRow === undefined) return true;
    const previous = backtestTimeMs(time(previousRow));
    const current = backtestTimeMs(time(row));
    return strict ? current > previous : current >= previous;
  });
};

export const BacktestRecordInputSchema = z
  .object({
    taskId: IdSchema,
    paperId: IdSchema.nullable().optional(),
    strategyId: IdSchema.nullable().optional(),
    strategy: requiredText(200),
    instruments: requiredText(500),
    periodStart: BacktestDateSchema,
    periodEnd: BacktestDateSchema,
    dataSource: requiredText(300),
    isSplit: BacktestIsSplitSchema.nullable().optional(),
    metrics: AgentMetricsSchema.optional(),
    equity: z
      .array(BacktestEquityPointSchema)
      .max(BACKTEST_EQUITY_MAX_POINTS)
      .refine((points) => nonDecreasing(points, (point) => point.t, true), {
        message: "equity timestamps must be strictly increasing",
      })
      .optional(),
    trades: z
      .array(BacktestTradeSchema)
      .max(BACKTEST_TRADES_MAX)
      .refine(
        (trades) => nonDecreasing(trades, (trade) => trade.entry_t, false),
        { message: "trades must be ordered by entry_t" }
      )
      .optional(),
    folds: z
      .array(BacktestFoldSchema)
      .max(BACKTEST_FOLDS_MAX)
      .refine(
        (folds) => nonDecreasing(folds, (fold) => fold.test_start, false),
        { message: "folds must be ordered by test_start" }
      )
      .optional(),
    notes: clearableText(4000).optional(),
    runConfig: BacktestRunConfigSchema.nullable().optional(),
    benchmark: BacktestBenchmarkSchema.nullable().optional(),
    ratingSeries: BacktestRatingSeriesSchema.nullable().optional(),
  })
  .strict()
  .refine((input) => input.periodEnd >= input.periodStart, {
    message: "periodEnd must not precede periodStart",
    path: ["periodEnd"],
  });

const BacktestSummaryFields = {
  id: z.string().min(1),
  taskId: z.string().min(1),
  paperId: z.string().nullable(),
  strategyId: z.string().nullable(),
  strategy: z.string(),
  instruments: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  dataSource: z.string(),
  isSplit: z
    .object({
      in_sample: z.object({
        start: z.string(),
        end: z.string(),
        metrics: z.record(z.string(), z.union([z.number(), z.string()])),
      }),
      out_of_sample: z.object({
        start: z.string(),
        end: z.string(),
        metrics: z.record(z.string(), z.union([z.number(), z.string()])),
      }),
    })
    .nullable(),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  maxDrawdown: z.number().nullable(),
  tradeCount: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  createdAt: z.date(),
};

export const BacktestResultSummarySchema = z.object({
  ...BacktestSummaryFields,
  pointCount: z.number().int().nonnegative(),
  foldCount: z.number().int().nonnegative(),
  taskTitle: z.string().nullable(),
});

// Server-derived analytics (see backtest-analytics.ts). Deterministic for one stored result.
const nullableNumber = z.number().nullable();
const IntervalSchema = z
  .object({
    mean: z.number(),
    p2_5: z.number(),
    p50: z.number(),
    p97_5: z.number(),
  })
  .nullable();
const PercentilesFields = {
  p5: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p95: z.number(),
};
const MonteCarloRunSchema = z.object({
  finalPnl: z.object(PercentilesFields),
  maxDrawdown: z.object(PercentilesFields),
  probabilityOfProfit: z.number(),
  riskOfRuin: z.number(),
  worst: z.object({ finalPnl: z.number(), maxDrawdown: z.number() }),
  fan: z.array(z.object({ step: z.number().int(), ...PercentilesFields })),
});
const PnlBucketSchema = z.object({
  key: z.string(),
  trades: z.number().int(),
  netPnl: z.number(),
  winRate: z.number(),
});
const PeriodReturnSchema = z.object({
  year: z.number().int(),
  month: z.number().int().nullable(),
  return: z.number(),
});
const BootstrapTestSchema = z.object({
  estimate: z.number(),
  ciLower: z.number(),
  ciUpper: z.number(),
  pValue: z.number(),
});
export const BacktestAnalyticsSchema = z.object({
  method: z.object({
    version: z.string(),
    seed: z.number().int(),
    resamples: z.number().int(),
    monteCarloPaths: z.number().int(),
    ruinFraction: z.number(),
    initialCapital: nullableNumber,
    blockLength: z.number().int().nullable(),
  }),
  returns: z
    .object({
      periods: z.number().int(),
      periodsPerYear: z.number(),
      totalReturn: z.number(),
      cagr: z.number(),
      annualVolatility: z.number(),
      sharpe: nullableNumber,
      sortino: nullableNumber,
      calmar: nullableNumber,
      maxDrawdown: z.number(),
      skew: nullableNumber,
      excessKurtosis: nullableNumber,
      psr: nullableNumber,
    })
    .nullable(),
  trades: z
    .object({
      count: z.number().int(),
      wins: z.number().int(),
      losses: z.number().int(),
      breakeven: z.number().int(),
      winRate: z.number(),
      grossProfit: z.number(),
      grossLoss: z.number(),
      netPnl: z.number(),
      profitFactor: nullableNumber,
      expectancy: z.number(),
      avgWin: nullableNumber,
      avgLoss: nullableNumber,
      payoffRatio: nullableNumber,
      largestWin: nullableNumber,
      largestLoss: nullableNumber,
      maxConsecutiveWins: z.number().int(),
      maxConsecutiveLosses: z.number().int(),
      kelly: nullableNumber,
      longCount: z.number().int(),
      shortCount: z.number().int(),
      longNetPnl: z.number(),
      shortNetPnl: z.number(),
      avgHoldMinutes: z.number(),
      totalCommission: nullableNumber,
    })
    .nullable(),
  drawdowns: z
    .object({
      count: z.number().int(),
      longestUnderwaterMs: z.number(),
      avgRecoveryMs: nullableNumber,
      ongoing: z.boolean(),
      periods: z.array(
        z.object({
          peakT: z.string(),
          troughT: z.string(),
          recoveryT: z.string().nullable(),
          depth: z.number(),
          declineMs: z.number(),
          recoveryMs: nullableNumber,
          underwaterMs: z.number(),
        })
      ),
    })
    .nullable(),
  monthlyReturns: z.array(PeriodReturnSchema),
  yearlyReturns: z.array(PeriodReturnSchema),
  pnlBy: z.object({
    weekday: z.array(PnlBucketSchema),
    hour: z.array(PnlBucketSchema),
    month: z.array(PnlBucketSchema),
    year: z.array(PnlBucketSchema),
  }),
  distribution: z
    .object({
      bins: z.array(
        z.object({ from: z.number(), to: z.number(), count: z.number().int() })
      ),
      mean: z.number(),
      median: z.number(),
      stdev: z.number(),
    })
    .nullable(),
  regimes: z.array(
    z.object({
      regime: z.string(),
      trades: z.number().int(),
      winRate: z.number(),
      netPnl: z.number(),
      avgPnl: z.number(),
      profitFactor: nullableNumber,
    })
  ),
  bootstrap: z.object({
    sharpe: IntervalSchema,
    totalReturn: IntervalSchema,
    maxDrawdown: IntervalSchema,
    winRate: IntervalSchema,
    profitFactor: IntervalSchema,
    expectancy: IntervalSchema,
  }),
  monteCarlo: z
    .object({
      paths: z.number().int(),
      seed: z.number(),
      pnlSource: z.enum(["trades", "equity"]),
      reshuffle: MonteCarloRunSchema,
      bootstrap: MonteCarloRunSchema,
      worst: z.object({
        finalPnl: z.number(),
        maxDrawdown: z.number(),
        riskOfRuin: z.number(),
      }),
      sizing: z.object({
        basis: z.literal("worst_run"),
        drawdownBudget: z.number(),
        worstMaxDrawdown: z.number(),
        sizeScale: z.number(),
      }),
    })
    .nullable(),
  benchmark: z
    .object({
      n: z.number().int(),
      beta: z.number(),
      alphaAnnual: z.number(),
      correlation: z.number(),
      rSquared: z.number(),
      benchmarkReturn: z.number(),
    })
    .nullable(),
  multipleTesting: z
    .object({
      ledger: z.object({
        scope: z.enum(["strategy", "task"]),
        key: z.string(),
        trials: z.number().int(),
        usableTrials: z.number().int(),
        sampled: z.number().int(),
      }),
      deflatedSharpe: z
        .object({
          sharpe: z.number(),
          trials: z.number().int(),
          sharpeVariance: z.number(),
          observations: z.number().int(),
          expectedMaxSharpe: z.number(),
          z: z.number(),
          probability: z.number(),
        })
        .nullable(),
      deflatedSharpeReason: z.string().nullable(),
      benjaminiHochberg: z
        .object({
          alpha: z.number(),
          tested: z.number().int(),
          discoveries: z.number().int(),
          qValue: z.number(),
        })
        .nullable(),
      benjaminiHochbergReason: z.string().nullable(),
    })
    .nullable(),
  volatility: z.object({
    ljungBoxSquared: z
      .object({
        n: z.number().int(),
        lags: z.number().int(),
        q: z.number(),
        pValue: z.number(),
      })
      .nullable(),
    garch: z
      .object({
        n: z.number().int(),
        omega: z.number(),
        alpha: z.number(),
        beta: z.number(),
        persistence: z.number(),
        halfLifePeriods: z.number(),
        logLikelihood: z.number(),
        converged: z.boolean(),
        longRunVolAnnual: z.number(),
        nextPeriodVol: z.number(),
        nextPeriodVolAnnual: z.number(),
        horizonPeriods: z.number().int(),
        horizonVolAnnual: z.number(),
      })
      .nullable(),
    garchReason: z.string().nullable(),
  }),
  significance: z.object({
    tTest: z
      .object({
        n: z.number().int(),
        mean: z.number(),
        stdError: z.number(),
        t: z.number(),
        df: z.number().int(),
        pValue: z.number(),
        pValueTwoSided: z.number(),
        ciLower: z.number(),
        ciUpper: z.number(),
      })
      .nullable(),
    stationaryBootstrap: z
      .object({
        expectedBlockLength: z.number().int(),
        resamples: z.number().int(),
        mean: BootstrapTestSchema,
        sharpe: BootstrapTestSchema.nullable(),
      })
      .nullable(),
  }),
});

// Server-derived replay of a rating series (agent-rating-placebo.ts). Research only: a rating evaluation
// never authorizes, creates or sizes an order.
export const RATING_EVALUATION_STRATEGY_KEYS = [
  "agents_rating",
  "buy_hold",
  "ma_cross",
] as const;
export const RATING_EVALUATION_UNAVAILABLE_REASONS = [
  "no_bars",
  "bad_bars",
  "outside_history",
  "too_few_decisions",
  "storage_error",
  "evaluation_error",
] as const;
export const RATING_EVALUATION_EQUITY_MAX_POINTS = 500;
const finiteValue = z.number().finite();
const nullableFinite = finiteValue.nullable();
const finiteInt = finiteValue.int();
const RatingStrategyMetricsSchema = z.object({
  annualReturn: nullableFinite,
  costDrag: finiteValue,
  days: finiteInt,
  maxDrawdown: finiteValue,
  sharpe: nullableFinite,
  timeInMarket: finiteValue,
  totalReturn: finiteValue,
  trades: finiteInt,
  volatility: nullableFinite,
});
const RatingEvaluationReadySchema = z.object({
  byRating: z.array(
    z.object({
      averageNextReturn: nullableFinite,
      decisions: finiteInt,
      hitRate: nullableFinite,
      rating: AgentRatingSchema,
    })
  ),
  costBps: finiteValue,
  days: finiteInt,
  endDate: z.string(),
  failedDecisions: finiteInt,
  placebo: z.object({
    agentsPercentile: finiteValue,
    exhaustive: z.boolean(),
    finalP5: finiteValue,
    finalP50: finiteValue,
    finalP95: finiteValue,
    p5: z.array(finiteValue),
    p50: z.array(finiteValue),
    p95: z.array(finiteValue),
    seed: finiteInt,
    sims: finiteInt,
  }),
  startDate: z.string(),
  status: z.literal("ready"),
  strategies: z.array(
    z.object({
      equity: z.array(z.object({ equity: finiteValue, t: z.string() })),
      key: z.enum(RATING_EVALUATION_STRATEGY_KEYS),
      label: z.string(),
      metrics: RatingStrategyMetricsSchema,
    })
  ),
  symbol: z.string(),
  timeframe: z.string(),
});
export const RatingEvaluationSchema = z.discriminatedUnion("status", [
  z.object({
    reason: z.enum(RATING_EVALUATION_UNAVAILABLE_REASONS),
    status: z.literal("unavailable"),
  }),
  RatingEvaluationReadySchema,
]);

export const BacktestResultSchema = z.object({
  ...BacktestSummaryFields,
  equity: z.array(z.object({ t: z.string(), equity: z.number() })),
  drawdown: z.array(BacktestDrawdownPointSchema),
  trades: z.array(
    z.object({
      entry_t: z.string(),
      exit_t: z.string(),
      side: z.enum(["long", "short"]),
      qty: z.number(),
      entry_px: z.number(),
      exit_px: z.number(),
      pnl: z.number(),
      sl: z.number().optional(),
      tp: z.number().optional(),
      commission: z.number().optional(),
      regime: z.string().optional(),
      symbol: z.string().optional(),
    })
  ),
  // Null when the result has no rating series.
  ratingEvaluation: RatingEvaluationSchema.nullable(),
  ratingSeries: z
    .object({
      costBps: z.number(),
      decisions: z.array(
        z.object({
          date: z.string(),
          rating: AgentRatingSchema.nullable(),
          runId: z.string().nullable().optional(),
        })
      ),
      symbol: z.string(),
      timeframe: z.string(),
    })
    .nullable(),
  runConfig: z
    .object({
      initialCapital: z.number().optional(),
      commissionPerContract: z.number().optional(),
      commissionPerTrade: z.number().optional(),
      commissionPercent: z.number().optional(),
      slippagePercent: z.number().optional(),
      timeframe: z.string().optional(),
      fillModel: z.enum(BACKTEST_FILL_MODEL_VALUES).optional(),
      leverage: z.number().optional(),
    })
    .nullable(),
  benchmark: z
    .object({
      label: z.string(),
      points: z.array(z.object({ t: z.string(), equity: z.number() })),
    })
    .nullable(),
  analytics: BacktestAnalyticsSchema,
  folds: z.array(
    z.object({
      label: z.string(),
      train_start: z.string(),
      train_end: z.string(),
      test_start: z.string(),
      test_end: z.string(),
      metrics: z.record(z.string(), z.union([z.number(), z.string()])),
    })
  ),
});

export const BacktestListInputSchema = z
  .object({
    taskId: IdSchema.optional(),
    paperId: IdSchema.optional(),
    strategyId: IdSchema.optional(),
    limit: z.number().int().min(1).max(BACKTEST_LIST_MAX).optional(),
  })
  .strict();
export const BacktestListOutputSchema = z.object({
  backtests: z.array(BacktestResultSummarySchema),
});
export const BacktestGetInputSchema = z.object({ id: IdSchema }).strict();
export const BacktestGetOutputSchema = z.object({
  backtest: BacktestResultSchema,
  task: AgentTaskSchema.nullable(),
});

// ---------------------------------------------------------------------------
// arXiv intake: metadata from the official arXiv API (export.arxiv.org), fetched server-side.
// Accepts 2402.05272, 2402.05272v3, arXiv:2402.05272, hep-th/9901001 or an arxiv.org abs/pdf URL.
export const ARXIV_INPUT_MAX = 300;
export const PapersAddFromArxivInputSchema = z
  .object({
    arxiv: requiredText(ARXIV_INPUT_MAX),
  })
  .strict();
export const PapersAddFromArxivOutputSchema = z.object({
  paper: ResearchPaperSchema,
  created: z.boolean(),
});

// Read-only QuantVPS deployment status (vertex-deploy-status-v1), fetched server-side from
// VERTEX_DEPLOY_STATUS_URL. The upstream document is parsed strictly; the bearer token never leaves the server.
export const DEPLOY_SERVICE_NAMES = [
  "nautilus-trader",
  "ib-gateway",
  "watchdog",
  "portfolio-ui",
  "postgres",
  "redis",
  "caddy",
] as const;
export const DEPLOY_STALE_AFTER_SECONDS = 120;
export const DEPLOY_LOG_WINDOW_LINES = 500;
// Docker reports never-set timestamps as the zero time.
export const DOCKER_ZERO_TIME = "0001-01-01T00:00:00Z";

const isoTime = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Invalid timestamp",
  });
// Zero time and null both mean "never"; normalized to null.
const dockerTime = z.union([isoTime, z.null()]).transform((value) => {
  if (value === null || value.startsWith("0001-01-01")) return null;
  return value;
});
const count = z.number().int().min(0).max(1_000_000_000);

export const DeployUpstreamLogSchema = z
  .object({
    lastLineAt: dockerTime,
    lines: count,
    errorLines: count,
    warnLines: count,
  })
  .strict();

const DeployUpstreamPresentServiceSchema = z
  .object({
    service: z.string().min(1).max(64),
    present: z.literal(true),
    status: z.string().min(1).max(32),
    running: z.boolean(),
    health: z.string().min(1).max(32).nullable(),
    startedAt: dockerTime,
    finishedAt: dockerTime,
    exitCode: z.number().int().min(-1_000_000).max(1_000_000),
    restartCount: count,
    oomKilled: z.boolean(),
    image: z.string().max(300),
    log: DeployUpstreamLogSchema.optional(),
  })
  .strict();

const DeployUpstreamMissingServiceSchema = z
  .object({
    service: z.string().min(1).max(64),
    present: z.literal(false),
  })
  .strict();

export const DeployUpstreamServiceSchema = z.discriminatedUnion("present", [
  DeployUpstreamPresentServiceSchema,
  DeployUpstreamMissingServiceSchema,
]);

export const DeployUpstreamStatusSchema = z
  .object({
    schema: z.literal("vertex-deploy-status-v1"),
    host: z.string().min(1).max(128),
    generatedAt: isoTime,
    readOnly: z.literal(true),
    services: z.array(DeployUpstreamServiceSchema).max(32),
  })
  .strict();

// vertex-deploy-status-v2 (infra/quant-vps/status/SCHEMA.md): tailnet-only session snapshot, a strict
// superset of v1. Every block is either available (source, as_of, optional age_seconds/stale) or
// {available:false, reason}. Account and order ids arrive pre-masked by the collector.
export const DEPLOY_SESSION_STATES = [
  "starting",
  "running",
  "paused",
  "degraded",
  "halted",
  "stopping",
  "stopped",
  "error",
  "unknown",
] as const;
export const DEPLOY_KILL_SWITCH_STATES = [
  "engaged",
  "clear",
  "unknown",
] as const;
const shortText = z.string().max(256);
const longText = z.string().max(2000);
const nullableTime = isoTime.nullable();
const num = z.number().finite();
const nullableNum = num.nullable();
const scalar = z.union([z.string().max(2000), num, z.boolean(), z.null()]);
const scalarOrList = z.union([scalar, z.array(scalar).max(200)]);
const freeRecord = z.record(z.string().max(128), scalarOrList);

export const DeployBlockUnavailableSchema = z
  .object({
    available: z.literal(false),
    source: shortText.optional(),
    reason: longText,
  })
  .strict();

const availableBase = {
  available: z.literal(true),
  source: longText,
  as_of: nullableTime,
  age_seconds: z.number().int().min(0).optional(),
  stale: z.boolean().optional(),
};
const listBase = {
  ...availableBase,
  count,
  truncated: z.boolean().optional(),
  max_items: count.optional(),
};
const block = <T extends z.ZodRawShape>(shape: T) => {
  return z.discriminatedUnion("available", [
    z.object(shape).strict(),
    DeployBlockUnavailableSchema,
  ]);
};

export const DeploySessionStrategySchema = z
  .object({
    id: shortText,
    name: shortText,
    started_at: nullableTime,
    symbols: z.array(shortText).max(500),
    observation_only: z.boolean().nullable(),
    trading_mode: shortText.nullable(),
  })
  .strict();

export const DeploySessionBlockSchema = block({
  ...availableBase,
  state: z.enum(DEPLOY_SESSION_STATES),
  raw_state: z
    .object({
      container_status: shortText.nullable(),
      container_health: shortText.nullable(),
      container_exit_code: z.number().int().nullable(),
      health_file_status: shortText.nullable(),
      last_runner_event: shortText.nullable(),
      last_runner_event_at: nullableTime,
      heartbeat_age_seconds: nullableNum,
    })
    .strict(),
  trading_mode: shortText.nullable(),
  safe_mode: z.boolean().nullable(),
  strategies: z.array(DeploySessionStrategySchema).max(200),
  symbols: z.array(shortText).max(1000),
  account_masked: shortText.nullable(),
  started_at: nullableTime,
  stopped_at: nullableTime,
  last_heartbeat_at: nullableTime,
  ibkr_adapter: z
    .object({
      ok: z.boolean().nullable(),
      detail: longText.nullable(),
      checked_at: nullableTime,
    })
    .strict()
    .nullable(),
});

export const DeployPositionSchema = z
  .object({
    symbol: shortText,
    sec_type: shortText.nullable(),
    qty: nullableNum,
    avg_px: nullableNum,
    avg_cost: nullableNum,
    multiplier: nullableNum,
    market_price: nullableNum,
    market_value: nullableNum,
    unrealized_pnl: nullableNum,
    realized_pnl: nullableNum,
    currency: shortText.nullable(),
    right: shortText.nullable().optional(),
    strike: nullableNum.optional(),
    expiry: shortText.nullable().optional(),
  })
  .strict();
export const DeployPositionsBlockSchema = block({
  ...listBase,
  items: z.array(DeployPositionSchema).max(1000),
});

export const DeployOrderSchema = z
  .object({
    order_id_masked: shortText.nullable(),
    client_id: z.union([num, shortText]).nullable(),
    symbol: shortText,
    sec_type: shortText.nullable(),
    side: shortText.nullable(),
    type: shortText.nullable(),
    qty: nullableNum,
    filled: nullableNum,
    remaining: nullableNum,
    price: nullableNum,
    stop: nullableNum,
    aux_price: nullableNum,
    tif: shortText.nullable(),
    status: shortText.nullable(),
    currency: shortText.nullable(),
    warning: longText.nullable().optional(),
  })
  .strict();
export const DeployOrdersBlockSchema = block({
  ...listBase,
  items: z.array(DeployOrderSchema).max(1000),
});

export const DeployFillSchema = z
  .object({
    time: nullableTime,
    symbol: shortText,
    side: shortText.nullable(),
    qty: nullableNum,
    price: nullableNum,
    order_id_masked: shortText.nullable(),
    exec_id_masked: shortText.nullable(),
  })
  .strict();
export const DeployFillsBlockSchema = block({
  ...listBase,
  items: z.array(DeployFillSchema).max(1000),
});

export const DeployEquityBlockSchema = block({
  ...availableBase,
  currency: shortText.nullable(),
  net_liq: nullableNum,
  cash: nullableNum,
  available_funds: nullableNum,
  buying_power: nullableNum,
  unrealized: nullableNum,
  realized: nullableNum,
});

export const DeployWatchdogCheckSchema = z
  .object({
    ok: z.boolean().nullable(),
    required: z.boolean().nullable(),
    consecutive_failures: z.number().int().min(0).nullable(),
    detail: longText.nullable(),
    checked_at: nullableTime,
  })
  .strict();

export const DeployWatchdogSchema = z
  .object({
    as_of: nullableTime,
    status: shortText.nullable(),
    safe_mode: z.boolean().nullable(),
    orders_enabled: z.boolean().nullable(),
    nautilus_orders_enabled: z.boolean().nullable(),
    required_failures: z.array(shortText).max(100),
    kill_switch_created_at: nullableTime,
    kill_switch_reason: longText.nullable(),
    live_flags: freeRecord,
    checks: z.record(z.string().max(128), DeployWatchdogCheckSchema),
  })
  .strict();

export const DeployRiskLimitsBlockSchema = z.discriminatedUnion("available", [
  z.object(availableBase).catchall(scalarOrList),
  DeployBlockUnavailableSchema,
]);

export const DeployRiskBlockSchema = block({
  ...availableBase,
  kill_switch: z.enum(DEPLOY_KILL_SWITCH_STATES),
  kill_switch_indicators: z
    .array(
      z
        .object({
          source: shortText,
          engaged: z.boolean().nullable(),
          as_of: nullableTime,
        })
        .strict()
    )
    .max(20),
  limits: DeployRiskLimitsBlockSchema,
  last_risk_check: freeRecord.nullable(),
  watchdog: DeployWatchdogSchema.nullable(),
});

export const DeployLogEntrySchema = z
  .object({
    time: nullableTime,
    level: z.enum(["WARNING", "ERROR"]),
    source: shortText,
    message: z.string().max(1000),
    count,
  })
  .strict();
export const DeployLogsBlockSchema = block({
  ...listBase,
  items: z.array(DeployLogEntrySchema).max(200),
});

export const DeployUpstreamStatusV2Schema = z
  .object({
    schema: z.literal("vertex-deploy-status-v2"),
    host: z.string().min(1).max(128),
    generatedAt: isoTime,
    readOnly: z.literal(true),
    services: z.array(DeployUpstreamServiceSchema).max(32),
    session: DeploySessionBlockSchema,
    positions: DeployPositionsBlockSchema,
    orders: DeployOrdersBlockSchema,
    fills: DeployFillsBlockSchema,
    equity: DeployEquityBlockSchema,
    risk: DeployRiskBlockSchema,
    logs: DeployLogsBlockSchema,
    collector: z
      .object({
        version: shortText,
        duration_ms: num.min(0),
        soft_max_bytes: count,
        hard_max_bytes: count,
      })
      .strict(),
  })
  .strict();

export const DeployServiceStatusSchema = z.object({
  service: z.string(),
  present: z.boolean(),
  status: z.string().nullable(),
  running: z.boolean(),
  health: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  restartCount: z.number().int().nullable(),
  oomKilled: z.boolean(),
  image: z.string().nullable(),
  log: z
    .object({
      lastLineAt: z.string().nullable(),
      lines: z.number().int(),
      errorLines: z.number().int(),
      warnLines: z.number().int(),
    })
    .nullable(),
});

export const DeploymentStatusInputSchema = z.object({}).strict();
export const DeploymentStatusOutputSchema = z.object({
  configured: z.boolean(),
  fetchedAt: z.string(),
  source: z.object({
    host: z.string(),
    generatedAt: z.string(),
    ageSeconds: z.number().int(),
    stale: z.boolean(),
  }),
  services: z.array(DeployServiceStatusSchema),
  // Present only when the tailnet v2 snapshot is configured and parsed.
  session: DeploySessionBlockSchema.optional(),
  positions: DeployPositionsBlockSchema.optional(),
  orders: DeployOrdersBlockSchema.optional(),
  fills: DeployFillsBlockSchema.optional(),
  equity: DeployEquityBlockSchema.optional(),
  risk: DeployRiskBlockSchema.optional(),
  logs: DeployLogsBlockSchema.optional(),
  // Set when v2 is configured but failed; the output then falls back to the v1 document.
  snapshotError: z.string().max(300).optional(),
});

export const AGENT_OPS_API_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Record not found" },
  CONFLICT: { status: 409, message: "Record conflict" },
  VALIDATION_ERROR: { status: 422, message: "Record validation failed" },
  STORAGE_ERROR: {
    status: 503,
    message: "Agent operations storage unavailable",
  },
  UPSTREAM_ERROR: { status: 502, message: "Upstream metadata source failed" },
  NOT_CONFIGURED: {
    status: 503,
    message: "Deployment status endpoint not configured",
  },
} as const;

const agentOps = oc.errors(AGENT_OPS_API_ERRORS);

export const AgentOpsSummaryInputSchema = z.object({}).strict();
export const AgentOpsSummaryOutputSchema = z.object({
  statusCounts: z.record(AgentTaskStatusSchema, z.number().int().nonnegative()),
  failedLast24h: z.number().int().nonnegative(),
  paperStageCounts: z.record(
    ResearchPaperStageSchema,
    z.number().int().nonnegative()
  ),
  latestEvents: z.array(AgentTaskEventWithTaskSchema),
});

export const AgentTaskListInputSchema = z
  .object({
    status: AgentTaskStatusSchema.optional(),
    kind: AgentTaskKindSchema.optional(),
    limit: z.number().int().min(1).max(AGENT_TASKS_LIST_MAX).optional(),
  })
  .strict();
export const AgentTaskListOutputSchema = z.object({
  tasks: z.array(AgentTaskSchema),
});

export const AgentTaskGetInputSchema = z.object({ id: IdSchema }).strict();
export const AgentTaskGetOutputSchema = z.object({
  task: AgentTaskSchema,
  events: z.array(AgentTaskEventSchema),
});

export const AgentTaskCreateInputSchema = z
  .object({
    kind: AgentTaskKindSchema,
    agent: requiredText(AGENT_TASK_AGENT_MAX),
    title: requiredText(AGENT_TASK_TITLE_MAX),
    summary: clearableText(AGENT_TASK_SUMMARY_MAX).optional(),
    status: AgentTaskStatusSchema.optional(),
    metrics: AgentMetricsSchema.optional(),
    links: AgentLinksSchema.optional(),
    paperId: IdSchema.nullable().optional(),
  })
  .strict();

export const AgentTaskUpdateInputSchema = z
  .object({
    id: IdSchema,
    status: AgentTaskStatusSchema.optional(),
    title: requiredText(AGENT_TASK_TITLE_MAX).optional(),
    summary: clearableText(AGENT_TASK_SUMMARY_MAX).optional(),
    metrics: AgentMetricsSchema.optional(),
    links: AgentLinksSchema.optional(),
    paperId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.status,
        input.title,
        input.summary,
        input.metrics,
        input.links,
        input.paperId,
      ].some((value) => value !== undefined),
    { message: "Change at least one field" }
  );

export const AgentTaskAppendEventInputSchema = z
  .object({
    taskId: IdSchema,
    level: AgentTaskEventLevelSchema.optional(),
    message: requiredText(AGENT_EVENT_MESSAGE_MAX),
  })
  .strict();

export const PapersListInputSchema = z.object({}).strict();
export const PapersListOutputSchema = z.object({
  papers: z.array(ResearchPaperSchema),
});

export const PapersAddInputSchema = z
  .object({
    title: requiredText(AGENT_TASK_TITLE_MAX),
    sourceUrl: z
      .union([z.string().trim().max(2000), z.null()])
      .transform((value) => (value === null || value === "" ? null : value))
      .refine(
        (value) => value === null || (httpUrl(value) && !value.startsWith("/")),
        { message: "Expected an http(s) URL" }
      )
      .optional(),
    authors: clearableText(500).optional(),
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    identifier: clearableText(200).optional(),
    kind: ResearchPaperKindSchema.optional(),
  })
  .strict();

export const PapersUpdateInputSchema = z
  .object({
    id: IdSchema,
    stage: ResearchPaperStageSchema.optional(),
    verdict: ResearchPaperVerdictSchema.optional(),
    blockers: clearableText(RESEARCH_PAPER_TEXT_MAX).optional(),
    notes: clearableText(RESEARCH_PAPER_TEXT_MAX).optional(),
    reportedMetrics: AgentMetricsSchema.optional(),
    reproducedMetrics: AgentMetricsSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.stage,
        input.verdict,
        input.blockers,
        input.notes,
        input.reportedMetrics,
        input.reproducedMetrics,
      ].some((value) => value !== undefined),
    { message: "Change at least one field" }
  );

const summary = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/summary",
    operationId: "agentOps.summary",
    summary: "Agent task counters, paper stages and latest events",
    tags: ["Agent operations"],
  })
  .input(AgentOpsSummaryInputSchema)
  .output(AgentOpsSummaryOutputSchema);

const listTasks = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/tasks",
    operationId: "agentOps.tasks.list",
    summary: "List agent tasks",
    tags: ["Agent operations"],
  })
  .input(AgentTaskListInputSchema)
  .output(AgentTaskListOutputSchema);

const getTask = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/tasks/{id}",
    operationId: "agentOps.tasks.get",
    summary: "Read one agent task with its events",
    tags: ["Agent operations"],
  })
  .input(AgentTaskGetInputSchema)
  .output(AgentTaskGetOutputSchema);

const createTask = agentOps
  .route({
    method: "POST",
    path: "/agent-ops/tasks",
    operationId: "agentOps.tasks.create",
    summary: "Create an agent task",
    tags: ["Agent operations"],
  })
  .input(AgentTaskCreateInputSchema)
  .output(AgentTaskSchema);

const updateTask = agentOps
  .route({
    method: "PATCH",
    path: "/agent-ops/tasks/{id}",
    operationId: "agentOps.tasks.update",
    summary:
      "Update an agent task; status transitions set started and finished times",
    tags: ["Agent operations"],
  })
  .input(AgentTaskUpdateInputSchema)
  .output(AgentTaskSchema);

const appendEvent = agentOps
  .route({
    method: "POST",
    path: "/agent-ops/tasks/{taskId}/events",
    operationId: "agentOps.tasks.appendEvent",
    summary: "Append an event to an agent task",
    tags: ["Agent operations"],
  })
  .input(AgentTaskAppendEventInputSchema)
  .output(AgentTaskEventSchema);

const listPapers = agentOps
  .route({
    method: "GET",
    path: "/papers",
    operationId: "papers.list",
    summary: "List research papers",
    tags: ["Research papers"],
  })
  .input(PapersListInputSchema)
  .output(PapersListOutputSchema);

const addPaper = agentOps
  .route({
    method: "POST",
    path: "/papers",
    operationId: "papers.add",
    summary: "Add a research paper",
    tags: ["Research papers"],
  })
  .input(PapersAddInputSchema)
  .output(ResearchPaperSchema);

const updatePaper = agentOps
  .route({
    method: "PATCH",
    path: "/papers/{id}",
    operationId: "papers.update",
    summary: "Update paper stage, verdict, blockers, notes or metrics",
    tags: ["Research papers"],
  })
  .input(PapersUpdateInputSchema)
  .output(ResearchPaperSchema);

const recordBacktest = agentOps
  .route({
    method: "POST",
    path: "/agent-ops/backtests",
    operationId: "agentOps.backtests.record",
    summary:
      "Record an agent-reported backtest result for a task; drawdown is derived from equity",
    tags: ["Agent operations"],
  })
  .input(BacktestRecordInputSchema)
  .output(BacktestResultSchema);

const listBacktests = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/backtests",
    operationId: "agentOps.backtests.list",
    summary: "List backtest results without series payloads",
    tags: ["Agent operations"],
  })
  .input(BacktestListInputSchema)
  .output(BacktestListOutputSchema);

const getBacktest = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/backtests/{id}",
    operationId: "agentOps.backtests.get",
    summary:
      "Read one backtest result with equity, drawdown, trades, folds and split",
    tags: ["Agent operations"],
  })
  .input(BacktestGetInputSchema)
  .output(BacktestGetOutputSchema);

const addPaperFromArxiv = agentOps
  .route({
    method: "POST",
    path: "/papers/arxiv",
    operationId: "papers.addFromArxiv",
    summary:
      "Add a paper from arXiv metadata; an existing identifier returns the existing row",
    tags: ["Research papers"],
  })
  .input(PapersAddFromArxivInputSchema)
  .output(PapersAddFromArxivOutputSchema);

const deploymentStatus = agentOps
  .route({
    method: "GET",
    path: "/agent-ops/deployment/status",
    operationId: "agentOps.deployment.status",
    summary:
      "Read-only QuantVPS trading-stack container state from the deployment status endpoint",
    tags: ["Agent operations"],
  })
  .input(DeploymentStatusInputSchema)
  .output(DeploymentStatusOutputSchema);

export const agentOpsContract = {
  summary,
  tasks: {
    list: listTasks,
    get: getTask,
    create: createTask,
    update: updateTask,
    appendEvent,
  },
  backtests: { record: recordBacktest, list: listBacktests, get: getBacktest },
  deployment: { status: deploymentStatus },
};

export const papersContract = {
  list: listPapers,
  add: addPaper,
  update: updatePaper,
  addFromArxiv: addPaperFromArxiv,
};

export type AgentTaskKindValue = z.infer<typeof AgentTaskKindSchema>;
export type AgentTaskStatusValue = z.infer<typeof AgentTaskStatusSchema>;
export type AgentTaskEventLevelValue = z.infer<
  typeof AgentTaskEventLevelSchema
>;
export type ResearchPaperStageValue = z.infer<typeof ResearchPaperStageSchema>;
export type ResearchPaperVerdictValue = z.infer<
  typeof ResearchPaperVerdictSchema
>;
export type AgentTaskOutput = z.infer<typeof AgentTaskSchema>;
export type AgentTaskEventOutput = z.infer<typeof AgentTaskEventSchema>;
export type AgentTaskEventWithTaskOutput = z.infer<
  typeof AgentTaskEventWithTaskSchema
>;
export type AgentOpsSummaryOutput = z.infer<typeof AgentOpsSummaryOutputSchema>;
export type AgentTaskListInput = z.input<typeof AgentTaskListInputSchema>;
export type AgentTaskGetOutput = z.infer<typeof AgentTaskGetOutputSchema>;
export type AgentTaskCreateInput = z.input<typeof AgentTaskCreateInputSchema>;
export type AgentTaskUpdateInput = z.input<typeof AgentTaskUpdateInputSchema>;
export type AgentTaskAppendEventInput = z.input<
  typeof AgentTaskAppendEventInputSchema
>;
export type ResearchPaperOutput = z.infer<typeof ResearchPaperSchema>;
export type PapersAddInput = z.input<typeof PapersAddInputSchema>;
export type PapersUpdateInput = z.input<typeof PapersUpdateInputSchema>;
export type BacktestRecordInput = z.input<typeof BacktestRecordInputSchema>;
export type BacktestResultOutput = z.infer<typeof BacktestResultSchema>;
export type AgentRating = z.infer<typeof AgentRatingSchema>;
export type BacktestRatingSeries = z.infer<typeof BacktestRatingSeriesSchema>;
export type RatingEvaluationOutput = z.infer<typeof RatingEvaluationSchema>;
export type BacktestResultSummaryOutput = z.infer<
  typeof BacktestResultSummarySchema
>;
export type BacktestListInput = z.input<typeof BacktestListInputSchema>;
export type BacktestGetOutput = z.infer<typeof BacktestGetOutputSchema>;
export type PapersAddFromArxivOutput = z.infer<
  typeof PapersAddFromArxivOutputSchema
>;
export type DeploymentStatusOutput = z.infer<
  typeof DeploymentStatusOutputSchema
>;
export type DeployServiceStatusOutput = z.infer<
  typeof DeployServiceStatusSchema
>;
export type DeployUpstreamStatus = z.infer<typeof DeployUpstreamStatusSchema>;
export type DeployUpstreamStatusV2 = z.infer<
  typeof DeployUpstreamStatusV2Schema
>;
export type DeploySessionState = (typeof DEPLOY_SESSION_STATES)[number];
export type DeployKillSwitchState = (typeof DEPLOY_KILL_SWITCH_STATES)[number];
export type DeployBlockUnavailable = z.infer<
  typeof DeployBlockUnavailableSchema
>;
export type DeploySessionBlock = z.infer<typeof DeploySessionBlockSchema>;
export type DeployPositionsBlock = z.infer<typeof DeployPositionsBlockSchema>;
export type DeployOrdersBlock = z.infer<typeof DeployOrdersBlockSchema>;
export type DeployFillsBlock = z.infer<typeof DeployFillsBlockSchema>;
export type DeployEquityBlock = z.infer<typeof DeployEquityBlockSchema>;
export type DeployRiskBlock = z.infer<typeof DeployRiskBlockSchema>;
export type DeployLogsBlock = z.infer<typeof DeployLogsBlockSchema>;
