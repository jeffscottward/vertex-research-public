// What: the flow.* procedures. flow.collect (scheduler, agent API key) runs one sampled collection;
// flow.snapshot reads one symbol's window for the /flow page and the agent; flow.tapeSpeed reads
// the per-second counts of the ES or NQ tape as bars with bursts for the /flow page;
// flow.hedgingPressure reads the SPY or SPX option prints of the newest options session as a
// running sum of estimated dealer hedge notional for the /flow page. Research only.
// flow.putCallRatio reads the SPY or SPX option prints as gross put/call premium and volume ratios
// over the newest options session and over stored sessions for the /flow page; flow.strikeHeatmap
// aggregates SPY or SPX option prints by strike and regular-session time slot. Research only.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowRepository,
  OpenbbRepository,
  ResearchStudyRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  FLOW_OPTION_BUBBLES_MAX_BUBBLES,
  FLOW_PUT_CALL_RATIO_MAX_DAYS,
  type FlowControl,
  type FlowControlInput,
  type FlowHedgingPressureInput,
  type FlowLiquidityHeatmapParsedInput,
  type FlowLiveDomParsedInput,
  type FlowLiveDomStreamParsedInput,
  type FlowOffExchangeLevelsParsedInput,
  type FlowOptionBubblesParsedInput,
  type FlowOptionPrintsParsedInput,
  type FlowPutCallRatioInput,
  type FlowSnapshot,
  type FlowSnapshotParsedInput,
  type FlowStrikeHeatmapParsedInput,
  type FlowSymbol,
  type FlowTapeSpeedParsedInput,
  type FlowTradeBubblesParsedInput,
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
import { HEDGING_READ_CAP } from "../flow-hedging-pressure-rules.ts";
import { OFF_EXCHANGE_READ_CAP } from "../flow-off-exchange-levels-rules.ts";
import { PUT_CALL_RATIO_LOOKBACK_DAYS } from "../flow-put-call-ratio-rules.ts";
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
import {
  buildFlowHedgingPressure,
  type FlowHedgingPressureRows,
} from "./flow-hedging-pressure.ts";
import {
  buildFlowLiquidityHeatmapFromRows,
  readFlowLiquidityHeatmapRows,
} from "./flow-liquidity-heatmap.ts";
import {
  type FlowLiveDomDeps,
  openFlowLiveDomStream,
  readFlowLiveDomSnapshot,
} from "./flow-live-dom.ts";
import {
  buildFlowOffExchangeLevels,
  type FlowOffExchangeLevelsRows,
  offExchangeFinraFromDate,
  offExchangeWindowRange,
} from "./flow-off-exchange-levels.ts";
import {
  buildFlowOptionBubbles,
  type FlowOptionBubblesRows,
} from "./flow-option-bubbles.ts";
import {
  buildFlowOptionPrints,
  readFlowOptionPrintsRows,
} from "./flow-option-prints.ts";
import {
  buildFlowPutCallRatio,
  type FlowPutCallRatioRows,
} from "./flow-put-call-ratio.ts";
import {
  buildFlowSnapshot,
  eventView,
  type FlowSnapshotRows,
  flowSessionDate,
  flowSessionOpen,
} from "./flow-snapshot.ts";
import {
  buildFlowStrikeHeatmap,
  type FlowStrikeHeatmapRows,
} from "./flow-strike-heatmap.ts";
import {
  buildFlowTapeSpeed,
  type FlowTapeSpeedRows,
  tapeSpeedAxis,
} from "./flow-tape-speed.ts";
import {
  buildFlowTradeBubblesFromRows,
  readFlowTradeBubblesRows,
} from "./flow-trade-bubbles.ts";
import {
  fetchMarketDepth,
  fetchMarketDepthHistory,
  fetchMarketDom,
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
  BAD_REQUEST: (options?: { message?: string }) => Error;
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
  if (repository === undefined)
    throw failures.STORAGE_ERROR({
      message:
        "Flow storage is not configured on this server; ask the operator",
    });
  return repository;
};

// The 503 of a failed read has two cases. The flow repository lets a driver error pass
// through as it is, so an error from an awaited repository call is a failed database
// request. An error from the pure assembly of the stored rows is a defect in the API.
const readRows = async <T>(failures: Failures, read: () => Promise<T>) => {
  try {
    return await read();
  } catch {
    throw failures.STORAGE_ERROR({
      message: "Flow storage: database request failed; retry",
    });
  }
};

