import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// OpenBB data sources (docs/vertex-rebuild/openbb.md, migration 0064_openbb_sources). The Python
// fetcher in services/openbb prints JSON batches; scripts/openbb/tick.ts posts them to
// openbb.ingest, which upserts here by primary key. Research only: nothing here places orders.

export const OPENBB_RUN_STATUSES = ["ok", "partial", "failed"] as const;
export const OPENBB_COT_REPORT_TYPES = ["tff", "disaggregated"] as const;
export const OPENBB_COT_CATEGORIES = [
  "dealer",
  "asset_manager",
  "leveraged_funds",
  "producer_merchant",
  "swap_dealer",
  "managed_money",
  "other_reportables",
  "nonreportable",
] as const;
export const OPENBB_OTC_VENUES = ["ats", "non_ats"] as const;
export const OPENBB_13F_OPTION_TYPES = ["put", "call", ""] as const;
export const OPENBB_FACTOR_FREQUENCIES = ["daily", "monthly"] as const;
export const OPENBB_FACTORS = [
  "mkt_rf",
  "smb",
  "hml",
  "rmw",
  "cma",
  "rf",
  "mom",
] as const;

export type OpenbbRunStatus = (typeof OPENBB_RUN_STATUSES)[number];
export type OpenbbCotReportType = (typeof OPENBB_COT_REPORT_TYPES)[number];
export type OpenbbCotCategory = (typeof OPENBB_COT_CATEGORIES)[number];
export type OpenbbOtcVenue = (typeof OPENBB_OTC_VENUES)[number];
export type OpenbbOptionType = (typeof OPENBB_13F_OPTION_TYPES)[number];
export type OpenbbFactorFrequency = (typeof OPENBB_FACTOR_FREQUENCIES)[number];
export type OpenbbFactor = (typeof OPENBB_FACTORS)[number];

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const count = (name: string) => bigint(name, { mode: "number" });

// NaN sorts above Infinity in Postgres, so `< 'Infinity'` also refuses NaN.
const finite = (column: AnyPgColumn): SQL =>
  sql`(${column} is null or (${column} > '-Infinity'::float8 and ${column} < 'Infinity'::float8))`;
const nonNegative = (column: AnyPgColumn): SQL =>
  sql`(${column} is null or ${column} >= 0)`;
const all = (parts: readonly SQL[]): SQL => sql.join([...parts], sql` and `);
const textLength = (column: AnyPgColumn, max: number): SQL =>
  sql`(${column} is null or char_length(trim(${column})) between 1 and ${sql.raw(String(max))})`;
const inList = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
const symbol = (column: AnyPgColumn): SQL =>
  sql`${column} ~ '^[A-Z0-9.^=-]{1,16}$'`;

export const openbbIngestRuns = pgTable(
  "openbb_ingest_runs",
  {
    error: text("error"),
    finishedAt: utcTimestamp("finished_at").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    job: text("job").notNull(),
    openbbVersion: text("openbb_version"),
    rowsReceived: integer("rows_received").notNull(),
    rowsWritten: integer("rows_written").notNull(),
    startedAt: utcTimestamp("started_at").notNull(),
    status: text("status").$type<OpenbbRunStatus>().notNull(),
    warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    check(
      "openbb_ingest_runs_check",
      all([
        sql`${table.job} ~ '^[a-z0-9-]{1,40}$'`,
        inList(table.status, OPENBB_RUN_STATUSES),
        sql`${table.rowsReceived} >= 0 and ${table.rowsWritten} >= 0`,
        sql`${table.finishedAt} >= ${table.startedAt}`,
        sql`(${table.error} is null or char_length(${table.error}) <= 4000)`,
        textLength(table.openbbVersion, 40),
      ])
    ),
  ]
);

