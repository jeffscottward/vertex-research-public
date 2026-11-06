import { oc } from "@orpc/contract";
import { z } from "zod";

// Engine comparison (dual run, owner decision 2026-11-05): with VERTEX_ENGINE_COMPARISON=on the
// instant backtest, the parameter sweep and the Autopilot gate keep their TypeScript result and
// also queue the same run(s) as Nautilus backtest runs for the research worker on the rig. Each
// such run stores `spec.comparison`: the feature, a group per request (or campaign), a label, and
// the TypeScript result it repeats. When the worker completes the run, the API stores where and
// how long it ran (`report.engineRun`) and the differences to the TypeScript result
// (`report.differences`). Research only; no order path.

export const ENGINE_COMPARISON_FEATURES = [
  "instant",
  "sweep",
  "autopilotGate",
] as const;
/** Sweep cells repeated on Nautilus per sweep; the UI states the cap. */
export const ENGINE_COMPARISON_SWEEP_CELLS_MAX = 100;
/** Autopilot gate runs repeated on Nautilus per campaign tick. */
export const ENGINE_COMPARISON_GATE_RUNS_MAX = 20;
/** TypeScript trades kept per comparison run (entry bar, exit bar, exit reason). */
export const ENGINE_COMPARISON_TRADES_MAX = 5000;
export const ENGINE_COMPARISON_LIST_MAX = 500;
/** VERTEX_HOST_LABEL default. */
export const DEFAULT_HOST_LABEL = "web server";
/** wallNote when the runtime clock did not move during the engine call. */
export const TIMER_FROZEN_NOTE = "timer frozen in Worker runtime";
/** Recorded GPU use: the Nautilus engine runs on the CPU only. */
export const NAUTILUS_GPU_NOTE = "not used (Nautilus engine is CPU-only)";
/** Parity tolerances (docs/vertex-rebuild/nautilus-backtest-engine.md#parity-tolerances). */
export const ENGINE_COMPARISON_TOLERANCES = Object.freeze({
  maxDrawdown: 1e-5,
  sharpe: 1e-3,
  totalReturn: 1e-5,
});

const nullableNumber = z.number().nullable();

/** The InstantStats fields of the TypeScript result. */
export const EngineComparisonStatsSchema = z.object({
  bars: z.number().int(),
  buyHoldMaxDrawdown: z.number(),
  buyHoldReturn: z.number(),
  cagr: nullableNumber,
  exposure: z.number(),
  maxDrawdown: z.number(),
  profitFactor: nullableNumber,
  sharpe: nullableNumber,
  sortino: nullableNumber,
  totalReturn: z.number(),
  trades: z.number().int(),
  winRate: nullableNumber,
});

export const ENGINE_EXIT_REASONS = ["signal", "stop", "target", "end"] as const;

/** One trade as [entry bar, exit bar, exit reason]. */
export const EngineComparisonTradeSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.enum(ENGINE_EXIT_REASONS),
]);

export const EngineComparisonSpecSchema = z.object({
  /** Runs of the same request (or campaign) that were not queued because of the cap. */
  dropped: z.number().int().nonnegative().optional(),
  feature: z.enum(ENGINE_COMPARISON_FEATURES),
  groupId: z.string().min(1).max(128),
  /** Sweep: the cell index; Autopilot gate: the candidate id. */
  key: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(200),
  typescript: z.object({
    host: z.string().min(1).max(100),
    stats: EngineComparisonStatsSchema,
    tradeCount: z.number().int().nonnegative(),
    trades: z
      .array(EngineComparisonTradeSchema)
      .max(ENGINE_COMPARISON_TRADES_MAX),
    /** Server-side wall time of the engine call; null when the runtime clock did not move. */
    wallMs: z.number().nonnegative().nullable(),
    wallNote: z.string().max(200).optional(),
  }),
});

/** Where and how long the Nautilus engine ran (written by the research worker). */
export const EngineRunSchema = z
  .object({
    /** CPU time (user + system) of the engine process that ran this run. */
    cpuMs: z.number().nonnegative().nullable(),
    gpu: z.string().min(1).max(100),
    host: z.string().min(1).max(100),
    /** Runs in the engine process that ran this run. */
    processCases: z.number().int().positive(),
    /** Engine processes the worker used for the claimed batch. */
    processes: z.number().int().positive(),
    processWallMs: z.number().nonnegative().nullable(),
    /** Engine time of this run inside its process. */
    wallMs: z.number().nonnegative().nullable(),
  })
  .strict();

export const EngineDifferencesSchema = z.object({
  items: z.array(
    z.object({
      detail: z.string(),
      field: z.string(),
      nautilus: z.union([z.number(), z.string()]).nullable(),
      typescript: z.union([z.number(), z.string()]).nullable(),
    })
  ),
  ok: z.boolean(),
});

/** The engine timing and the comparison group of a TypeScript result that was also queued. */
export const EngineComparisonTimingSchema = z.object({
  /** Set when the Nautilus runs could not be queued; the TypeScript result is still valid. */
  error: z.string().optional(),
  groupId: z.string().nullable(),
  host: z.string(),
  wallMs: z.number().nonnegative().nullable(),
  wallNote: z.string().optional(),
});

export const EngineComparisonListInputSchema = z
  .object({
    feature: z.enum(ENGINE_COMPARISON_FEATURES).optional(),
    groupId: z.string().trim().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(ENGINE_COMPARISON_LIST_MAX).default(100),
  })
  .strict();

export const EngineComparisonRunSchema = z.object({
  comparison: EngineComparisonSpecSchema,
  createdAt: z.date(),
  differences: EngineDifferencesSchema.nullable(),
  engineRun: EngineRunSchema.nullable(),
  engineVersion: z.string(),
  error: z.string().nullable(),
  finishedAt: z.date().nullable(),
  from: z.string(),
  id: z.string(),
  /** startedAt - createdAt; null while queued. */
  queueWaitMs: z.number().nullable(),
  startedAt: z.date().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  symbol: z.string(),
  timeframe: z.string(),
  to: z.string(),
});

export const EngineComparisonListOutputSchema = z.object({
  runs: z.array(EngineComparisonRunSchema).max(ENGINE_COMPARISON_LIST_MAX),
});

export const ENGINE_COMPARISON_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Backtest storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const list = oc
  .errors(ENGINE_COMPARISON_ERRORS)
  .route({
    method: "GET",
    operationId: "backtestRuns.comparisons.list",
    path: "/backtest-runs/comparisons",
    summary:
      "List engine comparison runs (Nautilus repeats of TypeScript results) with timing and differences",
    tags: ["Backtest runs"],
  })
  .input(EngineComparisonListInputSchema)
  .output(EngineComparisonListOutputSchema);

export const engineComparisonsContract = { list };

export type EngineComparisonFeature =
  (typeof ENGINE_COMPARISON_FEATURES)[number];
export type EngineComparisonSpec = z.infer<typeof EngineComparisonSpecSchema>;
export type EngineComparisonTrade = z.infer<typeof EngineComparisonTradeSchema>;
export type EngineRun = z.infer<typeof EngineRunSchema>;
export type EngineDifferences = z.infer<typeof EngineDifferencesSchema>;
export type EngineComparisonTiming = z.infer<
  typeof EngineComparisonTimingSchema
>;
export type EngineComparisonRun = z.infer<typeof EngineComparisonRunSchema>;
export type EngineComparisonListOutput = z.infer<
  typeof EngineComparisonListOutputSchema
>;
export type EngineComparisonListInput = z.input<
  typeof EngineComparisonListInputSchema
>;
