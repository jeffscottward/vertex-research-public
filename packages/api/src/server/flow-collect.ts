// What: one flow.collect run. For each symbol and source that is due, sample IBKR ticks and depth
// (through vertex-history) and QuantData options flow and GEX, derive per-minute features and
// events, and store them. Sampled ingest inside the IBKR historical budget (6 requests per 120 s,
// shared with /charts): one tick fetch (two historical requests) per sampled symbol about every
// 6 minutes (one tick turn: SPY), staggered so two sampled symbols never fetch in the same
// ~2 minutes, and only while at most 2 of the
// 6 slots are in use, so /charts keeps at least 2 free. Depth uses its own subscription pacer.
// ES and NQ read the streamed tape of vertex-history every minute (collectTape): it sends no IBKR
// request, so it has no pacing gate and does not count in the IBKR budget.
// Research only: nothing here places, changes or cancels orders. Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowOptionGapRecord,
  FlowPruneTable,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";

import {
  FLOW_EXPIRY_PARTS,
  FLOW_FILTER_PROFILE,
  FLOW_STORAGE_FAILURE_PREFIX,
  FLOW_SYMBOLS,
  type FlowCollectOutput,
  type FlowCollectParsedInput,
  type FlowExpiryPart,
  type FlowGroupId,
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
import { deepTradesOf } from "../flow-deep-trades.ts";
import {
  buildBook,
  buildMinuteFeatures,
  FLOW_INSTRUMENTS,
  type FlowEventRow,
  type FlowGroup,
  type FlowInstrument,
} from "../flow-features.ts";
import {
  type FlowNetDriftBucket,
  type FlowNetDriftRow,
  netDriftRequest,
  newestBucketAt,
  parseNetDrift,
} from "../flow-net-drift.ts";
import {
  type FlowOptionPrintRow,
  oldestRowTime,
  optionEvents,
  parseOptionPrints,
} from "../flow-options.ts";
import {
  countSigning,
  type SignedTrade,
  signTape,
  signTrades,
  type TapePrint,
} from "../flow-trade-signing.ts";
import {
  flowClockText,
  flowSessionDate,
  flowSessionOpen,
} from "./flow-snapshot.ts";
import type { MarketHistoryPacing, MarketTape } from "./market-data.ts";
import type { QuantDataClient, QuantDataResult } from "./quantdata-client.ts";

/** A source is due again this many seconds after its last attempt (any status). */
export const FLOW_DUE_SECONDS: Readonly<Record<FlowSource, number>> = {
  depth: 50,
  gex: 840,
  /** Due on every run; netDriftTurn alone sets the cadence, each group on alternate minutes. */
  net_drift: 0,
  options: 110,
  /**
   * Sampled ticks (one tick turn: SPY; ES and NQ read the streamed tape, FLOW_TAPE_DUE_SECONDS).
   * With the 60 s timer, 350 s gives one sample about every 360 s and stays below the starved
   * limit (410 s).
   */
  ticks: 350,
};
/**
 * The streamed tape of a symbol is due again this many seconds after its last read. The timer runs
 * every 60 s, so the tape is read on every run.
 */
export const FLOW_TAPE_DUE_SECONDS = 50;
/**
 * The most answers of one tape read. One answer holds at most 20,000 prints (a single second is
 * never split), so 12 answers hold more than the ring of 200,000 prints. A read that still has
 * more after them is a failed request.
 */
export const FLOW_TAPE_MAX_ANSWERS = 12;
/**
 * A tape read starts this many seconds before the minute of the last stored ok sample (twice this
 * before the present minute without one, tapeCursor). The minute that is read again heals a minute
 * that a print reached late.
 */
export const FLOW_TAPE_REREAD_SECONDS = 60;
/**
 * A tape read starts at most this many seconds before the present minute. Without the limit, the
 * first run after a collector or database outage of hours would read the whole ring in one
 * request; when that request fails, no sample is stored and each later run repeats a larger read.
 * The limit bounds the work of one run. Minutes before the limit are not read back: they stay a
 * gap. A catch-up from the newest stored minute is a future improvement.
 */
export const FLOW_TAPE_LOOKBACK_SECONDS = 600;
/** No sampled tick fetch (any sampled symbol) within this many seconds of another one. */
export const FLOW_TICKS_STAGGER_SECONDS = 110;
/**
 * Fetch ticks only while the IBKR 120 s window holds at most this many requests (of 6). A starved
 * symbol (FLOW_TICKS_STARVED_SECONDS) has a higher limit.
 */
const FLOW_IBKR_MAX_RECENT = 2;
/**
 * A symbol whose newest tick attempt (ok, empty or unavailable) is older than this is starved and
 * stops yielding to /charts: it fetches as soon as the window has room for its two requests. Without
 * this limit a steady client (a bar backfill at 3 to 4 requests per 120 s) kept every tick sample
 * out for hours. The one tick turn (SPY) is due every 350 s and the 60 s timer starts it about
 * every 360 s, which is below 410 s, so a symbol is starved only when its normal turn was missed,
 * and it still gets a sample before /flow calls ticks stale (FLOW_STALE_SECONDS.ticks, 600 s). The
 * turn guard test of flow-collect.test.ts fails when the turns no longer fit below 410 s. A failed
 * starved fetch is an attempt too: the symbol then yields again for 410 s and does not retry every
 * minute.
 */
export const FLOW_TICKS_STARVED_SECONDS = 410;
/** The vertex-history limit (6 per 120 s) minus the two requests of one tick fetch. */
const FLOW_IBKR_MAX_RECENT_STARVED = 4;
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
/**
 * Retention per table. flow_minutes keeps 730 days, like deep trades and net drift, so a later
 * study can replay the futures state of every streamed session. A rollback to a version that keeps
 * 14 days prunes the older minute rows.
 */
export const FLOW_RETENTION_DAYS: Readonly<Record<FlowPruneTable, number>> = {
  flow_book: 14,
  flow_events: 14,
  flow_gex: 14,
  flow_large_trades: 730,
  flow_minutes: 730,
  flow_net_drift: 730,
  flow_option_gaps: 14,
  flow_option_prints: 14,
  flow_samples: 14,
};
/**
 * Collector calls leave 6 of the shared client's 30 starts per 60 s free, so two /charts option reads
 * of 3 requests each always fit; the client holds the window (withCallerReserve).
 */
export const FLOW_QUANTDATA_CALLER_RESERVE = 6;
/** One GEX estimate sends three QuantData requests; one estimate runs per run. */
const FLOW_GEX_REQUESTS_PER_RUN = 3;
/** One net drift read per symbol sends two requests: total and zero_dte. */
const FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL = 2;
/** QuantData worst case of one source for one symbol; a source with less free starts is skipped. */
const FLOW_QUANTDATA_SOURCE_MAX: Readonly<Partial<Record<FlowSource, number>>> =
  {
    gex: FLOW_GEX_REQUESTS_PER_RUN,
    net_drift: FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL,
    options: FLOW_OPTION_RUN_PAGES_MAX,
  };
/** The IBKR history window of vertex-history: 6 requests per 120 s. */
export const FLOW_IBKR_LIMIT = 6;
/** The caller prunes at most once per this interval (deps.pruneDue). */
export const FLOW_PRUNE_INTERVAL_MS = 3_600_000;

export type FlowCollectDeps = Readonly<{
  now: Date;
  repository: FlowRepository;
  ticks: (instrument: FlowInstrument) => Promise<MarketTicksOutput>;
  /** One answer of the streamed tape from the exchange second `since` (no IBKR request). */
  tape: (instrument: FlowInstrument, since: number) => Promise<MarketTape>;
  depth: (instrument: FlowInstrument) => Promise<MarketDepthOutput>;
  pacing: () => Promise<MarketHistoryPacing>;
  /** Delete rows older than the retention cutoff in this run. */
  pruneDue: boolean;
  quantData: QuantDataClient | null;
  analytics:
    | ((ticker: FlowOptionTicker) => Promise<OptionsAnalyticsOutput>)
    | null;
  /** Milliseconds since the run started (the budget line). */
  elapsedMs: () => number;
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
  /** true once one symbol ran its GEX estimate in this run. */
  gexDone: boolean;
  /** Newest attempt per symbol and source (stored samples). */
  readonly last: Map<string, Date>;
  /** Newest stored ok sample per symbol and source (the cursor of the streamed tape). */
  readonly lastOk: Map<string, Date>;
  pacing: MarketHistoryPacing | null | undefined;
  /** Symbol price from this run's depth or ticks (for the ES − SPX basis). */
  readonly prices: Map<FlowSymbol, number>;
  /** Operator backfill: no session or due checks, longer options look-back. */
  readonly seed: boolean;
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

/**
 * Tick turns: one turn per symbol that fetches trades and quotes (two IBKR requests each), in
 * FLOW_SYMBOLS order. The stagger lets one turn go per FLOW_TICKS_STAGGER_SECONDS. A symbol with
 * the streamed tape has no turn.
 */
export const flowTickTurns = (
  instruments: Readonly<Record<FlowSymbol, FlowInstrument>>
): readonly (readonly FlowSymbol[])[] =>
  FLOW_SYMBOLS.filter(
    (symbol) => instruments[symbol].ticks === "trades_and_quotes"
  ).map((symbol) => [symbol]);

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
const ticksBlocked = async (
  state: RunState,
  symbol: FlowSymbol
): Promise<string | null> => {
  // Sampled symbols only: a tape read sends no IBKR request and must not hold a sample back.
  const lastTicks = Math.min(
    ...FLOW_SYMBOLS.filter(
      (other) => FLOW_INSTRUMENTS[other].ticks === "trades_and_quotes"
    ).map((other) =>
      secondsSince(state, state.last.get(sampleKey(other, "ticks")))
    )
  );
  if (!state.seed && lastTicks < FLOW_TICKS_STAGGER_SECONDS)
    return `staggered: another tick sample ${Math.round(lastTicks)} s ago`;
  const pacing = await historyPacing(state);
  if (pacing === null) return "IBKR pacing unknown (history health failed)";
  if (pacing.backoffSeconds > 0)
    return `IBKR pacing back-off, ${pacing.backoffSeconds} s left`;
  // The operator seed always yields; a sampled symbol yields only while its last attempt is recent.
  const starved =
    !state.seed &&
    secondsSince(state, state.last.get(sampleKey(symbol, "ticks"))) >
      FLOW_TICKS_STARVED_SECONDS;
  if (starved && pacing.recentRequests > FLOW_IBKR_MAX_RECENT_STARVED)
    return `IBKR window full (${pacing.recentRequests}/6 in 120 s); no room for 2 requests`;
  if (!starved && pacing.recentRequests > FLOW_IBKR_MAX_RECENT)
    return `IBKR window busy (${pacing.recentRequests}/6 in 120 s); /charts has priority`;
  // Count the two historical requests (TRADES, BID_ASK) against the window for the next symbol.
  state.pacing = { ...pacing, recentRequests: pacing.recentRequests + 2 };
  return null;
};

const collectTicks = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  const blocked = await ticksBlocked(state, instrument.symbol);
  if (blocked !== null) return notDue(blocked);
  state.last.set(sampleKey(instrument.symbol, "ticks"), state.deps.now);
  let output: MarketTicksOutput;
  try {
    output = await state.deps.ticks(instrument);
  } catch (error) {
    return failed(error);
  }
  // vertex-history answers a paced-out request with its previous payload (up to 15 min old).
  if (output.cache.stale)
    return {
      events: 0,
      items: 0,
      message: `stale copy (${output.cache.ageSeconds} s old, request paced out); not stored`,
      record: true,
      status: "unavailable",
    };
  const signed = signTrades(output.trades, output.quotes);
  const minTick = output.minTick ?? instrument.minTick;
  const features = buildMinuteFeatures(instrument, signed, minTick);
  const last = features.minutes.at(-1);
  if (last) state.prices.set(instrument.symbol, last.close);
  const items = await store(state, features.minutes, (rows) =>
    state.deps.repository.upsertMinutes(rows)
  );
  const first = signed[0];
  let events: number;
  let deepNote = "";
  if (instrument.kind === "future") {
    const deep =
      first === undefined
        ? { invalid: 0, rows: [], unsigned: 0 }
        : deepTradesOf(
            instrument,
            features.deepPrints,
            { first: first.t, last: (signed.at(-1) as SignedTrade).t },
            state.deps.now
          );
    const stored = state.dryRun
      ? { events: features.events.length, trades: deep.rows.length }
      : await state.deps.repository.insertTickSample({
          events: features.events,
          trades: deep.rows,
        });
    events = stored.events;
    deepNote = `; ${deep.rows.length} deep trades, ${stored.trades} new, ${deep.unsigned} deep prints without a side, ${deep.invalid} with an invalid price`;
  } else events = await storeEvents(state, features.events);
  const span =
    first === undefined
      ? "no prints"
      : `${signed.length} prints, ${new Date(first.t * 1000).toISOString()} to ${output.asOf}`;
  return {
    events,
    items,
    message: `${span}${deepNote}${output.cache.hit ? " (cache)" : ""}`,
    record: true,
    status: signed.length > 0 ? "ok" : "empty",
  };
};

type TapeRead = Readonly<{
  /** The first answer: it holds the price before `since` and the contract. */
  first: MarketTape;
  /** The last answer: it holds the end of the read and the newest feed state. */
  last: MarketTape;
  prints: readonly TapePrint[];
  /** Inclusive pairs [from, to] of covered exchange seconds. */
  covered: MarketTape["covered"];
}>;

/**
 * All answers of one tape read from `since`, joined: while an answer says `more`, the next request
 * starts at `until + 1`. A failed request throws; so does a read that is not complete after
 * FLOW_TAPE_MAX_ANSWERS answers.
 */
const readTape = async (
  state: RunState,
  instrument: FlowInstrument,
  since: number
): Promise<TapeRead> => {
  const first = await state.deps.tape(instrument, since);
  const answers = [first];
  let last = first;
  while (last.more) {
    if (answers.length >= FLOW_TAPE_MAX_ANSWERS)
      throw new Error(
        `tape read not complete after ${FLOW_TAPE_MAX_ANSWERS} answers`
      );
    last = await state.deps.tape(instrument, last.until + 1);
    answers.push(last);
  }
  return {
    covered: answers.flatMap((answer) => answer.covered),
    first,
    last,
    prints: answers.flatMap((answer) => answer.trades),
  };
};

const floorMinute = (seconds: number): number => Math.floor(seconds / 60) * 60;

/**
 * Covered seconds of one minute (0 to 60): the seconds of the minute that lie inside the covered
 * pairs and inside the read range [since, end).
 */
const tapeCoveredSeconds =
  (covered: MarketTape["covered"], since: number, end: number) =>
  (minuteStart: number): number => {
    const low = Math.max(minuteStart, since);
    const high = Math.min(minuteStart + 60, end);
    let seconds = 0;
    for (const [from, to] of covered)
      seconds += Math.max(0, Math.min(to + 1, high) - Math.max(from, low));
    return Math.min(60, seconds);
  };

/** The end of a tape sample message when the look-back limit cut the read. */
const TAPE_SKIPPED_NOTE = `; older minutes skipped (look-back limit ${FLOW_TAPE_LOOKBACK_SECONDS / 60} min)`;

/** A tape sample message of at most 300 characters (the limit of the samples table). */
const tapeMessage = (text: string, skipped: boolean): string => {
  const note = skipped ? TAPE_SKIPPED_NOTE : "";
  return `${text.slice(0, 300 - note.length)}${note}`;
};

/**
 * The first second of a tape read: one minute before the minute of the last stored ok sample, but
 * not before the look-back limit. Without an ok sample the read starts two minutes before the
 * present minute: a read that reaches the service in the first seconds of a minute ends in the
 * minute before, and one complete minute must be in the range, or no ok sample is ever written at
 * that timing. skipped: the limit cut the read, so older minutes are not read.
 */
const tapeCursor = (
  now: Date,
  lastOk: Date | undefined
): Readonly<{ since: number; skipped: boolean }> => {
  const minuteOf = (date: Date): number =>
    floorMinute(Math.floor(date.getTime() / 1000));
  const wanted =
    lastOk === undefined
      ? minuteOf(now) - 2 * FLOW_TAPE_REREAD_SECONDS
      : minuteOf(lastOk) - FLOW_TAPE_REREAD_SECONDS;
  const limit = minuteOf(now) - FLOW_TAPE_LOOKBACK_SECONDS;
  return { since: Math.max(wanted, limit), skipped: wanted < limit };
};

/**
 * One read of the streamed tape (ES and NQ). It reads from one minute before the minute of the last
 * stored ok sample (tapeCursor), keeps complete minutes only (the minute in progress is read by the
 * next run), signs the joined prints once and stores minutes, deep trades and events. It sends no
 * IBKR request: no pacing read, no stagger.
 */
const collectTape = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  const { now } = state.deps;
  const key = sampleKey(instrument.symbol, "ticks");
  const { since, skipped } = tapeCursor(now, state.lastOk.get(key));
  state.last.set(key, now);
  let read: TapeRead;
  try {
    read = await readTape(state, instrument, since);
  } catch (error) {
    return failed(error);
  }
  // The complete minutes end at the start of the minute that holds the first second after the
  // read.
  const end = floorMinute(read.last.until + 1);
  const prints = read.prints.filter(([t]) => t < end);
  const covered = tapeCoveredSeconds(read.covered, since, end);
  let coveredSeconds = 0;
  for (let minute = since; minute < end; minute += 60)
    coveredSeconds += covered(minute);
  const contract = read.first.contract?.localSymbol ?? instrument.symbol;
  const { error: cause, state: feed } = read.last.stream;
  /**
   * The sample of a read with no print and no covered second in `where`: empty for a live feed,
   * unavailable with the cause for a feed that is down or off. storedEvents and storedItems count
   * the rows of earlier minutes that this run stored.
   */
  const nothingIn = (
    where: string,
    storedEvents: number,
    storedItems: number
  ): Attempt =>
    feed === "live"
      ? {
          events: storedEvents,
          items: storedItems,
          message: tapeMessage(
            `streamed tape ${contract}: no print and no covered second in ${where}`,
            skipped
          ),
          record: true,
          status: "empty",
        }
      : {
          events: storedEvents,
          items: storedItems,
          message: tapeMessage(
            `tape stream ${feed}: ${cause ?? "no tick"}`,
            skipped
          ),
          record: true,
          status: "unavailable",
        };
  if (end <= since || (prints.length === 0 && coveredSeconds === 0))
    return nothingIn("the complete minutes", 0, 0);
  const signed = signTape(
    prints,
    read.first.previousPrice,
    read.first.previousDifferentPrice
  );
  const features = buildMinuteFeatures(
    instrument,
    signed,
    read.first.minTick ?? instrument.minTick,
    covered
  );
  // The close of the newest complete minute is at most about two minutes old. A price that this
  // run already has (the book mid of depth) is newer, so it stays. A minute row before the newest
  // complete minute gives no price: while a feed is off or halted, its prints can be as old as
  // the look-back limit.
  const newestMinute = end - 60;
  const newest = features.minutes.at(-1);
  if (
    newest &&
    newest.minute.getTime() === newestMinute * 1000 &&
    !state.prices.has(instrument.symbol)
  )
    state.prices.set(instrument.symbol, newest.close);
  // "trades": a second read replaces a minute row when it holds at least as many prints. A late or
  // out-of-order print lowers the covered seconds of its minute in the service, so the coverage
  // rule of the sampled ticks would keep the old row without that print.
  const items = await store(state, features.minutes, (rows) =>
    state.deps.repository.upsertMinutes(rows, "trades")
  );
  // The range is whole seconds from since to end - 1, so no second of it is cut.
  const deep = deepTradesOf(
    instrument,
    features.deepPrints,
    { first: since - 1, last: end },
    now,
    "streamed"
  );
  const stored = state.dryRun
    ? { events: features.events.length, trades: deep.rows.length }
    : await state.deps.repository.insertTickSample({
        events: features.events,
        trades: deep.rows,
      });
  // A feed that gave nothing in the newest complete minute is reported now, not one run later,
  // whatever state it reports: a feed can say live and deliver no print. The rows above are of
  // the minute that was read again: they are stored, because the second read heals a print that
  // arrived late. A newest minute that is covered and has no print is a quiet minute: it is ok.
  if (covered(newestMinute) === 0 && !prints.some(([t]) => t >= newestMinute))
    return nothingIn("the newest complete minute", stored.events, items);
  const counts = countSigning(signed);
  return {
    events: stored.events,
    items,
    message: tapeMessage(
      `streamed tape ${contract}: ${signed.length} prints in ${features.minutes.length} complete minutes, ${coveredSeconds} of ${end - since} s covered; ${deep.rows.length} deep trades, ${stored.trades} new; ${counts.tick} prints signed by the tick rule, ${counts.none} without a side`,
      skipped
    ),
    record: true,
    status: "ok",
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

type OptionPages = Readonly<{
  pages: OptionPage[];
  /** Requests sent, a failed one included (the run's page budget counts them). */
  requests: number;
  /** Rows are left in the range: the page limit was reached, or a later page failed. */
  capped: boolean;
  /** Why a later page failed, else null. */
  failed: string | null;
}>;

/**
 * One QuantData flow query over [start, end], newest first, until done or `maxRequests`. A failed
 * first page returns its message.
 */
const fetchOptionPages = async (
  client: QuantDataClient,
  ticker: FlowOptionTicker,
  start: Date,
  end: Date,
  maxRequests: number
): Promise<OptionPages | string> => {
  const pages: OptionPage[] = [];
  let searchAfter: unknown[] | null = null;
  let requests = 0;
  let failure: string | null = null;
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
    requests += 1;
    if (!result.ok) {
      if (pages.length === 0) return result.message;
      failure = result.message;
      break;
    }
    const next = result.body["nextSearchAfter"];
    searchAfter = Array.isArray(next) ? next : null;
    pages.push({ data: result.data, next: searchAfter });
  } while (searchAfter !== null && requests < maxRequests);
  return { capped: searchAfter !== null, failed: failure, pages, requests };
};

type OptionFetch = Readonly<{
  requests: number;
  pages: number;
  prints: FlowOptionPrintRow[];
  skipped: number;
  capped: boolean;
  failed: string | null;
  /**
   * Oldest trade time on the fetched pages, rows that failed the schema included, so a range
   * resumes even when its rows do not parse. Null: no row had a trade time.
   */
  oldest: Date | null;
}>;

/** Fetches and parses one range; writes nothing. */
const fetchOptions = async (
  client: QuantDataClient,
  instrument: FlowInstrument,
  start: Date,
  end: Date,
  maxRequests: number
): Promise<OptionFetch | string> => {
  const fetched = await fetchOptionPages(
    client,
    instrument.optionsTicker,
    start,
    end,
    maxRequests
  );
  if (typeof fetched === "string") return fetched;
  const parsed = fetched.pages.map((page) =>
    parseOptionPrints(page.data, instrument.symbol, instrument.optionsTicker)
  );
  const times = fetched.pages
    .map((page) => oldestRowTime(page.data, start, end))
    .filter((time) => time !== null)
    .map((time) => time.getTime());
  return {
    capped: fetched.capped,
    failed: fetched.failed,
    oldest: times.length === 0 ? null : new Date(Math.min(...times)),
    pages: fetched.pages.length,
    prints: parsed.flatMap((page) => page.prints),
    requests: fetched.requests,
    skipped: parsed.reduce((total, page) => total + page.skipped, 0),
  };
};

/** Stores prints and their events (insert-once by print id and event key). */
const storeOptions = async (
  state: RunState,
  instrument: FlowInstrument,
  prints: readonly FlowOptionPrintRow[]
): Promise<Readonly<{ items: number; events: number }>> => ({
  events: await storeEvents(
    state,
    optionEvents(prints, instrument.optionEventPremium)
  ),
  items: await store(state, prints, (rows) =>
    state.deps.repository.insertOptionPrints(rows)
  ),
});

/**
 * The new end of a capped range [start, end]: 1 ms after its oldest fetched row, so rows sharing
 * that millisecond are read again whether QuantData treats endTime as inclusive or exclusive
 * (stored ids are skipped), and at least 1 ms below `end`, so every resume moves on. Null: the
 * range is a single millisecond and nothing older is left.
 */
const resumeEnd = (start: Date, end: Date, oldest: Date): Date | null => {
  const next = Math.min(oldest.getTime() + 1, end.getTime() - 1);
  return next < start.getTime() ? null : new Date(next);
};

type GapResume = Readonly<{
  pages: number;
  prints: number;
  skipped: number;
  items: number;
  events: number;
  closed: number;
  left: number;
  /** Start of the oldest gap left. */
  oldest: Date | null;
  error: string | null;
}>;

/**
 * Reads gaps newest first within `budget` requests. A gap's prints are stored before its row
 * changes, so a failure in between only re-reads them. A gap read to its end is deleted; a capped
 * one keeps its start and moves its end back to its oldest fetched row. Dry runs write nothing.
 */
const resumeOptionGaps = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  gaps: readonly FlowOptionGapRecord[],
  budget: number
): Promise<GapResume> => {
  const { repository } = state.deps;
  const total = { events: 0, items: 0, pages: 0, prints: 0, skipped: 0 };
  let requests = 0;
  let closed = 0;
  let error: string | null = null;
  const close = async (gap: FlowOptionGapRecord) => {
    if (!state.dryRun)
      await repository.deleteOptionGap(gap.symbol, gap.startTime);
    closed += 1;
  };
  for (const gap of gaps) {
    if (requests >= budget) break;
    const fetched = await fetchOptions(
      client,
      instrument,
      gap.startTime,
      gap.endTime,
      budget - requests
    );
    if (typeof fetched === "string") {
      error = fetched;
      break;
    }
    const stored = await storeOptions(state, instrument, fetched.prints);
    requests += fetched.requests;
    total.pages += fetched.pages;
    total.prints += fetched.prints.length;
    total.skipped += fetched.skipped;
    total.items += stored.items;
    total.events += stored.events;
    if (!fetched.capped) {
      await close(gap);
      continue;
    }
    // Capped: the requests are spent, or a page failed. Either way this run stops here.
    error = fetched.failed;
    if (fetched.oldest === null) {
      error ??= "capped pages held no trade time";
      break;
    }
    const end = resumeEnd(gap.startTime, gap.endTime, fetched.oldest);
    if (end === null) await close(gap);
    else if (!state.dryRun)
      await repository.moveOptionGapEnd(gap.symbol, gap.startTime, end);
    break;
  }
  const left = gaps.slice(closed);
  return {
    ...total,
    closed,
    error,
    left: left.length,
    oldest:
      left.length === 0
        ? null
        : new Date(Math.min(...left.map((gap) => gap.startTime.getTime()))),
  };
};

