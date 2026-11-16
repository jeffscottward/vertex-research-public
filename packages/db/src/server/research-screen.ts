import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type {
  ResearchScreenBarValue,
  ResearchScreenErrorCode,
  ResearchScreenObservationValue,
  ResearchScreenRunStatus,
  ResearchScreenSource,
  ResearchScreenSwinglyticsSnapshotValue,
  ResearchScreenTickDecision,
} from "../schema/index.ts";
import {
  researchReports,
  researchScreenBars,
  researchScreenRows,
  researchScreenRuns,
  researchScreenScheduler,
  researchScreenSwinglytics,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
} from "./repository-errors.ts";

// Research screen store (researchScreen.*): the run engine's state.
// One run per claimed slot. A claim is one transaction under an advisory lock: it refuses when the
// slot has a run, when a run is running, or when a run with a newer or equal slot exists. The
// deadline, the lease and the tick time are taken from the database clock, so two web instances
// never disagree about who holds a run. Every write of a tick names its fence: a tick whose lease
// was taken over writes nothing. The times of a row (attempt, good observation, fetch) are taken
// from the repository clock. The jsonb columns are returned as stored: the oRPC layer parses them
// before a row leaves the server. Research only: no order path.

export type {
  ResearchScreenAttemptStatus,
  ResearchScreenBarValue,
  ResearchScreenErrorCode,
  ResearchScreenObservationValue,
  ResearchScreenRunStatus,
  ResearchScreenSource,
  ResearchScreenSwinglyticsSnapshotValue,
  ResearchScreenTickDecision,
} from "../schema/index.ts";

/** Minutes from the claim to the deadline of a run. */
export const RESEARCH_SCREEN_DEADLINE_MINUTES = 25;
/** Seconds one lease take or renewal holds a run. */
export const RESEARCH_SCREEN_LEASE_SECONDS = 240;
/** Most characters of a run message and of a row error message. */
export const RESEARCH_SCREEN_MESSAGE_MAX = 300;
/** Most characters of the stored Swinglytics error. */
export const RESEARCH_SCREEN_SWINGLYTICS_ERROR_MAX = 240;

export type ResearchScreenRunRecord = Readonly<
  typeof researchScreenRuns.$inferSelect
>;
export type ResearchScreenRowRecord = Readonly<
  typeof researchScreenRows.$inferSelect
>;
export type ResearchScreenBarsRecord = Readonly<
  typeof researchScreenBars.$inferSelect
>;
export type ResearchScreenSchedulerRecord = Readonly<{
  lastTickAt: Date;
  lastTickDecision: ResearchScreenTickDecision;
}>;
export type ResearchScreenSwinglyticsRecord = Readonly<
  Omit<typeof researchScreenSwinglytics.$inferSelect, "id">
>;
export type ResearchScreenReportRecord = Readonly<
  typeof researchReports.$inferSelect
>;

export type ResearchScreenClaimInput = Readonly<{
  labels: readonly string[];
  /** The request id of the claiming tick: the first lease owner. */
  owner: string;
  slotAt: Date;
  total: number;
}>;

/** One report a run still has to attempt. */
export type ResearchScreenWorkItem = Readonly<{
  bars: ResearchScreenBarsRecord | null;
  report: ResearchScreenReportRecord;
  row: ResearchScreenRowRecord | null;
}>;

/**
 * The effect of one report on the two stop counters of its run: true raises the counter by 1,
 * false sets it to 0, null leaves it (the report made no IBKR read).
 */
export type ResearchScreenStopSignals = Readonly<{
  ibkrFailed: boolean | null;
  /** null: no Yahoo request was made, so the counter keeps its value. */
  yahooRateLimited: boolean | null;
}>;

type RowWriteBase = Readonly<{
  providerSymbol: string;
  reportId: string;
  stops: ResearchScreenStopSignals;
}>;

/**
 * A new observation: replaces the whole row. It counts as succeeded unless its action is
 * "unavailable", which counts as failed.
 */
export type ResearchScreenGoodRowWrite = RowWriteBase &
  Readonly<{
    barsSource: ResearchScreenSource;
    historyAt: Date | null;
    kind: "good";
    observation: ResearchScreenObservationValue;
    quoteAt: Date | null;
    quoteSource: ResearchScreenSource | null;
  }>;

/**
 * A failed attempt: keeps the last good observation unless the provider symbol changed. `barsSource`
 * is the source the bars came from before the failure, when bars were read.
 */
