import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  max,
  min,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, type PgColumn, type PgTable } from "drizzle-orm/pg-core";

import {
  type OpenbbCongressChamber,
  type OpenbbFactorFrequency,
  openbbCongressFilings,
  openbbCongressTrades,
  openbbCotPositions,
  openbbCusipSymbols,
  openbbEventCalendar,
  openbbFactorReturns,
  openbbFinraOtcWeekly,
  openbbIngestRuns,
  openbbMacroPoints,
  openbbMacroSeries,
  openbbOptionIvDaily,
  openbbOptionIvTerm,
  openbbSec13fFilings,
  openbbSec13fHoldings,
  openbbSecFilings,
  openbbSecForm4Filings,
  openbbSecForm4IndexDays,
  openbbSecForm4Owners,
  openbbSecForm4Transactions,
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

const YAHOO_FALLBACK_ROW_WARNING_SUFFIX =
  "used the Yahoo option chain (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)";

type Insert<T extends PgTable> = T["$inferInsert"];
type Select<T extends PgTable> = T["$inferSelect"];

const UPSERT_TABLES = {
  // first_seen_at keeps its insert-time value: it is when Vertex first saw the row.
  congress_filings: {
    keepOnConflict: ["firstSeenAt"],
    keys: ["chamber", "docId"],
    table: openbbCongressFilings,
  },
  congress_trades: {
    keepOnConflict: ["firstSeenAt"],
    keys: ["chamber", "docId", "rowNumber"],
    table: openbbCongressTrades,
  },
  cot_positions: {
    keys: ["reportDate", "marketCode", "category"],
    table: openbbCotPositions,
  },
  // A pair seen again in an older file (a backfill) never moves last_seen back.
  cusip_symbols: {
    keepGreatest: ["lastSeen"],
    keys: ["cusip", "symbol"],
    table: openbbCusipSymbols,
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
    // A later batch without the CUSIP's ticker never erases one already stored.
    keepWhenNull: ["symbol"],
    keys: ["filerCik", "periodEnding", "cusip", "optionType"],
    table: openbbSec13fHoldings,
  },
  sec_13f_filings: {
    keys: ["accessionNumber"],
    table: openbbSec13fFilings,
  },
  sec_filings: { keys: ["accessionNumber", "symbol"], table: openbbSecFilings },
  sec_form4_filings: {
    keepOnConflict: ["firstSeenAt"],
    keys: ["accessionNumber"],
    table: openbbSecForm4Filings,
  },
  sec_form4_index_days: { keys: ["indexDay"], table: openbbSecForm4IndexDays },
  sec_form4_owners: {
    keepOnConflict: ["firstSeenAt"],
    keys: ["accessionNumber", "ownerCik"],
    table: openbbSecForm4Owners,
  },
  sec_form4_transactions: {
    keepOnConflict: ["firstSeenAt"],
    keys: ["accessionNumber", "rowNumber"],
    table: openbbSecForm4Transactions,
  },
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
/** One Form 4 transaction row in the shape of the old per-symbol insider table (openbb.sec). */
export type OpenbbInsiderRow = Readonly<{
  accessionNumber: string;
  acquiredDisposed: "A" | "D" | null;
  filingDate: string;
  ownerName: string;
  ownerTitle: string | null;
  price: number | null;
  rowNumber: number;
  shares: number | null;
  sharesAfter: number | null;
  symbol: string;
  transactionCode: string | null;
  transactionDate: string | null;
  url: string | null;
}>;
/** Finished state of the sec-form4 job for a window of index days (openbb.form4State). */
export type OpenbbForm4State = Readonly<{
  completeDays: string[];
  doneAccessions: string[];
  layoutUnknown: Readonly<{ accessionNumber: string; parserVersion: string }>[];
}>;
/** One open-market purchase row (code P, non-derivative, acquired) of a parsed original Form 4. */
export type OpenbbInsiderPurchase = Readonly<{
  accessionNumber: string;
  acceptedAt: Date;
  issuerCik: string;
  issuerName: string | null;
  issuerSymbol: string | null;
  plan10b51: boolean | null;
  price: number | null;
  shares: number | null;
  url: string;
}>;
export type OpenbbForm4Owner = Readonly<{
  accessionNumber: string;
  ownerCik: string;
  ownerName: string;
  officerTitle: string | null;
}>;
export type OpenbbForm4IndexDay = Select<typeof openbbSecForm4IndexDays>;
export type OpenbbFtdRow = Select<typeof openbbSecFtd>;
export type Openbb13fRow = Select<typeof openbbSec13fHoldings>;
export type Openbb13fFilingRow = Select<typeof openbbSec13fFilings>;
export type OpenbbFactorRow = Select<typeof openbbFactorReturns>;
export type OpenbbCongressFilingRow = Select<typeof openbbCongressFilings>;
/** A trade row with its filing's link and amendment flag. */
export type OpenbbCongressTradeRow = Select<typeof openbbCongressTrades> &
  Readonly<{ url: string; amends: boolean }>;

/** Rows a congress feed may return per list. */
export const OPENBB_CONGRESS_FEED_MAX_ROWS = 5000;

export type OpenbbCongressFeedQuery = Readonly<{
  /** Oldest filing date (YYYY-MM-DD) to include. */
  from: string;
  /** Exact ticker (uppercase). */
  ticker?: string;
  /** Case-insensitive substring of the member name. */
  member?: string;
  chamber?: OpenbbCongressChamber;
}>;

export type OpenbbCongressFeed = Readonly<{
  trades: OpenbbCongressTradeRow[];
  filings: OpenbbCongressFilingRow[];
}>;

export type OpenbbJobRuns = Readonly<{
  job: string;
  /** Newest run of the job, any status. */
  latest: OpenbbRun | null;
  /** Newest run with status ok or partial. */
  latestUsable: OpenbbRun | null;
}>;

/** The newest runs of one job that were all blocked upstream (status `blocked_upstream`). */
export type OpenbbBlockedStreak = Readonly<{
  job: string;
  /** Start of the first run of the streak. */
  since: Date;
  /** Recorded runs in the streak. */
  attempts: number;
}>;

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
  /** Newest run and newest ok-or-partial run of each job, in `jobs` order. */
  lastRunsFor: (jobs: readonly string[]) => Promise<OpenbbJobRuns[]>;
  /** Latest fully written non-empty Yahoo-fallback `cboe-option-iv` run. */
  lastYahooFallbackAt: () => Promise<Date | null>;
  /**
   * Congress trades and filings filed on or after `from`, newest first, at most 5,000 each.
   * Trades come only from parsed filings and only up to the filing's row_count.
   */
  congressFeed: (query: OpenbbCongressFeedQuery) => Promise<OpenbbCongressFeed>;
  /** One streak for each job whose newest run (by start time) is blocked upstream. */
  blockedStreaks: () => Promise<OpenbbBlockedStreak[]>;
  /** Row count and newest date of every OpenBB table. */
  tableStats: () => Promise<OpenbbTableStat[]>;
  /** Up to `limit` stored VX curve dates on or before `asOf`, newest first. */
  vxCurveDates: (asOf: string | null, limit: number) => Promise<string[]>;
  vxCurve: (asOfs: readonly string[]) => Promise<OpenbbVxCurveRow[]>;
  /** The newest `sessions` rows on or before `asOf` per underlying, oldest first. */
  optionIvDaily: (
    underlyings: readonly string[],
    asOf: string | null,
    sessions: number
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
  /** Newest `limit` Form 4 transaction rows of parsed filings whose issuer symbol is `symbol`. */
  insiderTrades: (symbol: string, limit: number) => Promise<OpenbbInsiderRow[]>;
  /**
   * Complete index days in [from, to], and the ledger accessions of the incomplete days: done
   * (parsed, or unparsed for a reason a new read cannot change) and layout_unknown with the parser
   * version that wrote them. Throws when there are more than `maxAccessions`.
   */
  form4State: (
    from: string,
    to: string,
    maxAccessions: number
  ) => Promise<OpenbbForm4State>;
  /** Purchase rows of parsed form-4 filings accepted at or after `from`, with their owners. */
  insiderPurchases: (from: Date) => Promise<{
    purchases: OpenbbInsiderPurchase[];
    owners: OpenbbForm4Owner[];
  }>;
  /** Index-day rows from `from` on, newest first. */
  form4IndexDays: (from: string) => Promise<OpenbbForm4IndexDay[]>;
  /**
   * 13F rows of the newest period of each filer for `symbol`, matched by the row's symbol; rows
   * without a symbol match by `cusips` (fallback, from the symbol's FTD rows).
   */
  holdings13f: (
    symbol: string,
    cusips: readonly string[]
  ) => Promise<Openbb13fRow[]>;
  /** CUSIPs mapped to `symbol` in openbb_cusip_symbols (from the SEC fails-to-deliver files). */
  cusipsForSymbol: (symbol: string) => Promise<string[]>;
  /** Accessions in the 13F filing ledger, newest filing first (the tick's skip list). */
  sec13fAccessions: (limit: number) => Promise<string[]>;
  /** Stored 13F holdings rows per accession (for the ledger's completeness check). */
  holdings13fCounts: (
    accessions: readonly string[]
  ) => Promise<Map<string, number>>;
  /** Every 13F ledger row (one per stored full book; a few hundred). */
  sec13fFilings: () => Promise<Openbb13fFilingRow[]>;
  /** 13F rows of the given ledger accessions that match `symbol` or one of `cusips`. */
  holdings13fOfFilings: (
    accessions: readonly string[],
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
  [
    "openbb_sec_form4_filings",
    openbbSecForm4Filings,
    openbbSecForm4Filings.indexDay,
  ],
  [
    "openbb_sec_form4_index_days",
    openbbSecForm4IndexDays,
    openbbSecForm4IndexDays.indexDay,
  ],
  ["openbb_sec_ftd", openbbSecFtd, openbbSecFtd.settlementDate],
  [
    "openbb_sec_13f_holdings",
    openbbSec13fHoldings,
    openbbSec13fHoldings.periodEnding,
  ],
  [
    "openbb_sec_13f_filings",
    openbbSec13fFilings,
    openbbSec13fFilings.periodEnding,
  ],
  ["openbb_cusip_symbols", openbbCusipSymbols, openbbCusipSymbols.lastSeen],
  ["openbb_factor_returns", openbbFactorReturns, openbbFactorReturns.date],
  [
    "openbb_congress_trades",
    openbbCongressTrades,
    openbbCongressTrades.filedOn,
  ],
  [
    "openbb_congress_filings",
    openbbCongressFilings,
    openbbCongressFilings.filedOn,
  ],
];

/** `%text%` for ILIKE with the LIKE wildcards in `text` escaped. */
const containsPattern = (text: string): string =>
  `%${text.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;

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

/**
 * `excluded.<column>` for every non-key column: the ON CONFLICT DO UPDATE set. Columns in
 * `keepWhenNull` keep the stored value when the new row has null; columns in `keepOnConflict` are
 * never updated; columns in `keepGreatest` keep the greater of the stored and the new value.
 */
const excludedSet = (
  table: PgTable,
  keys: readonly string[],
  keepWhenNull: readonly string[],
  keepOnConflict: readonly string[],
  keepGreatest: readonly string[] = []
): Record<string, SQL> =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(
        ([property]) =>
          !(keys.includes(property) || keepOnConflict.includes(property))
      )
      .map(([property, column]) => [
        property,
        keepWhenNull.includes(property)
          ? sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`
          : keepGreatest.includes(property)
            ? sql`greatest(${sql.raw(`excluded."${column.name}"`)}, ${column})`
            : sql.raw(`excluded."${column.name}"`),
      ])
  );

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});
/** YYYY-MM-DD of an instant in America/New_York. */
export const newYorkDay = (instant: Date): string =>
  NEW_YORK_DAY.format(instant);
