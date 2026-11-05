import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  type BacktestRunSpec,
  type BacktestRunStatus,
  type BacktestRunStrategySnapshot,
  backtestRuns,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Backtest runs started from the portal or MCP. The repository exposes only these transitions:
// create (queued), claim and claimNext (queued -> running), complete (running -> succeeded), fail
// (queued or running -> failed). The spec and strategy revision columns are written once by create
// and no method updates them, so a stored run stays tied to the revision it ran against.

export const BACKTEST_RUNS_LIST_MAX = 100;
export const BACKTEST_RUN_ERROR_MAX_LENGTH = 500;
/** Candidates claimNext tries when other workers win the race for the oldest run. */
export const BACKTEST_RUN_CLAIM_ATTEMPTS = 5;

export type BacktestRunRecord = Readonly<{
  id: string;
  status: BacktestRunStatus;
  strategyId: string | null;
  strategyRevision: string | null;
  strategySnapshot: BacktestRunStrategySnapshot | null;
  spec: BacktestRunSpec;
  engineVersion: string;
  requestedBy: string;
  error: string | null;
  report: Record<string, unknown> | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}>;

export type BacktestRunSummaryRecord = Omit<BacktestRunRecord, "report">;

export type BacktestRunCreateInput = Readonly<{
  strategyId: string | null;
  strategyRevision: string | null;
  strategySnapshot: BacktestRunStrategySnapshot | null;
  spec: BacktestRunSpec;
  engineVersion: string;
  requestedBy: string;
}>;

export type BacktestRunsRepository = Readonly<{
  create: (input: BacktestRunCreateInput) => Promise<BacktestRunRecord>;
  get: (id: string) => Promise<BacktestRunRecord | null>;
  list: (
    filter: Readonly<{ strategyId?: string; limit: number }>
  ) => Promise<BacktestRunSummaryRecord[]>;
  /** Moves a queued run to running. Returns null when another caller already claimed it. */
  claim: (id: string) => Promise<BacktestRunRecord | null>;
  /**
   * Moves the oldest queued run of the engine version to running. Returns null when no queued run
   * is left. The update is conditional, so two workers never claim the same run.
   */
  claimNext: (engineVersion: string) => Promise<BacktestRunRecord | null>;
  complete: (
    id: string,
    report: Record<string, unknown>
  ) => Promise<BacktestRunRecord | null>;
  fail: (id: string, error: string) => Promise<BacktestRunRecord | null>;
  /** Fails one run when it is running and started before `startedBefore`. */
  failIfStale: (
    id: string,
    startedBefore: Date,
    error: string
  ) => Promise<boolean>;
  /**
   * Fails one run when it is still queued, was created before `before`, and no run of
   * `engineVersion` was claimed since `before` (no worker took any run in that time). A busy
   * worker therefore never fails the runs waiting behind it.
   */
  failIfUnclaimed: (
    id: string,
    engineVersion: string,
    before: Date,
    error: string
  ) => Promise<boolean>;
}>;

const summaryColumns = {
  id: backtestRuns.id,
  status: backtestRuns.status,
  strategyId: backtestRuns.strategyId,
  strategyRevision: backtestRuns.strategyRevision,
  strategySnapshot: backtestRuns.strategySnapshot,
  spec: backtestRuns.spec,
  engineVersion: backtestRuns.engineVersion,
  requestedBy: backtestRuns.requestedBy,
  error: backtestRuns.error,
  createdAt: backtestRuns.createdAt,
  startedAt: backtestRuns.startedAt,
  finishedAt: backtestRuns.finishedAt,
};

/** Trims an error message to the stored maximum. Never empty. */
export const boundBacktestRunError = (error: string): string => {
  const trimmed = error.trim();
  const text = trimmed === "" ? "Backtest failed" : trimmed;
  return text.slice(0, BACKTEST_RUN_ERROR_MAX_LENGTH);
};

