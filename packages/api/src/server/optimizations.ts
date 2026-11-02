import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type AgentOpsRepository,
  type OptimizationRunDetail,
  type OptimizationRunSummary,
  type OptimizationRunsRepository,
} from "@darkfactory/db/server";
import type { AgentTask } from "@darkfactory/db/schema";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  OptimizationRunOutput,
  OptimizationSummaryOutput,
} from "../contracts/optimizations.ts";
import { computeOptimizationAnalytics } from "../optimization-analytics.ts";
import { toAgentTaskOutput } from "./agent-ops.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Agent-recorded optimizer runs (agentOps.optimizations.*). Every procedure uses requireOperator; agent
// keys reach it through the agentOps scope, and read keys may call only list and get. The repository
// owns all shape, bound and cross-field validation; this module maps rows and derives analytics on get.

const api = implement(appContract).$context<ApiContext>();

type OptimizationErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";
type OptimizationErrorFactories = Readonly<
  Record<OptimizationErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): OptimizationErrorFactories => {
  return errors as OptimizationErrorFactories;
};

const runsFor = (
  context: ApiContext,
  errors: unknown
): OptimizationRunsRepository => {
  const repository = context.repositories.optimizationRuns;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const tasksFor = (context: ApiContext, errors: unknown): AgentOpsRepository => {
  const repository = context.repositories.agentOps;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapOptimizationError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({
      message: error.message.replace(/^Invalid repository input: /u, ""),
    });
  }
  if (error instanceof DatabaseConflictError) throw failures.CONFLICT();
  if (error instanceof DatabasePersistenceError) {
    throw failures.STORAGE_ERROR({
      message:
        "Optimization storage unavailable. Apply migration 0020 if the table is missing.",
    });
  }
  throw error;
};

const summaryFields = (
  row: OptimizationRunSummary | OptimizationRunDetail
) => ({
  id: row.id,
  taskId: row.taskId,
  strategyId: row.strategyId ?? null,
  strategyName: row.strategyName ?? null,
  method: row.method,
  objectives: row.objectives.map((objective) => ({ ...objective })),
  validation: {
    mode: row.validation.mode,
    params: { ...row.validation.params },
  },
  markets: [...row.markets],
  seed: row.seed ?? null,
  trialCount: row.trialCount,
  stopReason: row.stopReason,
  best: row.best ?? null,
  diagnostics: row.diagnostics ?? null,
  notes: row.notes ?? null,
  createdAt: row.createdAt,
});

const toOptimizationSummaryOutput = (
  row: OptimizationRunSummary,
  taskTitle: string | null
): OptimizationSummaryOutput => ({
  ...summaryFields(row),
  storedTrialCount: Number(row.storedTrialCount),
  foldCount: Number(row.foldCount),
  paretoCount: Number(row.paretoCount),
  taskTitle,
});

const toOptimizationOutput = (
  row: OptimizationRunDetail
): OptimizationRunOutput => {
  const trials = row.trials ?? [];
  return {
    ...summaryFields(row),
    trials,
    paretoFront: row.paretoFront ?? [],
    folds: row.folds ?? [],
    marketRanking: row.marketRanking ?? [],
    oos: row.oos ?? null,
    analytics: computeOptimizationAnalytics({
      method: row.method,
      objectives: row.objectives,
      trials,
    }),
  };
};

// Resolves ledger task titles for summary rows (one list call plus at most 50 lookups).
const withTaskTitles = async (
  tasks: AgentOpsRepository,
  rows: readonly OptimizationRunSummary[]
): Promise<OptimizationSummaryOutput[]> => {
  if (rows.length === 0) return [];
  const titles = new Map<string, string | null>(
    (await tasks.listTasks({ kind: "optimization", limit: 200 })).map(
      (task) => [task.id, task.title]
    )
  );
  const missing = [
    ...new Set(rows.map((row) => row.taskId).filter((id) => !titles.has(id))),
  ];
  for (const id of missing.slice(0, 50)) {
    const found = await tasks.getTask(id);
    titles.set(id, found?.task.title ?? null);
  }
  return rows.map((row) =>
    toOptimizationSummaryOutput(row, titles.get(row.taskId) ?? null)
  );
};

const agentOpsOptimizationsRecord = api.agentOps.optimizations.record
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = runsFor(context, errors);
    try {
      const row = await repository.record({
        taskId: input.taskId,
        strategyId: input.strategyId ?? null,
        method: input.method,
        objectives: input.objectives,
        validation: input.validation,
        markets: input.markets,
        seed: input.seed ?? null,
        trialCount: input.trialCount,
        stopReason: input.stopReason,
        best: input.best ?? null,
        paretoFront: input.paretoFront ?? [],
        trials: input.trials ?? [],
        folds: input.folds ?? [],
        marketRanking: input.marketRanking ?? [],
        oos: input.oos ?? null,
        diagnostics: input.diagnostics ?? null,
        notes: input.notes ?? null,
      });
      return toOptimizationOutput(row);
    } catch (error) {
      return mapOptimizationError(error, errors);
    }
  });

const agentOpsOptimizationsList = api.agentOps.optimizations.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = runsFor(context, errors);
    const tasks = tasksFor(context, errors);
    try {
      const rows = await repository.list({
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.strategyId === undefined
          ? {}
          : { strategyId: input.strategyId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { optimizations: await withTaskTitles(tasks, rows) };
    } catch (error) {
      return mapOptimizationError(error, errors);
    }
  });

const agentOpsOptimizationsGet = api.agentOps.optimizations.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = runsFor(context, errors);
    let row: OptimizationRunDetail | null;
    let task: AgentTask | null = null;
    try {
      row = await repository.get(input.id);
      if (row !== null)
        task =
          (await tasksFor(context, errors).getTask(row.taskId))?.task ?? null;
    } catch (error) {
      return mapOptimizationError(error, errors);
    }
    if (row === null) throw factories(errors).NOT_FOUND();
    return {
      optimization: toOptimizationOutput(row),
      task: task === null ? null : toAgentTaskOutput(task),
    };
  });

export const optimizationsRouter = {
  record: agentOpsOptimizationsRecord,
  list: agentOpsOptimizationsList,
  get: agentOpsOptimizationsGet,
};
