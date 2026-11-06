import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notExists,
  sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import {
  type BacktestRunSpec,
  type BacktestRunStatus,
  type BacktestRunStrategySnapshot,
  backtestRuns,
} from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";

// Backtest runs started from the portal or MCP. The repository exposes only these transitions:
// create (queued), claim and claimNext (queued -> running), complete (running -> succeeded), fail
// (queued or running -> failed). The spec and strategy revision columns are written once by create
// and no method updates them, so a stored run stays tied to the revision it ran against.

export const BACKTEST_RUNS_LIST_MAX = 100;
export const BACKTEST_RUN_ERROR_MAX_LENGTH = 500;
/** Most runs one claimBatch returns. */
export const BACKTEST_RUN_BATCH_MAX = 50;
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

/** A comparison run with the parts of its report that the comparison view needs. */
export type BacktestRunComparisonRecord = BacktestRunSummaryRecord &
  Readonly<{
    engineRun: Record<string, unknown> | null;
    differences: Record<string, unknown> | null;
  }>;

const BACKTEST_RUN_COMPARISONS_LIST_MAX = 500;

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
  /**
   * Stores the queued runs of one comparison group, in one transaction under an advisory lock on
   * the group id:
   * - reuse (with `reuseSince`): when the group already has a run created since then that was
   *   not superseded, nothing is inserted (an identical request does not queue the same runs
   *   again);
   * - supersede: queued runs of the same engine, feature and requester in other groups fail with
   *   `supersededError` (one conditional update; running runs are never touched).
   */
  enqueueGroup: (
    input: Readonly<{
      groupId: string;
      runs: readonly BacktestRunCreateInput[];
      reuseSince?: Date;
      supersededError: string;
      supersede?: Readonly<{
        engineVersion: string;
        feature: string;
        requestedBy: string;
      }>;
    }>
  ) => Promise<
    Readonly<{ reused: boolean; created: number; superseded: number }>
  >;
  /** Newest first. Comparison runs (spec.comparison) are left out. */
  list: (
    filter: Readonly<{ strategyId?: string; limit: number }>
  ) => Promise<BacktestRunSummaryRecord[]>;
  /** Comparison runs, newest first, optionally of one feature or group. */
  listComparisons: (
    filter: Readonly<{ feature?: string; groupId?: string; limit: number }>
  ) => Promise<BacktestRunComparisonRecord[]>;
  /** Moves a queued run to running. Returns null when another caller already claimed it. */
  claim: (id: string) => Promise<BacktestRunRecord | null>;
  /**
   * Moves the oldest queued run of the engine version to running. Returns null when no queued run
   * is left. The update is conditional, so two workers never claim the same run.
   */
  claimNext: (engineVersion: string) => Promise<BacktestRunRecord | null>;
  /**
   * claimNext, then up to `max - 1` more queued runs of the same engine and comparison group
   * (oldest first) when the first run belongs to a group. Conditional updates: a run goes to one
   * caller only. Empty when no queued run is left.
   */
  claimBatch: (
    engineVersion: string,
    max: number
  ) => Promise<BacktestRunRecord[]>;
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

/** The comparison group of a spec (spec.comparison.groupId), or null. */
const comparisonGroup = sql<
  string | null
>`${backtestRuns.spec}->'comparison'->>'groupId'`;

/** Queued runs of one comparison group in the claimBatch subquery. */
const groupRuns = alias(backtestRuns, "grouped");

/** Oldest first, then by id (the claim order). */
const byAge = (left: BacktestRunRecord, right: BacktestRunRecord): number =>
  left.createdAt.getTime() - right.createdAt.getTime() ||
  left.id.localeCompare(right.id);

