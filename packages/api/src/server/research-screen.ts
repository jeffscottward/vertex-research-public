import {
  DatabasePersistenceError,
  type ResearchScreenBarsRecord,
  type ResearchScreenRepository,
  type ResearchScreenRowWrite,
  type ResearchScreenRunRecord,
  type ResearchScreenStatusRecord,
  type ResearchScreenStatusRow,
  type ResearchScreenStopSignals,
  type ResearchScreenSwinglyticsRecord,
  type ResearchScreenWorkItem,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  RESEARCH_SCREEN_ACTIONS,
  RESEARCH_SCREEN_NEXT_SLOTS,
  type ResearchScreenAction,
  type ResearchScreenContext,
  type ResearchScreenDecision,
  type ResearchScreenRow,
  type ResearchScreenRun,
  type ResearchScreenSlot,
  type ResearchScreenStatusOutput,
  type ResearchScreenTickOutput,
} from "../contracts/research-screen.ts";
import {
  CALENDAR_UNVERIFIED_LIMITATION,
  type CatalogEntry,
  effectiveRow,
  parseCatalogEntry,
  RESEARCH_SCREEN_LIMITATIONS,
  RESEARCH_SCREEN_LIMITS,
  type ResearchScreenBar,
  runStatusOf,
  schedulerStateOf,
  screenReport,
} from "../research-screen.ts";
import {
  barsDueSessionDate,
  calendarVerified,
  newestSlotAtOrBefore,
  slotsBetween,
} from "../research-screen-slots.ts";
import { SWINGLYTICS_WARNING } from "../swinglytics.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type ReadChartResult,
  type ReadIbkrBarsResult,
  type ReadSwinglyticsResult,
  readChart,
  readIbkrBars,
  readSwinglytics,
  researchScreenNow,
} from "./research-screen-evidence.ts";

// researchScreen.*: `tick` is scheduler-only (an operator's agent API key) and works one share of
// a run per call; `status` is operator-only and applies the read-time rule to the stored rows.
// Research only: no order path. A provider failure is a row error code, never an API error.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How far ahead the status looks for its next slots (the grid alone gives 18 in 3 days). */
const NEXT_SLOTS_WINDOW_MS = 3 * DAY_MS;
/** Stored bars of one report: the newest sessions that are kept. */
const STORED_BARS_MAX = 300;

/** The evidence readers of the engine (research-screen-evidence.ts). */
export type ResearchScreenReaders = Readonly<{
  readChart: (providerSymbol: string) => Promise<ReadChartResult>;
  readIbkrBars: (
    entry: CatalogEntry,
    config: DeployStatusConfig | null | undefined
  ) => Promise<ReadIbkrBarsResult>;
  readSwinglytics: () => Promise<ReadSwinglyticsResult>;
}>;

export type ResearchScreenEngine = Readonly<{
  marketHistory: DeployStatusConfig | null | undefined;
  now: () => Date;
  readers: ResearchScreenReaders;
  repository: ResearchScreenRepository;
  requestId: string;
}>;

/** The counters of a run during one share: the run record plus the accepted writes of the share. */
export interface ShareCounters {
  failed: number;
  ibkrFailuresInRow: number;
  succeeded: number;
  yahooRateLimitsInRow: number;
}

type Lease = Readonly<{ fence: number; run: ResearchScreenRunRecord }>;

type ChosenBars = Readonly<{
  bars: readonly ResearchScreenBar[];
  /** null: no IBKR read was made, so the stop counter keeps its value. */
  ibkrFailed: boolean | null;
  source: "ibkr" | "yahoo";
}>;

/** True when IBKR has no form of the report (the Yahoo bars are its only bars). */
export const ibkrNotServed = (read: ReadIbkrBarsResult): boolean =>
  !read.ok && read.reason === "not-served";

/**
 * True when the stored bars can be used without a request: they exist, belong to this provider
 * symbol and reach the newest NYSE session whose close is at least 2 hours ago.
 */
export const storedBarsCurrent = (
  stored: ResearchScreenBarsRecord | null,
  providerSymbol: string,
  now: Date
): stored is ResearchScreenBarsRecord => {
  const due = barsDueSessionDate(now);
  return (
    stored !== null &&
    due !== null &&
    stored.providerSymbol === providerSymbol &&
    stored.sessionDate >= due
  );
};