type OptionWindow = Readonly<{
  requests: number;
  failed: string | null;
  prints: number;
  items: number;
  events: number;
  notes: string[];
  /** Ranges this window left unread (stored already, unless a dry run). */
  gaps: FlowOptionGapRecord[];
}>;

/**
 * The new window, from the newest stored print (inside the look-back) to now. Ranges it leaves
 * unread are stored as gaps before its prints, so no failure can move the newest stored print past
 * an unread range: the older part of a capped window, and the time between the newest stored print
 * and the look-back floor after an outage longer than the look-back.
 */
const readOptionWindow = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  newest: Date | null
): Promise<OptionWindow | string> => {
  const { now, repository } = state.deps;
  const floor = new Date(
    now.getTime() -
      (state.seed ? FLOW_SEED_OPTION_LOOKBACK_MS : FLOW_OPTION_LOOKBACK_MS)
  );
  const since = newest !== null && newest > floor ? newest : floor;
  const fetched = await fetchOptions(
    client,
    instrument,
    since,
    now,
    FLOW_OPTION_PAGES_MAX
  );
  if (typeof fetched === "string") return fetched;
  const notes = [
    `${fetched.prints.length} prints on ${fetched.pages} page(s) since ${since.toISOString()}`,
  ];
  const gaps: FlowOptionGapRecord[] = [];
  const gap = (startTime: Date, endTime: Date) =>
    gaps.push({
      createdAt: now,
      endTime,
      startTime,
      symbol: instrument.symbol,
    });
  if (fetched.capped) {
    // No trade time on the capped pages: the whole window stays unread.
    const end =
      fetched.oldest === null ? now : resumeEnd(since, now, fetched.oldest);
    const reason =
      fetched.failed === null
        ? `page cap ${FLOW_OPTION_PAGES_MAX} reached`
        : `page ${fetched.pages + 1} failed`;
    if (end === null)
      notes.push(`${reason}, nothing older left in this window`);
    else {
      gap(since, end);
      notes.push(`${reason}, older prints of this window queued as a gap`);
    }
  }
  if (newest !== null && newest < floor) {
    gap(newest, floor);
    notes.push(
      `prints from ${newest.toISOString()} to the look-back queued as a gap`
    );
  }
  if (fetched.skipped > 0)
    notes.push(`${fetched.skipped} rows failed the schema`);
  if (!state.dryRun) for (const row of gaps) await repository.addOptionGap(row);
  const stored = await storeOptions(state, instrument, fetched.prints);
  return {
    ...stored,
    failed: fetched.failed,
    gaps,
    notes,
    prints: fetched.prints.length,
    requests: fetched.requests,
  };
};

