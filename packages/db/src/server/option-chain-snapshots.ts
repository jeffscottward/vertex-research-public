import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  type OptionChainSnapshotQuoteRow,
  type OptionChainSnapshotQuoteSource,
  type OptionChainSnapshotRight,
  type OptionChainSnapshotRow,
  optionChainSnapshotQuotes,
  optionChainSnapshots,
} from "../schema/index.ts";
import type { Database } from "./client.ts";

// Option chain snapshots repository (migration 0092_option_chain_snapshots).
// optionsChain.ingestSnapshot upserts one (snapshotAt, underlying, expiry) header and replaces its
// quote rows inside a single transaction; optionsChain.snapshot reads the newest or requested
// snapshot plus recent run/day availability. Research only: no order path.

export const OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH = 500;
export const OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS = 400;
export const OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS = 60;
export const OPTION_CHAIN_SNAPSHOT_HEADER_SCAN_LIMIT = 2000;

export type OptionChainSnapshotQuoteInput = Readonly<{
  ask: number | null;
  bid: number | null;
  iv: number | null;
  last: number | null;
  openInterest: number | null;
  right: OptionChainSnapshotRight;
  source: OptionChainSnapshotQuoteSource;
  strike: number;
  volume: number | null;
}>;

export type OptionChainSnapshotIngestRecord = Readonly<{
  expiry: string;
  quotes: readonly OptionChainSnapshotQuoteInput[];
  snapshotAt: Date;
  source: string;
  spot: number | null;
  tradingDay: string;
  underlying: string;
}>;

export type OptionChainSnapshotIngestResult = Readonly<{
  created: boolean;
  expiry: string;
  quoteCount: number;
  snapshotAt: Date;
  snapshotId: string;
  tradingDay: string;
  underlying: string;
}>;

export type OptionChainSnapshotRunSummary = Readonly<{
  expiries: readonly string[];
  quoteCount: number;
  snapshotAt: Date;
  source: string;
  spot: number | null;
  tradingDay: string;
}>;

export type OptionChainSnapshotExpiryRead = Readonly<{
  expiry: string;
  quoteCount: number;
  quotes: readonly OptionChainSnapshotQuoteInput[];
  source: string;
  spot: number | null;
}>;

export type OptionChainSnapshotReadQuery = Readonly<{
  expiry?: string | undefined;
  snapshotAt?: Date | undefined;
  tradingDay?: string | undefined;
  underlying: string;
}>;

export type OptionChainSnapshotReadResult = Readonly<{
  availableDays: readonly string[];
  availableSnapshots: readonly OptionChainSnapshotRunSummary[];
  expiries: readonly OptionChainSnapshotExpiryRead[];
  snapshotAt: Date | null;
  tradingDay: string | null;
  underlying: string;
}>;

export interface OptionChainSnapshotsRepository {
  ingestSnapshot: (
    record: OptionChainSnapshotIngestRecord
  ) => Promise<OptionChainSnapshotIngestResult>;
  readSnapshot: (
    query: OptionChainSnapshotReadQuery
  ) => Promise<OptionChainSnapshotReadResult>;
}

export const optionChainSnapshotId = (
  snapshotAt: Date,
  underlying: string,
  expiry: string
): string => `${snapshotAt.toISOString()}|${underlying}|${expiry}`;

const summarizeHeaders = (
  headers: readonly OptionChainSnapshotRow[]
): Readonly<{
  availableDays: string[];
  availableSnapshots: OptionChainSnapshotRunSummary[];
}> => {
  const days: string[] = [];
  const seenDays = new Set<string>();
  const runMap = new Map<
    string,
    {
      expiries: string[];
      quoteCount: number;
      snapshotAt: Date;
      sources: Set<string>;
      spot: number | null;
      tradingDay: string;
    }
  >();

  for (const row of headers) {
    if (
      !seenDays.has(row.tradingDay) &&
      days.length < OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS
    ) {
      seenDays.add(row.tradingDay);
      days.push(row.tradingDay);
    }
    const key = row.snapshotAt.toISOString();
    let run = runMap.get(key);
    if (run === undefined) {
      if (runMap.size >= OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS) continue;
      run = {
        expiries: [],
        quoteCount: 0,
        snapshotAt: row.snapshotAt,
        sources: new Set(),
        spot: row.spot,
        tradingDay: row.tradingDay,
      };
      runMap.set(key, run);
    }
    run.expiries.push(row.expiry);
    run.quoteCount += row.quoteCount;
    run.sources.add(row.source);
    if (run.spot === null && row.spot !== null) run.spot = row.spot;
  }

  const availableSnapshots: OptionChainSnapshotRunSummary[] = [];
  for (const run of runMap.values()) {
    availableSnapshots.push({
      expiries: [...run.expiries].sort(),
      quoteCount: run.quoteCount,
      snapshotAt: run.snapshotAt,
      source: [...run.sources].sort().join("+"),
      spot: run.spot,
      tradingDay: run.tradingDay,
    });
  }
  return { availableDays: days, availableSnapshots };
};

const toQuoteOutput = (
  row: OptionChainSnapshotQuoteRow
): OptionChainSnapshotQuoteInput => ({
  ask: row.ask,
  bid: row.bid,
  iv: row.iv,
  last: row.last,
  openInterest: row.openInterest,
  right: row.right,
  source: row.source,
  strike: row.strike,
  volume: row.volume,
});

