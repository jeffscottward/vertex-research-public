import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  max,
  type SQL,
  sql,
} from "drizzle-orm";

import {
  FLOW_SOURCE_VALUES,
  type FlowDirectionValue,
  type FlowEventKindValue,
  type FlowNetDriftTickerValue,
  type FlowOptionTickerValue,
  type FlowSampleStatusValue,
  type FlowSourceValue,
  type FlowOptionSideValue,
  type FlowSymbolValue,
  flowBook,
  flowBookSnapshots,
  flowEvents,
  flowGex,
  flowLargeTrades,
  flowMarketPremium,
  flowMarketPremiumSessions,
  flowMinutes,
  flowNetDrift,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
  flowTapeSeconds,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import { InvalidRepositoryInputError } from "./repository-errors.ts";

// Flow pipeline storage (flow.*, docs/vertex-rebuild/flow-pipeline.md). flow.collect records one
// sample row per source attempt and upserts the derived rows; flow.snapshot reads one symbol's
// window. Rows are derived and regenerable; prune() removes rows older than each table's retention cutoff.
// Exception: the per-second counts of flow_tape_seconds cannot be collected again and are not pruned.
// Research only: no order path.

export type {
  FlowSampleStatusValue,
  FlowSourceValue,
  FlowSymbolValue,
} from "../schema/index.ts";

export type FlowSampleRecord = typeof flowSamples.$inferSelect;
export type FlowMinuteRecord = typeof flowMinutes.$inferSelect;
export type FlowBookRecord = typeof flowBook.$inferSelect;
export type FlowBookSnapshotRecord = typeof flowBookSnapshots.$inferSelect;
export type FlowOptionPrintRecord = typeof flowOptionPrints.$inferSelect;
export type FlowOptionGapRecord = typeof flowOptionGaps.$inferSelect;
/** The columns of an option print that the hedging pressure line reads (flow.hedgingPressure). */
export type FlowHedgingPrintRecord = Pick<
  FlowOptionPrintRecord,
  | "id"
  | "tradedAt"
  | "right"
  | "strike"
  | "dte"
  | "iv"
  | "underlyingPrice"
  | "side"
  | "size"
>;
/**
 * The stored option prints of one strike, right and sentiment (optionsAnalytics strike profiles):
 * contracts, premium, print count and the oldest and newest trade time.
 */
export type FlowOptionStrikeTotalRecord = Readonly<{
  strike: number;
  right: "call" | "put";
  sentiment: FlowDirectionValue;
  contracts: number;
  premium: number;
  trades: number;
  oldestAt: Date;
  newestAt: Date;
}>;
export type FlowEventRecord = typeof flowEvents.$inferSelect;
export type FlowGexRecord = typeof flowGex.$inferSelect;
export type FlowNetDriftRecord = typeof flowNetDrift.$inferSelect;
export type FlowLargeTradeRecord = typeof flowLargeTrades.$inferSelect;
export type FlowTapeSecondsRecord = typeof flowTapeSeconds.$inferSelect;
export type FlowMarketPremiumRecord = typeof flowMarketPremium.$inferSelect;
export type FlowMarketPremiumSessionRecord =
  typeof flowMarketPremiumSessions.$inferSelect;
/** net_bullish: net premium descending; net_bearish: net premium ascending; total: premium descending. */
export type FlowMarketPremiumSort = "net_bullish" | "net_bearish" | "total";
export type FlowMarketPremiumRankingQuery = Readonly<{
  /** Session dates (YYYY-MM-DD) to sum over; empty gives an empty ranking. */
  sessionDates: readonly string[];
  /** Only rows of this filter profile count, so two filter definitions never mix in one sum. */
  filterProfile: string;
  ticker: string | null;
  sort: FlowMarketPremiumSort;
  limit: number;
}>;
export type FlowMarketPremiumRankingRow = Readonly<{
  /** Position in the whole market order of the sessions (also with a ticker filter). */
  rank: number;
  ticker: string;
  bullishPremium: number;
  bearishPremium: number;
  premium: number;
  tradeCount: number;
  volume: number;
  sessionsPresent: number;
}>;
export type FlowMarketPremiumRanking = Readonly<{
  rows: FlowMarketPremiumRankingRow[];
  /** Over every ticker of the sessions, without the ticker filter. */
  totals: Readonly<{
    tickers: number;
    bullishPremium: number;
    bearishPremium: number;
    premium: number;
  }>;
}>;
export type FlowLargeTradeQuery = Readonly<{
  symbol: "ES" | "NQ";
  from: Date;
  to: Date;
}>;
/** A range of minutes of one streamed future: from <= minute < to. */
export type FlowTapeSecondsQuery = Readonly<{
  symbol: "ES" | "NQ";
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}>;
/** A range of L2 depth snapshots of one future: from <= captured_at < to, capped at limit. */
export type FlowBookSnapshotsQuery = Readonly<{
  symbol: "ES" | "NQ";
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  limit: number;
}>;
/** The option prints of one symbol with from <= traded_at < to, at most `limit` rows. */
export type FlowHedgingPrintsQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  limit: number;
}>;
/** Big option prints of one symbol with from <= traded_at < to and premium >= minPremiumUsd. */
export type FlowLargeOptionPrintsQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** Inclusive minimum print premium in US dollars. */
  minPremiumUsd: number;
  limit: number;
}>;
/** Per-minute option print aggregates of one symbol with from <= traded_at < to. */
export type FlowOptionPrintMinutesQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}>;
export type FlowOptionPrintMinuteRecord = Readonly<{
  minute: Date;
  callPrints: number;
  putPrints: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  lastTradedAt: Date;
  lastPrice: number | null;
}>;
/** Per-session-date option print aggregates of one symbol with from <= traded_at < to. */
export type FlowOptionPrintDaysQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  limit: number;
}>;
export type FlowOptionPrintDayRecord = Readonly<{
  session: string;
  callPrints: number;
  putPrints: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  lastPrice: number | null;
}>;
export type FlowOptionPrintBucketMinutes = 5 | 15 | 30;
/** Per-(strike, slot, right, side) option print aggregates of one symbol with from <= traded_at < to. */
export type FlowOptionPrintStrikeBucketsQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive session start (09:30 New York). */
  from: Date;
  /** Exclusive session end (16:15 New York). */
  to: Date;
  bucketMinutes: FlowOptionPrintBucketMinutes;
}>;
export type FlowOptionPrintStrikeBucketRecord = Readonly<{
  strike: number;
  slotIndex: number;
  right: "call" | "put";
  side: FlowOptionSideValue;
  premium: number;
  prints: number;
  volume: number;
  lastTradedAt: Date;
}>;
export type FlowOptionPrintSlotPriceRecord = Readonly<{
  slotIndex: number;
  price: number;
  pricedAt: Date;
}>;