const NO_WINDOW: OptionWindow = {
  events: 0,
  failed: null,
  gaps: [],
  items: 0,
  notes: ["market closed, gaps only"],
  prints: 0,
  requests: 0,
};

const gapNotes = (resumed: GapResume): string[] => [
  `gaps: ${resumed.prints} prints on ${resumed.pages} page(s), ${resumed.closed} closed, ${resumed.left} left${resumed.oldest === null ? "" : ` (oldest from ${resumed.oldest.toISOString()})`}`,
  ...(resumed.skipped > 0
    ? [`${resumed.skipped} gap rows failed the schema`]
    : []),
  ...(resumed.error === null
    ? []
    : [`gap fetch stopped: ${resumed.error.slice(0, 80)}`]),
];

/** Stored and new gaps, one per start (the later end wins, as in addOptionGap), newest end first. */
const mergeGaps = (
  gaps: readonly FlowOptionGapRecord[]
): FlowOptionGapRecord[] => {
  const byStart = new Map<number, FlowOptionGapRecord>();
  for (const gap of gaps) {
    const known = byStart.get(gap.startTime.getTime());
    if (known === undefined || known.endTime < gap.endTime)
      byStart.set(gap.startTime.getTime(), gap);
  }
  return [...byStart.values()].sort(
    (a, b) => b.endTime.getTime() - a.endTime.getTime()
  );
};

