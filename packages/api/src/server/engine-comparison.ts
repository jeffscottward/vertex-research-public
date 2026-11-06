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
 * The comparison queue of a request, or null when the setting is off or run storage is missing.
 * `requestedBy` is the caller's user id.
 */
export const comparisonQueueFor = (
  context: ApiContext,
  requestedBy: string
): ComparisonQueue | null => {
  const runs = context.repositories.backtestRuns;
  if (context.engineComparison !== "on" || runs === undefined) return null;
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