/** The run counters after a write that the repository accepted (the rules of `writeRow`). */
export const countWrite = (
  counters: ShareCounters,
  row: ResearchScreenRowWrite
): void => {
  const succeeded =
    row.kind === "good" && row.observation.action !== "unavailable";
  if (succeeded) counters.succeeded += 1;
  else counters.failed += 1;
  counters.yahooRateLimitsInRow = row.stops.yahooRateLimited
    ? counters.yahooRateLimitsInRow + 1
    : 0;
  if (row.stops.ibkrFailed === null) return;
  counters.ibkrFailuresInRow = row.stops.ibkrFailed
    ? counters.ibkrFailuresInRow + 1
    : 0;
};

/**
 * The bars one report is screened with (design, "Price reader"): the Yahoo bars of the chart when
 * IBKR cannot serve the report, the stored IBKR bars while they are not due, else a read of the
 * history service unless the run reached the IBKR stop. null: the fence is old, nothing was saved.
 */
export const chooseBars = async (
  engine: ResearchScreenEngine,
  lease: Lease,
  item: ResearchScreenWorkItem,
  work: Readonly<{
    counters: ShareCounters;
    entry: CatalogEntry;
    now: Date;
    yahooBars: readonly ResearchScreenBar[];
  }>
): Promise<ChosenBars | null> => {
  const { entry } = work;
  const yahoo = (ibkrFailed: boolean | null): ChosenBars => ({
    bars: work.yahooBars,
    ibkrFailed,
    source: "yahoo",
  });
  // Without a configuration the reader makes no request; it only says whether IBKR serves this.
  if (ibkrNotServed(await engine.readers.readIbkrBars(entry, null)))
    return yahoo(null);
  if (storedBarsCurrent(item.bars, entry.providerSymbol, work.now))
    return { bars: item.bars.bars, ibkrFailed: null, source: "ibkr" };
  if (work.counters.ibkrFailuresInRow >= RESEARCH_SCREEN_LIMITS.ibkrFailureStop)
    return yahoo(null);
  const read = await engine.readers.readIbkrBars(entry, engine.marketHistory);
  const last = read.ok ? read.bars.at(-1) : undefined;
  if (!read.ok || last === undefined) return yahoo(true);
  const saved = await engine.repository.saveBars(
    lease.run.id,
    lease.fence,
    entry.id,
    entry.providerSymbol,
    last.date,
    read.bars.slice(-STORED_BARS_MAX)
  );
  return saved ? { bars: read.bars, ibkrFailed: false, source: "ibkr" } : null;
};

type Failure = Readonly<{
  errorCode: FailedWrite["errorCode"];
  errorMessage: string;
}>;
type FailedWrite = Extract<ResearchScreenRowWrite, { kind: "failed" }>;

const failedRow = (
  item: ResearchScreenWorkItem,
  failure: Failure,
  stops: ResearchScreenStopSignals,
  barsSource: "ibkr" | "yahoo" | null = null
): FailedWrite => ({
  barsSource,
  errorCode: failure.errorCode,
  errorMessage: failure.errorMessage,
  kind: "failed",
  providerSymbol: item.report.providerSymbol,
  reportId: item.report.id,
  stops,
});

/** The screened row of a report whose chart was read; null when the fence is old. */
const screenedRow = async (
  engine: ResearchScreenEngine,
  lease: Lease,
  item: ResearchScreenWorkItem,
  work: Readonly<{
    chart: Extract<ReadChartResult, { ok: true }>;
    counters: ShareCounters;
    entry: CatalogEntry;
  }>
): Promise<ResearchScreenRowWrite | null> => {
  const now = engine.now();
  const chosen = await chooseBars(engine, lease, item, {
    counters: work.counters,
    entry: work.entry,
    now,
    yahooBars: work.chart.bars,
  });
  if (chosen === null) return null;
  const stops = { ibkrFailed: chosen.ibkrFailed, yahooRateLimited: false };
  const screened = screenReport(
    work.entry,
    {
      bars: chosen.bars,
      barsSource: chosen.source,
      fetchError: null,
      quote: work.chart.quote,
    },
    now
  );
  if (!screened.ok) return failedRow(item, screened, stops, chosen.source);
  const { historyAt, quoteAt, ...values } = screened.observation;
  return {
    barsSource: chosen.source,
    historyAt,
    kind: "good",
    observation: {
      ...values,
      blockingWarnings: values.blockingWarnings.map((warning) => ({
        ...warning,
      })),
      buyZone: { ...values.buyZone },
      reasons: [...values.reasons],
      warnings: [...values.warnings],
    },
    providerSymbol: item.report.providerSymbol,
    quoteAt,
    quoteSource: "yahoo",
    reportId: item.report.id,
    stops,
  };
};