export const openbbVxCurve = pgTable(
  "openbb_vx_curve",
  {
    asOf: date("as_of", { mode: "string" }).notNull(),
    contractMonth: text("contract_month").notNull(),
    price: doublePrecision("price").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.asOf, table.contractMonth] }),
    check(
      "openbb_vx_curve_check",
      all([
        sql`${table.contractMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
        finite(table.price),
      ])
    ),
  ]
);

export const openbbOptionIvDaily = pgTable(
  "openbb_option_iv_daily",
  {
    asOf: date("as_of", { mode: "string" }).notNull(),
    atmIv30d: doublePrecision("atm_iv_30d"),
    callIv25d30d: doublePrecision("call_iv_25d_30d"),
    callOi: count("call_oi").notNull(),
    callVolume: count("call_volume").notNull(),
    callWall: doublePrecision("call_wall"),
    contracts: integer("contracts").notNull(),
    gammaFlip: doublePrecision("gamma_flip"),
    netGex: doublePrecision("net_gex"),
    putIv25d30d: doublePrecision("put_iv_25d_30d"),
    putOi: count("put_oi").notNull(),
    putVolume: count("put_volume").notNull(),
    putWall: doublePrecision("put_wall"),
    underlying: text("underlying").notNull(),
    underlyingPrice: doublePrecision("underlying_price").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.asOf, table.underlying] }),
    check(
      "openbb_option_iv_daily_check",
      all([
        symbol(table.underlying),
        finite(table.underlyingPrice),
        finite(table.atmIv30d),
        finite(table.putIv25d30d),
        finite(table.callIv25d30d),
        finite(table.netGex),
        finite(table.gammaFlip),
        finite(table.callWall),
        finite(table.putWall),
        nonNegative(table.callOi),
        nonNegative(table.putOi),
        nonNegative(table.callVolume),
        nonNegative(table.putVolume),
        nonNegative(table.contracts),
      ])
    ),
  ]
);

export const openbbOptionIvTerm = pgTable(
  "openbb_option_iv_term",
  {
    asOf: date("as_of", { mode: "string" }).notNull(),
    atmIv: doublePrecision("atm_iv"),
    atmStrike: doublePrecision("atm_strike"),
    callOi: count("call_oi").notNull(),
    callVolume: count("call_volume").notNull(),
    dte: integer("dte").notNull(),
    expiration: date("expiration", { mode: "string" }).notNull(),
    putOi: count("put_oi").notNull(),
    putVolume: count("put_volume").notNull(),
    underlying: text("underlying").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.asOf, table.underlying, table.expiration] }),
    check(
      "openbb_option_iv_term_check",
      all([
        symbol(table.underlying),
        sql`${table.expiration} >= ${table.asOf}`,
        nonNegative(table.dte),
        finite(table.atmStrike),
        finite(table.atmIv),
        nonNegative(table.callOi),
        nonNegative(table.putOi),
        nonNegative(table.callVolume),
        nonNegative(table.putVolume),
      ])
    ),
  ]
);

export const openbbCotPositions = pgTable(
  "openbb_cot_positions",
  {
    category: text("category").$type<OpenbbCotCategory>().notNull(),
    long: count("long").notNull(),
    market: text("market").notNull(),
    marketCode: text("market_code").notNull(),
    openInterest: count("open_interest").notNull(),
    reportDate: date("report_date", { mode: "string" }).notNull(),
    reportType: text("report_type").$type<OpenbbCotReportType>().notNull(),
    short: count("short").notNull(),
    spreading: count("spreading"),
  },
  (table) => [
    primaryKey({
      columns: [table.reportDate, table.marketCode, table.category],
    }),
    check(
      "openbb_cot_positions_check",
      all([
        sql`${table.marketCode} ~ '^[0-9A-Z]{1,12}$'`,
        sql`${table.market} ~ '^[A-Z0-9]{1,8}$'`,
        inList(table.category, OPENBB_COT_CATEGORIES),
        inList(table.reportType, OPENBB_COT_REPORT_TYPES),
        nonNegative(table.long),
        nonNegative(table.short),
        nonNegative(table.spreading),
        nonNegative(table.openInterest),
      ])
    ),
  ]
);

export const openbbMacroSeries = pgTable(
  "openbb_macro_series",
  {
    firstDate: date("first_date", { mode: "string" }).notNull(),
    frequency: text("frequency").notNull(),
    id: text("id").primaryKey(),
    lastDate: date("last_date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    pointCount: integer("point_count").notNull(),
    source: text("source").notNull(),
    unit: text("unit").notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "openbb_macro_series_check",
      all([
        sql`${table.id} ~ '^[A-Z0-9_]{1,40}$'`,
        textLength(table.source, 80),
        textLength(table.name, 200),
        textLength(table.unit, 40),
        textLength(table.frequency, 20),
        sql`${table.pointCount} >= 1 and ${table.firstDate} <= ${table.lastDate}`,
      ])
    ),
  ]
);

export const openbbMacroPoints = pgTable(
  "openbb_macro_points",
  {
    date: date("date", { mode: "string" }).notNull(),
    seriesId: text("series_id")
      .notNull()
      .references(() => openbbMacroSeries.id, { onDelete: "cascade" }),
    value: doublePrecision("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.date] }),
    check("openbb_macro_points_check", finite(table.value)),
  ]
);

export const openbbEventCalendar = pgTable(
  "openbb_event_calendar",
  {
    date: date("date", { mode: "string" }).notNull(),
    detail: text("detail"),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    time: text("time"),
    title: text("title").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.eventKey] }),
    check(
      "openbb_event_calendar_check",
      all([
        textLength(table.source, 80),
        textLength(table.eventKey, 200),
        sql`(${table.time} is null or ${table.time} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`,
        sql`${table.kind} ~ '^[a-z0-9_]{1,40}$'`,
        textLength(table.title, 300),
        sql`(${table.detail} is null or char_length(${table.detail}) <= 2000)`,
      ])
    ),
  ]
);

export const openbbFinraOtcWeekly = pgTable(
  "openbb_finra_otc_weekly",
  {
    lastUpdated: date("last_updated", { mode: "string" }),
    shares: count("shares").notNull(),
    symbol: text("symbol").notNull(),
    tier: text("tier").notNull(),
    trades: count("trades").notNull(),
    venue: text("venue").$type<OpenbbOtcVenue>().notNull(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.weekStart, table.symbol, table.venue] }),
    check(
      "openbb_finra_otc_weekly_check",
      all([
        symbol(table.symbol),
        inList(table.venue, OPENBB_OTC_VENUES),
        textLength(table.tier, 20),
        nonNegative(table.shares),
        nonNegative(table.trades),
      ])
    ),
  ]
);

export const openbbShortInterest = pgTable(
  "openbb_short_interest",
  {
    avgDailyVolume: count("avg_daily_volume"),
    daysToCover: doublePrecision("days_to_cover"),
    previousShortInterest: count("previous_short_interest"),
    settlementDate: date("settlement_date", { mode: "string" }).notNull(),
    shortInterest: count("short_interest").notNull(),
    symbol: text("symbol").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.settlementDate, table.symbol] }),
    check(
      "openbb_short_interest_check",
      all([
        symbol(table.symbol),
        nonNegative(table.shortInterest),
        nonNegative(table.previousShortInterest),
        nonNegative(table.avgDailyVolume),
        finite(table.daysToCover),
        nonNegative(table.daysToCover),
      ])
    ),
  ]
);

export const openbbShortVolumeDaily = pgTable(
  "openbb_short_volume_daily",
  {
    date: date("date", { mode: "string" }).notNull(),
    shortExemptVolume: count("short_exempt_volume").notNull(),
    shortVolume: count("short_volume").notNull(),
    symbol: text("symbol").notNull(),
    totalVolume: count("total_volume").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.symbol] }),
    check(
      "openbb_short_volume_daily_check",
      all([
        symbol(table.symbol),
        nonNegative(table.shortVolume),
        nonNegative(table.shortExemptVolume),
        nonNegative(table.totalVolume),
      ])
    ),
  ]
);

export const openbbSecFilings = pgTable(
  "openbb_sec_filings",
  {
    accessionNumber: text("accession_number").notNull(),
    cik: text("cik").notNull(),
    description: text("description").notNull(),
    filingDate: date("filing_date", { mode: "string" }).notNull(),
    formType: text("form_type").notNull(),
    reportDate: date("report_date", { mode: "string" }),
    symbol: text("symbol").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accessionNumber, table.symbol] }),
    check(
      "openbb_sec_filings_check",
      all([
        sql`${table.accessionNumber} ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'`,
        symbol(table.symbol),
        sql`${table.cik} ~ '^[0-9]{1,10}$'`,
        textLength(table.formType, 20),
        sql`${table.url} ~ '^https://'`,
        sql`char_length(${table.description}) <= 2000`,
      ])
    ),
  ]
);

