// What: the flow.* procedures. flow.collect (scheduler, agent API key) runs one sampled collection;
// flow.snapshot reads one symbol's window for the /flow page and the agent. Research only.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowRepository,
  OpenbbRepository,
  ResearchStudyRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  FlowControl,
  FlowControlInput,
  FlowSnapshot,
  FlowSnapshotParsedInput,
  FlowSymbol,
} from "../contracts/flow.ts";
import { ResearchStudyDocumentSchema } from "../contracts/research-studies.ts";
import {
  FLOW_CONTROL_STUDY_ID,
  FLOW_CONTROL_STUDY_RULES_ITEM,
} from "../flow-control-rules.ts";
import {
  FLOW_GROUPS,
  type FlowInstrument,
  flowSymbolForTicker,
} from "../flow-features.ts";
import { newYorkClock } from "../signal-alerts.ts";
import type { ApiContext } from "./context.ts";
import {
  FLOW_DEPTH_ROWS,
  FLOW_IBKR_LIMIT,
  FLOW_PRUNE_INTERVAL_MS,
  FLOW_QUANTDATA_CALLER_RESERVE,
  FLOW_TICKS_COUNT,
  runFlowCollect,
} from "./flow-collect.ts";
import {
  buildFlowControl,
  type FlowControlRows,
  type FlowSessionEventRead,
  type FlowStudyRead,
  futuresSessionRange,
  optionsSessionRange,
} from "./flow-control.ts";
import { buildFlowSnapshot, flowSessionOpen } from "./flow-snapshot.ts";
import {
  fetchMarketDepth,
  fetchMarketHistoryPacing,
  fetchMarketTape,
  fetchMarketTicks,
} from "./market-data.ts";
import { newYorkTime } from "./merged-bars.ts";
import { requireOperator } from "./operator-access.ts";
import {
  buildOptionsAnalytics,
  quantDataClientFor,
} from "./options-analytics.ts";
import { withCallerReserve } from "./quantdata-client.ts";

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

const systemClock = (): Date => new Date();
let clock: () => Date = systemClock;
// One collect run at a time per server process (QuantVPS runs one), so a manual or seed run can
// never overlap the timer and spend the shared IBKR budget twice.
// A run older than the scheduler's 170 s timeout counts as abandoned (a cancelled request may
// never reach its finally), so a stuck flag cannot stop sampling for good.
const COLLECT_STALE_MS = 180_000;
let collectingSince: number | null = null;
let lastPruneAt = Number.NEGATIVE_INFINITY;
export const setFlowClockForTesting = (now?: () => Date): void => {
  clock = now ?? systemClock;
  collectingSince = null;
  lastPruneAt = Number.NEGATIVE_INFINITY;
};

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): FlowRepository => {
  const repository = context.repositories.flow;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const instrumentInput = (instrument: FlowInstrument) => ({
  currency: "USD",
  secType: instrument.secType,
  symbol: instrument.symbol,
  ...(instrument.exchange === undefined
    ? {}
    : { exchange: instrument.exchange }),
});

const collect = api.flow.collect
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Scheduler only: one timer drives the whole deployment's sampling.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "flow.collect needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    const history = context.marketHistory ?? null;
    const quantData = context.quantData ?? null;
    // The collector's view keeps FLOW_QUANTDATA_CALLER_RESERVE starts free in the shared client, so
    // /charts option reads (the shared client without the view) always find room.
    const client =
      quantData === null
        ? null
        : withCallerReserve(
            quantDataClientFor(quantData),
            FLOW_QUANTDATA_CALLER_RESERVE
          );
    const now = clock();
    if (
      collectingSince !== null &&
      now.getTime() - collectingSince < COLLECT_STALE_MS
    )
      return {
        at: now.toISOString(),
        budget: {
          ibkrLimit: FLOW_IBKR_LIMIT,
          ibkrRecent: null,
          quantDataFree: null,
          quantDataReserve: FLOW_QUANTDATA_CALLER_RESERVE,
          runSeconds: 0,
        },
        busy: true,
        dryRun: input.dryRun,
        pruned: 0,
        runs: [],
      };
    const pruneDue =
      !input.dryRun && now.getTime() - lastPruneAt >= FLOW_PRUNE_INTERVAL_MS;
    const started = now.getTime();
    collectingSince = started;
    try {
      const output = await runFlowCollect(input, {
        analytics:
          client === null
            ? null
            : (ticker) =>
                buildOptionsAnalytics(
                  { flowHours: 1, symbol: ticker },
                  { client, now: () => now }
                ),
        depth: (instrument) =>
          fetchMarketDepth(history, {
            ...instrumentInput(instrument),
            rows: FLOW_DEPTH_ROWS,
          }),
        elapsedMs: () => clock().getTime() - started,
        now,
        pacing: () => fetchMarketHistoryPacing(history),
        pruneDue,
        quantData: client,
        repository,
        tape: (instrument, since) =>
          fetchMarketTape(history, { since, symbol: instrument.symbol }),
        ticks: (instrument) =>
          fetchMarketTicks(history, {
            ...instrumentInput(instrument),
            count: FLOW_TICKS_COUNT,
            quotes: true,
            useRTH: false,
          }),
      });
      if (pruneDue) lastPruneAt = started;
      return output;
    } finally {
      if (collectingSince === started) collectingSince = null;
    }
  });

