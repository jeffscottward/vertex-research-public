import { and, asc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";

import {
  MARKET_DAILY_SERIES_KINDS,
  type MarketDailySeriesKind,
  marketDailyPoints,
  marketDailySeries,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Stored daily research series of the QuantConnect idea ports. A series keeps every source row
// whose close is a finite number; open, high, low and adj_close stay null where the source has
// no usable value, so both the bar view (complete rows) and the close view (every row) can be
// rebuilt from one table. Writes replace one whole series inside a transaction. Doubles
// round-trip exactly: Postgres prints float8 with the shortest exact digits and node-pg parses
// them with parseFloat; negative zero is written as a float8 literal because String(-0) is "0".

const INSERT_CHUNK_ROWS = 5000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const MARKET_DAILY_SERIES_ID_PATTERN = /^[A-Z0-9._^=-]{1,20}$/u;
const ISO_DATE_PATTERN = /^([1-9]\d{3})-(\d{2})-(\d{2})$/u;

export type MarketDailySeries = Readonly<{
  id: string;
  kind: MarketDailySeriesKind;
  source: string;
  sourceSha256: string;
  pointCount: number;
  firstDate: string;
  lastDate: string;
  importedAt: Date;
}>;

export type MarketDailySeriesInput = Readonly<{
  id: string;
  kind: MarketDailySeriesKind;
  source: string;
  sourceSha256: string;
}>;

export type MarketDailyPoint = Readonly<{
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
}>;

/** One loaded series in date order; null where the stored value is null. */
export type MarketDailyColumns = Readonly<{
  dates: string[];
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: number[];
  adjClose: (number | null)[];
}>;

/** Inclusive ISO date bounds (`YYYY-MM-DD`). */
export type MarketDailyRange = Readonly<{ from?: string; to?: string }>;

export type MarketDailySeriesRepository = Readonly<{
  listSeries: () => Promise<MarketDailySeries[]>;
  /** id -> columns for each requested id that is stored, in request order; unknown ids are absent. */
  loadSeries: (
    ids: readonly string[],
    range?: MarketDailyRange
  ) => Promise<Map<string, MarketDailyColumns>>;
  replaceSeries: (
    series: MarketDailySeriesInput,
    points: readonly MarketDailyPoint[]
  ) => Promise<MarketDailySeries>;
}>;

export class MarketDailySeriesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDailySeriesInputError";
  }
}

/** True for a real calendar date written `YYYY-MM-DD` with a year from 1000 to 9999. */
export const isMarketDailyDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match.map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const optionalFinite = (value: number | null): boolean =>
  value === null || Number.isFinite(value);

/** Throws MarketDailySeriesInputError unless the series input and points can be stored. */
export const validateMarketDailySeries = (
  series: MarketDailySeriesInput,
  points: readonly MarketDailyPoint[]
): void => {
  if (!MARKET_DAILY_SERIES_ID_PATTERN.test(series.id)) {
    throw new MarketDailySeriesInputError(
      "id must match ^[A-Z0-9._^=-]{1,20}$"
    );
  }
  if (!MARKET_DAILY_SERIES_KINDS.includes(series.kind)) {
    throw new MarketDailySeriesInputError(
      "kind must be etf, future, index or derived"
    );
  }
  const source = series.source.trim();
  if (source.length === 0 || source.length > 300) {
    throw new MarketDailySeriesInputError("source must be 1 to 300 characters");
  }
  if (!SHA256_PATTERN.test(series.sourceSha256)) {
    throw new MarketDailySeriesInputError(
      "sourceSha256 must be 64 hex characters"
    );
  }
  if (points.length === 0) {
    throw new MarketDailySeriesInputError("at least 1 point needed");
  }
  let previous = "";
  for (const [index, point] of points.entries()) {
    if (!isMarketDailyDate(point.date) || point.date <= previous) {
      throw new MarketDailySeriesInputError(
        `point ${index}: date must be a YYYY-MM-DD date after the previous point`
      );
    }
    previous = point.date;
    const valid =
      Number.isFinite(point.close) &&
      optionalFinite(point.open) &&
      optionalFinite(point.high) &&
      optionalFinite(point.low) &&
      optionalFinite(point.adjClose);
    if (!valid) {
      throw new MarketDailySeriesInputError(
        `point ${index}: close must be finite; open, high, low and adjClose null or finite`
      );
    }
  }
};