export const createOptionChainSnapshotsRepository = (
  database: Database,
  now: () => Date = () => new Date()
): OptionChainSnapshotsRepository => ({
  ingestSnapshot: async (record) =>
    database.transaction(async (tx) => {
      // Deterministic PK derived from the natural key (snapshotAt, underlying, expiry): conflicting
      // on `id` handles concurrent upserts atomically without a dual-unique-constraint race, and
      // `xmax = 0` reports whether Postgres inserted a new row or updated an existing one.
      const snapshotId = optionChainSnapshotId(
        record.snapshotAt,
        record.underlying,
        record.expiry
      );
      const updatedAt = now();
      const persisted = (
        await tx
          .insert(optionChainSnapshots)
          .values({
            createdAt: updatedAt,
            expiry: record.expiry,
            id: snapshotId,
            quoteCount: record.quotes.length,
            snapshotAt: record.snapshotAt,
            source: record.source,
            spot: record.spot,
            tradingDay: record.tradingDay,
            underlying: record.underlying,
            updatedAt,
          })
          .onConflictDoUpdate({
            set: {
              quoteCount: record.quotes.length,
              source: record.source,
              spot: record.spot,
              tradingDay: record.tradingDay,
              updatedAt,
            },
            target: optionChainSnapshots.id,
          })
          .returning({
            created: sql<boolean>`(xmax = 0)`,
            id: optionChainSnapshots.id,
          })
      )[0];
      const persistedId = persisted?.id ?? snapshotId;
      const created = persisted?.created ?? true;

      await tx
        .delete(optionChainSnapshotQuotes)
        .where(eq(optionChainSnapshotQuotes.snapshotId, persistedId));

      for (
        let start = 0;
        start < record.quotes.length;
        start += OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH
      ) {
        const chunk = record.quotes.slice(
          start,
          start + OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH
        );
        await tx.insert(optionChainSnapshotQuotes).values(
          chunk.map((quote) => ({
            ask: quote.ask,
            bid: quote.bid,
            iv: quote.iv,
            last: quote.last,
            openInterest: quote.openInterest,
            right: quote.right,
            snapshotId: persistedId,
            source: quote.source,
            strike: quote.strike,
            volume: quote.volume,
          }))
        );
      }

      return {
        created,
        expiry: record.expiry,
        quoteCount: record.quotes.length,
        snapshotAt: record.snapshotAt,
        snapshotId: persistedId,
        tradingDay: record.tradingDay,
        underlying: record.underlying,
      };
    }),

  readSnapshot: async (query) => {
    const recentHeaders = await database
      .select()
      .from(optionChainSnapshots)
      .where(eq(optionChainSnapshots.underlying, query.underlying))
      .orderBy(
        desc(optionChainSnapshots.snapshotAt),
        asc(optionChainSnapshots.expiry)
      )
      .limit(OPTION_CHAIN_SNAPSHOT_HEADER_SCAN_LIMIT);

    const { availableDays, availableSnapshots } =
      summarizeHeaders(recentHeaders);

    let candidateHeaders: readonly OptionChainSnapshotRow[];
    if (
      query.snapshotAt !== undefined ||
      query.tradingDay !== undefined ||
      query.expiry !== undefined
    ) {
      const filters = [eq(optionChainSnapshots.underlying, query.underlying)];
      if (query.snapshotAt !== undefined)
        filters.push(eq(optionChainSnapshots.snapshotAt, query.snapshotAt));
      if (query.tradingDay !== undefined)
        filters.push(eq(optionChainSnapshots.tradingDay, query.tradingDay));
      if (query.expiry !== undefined)
        filters.push(eq(optionChainSnapshots.expiry, query.expiry));
      candidateHeaders = await database
        .select()
        .from(optionChainSnapshots)
        .where(and(...filters))
        .orderBy(
          desc(optionChainSnapshots.snapshotAt),
          asc(optionChainSnapshots.expiry)
        );
    } else {
      candidateHeaders = recentHeaders;
    }

    const newest = candidateHeaders[0];
    if (newest === undefined) {
      return {
        availableDays,
        availableSnapshots,
        expiries: [],
        snapshotAt: null,
        tradingDay: null,
        underlying: query.underlying,
      };
    }

    const targetTime = newest.snapshotAt.getTime();
    const selectedHeaders = candidateHeaders.filter(
      (row) => row.snapshotAt.getTime() === targetTime
    );

    const quoteRows = await database
      .select()
      .from(optionChainSnapshotQuotes)
      .where(
        inArray(
          optionChainSnapshotQuotes.snapshotId,
          selectedHeaders.map((row) => row.id)
        )
      )
      .orderBy(
        asc(optionChainSnapshotQuotes.strike),
        asc(optionChainSnapshotQuotes.right)
      );

    const quotesBySnapshot = new Map<string, OptionChainSnapshotQuoteInput[]>();
    for (const row of quoteRows) {
      let bucket = quotesBySnapshot.get(row.snapshotId);
      if (bucket === undefined) {
        bucket = [];
        quotesBySnapshot.set(row.snapshotId, bucket);
      }
      bucket.push(toQuoteOutput(row));
    }

    return {
      availableDays,
      availableSnapshots,
      expiries: selectedHeaders.map((header) => ({
        expiry: header.expiry,
        quoteCount: header.quoteCount,
        quotes: quotesBySnapshot.get(header.id) ?? [],
        source: header.source,
        spot: header.spot,
      })),
      snapshotAt: newest.snapshotAt,
      tradingDay: newest.tradingDay,
      underlying: query.underlying,
    };
  },
});
