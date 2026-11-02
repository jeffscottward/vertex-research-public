import { oc } from "@orpc/contract";
import { z } from "zod";

import { AGENT_OPS_API_ERRORS, AgentTaskSchema } from "./agent-ops.ts";

// Optimizer runs: agents record, operators read (agentOps.optimizations.*). Operator-only through
// requireOperator; agent keys may call it, read keys only list and get. Values are agent-reported.
// Shapes and bounds are checked here; index ranges, method/validation combinations and cross-field
// rules are enforced once in the repository normalizer and reach the caller as VALIDATION_ERROR.
// Parameter importance and score profiles are derived by the server on get and never stored.
//
// Mapping from services/research/backtesting/optimizer.py OptimizationResult.to_dict() (result `r`):
//   method            <- r.method
//   objectives        <- r.config.objectives                          ([{ metric, direction }])
//   validation        <- { mode: r.config.validation.mode, params: { nObservations: n_observations,
//                          isFraction: is_fraction, trainLength: train_length, testLength: test_length,
//                          step, anchored, topK: top_k } }             (null fields omitted)
//   markets           <- r.config.markets
//   seed              <- r.seed
//   trialCount        <- len(r.trials)
//   stopReason        <- r.stop_reason
//   trials[]          <- r.trials: { index, params, score, status, fold?, reason?,
//                          metrics?: objective_values keyed by objective metric }
//                        (at most 5000; a subset is allowed, trialCount keeps the total)
//   best              <- r.best: { trialIndex: index, params, score, metrics: objective values } or null
//   paretoFront[]     <- r.pareto_front indices: { trialIndex, params, values: objective values }
//   oos (is_oos)      <- r.validation: { mode, inSample: in_sample, outOfSample: out_of_sample,
//                          selected, topK: top_k, reason }; each report { trialIndex: trial_index, params,
//                          inSampleScore: in_sample_score, score, degradation, status, reason?, window? }
//   oos (walk_forward)<- r.validation: { mode, stitchedScore: stitched_score, stitchedMetrics: stitched,
//                          droppedMarkets: stitched_dropped_markets, reason }
//   folds[]           <- r.validation.folds: { index, train, test, seed, stopReason: stop_reason,
//                          trialCount: len(trial_indices), bestTrialIndex: best_trial_index, params,
//                          oos: out_of_sample report, diagnostics }
//   marketRanking[]   <- r.market_ranking (market_only): { rank, market, status, value, reason? }
//   diagnostics       <- r.diagnostics: { deflatedSharpe: deflated_sharpe (camelCase fields),
//                          deflatedSharpeReason, pbo: pbo without logits (camelCase fields), pboReason }
// Windows are { start, end } bar indices (labels dropped). Non-finite values are not accepted.

export const OPTIMIZATION_METHOD_VALUES = [
  "grid",
  "random",
  "tpe",
  "evolution",
  "pareto",
  "market_only",
] as const;
export const OPTIMIZATION_VALIDATION_MODE_VALUES = [
  "single",
  "is_oos",
  "walk_forward",
] as const;
export const OPTIMIZATION_STOP_REASON_VALUES = [
  "completed",
  "budget",
  "time_budget",
  "exhausted",
] as const;
export const OPTIMIZATION_DIRECTION_VALUES = ["maximize", "minimize"] as const;
export const OPTIMIZATION_TRIAL_STATUS_VALUES = ["ok", "failed"] as const;
export const OPTIMIZATION_LIST_MAX = 200;
export const OPTIMIZATION_TRIALS_LIMIT = 5000;
export const OPTIMIZATION_PARETO_LIMIT = 500;
export const OPTIMIZATION_FOLDS_LIMIT = 100;
export const OPTIMIZATION_MARKETS_LIMIT = 40;

export const OptimizationMethodSchema = z.enum(OPTIMIZATION_METHOD_VALUES);
export const OptimizationValidationModeSchema = z.enum(
  OPTIMIZATION_VALIDATION_MODE_VALUES
);
export const OptimizationStopReasonSchema = z.enum(
  OPTIMIZATION_STOP_REASON_VALUES
);
export const OptimizationDirectionSchema = z.enum(
  OPTIMIZATION_DIRECTION_VALUES
);
const TrialStatusSchema = z.enum(OPTIMIZATION_TRIAL_STATUS_VALUES);