/** The row of one report, without the write; null when the fence is old. */
const rowOf = async (
  engine: ResearchScreenEngine,
  lease: Lease,
  item: ResearchScreenWorkItem,
  counters: ShareCounters
): Promise<ResearchScreenRowWrite | null> => {
  const yahooStopped =
    counters.yahooRateLimitsInRow >= RESEARCH_SCREEN_LIMITS.yahooRateLimitStop;
  const parsed = parseCatalogEntry(item.report);
  // No Yahoo request was made: the Yahoo counter keeps its side of the stop.
  if (!parsed.ok)
    return failedRow(item, parsed, {
      ibkrFailed: null,
      yahooRateLimited: yahooStopped,
    });
  if (yahooStopped)
    return failedRow(
      item,
      {
        errorCode: "rate-limited",
        errorMessage:
          "Yahoo chart: not requested after 3 rate-limit answers in a row in this run.",
      },
      { ibkrFailed: null, yahooRateLimited: true }
    );
  const chart = await engine.readers.readChart(parsed.entry.providerSymbol);
  if (!chart.ok)
    return failedRow(item, chart, {
      ibkrFailed: null,
      yahooRateLimited: chart.errorCode === "rate-limited",
    });
  return screenedRow(engine, lease, item, {
    chart,
    counters,
    entry: parsed.entry,
  });
};

/**
 * Screens one report and writes its row. False when the fence is old (nothing was counted); the
 * counters follow an accepted write.
 */
export const processReport = async (
  engine: ResearchScreenEngine,
  lease: Lease,
  item: ResearchScreenWorkItem,
  counters: ShareCounters
): Promise<boolean> => {
  const row = await rowOf(engine, lease, item, counters);
  if (row === null) return false;
  const written = await engine.repository.writeRow(
    lease.run.id,
    lease.fence,
    row
  );
  if (written) countWrite(counters, row);
  return written;
};

const answerOf = (
  engine: ResearchScreenEngine,
  decision: ResearchScreenDecision,
  run: ResearchScreenRunRecord,
  state: Readonly<{
    done: boolean;
    processed: number;
    remaining: number;
    runStatus: ResearchScreenTickOutput["runStatus"];
  }>
): ResearchScreenTickOutput => ({
  decision,
  done: state.done,
  processed: state.processed,
  remaining: state.remaining,
  requestId: engine.requestId,
  runId: run.id,
  runStatus: state.runStatus,
  slotAt: run.slotAt,
  slotLabels: [...run.slotLabels],
  total: run.total,
});

/**
 * One share of a run: reports until the share budget or the deadline, the lease renewed after each
 * one. Ends the run when no report remains or the deadline is reached. A refused write or renewal
 * (an old fence) ends the share at once.
 */
export const workShare = async (
  engine: ResearchScreenEngine,
  decision: "claimed" | "resumed",
  lease: Lease
): Promise<ResearchScreenTickOutput> => {
  const { run } = lease;
  const deadline = run.deadlineAt.getTime();
  const items = await engine.repository.listWork(run.id);
  const counters: ShareCounters = {
    failed: run.failed,
    ibkrFailuresInRow: run.ibkrFailuresInRow,
    succeeded: run.succeeded,
    yahooRateLimitsInRow: run.yahooRateLimitsInRow,
  };
  const started = engine.now().getTime();
  const inTime = (): boolean => {
    const at = engine.now().getTime();
    return at - started < RESEARCH_SCREEN_LIMITS.shareBudgetMs && at < deadline;
  };
  let attempted = 0;
  let held = true;
  for (const item of items) {
    if (!inTime()) break;
    held = await processReport(engine, lease, item, counters);
    if (!held) break;
    attempted += 1;
    held = await engine.repository.renewLease(run.id, lease.fence);
    if (!held) break;
  }
  const processed = counters.succeeded + counters.failed;
  const remaining = items.length - attempted;
  const state = { processed, remaining };
  if (!held)
    return answerOf(engine, decision, run, {
      ...state,
      done: true,
      runStatus: "running",
    });
  if (remaining > 0 && engine.now().getTime() < deadline)
    return answerOf(engine, decision, run, {
      ...state,
      done: false,
      runStatus: "running",
    });
  const status = runStatusOf({
    failed: counters.failed,
    notReached: Math.max(0, run.total - processed),
    succeeded: counters.succeeded,
    total: run.total,
  });
  const finished = await engine.repository.finishRun(
    run.id,
    lease.fence,
    status,
    `${processed} of ${run.total} reports screened`
  );
  return answerOf(engine, decision, run, {
    ...state,
    done: true,
    runStatus: finished ? status : "running",
  });
};