/** Reads gaps with the requests the window left (none after a failed window page). */
const readGaps = async (
  state: RunState,
  client: QuantDataClient,
  instrument: FlowInstrument,
  window: OptionWindow,
  stored: readonly FlowOptionGapRecord[]
): Promise<Readonly<{ notes: string[]; resumed: GapResume | null }>> => {
  const gaps = mergeGaps([...window.gaps, ...stored]);
  if (window.failed !== null)
    return {
      notes: [`gaps not read after a failed page (${gaps.length} left)`],
      resumed: null,
    };
  if (gaps.length === 0) return { notes: [], resumed: null };
  const resumed = await resumeOptionGaps(
    state,
    client,
    instrument,
    gaps,
    FLOW_OPTION_RUN_PAGES_MAX - window.requests
  );
  return { notes: gapNotes(resumed), resumed };
};

const optionsAttempt = (
  window: OptionWindow,
  resumed: GapResume | null,
  notes: readonly string[]
): Attempt => ({
  events: window.events + (resumed?.events ?? 0),
  items: window.items + (resumed?.items ?? 0),
  message: notes.join("; ").slice(0, 300),
  record: true,
  status: window.prints + (resumed?.prints ?? 0) > 0 ? "ok" : "empty",
});

/**
 * Options flow for one symbol. While the options session is open: the new window (from the newest
 * stored print) first, at most FLOW_OPTION_PAGES_MAX requests, then gaps with the rest of
 * FLOW_OPTION_RUN_PAGES_MAX. After the close the run reads gaps only, until none are left; without
 * gaps it answers "market closed" with no request.
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
    // Closed: nothing to collect without the gap list, so report it without a sample. Every
    // repository rejection arrives as a FlowStorageError (storageTagged).
    if (!open)
      return notDue(
        `market closed; gaps unavailable: ${(error as FlowStorageError).message.slice(0, 80)}`
      );
    return failed(error);
  }
  if (!open && stored.length === 0) return notDue("market closed");
  const window = open
    ? await readOptionWindow(state, client, instrument, newest)
    : NO_WINDOW;
  if (typeof window === "string") return failed(new Error(window));
  const { notes, resumed } = await readGaps(
    state,
    client,
    instrument,
    window,
    stored
  );
  // After the close only gaps run: one that stopped without a print is a failed sample, so a gap
  // that cannot be read shows on the freshness strip.
  if (
    !open &&
    resumed !== null &&
    resumed.prints === 0 &&
    resumed.error !== null
  )
    return failed(new Error(`gaps: ${resumed.error}`));
  return optionsAttempt(window, resumed, [...window.notes, ...notes]);
};

const gexBasis = (
  state: RunState,
  instrument: FlowInstrument,
  spot: number | null
) => {
  if (instrument.kind === "etf") return 0;
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

/** sp500 symbols read net drift on even minutes of the run time, nasdaq100 symbols on odd minutes. */
export const netDriftTurn = (group: FlowGroupId, now: Date): boolean =>
  Math.floor(now.getTime() / 60_000) % 2 === (group === "sp500" ? 0 : 1);