/** Reads one symbol's window; the window ends at the newest stored data, not now. */
export const readFlowSnapshot = async (
  repository: FlowRepository,
  input: FlowSnapshotParsedInput,
  now: Date
): Promise<FlowSnapshot> => {
  const newest = await repository.newestDataAt(input.symbol);
  const windowEnd =
    newest === null || newest.getTime() > now.getTime() ? now : newest;
  const windowStart = new Date(windowEnd.getTime() - input.minutes * 60_000);
  const rows = await repository.readWindow({
    from: windowStart,
    gexAt: now,
    symbol: input.symbol,
    to: windowEnd,
  });
  const samples = await repository.latestSamples(input.symbol);
  return buildFlowSnapshot({
    ...rows,
    ...samples,
    now,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  });
};

const snapshot = api.flow.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    try {
      return await readFlowSnapshot(repository, input, clock());
    } catch {
      throw failures.STORAGE_ERROR();
    }
  });

/** The stored study of the options-side rule, or not_tested. */
const readFlowStudy = async (
  researchStudies: ResearchStudyRepository | undefined
): Promise<FlowStudyRead> => {
  const notTested = {
    rulesVersion: null,
    status: "not_tested",
    testedOn: null,
  } as const;
  const record = await researchStudies?.get(FLOW_CONTROL_STUDY_ID);
  if (record === undefined || record === null) return notTested;
  const parsed = ResearchStudyDocumentSchema.safeParse(record.summary);
  if (!parsed.success || parsed.data.kind !== "strategy-backtest")
    return notTested;
  const study = parsed.data;
  return {
    rulesVersion:
      study.rules.find((entry) => entry.item === FLOW_CONTROL_STUDY_RULES_ITEM)
        ?.rule ?? null,
    status: study.verdict,
    testedOn: study.ran,
  };
};

const DAY_MS = 86_400_000;
/** 15:59 New York: the last one-minute bucket of the regular session. */
const LAST_BUCKET_MINUTE = 959;

/** The weekday before a New York date (YYYY-MM-DD). */
const weekdayBefore = (date: string): string => {
  let at = Date.parse(`${date}T12:00:00Z`) - DAY_MS;
  while ([0, 6].includes(new Date(at).getUTCDay())) at -= DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
};

/**
 * The last one-minute close of the primary ticker before the session date: the bucket at or before
 * 15:59 New York of the weekday before; after a holiday one more read at 15:59 of the row's day.
 * Holidays and half days are not modelled (on a half day this is not the official close).
 */