const leaseLive = (run: ResearchScreenRunRecord, now: Date): boolean =>
  run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() > now.getTime();

const busy = async (
  engine: ResearchScreenEngine,
  run: ResearchScreenRunRecord
): Promise<ResearchScreenTickOutput> => {
  await engine.repository.recordTick("busy");
  const processed = run.succeeded + run.failed;
  return answerOf(engine, "busy", run, {
    done: true,
    processed,
    remaining: Math.max(0, run.total - processed),
    runStatus: "running",
  });
};

/** The Swinglytics context of a run. Isolated: no failure here changes the run. */
const collectSwinglytics = async (
  engine: ResearchScreenEngine
): Promise<void> => {
  try {
    const read = await engine.readers.readSwinglytics();
    await engine.repository.saveSwinglytics(
      read.ok
        ? {
            generatedAt: read.generatedAt,
            kind: "ok",
            snapshot: read.snapshot,
          }
        : { kind: "error", message: read.error }
    );
  } catch {
    // The next run reads the page again; the stored context keeps its last state.
  }
};

/** No run is active: claims the newest slot at or before `now` when it is due. */
const claimAndWork = async (
  engine: ResearchScreenEngine,
  now: Date
): Promise<ResearchScreenTickOutput> => {
  const { repository } = engine;
  const slot = newestSlotAtOrBefore(now);
  const catalog = await repository.readStatus();
  const run = await repository.claimSlot({
    labels: [...slot.labels],
    owner: engine.requestId,
    slotAt: slot.at,
    total: catalog.rows.length,
  });
  if (run === null) {
    await repository.recordTick("not-due");
    return {
      decision: "not-due",
      done: true,
      processed: 0,
      remaining: 0,
      requestId: engine.requestId,
      runId: null,
      runStatus: null,
      slotAt: null,
      slotLabels: [],
      total: 0,
    };
  }
  await repository.recordTick("claimed");
  await collectSwinglytics(engine);
  return workShare(engine, "claimed", { fence: run.fence, run });
};

/** One scheduler tick (design, "Contracts", the decision table). */
export const runTick = async (
  engine: ResearchScreenEngine
): Promise<ResearchScreenTickOutput> => {
  const { repository } = engine;
  const now = engine.now();
  const active = await repository.findActiveRun();
  if (active === null) return claimAndWork(engine, now);
  if (leaseLive(active, now)) return busy(engine, active);
  if (active.deadlineAt.getTime() <= now.getTime()) {
    await repository.closeExpiredRun(active.id);
    return claimAndWork(engine, now);
  }
  const taken = await repository.takeLease(active.id, engine.requestId);
  if (taken === null) return busy(engine, active);
  await repository.recordTick("resumed");
  return workShare(engine, "resumed", { fence: taken.fence, run: active });
};

const toRun = (
  run: ResearchScreenRunRecord,
  shown: ResearchScreenRun["status"]
): ResearchScreenRun => ({
  barsFromIbkr: run.barsFromIbkr,
  barsFromYahoo: run.barsFromYahoo,
  claimedAt: run.claimedAt,
  deadlineAt: run.deadlineAt,
  failed: run.failed,
  finishedAt: run.finishedAt,
  id: run.id,
  message: run.message,
  notReached: run.notReached,
  slotAt: run.slotAt,
  slotLabels: [...run.slotLabels],
  status: shown,
  succeeded: run.succeeded,
  total: run.total,
});