/** A net drift bucket is ok while its newest bucket started at most this long before now. */
const NET_DRIFT_OK_SECONDS = 300;

type NetDriftPart =
  | Readonly<{ ok: true; buckets: readonly FlowNetDriftBucket[] }>
  | Readonly<{ ok: false; reserved: boolean; text: string }>;

const netDriftPart = async (
  state: RunState,
  client: QuantDataClient,
  ticker: FlowOptionTicker,
  part: FlowExpiryPart,
  sessionDate: string
): Promise<NetDriftPart> => {
  const result: QuantDataResult = await client.request(
    "netDrift",
    netDriftRequest(sessionDate, ticker, part),
    30_000
  );
  if (!result.ok) {
    const until = new Date(
      state.deps.now.getTime() +
        (result.retryAfterSeconds ?? client.cooldownSeconds()) * 1000
    );
    return {
      ok: false,
      reserved: result.reason === "reserved",
      text:
        result.reason === "rate_limited"
          ? `rate limited until ${flowClockText(until)} ET`
          : result.message,
    };
  }
  const parsed = parseNetDrift(result.data);
  return parsed.ok
    ? parsed
    : { ok: false, reserved: false, text: parsed.message };
};

const storeNetDrift = (
  state: RunState,
  ticker: FlowOptionTicker,
  part: FlowExpiryPart,
  buckets: readonly FlowNetDriftBucket[]
): Promise<number> =>
  store(
    state,
    buckets.map(
      (bucket): FlowNetDriftRow => ({
        ...bucket,
        filterProfile: FLOW_FILTER_PROFILE,
        part,
        ticker,
      })
    ),
    (rows) => state.deps.repository.upsertNetDrift(rows)
  );