const readPreviousClose = async (
  flow: FlowRepository,
  ticker: FlowControlRows["netDrift"][number]["ticker"],
  sessionDate: string
): Promise<number | null> => {
  const prevDay = weekdayBefore(sessionDate);
  let row = await flow.netDriftPriceAtOrBefore(
    ticker,
    newYorkTime(prevDay, LAST_BUCKET_MINUTE)
  );
  if (row === null) return null;
  const day = newYorkClock(row.minute).day;
  if (day < prevDay) {
    row = await flow.netDriftPriceAtOrBefore(
      ticker,
      newYorkTime(day, LAST_BUCKET_MINUTE)
    );
    if (row === null) return null;
  }
  return newYorkClock(row.minute).minute < 570 ? null : row.price;
};

/** The FOMC mark of the session date; a missing repository or a failed read never fails the document. */
const readSessionEvent = async (
  openbb: OpenbbRepository | undefined,
  sessionDate: string
): Promise<FlowSessionEventRead> => {
  if (openbb === undefined) return { calendar: "not_read", event: null };
  try {
    const rows = await openbb.events(sessionDate, sessionDate, [
      "fomc_meeting",
    ]);
    return {
      calendar: "read",
      event: rows.some((row) => row.source === "federal_reserve")
        ? "fomc"
        : null,
    };
  } catch {
    return { calendar: "not_read", event: null };
  }
};

/** Reads one index group's stored rows and assembles flow-control.v1. */
export const readFlowControl = async (
  repositories: Readonly<{
    flow: FlowRepository;
    researchStudies: ResearchStudyRepository | undefined;
    openbb: OpenbbRepository | undefined;
  }>,
  input: FlowControlInput,
  now: Date
): Promise<FlowControl> => {
  const { flow, researchStudies, openbb } = repositories;
  const group = FLOW_GROUPS[input.group];
  const optionsOpen = flowSessionOpen("options", group.future, now);
  const sessionDate = newYorkClock(
    optionsOpen
      ? now
      : ((await flow.newestNetDriftMinute(group.primaryTicker)) ?? now)
  ).day;
  const { from, to } = optionsSessionRange(sessionDate);
  const netDrift = await flow.readNetDrift({
    from,
    tickers: [group.primaryTicker, group.checkTicker],
    to,
  });
  const samples: Partial<
    Record<FlowSymbol, Awaited<ReturnType<FlowRepository["latestSamples"]>>>
  > = {};
  for (const symbol of new Set([
    ...[group.primaryTicker, group.checkTicker].map(flowSymbolForTicker),
    group.future,
  ]))
    samples[symbol] = await flow.latestSamples(symbol);
  // The future's minutes and events over the options session (books and GEX are not used).
  const window = await flow.readWindow({ from, symbol: group.future, to });
  const futures = futuresSessionRange(sessionDate);
  const largeTrades = await flow.readLargeTrades({
    from: futures.from,
    // Every group's future is ES or NQ (the flow registry test pins it).
    symbol: group.future as "ES" | "NQ",
    to: futures.to,
  });
  return buildFlowControl({
    crossGaps: input.group === "sp500" ? await flow.optionGaps("ES") : null,
    // The prints were read over the options session up to now (to its end after the close); the
    // assembly answers not_comparable when the fold window falls outside that range.
    crossPrints:
      input.group === "sp500"
        ? { from, prints: window.prints, to: optionsOpen ? now : to }
        : null,
    group: input.group,
    largeTrades,
    netDrift,
    now,
    previousClose: await readPreviousClose(
      flow,
      group.primaryTicker,
      sessionDate
    ),
    samples,
    sessionDate,
    sessionEvent: await readSessionEvent(openbb, sessionDate),
    study: await readFlowStudy(researchStudies),
    tape: window.minutes,
    tapeEvents: window.events,
  });
};

const control = api.flow.control
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const flow = repositoryFor(context, failures);
    try {
      return await readFlowControl(
        {
          flow,
          openbb: context.repositories.openbb,
          researchStudies: context.repositories.researchStudies,
        },
        input,
        clock()
      );
    } catch {
      throw failures.STORAGE_ERROR();
    }
  });

export const flowRouter = { collect, control, snapshot };
