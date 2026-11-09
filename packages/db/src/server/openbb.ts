import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import {
  type OpenbbFactorFrequency,
  openbbCotPositions,
  openbbEventCalendar,
  openbbFactorReturns,
  openbbFinraOtcWeekly,
  openbbIngestRuns,
  openbbMacroPoints,
  openbbMacroSeries,
  openbbOptionIvDaily,
  openbbOptionIvTerm,
  openbbSec13fHoldings,
  openbbSecFilings,
  openbbSecFtd,
  openbbSecInsiderTrades,
  openbbShortInterest,
  openbbShortVolumeDaily,
  openbbVxCurve,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// OpenBB data sources (docs/vertex-rebuild/openbb.md). openbb.ingest upserts each fetched table by
// its primary key, so a repeated batch writes the same rows again and never duplicates them.
// macro_points also upserts its series row and recomputes first/last date and point count.
// Reads serve the operator procedures openbb.*. Research only: nothing here places orders.

/** Rows of the session window the IV percentile reads (one trading year). */
export const OPENBB_IV_PERCENTILE_SESSIONS = 252;

type Insert<T extends PgTable> = T["$inferInsert"];
type Select<T extends PgTable> = T["$inferSelect"];

const UPSERT_TABLES = {
  cot_positions: {
    keys: ["reportDate", "marketCode", "category"],
    table: openbbCotPositions,
  },
  event_calendar: { keys: ["source", "eventKey"], table: openbbEventCalendar },
  factor_returns: {
    keys: ["date", "frequency", "factor"],
    table: openbbFactorReturns,
  },
  finra_otc_weekly: {
    keys: ["weekStart", "symbol", "venue"],
    table: openbbFinraOtcWeekly,
  },
  option_iv_daily: {
    keys: ["asOf", "underlying"],
    table: openbbOptionIvDaily,
  },
  option_iv_term: {
    keys: ["asOf", "underlying", "expiration"],
    table: openbbOptionIvTerm,
  },
  sec_13f_holdings: {
    keys: ["filerCik", "periodEnding", "cusip", "optionType"],
    table: openbbSec13fHoldings,
  },
  sec_filings: { keys: ["accessionNumber", "symbol"], table: openbbSecFilings },
  sec_ftd: { keys: ["settlementDate", "symbol"], table: openbbSecFtd },
  sec_insider_trades: {
    keys: ["accessionNumber", "rowNumber"],
    table: openbbSecInsiderTrades,
  },
  short_interest: {
    keys: ["settlementDate", "symbol"],
    table: openbbShortInterest,
  },
  short_volume_daily: {
    keys: ["date", "symbol"],
    table: openbbShortVolumeDaily,
  },
  vx_curve: { keys: ["asOf", "contractMonth"], table: openbbVxCurve },
} as const;

export type OpenbbUpsertTable = keyof typeof UPSERT_TABLES;
export const OPENBB_UPSERT_TABLES = Object.keys(
  UPSERT_TABLES
) as OpenbbUpsertTable[];

export type OpenbbUpsertRows = {
  [K in OpenbbUpsertTable]: Insert<(typeof UPSERT_TABLES)[K]["table"]>;
};

export type OpenbbMacroPointInput = Readonly<{
  seriesId: string;
  date: string;
  value: number;
  source: string;
  name: string;
  unit: string;
  frequency: string;
}>;

export type OpenbbRunInput = Readonly<{
  job: string;
  startedAt: Date;
  finishedAt: Date;
  status: Select<typeof openbbIngestRuns>["status"];
  rowsReceived: number;
  rowsWritten: number;
  warnings: readonly string[];
  error: string | null;
  openbbVersion: string | null;
}>;

export type OpenbbRun = Select<typeof openbbIngestRuns>;
export type OpenbbVxCurveRow = Select<typeof openbbVxCurve>;
export type OpenbbOptionIvDailyRow = Select<typeof openbbOptionIvDaily>;
export type OpenbbOptionIvTermRow = Select<typeof openbbOptionIvTerm>;
export type OpenbbCotRow = Select<typeof openbbCotPositions>;
export type OpenbbMacroSeriesRow = Select<typeof openbbMacroSeries>;
export type OpenbbMacroPointRow = Select<typeof openbbMacroPoints>;
export type OpenbbEventRow = Select<typeof openbbEventCalendar>;
export type OpenbbOtcRow = Select<typeof openbbFinraOtcWeekly>;
export type OpenbbShortInterestRow = Select<typeof openbbShortInterest>;
export type OpenbbShortVolumeRow = Select<typeof openbbShortVolumeDaily>;
export type OpenbbSecFilingRow = Select<typeof openbbSecFilings>;
export type OpenbbInsiderRow = Select<typeof openbbSecInsiderTrades>;
export type OpenbbFtdRow = Select<typeof openbbSecFtd>;
export type Openbb13fRow = Select<typeof openbbSec13fHoldings>;
export type OpenbbFactorRow = Select<typeof openbbFactorReturns>;

export type OpenbbTableStat = Readonly<{
  table: string;
  rows: number;
  newestDate: string | null;
}>;

export type OpenbbRepository = Readonly<{
  /** Upserts rows by primary key (last duplicate in the batch wins); returns rows written. */
  upsertRows: <K extends OpenbbUpsertTable>(
    table: K,
    rows: readonly OpenbbUpsertRows[K][]
  ) => Promise<number>;
  /** Upserts points and their series rows, then recomputes first/last date and point count. */
  upsertMacroPoints: (
    rows: readonly OpenbbMacroPointInput[]
  ) => Promise<number>;
  recordRun: (run: OpenbbRunInput) => Promise<OpenbbRun>;
  /** Newest run of each job, by job. */
  latestRuns: () => Promise<OpenbbRun[]>;
  /** Row count and newest date of every OpenBB table. */
  tableStats: () => Promise<OpenbbTableStat[]>;
  /** Up to `limit` stored VX curve dates on or before `asOf`, newest first. */
  vxCurveDates: (asOf: string | null, limit: number) => Promise<string[]>;
  vxCurve: (asOfs: readonly string[]) => Promise<OpenbbVxCurveRow[]>;
  /** The newest OPENBB_IV_PERCENTILE_SESSIONS rows on or before `asOf` per underlying, oldest first. */
  optionIvDaily: (
    underlyings: readonly string[],
    asOf: string | null
  ) => Promise<OpenbbOptionIvDailyRow[]>;
  /** Term rows of the newest date on or before `asOf`. */
  optionIvTermLatest: (asOf: string | null) => Promise<OpenbbOptionIvTermRow[]>;
  cot: (market: string | null, from: string) => Promise<OpenbbCotRow[]>;
  macroSeries: (
    ids: readonly string[] | null
  ) => Promise<OpenbbMacroSeriesRow[]>;
  macroPoints: (
    ids: readonly string[],
    from: string | null
  ) => Promise<OpenbbMacroPointRow[]>;
  events: (
    from: string,
    to: string,
    kinds: readonly string[] | null
  ) => Promise<OpenbbEventRow[]>;
  shortVolume: (
    symbol: string,
    from: string
  ) => Promise<OpenbbShortVolumeRow[]>;
  shortInterest: (
    symbol: string,
    from: string
  ) => Promise<OpenbbShortInterestRow[]>;
  otcWeekly: (symbol: string, from: string) => Promise<OpenbbOtcRow[]>;
  ftd: (
    symbol: string,
    from: string | null,
    limit: number
  ) => Promise<OpenbbFtdRow[]>;
  secFilings: (symbol: string, limit: number) => Promise<OpenbbSecFilingRow[]>;
  insiderTrades: (symbol: string, limit: number) => Promise<OpenbbInsiderRow[]>;
  /**
   * 13F rows of the newest period of each filer for `symbol`, matched by the row's symbol; rows
   * without a symbol match by `cusips` (fallback, from the symbol's FTD rows).
   */
  holdings13f: (
    symbol: string,
    cusips: readonly string[]
  ) => Promise<Openbb13fRow[]>;
  factors: (
    frequency: OpenbbFactorFrequency,
    from: string | null
  ) => Promise<OpenbbFactorRow[]>;
}>;

const STAT_TABLES: ReadonlyArray<readonly [string, PgTable, PgColumn]> = [
  ["openbb_ingest_runs", openbbIngestRuns, openbbIngestRuns.startedAt],
  ["openbb_vx_curve", openbbVxCurve, openbbVxCurve.asOf],
  ["openbb_option_iv_daily", openbbOptionIvDaily, openbbOptionIvDaily.asOf],
  ["openbb_option_iv_term", openbbOptionIvTerm, openbbOptionIvTerm.asOf],
  ["openbb_cot_positions", openbbCotPositions, openbbCotPositions.reportDate],
  ["openbb_macro_series", openbbMacroSeries, openbbMacroSeries.lastDate],
  ["openbb_macro_points", openbbMacroPoints, openbbMacroPoints.date],
  ["openbb_event_calendar", openbbEventCalendar, openbbEventCalendar.date],
  [
    "openbb_finra_otc_weekly",
    openbbFinraOtcWeekly,
    openbbFinraOtcWeekly.weekStart,
  ],
  [
    "openbb_short_interest",
    openbbShortInterest,
    openbbShortInterest.settlementDate,
  ],
  [
    "openbb_short_volume_daily",
    openbbShortVolumeDaily,
    openbbShortVolumeDaily.date,
  ],
  ["openbb_sec_filings", openbbSecFilings, openbbSecFilings.filingDate],
  [
    "openbb_sec_insider_trades",
    openbbSecInsiderTrades,
    openbbSecInsiderTrades.filingDate,
  ],
  ["openbb_sec_ftd", openbbSecFtd, openbbSecFtd.settlementDate],
  [
    "openbb_sec_13f_holdings",
    openbbSec13fHoldings,
    openbbSec13fHoldings.periodEnding,
  ],
  ["openbb_factor_returns", openbbFactorReturns, openbbFactorReturns.date],
];

/** Keeps the last row of each primary key, so one INSERT never touches a row twice. */
const lastPerKey = <Row extends Record<string, unknown>>(
  rows: readonly Row[],
  keys: readonly string[]
): Row[] => {
  const byKey = new Map<string, Row>();
  for (const row of rows)
    byKey.set(JSON.stringify(keys.map((key) => row[key])), row);
  return [...byKey.values()];
};

/** `excluded.<column>` for every non-key column: the ON CONFLICT DO UPDATE set. */
const excludedSet = (
  table: PgTable,
  keys: readonly string[]
): Record<string, SQL> =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([property]) => !keys.includes(property))
      .map(([property, column]) => [
        property,
        sql.raw(`excluded."${column.name}"`),
      ])
  );