const IdSchema = z.string().trim().min(1).max(128);
const finite = z.number().finite();
const index = z.number().int().min(0);
const reason = z.string().max(300);
const ParamsSchema = z.record(
  z.string().max(64),
  z.union([finite, z.boolean(), z.string().max(200), z.null()])
);
const MetricsSchema = z.record(z.string().max(64), finite);
const WindowSchema = z.object({ start: index, end: index }).strict();

const OosReportSchema = z
  .object({
    trialIndex: index,
    params: ParamsSchema,
    inSampleScore: finite.nullable(),
    score: finite.nullable(),
    degradation: finite.nullable(),
    status: TrialStatusSchema,
    reason: reason.nullable().optional(),
    window: WindowSchema.nullable().optional(),
  })
  .strict();

const DiagnosticsSchema = z
  .object({
    deflatedSharpe: z
      .object({
        sharpe: finite,
        nTrials: z.number().int(),
        sharpeVariance: finite,
        nObservations: z.number().int(),
        skew: finite,
        kurtosis: finite,
        expectedMaxSharpe: finite,
        z: finite,
        probability: finite,
      })
      .strict()
      .nullable(),
    deflatedSharpeReason: reason.nullable(),
    pbo: z
      .object({
        pbo: finite,
        nTrials: z.number().int(),
        nPeriodsUsed: z.number().int(),
        nPartitions: z.number().int(),
        nCombinations: z.number().int(),
        metric: z.enum(["sharpe", "mean"]),
      })
      .strict()
      .nullable(),
    pboReason: reason.nullable(),
  })
  .strict();

const TrialSchema = z
  .object({
    index,
    params: ParamsSchema,
    score: finite.nullable(),
    status: TrialStatusSchema,
    metrics: MetricsSchema.nullable().optional(),
    fold: index.nullable().optional(),
    reason: reason.nullable().optional(),
  })
  .strict();

const FoldSchema = z
  .object({
    index,
    train: WindowSchema,
    test: WindowSchema,
    seed: z.number().int().nullable().optional(),
    stopReason: OptimizationStopReasonSchema,
    trialCount: index,
    bestTrialIndex: index.nullable(),
    params: ParamsSchema.nullable(),
    oos: OosReportSchema.nullable(),
    diagnostics: DiagnosticsSchema.nullable().optional(),
  })
  .strict();

const OosSchema = z
  .object({
    mode: z.enum(["is_oos", "walk_forward"]),
    inSample: WindowSchema.nullable().optional(),
    outOfSample: WindowSchema.nullable().optional(),
    selected: OosReportSchema.nullable().optional(),
    topK: z.array(OosReportSchema).max(50).optional(),
    stitchedScore: finite.nullable().optional(),
    stitchedMetrics: z
      .record(z.string().max(64), MetricsSchema)
      .nullable()
      .optional(),
    droppedMarkets: z
      .array(z.string().max(64))
      .max(OPTIMIZATION_MARKETS_LIMIT)
      .nullable()
      .optional(),
    reason: reason.nullable().optional(),
  })
  .strict();

const MarketRankSchema = z
  .object({
    rank: z.number().int().min(1).nullable(),
    market: z.string().max(64),
    status: TrialStatusSchema,
    value: finite.nullable(),
    reason: reason.nullable().optional(),
  })
  .strict();

