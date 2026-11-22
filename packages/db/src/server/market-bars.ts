import { BAR_SYMBOL_PATTERN } from "@darkfactory/shared/universes";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";

import {
  MARKET_BAR_TIMEFRAMES,
  type MarketBarTimeframe,
  marketBarSeries,
  marketBars,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Stored OHLCV history for the instant backtest page. Reads return columnar typed arrays so the
// engine can run without per-bar objects. Writes replace one whole series inside a transaction.

const INSERT_CHUNK_ROWS = 5000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type MarketBarSeries = Readonly<{
  id: string;
  symbol: string;
  timeframe: MarketBarTimeframe;
  source: string;
  sourceSha256: string;
  barCount: number;
  firstT: number;
  lastT: number;
  importedAt: Date;
}>;

export type MarketBarRow = Readonly<{
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}>;

export type MarketBarColumns = Readonly<{
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** Bar volume; NaN where the stored volume is null. Loaded columns always have it. */
  v?: Float64Array;
}>;

export type MarketBarSeriesInput = Readonly<{
  symbol: string;
  timeframe: MarketBarTimeframe;
  source: string;
  sourceSha256: string;
}>;

export type MarketBarsRepository = Readonly<{
  listSeries: () => Promise<MarketBarSeries[]>;
  getSeries: (
    symbol: string,
    timeframe: MarketBarTimeframe
  ) => Promise<MarketBarSeries | null>;
  loadColumns: (seriesId: string) => Promise<MarketBarColumns>;
  replaceSeries: (
    series: MarketBarSeriesInput,
    bars: readonly MarketBarRow[]
  ) => Promise<MarketBarSeries>;
  /** The last stored bar of every series of one timeframe, in symbol order. */
  latestBars: (timeframe: MarketBarTimeframe) => Promise<MarketBarLatest[]>;
  /**
   * Appends bars to a stored series under a per-series advisory lock: only bars with `t` after
   * the stored last_t are inserted, stored bars never change. bar_count, last_t and source_sha256
   * (BARS_SHA256, the digest of the stored bars) are then recomputed from storage; source keeps the
   * text of the base import. Nothing newer: the stored series is returned unchanged. Throws
   * MarketBarsInputError when the series is not stored.
   */
  appendBars: (
    series: MarketBarSeriesKey,
    bars: readonly MarketBarRow[]
  ) => Promise<MarketBarAppendResult>;
}>;

export type MarketBarSeriesKey = Pick<
  MarketBarSeriesInput,
  "symbol" | "timeframe"
>;

/** Symbol, last bar time (epoch ms) and last close of one stored series. */
export type MarketBarLatest = Readonly<{
  symbol: string;
  lastT: number;
  close: number;
}>;

/** The series after appendBars and the number of bars it inserted. */
export type MarketBarAppendResult = Readonly<{
  series: MarketBarSeries;
  written: number;
}>;

/**
 * sha256 (hex) of the stored bars of one series: `t|o|h|l|c|v` lines in time order, null volume as
 * empty. Floats use the shortest exact text (appendBars sets extra_float_digits = 1), so the digest
 * does not depend on session settings. source_sha256 is the data identity that backtest runs
 * record, so it must change when bars are appended.
 */
const BARS_SHA256 = `encode(sha256(convert_to(coalesce(string_agg(concat_ws('|', t::text, o::text, h::text, l::text, c::text, coalesce(v::text, '')), E'\\n' order by t), ''), 'UTF8')), 'hex')`;

/** Serializes every write of one series (replaceSeries, appendBars) inside its transaction. */
const lockSeries = (id: string): SQL =>
  sql`select pg_advisory_xact_lock(hashtextextended('market_bar_series:' || ${id}, 0))`;

export class MarketBarsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketBarsInputError";
  }
}

export const marketBarSeriesId = (
  symbol: string,
  timeframe: MarketBarTimeframe
): string => `${symbol}:${timeframe}`;

const positive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const validateSeriesKey = (series: MarketBarSeriesKey): void => {
  if (!BAR_SYMBOL_PATTERN.test(series.symbol)) {
    throw new MarketBarsInputError("symbol must match ^[A-Z0-9.^=-]{1,20}$");
  }
  if (!MARKET_BAR_TIMEFRAMES.includes(series.timeframe)) {
    throw new MarketBarsInputError("timeframe must be 1d or 1m");
  }
};

const validateBarRows = (
  bars: readonly MarketBarRow[],
  minimum: number
): void => {
  if (bars.length < minimum) {
    throw new MarketBarsInputError(
      `at least ${minimum} ${minimum === 1 ? "bar" : "bars"} needed`
    );
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, bar] of bars.entries()) {
    if (!Number.isSafeInteger(bar.t) || bar.t <= previous) {
      throw new MarketBarsInputError(
        `bar ${index}: t must be an integer greater than the previous bar`
      );
    }
    previous = bar.t;
    const pricesValid =
      positive(bar.o) &&
      positive(bar.h) &&
      positive(bar.l) &&
      positive(bar.c) &&
      bar.l <= Math.min(bar.o, bar.c) &&
      bar.h >= Math.max(bar.o, bar.c);
    const volumeValid =
      bar.v === null || (Number.isFinite(bar.v) && bar.v >= 0);
    if (!(pricesValid && volumeValid)) {
      throw new MarketBarsInputError(
        `bar ${index}: prices must be positive with low <= open, close <= high; volume null or >= 0`
      );
    }
  }
};

