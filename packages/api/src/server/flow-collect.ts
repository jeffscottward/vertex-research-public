// What: one flow.collect run. For each symbol and source that is due, sample IBKR ticks and depth
// (through vertex-history) and QuantData options flow and GEX, derive per-minute features and
// events, and store them. Sampled ingest inside the IBKR historical budget (6 requests per 120 s,
// shared with /charts): one tick fetch (two historical requests) per symbol about every 4 minutes,
// staggered so the two symbols never fetch in the same ~2 minutes, and only while at most 2 of the
// 6 slots are in use, so /charts keeps at least 2 free. Depth uses its own subscription pacer.
// Research only: nothing here places, changes or cancels orders. Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowOptionGapRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";

import {
  FLOW_SYMBOLS,
  type FlowCollectOutput,
  type FlowCollectParsedInput,
  type FlowOptionTicker,
  type FlowSampleStatus,
  type FlowSource,
  type FlowSymbol,
} from "../contracts/flow.ts";
import type {
  MarketDepthOutput,
  MarketTicksOutput,
} from "../contracts/market-data.ts";
import type { OptionsAnalyticsOutput } from "../contracts/options-analytics.ts";
import {
  buildBook,
  buildMinuteFeatures,
  FLOW_INSTRUMENTS,
  type FlowEventRow,
  type FlowInstrument,
} from "../flow-features.ts";
import { optionEvents, parseOptionPrints } from "../flow-options.ts";
import { signTrades } from "../flow-trade-signing.ts";
import { flowSessionOpen } from "./flow-snapshot.ts";
import type { MarketHistoryPacing } from "./market-data.ts";
import type { QuantDataClient } from "./quantdata-client.ts";

/** A source is due again this many seconds after its last attempt (any status). */
export const FLOW_DUE_SECONDS: Readonly<Record<FlowSource, number>> = {
  depth: 50,
  gex: 840,
  options: 110,
  ticks: 230,
};
/** No tick fetch (any symbol) within this many seconds of another one. */
const FLOW_TICKS_STAGGER_SECONDS = 110;
/** Fetch ticks only while the IBKR 120 s window holds at most this many requests (of 6). */
const FLOW_IBKR_MAX_RECENT = 2;
export const FLOW_TICKS_COUNT = 1000;
export const FLOW_DEPTH_ROWS = 10;
/** QuantData pages for the new options window of one symbol per run. */
export const FLOW_OPTION_PAGES_MAX = 6;
/**
 * QuantData pages per symbol and run in total: the new window first, stored gaps get the rest (at
 * least 2). Both symbols: at most 16 requests per ~2 minutes, inside the vertex-web QuantData budget
 * (30 per minute, shared with /charts) and the account limit (240 per 60 s).
 */
export const FLOW_OPTION_RUN_PAGES_MAX = 8;
export const FLOW_OPTION_LOOKBACK_MS = 15 * 60_000;
export const FLOW_SEED_OPTION_LOOKBACK_MS = 72 * 3_600_000;
export const FLOW_RETENTION_DAYS = 14;
/** The caller prunes at most once per this interval (deps.pruneDue). */
export const FLOW_PRUNE_INTERVAL_MS = 3_600_000;

const DEFAULT_MIN_TICK: Readonly<Record<FlowSymbol, number>> = {
  ES: 0.25,
  SPY: 0.01,
};

export type FlowCollectDeps = Readonly<{
  now: Date;
  repository: FlowRepository;
  ticks: (instrument: FlowInstrument) => Promise<MarketTicksOutput>;
  depth: (instrument: FlowInstrument) => Promise<MarketDepthOutput>;
  pacing: () => Promise<MarketHistoryPacing>;
  /** Delete rows older than the retention cutoff in this run. */
  pruneDue: boolean;
  quantData: QuantDataClient | null;
  analytics:
    | ((ticker: FlowOptionTicker) => Promise<OptionsAnalyticsOutput>)
    | null;
}>;