export const createOpenbbRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): OpenbbRepository => ({
  cot: async (market, from) =>
    await database
      .select()
      .from(openbbCotPositions)
      .where(
        and(
          gte(openbbCotPositions.reportDate, from),
          market === null ? undefined : eq(openbbCotPositions.market, market)
        )
      )
      .orderBy(
        asc(openbbCotPositions.market),
        asc(openbbCotPositions.reportDate),
        asc(openbbCotPositions.category)
      ),
  events: async (from, to, kinds) =>
    await database
      .select()
      .from(openbbEventCalendar)
      .where(
        and(
          gte(openbbEventCalendar.date, from),
          lte(openbbEventCalendar.date, to),
          kinds === null
            ? undefined
            : inArray(openbbEventCalendar.kind, [...kinds])
        )
      )
      .orderBy(
        asc(openbbEventCalendar.date),
        asc(openbbEventCalendar.time),
        asc(openbbEventCalendar.title)
      ),
  factors: async (frequency, from) =>
    await database
      .select()
      .from(openbbFactorReturns)
      .where(
        and(
          eq(openbbFactorReturns.frequency, frequency),
          from === null ? undefined : gte(openbbFactorReturns.date, from)
        )
      )
      .orderBy(asc(openbbFactorReturns.date), asc(openbbFactorReturns.factor)),
  ftd: async (symbol, from, limit) =>
    await database
      .select()
      .from(openbbSecFtd)
      .where(
        and(
          eq(openbbSecFtd.symbol, symbol),
          from === null ? undefined : gte(openbbSecFtd.settlementDate, from)
        )
      )
      .orderBy(desc(openbbSecFtd.settlementDate))
      .limit(limit),
  holdings13f: async (symbol, cusips) => {
    const newest = database
      .select({
        filerCik: openbbSec13fHoldings.filerCik,
        periodEnding: sql<string>`max(${openbbSec13fHoldings.periodEnding})`.as(
          "newest_period"
        ),
      })
      .from(openbbSec13fHoldings)
      .groupBy(openbbSec13fHoldings.filerCik)
      .as("newest");
    const rows = await database
      .select({ holding: openbbSec13fHoldings })
      .from(openbbSec13fHoldings)
      .innerJoin(
        newest,
        and(
          eq(openbbSec13fHoldings.filerCik, newest.filerCik),
          eq(openbbSec13fHoldings.periodEnding, newest.periodEnding)
        )
      )
      .where(
        or(
          eq(openbbSec13fHoldings.symbol, symbol),
          cusips.length === 0
            ? undefined
            : and(
                isNull(openbbSec13fHoldings.symbol),
                inArray(openbbSec13fHoldings.cusip, [...cusips])
              )
        )
      )
      .orderBy(desc(openbbSec13fHoldings.value));
    return rows.map((row) => row.holding);
  },
  insiderTrades: async (symbol, limit) =>
    await database
      .select()
      .from(openbbSecInsiderTrades)
      .where(eq(openbbSecInsiderTrades.symbol, symbol))
      .orderBy(
        desc(openbbSecInsiderTrades.filingDate),
        asc(openbbSecInsiderTrades.accessionNumber),
        asc(openbbSecInsiderTrades.rowNumber)
      )
      .limit(limit),
  latestRuns: async () =>
    await database
      .selectDistinctOn([openbbIngestRuns.job])
      .from(openbbIngestRuns)
      .orderBy(asc(openbbIngestRuns.job), desc(openbbIngestRuns.startedAt)),
  macroPoints: async (ids, from) => {
    if (ids.length === 0) return [];
    return await database
      .select()
      .from(openbbMacroPoints)
      .where(
        and(
          inArray(openbbMacroPoints.seriesId, [...ids]),
          from === null ? undefined : gte(openbbMacroPoints.date, from)
        )
      )
      .orderBy(asc(openbbMacroPoints.seriesId), asc(openbbMacroPoints.date));
  },
  macroSeries: async (ids) =>
    await database
      .select()
      .from(openbbMacroSeries)
      .where(ids === null ? undefined : inArray(openbbMacroSeries.id, [...ids]))
      .orderBy(asc(openbbMacroSeries.id)),
  optionIvDaily: async (underlyings, asOf) => {
    if (underlyings.length === 0) return [];
    const ranked = database
      .select({
        ...getTableColumns(openbbOptionIvDaily),
        session:
          sql<number>`row_number() over (partition by ${openbbOptionIvDaily.underlying} order by ${openbbOptionIvDaily.asOf} desc)`.as(
            "session"
          ),
      })
      .from(openbbOptionIvDaily)
      .where(
        and(
          inArray(openbbOptionIvDaily.underlying, [...underlyings]),
          asOf === null ? undefined : lte(openbbOptionIvDaily.asOf, asOf)
        )
      )
      .as("ranked");
    const rows = await database
      .select()
      .from(ranked)
      .where(lte(ranked.session, OPENBB_IV_PERCENTILE_SESSIONS))
      .orderBy(asc(ranked.underlying), asc(ranked.asOf));
    return rows.map(({ session: _session, ...row }) => row);
  },
  optionIvTermLatest: async (asOf) => {
    const [latest] = await database
      .select({ asOf: sql<string | null>`max(${openbbOptionIvTerm.asOf})` })
      .from(openbbOptionIvTerm)
      .where(asOf === null ? undefined : lte(openbbOptionIvTerm.asOf, asOf));
    const newest = (latest as { asOf: string | null }).asOf;
    if (newest === null) return [];
    return await database
      .select()
      .from(openbbOptionIvTerm)
      .where(eq(openbbOptionIvTerm.asOf, newest))
      .orderBy(
        asc(openbbOptionIvTerm.underlying),
        asc(openbbOptionIvTerm.expiration)
      );
  },
  otcWeekly: async (symbol, from) =>
    await database
      .select()
      .from(openbbFinraOtcWeekly)
      .where(
        and(
          eq(openbbFinraOtcWeekly.symbol, symbol),
          gte(openbbFinraOtcWeekly.weekStart, from)
        )
      )
      .orderBy(
        asc(openbbFinraOtcWeekly.weekStart),
        asc(openbbFinraOtcWeekly.venue)
      ),
  recordRun: async (run) => {
    const [row] = await database
      .insert(openbbIngestRuns)
      .values({ ...run, warnings: [...run.warnings] })
      .returning();
    return row as OpenbbRun;
  },
  secFilings: async (symbol, limit) =>
    await database
      .select()
      .from(openbbSecFilings)
      .where(eq(openbbSecFilings.symbol, symbol))
      .orderBy(
        desc(openbbSecFilings.filingDate),
        desc(openbbSecFilings.accessionNumber)
      )
      .limit(limit),
  shortInterest: async (symbol, from) =>
    await database
      .select()
      .from(openbbShortInterest)
      .where(
        and(
          eq(openbbShortInterest.symbol, symbol),
          gte(openbbShortInterest.settlementDate, from)
        )
      )
      .orderBy(asc(openbbShortInterest.settlementDate)),
  shortVolume: async (symbol, from) =>
    await database
      .select()
      .from(openbbShortVolumeDaily)
      .where(
        and(
          eq(openbbShortVolumeDaily.symbol, symbol),
          gte(openbbShortVolumeDaily.date, from)
        )
      )
      .orderBy(asc(openbbShortVolumeDaily.date)),
  tableStats: async () =>
    await Promise.all(
      STAT_TABLES.map(async ([name, table, column]) => {
        const [row] = await database
          .select({
            newestDate: sql<string | null>`max(${column})::date::text`,
            rows: sql<number>`count(*)::int`,
          })
          .from(table);
        // An aggregate without GROUP BY always returns exactly one row.
        const { newestDate, rows } = row as {
          newestDate: string | null;
          rows: number;
        };
        return { newestDate, rows, table: name };
      })
    ),
  upsertMacroPoints: async (rows) => {
    if (rows.length === 0) return 0;
    const points = lastPerKey(rows, ["seriesId", "date"]);
    const series = new Map<string, OpenbbMacroPointInput>();
    for (const point of points) series.set(point.seriesId, point);
    const ids = [...series.keys()];
    return await database.transaction(async (tx) => {
      await tx
        .insert(openbbMacroSeries)
        .values(
          [...series.values()].map((point) => ({
            firstDate: point.date,
            frequency: point.frequency,
            id: point.seriesId,
            lastDate: point.date,
            name: point.name,
            pointCount: 1,
            source: point.source,
            unit: point.unit,
            updatedAt: now(),
          }))
        )
        .onConflictDoUpdate({
          set: {
            frequency: sql.raw(`excluded."frequency"`),
            name: sql.raw(`excluded."name"`),
            source: sql.raw(`excluded."source"`),
            unit: sql.raw(`excluded."unit"`),
            updatedAt: sql.raw(`excluded."updated_at"`),
          },
          target: openbbMacroSeries.id,
        });
      await tx
        .insert(openbbMacroPoints)
        .values(
          points.map((point) => ({
            date: point.date,
            seriesId: point.seriesId,
            value: point.value,
          }))
        )
        .onConflictDoUpdate({
          set: { value: sql.raw(`excluded."value"`) },
          target: [openbbMacroPoints.seriesId, openbbMacroPoints.date],
        });
      await tx.execute(sql`
        update ${openbbMacroSeries} as s
        set first_date = agg.first_date, last_date = agg.last_date, point_count = agg.point_count
        from (
          select series_id, min(date) as first_date, max(date) as last_date, count(*)::int as point_count
          from ${openbbMacroPoints}
          where ${inArray(openbbMacroPoints.seriesId, ids)}
          group by series_id
        ) as agg
        where s.id = agg.series_id`);
      return points.length;
    });
  },
  upsertRows: async (tableName, rows) => {
    if (rows.length === 0) return 0;
    const { keys, table } = UPSERT_TABLES[tableName];
    const unique = lastPerKey(rows as readonly Record<string, unknown>[], keys);
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    await database
      .insert(table)
      .values(unique as never)
      .onConflictDoUpdate({
        set: excludedSet(table, keys),
        target: keys.map((key) => columns[key] as PgColumn),
      });
    return unique.length;
  },
  vxCurve: async (asOfs) => {
    if (asOfs.length === 0) return [];
    return await database
      .select()
      .from(openbbVxCurve)
      .where(inArray(openbbVxCurve.asOf, [...asOfs]))
      .orderBy(desc(openbbVxCurve.asOf), asc(openbbVxCurve.contractMonth));
  },
  vxCurveDates: async (asOf, limit) =>
    (
      await database
        .selectDistinct({ asOf: openbbVxCurve.asOf })
        .from(openbbVxCurve)
        .where(asOf === null ? undefined : lte(openbbVxCurve.asOf, asOf))
        .orderBy(desc(openbbVxCurve.asOf))
        .limit(limit)
    ).map((row) => row.asOf),
});