const collectNetDrift = async (
  state: RunState,
  instrument: FlowInstrument
): Promise<Attempt> => {
  const { group } = instrument;
  if (!(state.seed || netDriftTurn(group, state.deps.now)))
    return notDue(
      `staggered: ${group} net drift runs on ${group === "sp500" ? "even" : "odd"} minutes`
    );
  const client = state.deps.quantData;
  if (client === null) return notDue("QuantData not configured");
  const ticker = instrument.optionsTicker;
  const sessionDate = flowSessionDate(state.deps.now);
  const [totalPart, zeroPart] = FLOW_EXPIRY_PARTS;
  const total = await netDriftPart(
    state,
    client,
    ticker,
    totalPart,
    sessionDate
  );
  if (!total.ok && total.reserved)
    return notDue("budget: QuantData starts kept free for other callers");
  if (!total.ok)
    return {
      events: 0,
      items: 0,
      message: total.text.slice(0, 300),
      record: true,
      status: "unavailable",
    };
  const zero = await netDriftPart(state, client, ticker, zeroPart, sessionDate);
  const items =
    (await storeNetDrift(state, ticker, totalPart, total.buckets)) +
    (zero.ok ? await storeNetDrift(state, ticker, zeroPart, zero.buckets) : 0);
  const zeroCount = zero.ok ? zero.buckets.length : 0;
  const newest = newestBucketAt(total.buckets);
  const head = `${ticker} total ${total.buckets.length} buckets, zero_dte ${zeroCount}`;
  const tail = zero.ok ? "" : `; zero_dte failed (${zero.text})`;
  if (newest === null)
    return {
      events: 0,
      items,
      message: `${head}, 2 requests${tail}`.slice(0, 300),
      record: true,
      status: "empty",
    };
  const fresh = secondsSince(state, newest) <= NET_DRIFT_OK_SECONDS;
  return {
    events: 0,
    items,
    message:
      `${head}, newest ${flowClockText(newest)} NY, 2 requests${tail}`.slice(
        0,
        300
      ),
    record: true,
    status: fresh ? "ok" : "empty",
  };
};