type Run = FlowCollectOutput["runs"][number];
type Attempt = Readonly<{
  status: FlowSampleStatus;
  items: number;
  events: number;
  message: string | null;
  /** false: reported in the run output only (not due, closed, budget), not stored as a sample. */
  record: boolean;
}>;

/** State shared by the sources of one run. */
interface RunState {
  readonly deps: FlowCollectDeps;
  readonly dryRun: boolean;
  /** Operator backfill: no session or due checks, longer options look-back. */
  readonly seed: boolean;
  /** Newest attempt per symbol and source (stored samples). */
  readonly last: Map<string, Date>;
  pacing: MarketHistoryPacing | null | undefined;
  /** Symbol price from this run's depth or ticks (for the ES − SPX basis). */
  readonly prices: Map<FlowSymbol, number>;
}

const sampleKey = (symbol: FlowSymbol, source: FlowSource) =>
  `${symbol}:${source}`;

const notDue = (message: string): Attempt => ({
  events: 0,
  items: 0,
  message,
  record: false,
  status: "skipped",
});

const failed = (error: unknown): Attempt => ({
  events: 0,
  items: 0,
  message: (error instanceof Error ? error.message : "request failed").slice(
    0,
    300
  ),
  record: true,
  status: "unavailable",
});

const secondsSince = (state: RunState, at: Date | undefined): number =>
  at === undefined
    ? Number.POSITIVE_INFINITY
    : (state.deps.now.getTime() - at.getTime()) / 1000;

const store = async <T>(
  state: RunState,
  rows: readonly T[],
  write: (rows: readonly T[]) => Promise<number>
): Promise<number> => (state.dryRun ? rows.length : await write(rows));

const storeEvents = (state: RunState, events: readonly FlowEventRow[]) =>
  store(state, events, (rows) => state.deps.repository.insertEvents(rows));

const historyPacing = async (
  state: RunState
): Promise<MarketHistoryPacing | null> => {
  if (state.pacing === undefined) {
    try {
      state.pacing = await state.deps.pacing();
    } catch {
      state.pacing = null;
    }
  }
  return state.pacing;
};

/** Why a tick fetch must wait (budget, stagger), or null when it may go (its requests then count). */
const ticksBlocked = async (state: RunState): Promise<string | null> => {
  const lastTicks = Math.min(
    ...FLOW_SYMBOLS.map((symbol) =>
      secondsSince(state, state.last.get(sampleKey(symbol, "ticks")))
    )
  );
  if (!state.seed && lastTicks < FLOW_TICKS_STAGGER_SECONDS)
    return `staggered: another tick sample ${Math.round(lastTicks)} s ago`;
  const pacing = await historyPacing(state);
  if (pacing === null) return "IBKR pacing unknown (history health failed)";
  if (pacing.backoffSeconds > 0)
    return `IBKR pacing back-off, ${pacing.backoffSeconds} s left`;
  if (pacing.recentRequests > FLOW_IBKR_MAX_RECENT)
    return `IBKR window busy (${pacing.recentRequests}/6 in 120 s); /charts has priority`;
  // Count the two historical requests (TRADES, BID_ASK) against the window for the next symbol.
  state.pacing = { ...pacing, recentRequests: pacing.recentRequests + 2 };
  return null;
};

const collectTicks = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  const blocked = await ticksBlocked(state);
  if (blocked !== null) return notDue(blocked);
  state.last.set(sampleKey(instrument.symbol, "ticks"), state.deps.now);
  let output: MarketTicksOutput;
  try {
    output = await state.deps.ticks(instrument);
  } catch (error) {
    return failed(error);
  }
  const signed = signTrades(output.trades, output.quotes);
  const minTick = output.minTick ?? DEFAULT_MIN_TICK[instrument.symbol];
  const features = buildMinuteFeatures(instrument, signed, minTick);
  const last = features.minutes.at(-1);
  if (last) state.prices.set(instrument.symbol, last.close);
  const items = await store(state, features.minutes, (rows) =>
    state.deps.repository.upsertMinutes(rows)
  );
  const events = await storeEvents(state, features.events);
  const first = signed[0];
  const span =
    first === undefined
      ? "no prints"
      : `${signed.length} prints, ${new Date(first.t * 1000).toISOString()} to ${output.asOf}`;
  return {
    events,
    items,
    message: `${span}${output.cache.hit ? " (cache)" : ""}`,
    record: true,
    status: signed.length > 0 ? "ok" : "empty",
  };
};