export type ResearchScreenFailedRowWrite = RowWriteBase &
  Readonly<{
    barsSource: ResearchScreenSource | null;
    errorCode: ResearchScreenErrorCode;
    errorMessage: string;
    kind: "failed";
  }>;

export type ResearchScreenRowWrite =
  | ResearchScreenGoodRowWrite
  | ResearchScreenFailedRowWrite;

export type ResearchScreenSwinglyticsResult =
  | Readonly<{
      generatedAt: Date;
      kind: "ok";
      snapshot: ResearchScreenSwinglyticsSnapshotValue;
    }>
  | Readonly<{ kind: "error"; message: string }>;

/** One catalog report with its screen row, when it has one. */
export type ResearchScreenStatusRow = Readonly<{
  report: Readonly<{
    id: string;
    name: string;
    position: number;
    providerSymbol: string;
    symbol: string;
  }>;
  row: ResearchScreenRowRecord | null;
}>;

export type ResearchScreenStatusRecord = Readonly<{
  activeRun: ResearchScreenRunRecord | null;
  /** The finished run with the newest slot. */
  lastRun: ResearchScreenRunRecord | null;
  /** Catalog position order. */
  rows: ResearchScreenStatusRow[];
  /** Slot times of the runs claimed in the last 24 hours (database clock), newest first. */
  runsSince: Date[];
  scheduler: ResearchScreenSchedulerRecord | null;
  swinglytics: ResearchScreenSwinglyticsRecord | null;
}>;

export type ResearchScreenRepository = Readonly<{
  /**
   * Claims a slot and takes the first lease (fence 1). Null when the slot has a run, when a run is
   * running, or when a run with a newer or equal slot exists.
   */
  claimSlot: (
    input: ResearchScreenClaimInput
  ) => Promise<ResearchScreenRunRecord | null>;
  /**
   * Ends a running run as interrupted when its deadline passed and its lease is set and expired (the
   * holder vanished). A run whose lease was released is ended by the next share, by its counts.
   */
  closeExpiredRun: (runId: string) => Promise<boolean>;
  /** The number of catalog reports (the first total of a run). */
  countReports: () => Promise<number>;
  findActiveRun: () => Promise<ResearchScreenRunRecord | null>;
  /** Ends a running run and clears its lease. False when the fence is old. */
  finishRun: (
    runId: string,
    fence: number,
    status: Exclude<ResearchScreenRunStatus, "running">,
    message: string | null,
    /** Reports of the work list that got no attempt; the total becomes the sum of the three counts. */
    notReached: number
  ) => Promise<boolean>;
  /**
   * Catalog reports not yet attempted in this run, with their row and stored bars: never attempted
   * first, then the oldest attempt first; ties in catalog position order.
   */
  listWork: (runId: string) => Promise<ResearchScreenWorkItem[]>;
  readStatus: () => Promise<ResearchScreenStatusRecord>;
  /** Stores the time (database clock) and the decision of a tick in the single scheduler row. */
  recordTick: (decision: ResearchScreenTickDecision) => Promise<void>;
  /** Frees the lease of a share that ends with work left, so the next tick takes it at once. */
  releaseLease: (runId: string, fence: number) => Promise<boolean>;
  /** Extends the lease. False when the fence is old or the run ended. */
  renewLease: (runId: string, fence: number) => Promise<boolean>;
  /** Replaces the stored bars of a report. False (and no write) when the fence is old. */
  saveBars: (
    runId: string,
    fence: number,
    reportId: string,
    providerSymbol: string,
    sessionDate: string,
    bars: readonly ResearchScreenBarValue[]
  ) => Promise<boolean>;
  saveSwinglytics: (result: ResearchScreenSwinglyticsResult) => Promise<void>;
  /**
   * Takes the lease of a running run when it is free or expired: the run as stored after the
   * takeover (raised fence, fresh counters). Null when the lease is live.
   */
  takeLease: (
    runId: string,
    owner: string
  ) => Promise<ResearchScreenRunRecord | null>;
  /**
   * Writes the row of one report and the counters of its run in one transaction. False (and no
   * write) when the fence is old.
   */
  writeRow: (
    runId: string,
    fence: number,
    row: ResearchScreenRowWrite
  ) => Promise<boolean>;
}>;

const SINGLE_ROW_ID = 1;
const runs = researchScreenRuns;
const rows = researchScreenRows;

