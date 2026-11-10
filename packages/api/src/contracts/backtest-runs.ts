import { STRUCTURES } from "@darkfactory/academy/schema";
import { BAR_SYMBOL_PATTERN } from "@darkfactory/shared/universes";
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  STRATEGY_OPTION_STRUCTURES,
  STRATEGY_OPTION_SYMBOLS,
  StrategyDefinitionSchema,
} from "../strategy-dsl.ts";
import {
  BacktestRunCostsSchema,
  CostProfileInputSchema,
  CostProfileSchema,
} from "./backtest-cost-profiles.ts";
import { backtestSweepProcedure } from "./backtest-sweep.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import {
  EngineComparisonSpecSchema,
  EngineDifferencesSchema,
  EngineRunSchema,
  engineComparisonsContract,
} from "./engine-comparison.ts";
import { forwardDriftContract } from "./forward-drift.ts";
import {
  INSTANT_BACKTEST_TIMEFRAMES,
  InstantBacktestBreakoutSchema,
  InstantBacktestSmaCrossSchema,
} from "./instant-backtest.ts";
import { SECTOR_ROTATION_QUADRANTS } from "./sector-rotation.ts";
import { strategyDefinitionsContract } from "./strategy-definitions.ts";

// Backtest runs: a queued job that runs a backtest engine over a date range of stored bars and
// stores an account-currency report tied to an immutable strategy revision (a SHA-256 of the
// strategy snapshot taken at submit time). The API server runs `instant-2` runs (TypeScript
// engine) itself. A research worker runs `nautilus-trader-*` runs: it claims a run with
// `engine.claim`, runs NautilusTrader and posts the result with `engine.complete` (or
// `engine.fail`); the API builds the report. `sweep` runs a parameter grid in the request and
// stores nothing (see ./backtest-sweep.ts). Operator-only; agent keys may call it (read keys only
// list, get and sweep; the engine procedures need a write key). Research only; there is no order
// or broker path.

export const BACKTEST_RUN_ENGINE_VERSION = "instant-2";
/** Engine id of runs that the Nautilus research worker runs (services/research/nautilus_backtest). */
export const BACKTEST_RUN_NAUTILUS_ENGINE = "nautilus-trader-1.227.0";
/** Most bars one worker run may have (claim fails a longer run; complete rejects longer results). */
export const BACKTEST_RUN_ENGINE_BARS_MAX = 1_000_000;
export const BACKTEST_RUN_ENGINE_ERROR_MAX = 500;
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
    symbol: z.string().regex(BAR_SYMBOL_PATTERN),
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

/** Exit reasons of an options book trade (qc_ports book.py). */
export const OPTIONS_EXIT_REASONS = [
  "expiry",
  "stale-iv",
  "exitDte",
  "profitTake",
  "signal",
  "end",
] as const;

/** One option vertical of an options run, per the ledger (qc_ports ledger.trade_record). */
export const BacktestRunOptionsTradeSchema = z.object({
  contracts: z.number().int(),
  entryDate: z.string(),
  entryFee: z.number(),
  entryPrice: z.number(),
  exitDate: z.string(),
  exitFee: z.number(),
  exitPrice: z.number(),
  exitReason: z.enum(OPTIONS_EXIT_REASONS),
  expiry: z.string(),
  id: z.number().int(),
  longStrike: z.number(),
  pnl: z.number(),
  returnOnRisk: z.number(),
  shortStrike: z.number(),
  structure: z.string(),
  symbol: z.string(),
});

/**
 * Metrics of an options run (qc_ports metrics.summarize with one trial, plus the book skips, the
 * largest open risk and the stale-IV exits): Sharpe is daily × √252, deflatedSharpe is the
 * probabilistic Sharpe (one trial), years are calendar days / 365.25.
 */