/** A running run whose deadline and lease are both past is shown as interrupted (not written). */
const shownStatusOf = (
  run: ResearchScreenRunRecord,
  now: Date
): ResearchScreenRun["status"] =>
  run.status === "running" &&
  run.deadlineAt.getTime() <= now.getTime() &&
  !leaseLive(run, now)
    ? "interrupted"
    : run.status;

const timeOf = (at: Date | null): number => (at === null ? 0 : at.getTime());

const NO_OBSERVATION = {
  action: "unavailable",
  blockingWarnings: [],
  buyZone: null,
  changePercent: null,
  momentumPercent: null,
  price: null,
  quoteAgeMs: null,
  reasons: [],
  rewardRisk: null,
  score: 0,
  stop: null,
  storedAction: null,
  storedScore: null,
  support: null,
  target: null,
  warnings: [],
} as const satisfies Partial<ResearchScreenRow>;

type StoredRow = NonNullable<ResearchScreenStatusRow["row"]>;

/** The observation columns of a row after the read-time rule; no good observation gives nulls. */
const observationOf = (
  row: StoredRow,
  now: Date
): Pick<ResearchScreenRow, keyof typeof NO_OBSERVATION> => {
  const stored = row.observation;
  const action: ResearchScreenAction | undefined = RESEARCH_SCREEN_ACTIONS.find(
    (known) => known === stored?.action
  );
  if (stored === null || action === undefined)
    return {
      ...NO_OBSERVATION,
      blockingWarnings: [],
      reasons: [],
      warnings: [],
    };
  const shown = effectiveRow(
    {
      action,
      quoteAt: row.quoteAt,
      score: stored.score,
      warnings: stored.warnings,
    },
    now
  );
  return {
    action: shown.action,
    blockingWarnings: stored.blockingWarnings,
    buyZone: stored.buyZone,
    changePercent: stored.changePercent,
    momentumPercent: stored.momentumPercent,
    price: stored.price,
    quoteAgeMs:
      row.quoteAt === null ? null : now.getTime() - row.quoteAt.getTime(),
    reasons: stored.reasons,
    rewardRisk: stored.rewardRisk,
    score: shown.score,
    stop: stored.stop,
    storedAction: shown.storedAction,
    storedScore: shown.storedScore,
    support: stored.support,
    target: stored.target,
    warnings: [...shown.warnings],
  };
};

/**
 * One catalog report as a status row. A stored row of another provider symbol is a row of another
 * instrument: the report is shown as never collected until its next attempt.
 */
export const toStatusRow = (
  { report, row }: ResearchScreenStatusRow,
  now: Date
): ResearchScreenRow => {
  const identity = {
    providerSymbol: report.providerSymbol,
    reportId: report.id,
    symbol: report.symbol,
  };
  if (row === null || row.providerSymbol !== report.providerSymbol)
    return {
      ...identity,
      ...NO_OBSERVATION,
      barsSource: null,
      blockingWarnings: [],
      collection: "never",
      errorCode: null,
      errorMessage: null,
      historyAt: null,
      lastAttemptAt: null,
      lastAttemptRunId: null,
      lastGoodAt: null,
      lastGoodRunId: null,
      quoteAt: null,
      quoteSource: null,
      reasons: [],
      warnings: [],
    };
  return {
    ...identity,
    ...observationOf(row, now),
    barsSource: row.barsSource,
    collection: timeOf(row.attemptAt) > timeOf(row.goodAt) ? "failed" : "fresh",
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    historyAt: row.historyAt,
    lastAttemptAt: row.attemptAt,
    lastAttemptRunId: row.attemptRunId,
    lastGoodAt: row.goodAt,
    lastGoodRunId: row.goodRunId,
    quoteAt: row.quoteAt,
    quoteSource: row.quoteSource === "yahoo" ? "yahoo" : null,
  };
};

/** A clock of the context that is missing, in the future, or older than 4 hours. */
const staleClock = (at: Date | null, now: Date): boolean => {
  if (at === null) return true;
  const age = now.getTime() - at.getTime();
  return age < 0 || age > RESEARCH_SCREEN_LIMITS.swinglyticsStaleMs;
};