const leaseExpiry = sql`now() + make_interval(secs => ${RESEARCH_SCREEN_LEASE_SECONDS})`;
/** A lease that is set and has ended: its holder vanished. A released lease (null) is not one. */
const leaseExpired = sql`${runs.leaseExpiresAt} <= now()`;
const leaseFree = or(isNull(runs.leaseExpiresAt), leaseExpired);
const notReached = sql<number>`greatest(${runs.total} - ${runs.succeeded} - ${runs.failed}, 0)`;

/** The running run with this id whose lease still has this fence. */
const heldBy = (runId: string, fence: number) =>
  and(eq(runs.id, runId), eq(runs.status, "running"), eq(runs.fence, fence));

const raisedBy = (column: typeof runs.succeeded, raise: boolean): SQL =>
  raise ? sql`${column} + 1` : sql`${column}`;

/** The next value of a stop counter: +1 on true, 0 on false, unchanged on null (no request). */
const stopCounter = (
  column: typeof runs.succeeded,
  signal: boolean | null
): SQL => {
  if (signal === null) return sql`${column}`;
  return signal ? sql`${column} + 1` : sql`0`;
};

/** A stored good column, or null when the stored provider symbol is not the new one. */
const keptWhileSameSymbol = (column: SQL | typeof rows.goodAt): SQL =>
  sql`case when ${rows.providerSymbol} = excluded.provider_symbol then ${column} end`;

const upsertRow = async (
  database: DatabaseExecutor,
  runId: string,
  row: ResearchScreenRowWrite,
  at: Date
): Promise<void> => {
  const attempt = { attemptAt: at, attemptRunId: runId };
  if (row.kind === "good") {
    const good = {
      ...attempt,
      barsSource: row.barsSource,
      errorCode: null,
      errorMessage: null,
      goodAt: at,
      goodRunId: runId,
      historyAt: row.historyAt,
      observation: row.observation,
      providerSymbol: row.providerSymbol,
      quoteAt: row.quoteAt,
      quoteSource: row.quoteSource,
    };
    await database
      .insert(rows)
      .values({ ...good, reportId: row.reportId })
      .onConflictDoUpdate({ set: good, target: rows.reportId });
    return;
  }
  const failed = {
    ...attempt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage.slice(0, RESEARCH_SCREEN_MESSAGE_MAX),
    providerSymbol: row.providerSymbol,
  };
  await database
    .insert(rows)
    .values({ ...failed, reportId: row.reportId })
    .onConflictDoUpdate({
      set: {
        ...failed,
        barsSource: keptWhileSameSymbol(sql`${rows.barsSource}`),
        goodAt: keptWhileSameSymbol(rows.goodAt),
        goodRunId: keptWhileSameSymbol(sql`${rows.goodRunId}`),
        historyAt: keptWhileSameSymbol(rows.historyAt),
        observation: keptWhileSameSymbol(sql`${rows.observation}`),
        quoteAt: keptWhileSameSymbol(rows.quoteAt),
        quoteSource: keptWhileSameSymbol(sql`${rows.quoteSource}`),
      },
      target: rows.reportId,
    });
};

/** Postgres failures become DatabasePersistenceError (503 at the API). */
const orPersistenceError = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (typeof databaseErrorDetails(error).code === "string") {
      throw new DatabasePersistenceError("research screen");
    }
    throw error;
  }
};

const claimSlot = (
  database: DatabaseExecutor,
  input: ResearchScreenClaimInput
): Promise<ResearchScreenRunRecord | null> =>
  database.transaction(async (tx) => {
    // One claim at a time: without the lock, an older slot could pass the check below while a
    // newer run is claimed and finished by another instance.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('darkfactory.research-screen.claim', 0))`
    );
    const [blocking] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(or(eq(runs.status, "running"), gte(runs.slotAt, input.slotAt)))
      .limit(1);
    if (blocking !== undefined) return null;
    const [claimed] = await tx
      .insert(runs)
      .values({
        claimedAt: sql`now()`,
        deadlineAt: sql`now() + make_interval(mins => ${RESEARCH_SCREEN_DEADLINE_MINUTES})`,
        fence: 1,
        leaseExpiresAt: leaseExpiry,
        leaseOwner: input.owner,
        slotAt: input.slotAt,
        slotLabels: [...input.labels],
        status: "running",
        total: input.total,
      })
      .onConflictDoNothing()
      .returning();
    return claimed ?? null;
  });

