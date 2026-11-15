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
import type { SemanticEvent } from "@darkfactory/observability/port";
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
  runStatusOf,
  schedulerStateOf,
  screenReport,
} from "../research-screen.ts";
import type { ResearchScreenBar } from "../research-screen-quote.ts";
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
/** Characters the message of a context failure event may hold. */
const CONTEXT_FAILURE_MESSAGE_MAX = 240;
export const RESEARCH_SCREEN_CONTEXT_FAILED_EVENT =
  "research.screen.context.failed";
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
  /**
   * Reports that the Swinglytics context of a run could not be read or stored (the reader threw or
   * the write failed). Must not throw: the run goes on.
   */
  reportContextFailure: (message: string) => Promise<void>;
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

/** The next value of a stop counter: +1 on true, 0 on false, unchanged on null (no request). */
const nextStopCount = (count: number, signal: boolean | null): number => {
  if (signal === null) return count;
  return signal ? count + 1 : 0;
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
  counters.yahooRateLimitsInRow = nextStopCount(
    counters.yahooRateLimitsInRow,
    row.stops.yahooRateLimited
  );
  counters.ibkrFailuresInRow = nextStopCount(
    counters.ibkrFailuresInRow,
    row.stops.ibkrFailed
  );
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
      quote: work.chart.quote,
    },
    now,
    // IBKR bars must reach the session the stored bars are due for; Yahoo bars have no such date.
    chosen.source === "ibkr" ? barsDueSessionDate(now) : null
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
  const parsed = parseCatalogEntry(item.report);
  // No request was made: both stop counters keep their value, so an active stop holds.
  if (!parsed.ok)
    return failedRow(item, parsed, {
      ibkrFailed: null,
      yahooRateLimited: null,
    });
  if (
    counters.yahooRateLimitsInRow >= RESEARCH_SCREEN_LIMITS.yahooRateLimitStop
  )
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
const processReport = async (
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
    total: number;
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
  total: state.total,
});

/**
 * One share of a run: reports until the share budget or the deadline, the lease renewed after each
 * one. Ends the run when no report remains or the deadline is reached; else frees the lease for the
 * next tick. A refused write or renewal (an old fence) ends the share at once. The counts of the
 * answer and of the end are those of the work list, not of the claim.
 */
const workShare = async (
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
  // The reports of the run as it went: a report can leave or join the catalog after the claim.
  const total = processed + remaining;
  const answer = (
    done: boolean,
    runStatus: ResearchScreenTickOutput["runStatus"]
  ): ResearchScreenTickOutput =>
    answerOf(engine, decision, run, {
      done,
      processed,
      remaining,
      runStatus,
      total,
    });
  if (!held) return answer(true, "running");
  if (remaining > 0 && engine.now().getTime() < deadline) {
    // Work is left: the lease is freed so the next tick takes it at once. A refusal means that
    // another tick has the run already.
    const released = await engine.repository.releaseLease(run.id, lease.fence);
    return answer(!released, "running");
  }
  const status = runStatusOf({
    failed: counters.failed,
    notReached: remaining,
    succeeded: counters.succeeded,
    total,
  });
  const finished = await engine.repository.finishRun(
    run.id,
    lease.fence,
    status,
    `${processed} of ${total} reports screened`,
    remaining
  );
  return answer(true, finished ? status : "running");
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
    total: run.total,
  });
};

/** The failure of the context step as one line of at most 240 characters without URLs. */
export const contextFailureMessage = (error: unknown): string =>
  String(error)
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, CONTEXT_FAILURE_MESSAGE_MAX);

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
  } catch (error) {
    // The run goes on: the next run reads the page again. The failure is reported, not hidden.
    await engine.reportContextFailure(contextFailureMessage(error));
  }
};

/** No run is active: claims the newest slot at or before `now` when it is due. */
const claimAndWork = async (
  engine: ResearchScreenEngine,
  now: Date
): Promise<ResearchScreenTickOutput> => {
  const { repository } = engine;
  const slot = newestSlotAtOrBefore(now);
  const run = await repository.claimSlot({
    labels: [...slot.labels],
    owner: engine.requestId,
    slotAt: slot.at,
    total: await repository.countReports(),
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
  if (
    active.deadlineAt.getTime() <= now.getTime() &&
    (await repository.closeExpiredRun(active.id))
  )
    return claimAndWork(engine, now);
  // The deadline has not passed, or the database did not end the run (its clock, or another tick,
  // says otherwise): this tick continues the run when it gets the lease.
  const taken = await repository.takeLease(active.id, engine.requestId);
  if (taken === null) return busy(engine, active);
  await repository.recordTick("resumed");
  // The run as stored now: its counters and stop counters include every earlier share.
  return workShare(engine, "resumed", { fence: taken.fence, run: taken });
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

/**
 * The observation columns of a row. No good observation gives nulls. After a failed collection the
 * last good values stay with their stored action and score, and the row is shown as `unavailable`
 * with score 0. Else the read-time rule applies.
 */
const observationOf = (
  row: StoredRow,
  collection: "failed" | "fresh",
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
  const kept = {
    action,
    quoteAt: row.quoteAt,
    score: stored.score,
    warnings: stored.warnings,
  };
  const shown =
    collection === "failed"
      ? {
          ...kept,
          action: "unavailable" as const,
          score: 0,
          storedAction: action,
          storedScore: stored.score,
        }
      : effectiveRow(kept, now);
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
const toStatusRow = (
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
  const collection =
    timeOf(row.attemptAt) > timeOf(row.goodAt) ? "failed" : "fresh";
  return {
    ...identity,
    ...observationOf(row, collection, now),
    barsSource: row.barsSource,
    collection,
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
const statusOf = (
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

/**
 * The reporter of a context failure for one request: one semantic event
 * `research.screen.context.failed`. Without an event port it reports nothing.
 */
export const contextFailureReporter =
  (
    context: Pick<
      ApiContext,
      "requestId" | "semanticEvents" | "span" | "waitUntil"
    >
  ) =>
  async (message: string): Promise<void> => {
    if (context.semanticEvents === undefined) return;
    const event: SemanticEvent = {
      action: "collect-context",
      attributes: { message },
      correlation: {
        ...context.span?.correlation,
        procedure: "researchScreen.tick",
        requestId: context.requestId,
        route: "/api/research-screen/tick",
      },
      entityType: "research-screen-context",
      eventId: crypto.randomUUID(),
      name: RESEARCH_SCREEN_CONTEXT_FAILED_EVENT,
      occurredAt: researchScreenNow().toISOString(),
      outcome: "failure",
      source: "api",
    };
    try {
      await context.semanticEvents.emit(event, {
        ...(context.span === undefined ? {} : { span: context.span }),
        ...(context.waitUntil === undefined
          ? {}
          : { waitUntil: context.waitUntil }),
      });
    } catch {
      // The event port is the last place a failure can be reported; the run goes on without it.
    }
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
        reportContextFailure: contextFailureReporter(context),
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