export const openbbSecInsiderTrades = pgTable(
  "openbb_sec_insider_trades",
  {
    accessionNumber: text("accession_number").notNull(),
    acquiredDisposed: text("acquired_disposed").$type<"A" | "D">(),
    filingDate: date("filing_date", { mode: "string" }).notNull(),
    ownerName: text("owner_name").notNull(),
    ownerTitle: text("owner_title"),
    price: doublePrecision("price"),
    rowNumber: integer("row_number").notNull(),
    shares: doublePrecision("shares"),
    sharesAfter: doublePrecision("shares_after"),
    symbol: text("symbol").notNull(),
    transactionCode: text("transaction_code"),
    transactionDate: date("transaction_date", { mode: "string" }),
    url: text("url"),
  },
  (table) => [
    primaryKey({ columns: [table.accessionNumber, table.rowNumber] }),
    check(
      "openbb_sec_insider_trades_check",
      all([
        sql`${table.accessionNumber} ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'`,
        nonNegative(table.rowNumber),
        symbol(table.symbol),
        textLength(table.ownerName, 200),
        textLength(table.ownerTitle, 200),
        textLength(table.transactionCode, 10),
        finite(table.shares),
        finite(table.price),
        finite(table.sharesAfter),
        sql`(${table.acquiredDisposed} is null or ${table.acquiredDisposed} in ('A', 'D'))`,
        sql`(${table.url} is null or ${table.url} ~ '^https://')`,
      ])
    ),
  ]
);

