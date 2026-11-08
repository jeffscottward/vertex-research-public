import { and, asc, desc, eq, gte, lt, lte, max, sql } from "drizzle-orm";

import {
  type FlowSampleStatusValue,
  type FlowSourceValue,
  type FlowSymbolValue,
  flowBook,
  flowEvents,
  flowGex,
  flowMinutes,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Flow pipeline storage (flow.*, docs/vertex-rebuild/flow-pipeline.md). flow.collect records one
// sample row per source attempt and upserts the derived rows; flow.snapshot reads one symbol's
// window. Rows are derived and regenerable; prune() removes rows older than the retention cutoff.
// Research only: no order path.

export type {
  FlowSampleStatusValue,
  FlowSourceValue,
  FlowSymbolValue,
} from "../schema/index.ts";

export type FlowSampleRecord = typeof flowSamples.$inferSelect;
export type FlowMinuteRecord = typeof flowMinutes.$inferSelect;
export type FlowBookRecord = typeof flowBook.$inferSelect;
export type FlowOptionPrintRecord = typeof flowOptionPrints.$inferSelect;
export type FlowOptionGapRecord = typeof flowOptionGaps.$inferSelect;
export type FlowEventRecord = typeof flowEvents.$inferSelect;
export type FlowGexRecord = typeof flowGex.$inferSelect;

/** Rows one insert statement may hold (keeps each statement well under the parameter limit). */
export const FLOW_UPSERT_BATCH = 250;

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

export type FlowRepository = Readonly<{
  recordSample: (sample: FlowSampleRecord) => Promise<void>;
  /** Upserts by (symbol, minute); a stored minute is replaced only by one that covers at least as much of it. */
  upsertMinutes: (rows: readonly FlowMinuteRecord[]) => Promise<number>;
  /** Insert-once rows; each returns how many rows were new. */
  insertBooks: (rows: readonly FlowBookRecord[]) => Promise<number>;
  insertOptionPrints: (
    rows: readonly FlowOptionPrintRecord[]
  ) => Promise<number>;
  insertEvents: (rows: readonly FlowEventRecord[]) => Promise<number>;
  insertGex: (rows: readonly FlowGexRecord[]) => Promise<number>;
  /** Deletes rows older than the cutoff from every flow table; returns the rows removed. */
  prune: (before: Date) => Promise<number>;
  /** Newest stored option print time for a symbol (paging stops there). */
  newestOptionPrintAt: (symbol: FlowSymbolValue) => Promise<Date | null>;
  /** Unfetched option-print ranges of a symbol, newest end first. */
  optionGaps: (symbol: FlowSymbolValue) => Promise<FlowOptionGapRecord[]>;
  /** Stores a gap, or moves the end of the stored gap with the same symbol and start. */
  saveOptionGap: (gap: FlowOptionGapRecord) => Promise<void>;
  /** Deletes a gap that was read completely. */
  deleteOptionGap: (symbol: FlowSymbolValue, startTime: Date) => Promise<void>;
  /** Newest stored minute, book or option print time for a symbol (the snapshot window ends there). */
  newestDataAt: (symbol: FlowSymbolValue) => Promise<Date | null>;
  /** Newest sample of any status and newest ok sample, per source. */
  latestSamples: (symbol: FlowSymbolValue) => Promise<
    Readonly<{
      latest: FlowSampleRecord[];
      latestOk: FlowSampleRecord[];
    }>
  >;
  readWindow: (query: FlowWindowQuery) => Promise<FlowWindowRows>;
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

const SOURCES: readonly FlowSourceValue[] = [
  "ticks",
  "depth",
  "options",
  "gex",
];

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
    latestSamples: async (symbol) => {
      const latest: FlowSampleRecord[] = [];
      const latestOk: FlowSampleRecord[] = [];
      for (const source of SOURCES) {
        const last = await newestSample(symbol, source, null);
        const ok = await newestSample(symbol, source, "ok");
        if (last) latest.push(last);
        if (ok) latestOk.push(ok);
      }
      return { latest, latestOk };
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
        .orderBy(desc(flowOptionGaps.endTime)),
    prune: async (before) => {
      const removed = [
        await database
          .delete(flowSamples)
          .where(lt(flowSamples.at, before))
          .returning({ at: flowSamples.at }),
        await database
          .delete(flowMinutes)
          .where(lt(flowMinutes.minute, before))
          .returning({ at: flowMinutes.minute }),
        await database
          .delete(flowBook)
          .where(lt(flowBook.at, before))
          .returning({ at: flowBook.at }),
        await database
          .delete(flowOptionPrints)
          .where(lt(flowOptionPrints.tradedAt, before))
          .returning({ at: flowOptionPrints.tradedAt }),
        await database
          .delete(flowEvents)
          .where(lt(flowEvents.at, before))
          .returning({ at: flowEvents.at }),
        await database
          .delete(flowGex)
          .where(lt(flowGex.at, before))
          .returning({ at: flowGex.at }),
        // A gap whose newest part is older than the cutoff would only fetch rows prune removes.
        await database
          .delete(flowOptionGaps)
          .where(lt(flowOptionGaps.endTime, before))
          .returning({ at: flowOptionGaps.endTime }),
      ];
      return removed.reduce((total, rows) => total + rows.length, 0);
    },
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
    saveOptionGap: async (gap) => {
      await database
        .insert(flowOptionGaps)
        .values(gap)
        .onConflictDoUpdate({
          set: { endTime: sql`excluded.end_time` },
          target: [flowOptionGaps.symbol, flowOptionGaps.startTime],
        });
    },
    upsertMinutes: async (rows) => {
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
              largePrintVolume: sql`excluded.large_print_volume`,
              largePrints: sql`excluded.large_prints`,
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
            setWhere: sql`excluded.covered_seconds >= ${flowMinutes.coveredSeconds}`,
            target: [flowMinutes.symbol, flowMinutes.minute],
          })
          .returning({ minute: flowMinutes.minute });
        written += stored.length;
      }
      return written;
    },
  };
};
