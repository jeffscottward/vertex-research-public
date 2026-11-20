import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
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

export const OPENBB_CONGRESS_CHAMBERS = ["house", "senate"] as const;
export const OPENBB_CONGRESS_HOLDERS = [
  "self",
  "spouse",
  "joint",
  "dependent",
] as const;
export const OPENBB_CONGRESS_TRANSACTION_TYPES = [
  "purchase",
  "sale",
  "sale_partial",
  "exchange",
  "other",
] as const;
export const OPENBB_CONGRESS_FILING_STATUSES = ["parsed", "unparsed"] as const;
export const OPENBB_CONGRESS_UNPARSED_REASONS = [
  "scanned_image",
  "no_transactions",
  "layout_unknown",
] as const;

export type OpenbbRunStatus = (typeof OPENBB_RUN_STATUSES)[number];
export type OpenbbCotReportType = (typeof OPENBB_COT_REPORT_TYPES)[number];
export type OpenbbCotCategory = (typeof OPENBB_COT_CATEGORIES)[number];
export type OpenbbOtcVenue = (typeof OPENBB_OTC_VENUES)[number];
export type OpenbbOptionType = (typeof OPENBB_13F_OPTION_TYPES)[number];
export type OpenbbFactorFrequency = (typeof OPENBB_FACTOR_FREQUENCIES)[number];
export type OpenbbCongressChamber = (typeof OPENBB_CONGRESS_CHAMBERS)[number];
export type OpenbbCongressHolder = (typeof OPENBB_CONGRESS_HOLDERS)[number];
export type OpenbbCongressTransactionType =
  (typeof OPENBB_CONGRESS_TRANSACTION_TYPES)[number];
export type OpenbbCongressFilingStatus =
  (typeof OPENBB_CONGRESS_FILING_STATUSES)[number];
export type OpenbbCongressUnparsedReason =
  (typeof OPENBB_CONGRESS_UNPARSED_REASONS)[number];
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

// House doc ids are digits; Senate doc ids are lowercase UUIDs.
const congressDocId = (chamber: AnyPgColumn, docId: AnyPgColumn): SQL =>
  sql`((${chamber} = 'house' and ${docId} ~ '^[0-9]{1,12}$') or (${chamber} = 'senate' and ${docId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))`;

/**
 * One transaction row of a congressional periodic transaction report. A row is shown only while
 * its filing in openbb_congress_filings is parsed and row_number <= row_count, so rows left over
 * from an older, longer parse stay hidden. first_seen_at is set on insert and never updated.
 */
export const openbbCongressTrades = pgTable(
  "openbb_congress_trades",
  {
    amountHigh: count("amount_high"),
    amountLabel: text("amount_label").notNull(),
    amountLow: count("amount_low"),
    asset: text("asset").notNull(),
    assetType: text("asset_type"),
    chamber: text("chamber").$type<OpenbbCongressChamber>().notNull(),
    docId: text("doc_id").notNull(),
    filedOn: date("filed_on", { mode: "string" }).notNull(),
    firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
    holder: text("holder").$type<OpenbbCongressHolder>(),
    member: text("member").notNull(),
    rowNumber: integer("row_number").notNull(),
    ticker: text("ticker"),
    transactionDate: date("transaction_date", { mode: "string" }),
    transactionType: text("transaction_type")
      .$type<OpenbbCongressTransactionType>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chamber, table.docId, table.rowNumber] }),
    index("openbb_congress_trades_filed_on_idx").on(table.filedOn.desc()),
    index("openbb_congress_trades_ticker_idx").on(
      table.ticker,
      table.filedOn.desc()
    ),
    check(
      "openbb_congress_trades_check",
      all([
        inList(table.chamber, OPENBB_CONGRESS_CHAMBERS),
        congressDocId(table.chamber, table.docId),
        sql`${table.rowNumber} >= 1`,
        textLength(table.member, 200),
        sql`(${table.holder} is null or ${inList(table.holder, OPENBB_CONGRESS_HOLDERS)})`,
        sql`(${table.ticker} is null or ${symbol(table.ticker)})`,
        sql`char_length(${table.asset}) <= 500`,
        textLength(table.assetType, 40),
        inList(table.transactionType, OPENBB_CONGRESS_TRANSACTION_TYPES),
        textLength(table.amountLabel, 60),
        nonNegative(table.amountLow),
        nonNegative(table.amountHigh),
      ])
    ),
  ]
);