/** Stored option prints of one symbol with from <= traded_at < to and expiry >= minExpiry. */
export type FlowOptionStrikeTotalsQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** ISO date (YYYY-MM-DD), inclusive. */
  minExpiry: string;
}>;
export type FlowPruneTable =
  | "flow_samples"
  | "flow_minutes"
  | "flow_book"
  | "flow_book_snapshots"
  | "flow_option_prints"
  | "flow_events"
  | "flow_gex"
  | "flow_option_gaps"
  | "flow_net_drift"
  | "flow_large_trades";
export type FlowNetDriftQuery = Readonly<{
  tickers: readonly FlowNetDriftTickerValue[];
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}>;

/** Rows one insert statement may hold (keeps each statement well under the parameter limit). */
export const FLOW_UPSERT_BATCH = 250;

/**
 * The rule that decides if a new minute row replaces the stored row of the same minute.
 * `coverage`: the new row covers at least as many seconds. The sampled ticks need this rule: a
 * later sample that covers less of the minute holds fewer trades, so it must not replace the row.
 * `trades`: the new row holds at least as many trades. The streamed tape needs this rule: a late
 * or out-of-order trade gives a later read more trades and fewer covered seconds, and that read
 * is the correct one. A read after a service restart holds fewer trades, so the stored row stays.
 */
export type FlowMinuteReplace = "coverage" | "trades";

export type FlowWindowQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Inclusive. */
  to: Date;
  /**
   * The GEX snapshot is the newest at or before this time (default `to`). The snapshot reader
   * passes now: GEX comes from previous-session open interest, so it still applies after a
   * window that ended at a closed market's last print.
   */
  gexAt?: Date;
}>;

export type FlowWindowRows = Readonly<{
  minutes: FlowMinuteRecord[];
  books: FlowBookRecord[];
  prints: FlowOptionPrintRecord[];
  events: FlowEventRecord[];
  /** Newest GEX snapshot at or before the window end. */
  gex: FlowGexRecord | null;
}>;

export type FlowEventsQuery = Readonly<{
  symbol: FlowSymbolValue;
  /** Inclusive. */
  from: Date;
  /** Inclusive. */
  to: Date;
  /** Optional event kind filter; omit for all kinds. */
  kinds?: readonly FlowEventKindValue[];
  /** Maximum rows returned, newest first. */
  limit: number;
}>;