export const BacktestRunOptionsMetricsSchema = z.object({
  cagr: nullableNumber,
  days: z.number().int(),
  deflatedSharpe: nullableNumber,
  end: z.string(),
  expectedMaxSharpe: nullableNumber,
  exposure: z.number(),
  finalEquity: z.number(),
  maxDrawdown: z.number(),
  maxOpenRisk: z.number(),
  nTrials: z.number().int(),
  sharpe: nullableNumber,
  sharpeVariance: nullableNumber,
  skipped: z.number().int(),
  staleIvExits: z.number().int(),
  start: z.string(),
  totalReturn: z.number(),
  trades: z.number().int(),
  winRate: nullableNumber,
  worstMonth: z.string().nullable(),
  worstMonthReturn: nullableNumber,
});

/**
 * Largest relative daily equity gap between the options ledger and NautilusTrader that a Nautilus
 * options run may have; the same value as PARITY_REL_TOL in
 * services/research/strategies/qc_ports/portfolio.py (a test pins both).
 */
export const OPTIONS_NAUTILUS_PARITY_TOLERANCE = 1e-6;

const nautilusGapSchema = z
  .number()
  .min(0)
  .max(OPTIONS_NAUTILUS_PARITY_TOLERANCE);

/** Entry signals per options symbol. */
const optionsSignalsSchema = z
  .record(z.string(), z.number().int().min(0))
  .refine(
    (signals) =>
      Object.keys(signals).every((symbol) =>
        (STRATEGY_OPTION_SYMBOLS as readonly string[]).includes(symbol)
      ),
    { message: "Signals are counted per options symbol" }
  );

/** Most trades a stored report keeps (the run's metrics still count every trade). */
export const BACKTEST_RUN_TRADES_MAX = 5000;

/** Options runs: the options book result (docs/vertex-rebuild/strategy-definitions.md, options runner). */
export const BacktestRunOptionsReportSchema = z.object({
  capital: z.number(),
  metrics: BacktestRunOptionsMetricsSchema,
  /** Nautilus runs: largest daily equity gap between the ledger and NautilusTrader (relative). */
  nautilusGap: nautilusGapSchema.nullable(),
  /** Entry signals per symbol (events handed to the book). */
  signals: optionsSignalsSchema,
  symbols: z.array(z.string()),
  /** The first BACKTEST_RUN_TRADES_MAX spreads; `metrics` count them all. */
  trades: z.array(BacktestRunOptionsTradeSchema).max(BACKTEST_RUN_TRADES_MAX),
  /** True when the run had more spreads than `trades` keeps. */
  tradesTruncated: z.boolean(),
});