const assemble = <T, R>(failures: Failures, build: (rows: T) => R, rows: T) => {
  try {
    return build(rows);
  } catch {
    throw failures.STORAGE_ERROR({
      message:
        "Flow storage request failed inside the API (unexpected error); retry, and report it if it repeats",
    });
  }
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
        depthHistory: (instrument, since) =>
          fetchMarketDepthHistory(history, {
            since,
            symbol: instrument.symbol,
          }),
        elapsedMs: () => clock().getTime() - started,
        now,
        pacing: () => fetchMarketHistoryPacing(history),
        pruneDue,
        quantData: client,
        repository,
        tape: (instrument, since) =>
          fetchMarketTape(history, { since, symbol: instrument.symbol }),
        tapeHistory: (instrument) =>
          fetchMarketTicks(history, {
            ...instrumentInput(instrument),
            count: FLOW_TICKS_COUNT,
            quotes: false,
            useRTH: false,
          }),
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

/** Reads one symbol's stored rows; the window ends at the newest stored data, not now. */
const readFlowSnapshotRows = async (
  repository: FlowRepository,
  input: FlowSnapshotParsedInput,
  now: Date
): Promise<FlowSnapshotRows> => {
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
  return {
    ...rows,
    ...samples,
    now,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  };
};

/** Reads one symbol's window and assembles flow.snapshot. */
export const readFlowSnapshot = async (
  repository: FlowRepository,
  input: FlowSnapshotParsedInput,
  now: Date
): Promise<FlowSnapshot> =>
  buildFlowSnapshot(await readFlowSnapshotRows(repository, input, now));

const snapshot = api.flow.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowSnapshotRows(repository, input, now)
    );
    return assemble(failures, buildFlowSnapshot, rows);
  });

/**
 * Reads the per-second counts of one streamed future for the window of flow.snapshot (it ends at
 * the newest stored data, not now), with the lead-in that the burst rule needs before the first
 * bar, and the minutes of the axis that have a minute row.
 */
const readFlowTapeSpeedRows = async (
  repository: FlowRepository,
  input: FlowTapeSpeedParsedInput,
  now: Date
): Promise<FlowTapeSpeedRows> => {
  const newest = await repository.newestDataAt(input.symbol);
  const windowEnd =
    newest === null || newest.getTime() > now.getTime() ? now : newest;
  const windowStart = new Date(windowEnd.getTime() - input.minutes * 60_000);
  const { axisEnd, axisStart, readFrom } = tapeSpeedAxis(
    windowStart,
    windowEnd
  );
  const seconds = await repository.readTapeSeconds({
    from: readFrom,
    symbol: input.symbol,
    to: axisEnd,
  });
  const minuteStarts = await repository.readMinuteStarts({
    from: axisStart,
    symbol: input.symbol,
    to: axisEnd,
  });
  // The document uses the tape sample only.
  const samples = await repository.latestSamples(input.symbol, ["ticks"]);
  return {
    ...samples,
    minuteStarts,
    minutes: input.minutes,
    now,
    seconds,
    symbol: input.symbol,
    windowEnd,
    windowStart,
  };
};

const tapeSpeed = api.flow.tapeSpeed
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowTapeSpeedRows(repository, input, now)
    );
    return assemble(failures, buildFlowTapeSpeed, rows);
  });

/**
 * Reads the option prints of the newest stored options session of one symbol: the session of the
 * newest print (a weekend or a pre-open print maps to the weekday before), its prints from 09:30
 * to 16:15 New York up to the read cap plus one (so the assembly can see a cut), the open gaps of
 * the collector and the options sample.
 */
const readFlowHedgingPressureRows = async (
  repository: FlowRepository,
  input: FlowHedgingPressureInput,
  now: Date
): Promise<FlowHedgingPressureRows> => {
  const newest = await repository.newestOptionPrintAt(input.symbol);
  const session = newest === null ? null : flowSessionDate(newest);
  const prints =
    session === null
      ? []
      : await repository.readHedgingPrints({
          ...optionsSessionRange(session),
          limit: HEDGING_READ_CAP + 1,
          symbol: input.symbol,
        });
  const gaps =
    session === null ? [] : await repository.optionGaps(input.symbol);
  // The response uses the options sample only.
  const samples = await repository.latestSamples(input.symbol, ["options"]);
  return {
    ...samples,
    gaps,
    now,
    prints,
    session,
    symbol: input.symbol,
  };
};