/** QuantData worst case of one run: the larger net drift group, every options symbol, one GEX estimate. */
export const flowQuantDataRunWorstCase = (
  instruments: Readonly<Record<FlowSymbol, FlowInstrument>>,
  groups: Readonly<Record<FlowGroupId, FlowGroup>>
): number => {
  const list = Object.values(instruments);
  const netDriftPerGroup = Object.keys(groups).map(
    (group) =>
      list.filter(
        (instrument) =>
          instrument.group === group && instrument.sources.includes("net_drift")
      ).length
  );
  const optionSymbols = list.filter((instrument) =>
    instrument.sources.includes("options")
  ).length;
  return (
    Math.max(0, ...netDriftPerGroup) * FLOW_NET_DRIFT_REQUESTS_PER_SYMBOL +
    optionSymbols * FLOW_OPTION_RUN_PAGES_MAX +
    FLOW_GEX_REQUESTS_PER_RUN
  );
};

// Net drift first (its cadence is per minute); depth before GEX, so the ES − SPX basis can use this
// run's book.
const SOURCE_ORDER: readonly FlowSource[] = [
  "net_drift",
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
  net_drift: collectNetDrift,
  options: (state, instrument) => collectOptions(state, instrument, true),
  ticks: (state, instrument) =>
    instrument.ticks === "stream"
      ? collectTape(state, instrument)
      : collectTicks(state, instrument),
};

/** Seconds after the last attempt before a source of an instrument is due again. */
const dueSeconds = (instrument: FlowInstrument, source: FlowSource): number =>
  source === "ticks" && instrument.ticks === "stream"
    ? FLOW_TAPE_DUE_SECONDS
    : FLOW_DUE_SECONDS[source];

/** Why a source must wait for this run (GEX stagger, QuantData starts), or null. */
const runGate = (state: RunState, source: FlowSource): Attempt | null => {
  if (source === "gex" && state.gexDone)
    return notDue("staggered: GEX ran for another symbol in this run");
  const needed = FLOW_QUANTDATA_SOURCE_MAX[source];
  const client = state.deps.quantData;
  if (needed === undefined || client === null) return null;
  const free = client.freeStarts();
  if (free >= needed) return null;
  return notDue(
    `budget: ${free} QuantData starts free beyond the reserve of ${FLOW_QUANTDATA_CALLER_RESERVE}, ${needed} needed`
  );
};