const saveBars = (
  database: DatabaseExecutor,
  at: Date,
  ...[runId, fence, reportId, providerSymbol, sessionDate, bars]: Parameters<
    ResearchScreenRepository["saveBars"]
  >
): Promise<boolean> =>
  database.transaction(async (tx) => {
    // The row lock holds a lease takeover back until this write is committed.
    const [held] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(heldBy(runId, fence))
      .for("update");
    if (held === undefined) return false;
    const stored = {
      bars: [...bars],
      fetchedAt: at,
      providerSymbol,
      sessionDate,
    };
    await tx
      .insert(researchScreenBars)
      .values({ ...stored, reportId })
      .onConflictDoUpdate({
        set: stored,
        target: researchScreenBars.reportId,
      });
    return true;
  });

const writeRow = (
  database: DatabaseExecutor,
  at: Date,
  runId: string,
  fence: number,
  row: ResearchScreenRowWrite
): Promise<boolean> =>
  database.transaction(async (tx) => {
    const succeeded =
      row.kind === "good" && row.observation.action !== "unavailable";
    // The counter update takes the row lock of the run, so the fence cannot change before commit.
    const counted = await tx
      .update(runs)
      .set({
        barsFromIbkr: raisedBy(runs.barsFromIbkr, row.barsSource === "ibkr"),
        barsFromYahoo: raisedBy(runs.barsFromYahoo, row.barsSource === "yahoo"),
        failed: raisedBy(runs.failed, !succeeded),
        ibkrFailuresInRow: stopCounter(
          runs.ibkrFailuresInRow,
          row.stops.ibkrFailed
        ),
        succeeded: raisedBy(runs.succeeded, succeeded),
        yahooRateLimitsInRow: stopCounter(
          runs.yahooRateLimitsInRow,
          row.stops.yahooRateLimited
        ),
      })
      .where(heldBy(runId, fence))
      .returning({ id: runs.id });
    if (counted.length === 0) return false;
    await upsertRow(tx, runId, row, at);
    return true;
  });

const readStatus = async (
  database: DatabaseExecutor
): Promise<ResearchScreenStatusRecord> => {
  const [scheduler] = await database
    .select({
      lastTickAt: researchScreenScheduler.lastTickAt,
      lastTickDecision: researchScreenScheduler.lastTickDecision,
    })
    .from(researchScreenScheduler)
    .where(eq(researchScreenScheduler.id, SINGLE_ROW_ID))
    .limit(1);
  const [activeRun] = await database
    .select()
    .from(runs)
    .where(eq(runs.status, "running"))
    .limit(1);
  const [lastRun] = await database
    .select()
    .from(runs)
    .where(ne(runs.status, "running"))
    .orderBy(desc(runs.slotAt))
    .limit(1);
  const recent = await database
    .select({ slotAt: runs.slotAt })
    .from(runs)
    .where(sql`${runs.claimedAt} > now() - interval '24 hours'`)
    .orderBy(desc(runs.slotAt));
  const statusRows = await database
    .select({
      report: {
        id: researchReports.id,
        name: researchReports.name,
        position: researchReports.position,
        providerSymbol: researchReports.providerSymbol,
        symbol: researchReports.symbol,
      },
      row: rows,
    })
    .from(researchReports)
    .leftJoin(rows, eq(rows.reportId, researchReports.id))
    .orderBy(asc(researchReports.position), asc(researchReports.id));
  const [swinglytics] = await database
    .select({
      generatedAt: researchScreenSwinglytics.generatedAt,
      lastAttemptAt: researchScreenSwinglytics.lastAttemptAt,
      lastAttemptStatus: researchScreenSwinglytics.lastAttemptStatus,
      lastError: researchScreenSwinglytics.lastError,
      retrievedAt: researchScreenSwinglytics.retrievedAt,
      snapshot: researchScreenSwinglytics.snapshot,
    })
    .from(researchScreenSwinglytics)
    .where(eq(researchScreenSwinglytics.id, SINGLE_ROW_ID))
    .limit(1);
  return {
    activeRun: activeRun ?? null,
    lastRun: lastRun ?? null,
    rows: statusRows,
    runsSince: recent.map((run) => run.slotAt),
    scheduler: scheduler ?? null,
    swinglytics: swinglytics ?? null,
  };
};