export type FlowRepository = Readonly<{
  recordSample: (sample: FlowSampleRecord) => Promise<void>;
  /**
   * Upserts by (symbol, minute). The rule `replace` decides if a new row replaces a stored row
   * (see `FlowMinuteReplace`). The default is `coverage`.
   */
  upsertMinutes: (
    rows: readonly FlowMinuteRecord[],
    replace?: FlowMinuteReplace
  ) => Promise<number>;
  /** Insert-once rows; each returns how many rows were new. */
  insertBooks: (rows: readonly FlowBookRecord[]) => Promise<number>;
  insertOptionPrints: (
    rows: readonly FlowOptionPrintRecord[]
  ) => Promise<number>;
  insertEvents: (rows: readonly FlowEventRecord[]) => Promise<number>;
  insertGex: (rows: readonly FlowGexRecord[]) => Promise<number>;
  /**
   * Stores the events and the deep trades of one futures tick sample in one transaction
   * (both or none); insert-once, so a stored key is never rewritten. Returns the new rows.
   */
  insertTickSample: (
    input: Readonly<{
      events: readonly FlowEventRecord[];
      trades: readonly FlowLargeTradeRecord[];
    }>
  ) => Promise<Readonly<{ events: number; trades: number }>>;
  /** Deep trades of a symbol with from <= second < to (end-exclusive), by second, then seq. */
  readLargeTrades: (
    query: FlowLargeTradeQuery
  ) => Promise<FlowLargeTradeRecord[]>;
  /**
   * Upserts the per-second counts by (symbol, minute). A new row replaces the stored row when it
   * holds at least as many trades (the `trades` rule of the minute rows, so both tables keep the
   * same read of a minute). Returns the rows written.
   */
  upsertTapeSeconds: (
    rows: readonly FlowTapeSecondsRecord[]
  ) => Promise<number>;
  /** Per-second counts of a symbol with from <= minute < to, ascending by minute. */
  readTapeSeconds: (
    query: FlowTapeSecondsQuery
  ) => Promise<FlowTapeSecondsRecord[]>;
  /**
   * Upserts CME L2 depth snapshots by (symbol, captured_at). A streamed snapshot replaces a
   * sampled snapshot at the same timestamp, and equal-mode updates refresh the book.
   */
  upsertBookSnapshots: (
    rows: readonly FlowBookSnapshotRecord[]
  ) => Promise<number>;
  /**
   * L2 depth snapshots of ES or NQ with from <= captured_at < to. Queries newest-first up to
   * limit so long windows never drop recent snapshots, then returns rows ascending by captured_at.
   */
  readBookSnapshots: (
    query: FlowBookSnapshotsQuery
  ) => Promise<FlowBookSnapshotRecord[]>;
  /** The minutes of a symbol that have a minute row, with from <= minute < to, ascending. */
  readMinuteStarts: (query: FlowTapeSecondsQuery) => Promise<Date[]>;
  /** Stored minute OHLC/VWAP bars of ES or NQ with from <= minute < to, ascending by minute. */
  readMinutes: (query: FlowTapeSecondsQuery) => Promise<FlowMinuteRecord[]>;
  /**
   * The option prints of a symbol with from <= traded_at < to, ascending by traded_at, then id,
   * at most `limit` rows; only the columns of the hedging pressure line.
   */
  readHedgingPrints: (
    query: FlowHedgingPrintsQuery
  ) => Promise<FlowHedgingPrintRecord[]>;
  /**
   * Big option prints of a symbol with from <= traded_at < to and premium >= minPremiumUsd,
   * ordered by premium desc, traded_at desc, id desc, at most `limit` rows.
   */
  readLargeOptionPrints: (
    query: FlowLargeOptionPrintsQuery
  ) => Promise<FlowOptionPrintRecord[]>;
  /**
   * Per-minute call and put sums of a symbol with from <= traded_at < to, ascending by minute.
   */
  readOptionPrintMinutes: (
    query: FlowOptionPrintMinutesQuery
  ) => Promise<FlowOptionPrintMinuteRecord[]>;
  /**
   * Per-session-date (New York regular options hours 09:30 to 16:15, Mon-Fri) call and put sums
   * of a symbol with from <= traded_at < to; returns the newest `limit` sessions, oldest first.
   */
  readOptionPrintDays: (
    query: FlowOptionPrintDaysQuery
  ) => Promise<FlowOptionPrintDayRecord[]>;
  /**
   * Domain-agnostic per-(strike, slotIndex, right, side) option print sums of a symbol with
   * from <= traded_at < to, ordered by strike desc, slotIndex asc, right asc, side asc.
   */
  readOptionPrintStrikeBuckets: (
    query: FlowOptionPrintStrikeBucketsQuery
  ) => Promise<FlowOptionPrintStrikeBucketRecord[]>;
  /**
   * Newest finite positive underlying_price per time slot of a symbol with from <= traded_at < to,
   * breaking equal-timestamp ties by id desc (at most 81 rows per options session).
   */
  readOptionPrintSlotPrices: (
    query: FlowOptionPrintStrikeBucketsQuery
  ) => Promise<FlowOptionPrintSlotPriceRecord[]>;
  /**
   * The option prints of a symbol with from <= traded_at < to, expiry >= minExpiry and a strike
   * above 0, grouped by strike, right and sentiment, ascending by strike, then right, then
   * sentiment.
   */
  readOptionStrikeTotals: (
    query: FlowOptionStrikeTotalsQuery
  ) => Promise<FlowOptionStrikeTotalRecord[]>;
  /** Newest priced total net drift row of a ticker with minute <= at, or null. */
  netDriftPriceAtOrBefore: (
    ticker: FlowOptionTickerValue,
    at: Date
  ) => Promise<Readonly<{ minute: Date; price: number }> | null>;
  /** Deletes rows older than each table's cutoff; returns the rows removed. */
  prune: (cutoffs: Readonly<Record<FlowPruneTable, Date>>) => Promise<number>;
  /** Upserts by (ticker, part, minute); a row is rewritten only when a value or the filter profile changed. */
  upsertNetDrift: (rows: readonly FlowNetDriftRecord[]) => Promise<number>;
  /** Net drift rows of the tickers with from <= minute < to, ascending by minute. */
  readNetDrift: (query: FlowNetDriftQuery) => Promise<FlowNetDriftRecord[]>;
  /** Newest stored minute of the total part of a ticker. */
  newestNetDriftMinute: (
    ticker: FlowNetDriftTickerValue
  ) => Promise<Date | null>;
  /** Newest stored option print time for a symbol (paging stops there). */
  newestOptionPrintAt: (symbol: FlowSymbolValue) => Promise<Date | null>;
  /** Unfetched option-print ranges of a symbol, newest end first. */
  optionGaps: (symbol: FlowSymbolValue) => Promise<FlowOptionGapRecord[]>;
  /** Stores a new gap; a stored gap with the same symbol and start keeps the later end. */
  addOptionGap: (gap: FlowOptionGapRecord) => Promise<void>;
  /** Moves a stored gap's end back to where the next read resumes. */
  moveOptionGapEnd: (
    symbol: FlowSymbolValue,
    startTime: Date,
    endTime: Date
  ) => Promise<void>;
  /** Deletes a gap that was read completely. */
  deleteOptionGap: (symbol: FlowSymbolValue, startTime: Date) => Promise<void>;
  /** Newest stored minute, book or option print time for a symbol (the snapshot window ends there). */
  newestDataAt: (symbol: FlowSymbolValue) => Promise<Date | null>;
  /**
   * Newest sample of any status and newest ok sample, per source. `sources` limits the read to
   * the sources that the caller uses (two queries per source); the default is every source.
   */
  latestSamples: (
    symbol: FlowSymbolValue,
    sources?: readonly FlowSourceValue[]
  ) => Promise<
    Readonly<{
      latest: FlowSampleRecord[];
      latestOk: FlowSampleRecord[];
    }>
  >;
  readWindow: (query: FlowWindowQuery) => Promise<FlowWindowRows>;
  /** Stored flow events for a symbol in [from, to], optionally filtered by kind, newest first. */
  readEvents: (query: FlowEventsQuery) => Promise<FlowEventRecord[]>;
  /**
   * Stores one market premium capture in one transaction: upserts the rows by (session date,
   * ticker), the newest capture replacing the values, deletes the session's rows of older captures
   * (all rows share one session date and capture time), and replaces the ledger row of the session.
   * Returns the rows written.
   */
  storeMarketPremium: (
    input: Readonly<{
      rows: readonly FlowMarketPremiumRecord[];
      session: FlowMarketPremiumSessionRecord;
    }>
  ) => Promise<number>;
  /** Ledger rows with from <= session date <= to (YYYY-MM-DD, inclusive), oldest first. */
  marketPremiumLedger: (
    range: Readonly<{ from: string; to: string }>
  ) => Promise<FlowMarketPremiumSessionRecord[]>;
  /**
   * Per ticker sums over the given sessions, in sort order then by ticker, at most limit rows. A
   * ticker filter returns that ticker's row (or none) with its rank in the whole market.
   */
  marketPremiumRanking: (
    query: FlowMarketPremiumRankingQuery
  ) => Promise<FlowMarketPremiumRanking>;
}>;

const batches = <T>(rows: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += FLOW_UPSERT_BATCH)
    out.push(rows.slice(start, start + FLOW_UPSERT_BATCH));
  return out;
};

const newestDate = (values: readonly (Date | null)[]): Date | null => {
  const times = values.filter((value) => value !== null);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((value) => value.getTime())));
};

/** Postgres max() over a timestamp can come back as a string through some drivers. */
const toDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
};

const STRIKE_BUCKET_MINUTES: readonly number[] = [5, 15, 30];

const strikeSlotExpression = (
  query: FlowOptionPrintStrikeBucketsQuery
): SQL<number> => {
  if (!STRIKE_BUCKET_MINUTES.includes(query.bucketMinutes)) {
    throw new InvalidRepositoryInputError("bucketMinutes must be 5, 15, or 30");
  }
  const fromMs = query.from.getTime();
  const toMs = query.to.getTime();
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs)) {
    throw new InvalidRepositoryInputError(
      "from and to must be finite dates with from < to"
    );
  }
  const fromIso = query.from.toISOString();
  const bucketSeconds = query.bucketMinutes * 60;
  return sql<number>`floor(extract(epoch from (${flowOptionPrints.tradedAt} - ${sql.raw(`'${fromIso}'::timestamptz`)})) / ${sql.raw(String(bucketSeconds))})::int`;
};