/**
 * One congressional periodic transaction report: parsed (row_count transactions stored) or
 * unparsed with a reason. first_seen_at is set on insert and never updated.
 */
export const openbbCongressFilings = pgTable(
  "openbb_congress_filings",
  {
    amends: boolean("amends").notNull(),
    chamber: text("chamber").$type<OpenbbCongressChamber>().notNull(),
    docId: text("doc_id").notNull(),
    filedOn: date("filed_on", { mode: "string" }).notNull(),
    firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
    member: text("member").notNull(),
    parserVersion: text("parser_version").notNull(),
    reason: text("reason").$type<OpenbbCongressUnparsedReason>(),
    rowCount: integer("row_count").notNull(),
    stateDistrict: text("state_district"),
    status: text("status").$type<OpenbbCongressFilingStatus>().notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chamber, table.docId] }),
    index("openbb_congress_filings_filed_on_idx").on(table.filedOn.desc()),
    check(
      "openbb_congress_filings_check",
      all([
        inList(table.chamber, OPENBB_CONGRESS_CHAMBERS),
        congressDocId(table.chamber, table.docId),
        textLength(table.member, 200),
        textLength(table.stateDistrict, 10),
        sql`${table.url} ~ '^https://'`,
        inList(table.status, OPENBB_CONGRESS_FILING_STATUSES),
        sql`((${table.status} = 'parsed' and ${table.reason} is null) or (${table.status} = 'unparsed' and ${inList(table.reason, OPENBB_CONGRESS_UNPARSED_REASONS)}))`,
        sql`${table.rowCount} >= 0`,
        sql`(${table.status} = 'parsed' or ${table.rowCount} = 0)`,
        textLength(table.parserVersion, 20),
      ])
    ),
  ]
);

export const OPENBB_FORM4_FORM_TYPES = ["4", "4/A"] as const;
export const OPENBB_FORM4_STATUSES = ["parsed", "unparsed"] as const;
export const OPENBB_FORM4_UNPARSED_REASONS = [
  "no_xml",
  "too_large",
  "not_found",
  "layout_unknown",
] as const;
export const OPENBB_FORM4_CODES = [
  "A",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "O",
  "P",
  "S",
  "U",
  "V",
  "W",
  "X",
  "Z",
] as const;
export type OpenbbForm4FormType = (typeof OPENBB_FORM4_FORM_TYPES)[number];
export type OpenbbForm4Status = (typeof OPENBB_FORM4_STATUSES)[number];
export type OpenbbForm4UnparsedReason =
  (typeof OPENBB_FORM4_UNPARSED_REASONS)[number];
export type OpenbbForm4Code = (typeof OPENBB_FORM4_CODES)[number];

const accessionRule = (column: AnyPgColumn): SQL =>
  sql`${column} ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'`;
const cikRule = (column: AnyPgColumn): SQL => sql`${column} ~ '^[0-9]{1,10}$'`;

/**
 * Form 4 ledger, one row per accession of an EDGAR daily index (sec-form4, plan-pr3.md): parsed
 * (row_count transactions and the owners stored) or unparsed with a reason. Transaction and owner
 * rows count only while this row is parsed (and row_number <= row_count). first_seen_at is set on
 * insert and never updated.
 */
export const openbbSecForm4Filings = pgTable(
  "openbb_sec_form4_filings",
  {
    acceptedAt: utcTimestamp("accepted_at"),
    accessionNumber: text("accession_number").primaryKey(),
    firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
    formType: text("form_type").$type<OpenbbForm4FormType>().notNull(),
    indexDay: date("index_day", { mode: "string" }).notNull(),
    issuerCik: text("issuer_cik"),
    issuerName: text("issuer_name"),
    issuerSymbol: text("issuer_symbol"),
    parserVersion: text("parser_version").notNull(),
    periodOfReport: date("period_of_report", { mode: "string" }),
    plan10b51: boolean("plan_10b5_1"),
    reason: text("reason").$type<OpenbbForm4UnparsedReason>(),
    rowCount: integer("row_count").notNull(),
    status: text("status").$type<OpenbbForm4Status>().notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    index("openbb_sec_form4_filings_accepted_at_idx").on(
      table.acceptedAt.desc()
    ),
    index("openbb_sec_form4_filings_issuer_cik_idx").on(
      table.issuerCik,
      table.acceptedAt.desc()
    ),
    index("openbb_sec_form4_filings_symbol_idx").on(
      table.issuerSymbol,
      table.acceptedAt.desc()
    ),
    index("openbb_sec_form4_filings_index_day_idx").on(table.indexDay),
    check(
      "openbb_sec_form4_filings_check",
      all([
        accessionRule(table.accessionNumber),
        inList(table.formType, OPENBB_FORM4_FORM_TYPES),
        inList(table.status, OPENBB_FORM4_STATUSES),
        sql`(${table.reason} is null or ${inList(table.reason, OPENBB_FORM4_UNPARSED_REASONS)})`,
        sql`((${table.status} = 'parsed') = (${table.reason} is null))`,
        sql`(${table.status} = 'parsed' or ${table.rowCount} = 0)`,
        sql`(${table.status} = 'unparsed' or (${table.acceptedAt} is not null and ${table.issuerCik} is not null))`,
        sql`${table.rowCount} >= 0`,
        sql`(${table.issuerCik} is null or ${cikRule(table.issuerCik)})`,
        sql`(${table.issuerSymbol} is null or ${symbol(table.issuerSymbol)})`,
        textLength(table.issuerName, 200),
        textLength(table.parserVersion, 20),
        sql`${table.url} ~ '^https://'`,
      ])
    ),
  ]
);

