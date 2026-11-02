import { oc } from "@orpc/contract";
import { z } from "zod";

// Forward drift (backtestRuns.drift.*): a monitor pins one finished backtest run as the baseline
// of a strategy revision and receives the paper (forward) equity series and closed trades of the
// same revision. Each recording evaluates five checks (drawdown, losing streak, rolling profit
// factor, Sharpe, rolling win rate) against warn/alert thresholds and stores an in-app alert when
// a check reaches a more severe level. Paper data only: nothing here places, routes or simulates
// broker orders. Operator-only; write keys may create, record and acknowledge, read keys may list
// and get.

export const FORWARD_DRIFT_CHECK_KEYS = [
  "drawdown",
  "losingStreak",
  "profitFactor",
  "sharpe",
  "winRate",
] as const;
export const FORWARD_DRIFT_LEVEL_VALUES = [
  "ok",
  "warn",
  "alert",
  "insufficient",
] as const;
/** Points or trades in one recording request. */
export const FORWARD_DRIFT_RECORD_MAX = 2000;
/** Points or trades stored per monitor. */
export const FORWARD_DRIFT_STORED_MAX = 5000;
export const FORWARD_DRIFT_LIST_DEFAULT = 50;
export const FORWARD_DRIFT_LIST_LIMIT = 100;

const id = z.string().trim().min(1).max(128);
const revision = z.string().regex(/^[0-9a-f]{64}$/u);
/** Epoch milliseconds up to the year 9999. */
const time = z.number().int().min(0).max(253_402_300_799_999);
const thresholdValue = z.number().min(-100).max(100);

const ThresholdOverrideSchema = z
  .object({
    alert: thresholdValue.optional(),
    warn: thresholdValue.optional(),
  })
  .strict();

export const ForwardDriftThresholdOverridesSchema = z
  .object({
    drawdown: ThresholdOverrideSchema.optional(),
    losingStreak: ThresholdOverrideSchema.optional(),
    profitFactor: ThresholdOverrideSchema.optional(),
    sharpe: ThresholdOverrideSchema.optional(),
    winRate: ThresholdOverrideSchema.optional(),
  })
  .strict();

export const ForwardDriftCreateInputSchema = z
  .object({
    baselineRunId: id,
    /** Must equal the baseline run's strategy revision (null for a run without a strategy). */
    expectedRevision: revision.nullable(),
    label: z.string().trim().min(1).max(120),
    thresholds: ForwardDriftThresholdOverridesSchema.optional(),
  })
  .strict();

const increasing = (
  values: readonly Readonly<{ t: number }>[],
  strict: boolean
): boolean => {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (strict ? value.t <= previous : value.t < previous) return false;
    previous = value.t;
  }
  return true;
};

export const ForwardDriftRecordInputSchema = z
  .object({
    id,
    points: z
      .array(z.object({ equity: z.number().positive(), t: time }).strict())
      .max(FORWARD_DRIFT_RECORD_MAX)
      .default([])
      .refine((points) => increasing(points, true), {
        message: "Point times must increase",
      }),
    /** Paper only. There is no live source. */
    source: z.literal("paper"),
    trades: z
      .array(z.object({ pnl: z.number(), t: time }).strict())
      .max(FORWARD_DRIFT_RECORD_MAX)
      .default([])
      .refine((trades) => increasing(trades, false), {
        message: "Trade times must not decrease",
      }),
  })
  .strict()
  .refine((input) => input.points.length + input.trades.length > 0, {
    message: "Send at least one point or trade",
    path: ["points"],
  });

export const ForwardDriftGetInputSchema = z.object({ id }).strict();

export const ForwardDriftListInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(FORWARD_DRIFT_LIST_LIMIT)
      .default(FORWARD_DRIFT_LIST_DEFAULT),
  })
  .strict();

export const ForwardDriftAcknowledgeInputSchema = z.object({ id }).strict();

/** Most monitors one paper tick processes. */
export const PAPER_FORWARD_TICK_MAX = 20;

export const PaperForwardSetInputSchema = z
  .object({ id, running: z.boolean() })
  .strict();

/** Without an id, every running paper runner is ticked (oldest first, at most 20). */
export const PaperForwardTickInputSchema = z
  .object({ id: id.optional() })
  .strict();

const PaperRunnerSchema = z.object({
  /** Outcome of the last tick, for example "No new settled bars". Null before the first tick. */
  note: z.string().nullable(),
  status: z.enum(["off", "running"]),
  tickedAt: z.date().nullable(),
});

export const PaperForwardTickResultSchema = z.object({
  monitorId: z.string(),
  newPoints: z.number().int(),
  newTrades: z.number().int(),
  note: z.string().nullable(),
  raised: z.number().int(),
});

export const PaperForwardTickOutputSchema = z.object({
  results: z.array(PaperForwardTickResultSchema),
});

const ThresholdSchema = z.object({ alert: z.number(), warn: z.number() });
const ThresholdsSchema = z.object({
  drawdown: ThresholdSchema,
  losingStreak: ThresholdSchema,
  profitFactor: ThresholdSchema,
  sharpe: ThresholdSchema,
  winRate: ThresholdSchema,
});
const level = z.enum(FORWARD_DRIFT_LEVEL_VALUES);

export const ForwardDriftCheckSchema = z.object({
  alertAt: z.number(),
  baseline: z.number().nullable(),
  direction: z.enum(["higher-is-worse", "lower-is-worse"]),
  forward: z.number().nullable(),
  key: z.enum(FORWARD_DRIFT_CHECK_KEYS),
  label: z.string(),
  level,
  minSample: z.number().int(),
  ratio: z.number().nullable(),
  reason: z.string(),
  sample: z.number().int(),
  warnAt: z.number(),
});