const validateIds = (ids: readonly string[]): string[] => {
  for (const id of ids) {
    if (!MARKET_DAILY_SERIES_ID_PATTERN.test(id)) {
      throw new MarketDailySeriesInputError(
        "id must match ^[A-Z0-9._^=-]{1,20}$"
      );
    }
  }
  return [...new Set(ids)];
};

const validateRange = (range: MarketDailyRange): void => {
  for (const bound of [range.from, range.to]) {
    if (bound !== undefined && !isMarketDailyDate(bound)) {
      throw new MarketDailySeriesInputError(
        "range bounds must be YYYY-MM-DD dates"
      );
    }
  }
};

/** Postgres float8 parameter; String(-0) is "0", so negative zero is sent as a literal. */
const float8 = <T extends number | null>(value: T): T | SQL =>
  Object.is(value, -0) ? sql`'-0'::float8` : value;

type LoadedRow = Readonly<{ seriesId: string } & MarketDailyPoint>;

export const createMarketDailySeriesRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): MarketDailySeriesRepository => ({
  listSeries: async () =>
    await database
      .select()
      .from(marketDailySeries)
      .orderBy(asc(marketDailySeries.id)),
  loadSeries: async (ids, range = {}) => {
    const unique = validateIds(ids);
    validateRange(range);
    const loaded = new Map<string, MarketDailyColumns>();
    if (unique.length === 0) return loaded;
    const stored = new Set(
      (
        await database
          .select({ id: marketDailySeries.id })
          .from(marketDailySeries)
          .where(inArray(marketDailySeries.id, unique))
      ).map((row) => row.id)
    );
    for (const id of unique) {
      if (stored.has(id)) {
        loaded.set(id, {
          adjClose: [],
          close: [],
          dates: [],
          high: [],
          low: [],
          open: [],
        });
      }
    }
    if (loaded.size === 0) return loaded;
    const rows: LoadedRow[] = await database
      .select({
        adjClose: marketDailyPoints.adjClose,
        close: marketDailyPoints.close,
        date: marketDailyPoints.date,
        high: marketDailyPoints.high,
        low: marketDailyPoints.low,
        open: marketDailyPoints.open,
        seriesId: marketDailyPoints.seriesId,
      })
      .from(marketDailyPoints)
      .where(
        and(
          inArray(marketDailyPoints.seriesId, [...loaded.keys()]),
          range.from === undefined
            ? undefined
            : gte(marketDailyPoints.date, range.from),
          range.to === undefined
            ? undefined
            : lte(marketDailyPoints.date, range.to)
        )
      )
      .orderBy(asc(marketDailyPoints.seriesId), asc(marketDailyPoints.date));
    for (const row of rows) {
      const columns = loaded.get(row.seriesId) as MarketDailyColumns;
      columns.dates.push(row.date);
      columns.open.push(row.open);
      columns.high.push(row.high);
      columns.low.push(row.low);
      columns.close.push(row.close);
      columns.adjClose.push(row.adjClose);
    }
    return loaded;
  },
  replaceSeries: async (series, points) => {
    validateMarketDailySeries(series, points);
    const row = {
      firstDate: (points[0] as MarketDailyPoint).date,
      id: series.id,
      importedAt: now(),
      kind: series.kind,
      lastDate: (points.at(-1) as MarketDailyPoint).date,
      pointCount: points.length,
      source: series.source.trim(),
      sourceSha256: series.sourceSha256,
    };
    return await database.transaction(async (tx) => {
      await tx
        .delete(marketDailySeries)
        .where(eq(marketDailySeries.id, series.id));
      await tx.insert(marketDailySeries).values(row);
      for (let start = 0; start < points.length; start += INSERT_CHUNK_ROWS) {
        await tx.insert(marketDailyPoints).values(
          points.slice(start, start + INSERT_CHUNK_ROWS).map((point) => ({
            adjClose: float8(point.adjClose),
            close: float8(point.close),
            date: point.date,
            high: float8(point.high),
            low: float8(point.low),
            open: float8(point.open),
            seriesId: series.id,
          }))
        );
      }
      return row;
    });
  },
});