const collectDepth = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  let output: MarketDepthOutput;
  try {
    output = await state.deps.depth(instrument);
  } catch (error) {
    return failed(error);
  }
  const book = buildBook(
    instrument.symbol,
    state.deps.now,
    output.bids,
    output.asks,
    output.sizeMultiplier
  );
  if (book.bestBid !== null && book.bestAsk !== null)
    state.prices.set(instrument.symbol, (book.bestBid + book.bestAsk) / 2);
  const empty = book.levels === 0;
  const items = empty
    ? 0
    : await store(state, [book], (rows) =>
        state.deps.repository.insertBooks(rows)
      );
  const missing = output.venues?.missing ?? [];
  return {
    events: 0,
    items,
    message: `${book.levels} levels${missing.length > 0 ? `; no depth subscription for ${missing.join(", ")}` : ""}`,
    record: true,
    status: empty ? "empty" : "ok",
  };
};

type OptionPage = Readonly<{
  data: unknown;
  next: unknown[] | null;
}>;

/** One QuantData flow query over [start, end] (inclusive), newest first, until done or `maxPages`. */
const fetchOptionPages = async (
  client: QuantDataClient,
  ticker: FlowOptionTicker,
  start: Date,
  end: Date,
  maxPages: number
): Promise<Readonly<{ pages: OptionPage[]; capped: boolean }> | string> => {
  const pages: OptionPage[] = [];
  let searchAfter: unknown[] | null = null;
  do {
    const result = await client.request(
      "orderFlow",
      {
        filter: { ticker },
        ...(searchAfter === null ? {} : { searchAfter }),
        timeRange: {
          endTime: end.toISOString(),
          startTime: start.toISOString(),
        },
      },
      30_000
    );
    if (!result.ok) {
      if (pages.length === 0) return result.message;
      break;
    }
    const next = result.body["nextSearchAfter"];
    searchAfter = Array.isArray(next) ? next : null;
    pages.push({ data: result.data, next: searchAfter });
  } while (searchAfter !== null && pages.length < maxPages);
  return { capped: searchAfter !== null, pages };
};

type OptionFetch = Readonly<{
  pages: number;
  prints: number;
  skipped: number;
  items: number;
  events: number;
  /** More prints are left in the range (page cap, or a later page failed). */
  capped: boolean;
  /** Oldest fetched print time; a capped range resumes there. */
  oldest: Date | null;
}>;

/** Fetches one range and stores its prints and events (insert-once by print id). */
const fetchAndStoreOptions = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  start: Date,
  end: Date,
  maxPages: number
): Promise<OptionFetch | string> => {
  const fetched = await fetchOptionPages(
    client,
    instrument.optionsTicker,
    start,
    end,
    maxPages
  );
  if (typeof fetched === "string") return fetched;
  const parsed = fetched.pages.map((page) =>
    parseOptionPrints(page.data, instrument.symbol, instrument.optionsTicker)
  );
  const prints = parsed.flatMap((page) => page.prints);
  const items = await store(state, prints, (rows) =>
    state.deps.repository.insertOptionPrints(rows)
  );
  const events = await storeEvents(
    state,
    optionEvents(prints, instrument.optionEventPremium)
  );
  return {
    capped: fetched.capped,
    events,
    items,
    oldest:
      prints.length === 0
        ? null
        : new Date(
            Math.min(...prints.map((print) => print.tradedAt.getTime()))
          ),
    pages: fetched.pages.length,
    prints: prints.length,
    skipped: parsed.reduce((total, page) => total + page.skipped, 0),
  };
};

/**
 * The new end of a capped range [start, end]: its oldest fetched print (inclusive again, so prints
 * sharing that time are not lost; stored ids are skipped), and at least 1 ms below `end` so every
 * resume moves on. Null: nothing is left before `start`, or the capped pages held no valid print.
 */