const hedgingPressure = api.flow.hedgingPressure
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowHedgingPressureRows(repository, input, now)
    );
    return assemble(failures, buildFlowHedgingPressure, rows);
  });

/**
 * Reads the per-minute option print sums of the newest stored options session and the per-day
 * sums across stored sessions (up to PUT_CALL_RATIO_LOOKBACK_DAYS back), plus open collector gaps
 * and the options source sample.
 */
const readFlowPutCallRatioRows = async (
  repository: FlowRepository,
  input: FlowPutCallRatioInput,
  now: Date
): Promise<FlowPutCallRatioRows> => {
  const newest = await repository.newestOptionPrintAt(input.symbol);
  const session = newest === null ? null : flowSessionDate(newest);
  if (session === null) {
    const samples = await repository.latestSamples(input.symbol, ["options"]);
    return {
      ...samples,
      days: [],
      gaps: [],
      minutes: [],
      now,
      session: null,
      symbol: input.symbol,
    };
  }
  const range = optionsSessionRange(session);
  const lookbackDate = new Date(
    Date.parse(`${session}T12:00:00Z`) - PUT_CALL_RATIO_LOOKBACK_DAYS * DAY_MS
  )
    .toISOString()
    .slice(0, 10);
  const daysFrom = optionsSessionRange(lookbackDate).from;
  const [minutes, days, gaps, samples] = await Promise.all([
    repository.readOptionPrintMinutes({
      ...range,
      symbol: input.symbol,
    }),
    repository.readOptionPrintDays({
      from: daysFrom,
      limit: FLOW_PUT_CALL_RATIO_MAX_DAYS,
      symbol: input.symbol,
      to: range.to,
    }),
    repository.optionGaps(input.symbol),
    repository.latestSamples(input.symbol, ["options"]),
  ]);
  return {
    ...samples,
    days,
    gaps,
    minutes,
    now,
    session,
    symbol: input.symbol,
  };
};

const putCallRatio = api.flow.putCallRatio
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowPutCallRatioRows(repository, input, now)
    );
    return assemble(failures, buildFlowPutCallRatio, rows);
  });

const readFlowStrikeHeatmapRows = async (
  repository: FlowRepository,
  input: FlowStrikeHeatmapParsedInput,
  now: Date
): Promise<FlowStrikeHeatmapRows> => {
  const newest = await repository.newestOptionPrintAt(input.symbol);
  const session = newest === null ? null : flowSessionDate(newest);
  if (session === null) {
    const samples = await repository.latestSamples(input.symbol, ["options"]);
    return {
      ...samples,
      bucketMinutes: input.bucketMinutes,
      buckets: [],
      gaps: [],
      now,
      session: null,
      slotPrices: [],
      symbol: input.symbol,
    };
  }
  const range = optionsSessionRange(session);
  const [buckets, slotPrices, gaps, samples] = await Promise.all([
    repository.readOptionPrintStrikeBuckets({
      bucketMinutes: input.bucketMinutes,
      ...range,
      symbol: input.symbol,
    }),
    repository.readOptionPrintSlotPrices({
      bucketMinutes: input.bucketMinutes,
      ...range,
      symbol: input.symbol,
    }),
    repository.optionGaps(input.symbol),
    repository.latestSamples(input.symbol, ["options"]),
  ]);
  return {
    ...samples,
    bucketMinutes: input.bucketMinutes,
    buckets,
    gaps,
    now,
    session,
    slotPrices,
    symbol: input.symbol,
  };
};

const strikeHeatmap = api.flow.strikeHeatmap
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowStrikeHeatmapRows(repository, input, now)
    );
    return assemble(failures, buildFlowStrikeHeatmap, rows);
  });