const saveSwinglytics = async (
  database: DatabaseExecutor,
  result: ResearchScreenSwinglyticsResult,
  at: Date
): Promise<void> => {
  const stored =
    result.kind === "ok"
      ? {
          generatedAt: result.generatedAt,
          lastAttemptAt: at,
          lastAttemptStatus: "ok" as const,
          lastError: null,
          retrievedAt: at,
          snapshot: result.snapshot,
        }
      : {
          lastAttemptAt: at,
          lastAttemptStatus: "error" as const,
          lastError: result.message.slice(
            0,
            RESEARCH_SCREEN_SWINGLYTICS_ERROR_MAX
          ),
        };
  await database
    .insert(researchScreenSwinglytics)
    .values({ ...stored, id: SINGLE_ROW_ID })
    .onConflictDoUpdate({
      set: stored,
      target: researchScreenSwinglytics.id,
    });
};

export const createResearchScreenRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): ResearchScreenRepository => ({
  claimSlot: (input) => orPersistenceError(claimSlot(database, input)),
  closeExpiredRun: async (runId) => {
    const closed = await orPersistenceError(
      database
        .update(runs)
        .set({
          finishedAt: sql`now()`,
          leaseExpiresAt: null,
          leaseOwner: null,
          notReached,
          status: "interrupted",
        })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, "running"),
            sql`${runs.deadlineAt} <= now()`,
            leaseExpired
          )
        )
        .returning({ id: runs.id })
    );
    return closed.length > 0;
  },
  countReports: async () => {
    const [counted] = await orPersistenceError(
      database.select({ reports: count() }).from(researchReports)
    );
    return counted?.reports ?? 0;
  },
  findActiveRun: async () => {
    const [run] = await orPersistenceError(
      database.select().from(runs).where(eq(runs.status, "running")).limit(1)
    );
    return run ?? null;
  },
  finishRun: async (runId, fence, status, message, left) => {
    const finished = await orPersistenceError(
      database
        .update(runs)
        .set({
          finishedAt: sql`now()`,
          leaseExpiresAt: null,
          leaseOwner: null,
          message: message?.slice(0, RESEARCH_SCREEN_MESSAGE_MAX) ?? null,
          notReached: left,
          status,
          total: sql`${runs.succeeded} + ${runs.failed} + ${left}`,
        })
        .where(heldBy(runId, fence))
        .returning({ id: runs.id })
    );
    return finished.length > 0;
  },
  listWork: (runId) =>
    orPersistenceError(
      database
        .select({
          bars: researchScreenBars,
          report: researchReports,
          row: rows,
        })
        .from(researchReports)
        .leftJoin(rows, eq(rows.reportId, researchReports.id))
        .leftJoin(
          researchScreenBars,
          eq(researchScreenBars.reportId, researchReports.id)
        )
        .where(or(isNull(rows.attemptRunId), ne(rows.attemptRunId, runId)))
        .orderBy(
          sql`${rows.attemptAt} asc nulls first`,
          asc(researchReports.position),
          asc(researchReports.id)
        )
    ),
  readStatus: () => orPersistenceError(readStatus(database)),
  recordTick: async (decision) => {
    const tick = { lastTickAt: sql`now()`, lastTickDecision: decision };
    await orPersistenceError(
      database
        .insert(researchScreenScheduler)
        .values({ ...tick, id: SINGLE_ROW_ID })
        .onConflictDoUpdate({ set: tick, target: researchScreenScheduler.id })
    );
  },
  releaseLease: async (runId, fence) => {
    const released = await orPersistenceError(
      database
        .update(runs)
        .set({ leaseExpiresAt: null, leaseOwner: null })
        .where(heldBy(runId, fence))
        .returning({ id: runs.id })
    );
    return released.length > 0;
  },
  renewLease: async (runId, fence) => {
    const renewed = await orPersistenceError(
      database
        .update(runs)
        .set({ leaseExpiresAt: leaseExpiry })
        .where(heldBy(runId, fence))
        .returning({ id: runs.id })
    );
    return renewed.length > 0;
  },
  saveBars: (...input) =>
    orPersistenceError(saveBars(database, now(), ...input)),
  saveSwinglytics: (result) =>
    orPersistenceError(saveSwinglytics(database, result, now())),
  takeLease: async (runId, owner) => {
    const [taken] = await orPersistenceError(
      database
        .update(runs)
        .set({
          fence: sql`${runs.fence} + 1`,
          leaseExpiresAt: leaseExpiry,
          leaseOwner: owner,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "running"), leaseFree))
        .returning()
    );
    return taken ?? null;
  },
  writeRow: (runId, fence, row) =>
    orPersistenceError(writeRow(database, now(), runId, fence, row)),
});