/** Text cut to `max` UTF-16 units, with an ellipsis when cut. */
const cutLabel = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export const createOpenbbRepository = (
  database: DatabaseExecutor,
  now: () => Date = () => new Date()
): OpenbbRepository => ({
  blockedStreaks: async () => {
    // Blocked runs that started after the job's newest run with a different status. Such a run
    // exists only when the newest run of the job is blocked.
    const other = alias(openbbIngestRuns, "other_runs");
    const newestOther = database
      .select({ startedAt: max(other.startedAt) })
      .from(other)
      .where(
        and(
          eq(other.job, openbbIngestRuns.job),
          ne(other.status, "blocked_upstream")
        )
      );
    const rows = await database
      .select({
        attempts: count(),
        job: openbbIngestRuns.job,
        since: min(openbbIngestRuns.startedAt),
      })
      .from(openbbIngestRuns)
      .where(
        and(
          eq(openbbIngestRuns.status, "blocked_upstream"),
          gt(
            openbbIngestRuns.startedAt,
            sql`coalesce((${newestOther}), '-infinity'::timestamptz)`
          )
        )
      )
      .groupBy(openbbIngestRuns.job)
      .orderBy(asc(openbbIngestRuns.job));
    return rows.flatMap(({ attempts, job, since }) =>
      since === null ? [] : [{ attempts, job, since }]
    );
  },
  congressFeed: async ({ chamber, from, member, ticker }) => {
    const trades = openbbCongressTrades;
    const filings = openbbCongressFilings;
    const tradeRows = await database
      .select({ amends: filings.amends, trade: trades, url: filings.url })
      .from(trades)
      .innerJoin(
        filings,
        and(
          eq(trades.chamber, filings.chamber),
          eq(trades.docId, filings.docId)
        )
      )
      .where(
        and(
          gte(trades.filedOn, from),
          eq(filings.status, "parsed"),
          lte(trades.rowNumber, filings.rowCount),
          ticker === undefined ? undefined : eq(trades.ticker, ticker),
          member === undefined
            ? undefined
            : ilike(trades.member, containsPattern(member)),
          chamber === undefined ? undefined : eq(trades.chamber, chamber)
        )
      )
      .orderBy(
        desc(trades.filedOn),
        asc(trades.chamber),
        asc(trades.docId),
        asc(trades.rowNumber)
      )
      .limit(OPENBB_CONGRESS_FEED_MAX_ROWS);
    const filingRows = await database
      .select()
      .from(filings)
      .where(
        and(
          gte(filings.filedOn, from),
          member === undefined
            ? undefined
            : ilike(filings.member, containsPattern(member)),
          chamber === undefined ? undefined : eq(filings.chamber, chamber)
        )
      )
      .orderBy(desc(filings.filedOn), asc(filings.chamber), asc(filings.docId))
      .limit(OPENBB_CONGRESS_FEED_MAX_ROWS);
    return {
      filings: filingRows,
      trades: tradeRows.map(({ amends, trade, url }) => ({
        ...trade,
        amends,
        url,
      })),
    };
  },
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
  form4IndexDays: async (from) =>
    await database
      .select()
      .from(openbbSecForm4IndexDays)
      .where(gte(openbbSecForm4IndexDays.indexDay, from))
      .orderBy(desc(openbbSecForm4IndexDays.indexDay)),
  form4State: async (from, to, maxAccessions) => {
    const days = openbbSecForm4IndexDays;
    const filings = openbbSecForm4Filings;
    const complete = await database
      .select({ indexDay: days.indexDay })
      .from(days)
      .where(
        and(
          gte(days.indexDay, from),
          lte(days.indexDay, to),
          eq(days.complete, true)
        )
      )
      .orderBy(asc(days.indexDay));
    const completeDays = complete.map((row) => row.indexDay);
    const rows = await database
      .select({
        accessionNumber: filings.accessionNumber,
        parserVersion: filings.parserVersion,
        reason: filings.reason,
      })
      .from(filings)
      .where(
        and(
          gte(filings.indexDay, from),
          lte(filings.indexDay, to),
          completeDays.length === 0
            ? undefined
            : sql`${filings.indexDay} not in (${sql.join(
                completeDays.map((day) => sql`${day}::date`),
                sql`, `
              )})`
        )
      )
      .orderBy(asc(filings.accessionNumber))
      .limit(maxAccessions + 1);
    if (rows.length > maxAccessions)
      throw new Error(
        `form4State: more than ${maxAccessions} ledger rows in the window`
      );
    return {
      completeDays,
      doneAccessions: rows
        .filter((row) => row.reason !== "layout_unknown")
        .map((row) => row.accessionNumber),
      layoutUnknown: rows
        .filter((row) => row.reason === "layout_unknown")
        .map(({ accessionNumber, parserVersion }) => ({
          accessionNumber,
          parserVersion,
        })),
    };
  },
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
  cusipsForSymbol: async (symbol) =>
    (
      await database
        .selectDistinct({ cusip: openbbCusipSymbols.cusip })
        .from(openbbCusipSymbols)
        .where(eq(openbbCusipSymbols.symbol, symbol))
        .orderBy(asc(openbbCusipSymbols.cusip))
    ).map((row) => row.cusip),
  holdings13fOfFilings: async (accessions, symbol, cusips) => {
    if (accessions.length === 0) return [];
    return await database
      .select()
      .from(openbbSec13fHoldings)
      .where(
        and(
          inArray(openbbSec13fHoldings.accessionNumber, [...accessions]),
          cusips.length === 0
            ? eq(openbbSec13fHoldings.symbol, symbol)
            : or(
                eq(openbbSec13fHoldings.symbol, symbol),
                inArray(openbbSec13fHoldings.cusip, [...cusips])
              )
        )
      )
      .orderBy(desc(openbbSec13fHoldings.value));
  },
  holdings13fCounts: async (accessions) => {
    if (accessions.length === 0) return new Map();
    const rows = await database
      .select({
        accessionNumber: openbbSec13fHoldings.accessionNumber,
        rows: sql<number>`count(*)::int`,
      })
      .from(openbbSec13fHoldings)
      .where(inArray(openbbSec13fHoldings.accessionNumber, [...accessions]))
      .groupBy(openbbSec13fHoldings.accessionNumber);
    return new Map(rows.map((row) => [String(row.accessionNumber), row.rows]));
  },
  sec13fAccessions: async (limit) =>
    (
      await database
        .select({ accessionNumber: openbbSec13fFilings.accessionNumber })
        .from(openbbSec13fFilings)
        .orderBy(
          desc(openbbSec13fFilings.filedOn),
          asc(openbbSec13fFilings.accessionNumber)
        )
        .limit(limit)
    ).map((row) => row.accessionNumber),
  sec13fFilings: async () =>
    await database
      .select()
      .from(openbbSec13fFilings)
      .orderBy(
        asc(openbbSec13fFilings.filerCik),
        desc(openbbSec13fFilings.periodEnding),
        asc(openbbSec13fFilings.filedOn)
      ),
  insiderPurchases: async (from) => {
    const filings = openbbSecForm4Filings;
    const rows = openbbSecForm4Transactions;
    const owners = openbbSecForm4Owners;
    const usable = and(
      eq(filings.status, "parsed"),
      eq(filings.formType, "4"),
      gte(filings.acceptedAt, from)
    );
    const purchases = await database
      .select({
        acceptedAt: filings.acceptedAt,
        accessionNumber: filings.accessionNumber,
        issuerCik: filings.issuerCik,
        issuerName: filings.issuerName,
        issuerSymbol: filings.issuerSymbol,
        plan10b51: filings.plan10b51,
        price: rows.price,
        shares: rows.shares,
        url: filings.url,
      })
      .from(rows)
      .innerJoin(
        filings,
        and(
          eq(filings.accessionNumber, rows.accessionNumber),
          lte(rows.rowNumber, filings.rowCount)
        )
      )
      .where(
        and(
          usable,
          eq(rows.transactionCode, "P"),
          eq(rows.derivative, false),
          eq(rows.acquiredDisposed, "A")
        )
      )
      .orderBy(
        asc(filings.acceptedAt),
        asc(rows.accessionNumber),
        asc(rows.rowNumber)
      );
    const ownerRows = await database
      .selectDistinct({
        accessionNumber: owners.accessionNumber,
        officerTitle: owners.officerTitle,
        ownerCik: owners.ownerCik,
        ownerName: owners.ownerName,
      })
      .from(owners)
      .innerJoin(filings, eq(filings.accessionNumber, owners.accessionNumber))
      .innerJoin(
        rows,
        and(
          eq(rows.accessionNumber, owners.accessionNumber),
          eq(rows.transactionCode, "P")
        )
      )
      .where(usable)
      .orderBy(asc(owners.accessionNumber), asc(owners.ownerCik));
    return {
      owners: ownerRows,
      purchases: purchases.flatMap((row) =>
        row.acceptedAt === null || row.issuerCik === null
          ? []
          : [{ ...row, acceptedAt: row.acceptedAt, issuerCik: row.issuerCik }]
      ),
    };
  },
  insiderTrades: async (symbol, limit) => {
    const filings = openbbSecForm4Filings;
    const rows = openbbSecForm4Transactions;
    const owners = openbbSecForm4Owners;
    const found = await database
      .select({
        acceptedAt: filings.acceptedAt,
        accessionNumber: rows.accessionNumber,
        acquiredDisposed: rows.acquiredDisposed,
        price: rows.price,
        rowNumber: rows.rowNumber,
        shares: rows.shares,
        sharesAfter: rows.sharesAfter,
        transactionCode: rows.transactionCode,
        transactionDate: rows.transactionDate,
        url: filings.url,
      })
      .from(rows)
      .innerJoin(
        filings,
        and(
          eq(filings.accessionNumber, rows.accessionNumber),
          eq(filings.status, "parsed"),
          lte(rows.rowNumber, filings.rowCount)
        )
      )
      .where(eq(filings.issuerSymbol, symbol))
      .orderBy(
        desc(filings.acceptedAt),
        asc(rows.accessionNumber),
        asc(rows.rowNumber)
      )
      .limit(limit);
    // Owners only of the accessions on this page (never the whole owners table).
    const accessions = [...new Set(found.map((row) => row.accessionNumber))];
    const people =
      accessions.length === 0
        ? []
        : await database
            .select({
              accessionNumber: owners.accessionNumber,
              officerTitle: owners.officerTitle,
              ownerName: owners.ownerName,
            })
            .from(owners)
            .where(inArray(owners.accessionNumber, accessions))
            .orderBy(asc(owners.accessionNumber), asc(owners.ownerCik));
    const byAccession = new Map<string, typeof people>();
    for (const person of people)
      byAccession.set(person.accessionNumber, [
        ...(byAccession.get(person.accessionNumber) ?? []),
        person,
      ]);
    return found.map((row) => {
      const list = byAccession.get(row.accessionNumber) ?? [];
      const title = list.find((person) => person.officerTitle)?.officerTitle;
      return {
        accessionNumber: row.accessionNumber,
        acquiredDisposed:
          row.acquiredDisposed === "A" || row.acquiredDisposed === "D"
            ? row.acquiredDisposed
            : null,
        filingDate: newYorkDay(row.acceptedAt ?? now()),
        ownerName: cutLabel(
          list.map((person) => person.ownerName).join("; ") ||
            "Unknown reporting person",
          200
        ),
        ownerTitle: title ? cutLabel(title, 200) : null,
        price: row.price,
        rowNumber: row.rowNumber,
        shares: row.shares,
        sharesAfter: row.sharesAfter,
        symbol,
        transactionCode: row.transactionCode,
        transactionDate: row.transactionDate,
        url: row.url,
      };
    });
  },
  lastRunsFor: async (jobs) => {
    if (jobs.length === 0) return [];
    const newest = async (usableOnly: boolean): Promise<OpenbbRun[]> =>
      await database
        .selectDistinctOn([openbbIngestRuns.job])
        .from(openbbIngestRuns)
        .where(
          and(
            inArray(openbbIngestRuns.job, [...jobs]),
            usableOnly
              ? inArray(openbbIngestRuns.status, ["ok", "partial"])
              : undefined
          )
        )
        .orderBy(asc(openbbIngestRuns.job), desc(openbbIngestRuns.startedAt));
    const [latest, usable] = [await newest(false), await newest(true)];
    return jobs.map((job) => ({
      job,
      latest: latest.find((run) => run.job === job) ?? null,
      latestUsable: usable.find((run) => run.job === job) ?? null,
    }));
  },
  lastYahooFallbackAt: async () => {
    const [run] = await database
      .select({ finishedAt: openbbIngestRuns.finishedAt })
      .from(openbbIngestRuns)
      .where(
        and(
          eq(openbbIngestRuns.job, "cboe-option-iv"),
          inArray(openbbIngestRuns.status, ["ok", "partial"]),
          gt(openbbIngestRuns.rowsReceived, 0),
          eq(openbbIngestRuns.rowsWritten, openbbIngestRuns.rowsReceived),
          sql`exists (
            select 1 from unnest(${openbbIngestRuns.warnings}) as warning(value)
            where right(
              warning.value,
              char_length(${YAHOO_FALLBACK_ROW_WARNING_SUFFIX})
            ) = ${YAHOO_FALLBACK_ROW_WARNING_SUFFIX}
          )`
        )
      )
      .orderBy(
        desc(openbbIngestRuns.finishedAt),
        desc(openbbIngestRuns.startedAt),
        desc(openbbIngestRuns.id)
      )
      .limit(1);
    return run?.finishedAt ?? null;
  },
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
  optionIvDaily: async (underlyings, asOf, sessions) => {
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
      .where(lte(ranked.session, sessions))
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
    const {
      keepGreatest = [],
      keepOnConflict = [],
      keepWhenNull = [],
      keys,
      table,
    }: Readonly<{
      keepGreatest?: readonly string[];
      keepOnConflict?: readonly string[];
      keepWhenNull?: readonly string[];
      keys: readonly string[];
      table: PgTable;
    }> = UPSERT_TABLES[tableName];
    const unique = lastPerKey(rows as readonly Record<string, unknown>[], keys);
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    await database
      .insert(table)
      .values(unique as never)
      .onConflictDoUpdate({
        set: excludedSet(
          table,
          keys,
          keepWhenNull,
          keepOnConflict,
          keepGreatest
        ),
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