/** Non-null grouped timestamp from Postgres (Date or ISO string depending on driver). */
const toGroupedDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

/** The update condition of each replace rule; `excluded` is the new row. */
const MINUTE_REPLACE_RULES: Readonly<Record<FlowMinuteReplace, SQL>> = {
  coverage: sql`excluded.covered_seconds >= ${flowMinutes.coveredSeconds}`,
  trades: sql`excluded.trades >= ${flowMinutes.trades}`,
};

export const createFlowRepository = (
  database: DatabaseExecutor
): FlowRepository => {
  const insertOnce = async <T extends Record<string, unknown>>(
    rows: readonly T[],
    insert: (batch: T[]) => Promise<readonly unknown[]>
  ): Promise<number> => {
    let written = 0;
    for (const batch of batches(rows)) written += (await insert(batch)).length;
    return written;
  };

  const newestSample = async (
    symbol: FlowSymbolValue,
    source: FlowSourceValue,
    status: FlowSampleStatusValue | null
  ): Promise<FlowSampleRecord | null> => {
    const [row] = await database
      .select()
      .from(flowSamples)
      .where(
        and(
          eq(flowSamples.symbol, symbol),
          eq(flowSamples.source, source),
          status === null ? undefined : eq(flowSamples.status, status)
        )
      )
      .orderBy(desc(flowSamples.at))
      .limit(1);
    return row ?? null;
  };

  return {
    addOptionGap: async (gap) => {
      await database
        .insert(flowOptionGaps)
        .values(gap)
        .onConflictDoUpdate({
          set: {
            endTime: sql`greatest(${flowOptionGaps.endTime}, excluded.end_time)`,
          },
          target: [flowOptionGaps.symbol, flowOptionGaps.startTime],
        });
    },
    deleteOptionGap: async (symbol, startTime) => {
      await database
        .delete(flowOptionGaps)
        .where(
          and(
            eq(flowOptionGaps.symbol, symbol),
            eq(flowOptionGaps.startTime, startTime)
          )
        );
    },
    insertBooks: (rows) =>
      insertOnce(rows, (batch) =>
        database
          .insert(flowBook)
          .values(batch)
          .onConflictDoNothing()
          .returning({ at: flowBook.at })
      ),
    insertEvents: (rows) =>
      insertOnce(rows, (batch) =>
        database
          .insert(flowEvents)
          .values(batch)
          .onConflictDoNothing()
          .returning({ key: flowEvents.key })
      ),
    insertGex: (rows) =>
      insertOnce(rows, (batch) =>
        database
          .insert(flowGex)
          .values(batch)
          .onConflictDoNothing()
          .returning({ at: flowGex.at })
      ),
    insertOptionPrints: (rows) =>
      insertOnce(rows, (batch) =>
        database
          .insert(flowOptionPrints)
          .values(batch)
          .onConflictDoNothing()
          .returning({ id: flowOptionPrints.id })
      ),
    insertTickSample: async ({ events, trades }) => {
      if (events.length === 0 && trades.length === 0)
        return { events: 0, trades: 0 };
      return await database.transaction(async (tx) => {
        let newTrades = 0;
        for (const batch of batches(trades))
          newTrades += (
            await tx
              .insert(flowLargeTrades)
              .values(batch)
              .onConflictDoNothing()
              .returning({ seq: flowLargeTrades.seq })
          ).length;
        let newEvents = 0;
        for (const batch of batches(events))
          newEvents += (
            await tx
              .insert(flowEvents)
              .values(batch)
              .onConflictDoNothing()
              .returning({ key: flowEvents.key })
          ).length;
        return { events: newEvents, trades: newTrades };
      });
    },
    latestSamples: async (symbol, sources = FLOW_SOURCE_VALUES) => {
      const latest: FlowSampleRecord[] = [];
      const latestOk: FlowSampleRecord[] = [];
      for (const source of sources) {
        const last = await newestSample(symbol, source, null);
        const ok = await newestSample(symbol, source, "ok");
        if (last) latest.push(last);
        if (ok) latestOk.push(ok);
      }
      return { latest, latestOk };
    },
    marketPremiumLedger: async ({ from, to }) =>
      await database
        .select()
        .from(flowMarketPremiumSessions)
        .where(
          and(
            gte(flowMarketPremiumSessions.sessionDate, from),
            lte(flowMarketPremiumSessions.sessionDate, to)
          )
        )
        .orderBy(asc(flowMarketPremiumSessions.sessionDate)),
    marketPremiumRanking: async ({
      sessionDates,
      filterProfile,
      ticker,
      sort,
      limit,
    }) => {
      if (sessionDates.length === 0)
        return {
          rows: [],
          totals: {
            bearishPremium: 0,
            bullishPremium: 0,
            premium: 0,
            tickers: 0,
          },
        };
      const inSessions = and(
        inArray(flowMarketPremium.sessionDate, [...sessionDates]),
        eq(flowMarketPremium.filterProfile, filterProfile)
      );
      const bullish = sql`sum(${flowMarketPremium.bullishPremium})`;
      const bearish = sql`sum(${flowMarketPremium.bearishPremium})`;
      const total = sql`sum(${flowMarketPremium.premium})`;
      const order: Readonly<Record<FlowMarketPremiumSort, SQL>> = {
        net_bearish: sql`${bullish} - ${bearish} asc`,
        net_bullish: sql`${bullish} - ${bearish} desc`,
        total: sql`${total} desc`,
      };
      const ordered = database
        .select({
          bearishPremium: bearish.mapWith(Number),
          bullishPremium: bullish.mapWith(Number),
          premium: total.mapWith(Number),
          sessionsPresent: sql`count(*)`.mapWith(Number),
          ticker: flowMarketPremium.ticker,
          tradeCount: sql`sum(${flowMarketPremium.tradeCount})`.mapWith(Number),
          volume: sql`sum(${flowMarketPremium.volume})`.mapWith(Number),
        })
        .from(flowMarketPremium)
        .where(inSessions)
        .groupBy(flowMarketPremium.ticker)
        .orderBy(order[sort], asc(flowMarketPremium.ticker));
      // With a ticker filter the whole market is ordered (a few thousand tickers at most), so the
      // ticker keeps its market rank.
      const ranked = (
        ticker === null ? await ordered.limit(limit) : await ordered
      ).map((row, index) => ({ ...row, rank: index + 1 }));
      const rows =
        ticker === null
          ? ranked
          : ranked.filter((row) => row.ticker === ticker).slice(0, limit);
      const [totals] = await database
        .select({
          bearishPremium: sql`coalesce(${bearish}, 0)`.mapWith(Number),
          bullishPremium: sql`coalesce(${bullish}, 0)`.mapWith(Number),
          premium: sql`coalesce(${total}, 0)`.mapWith(Number),
          tickers: sql`count(distinct ${flowMarketPremium.ticker})`.mapWith(
            Number
          ),
        })
        .from(flowMarketPremium)
        .where(inSessions);
      return {
        rows,
        totals: totals ?? {
          bearishPremium: 0,
          bullishPremium: 0,
          premium: 0,
          tickers: 0,
        },
      };
    },
    moveOptionGapEnd: async (symbol, startTime, endTime) => {
      await database
        .update(flowOptionGaps)
        .set({ endTime })
        .where(
          and(
            eq(flowOptionGaps.symbol, symbol),
            eq(flowOptionGaps.startTime, startTime)
          )
        );
    },
    netDriftPriceAtOrBefore: async (ticker, at) => {
      const [row] = await database
        .select({
          minute: flowNetDrift.minute,
          price: flowNetDrift.underlyingPrice,
        })
        .from(flowNetDrift)
        .where(
          and(
            eq(flowNetDrift.ticker, ticker),
            eq(flowNetDrift.part, "total"),
            lte(flowNetDrift.minute, at),
            isNotNull(flowNetDrift.underlyingPrice)
          )
        )
        .orderBy(desc(flowNetDrift.minute))
        .limit(1);
      if (row === undefined || row.price === null) return null;
      return { minute: row.minute, price: row.price };
    },
    newestDataAt: async (symbol) => {
      const [minute] = await database
        .select({ at: max(flowMinutes.minute) })
        .from(flowMinutes)
        .where(eq(flowMinutes.symbol, symbol));
      const [book] = await database
        .select({ at: max(flowBook.at) })
        .from(flowBook)
        .where(eq(flowBook.symbol, symbol));
      const [print] = await database
        .select({ at: max(flowOptionPrints.tradedAt) })
        .from(flowOptionPrints)
        .where(eq(flowOptionPrints.symbol, symbol));
      return newestDate([
        toDate(minute?.at),
        toDate(book?.at),
        toDate(print?.at),
      ]);
    },
    newestNetDriftMinute: async (ticker) => {
      const [row] = await database
        .select({ minute: max(flowNetDrift.minute) })
        .from(flowNetDrift)
        .where(
          and(eq(flowNetDrift.ticker, ticker), eq(flowNetDrift.part, "total"))
        );
      return toDate(row?.minute);
    },
    newestOptionPrintAt: async (symbol) => {
      const [row] = await database
        .select({ at: max(flowOptionPrints.tradedAt) })
        .from(flowOptionPrints)
        .where(eq(flowOptionPrints.symbol, symbol));
      return toDate(row?.at);
    },
    optionGaps: (symbol) =>
      database
        .select()
        .from(flowOptionGaps)
        .where(eq(flowOptionGaps.symbol, symbol))
        .orderBy(desc(flowOptionGaps.endTime), desc(flowOptionGaps.startTime)),
    prune: async (cutoffs) => {
      const removed = [
        await database
          .delete(flowSamples)
          .where(lt(flowSamples.at, cutoffs.flow_samples))
          .returning({ at: flowSamples.at }),
        await database
          .delete(flowMinutes)
          .where(lt(flowMinutes.minute, cutoffs.flow_minutes))
          .returning({ at: flowMinutes.minute }),
        await database
          .delete(flowBook)
          .where(lt(flowBook.at, cutoffs.flow_book))
          .returning({ at: flowBook.at }),
        await database
          .delete(flowOptionPrints)
          .where(lt(flowOptionPrints.tradedAt, cutoffs.flow_option_prints))
          .returning({ at: flowOptionPrints.tradedAt }),
        await database
          .delete(flowEvents)
          .where(lt(flowEvents.at, cutoffs.flow_events))
          .returning({ at: flowEvents.at }),
        await database
          .delete(flowGex)
          .where(lt(flowGex.at, cutoffs.flow_gex))
          .returning({ at: flowGex.at }),
        // A gap whose newest part is older than the cutoff would only fetch rows prune removes.
        await database
          .delete(flowOptionGaps)
          .where(lt(flowOptionGaps.endTime, cutoffs.flow_option_gaps))
          .returning({ at: flowOptionGaps.endTime }),
        await database
          .delete(flowNetDrift)
          .where(lt(flowNetDrift.minute, cutoffs.flow_net_drift))
          .returning({ at: flowNetDrift.minute }),
        await database
          .delete(flowLargeTrades)
          .where(lt(flowLargeTrades.second, cutoffs.flow_large_trades))
          .returning({ at: flowLargeTrades.second }),
        await database
          .delete(flowBookSnapshots)
          .where(lt(flowBookSnapshots.capturedAt, cutoffs.flow_book_snapshots))
          .returning({ at: flowBookSnapshots.capturedAt }),
      ];
      return removed.reduce((total, rows) => total + rows.length, 0);
    },
    readOptionStrikeTotals: ({ symbol, from, to, minExpiry }) =>
      database
        .select({
          strike: flowOptionPrints.strike,
          right: flowOptionPrints.right,
          sentiment: flowOptionPrints.sentiment,
          contracts: sql`sum(${flowOptionPrints.size})`.mapWith(Number),
          premium: sql`sum(${flowOptionPrints.premium})`.mapWith(Number),
          trades: sql`count(*)`.mapWith(Number),
          oldestAt: sql`min(${flowOptionPrints.tradedAt})`.mapWith(
            flowOptionPrints.tradedAt
          ),
          newestAt: sql`max(${flowOptionPrints.tradedAt})`.mapWith(
            flowOptionPrints.tradedAt
          ),
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lt(flowOptionPrints.tradedAt, to),
            gte(flowOptionPrints.expiry, minExpiry),
            gt(flowOptionPrints.strike, 0)
          )
        )
        .groupBy(
          flowOptionPrints.strike,
          flowOptionPrints.right,
          flowOptionPrints.sentiment
        )
        .orderBy(
          asc(flowOptionPrints.strike),
          asc(flowOptionPrints.right),
          asc(flowOptionPrints.sentiment)
        ),
    readBookSnapshots: async ({ symbol, from, to, limit }) => {
      const rows = await database
        .select()
        .from(flowBookSnapshots)
        .where(
          and(
            eq(flowBookSnapshots.symbol, symbol),
            gte(flowBookSnapshots.capturedAt, from),
            lt(flowBookSnapshots.capturedAt, to)
          )
        )
        .orderBy(desc(flowBookSnapshots.capturedAt))
        .limit(limit);
      return rows.reverse();
    },
    readEvents: async ({ from, kinds, limit, symbol, to }) =>
      await database
        .select()
        .from(flowEvents)
        .where(
          and(
            eq(flowEvents.symbol, symbol),
            gte(flowEvents.at, from),
            lte(flowEvents.at, to),
            kinds !== undefined && kinds.length > 0
              ? inArray(flowEvents.kind, [...kinds])
              : undefined
          )
        )
        .orderBy(desc(flowEvents.at), asc(flowEvents.key))
        .limit(limit),
    readHedgingPrints: ({ symbol, from, to, limit }) =>
      database
        .select({
          dte: flowOptionPrints.dte,
          id: flowOptionPrints.id,
          iv: flowOptionPrints.iv,
          right: flowOptionPrints.right,
          side: flowOptionPrints.side,
          size: flowOptionPrints.size,
          strike: flowOptionPrints.strike,
          tradedAt: flowOptionPrints.tradedAt,
          underlyingPrice: flowOptionPrints.underlyingPrice,
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lt(flowOptionPrints.tradedAt, to)
          )
        )
        .orderBy(asc(flowOptionPrints.tradedAt), asc(flowOptionPrints.id))
        .limit(limit),
    readLargeOptionPrints: ({ symbol, from, to, minPremiumUsd, limit }) =>
      database
        .select()
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lt(flowOptionPrints.tradedAt, to),
            gte(flowOptionPrints.premium, minPremiumUsd)
          )
        )
        .orderBy(
          desc(flowOptionPrints.premium),
          desc(flowOptionPrints.tradedAt),
          desc(flowOptionPrints.id)
        )
        .limit(limit),
    readLargeTrades: ({ symbol, from, to }) =>
      database
        .select()
        .from(flowLargeTrades)
        .where(
          and(
            eq(flowLargeTrades.symbol, symbol),
            gte(flowLargeTrades.second, from),
            lt(flowLargeTrades.second, to)
          )
        )
        .orderBy(asc(flowLargeTrades.second), asc(flowLargeTrades.seq)),
    readMinuteStarts: async ({ symbol, from, to }) => {
      const rows = await database
        .select({ minute: flowMinutes.minute })
        .from(flowMinutes)
        .where(
          and(
            eq(flowMinutes.symbol, symbol),
            gte(flowMinutes.minute, from),
            lt(flowMinutes.minute, to)
          )
        )
        .orderBy(asc(flowMinutes.minute));
      return rows.map((row) => row.minute);
    },
    readMinutes: ({ symbol, from, to }) =>
      database
        .select()
        .from(flowMinutes)
        .where(
          and(
            eq(flowMinutes.symbol, symbol),
            gte(flowMinutes.minute, from),
            lt(flowMinutes.minute, to)
          )
        )
        .orderBy(asc(flowMinutes.minute)),
    readNetDrift: ({ tickers, from, to }) =>
      database
        .select()
        .from(flowNetDrift)
        .where(
          and(
            inArray(flowNetDrift.ticker, [...tickers]),
            gte(flowNetDrift.minute, from),
            lt(flowNetDrift.minute, to)
          )
        )
        .orderBy(asc(flowNetDrift.minute)),
    readOptionPrintDays: async ({ symbol, from, to, limit }) => {
      const nyTimestamp = sql`(${flowOptionPrints.tradedAt} at time zone 'America/New_York')`;
      const sessionDay = sql<string>`to_char(${nyTimestamp}, 'YYYY-MM-DD')`;
      const rows = await database
        .select({
          callPremium:
            sql`coalesce(sum(${flowOptionPrints.premium}) filter (where ${flowOptionPrints.right} = 'call'), 0)`.mapWith(
              Number
            ),
          callPrints:
            sql`count(*) filter (where ${flowOptionPrints.right} = 'call')`.mapWith(
              Number
            ),
          callVolume:
            sql`coalesce(sum(${flowOptionPrints.size}) filter (where ${flowOptionPrints.right} = 'call'), 0)`.mapWith(
              Number
            ),
          lastPrice: sql<
            number | string | null
          >`(array_agg(${flowOptionPrints.underlyingPrice} order by ${flowOptionPrints.tradedAt} desc, ${flowOptionPrints.id} desc) filter (where ${flowOptionPrints.underlyingPrice} > 0))[1]`,
          putPremium:
            sql`coalesce(sum(${flowOptionPrints.premium}) filter (where ${flowOptionPrints.right} = 'put'), 0)`.mapWith(
              Number
            ),
          putPrints:
            sql`count(*) filter (where ${flowOptionPrints.right} = 'put')`.mapWith(
              Number
            ),
          putVolume:
            sql`coalesce(sum(${flowOptionPrints.size}) filter (where ${flowOptionPrints.right} = 'put'), 0)`.mapWith(
              Number
            ),
          session: sessionDay,
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lt(flowOptionPrints.tradedAt, to),
            sql`extract(isodow from ${nyTimestamp}) <= 5`,
            sql`${nyTimestamp}::time >= time '09:30:00'`,
            sql`${nyTimestamp}::time < time '16:15:00'`
          )
        )
        .groupBy(sessionDay)
        .orderBy(desc(sessionDay))
        .limit(limit);
      return rows
        .map((row) => ({
          callPremium: Number(row.callPremium),
          callPrints: Number(row.callPrints),
          callVolume: Number(row.callVolume),
          lastPrice: row.lastPrice === null ? null : Number(row.lastPrice),
          putPremium: Number(row.putPremium),
          putPrints: Number(row.putPrints),
          putVolume: Number(row.putVolume),
          session: String(row.session),
        }))
        .reverse();
    },
    readOptionPrintStrikeBuckets: async (query) => {
      const slotIndex = strikeSlotExpression(query);
      const rows = await database
        .select({
          lastTradedAt: sql<Date | string>`max(${flowOptionPrints.tradedAt})`,
          premium: sql`coalesce(sum(${flowOptionPrints.premium}), 0)`.mapWith(
            Number
          ),
          prints: sql`count(*)`.mapWith(Number),
          right: flowOptionPrints.right,
          side: flowOptionPrints.side,
          slotIndex,
          strike: flowOptionPrints.strike,
          volume: sql`coalesce(sum(${flowOptionPrints.size}), 0)`.mapWith(
            Number
          ),
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, query.symbol),
            gte(flowOptionPrints.tradedAt, query.from),
            lt(flowOptionPrints.tradedAt, query.to)
          )
        )
        .groupBy(
          flowOptionPrints.strike,
          slotIndex,
          flowOptionPrints.right,
          flowOptionPrints.side
        )
        .orderBy(
          desc(flowOptionPrints.strike),
          asc(slotIndex),
          asc(flowOptionPrints.right),
          asc(flowOptionPrints.side)
        );
      return rows.map((row) => ({
        lastTradedAt: toGroupedDate(row.lastTradedAt),
        premium: Number(row.premium),
        prints: Number(row.prints),
        right: row.right,
        side: row.side,
        slotIndex: Number(row.slotIndex),
        strike: Number(row.strike),
        volume: Number(row.volume),
      }));
    },
    readOptionPrintSlotPrices: async (query) => {
      const slotIndex = strikeSlotExpression(query);
      const rows = await database
        .selectDistinctOn([slotIndex], {
          price: flowOptionPrints.underlyingPrice,
          pricedAt: flowOptionPrints.tradedAt,
          slotIndex,
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, query.symbol),
            gte(flowOptionPrints.tradedAt, query.from),
            lt(flowOptionPrints.tradedAt, query.to),
            isNotNull(flowOptionPrints.underlyingPrice),
            sql`${flowOptionPrints.underlyingPrice} > 0 and ${flowOptionPrints.underlyingPrice} < 'Infinity'::double precision and ${flowOptionPrints.underlyingPrice} <> 'NaN'::double precision`
          )
        )
        .orderBy(
          asc(slotIndex),
          desc(flowOptionPrints.tradedAt),
          desc(flowOptionPrints.id)
        );
      return rows.map((row) => ({
        price: Number(row.price),
        pricedAt: toGroupedDate(row.pricedAt),
        slotIndex: Number(row.slotIndex),
      }));
    },
    readOptionPrintMinutes: async ({ symbol, from, to }) => {
      const bucket = sql<
        Date | string
      >`date_trunc('minute', ${flowOptionPrints.tradedAt})`;
      const rows = await database
        .select({
          callPremium:
            sql`coalesce(sum(${flowOptionPrints.premium}) filter (where ${flowOptionPrints.right} = 'call'), 0)`.mapWith(
              Number
            ),
          callPrints:
            sql`count(*) filter (where ${flowOptionPrints.right} = 'call')`.mapWith(
              Number
            ),
          callVolume:
            sql`coalesce(sum(${flowOptionPrints.size}) filter (where ${flowOptionPrints.right} = 'call'), 0)`.mapWith(
              Number
            ),
          lastPrice: sql<
            number | string | null
          >`(array_agg(${flowOptionPrints.underlyingPrice} order by ${flowOptionPrints.tradedAt} desc, ${flowOptionPrints.id} desc) filter (where ${flowOptionPrints.underlyingPrice} > 0))[1]`,
          lastTradedAt: sql<Date | string>`max(${flowOptionPrints.tradedAt})`,
          minute: bucket,
          putPremium:
            sql`coalesce(sum(${flowOptionPrints.premium}) filter (where ${flowOptionPrints.right} = 'put'), 0)`.mapWith(
              Number
            ),
          putPrints:
            sql`count(*) filter (where ${flowOptionPrints.right} = 'put')`.mapWith(
              Number
            ),
          putVolume:
            sql`coalesce(sum(${flowOptionPrints.size}) filter (where ${flowOptionPrints.right} = 'put'), 0)`.mapWith(
              Number
            ),
        })
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lt(flowOptionPrints.tradedAt, to)
          )
        )
        .groupBy(bucket)
        .orderBy(asc(bucket));
      return rows.map((row) => ({
        callPremium: Number(row.callPremium),
        callPrints: Number(row.callPrints),
        callVolume: Number(row.callVolume),
        lastPrice: row.lastPrice === null ? null : Number(row.lastPrice),
        lastTradedAt: toGroupedDate(row.lastTradedAt),
        minute: toGroupedDate(row.minute),
        putPremium: Number(row.putPremium),
        putPrints: Number(row.putPrints),
        putVolume: Number(row.putVolume),
      }));
    },
    readTapeSeconds: ({ symbol, from, to }) =>
      database
        .select({
          contract: flowTapeSeconds.contract,
          contracts: flowTapeSeconds.contracts,
          covered: flowTapeSeconds.covered,
          minute: flowTapeSeconds.minute,
          symbol: flowTapeSeconds.symbol,
          totalTrades: flowTapeSeconds.totalTrades,
          trades: flowTapeSeconds.trades,
        })
        .from(flowTapeSeconds)
        .where(
          and(
            eq(flowTapeSeconds.symbol, symbol),
            gte(flowTapeSeconds.minute, from),
            lt(flowTapeSeconds.minute, to)
          )
        )
        .orderBy(asc(flowTapeSeconds.minute)),
    readWindow: async ({ symbol, from, to, gexAt }) => {
      const minutes = await database
        .select()
        .from(flowMinutes)
        .where(
          and(
            eq(flowMinutes.symbol, symbol),
            gte(flowMinutes.minute, from),
            lte(flowMinutes.minute, to)
          )
        )
        .orderBy(asc(flowMinutes.minute));
      const books = await database
        .select()
        .from(flowBook)
        .where(
          and(
            eq(flowBook.symbol, symbol),
            gte(flowBook.at, from),
            lte(flowBook.at, to)
          )
        )
        .orderBy(asc(flowBook.at));
      const prints = await database
        .select()
        .from(flowOptionPrints)
        .where(
          and(
            eq(flowOptionPrints.symbol, symbol),
            gte(flowOptionPrints.tradedAt, from),
            lte(flowOptionPrints.tradedAt, to)
          )
        )
        .orderBy(asc(flowOptionPrints.tradedAt));
      const events = await database
        .select()
        .from(flowEvents)
        .where(
          and(
            eq(flowEvents.symbol, symbol),
            gte(flowEvents.at, from),
            lte(flowEvents.at, to)
          )
        )
        .orderBy(desc(flowEvents.at));
      const [gex] = await database
        .select()
        .from(flowGex)
        .where(and(eq(flowGex.symbol, symbol), lte(flowGex.at, gexAt ?? to)))
        .orderBy(desc(flowGex.at))
        .limit(1);
      return { books, events, gex: gex ?? null, minutes, prints };
    },
    recordSample: async (sample) => {
      await database
        .insert(flowSamples)
        .values(sample)
        .onConflictDoUpdate({
          set: {
            items: sql`excluded.items`,
            message: sql`excluded.message`,
            status: sql`excluded.status`,
          },
          target: [flowSamples.symbol, flowSamples.source, flowSamples.at],
        });
    },
    storeMarketPremium: async ({ rows, session }) =>
      await database.transaction(async (tx) => {
        let written = 0;
        for (const batch of batches(rows))
          written += (
            await tx
              .insert(flowMarketPremium)
              .values(batch)
              .onConflictDoUpdate({
                set: {
                  bearishPremium: sql`excluded.bearish_premium`,
                  bullishPremium: sql`excluded.bullish_premium`,
                  capturedAt: sql`excluded.captured_at`,
                  filterProfile: sql`excluded.filter_profile`,
                  premium: sql`excluded.premium`,
                  tradeCount: sql`excluded.trade_count`,
                  volume: sql`excluded.volume`,
                },
                target: [
                  flowMarketPremium.sessionDate,
                  flowMarketPremium.ticker,
                ],
              })
              .returning({ ticker: flowMarketPremium.ticker })
          ).length;
        // The newest answer replaces the session's whole row set: a ticker that is no longer in it
        // (a corrected or cancelled trade) keeps an older capture time and is removed.
        const [first] = rows;
        if (first !== undefined)
          await tx
            .delete(flowMarketPremium)
            .where(
              and(
                eq(flowMarketPremium.sessionDate, first.sessionDate),
                lt(flowMarketPremium.capturedAt, first.capturedAt)
              )
            );
        await tx
          .insert(flowMarketPremiumSessions)
          .values(session)
          .onConflictDoUpdate({
            set: {
              attempts: sql`excluded.attempts`,
              capturedAt: sql`excluded.captured_at`,
              lastAttemptAt: sql`excluded.last_attempt_at`,
              lastMessage: sql`excluded.last_message`,
              status: sql`excluded.status`,
              tickers: sql`excluded.tickers`,
            },
            target: flowMarketPremiumSessions.sessionDate,
          });
        return written;
      }),
    upsertBookSnapshots: async (rows) => {
      let written = 0;
      for (const batch of batches(rows)) {
        const stored = await database
          .insert(flowBookSnapshots)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              askPrices: sql`excluded.ask_prices`,
              askSizes: sql`excluded.ask_sizes`,
              bestAsk: sql`excluded.best_ask`,
              bestBid: sql`excluded.best_bid`,
              bidPrices: sql`excluded.bid_prices`,
              bidSizes: sql`excluded.bid_sizes`,
              capture: sql`excluded.capture`,
              contract: sql`excluded.contract`,
              minTick: sql`excluded.min_tick`,
            },
            setWhere: sql`excluded.capture = 'streamed' or ${flowBookSnapshots.capture} = 'sampled'`,
            target: [flowBookSnapshots.symbol, flowBookSnapshots.capturedAt],
          })
          .returning({ capturedAt: flowBookSnapshots.capturedAt });
        written += stored.length;
      }
      return written;
    },
    upsertMinutes: async (rows, replace = "coverage") => {
      let written = 0;
      for (const batch of batches(rows)) {
        const stored = await database
          .insert(flowMinutes)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              absorption: sql`excluded.absorption`,
              buyVolume: sql`excluded.buy_volume`,
              close: sql`excluded.close`,
              coveredSeconds: sql`excluded.covered_seconds`,
              delta: sql`excluded.delta`,
              high: sql`excluded.high`,
              largePrints: sql`excluded.large_prints`,
              largePrintVolume: sql`excluded.large_print_volume`,
              low: sql`excluded.low`,
              offExchangeVolume: sql`excluded.off_exchange_volume`,
              open: sql`excluded.open`,
              sellVolume: sql`excluded.sell_volume`,
              stackedBuy: sql`excluded.stacked_buy`,
              stackedSell: sql`excluded.stacked_sell`,
              trades: sql`excluded.trades`,
              volume: sql`excluded.volume`,
              vwap: sql`excluded.vwap`,
            },
            setWhere: MINUTE_REPLACE_RULES[replace],
            target: [flowMinutes.symbol, flowMinutes.minute],
          })
          .returning({ minute: flowMinutes.minute });
        written += stored.length;
      }
      return written;
    },
    upsertNetDrift: async (rows) => {
      let written = 0;
      for (const batch of batches(rows)) {
        const stored = await database
          .insert(flowNetDrift)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              filterProfile: sql`excluded.filter_profile`,
              netCallPremium: sql`excluded.net_call_premium`,
              netCallVolume: sql`excluded.net_call_volume`,
              netPutPremium: sql`excluded.net_put_premium`,
              netPutVolume: sql`excluded.net_put_volume`,
              underlyingPrice: sql`excluded.underlying_price`,
            },
            setWhere: sql`${flowNetDrift.netCallPremium} is distinct from excluded.net_call_premium or ${flowNetDrift.netPutPremium} is distinct from excluded.net_put_premium or ${flowNetDrift.netCallVolume} is distinct from excluded.net_call_volume or ${flowNetDrift.netPutVolume} is distinct from excluded.net_put_volume or ${flowNetDrift.underlyingPrice} is distinct from excluded.underlying_price or ${flowNetDrift.filterProfile} is distinct from excluded.filter_profile`,
            target: [
              flowNetDrift.ticker,
              flowNetDrift.part,
              flowNetDrift.minute,
            ],
          })
          .returning({ minute: flowNetDrift.minute });
        written += stored.length;
      }
      return written;
    },
    upsertTapeSeconds: async (rows) => {
      let written = 0;
      for (const batch of batches(rows)) {
        const stored = await database
          .insert(flowTapeSeconds)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              contract: sql`excluded.contract`,
              contracts: sql`excluded.contracts`,
              covered: sql`excluded.covered`,
              totalTrades: sql`excluded.total_trades`,
              trades: sql`excluded.trades`,
            },
            setWhere: sql`excluded.total_trades >= ${flowTapeSeconds.totalTrades}`,
            target: [flowTapeSeconds.symbol, flowTapeSeconds.minute],
          })
          .returning({ minute: flowTapeSeconds.minute });
        written += stored.length;
      }
      return written;
    },
  };
};
