import type { BacktestRunComparisonRecord } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  DEFAULT_HOST_LABEL,
  type EngineComparisonRun,
  EngineComparisonSpecSchema,
  EngineDifferencesSchema,
  EngineRunSchema,
} from "../contracts/engine-comparison.ts";
import {
  type ComparisonQueue,
  createComparisonQueue,
} from "../engine-comparison.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Engine comparison per request (the queue, ../engine-comparison.ts) and the list procedure
// (backtestRuns.comparisons.list). With VERTEX_ENGINE_COMPARISON on, the instant backtest, the
// sweep and the Autopilot gate hand their TypeScript results to the queue. A queue failure never
// changes the TypeScript answer. Research only.

/**
 * The comparison queue of a request, or null when the setting is off, run storage is missing or
 * the caller may not write (a read-access agent key or a read-only viewer: backtestRuns.sweep is
 * a read procedure, and queueing runs is a write). `requestedBy` is the caller's user id.
 * `agentViewerMayQueue` lets a read-only agent viewer queue too (Academy backtests only, owner
 * decision 2026-11-10); a read-access agent key still may not.
 */
export const comparisonQueueFor = (
  context: ApiContext,
  requestedBy: string,
  options: Readonly<{ agentViewerMayQueue?: boolean }> = {}
): ComparisonQueue | null => {
  const runs = context.repositories.backtestRuns;
  const mayQueue =
    context.callerCanWrite === true ||
    (options.agentViewerMayQueue === true &&
      context.callerIsAgentViewer === true);
  if (context.engineComparison !== "on" || runs === undefined || !mayQueue)
    return null;
  return createComparisonQueue(
    runs,
    context.hostLabel ?? DEFAULT_HOST_LABEL,
    requestedBy
  );
};

/** The list view of a stored comparison run; null when its comparison part is not readable. */
const toComparisonRun = (
  record: BacktestRunComparisonRecord
): EngineComparisonRun | null => {
  const comparison = EngineComparisonSpecSchema.safeParse(
    record.spec.comparison
  );
  if (!comparison.success) return null;
  const engineRun = EngineRunSchema.safeParse(record.engineRun);
  const differences = EngineDifferencesSchema.safeParse(record.differences);
  return {
    comparison: comparison.data,
    createdAt: record.createdAt,
    differences: differences.success ? differences.data : null,
    engineRun: engineRun.success ? engineRun.data : null,
    engineVersion: record.engineVersion,
    error: record.error,
    finishedAt: record.finishedAt,
    from: record.spec.from,
    id: record.id,
    queueWaitMs:
      record.startedAt === null
        ? null
        : record.startedAt.getTime() - record.createdAt.getTime(),
    startedAt: record.startedAt,
    status: record.status,
    symbol: record.spec.symbol,
    timeframe: record.spec.timeframe,
    to: record.spec.to,
  };
};

type Failures = Readonly<{ STORAGE_ERROR: () => Error }>;

const api = implement(appContract).$context<ApiContext>();

const list = api.backtestRuns.comparisons.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const runs = context.repositories.backtestRuns;
    if (runs === undefined)
      throw (errors as unknown as Failures).STORAGE_ERROR();
    const records = await runs.listComparisons({
      limit: input.limit,
      ...(input.feature === undefined ? {} : { feature: input.feature }),
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    });
    return {
      runs: records.flatMap((record) => {
        const run = toComparisonRun(record);
        return run === null ? [] : [run];
      }),
    };
  });

export const engineComparisonsRouter = { list };