export const openbbSecFtd = pgTable(
  "openbb_sec_ftd",
  {
    cusip: text("cusip").notNull(),
    price: doublePrecision("price"),
    quantity: count("quantity").notNull(),
    settlementDate: date("settlement_date", { mode: "string" }).notNull(),
    symbol: text("symbol").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.settlementDate, table.symbol] }),
    check(
      "openbb_sec_ftd_check",
      all([
        symbol(table.symbol),
        sql`${table.cusip} ~ '^[0-9A-Z]{9}$'`,
        nonNegative(table.quantity),
        finite(table.price),
      ])
    ),
  ]
);

export const openbbSec13fHoldings = pgTable(
  "openbb_sec_13f_holdings",
  {
    assetClass: text("asset_class"),
    cusip: text("cusip").notNull(),
    filerCik: text("filer_cik").notNull(),
    filerName: text("filer_name").notNull(),
    issuer: text("issuer").notNull(),
    optionType: text("option_type").$type<OpenbbOptionType>().notNull(),
    periodEnding: date("period_ending", { mode: "string" }).notNull(),
    shares: count("shares"),
    // Ticker of the CUSIP from the fetcher's verified universe map; null when not mapped.
    symbol: text("symbol"),
    value: doublePrecision("value").notNull(),
    weight: doublePrecision("weight"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.filerCik,
        table.periodEnding,
        table.cusip,
        table.optionType,
      ],
    }),
    check(
      "openbb_sec_13f_holdings_check",
      all([
        sql`${table.filerCik} ~ '^[0-9]{1,10}$'`,
        sql`${table.cusip} ~ '^[0-9A-Z]{9}$'`,
        inList(table.optionType, OPENBB_13F_OPTION_TYPES),
        sql`(${table.symbol} is null or ${symbol(table.symbol)})`,
        textLength(table.filerName, 200),
        textLength(table.issuer, 200),
        textLength(table.assetClass, 40),
        nonNegative(table.shares),
        finite(table.value),
        finite(table.weight),
      ])
    ),
    index("openbb_sec_13f_holdings_symbol_idx").on(table.symbol),
  ]
);

export const openbbFactorReturns = pgTable(
  "openbb_factor_returns",
  {
    date: date("date", { mode: "string" }).notNull(),
    factor: text("factor").$type<OpenbbFactor>().notNull(),
    frequency: text("frequency").$type<OpenbbFactorFrequency>().notNull(),
    value: doublePrecision("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.frequency, table.factor] }),
    check(
      "openbb_factor_returns_check",
      all([
        inList(table.frequency, OPENBB_FACTOR_FREQUENCIES),
        inList(table.factor, OPENBB_FACTORS),
        finite(table.value),
      ])
    ),
  ]
);