export const createBacktestRunsRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{
    now: () => Date;
    generateId: () => string;
  }>
): BacktestRunsRepository => ({
  create: async (input) => {
    const [row] = await database
      .insert(backtestRuns)
      .values({
        id: dependencies.generateId(),
        status: "queued",
        strategyId: input.strategyId,
        strategyRevision: input.strategyRevision,
        strategySnapshot: input.strategySnapshot,
        spec: input.spec,
        engineVersion: input.engineVersion,
        requestedBy: input.requestedBy,
        createdAt: dependencies.now(),
      })
      .returning();
    return row as BacktestRunRecord;
  },
  get: async (id) => {
    const [row] = await database
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.id, id))
      .limit(1);
    return (row as BacktestRunRecord | undefined) ?? null;
  },
  list: async (filter) =>
    (await database
      .select(summaryColumns)
      .from(backtestRuns)
      .where(
        filter.strategyId === undefined
          ? undefined
          : eq(backtestRuns.strategyId, filter.strategyId)
      )
      .orderBy(desc(backtestRuns.createdAt))
      .limit(
        Math.min(Math.max(filter.limit, 1), BACKTEST_RUNS_LIST_MAX)
      )) as BacktestRunSummaryRecord[],
  claim: async (id) => {
    const [row] = await database
      .update(backtestRuns)
      .set({ status: "running", startedAt: dependencies.now() })
      .where(and(eq(backtestRuns.id, id), eq(backtestRuns.status, "queued")))
      .returning();
    return (row as BacktestRunRecord | undefined) ?? null;
  },
  claimNext: async (engineVersion) => {
    // Same conditional update as claim: when another worker claims the candidate first, the
    // update returns no row and the next oldest queued run is tried.
    for (let attempt = 0; attempt < BACKTEST_RUN_CLAIM_ATTEMPTS; attempt += 1) {
      const [candidate] = (await database
        .select({ id: backtestRuns.id })
        .from(backtestRuns)
        .where(
          and(
            eq(backtestRuns.status, "queued"),
            eq(backtestRuns.engineVersion, engineVersion)
          )
        )
        .orderBy(asc(backtestRuns.createdAt), asc(backtestRuns.id))
        .limit(1)) as { id: string }[];
      if (candidate === undefined) return null;
      const [row] = await database
        .update(backtestRuns)
        .set({ status: "running", startedAt: dependencies.now() })
        .where(
          and(
            eq(backtestRuns.id, candidate.id),
            eq(backtestRuns.status, "queued"),
            eq(backtestRuns.engineVersion, engineVersion)
          )
        )
        .returning();
      if (row !== undefined) return row as BacktestRunRecord;
    }
    return null;
  },
  complete: async (id, report) => {
    const [row] = await database
      .update(backtestRuns)
      .set({ status: "succeeded", report, finishedAt: dependencies.now() })
      .where(and(eq(backtestRuns.id, id), eq(backtestRuns.status, "running")))
      .returning();
    return (row as BacktestRunRecord | undefined) ?? null;
  },
  fail: async (id, error) => {
    const [row] = await database
      .update(backtestRuns)
      .set({
        status: "failed",
        error: boundBacktestRunError(error),
        finishedAt: dependencies.now(),
      })
      .where(
        and(
          eq(backtestRuns.id, id),
          // Terminal runs are never rewritten.
          inArray(backtestRuns.status, ["queued", "running"])
        )
      )
      .returning();
    return (row as BacktestRunRecord | undefined) ?? null;
  },
  failIfStale: async (id, startedBefore, error) => {
    const rows = await database
      .update(backtestRuns)
      .set({
        status: "failed",
        error: boundBacktestRunError(error),
        finishedAt: dependencies.now(),
      })
      .where(
        and(
          eq(backtestRuns.id, id),
          eq(backtestRuns.status, "running"),
          lt(backtestRuns.startedAt, startedBefore)
        )
      )
      .returning({ id: backtestRuns.id });
    return rows.length > 0;
  },
  failIfUnclaimed: async (id, engineVersion, before, error) => {
    const rows = await database
      .update(backtestRuns)
      .set({
        status: "failed",
        error: boundBacktestRunError(error),
        finishedAt: dependencies.now(),
      })
      .where(
        and(
          eq(backtestRuns.id, id),
          eq(backtestRuns.status, "queued"),
          lt(backtestRuns.createdAt, before),
          // The subquery's own backtest_runs shadows the updated row in its where clause.
          sql`not exists (select 1 from ${backtestRuns} where ${backtestRuns.engineVersion} = ${engineVersion} and ${backtestRuns.startedAt} >= ${before})`
        )
      )
      .returning({ id: backtestRuns.id });
    return rows.length > 0;
  },
});