const toContext = (
  stored: ResearchScreenSwinglyticsRecord,
  now: Date
): ResearchScreenContext => ({
  generatedAt: stored.generatedAt,
  lastAttemptAt: stored.lastAttemptAt,
  lastAttemptStatus: stored.lastAttemptStatus,
  lastError: stored.lastError,
  retrievedAt: stored.retrievedAt,
  snapshot: stored.snapshot,
  stale:
    staleClock(stored.generatedAt, now) || staleClock(stored.retrievedAt, now),
  warning: SWINGLYTICS_WARNING,
});

const toSlot = (slot: {
  at: Date;
  labels: readonly string[];
}): ResearchScreenSlot => ({ at: slot.at, labels: [...slot.labels] });

/** Slots of the last 24 hours with no run, newest first. */
const missedSlotsOf = (
  stored: ResearchScreenStatusRecord,
  now: Date
): ResearchScreenSlot[] => {
  const claimed = new Set(stored.runsSince.map((at) => at.getTime()));
  if (stored.activeRun !== null) claimed.add(stored.activeRun.slotAt.getTime());
  return slotsBetween(new Date(now.getTime() - DAY_MS), now)
    .filter((slot) => !claimed.has(slot.at.getTime()))
    .map(toSlot)
    .reverse();
};

/** The status answer from one stored read (the read-time rule applied at `now`). */
export const statusOf = (
  stored: ResearchScreenStatusRecord,
  now: Date
): ResearchScreenStatusOutput => {
  const lastTickAt = stored.scheduler?.lastTickAt ?? null;
  return {
    activeRun:
      stored.activeRun === null
        ? null
        : toRun(stored.activeRun, shownStatusOf(stored.activeRun, now)),
    evaluatedAt: now,
    lastRun:
      stored.lastRun === null
        ? null
        : toRun(stored.lastRun, stored.lastRun.status),
    limitations: calendarVerified(now)
      ? [...RESEARCH_SCREEN_LIMITATIONS]
      : [...RESEARCH_SCREEN_LIMITATIONS, CALENDAR_UNVERIFIED_LIMITATION],
    missedSlots: missedSlotsOf(stored, now),
    nextSlots: slotsBetween(now, new Date(now.getTime() + NEXT_SLOTS_WINDOW_MS))
      .slice(0, RESEARCH_SCREEN_NEXT_SLOTS)
      .map(toSlot),
    rows: stored.rows.map((row) => toStatusRow(row, now)),
    scheduler: {
      lastTickAt,
      lastTickDecision: stored.scheduler?.lastTickDecision ?? null,
      state: schedulerStateOf(lastTickAt, now),
    },
    swinglytics:
      stored.swinglytics === null ? null : toContext(stored.swinglytics, now),
  };
};

const api = implement(appContract).$context<ApiContext>();
type Errors = Readonly<{ STORAGE_ERROR: () => Error }>;

/** Runs a handler with the repository, mapping storage failures once. */
const withRepository = async <T>(
  context: ApiContext,
  errors: Errors,
  work: (repository: ResearchScreenRepository) => Promise<T>
): Promise<T> => {
  const repository = context.repositories.researchScreen;
  if (repository === undefined) throw errors.STORAGE_ERROR();
  try {
    return await work(repository);
  } catch (error) {
    if (error instanceof DatabasePersistenceError) throw errors.STORAGE_ERROR();
    throw error;
  }
};

const tick = api.researchScreen.tick
  .use(requireOperator)
  .handler(({ context, errors }) => {
    // Scheduler only: one timer works the runs of the whole deployment.
    if (context.agentApiKeyPresented !== true)
      throw errors.FORBIDDEN({
        message: "researchScreen.tick needs an agent API key",
      });
    return withRepository(context, errors, (repository) =>
      runTick({
        marketHistory: context.marketHistory,
        now: researchScreenNow,
        readers: { readChart, readIbkrBars, readSwinglytics },
        repository,
        requestId: context.requestId,
      })
    );
  });

const status = api.researchScreen.status
  .use(requireOperator)
  .handler(({ context, errors }) =>
    withRepository(context, errors, async (repository) =>
      statusOf(await repository.readStatus(), researchScreenNow())
    )
  );

export const researchScreenRouter = { status, tick };