const resumeEnd = (
  start: Date,
  end: Date,
  oldest: Date | null
): Date | null => {
  if (oldest === null) return null;
  const next = Math.min(oldest.getTime(), end.getTime() - 1);
  return next < start.getTime() ? null : new Date(next);
};

type GapWork = Readonly<{ gap: FlowOptionGapRecord; stored: boolean }>;

type GapResume = Readonly<{
  pages: number;
  prints: number;
  skipped: number;
  items: number;
  events: number;
  closed: number;
  left: number;
  error: string | null;
}>;

/**
 * Reads unfetched ranges newest first within `budget` pages. A range read completely is deleted;
 * a capped one is saved with its end moved back to the oldest fetched print; ranges this run did
 * not reach stay (new ones are saved). Dry runs write nothing.
 */
const resumeOptionGaps = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  gaps: readonly GapWork[],
  budget: number
): Promise<GapResume> => {
  const { repository } = state.deps;
  const pending = [...gaps];
  const total = { events: 0, items: 0, pages: 0, prints: 0, skipped: 0 };
  let closed = 0;
  let error: string | null = null;
  const save = async (gap: FlowOptionGapRecord) => {
    if (!state.dryRun) await repository.saveOptionGap(gap);
  };
  for (let work = pending[0]; work !== undefined; work = pending[0]) {
    if (total.pages >= budget) break;
    const fetched = await fetchAndStoreOptions(
      state,
      client,
      instrument,
      work.gap.startTime,
      work.gap.endTime,
      budget - total.pages
    );
    if (typeof fetched === "string") {
      error = fetched;
      break;
    }
    pending.shift();
    total.pages += fetched.pages;
    total.prints += fetched.prints;
    total.skipped += fetched.skipped;
    total.items += fetched.items;
    total.events += fetched.events;
    const end = fetched.capped
      ? resumeEnd(work.gap.startTime, work.gap.endTime, fetched.oldest)
      : null;
    if (end !== null) {
      const gap = { ...work.gap, endTime: end };
      await save(gap);
      pending.unshift({ gap, stored: true });
      // Capped: the budget is spent, or a later page failed (retry next run).
      break;
    }
    if (work.stored && !state.dryRun)
      await repository.deleteOptionGap(work.gap.symbol, work.gap.startTime);
    closed += 1;
  }
  for (const work of pending) if (!work.stored) await save(work.gap);
  return { ...total, closed, error, left: pending.length };
};

type OptionWindow = Readonly<{
  fetched: OptionFetch;
  notes: string[];
  /** The older part of a capped window, not stored yet. */
  gap: FlowOptionGapRecord | null;
}>;

/** The new window, from the newest stored print (inside the look-back) to now. */
const readOptionWindow = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  newest: Date | null
): Promise<OptionWindow | string> => {
  const { now } = state.deps;
  const floor = new Date(
    now.getTime() -
      (state.seed ? FLOW_SEED_OPTION_LOOKBACK_MS : FLOW_OPTION_LOOKBACK_MS)
  );
  const since = newest !== null && newest > floor ? newest : floor;
  const fetched = await fetchAndStoreOptions(
    state,
    client,
    instrument,
    since,
    now,
    FLOW_OPTION_PAGES_MAX
  );
  if (typeof fetched === "string") return fetched;
  const notes = [
    `${fetched.prints} prints on ${fetched.pages} page(s) since ${since.toISOString()}`,
  ];
  let gap: FlowOptionGapRecord | null = null;
  if (fetched.capped) {
    const end = resumeEnd(since, now, fetched.oldest);
    if (end !== null)
      gap = {
        createdAt: now,
        endTime: end,
        startTime: since,
        symbol: instrument.symbol,
      };
    const reason =
      fetched.pages >= FLOW_OPTION_PAGES_MAX
        ? `page cap ${FLOW_OPTION_PAGES_MAX} reached`
        : `page ${fetched.pages + 1} failed`;
    notes.push(
      gap === null
        ? `${reason}, older prints not tracked (no valid row on the fetched pages)`
        : `${reason}, older prints of this window queued as a gap`
    );
  }
  if (fetched.skipped > 0)
    notes.push(`${fetched.skipped} rows failed the schema`);
  return { fetched, gap, notes };
};