export const OptimizationRecordInputSchema = z
  .object({
    taskId: IdSchema,
    strategyId: IdSchema.nullable().optional(),
    method: OptimizationMethodSchema,
    objectives: z
      .array(
        z
          .object({
            metric: z.string().trim().min(1).max(64),
            direction: OptimizationDirectionSchema,
          })
          .strict()
      )
      .min(1)
      .max(8),
    validation: z
      .object({
        mode: OptimizationValidationModeSchema,
        params: z
          .object({
            nObservations: z.number().int().positive().nullable().optional(),
            isFraction: finite.nullable().optional(),
            trainLength: z.number().int().positive().nullable().optional(),
            testLength: z.number().int().positive().nullable().optional(),
            step: z.number().int().positive().nullable().optional(),
            anchored: z.boolean().nullable().optional(),
            topK: z.number().int().positive().nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    markets: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(OPTIMIZATION_MARKETS_LIMIT),
    seed: z.number().int().nullable().optional(),
    trialCount: z.number().int().min(0).max(1_000_000),
    stopReason: OptimizationStopReasonSchema,
    best: z
      .object({
        trialIndex: index.nullable(),
        params: ParamsSchema,
        score: finite.nullable(),
        metrics: MetricsSchema,
      })
      .strict()
      .nullable()
      .optional(),
    paretoFront: z
      .array(
        z
          .object({
            trialIndex: index,
            params: ParamsSchema,
            values: MetricsSchema,
          })
          .strict()
      )
      .max(OPTIMIZATION_PARETO_LIMIT)
      .optional(),
    trials: z.array(TrialSchema).max(OPTIMIZATION_TRIALS_LIMIT).optional(),
    folds: z.array(FoldSchema).max(OPTIMIZATION_FOLDS_LIMIT).optional(),
    marketRanking: z
      .array(MarketRankSchema)
      .max(OPTIMIZATION_MARKETS_LIMIT)
      .optional(),
    oos: OosSchema.nullable().optional(),
    diagnostics: DiagnosticsSchema.nullable().optional(),
    notes: z.union([z.string().max(4000), z.null()]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Outputs

const ParamsOutputSchema = z.record(
  z.string(),
  z.union([z.number(), z.boolean(), z.string(), z.null()])
);
const MetricsOutputSchema = z.record(z.string(), z.number());
const WindowOutputSchema = z.object({ start: z.number(), end: z.number() });
const OosReportOutputSchema = z.object({
  trialIndex: z.number().int(),
  params: ParamsOutputSchema,
  inSampleScore: z.number().nullable(),
  score: z.number().nullable(),
  degradation: z.number().nullable(),
  status: TrialStatusSchema,
  reason: z.string().optional(),
  window: WindowOutputSchema.optional(),
});
const DiagnosticsOutputSchema = DiagnosticsSchema;

const OptimizationSummaryFields = {
  id: z.string().min(1),
  taskId: z.string().min(1),
  strategyId: z.string().nullable(),
  strategyName: z.string().nullable(),
  method: OptimizationMethodSchema,
  objectives: z.array(
    z.object({ metric: z.string(), direction: OptimizationDirectionSchema })
  ),
  validation: z.object({
    mode: OptimizationValidationModeSchema,
    params: z.object({
      nObservations: z.number().optional(),
      isFraction: z.number().optional(),
      trainLength: z.number().optional(),
      testLength: z.number().optional(),
      step: z.number().optional(),
      anchored: z.boolean().optional(),
      topK: z.number().optional(),
    }),
  }),
  markets: z.array(z.string()),
  seed: z.number().int().nullable(),
  trialCount: z.number().int().nonnegative(),
  stopReason: OptimizationStopReasonSchema,
  best: z
    .object({
      trialIndex: z.number().int().nullable(),
      params: ParamsOutputSchema,
      score: z.number().nullable(),
      metrics: MetricsOutputSchema,
    })
    .nullable(),
  diagnostics: DiagnosticsOutputSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
};

export const OptimizationSummarySchema = z.object({
  ...OptimizationSummaryFields,
  storedTrialCount: z.number().int().nonnegative(),
  foldCount: z.number().int().nonnegative(),
  paretoCount: z.number().int().nonnegative(),
  taskTitle: z.string().nullable(),
});

// Server-derived analytics (see optimization-analytics.ts). Deterministic for one stored run.
const ProfileBinSchema = z.object({
  low: z.number(),
  high: z.number(),
  count: z.number().int().nonnegative(),
  meanScore: z.number().nullable(),
  bestScore: z.number().nullable(),
});

export const OptimizationAnalyticsSchema = z.object({
  version: z.string(),
  direction: OptimizationDirectionSchema,
  scoreSource: z.string(),
  trials: z.object({
    stored: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(),
  }),
  importance: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["numeric", "categorical"]),
      groups: z.number().int().nonnegative(),
      variance: z.number(),
      importance: z.number(),
    })
  ),
  profiles: z.array(
    z.object({
      name: z.string(),
      binned: z.boolean(),
      bins: z.array(ProfileBinSchema),
    })
  ),
  heatmap: z
    .object({
      x: z.string(),
      y: z.string(),
      xBins: z.array(z.object({ low: z.number(), high: z.number() })),
      yBins: z.array(z.object({ low: z.number(), high: z.number() })),
      // cells[row][column]: row indexes yBins, column indexes xBins.
      meanScores: z.array(z.array(z.number().nullable())),
      counts: z.array(z.array(z.number().int().nonnegative())),
      filledCells: z.number().int().nonnegative(),
    })
    .nullable(),
});

export const OptimizationRunSchema = z.object({
  ...OptimizationSummaryFields,
  trials: z.array(
    z.object({
      index: z.number().int(),
      params: ParamsOutputSchema,
      score: z.number().nullable(),
      status: TrialStatusSchema,
      metrics: MetricsOutputSchema.optional(),
      fold: z.number().int().optional(),
      reason: z.string().optional(),
    })
  ),
  paretoFront: z.array(
    z.object({
      trialIndex: z.number().int(),
      params: ParamsOutputSchema,
      values: MetricsOutputSchema,
    })
  ),
  folds: z.array(
    z.object({
      index: z.number().int(),
      train: WindowOutputSchema,
      test: WindowOutputSchema,
      seed: z.number().int().optional(),
      stopReason: OptimizationStopReasonSchema,
      trialCount: z.number().int(),
      bestTrialIndex: z.number().int().nullable(),
      params: ParamsOutputSchema.nullable(),
      oos: OosReportOutputSchema.nullable(),
      diagnostics: DiagnosticsOutputSchema.optional(),
    })
  ),
  marketRanking: z.array(
    z.object({
      rank: z.number().int().nullable(),
      market: z.string(),
      status: TrialStatusSchema,
      value: z.number().nullable(),
      reason: z.string().optional(),
    })
  ),
  oos: z
    .object({
      mode: z.enum(["is_oos", "walk_forward"]),
      inSample: WindowOutputSchema.optional(),
      outOfSample: WindowOutputSchema.optional(),
      selected: OosReportOutputSchema.nullable().optional(),
      topK: z.array(OosReportOutputSchema).optional(),
      stitchedScore: z.number().nullable().optional(),
      stitchedMetrics: z.record(z.string(), MetricsOutputSchema).optional(),
      droppedMarkets: z.array(z.string()).optional(),
      reason: z.string().nullable().optional(),
    })
    .nullable(),
  analytics: OptimizationAnalyticsSchema,
});

export const OptimizationListInputSchema = z
  .object({
    taskId: IdSchema.optional(),
    strategyId: IdSchema.optional(),
    limit: z.number().int().min(1).max(OPTIMIZATION_LIST_MAX).optional(),
  })
  .strict();
export const OptimizationListOutputSchema = z.object({
  optimizations: z.array(OptimizationSummarySchema),
});
export const OptimizationGetInputSchema = z.object({ id: IdSchema }).strict();
export const OptimizationGetOutputSchema = z.object({
  optimization: OptimizationRunSchema,
  task: AgentTaskSchema.nullable(),
});

const optimizations = oc.errors(AGENT_OPS_API_ERRORS);

const record = optimizations
  .route({
    method: "POST",
    path: "/agent-ops/optimizations",
    operationId: "agentOps.optimizations.record",
    summary: "Record an agent-reported optimizer run for a task",
    tags: ["Agent operations"],
  })
  .input(OptimizationRecordInputSchema)
  .output(OptimizationRunSchema);

const list = optimizations
  .route({
    method: "GET",
    path: "/agent-ops/optimizations",
    operationId: "agentOps.optimizations.list",
    summary: "List optimizer runs without trials, folds or the Pareto front",
    tags: ["Agent operations"],
  })
  .input(OptimizationListInputSchema)
  .output(OptimizationListOutputSchema);

const get = optimizations
  .route({
    method: "GET",
    path: "/agent-ops/optimizations/{id}",
    operationId: "agentOps.optimizations.get",
    summary:
      "Read one optimizer run with trials, folds and server-derived importance and profiles",
    tags: ["Agent operations"],
  })
  .input(OptimizationGetInputSchema)
  .output(OptimizationGetOutputSchema);

export const optimizationsContract = { record, list, get };

export type OptimizationMethodValue = z.infer<typeof OptimizationMethodSchema>;
export type OptimizationValidationModeValue = z.infer<
  typeof OptimizationValidationModeSchema
>;
export type OptimizationRecordInput = z.input<
  typeof OptimizationRecordInputSchema
>;
export type OptimizationRunOutput = z.infer<typeof OptimizationRunSchema>;
export type OptimizationSummaryOutput = z.infer<
  typeof OptimizationSummarySchema
>;
export type OptimizationAnalyticsOutput = z.infer<
  typeof OptimizationAnalyticsSchema
>;
export type OptimizationListInput = z.input<typeof OptimizationListInputSchema>;
export type OptimizationGetOutput = z.infer<typeof OptimizationGetOutputSchema>;