/** One Form 4 transaction row (non-derivative rows first, then derivative rows). */
export const openbbSecForm4Transactions = pgTable(
  "openbb_sec_form4_transactions",
  {
    accessionNumber: text("accession_number").notNull(),
    acquiredDisposed: text("acquired_disposed"),
    derivative: boolean("derivative").notNull(),
    directIndirect: text("direct_indirect"),
    firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
    price: doublePrecision("price"),
    rowNumber: integer("row_number").notNull(),
    securityTitle: text("security_title").notNull(),
    shares: doublePrecision("shares"),
    sharesAfter: doublePrecision("shares_after"),
    transactionCode: text("transaction_code").$type<OpenbbForm4Code>(),
    transactionDate: date("transaction_date", { mode: "string" }),
  },
  (table) => [
    primaryKey({ columns: [table.accessionNumber, table.rowNumber] }),
    index("openbb_sec_form4_transactions_purchase_idx")
      .on(table.accessionNumber)
      .where(sql`${table.transactionCode} = 'P'`),
    check(
      "openbb_sec_form4_transactions_check",
      all([
        accessionRule(table.accessionNumber),
        sql`${table.rowNumber} >= 1`,
        sql`(${table.acquiredDisposed} is null or ${table.acquiredDisposed} in ('A', 'D'))`,
        sql`(${table.directIndirect} is null or ${table.directIndirect} in ('D', 'I'))`,
        sql`(${table.transactionCode} is null or ${inList(table.transactionCode, OPENBB_FORM4_CODES)})`,
        textLength(table.securityTitle, 200),
        finite(table.price),
        finite(table.shares),
        finite(table.sharesAfter),
      ])
    ),
  ]
);

/** One reporting person (owner) of a Form 4; joint filers give several rows per accession. */
export const openbbSecForm4Owners = pgTable(
  "openbb_sec_form4_owners",
  {
    accessionNumber: text("accession_number").notNull(),
    firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
    isDirector: boolean("is_director").notNull(),
    isOfficer: boolean("is_officer").notNull(),
    isOther: boolean("is_other").notNull(),
    isTenPercentOwner: boolean("is_ten_percent_owner").notNull(),
    officerTitle: text("officer_title"),
    ownerCik: text("owner_cik").notNull(),
    ownerName: text("owner_name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accessionNumber, table.ownerCik] }),
    check(
      "openbb_sec_form4_owners_check",
      all([
        accessionRule(table.accessionNumber),
        cikRule(table.ownerCik),
        textLength(table.ownerName, 200),
        textLength(table.officerTitle, 200),
      ])
    ),
  ]
);

/** One EDGAR daily index day: distinct Form 4 accessions listed and how many have a ledger row. */
export const openbbSecForm4IndexDays = pgTable(
  "openbb_sec_form4_index_days",
  {
    complete: boolean("complete").notNull(),
    entriesDone: integer("entries_done").notNull(),
    entriesListed: integer("entries_listed").notNull(),
    indexDay: date("index_day", { mode: "string" }).primaryKey(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "openbb_sec_form4_index_days_check",
      all([
        sql`${table.entriesListed} >= 0`,
        sql`${table.entriesDone} between 0 and ${table.entriesListed}`,
        sql`${table.complete} = (${table.entriesDone} = ${table.entriesListed})`,
      ])
    ),
  ]
);