export const BacktestRunReportSchema = z.object({
  bars: z.number().int(),
  /** Present when the run had a cost profile: charges in money and the profit before them. */
  costs: BacktestRunCostsSchema.optional(),
  /** Comparison runs: the differences to the TypeScript result they repeat. */
  differences: EngineDifferencesSchema.optional(),
  /** Nautilus runs: where and how long the engine ran. */
  engineRun: EngineRunSchema.optional(),
  equity: z.array(
    z.object({ drawdownPct: z.number(), equity: z.number(), t: z.number() })
  ),
  firstT: z.number().int(),
  lastT: z.number().int(),
  metrics: BacktestRunMetricsSchema,
  /** Options definitions: the options book result; `trades` then holds the same spreads. */
  options: BacktestRunOptionsReportSchema.optional(),
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
      exitReason: z.enum([
        "signal",
        "stop",
        "target",
        "end",
        "sessionClose",
        "expiry",
        "stale-iv",
        "exitDte",
        "profitTake",
      ]),
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

/** Daily bars of one Academy comparison run (about 80 years). */
export const BACKTEST_RUN_ACADEMY_BARS_MAX = 20_000;

export const BacktestRunSpecSchema = z.object({
  /** Engine comparison runs only (./engine-comparison.ts). */
  comparison: EngineComparisonSpecSchema.optional(),
  costBps: z.number(),
  costProfile: CostProfileSchema.optional(),
  from: z.string(),
  initialCapital: z.number(),
  /**
   * DSL rules only: close a position at the next open after this many bars (the
   * runStrategyDefinition time exit). Setup replay comparison runs set it.
   */
  maxHoldBars: z.number().int().min(1).optional(),
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
    /**
     * Academy comparison runs only (the dual run of the Academy modelled options backtest): the
     * structure and its resolved rules on the daily closes of `symbol`, with `initialCapital` as
     * the capital. `iv` holds one implied volatility (or null) per bar from `from` to `to`.
     * Only the Nautilus research worker runs it; `backtestRuns.create` does not accept it.
     */
    z.object({
      iv: z
        .array(z.number().nullable())
        .max(BACKTEST_RUN_ACADEMY_BARS_MAX)
        .optional(),
      kind: z.literal("academy"),
      rules: z.record(z.string(), z.number()),
      structure: z.enum(STRUCTURES),
    }),
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
  VALIDATION_ERROR: {
    message: "The backtest engines cannot run this strategy",
    status: 422,
  },
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

// Engine worker procedures (backtestRuns.engine.*). claim moves the oldest queued run of the engine
// to running and returns its spec with the bars of the date range (the same slice the API engine
// uses), the resolved cost settings and the sector rotation points that the definition's filters
// need. complete sends the engine result: unit equity per bar, the trades and the stats (the shape
// of the TypeScript engine result); the API checks it against the stored bars, recomputes the
// stats from the equity and trades (they must match the sent stats) and builds the report. fail
// stores an error. complete and fail change only a running run of the same engine; any other run
// returns CONFLICT. With `max`, claim returns a batch on one bar series (a comparison group) and
// completeMany stores the whole batch in one request, with one outcome per run. A definition that
// reads daily series gets the series store rows (`series`, cut at the run's `to`); its
// seriesSha256 then covers the bars and the rows. An options definition is claimed alone and its
// result is the options runner document (kind "options": the ledger, its trades and skips and the
// metrics, which the API recomputes). Write keys only; research only, no order path.

const engineName = z.literal(BACKTEST_RUN_NAUTILUS_ENGINE);
const engineRunId = z.string().trim().min(1).max(128);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
/** JSON has no NaN, so a missing value (NaN in the stored columns, such as an unknown volume) is null. */
const values = z.array(z.number().nullable());

/** One daily series of the store (market_daily_series) up to the run's `to`, in date order. */
export const BacktestRunEngineSeriesColumnsSchema = z.object({
  adjClose: values,
  close: z.array(z.number()),
  dates: z.array(z.string()),
  high: values,
  low: values,
  open: values,
});

/** Series store rows by series id; null when the run reads no daily series. */
const seriesRowsSchema = z
  .record(z.string(), BacktestRunEngineSeriesColumnsSchema)
  .nullable();

export const BacktestRunEngineBarsSchema = z.object({
  c: values,
  h: values,
  l: values,
  o: values,
  t: values,
  v: values.optional(),
});

/** Most runs one batch claim returns. */
export const BACKTEST_RUN_ENGINE_BATCH_MAX = 50;

export const BacktestRunEngineClaimInputSchema = z
  .object({
    engine: engineName,
    /**
     * With `max`, claim returns a batch: the oldest queued run and, when it belongs to a
     * comparison group, up to `max - 1` more runs of that group, all on one bar series.
     */
    max: z.number().int().min(1).max(BACKTEST_RUN_ENGINE_BATCH_MAX).optional(),
  })
  .strict();

const costsSchema = z
  .object({ capital: z.number(), profile: CostProfileSchema })
  .nullable();
/** Sector rotation points by `${sector}:${timeframe}`; null without sector filters. */
const sectorQuadrantsSchema = z
  .record(
    z.string(),
    z.array(
      z.object({
        date: z.string(),
        quadrant: z.enum(SECTOR_ROTATION_QUADRANTS),
      })
    )
  )
  .nullable();

export const BacktestRunEngineClaimOutputSchema = z.object({
  /** With `max`: the claimed runs on one shared bar series; null when none is queued. */
  batch: z
    .object({
      /** Bars from the earliest `from` to the latest `to` of the runs. */
      bars: BacktestRunEngineBarsSchema,
      runs: z
        .array(
          z.object({
            costs: costsSchema,
            /** The run's bars are bars[first..end) (its own date range). */
            end: z.number().int().positive(),
            first: z.number().int().nonnegative(),
            id: z.string(),
            sectorQuadrants: sectorQuadrantsSchema,
            /**
             * The run's own seriesSha256 when it reads daily series (its bars and its rows);
             * absent when it is the batch's.
             */
            seriesSha256: sha256.optional(),
            spec: BacktestRunSpecSchema,
          })
        )
        .min(1)
        .max(BACKTEST_RUN_ENGINE_BATCH_MAX),
      /**
       * The rows every run of the batch reads: each series up to the latest `to` of the runs that
       * read it (a run reads its rows up to its own `to`).
       */
      series: seriesRowsSchema.optional(),
      /** The bar series hash (each run's seriesSha256 unless the run has its own). */
      seriesSha256: sha256,
    })
    .nullable()
    .optional(),
  /** The claimed run without `max`; null with `max` (see batch) or when none is queued. */
  run: z
    .object({
      bars: BacktestRunEngineBarsSchema,
      /** Cost profile and capital for the engine; null without a profile. */
      costs: costsSchema,
      id: z.string(),
      sectorQuadrants: sectorQuadrantsSchema,
      /** The daily series rows the definition reads (options: everything the runner reads). */
      series: seriesRowsSchema.optional(),
      /** Hash of the bar series, and of the series rows when the run reads any. */
      seriesSha256: sha256,
      spec: BacktestRunSpecSchema,
    })
    .nullable(),
});

const tradeAmount = z.number();

export const BacktestRunEngineTradeSchema = z
  .object({
    costs: z
      .object({
        bps: tradeAmount,
        commission: tradeAmount,
        fees: tradeAmount,
        slippage: tradeAmount,
        spread: tradeAmount,
        total: tradeAmount,
      })
      .strict()
      .optional(),
    entryIndex: z.number().int().min(0),
    entryPrice: z.number().positive(),
    exitIndex: z.number().int().min(0),
    exitPrice: z.number().positive(),
    exitReason: z.enum(["signal", "stop", "target", "end", "sessionClose"]),
    grossPnl: tradeAmount.optional(),
    netReturn: tradeAmount,
    pnl: tradeAmount,
    units: z.number().positive(),
  })
  .strict()
  .refine((trade) => trade.exitIndex >= trade.entryIndex, {
    message: "A trade must exit on or after its entry bar",
  });

export const BacktestRunEngineStatsSchema = z
  .object({
    bars: z.number().int().min(0),
    buyHoldMaxDrawdown: z.number(),
    buyHoldReturn: z.number(),
    cagr: z.number().nullable(),
    exposure: z.number(),
    maxDrawdown: z.number(),
    profitFactor: z.number().nullable(),
    sharpe: z.number().nullable(),
    sortino: z.number().nullable(),
    totalReturn: z.number(),
    trades: z.number().int().min(0),
    winRate: z.number().nullable(),
  })
  .strict();

export const BacktestRunEngineResultSchema = z
  .object({
    /** Unit equity (starting equity 1) at every bar of the range; finite and above 0. */
    equity: z
      .array(z.number().positive())
      .min(2)
      .max(BACKTEST_RUN_ENGINE_BARS_MAX),
    stats: BacktestRunEngineStatsSchema,
    trades: z
      .array(BacktestRunEngineTradeSchema)
      .max(BACKTEST_RUN_ENGINE_BARS_MAX),
  })
  .strict()
  .superRefine((result, context) => {
    const size = result.equity.length;
    if (result.stats.bars !== size)
      context.addIssue({
        code: "custom",
        message: "stats.bars must equal the equity length",
        path: ["stats", "bars"],
      });
    if (result.stats.trades !== result.trades.length)
      context.addIssue({
        code: "custom",
        message: "stats.trades must equal the number of trades",
        path: ["stats", "trades"],
      });
    result.trades.forEach((trade, index) => {
      if (trade.exitIndex >= size)
        context.addIssue({
          code: "custom",
          message: "Trade bar index is outside the equity series",
          path: ["trades", index, "exitIndex"],
        });
    });
  });

/** Most run days and most trades or skips of an options result. */
export const BACKTEST_RUN_OPTIONS_DAYS_MAX = 20_000;
export const BACKTEST_RUN_OPTIONS_TRADES_MAX = 20_000;
/**
 * Most bytes of daily series rows one claim sends (JSON): a run (or batch) whose rows are larger
 * fails at claim. The 32 store series over 35 years are about 13 MB.
 */
export const BACKTEST_RUN_ENGINE_SERIES_MAX_BYTES = 40_000_000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const optionsSymbol = z.enum(STRATEGY_OPTION_SYMBOLS);

/**
 * The options runner result of a Nautilus run (strategies.qc_ports.portfolio.run_spec_json): the
 * ledger in money (dates, equity, open positions, trades, size skips), the book skips, the entry
 * signals per symbol, the metrics (portfolio.run_metrics) and the largest daily equity gap between
 * the ledger and NautilusTrader.
 */
export const BacktestRunEngineOptionsResultSchema = z
  .object({
    bookSkipped: z.number().int().min(0),
    capital: z.number().positive(),
    dates: z.array(isoDate).min(2).max(BACKTEST_RUN_OPTIONS_DAYS_MAX),
    equity: z.array(z.number()).min(2).max(BACKTEST_RUN_OPTIONS_DAYS_MAX),
    kind: z.literal("options"),
    metrics: BacktestRunOptionsMetricsSchema.extend({
      end: isoDate,
      start: isoDate,
      worstMonth: z.string().max(7).nullable(),
    }).strict(),
    /** Required: the worker books every options run again in NautilusTrader. */
    nautilusGap: nautilusGapSchema,
    openPositions: z
      .array(z.number().int().min(0))
      .max(BACKTEST_RUN_OPTIONS_DAYS_MAX),
    signals: optionsSignalsSchema,
    skipped: z
      .array(
        z
          .object({
            entryDate: isoDate,
            id: z.number().int().min(1),
            reason: z.literal("size"),
            symbol: optionsSymbol,
          })
          .strict()
      )
      .max(BACKTEST_RUN_OPTIONS_TRADES_MAX),
    trades: z
      .array(
        BacktestRunOptionsTradeSchema.extend({
          contracts: z.number().int().min(1),
          entryDate: isoDate,
          exitDate: isoDate,
          expiry: isoDate,
          id: z.number().int().min(1),
          /** Max loss per contract (entry cost and worst exit cost included), for the open risk. */
          maxLoss: z.number().positive(),
          structure: z.enum(STRATEGY_OPTION_STRUCTURES),
          symbol: optionsSymbol,
        }).strict()
      )
      .max(BACKTEST_RUN_OPTIONS_TRADES_MAX),
  })
  .strict()
  .superRefine((result, context) => {
    const size = result.dates.length;
    for (const key of ["equity", "openPositions"] as const)
      if (result[key].length !== size)
        context.addIssue({
          code: "custom",
          message: `${key} must have one value per date`,
          path: [key],
        });
    if (
      result.dates.some(
        (date, index) =>
          index > 0 && date <= (result.dates[index - 1] as string)
      )
    )
      context.addIssue({
        code: "custom",
        message: "dates must be strictly increasing",
        path: ["dates"],
      });
    const days = new Set(result.dates);
    const ids = new Set<number>();
    result.trades.forEach((trade, index) => {
      if (
        !(days.has(trade.entryDate) && days.has(trade.exitDate)) ||
        trade.entryDate > trade.exitDate
      )
        context.addIssue({
          code: "custom",
          message:
            "A trade must enter and exit on run dates, the exit on or after the entry",
          path: ["trades", index, "exitDate"],
        });
      if (ids.has(trade.id))
        context.addIssue({
          code: "custom",
          message: "Trade ids must be unique",
          path: ["trades", index, "id"],
        });
      ids.add(trade.id);
    });
  });

/** A worker result: the equity engine result, or the options runner result (kind "options"). */
export const BacktestRunEngineAnyResultSchema = z.union([
  BacktestRunEngineResultSchema,
  BacktestRunEngineOptionsResultSchema,
]);

export const BacktestRunEngineCompleteInputSchema = z
  .object({
    engine: engineName,
    engineRun: EngineRunSchema.optional(),
    id: engineRunId,
    result: BacktestRunEngineAnyResultSchema,
    /** The seriesSha256 returned by claim; the API refuses a result for changed bars. */
    seriesSha256: sha256,
  })
  .strict();

/** One item of completeMany: a result (as complete) or an engine error (as fail). */
export const BacktestRunEngineCompleteItemSchema = z.union([
  z
    .object({
      engineRun: EngineRunSchema.optional(),
      id: engineRunId,
      result: BacktestRunEngineAnyResultSchema,
      seriesSha256: sha256,
    })
    .strict(),
  z
    .object({
      error: z.string().trim().min(1).max(BACKTEST_RUN_ENGINE_ERROR_MAX),
      id: engineRunId,
    })
    .strict(),
]);

export const BacktestRunEngineCompleteManyInputSchema = z
  .object({
    engine: engineName,
    items: z
      .array(BacktestRunEngineCompleteItemSchema)
      .min(1)
      .max(BACKTEST_RUN_ENGINE_BATCH_MAX),
  })
  .strict();

export const BacktestRunEngineCompleteManyOutputSchema = z.object({
  /** One outcome per item, in item order: the stored status, or why nothing changed. */
  outcomes: z.array(
    z.object({
      error: z.enum(["BAD_REQUEST", "CONFLICT", "NOT_FOUND"]).optional(),
      id: z.string(),
      message: z.string().optional(),
      status: z.enum(BACKTEST_RUN_STATUS_VALUES).nullable(),
    })
  ),
});

export const BacktestRunEngineFailInputSchema = z
  .object({
    engine: engineName,
    error: z.string().trim().min(1).max(BACKTEST_RUN_ENGINE_ERROR_MAX),
    id: engineRunId,
  })
  .strict();

export const BacktestRunEngineOutcomeSchema = z.object({
  id: z.string(),
  status: z.enum(BACKTEST_RUN_STATUS_VALUES),
});

export const BACKTEST_RUN_ENGINE_ERRORS = {
  ...BACKTEST_RUN_ERRORS,
  CONFLICT: {
    message: "The backtest run is not running on this engine",
    status: 409,
  },
} as const;

const engine = oc.errors(BACKTEST_RUN_ENGINE_ERRORS);

const engineClaim = engine
  .route({
    method: "POST",
    operationId: "backtestRuns.engine.claim",
    path: "/backtest-runs/engine/claim",
    summary:
      "Research worker: claim the oldest queued backtest run of an engine, with its bars (no orders)",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunEngineClaimInputSchema)
  .output(BacktestRunEngineClaimOutputSchema);

const engineComplete = engine
  .route({
    method: "POST",
    operationId: "backtestRuns.engine.complete",
    path: "/backtest-runs/engine/complete",
    summary:
      "Research worker: store the engine result of a claimed run; the API builds the report",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunEngineCompleteInputSchema)
  .output(BacktestRunEngineOutcomeSchema);

const engineCompleteMany = engine
  .route({
    method: "POST",
    operationId: "backtestRuns.engine.completeMany",
    path: "/backtest-runs/engine/complete-many",
    summary:
      "Research worker: store the results or errors of a claimed batch in one request",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunEngineCompleteManyInputSchema)
  .output(BacktestRunEngineCompleteManyOutputSchema);

const engineFail = engine
  .route({
    method: "POST",
    operationId: "backtestRuns.engine.fail",
    path: "/backtest-runs/engine/fail",
    summary: "Research worker: store the error of a claimed run",
    tags: ["Backtest runs"],
  })
  .input(BacktestRunEngineFailInputSchema)
  .output(BacktestRunEngineOutcomeSchema);

export const backtestRunsContract = {
  combine,
  comparisons: engineComparisonsContract,
  definitions: strategyDefinitionsContract,
  drift: forwardDriftContract,
  engine: {
    claim: engineClaim,
    complete: engineComplete,
    completeMany: engineCompleteMany,
    fail: engineFail,
  },
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
export type BacktestRunEngineClaimOutput = z.infer<
  typeof BacktestRunEngineClaimOutputSchema
>;
export type BacktestRunEngineCompleteItem = z.infer<
  typeof BacktestRunEngineCompleteItemSchema
>;
export type BacktestRunEngineResult = z.infer<
  typeof BacktestRunEngineResultSchema
>;
export type BacktestRunEngineOptionsResult = z.infer<
  typeof BacktestRunEngineOptionsResultSchema
>;