const readFlowOptionBubblesRows = async (
  repository: FlowRepository,
  input: FlowOptionBubblesParsedInput,
  now: Date
): Promise<FlowOptionBubblesRows> => {
  const newest = await repository.newestOptionPrintAt(input.symbol);
  const session = newest === null ? null : flowSessionDate(newest);
  if (session === null) {
    const samples = await repository.latestSamples(input.symbol, ["options"]);
    return {
      ...samples,
      gaps: [],
      minPremiumUsd: input.minPremiumUsd,
      minutes: [],
      now,
      prints: [],
      session: null,
      symbol: input.symbol,
    };
  }
  const range = optionsSessionRange(session);
  const [minutes, prints, gaps, samples] = await Promise.all([
    repository.readOptionPrintMinutes({ ...range, symbol: input.symbol }),
    repository.readLargeOptionPrints({
      ...range,
      limit: FLOW_OPTION_BUBBLES_MAX_BUBBLES + 1,
      minPremiumUsd: input.minPremiumUsd,
      symbol: input.symbol,
    }),
    repository.optionGaps(input.symbol),
    repository.latestSamples(input.symbol, ["options"]),
  ]);
  return {
    ...samples,
    gaps,
    minPremiumUsd: input.minPremiumUsd,
    minutes,
    now,
    prints,
    session,
    symbol: input.symbol,
  };
};

const optionBubbles = api.flow.optionBubbles
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowOptionBubblesRows(repository, input, now)
    );
    return assemble(failures, buildFlowOptionBubbles, rows);
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

/**
 * The checks of the future's streamed tape against IBKR history over the futures session; a
 * failed read (for example before migration 0101) never fails the document.
 */
const readTapeAudits = async (
  flow: FlowRepository,
  symbol: "ES" | "NQ",
  range: Readonly<{ from: Date; to: Date }>
): Promise<FlowControlRows["tapeAudits"]> => {
  try {
    return await flow.readTapeAudits({ ...range, symbol });
  } catch {
    return null;
  }
};

type FlowControlRepositories = Readonly<{
  flow: FlowRepository;
  researchStudies: ResearchStudyRepository | undefined;
  openbb: OpenbbRepository | undefined;
}>;

/** Reads one index group's stored rows. */
const readFlowControlRows = async (
  repositories: FlowControlRepositories,
  input: FlowControlInput,
  now: Date
): Promise<FlowControlRows> => {
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
  return {
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
    tapeAudits: await readTapeAudits(
      flow,
      group.future as "ES" | "NQ",
      futures
    ),
    tapeEvents: window.events,
  };
};

/** Reads one index group's stored rows and assembles flow-control.v1. */
export const readFlowControl = async (
  repositories: FlowControlRepositories,
  input: FlowControlInput,
  now: Date
): Promise<FlowControl> =>
  buildFlowControl(await readFlowControlRows(repositories, input, now));

const control = api.flow.control
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const flow = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowControlRows(
        {
          flow,
          openbb: context.repositories.openbb,
          researchStudies: context.repositories.researchStudies,
        },
        input,
        now
      )
    );
    return assemble(failures, buildFlowControl, rows);
  });

const events = api.flow.events
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (!(Number.isFinite(fromMs) && Number.isFinite(toMs)) || fromMs > toMs)
      throw failures.BAD_REQUEST({
        message: "from and to must be valid ISO timestamps with from <= to",
      });
    const repository = repositoryFor(context, failures);
    const rows = await readRows(failures, () =>
      repository.readEvents({
        from: new Date(fromMs),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        limit: input.limit + 1,
        symbol: input.symbol,
        to: new Date(toMs),
      })
    );
    const truncated = rows.length > input.limit;
    const limited = truncated ? rows.slice(0, input.limit) : rows;
    return {
      events: limited.map(eventView),
      from: new Date(fromMs).toISOString(),
      schemaVersion: "flow-events.v1" as const,
      symbol: input.symbol,
      to: new Date(toMs).toISOString(),
      truncated,
    };
  });

const liquidityHeatmap = api.flow.liquidityHeatmap
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowLiquidityHeatmapRows(
        repository,
        input as FlowLiquidityHeatmapParsedInput,
        now
      )
    );
    return assemble(failures, buildFlowLiquidityHeatmapFromRows, rows);
  });

const liveDomDepsFor = (
  context: ApiContext,
  failures: Failures
): FlowLiveDomDeps => {
  const repository = repositoryFor(context, failures);
  const marketHistory = context.marketHistory ?? null;
  return {
    fetchDom:
      marketHistory === null
        ? null
        : (input, options) => fetchMarketDom(marketHistory, input, options),
    now: clock,
    repository,
  };
};