const NO_WINDOW: OptionWindow = {
  fetched: {
    capped: false,
    events: 0,
    items: 0,
    oldest: null,
    pages: 0,
    prints: 0,
    skipped: 0,
  },
  gap: null,
  notes: ["market closed, gaps only"],
};

/**
 * Options flow for one symbol. While the options session is open: the new window (from the newest
 * stored print) first, at most FLOW_OPTION_PAGES_MAX pages; a capped window queues its older part
 * as a gap. Then stored gaps, newest first, with the rest of FLOW_OPTION_RUN_PAGES_MAX. After the
 * close the run reads gaps only, until none are left.
 */
const collectOptions = async (
  state: RunState,
  instrument: FlowInstrument,
  open: boolean
): Promise<Attempt> => {
  const client = state.deps.quantData;
  if (client === null) return notDue("QuantData not configured");
  const { repository } = state.deps;
  let stored: FlowOptionGapRecord[];
  let newest: Date | null = null;
  try {
    stored = await repository.optionGaps(instrument.symbol);
    if (open) newest = await repository.newestOptionPrintAt(instrument.symbol);
  } catch (error) {
    return failed(error);
  }
  if (!open && stored.length === 0) return notDue("market closed");
  const window = open
    ? await readOptionWindow(state, client, instrument, newest)
    : NO_WINDOW;
  if (typeof window === "string") return failed(new Error(window));
  const gaps: GapWork[] = [
    ...(window.gap === null ? [] : [{ gap: window.gap, stored: false }]),
    ...stored.map((gap) => ({ gap, stored: true })),
  ];
  const notes = [...window.notes];
  let resumed: GapResume | null = null;
  if (gaps.length > 0) {
    resumed = await resumeOptionGaps(
      state,
      client,
      instrument,
      gaps,
      FLOW_OPTION_RUN_PAGES_MAX - window.fetched.pages
    );
    if (!open && resumed.pages === 0 && resumed.error !== null)
      return failed(new Error(`gaps: ${resumed.error}`));
    notes.push(
      `gaps: ${resumed.prints} prints on ${resumed.pages} page(s), ${resumed.closed} closed, ${resumed.left} left`
    );
    if (resumed.skipped > 0)
      notes.push(`${resumed.skipped} gap rows failed the schema`);
    if (resumed.error !== null)
      notes.push(`gap fetch failed: ${resumed.error.slice(0, 80)}`);
  }
  const prints = window.fetched.prints + (resumed?.prints ?? 0);
  return {
    events: window.fetched.events + (resumed?.events ?? 0),
    items: window.fetched.items + (resumed?.items ?? 0),
    message: notes.join("; ").slice(0, 300),
    record: true,
    status: prints > 0 ? "ok" : "empty",
  };
};

const gexBasis = (
  state: RunState,
  instrument: FlowInstrument,
  spot: number | null
) => {
  if (instrument.symbol === "SPY") return 0;
  const price = state.prices.get(instrument.symbol);
  return price === undefined || spot === null ? null : price - spot;
};

const collectGex = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  const { analytics } = state.deps;
  if (analytics === null) return notDue("QuantData not configured");
  let output: OptionsAnalyticsOutput;
  try {
    output = await analytics(instrument.optionsTicker);
  } catch (error) {
    return failed(error);
  }
  const { context, exposure } = output;
  if (exposure.status !== "ok" || context.regime === "unknown")
    return {
      events: 0,
      items: 0,
      message: exposure.message ?? "No GEX estimate (regime unknown)",
      record: true,
      status: exposure.status === "unavailable" ? "unavailable" : "empty",
    };
  const basis = gexBasis(state, instrument, output.spot);
  const items = await store(
    state,
    [
      {
        at: state.deps.now,
        basis,
        callWall: context.levels.callWall,
        flip: context.levels.flip,
        ivRegime: context.iv.regime,
        maxPain: exposure.maxPain,
        netDex: context.greeks.netDex,
        putWall: context.levels.putWall,
        regime: context.regime,
        spot: output.spot,
        symbol: instrument.symbol,
        ticker: instrument.optionsTicker,
        totalGex: exposure.totalGex,
        zeroDteShare: context.flow.zeroDteShare,
      },
    ],
    (rows) => state.deps.repository.insertGex(rows)
  );
  return {
    events: 0,
    items,
    message: `${context.regime} gamma${basis === null ? "; basis unknown" : ""}`,
    record: true,
    status: "ok",
  };
};