/** Other runs of the engine in the failIfUnclaimed subquery (an alias, not the updated row). */
const activeRuns = alias(backtestRuns, "active");

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
): BacktestRunsRepository => {
  const repository: BacktestRunsRepository = {
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
    enqueueGroup: async (input) =>
      await withTransaction(database, async (transaction) => {
        // Two identical requests at once: the second waits here and then reuses the group.
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.groupId}, 0))`
        );
        const { reuseSince } = input;
        const [live] =
          reuseSince === undefined
            ? []
            : await transaction
                .select({ id: backtestRuns.id })
                .from(backtestRuns)
                .where(
                  and(
                    eq(comparisonGroup, input.groupId),
                    gte(backtestRuns.createdAt, reuseSince),
                    sql`not (${backtestRuns.status} = 'failed' and ${backtestRuns.error} = ${input.supersededError})`
                  )
                )
                .limit(1);
        const createdAt = dependencies.now();
        const created =
          live !== undefined || input.runs.length === 0
            ? []
            : await transaction
                .insert(backtestRuns)
                .values(
                  input.runs.map((run) => ({
                    createdAt,
                    engineVersion: run.engineVersion,
                    id: dependencies.generateId(),
                    requestedBy: run.requestedBy,
                    spec: run.spec,
                    status: "queued" as const,
                    strategyId: run.strategyId,
                    strategyRevision: run.strategyRevision,
                    strategySnapshot: run.strategySnapshot,
                  }))
                )
                .returning({ id: backtestRuns.id });
        const { supersede } = input;
        const superseded =
          supersede === undefined
            ? []
            : await transaction
                .update(backtestRuns)
                .set({
                  error: boundBacktestRunError(input.supersededError),
                  finishedAt: createdAt,
                  status: "failed",
                })
                .where(
                  and(
                    eq(backtestRuns.status, "queued"),
                    eq(backtestRuns.engineVersion, supersede.engineVersion),
                    eq(backtestRuns.requestedBy, supersede.requestedBy),
                    sql`${backtestRuns.spec}->'comparison'->>'feature' = ${supersede.feature}`,
                    sql`${comparisonGroup} <> ${input.groupId}`
                  )
                )
                .returning({ id: backtestRuns.id });
        return {
          created: created.length,
          reused: live !== undefined,
          superseded: superseded.length,
        };
      }),
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
          and(
            sql`${backtestRuns.spec}->'comparison' is null`,
            filter.strategyId === undefined
              ? undefined
              : eq(backtestRuns.strategyId, filter.strategyId)
          )
        )
        .orderBy(desc(backtestRuns.createdAt))
        .limit(
          Math.min(Math.max(filter.limit, 1), BACKTEST_RUNS_LIST_MAX)
        )) as BacktestRunSummaryRecord[],
    listComparisons: async (filter) =>
      (await database
        .select({
          ...summaryColumns,
          differences: sql<Record<
            string,
            unknown
          > | null>`${backtestRuns.report}->'differences'`,
          engineRun: sql<Record<
            string,
            unknown
          > | null>`${backtestRuns.report}->'engineRun'`,
        })
        .from(backtestRuns)
        .where(
          and(
            sql`${backtestRuns.spec}->'comparison' is not null`,
            filter.feature === undefined
              ? undefined
              : sql`${backtestRuns.spec}->'comparison'->>'feature' = ${filter.feature}`,
            filter.groupId === undefined
              ? undefined
              : eq(comparisonGroup, filter.groupId)
          )
        )
        .orderBy(desc(backtestRuns.createdAt), asc(backtestRuns.id))
        .limit(
          Math.min(Math.max(filter.limit, 1), BACKTEST_RUN_COMPARISONS_LIST_MAX)
        )) as BacktestRunComparisonRecord[],
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
      for (
        let attempt = 0;
        attempt < BACKTEST_RUN_CLAIM_ATTEMPTS;
        attempt += 1
      ) {
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
    claimBatch: async (engineVersion, max) => {
      const first = await repository.claimNext(engineVersion);
      if (first === null) return [];
      const groupId = (
        first.spec.comparison as { groupId?: unknown } | undefined
      )?.groupId;
      const more = Math.min(Math.floor(max), BACKTEST_RUN_BATCH_MAX) - 1;
      if (typeof groupId !== "string" || more < 1) return [first];
      // One statement: the outer status check skips rows that another caller claimed after this
      // subquery read them, so each run goes to one caller.
      const rest = (await database
        .update(backtestRuns)
        .set({ status: "running", startedAt: dependencies.now() })
        .where(
          and(
            eq(backtestRuns.status, "queued"),
            inArray(
              backtestRuns.id,
              new QueryBuilder()
                .select({ id: groupRuns.id })
                .from(groupRuns)
                .where(
                  and(
                    eq(groupRuns.status, "queued"),
                    eq(groupRuns.engineVersion, engineVersion),
                    sql`${groupRuns.spec}->'comparison'->>'groupId' = ${groupId}`
                  )
                )
                .orderBy(asc(groupRuns.createdAt), asc(groupRuns.id))
                .limit(more)
            )
          )
        )
        .returning()) as BacktestRunRecord[];
      return [first, ...rest.sort(byAge)];
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
            notExists(
              new QueryBuilder()
                .select({ one: sql`1` })
                .from(activeRuns)
                .where(
                  and(
                    eq(activeRuns.engineVersion, engineVersion),
                    gte(activeRuns.startedAt, before)
                  )
                )
            )
          )
        )
        .returning({ id: backtestRuns.id });
      return rows.length > 0;
    },
  };
  return repository;
};