const liveDom = api.flow.liveDom
  .use(requireOperator)
  .handler(async ({ context, input, errors, signal }) => {
    const failures = errors as unknown as Failures;
    const deps = liveDomDepsFor(context, failures);
    return await readRows(failures, () =>
      readFlowLiveDomSnapshot(deps, input as FlowLiveDomParsedInput, signal)
    );
  });

const liveDomStream = api.flow.liveDomStream
  .use(requireOperator)
  .handler(async ({ context, input, errors, signal }) => {
    const failures = errors as unknown as Failures;
    const deps = liveDomDepsFor(context, failures);
    return await readRows(failures, () =>
      openFlowLiveDomStream(deps, input as FlowLiveDomStreamParsedInput, signal)
    );
  });

const optionPrints = api.flow.optionPrints
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowOptionPrintsRows(
        repository,
        input as FlowOptionPrintsParsedInput,
        now
      )
    );
    return assemble(failures, buildFlowOptionPrints, rows);
  });

const tradeBubbles = api.flow.tradeBubbles
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowTradeBubblesRows(
        repository,
        input as FlowTradeBubblesParsedInput,
        now
      )
    );
    return assemble(failures, buildFlowTradeBubblesFromRows, rows);
  });

const readFlowOffExchangeLevelsRows = async (
  repositories: Readonly<{
    flow: FlowRepository;
    openbb: OpenbbRepository | undefined;
  }>,
  input: FlowOffExchangeLevelsParsedInput,
  now: Date
): Promise<FlowOffExchangeLevelsRows> => {
  const newest = await repositories.flow.newestMinuteAt(input.symbol);
  const anchorSession = newest === null ? null : flowSessionDate(newest);
  const finraFrom = offExchangeFinraFromDate(
    anchorSession ?? newYorkClock(now).day
  );
  const readFinra = () =>
    repositories.openbb === undefined
      ? Promise.resolve([])
      : repositories.openbb.otcWeekly(input.symbol, finraFrom);

  if (anchorSession === null) {
    const [samples, finraRows] = await Promise.all([
      repositories.flow.latestSamples(input.symbol, ["ticks"]),
      readFinra(),
    ]);
    return {
      ...samples,
      anchorSession: null,
      events: [],
      finraRows,
      minutes: [],
      now,
      range: input.range,
      symbol: input.symbol,
      truncated: false,
      windowEnd: null,
      windowStart: null,
    };
  }

  const window = offExchangeWindowRange(anchorSession, input.range);
  const [minutes, rawEvents, samples, finraRows] = await Promise.all([
    repositories.flow.readMinutes({
      from: window.from,
      symbol: input.symbol,
      to: window.to,
    }),
    repositories.flow.readEvents({
      from: window.from,
      kinds: ["off_exchange_print"],
      limit: OFF_EXCHANGE_READ_CAP + 1,
      symbol: input.symbol,
      to: new Date(window.to.getTime() - 1),
    }),
    repositories.flow.latestSamples(input.symbol, ["ticks"]),
    readFinra(),
  ]);
  const truncated = rawEvents.length > OFF_EXCHANGE_READ_CAP;
  return {
    ...samples,
    anchorSession,
    events: truncated ? rawEvents.slice(0, OFF_EXCHANGE_READ_CAP) : rawEvents,
    finraRows,
    minutes,
    now,
    range: input.range,
    symbol: input.symbol,
    truncated,
    windowEnd: window.to,
    windowStart: window.from,
  };
};

const offExchangeLevels = api.flow.offExchangeLevels
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const flow = repositoryFor(context, failures);
    const now = clock();
    const rows = await readRows(failures, () =>
      readFlowOffExchangeLevelsRows(
        { flow, openbb: context.repositories.openbb },
        input as FlowOffExchangeLevelsParsedInput,
        now
      )
    );
    return assemble(failures, buildFlowOffExchangeLevels, rows);
  });

export const flowRouter = {
  collect,
  control,
  events,
  hedgingPressure,
  liquidityHeatmap,
  liveDom,
  liveDomStream,
  offExchangeLevels,
  optionBubbles,
  optionPrints,
  putCallRatio,
  snapshot,
  strikeHeatmap,
  tapeSpeed,
  tradeBubbles,
};