export const ForwardDriftAlertSchema = z.object({
  acknowledgedAt: z.date().nullable(),
  baselineValue: z.number().nullable(),
  check: z.enum(FORWARD_DRIFT_CHECK_KEYS),
  createdAt: z.date(),
  forwardValue: z.number().nullable(),
  id: z.string(),
  level: z.enum(["warn", "alert"]),
  message: z.string(),
  monitorId: z.string(),
  ratio: z.number().nullable(),
});

export const ForwardDriftMonitorSummarySchema = z.object({
  baselineRunId: z.string(),
  createdAt: z.date(),
  id: z.string(),
  label: z.string(),
  level,
  paper: PaperRunnerSchema,
  pointCount: z.number().int(),
  strategyRevision: z.string().nullable(),
  thresholds: ThresholdsSchema,
  tradeCount: z.number().int(),
  updatedAt: z.date(),
  version: z.number().int(),
});

const point = z.object({ equity: z.number(), t: z.number() });

export const ForwardDriftMonitorSchema =
  ForwardDriftMonitorSummarySchema.extend({
    alerts: z.array(ForwardDriftAlertSchema),
    baseline: z.object({
      engineVersion: z.string(),
      /** The run's stored equity chart series (at most 2,000 points). */
      equity: z.array(point),
      initialCapital: z.number(),
      label: z.string(),
      seriesSha256: z.string(),
    }),
    checks: z.array(ForwardDriftCheckSchema),
    points: z.array(point),
    trades: z.array(z.object({ pnl: z.number(), t: z.number() })),
  });

export const ForwardDriftListOutputSchema = z.object({
  monitors: z.array(ForwardDriftMonitorSummarySchema),
  openAlerts: z.array(ForwardDriftAlertSchema),
});

export const ForwardDriftRecordOutputSchema = z.object({
  monitor: ForwardDriftMonitorSchema,
  raised: z.array(ForwardDriftAlertSchema),
});

export const FORWARD_DRIFT_ERRORS = {
  BAD_REQUEST: { message: "Invalid drift monitor request", status: 400 },
  CONFLICT: {
    message: "The monitor changed during this request; send it again",
    status: 409,
  },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Drift monitor, alert or run not found", status: 404 },
  STORAGE_ERROR: { message: "Drift storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const drift = oc.errors(FORWARD_DRIFT_ERRORS);
const tags = ["Forward drift"];

const create = drift
  .route({
    method: "POST",
    operationId: "backtestRuns.drift.create",
    path: "/forward-drift/monitors",
    summary:
      "Pin a finished backtest run as the drift baseline for paper results (paper only, no orders)",
    tags,
  })
  .input(ForwardDriftCreateInputSchema)
  .output(ForwardDriftMonitorSchema);

const record = drift
  .route({
    method: "POST",
    operationId: "backtestRuns.drift.record",
    path: "/forward-drift/monitors/{id}/observations",
    summary:
      "Append paper equity points and closed trades, evaluate drift and raise in-app alerts",
    tags,
  })
  .input(ForwardDriftRecordInputSchema)
  .output(ForwardDriftRecordOutputSchema);

const get = drift
  .route({
    method: "GET",
    operationId: "backtestRuns.drift.get",
    path: "/forward-drift/monitors/{id}",
    summary: "Read one drift monitor with its evaluated checks and alerts",
    tags,
  })
  .input(ForwardDriftGetInputSchema)
  .output(ForwardDriftMonitorSchema);

const list = drift
  .route({
    method: "GET",
    operationId: "backtestRuns.drift.list",
    path: "/forward-drift/monitors",
    summary:
      "List drift monitors, newest first, with the newest 200 open alerts",
    tags,
  })
  .input(ForwardDriftListInputSchema)
  .output(ForwardDriftListOutputSchema);

const acknowledge = drift
  .route({
    method: "POST",
    operationId: "backtestRuns.drift.acknowledge",
    path: "/forward-drift/alerts/{id}/acknowledge",
    summary: "Acknowledge one open drift alert",
    tags,
  })
  .input(ForwardDriftAcknowledgeInputSchema)
  .output(ForwardDriftAlertSchema);

const paperSet = drift
  .route({
    method: "POST",
    operationId: "backtestRuns.drift.paperSet",
    path: "/forward-drift/monitors/{id}/paper",
    summary:
      "Start or stop the paper forward runner of a monitor (simulated fills only, no broker calls)",
    tags,
  })
  .input(PaperForwardSetInputSchema)
  .output(ForwardDriftMonitorSchema);

const paperTick = drift
  .route({
    method: "POST",
    operationId: "backtestRuns.drift.paperTick",
    path: "/forward-drift/paper/tick",
    summary:
      "Run the baseline strategy on new stored bars in paper mode and record the settled results",
    tags,
  })
  .input(PaperForwardTickInputSchema)
  .output(PaperForwardTickOutputSchema);

export const forwardDriftContract = {
  acknowledge,
  create,
  get,
  list,
  paperSet,
  paperTick,
  record,
};

export type ForwardDriftCreateInput = z.input<
  typeof ForwardDriftCreateInputSchema
>;
export type ForwardDriftRecordInput = z.input<
  typeof ForwardDriftRecordInputSchema
>;
export type ForwardDriftMonitor = z.infer<typeof ForwardDriftMonitorSchema>;
export type ForwardDriftMonitorSummary = z.infer<
  typeof ForwardDriftMonitorSummarySchema
>;
export type ForwardDriftAlert = z.infer<typeof ForwardDriftAlertSchema>;
export type ForwardDriftCheckOutput = z.infer<typeof ForwardDriftCheckSchema>;
export type PaperForwardTickResult = z.infer<
  typeof PaperForwardTickResultSchema
>;