/** Throws MarketBarsInputError unless the series input and bars can be stored. */
export const validateMarketBars = (
  series: MarketBarSeriesInput,
  bars: readonly MarketBarRow[]
): void => {
  validateSeriesKey(series);
  const source = series.source.trim();
  if (source.length === 0 || source.length > 300) {
    throw new MarketBarsInputError("source must be 1 to 300 characters");
  }
  if (!SHA256_PATTERN.test(series.sourceSha256)) {
    throw new MarketBarsInputError("sourceSha256 must be 64 hex characters");
  }
  validateBarRows(bars, 2);
};

/** Converts ordered bar rows into columnar typed arrays. */
export const toMarketBarColumns = (
  rows: readonly MarketBarRow[]
): MarketBarColumns => {
  const size = rows.length;
  const columns = {
    c: new Float64Array(size),
    h: new Float64Array(size),
    l: new Float64Array(size),
    o: new Float64Array(size),
    t: new Float64Array(size),
    v: new Float64Array(size),
  };
  for (const [index, row] of rows.entries()) {
    columns.t[index] = row.t;
    columns.o[index] = row.o;
    columns.h[index] = row.h;
    columns.l[index] = row.l;
    columns.c[index] = row.c;
    columns.v[index] = row.v ?? Number.NaN;
  }
  return columns;
};

export const createMarketBarsRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): MarketBarsRepository => ({
  appendBars: async (series, bars) => {
    validateSeriesKey(series);
    validateBarRows(bars, 1);
    const id = marketBarSeriesId(series.symbol, series.timeframe);
    return await database.transaction(async (tx) => {
      await tx.execute(lockSeries(id));
      await tx.execute(sql`set local extra_float_digits = 1`);
      const [stored] = await tx
        .select()
        .from(marketBarSeries)
        .where(eq(marketBarSeries.id, id));
      if (stored === undefined) {
        throw new MarketBarsInputError(`no stored series ${id}`);
      }
      const writes = bars.filter((bar) => bar.t > stored.lastT);
      if (writes.length === 0) return { series: stored, written: 0 };
      for (let start = 0; start < writes.length; start += INSERT_CHUNK_ROWS) {
        await tx
          .insert(marketBars)
          .values(
            writes
              .slice(start, start + INSERT_CHUNK_ROWS)
              .map((bar) => ({ seriesId: id, ...bar }))
          );
      }
      const aggregate = (expression: string) =>
        sql`(select ${sql.raw(expression)} from ${marketBars} where ${eq(marketBars.seriesId, id)})`;
      const [row] = await tx
        .update(marketBarSeries)
        .set({
          barCount: aggregate("count(*)::int"),
          importedAt: now(),
          lastT: aggregate("max(t)"),
          sourceSha256: aggregate(BARS_SHA256),
        })
        .where(eq(marketBarSeries.id, id))
        .returning();
      return { series: row as MarketBarSeries, written: writes.length };
    });
  },
  getSeries: async (symbol, timeframe) => {
    const [row] = await database
      .select()
      .from(marketBarSeries)
      .where(eq(marketBarSeries.id, marketBarSeriesId(symbol, timeframe)))
      .limit(1);
    return row ?? null;
  },
  latestBars: async (timeframe) =>
    await database
      .select({
        close: marketBars.c,
        lastT: marketBarSeries.lastT,
        symbol: marketBarSeries.symbol,
      })
      .from(marketBarSeries)
      .innerJoin(
        marketBars,
        and(
          eq(marketBars.seriesId, marketBarSeries.id),
          eq(marketBars.t, marketBarSeries.lastT)
        )
      )
      .where(eq(marketBarSeries.timeframe, timeframe))
      .orderBy(asc(marketBarSeries.symbol)),
  listSeries: async () =>
    await database
      .select()
      .from(marketBarSeries)
      .orderBy(asc(marketBarSeries.symbol), asc(marketBarSeries.timeframe)),
  loadColumns: async (seriesId) =>
    toMarketBarColumns(
      await database
        .select({
          c: marketBars.c,
          h: marketBars.h,
          l: marketBars.l,
          o: marketBars.o,
          t: marketBars.t,
          v: marketBars.v,
        })
        .from(marketBars)
        .where(eq(marketBars.seriesId, seriesId))
        .orderBy(asc(marketBars.t))
    ),
  replaceSeries: async (series, bars) => {
    validateMarketBars(series, bars);
    const id = marketBarSeriesId(series.symbol, series.timeframe);
    const row = {
      barCount: bars.length,
      firstT: (bars[0] as MarketBarRow).t,
      id,
      importedAt: now(),
      lastT: (bars.at(-1) as MarketBarRow).t,
      source: series.source.trim(),
      sourceSha256: series.sourceSha256,
      symbol: series.symbol,
      timeframe: series.timeframe,
    };
    return await database.transaction(async (tx) => {
      await tx.execute(lockSeries(id));
      await tx.delete(marketBarSeries).where(eq(marketBarSeries.id, id));
      await tx.insert(marketBarSeries).values(row);
      for (let start = 0; start < bars.length; start += INSERT_CHUNK_ROWS) {
        await tx
          .insert(marketBars)
          .values(
            bars
              .slice(start, start + INSERT_CHUNK_ROWS)
              .map((bar) => ({ seriesId: id, ...bar }))
          );
      }
      return row;
    });
  },
});