// Depth before GEX, so the ES − SPX basis can use this run's book.
const SOURCE_ORDER: readonly FlowSource[] = [
  "depth",
  "ticks",
  "options",
  "gex",
];

const COLLECTORS: Readonly<
  Record<
    FlowSource,
    (state: RunState, instrument: FlowInstrument) => Promise<Attempt>
  >
> = {
  depth: collectDepth,
  gex: collectGex,
  options: (state, instrument) => collectOptions(state, instrument, true),
  ticks: collectTicks,
};

const attempt = async (
  state: RunState,
  instrument: FlowInstrument,
  source: FlowSource
): Promise<Attempt> => {
  if (state.seed) return await COLLECTORS[source](state, instrument);
  const open = flowSessionOpen(source, instrument.symbol, state.deps.now);
  // Options keep reading their unfetched gaps after the close; without gaps collectOptions answers
  // "market closed" before any QuantData request.
  if (!open && source !== "options") return notDue("market closed");
  const age = secondsSince(
    state,
    state.last.get(sampleKey(instrument.symbol, source))
  );
  if (age < FLOW_DUE_SECONDS[source])
    return notDue(`not due (last attempt ${Math.round(age)} s ago)`);
  return open
    ? await COLLECTORS[source](state, instrument)
    : await collectOptions(state, instrument, false);
};

const lastAttempts = async (
  repository: FlowRepository,
  symbols: readonly FlowSymbol[]
): Promise<Map<string, Date>> => {
  const last = new Map<string, Date>();
  for (const symbol of symbols) {
    const { latest } = await repository.latestSamples(symbol);
    for (const sample of latest)
      last.set(sampleKey(symbol, sample.source), sample.at);
  }
  return last;
};

const recordSample = async (
  state: RunState,
  symbol: FlowSymbol,
  source: FlowSource,
  result: Attempt
): Promise<void> => {
  if (state.dryRun || !result.record) return;
  const sample: FlowSampleRecord = {
    at: state.deps.now,
    items: result.items,
    message: result.message,
    source,
    status: result.status,
    symbol,
  };
  await state.deps.repository.recordSample(sample);
};

const pruneIfDue = async (state: RunState): Promise<number> => {
  const { now, repository } = state.deps;
  if (state.dryRun || !state.deps.pruneDue) return 0;
  return await repository.prune(
    new Date(now.getTime() - FLOW_RETENTION_DAYS * 86_400_000)
  );
};

export const runFlowCollect = async (
  input: FlowCollectParsedInput,
  deps: FlowCollectDeps
): Promise<FlowCollectOutput> => {
  const symbols = input.symbols ?? [...FLOW_SYMBOLS];
  const state: RunState = {
    deps,
    dryRun: input.dryRun,
    last: await lastAttempts(deps.repository, FLOW_SYMBOLS),
    pacing: undefined,
    prices: new Map(),
    seed: input.seed,
  };
  const runs: Run[] = [];
  for (const source of SOURCE_ORDER)
    for (const symbol of symbols) {
      const result = await attempt(state, FLOW_INSTRUMENTS[symbol], source);
      await recordSample(state, symbol, source, result);
      runs.push({
        events: result.events,
        items: result.items,
        message: result.message,
        source,
        status: result.status,
        symbol,
      });
    }
  return {
    at: deps.now.toISOString(),
    busy: false,
    dryRun: input.dryRun,
    pruned: await pruneIfDue(state),
    runs,
  };
};