const attempt = async (
  state: RunState,
  instrument: FlowInstrument,
  source: FlowSource
): Promise<Attempt> => {
  const open =
    state.seed || flowSessionOpen(source, instrument.symbol, state.deps.now);
  if (!state.seed) {
    // Options keep reading their unfetched gaps after the close; without gaps collectOptions answers
    // "market closed" before any QuantData request.
    if (!open && source !== "options") return notDue("market closed");
    const age = secondsSince(
      state,
      state.last.get(sampleKey(instrument.symbol, source))
    );
    if (age < dueSeconds(instrument, source))
      return notDue(`not due (last attempt ${Math.round(age)} s ago)`);
  }
  const held = runGate(state, source);
  if (held !== null) return held;
  if (source === "gex") state.gexDone = true;
  return open
    ? await COLLECTORS[source](state, instrument)
    : await collectOptions(state, instrument, false);
};

/** Per symbol and source: the newest stored sample (last) and the newest ok sample (lastOk). */
const lastAttempts = async (
  repository: FlowRepository,
  symbols: readonly FlowSymbol[]
): Promise<
  Readonly<{ last: Map<string, Date>; lastOk: Map<string, Date> }>
> => {
  const last = new Map<string, Date>();
  const lastOk = new Map<string, Date>();
  for (const symbol of symbols) {
    const { latest, latestOk } = await repository.latestSamples(symbol);
    for (const sample of latest)
      last.set(sampleKey(symbol, sample.source), sample.at);
    for (const sample of latestOk)
      lastOk.set(sampleKey(symbol, sample.source), sample.at);
  }
  return { last, lastOk };
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
  try {
    await state.deps.repository.recordSample(sample);
  } catch {
    // The run entry still reports the attempt; the next run retries the source.
  }
};

/** A repository call that throws; the run names a storage failure only for these. */
class FlowStorageError extends Error {
  readonly causeName: string;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "lookup failed", { cause });
    this.name = "FlowStorageError";
    this.causeName = cause instanceof Error ? cause.name : typeof cause;
  }
}

type RepositoryMethod = (...args: unknown[]) => Promise<unknown>;

/** Every repository method (all of them return promises) rethrows its error as a FlowStorageError. */
const storageTagged = (repository: FlowRepository): FlowRepository =>
  Object.fromEntries(
    Object.entries(repository).map(([name, method]) => [
      name,
      async (...args: unknown[]): Promise<unknown> => {
        try {
          return await Reflect.apply(
            method as RepositoryMethod,
            repository,
            args
          );
        } catch (error) {
          throw new FlowStorageError(error);
        }
      },
    ])
  ) as FlowRepository;

/** An error of one source becomes its sample; the run goes on with the next source. */
const isolated = async (
  state: RunState,
  instrument: FlowInstrument,
  source: FlowSource
): Promise<Attempt> => {
  try {
    return await attempt(state, instrument, source);
  } catch (error) {
    return {
      events: 0,
      items: 0,
      message:
        error instanceof FlowStorageError
          ? `${FLOW_STORAGE_FAILURE_PREFIX} (${error.causeName})`
          : `collector failed (${error instanceof Error ? error.name : typeof error})`,
      record: true,
      status: "unavailable",
    };
  }
};

const pruneIfDue = async (state: RunState): Promise<number> => {
  const { now, repository } = state.deps;
  if (state.dryRun || !state.deps.pruneDue) return 0;
  const cutoff = (table: FlowPruneTable): Date =>
    new Date(now.getTime() - FLOW_RETENTION_DAYS[table] * 86_400_000);
  return await repository.prune({
    flow_book: cutoff("flow_book"),
    flow_events: cutoff("flow_events"),
    flow_gex: cutoff("flow_gex"),
    flow_large_trades: cutoff("flow_large_trades"),
    flow_minutes: cutoff("flow_minutes"),
    flow_net_drift: cutoff("flow_net_drift"),
    flow_option_gaps: cutoff("flow_option_gaps"),
    flow_option_prints: cutoff("flow_option_prints"),
    flow_samples: cutoff("flow_samples"),
  });
};

export const runFlowCollect = async (
  input: FlowCollectParsedInput,
  deps: FlowCollectDeps
): Promise<FlowCollectOutput> => {
  const symbols = input.symbols ?? [...FLOW_SYMBOLS];
  const { last, lastOk } = await lastAttempts(deps.repository, FLOW_SYMBOLS);
  const state: RunState = {
    deps: { ...deps, repository: storageTagged(deps.repository) },
    dryRun: input.dryRun,
    gexDone: false,
    last,
    lastOk,
    pacing: undefined,
    prices: new Map(),
    seed: input.seed,
  };
  const runs: Run[] = [];
  for (const source of SOURCE_ORDER)
    for (const symbol of symbols) {
      if (!FLOW_INSTRUMENTS[symbol].sources.includes(source)) continue;
      const result = await isolated(state, FLOW_INSTRUMENTS[symbol], source);
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
  const pruned = await pruneIfDue(state);
  return {
    at: deps.now.toISOString(),
    budget: {
      ibkrLimit: FLOW_IBKR_LIMIT,
      ibkrRecent: state.pacing?.recentRequests ?? null,
      quantDataFree: deps.quantData?.freeStarts() ?? null,
      quantDataReserve: FLOW_QUANTDATA_CALLER_RESERVE,
      runSeconds: Math.round(deps.elapsedMs() / 1000),
    },
    busy: false,
    dryRun: input.dryRun,
    pruned,
    runs,
  };
};
