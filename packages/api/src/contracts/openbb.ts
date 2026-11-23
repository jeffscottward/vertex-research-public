import { oc } from "@orpc/contract";
import { z } from "zod";

// OpenBB data sources (openbb.*, docs/vertex-rebuild/openbb.md). The Python fetcher in
// services/openbb prints one `openbb-batch.v1` document per job; scripts/openbb/tick.ts checks it
// with these schemas and posts it to openbb.ingest in chunks, then openbb.recordRun. Reads are
// operator-only and read-only. Research only: nothing here places, changes or cancels orders.

export const OPENBB_BATCH_SCHEMA_VERSION = "openbb-batch.v1";
/** Rows one openbb.ingest call may carry. */
export const OPENBB_MAX_INGEST_ROWS = 2000;
/** Stored sessions a 1-year IV percentile or IV rank basis needs before it is reported. */
export const OPENBB_IV_PERCENTILE_MIN_SESSIONS = 252;
export const OPENBB_IV_PERCENTILE_SESSIONS = 252;

export const OPENBB_JOBS = [
  "cboe-vol-indices",
  "cboe-vx-curve",
  "cboe-option-iv",
  "cftc-cot",
  "fed-rates",
  "fed-regime",
  "fed-events",
  "treasury-tga",
  "oecd-cli",
  "fred-keyless",
  "finra-otc",
  "finra-short-interest",
  "finra-short-volume",
  "sec-filings",
  "sec-insider",
  "sec-ftd",
  "sec-13f",
  "famafrench",
  "congress-house",
  "congress-senate",
  "sec-form4",
  "daily-prices",
] as const;
export const OPENBB_TABLES = [
  "daily_series",
  "daily_bars",
  "vx_curve",
  "option_iv_daily",
  "option_iv_term",
  "cot_positions",
  "macro_points",
  "event_calendar",
  "finra_otc_weekly",
  "short_interest",
  "short_volume_daily",
  "sec_filings",
  "sec_insider_trades",
  "sec_ftd",
  "sec_13f_holdings",
  "sec_13f_filings",
  "cusip_symbols",
  "factor_returns",
  "congress_trades",
  "congress_filings",
  "sec_form4_transactions",
  "sec_form4_owners",
  "sec_form4_filings",
  "sec_form4_index_days",
] as const;
/** Cboe vol indices stored as market daily series (kind `index`, source `cboe`). */
export const OPENBB_VOL_INDEX_IDS = [
  "VIX",
  "VIX1D",
  "VIX9D",
  "VIX3M",
  "VIX6M",
  "VIX1Y",
  "VVIX",
  "SKEW",
  "VXN",
  "VXD",
  "RVX",
  "GVZ",
  "OVX",
  "VXSLV",
] as const;
export const OPENBB_CORE7 = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
] as const;
/** Cboe 30-day volatility index proxy per Core 7 ETF, matching STRATEGY_IV_INDEX. */
export const OPENBB_VOL_INDEX_PROXY = {
  DIA: "VXD",
  GLD: "GVZ",
  IWM: "RVX",
  QQQ: "VXN",
  SLV: "VXSLV",
  SPY: "VIX",
  USO: "OVX",
} as const satisfies Record<
  (typeof OPENBB_CORE7)[number],
  (typeof OPENBB_VOL_INDEX_IDS)[number]
>;
export const OPENBB_IV_BASES = ["own_atm_iv", "vol_index_proxy"] as const;
export const OPENBB_IV_UNITS = ["decimal", "vol_points"] as const;
// blocked_upstream: every source of the job was refused by its upstream host (HTTP 403 or 429, or
// an HTML page with a status below 400 where data was expected). The run's `error` is
// `HTTP <code> from <host>`.
export const OPENBB_RUN_STATUSES = [
  "ok",
  "partial",
  "failed",
  "blocked_upstream",
] as const;
/** Wait after the newest blocked run before the next timer attempt: 1 h after the first, then 6 h. */
export const OPENBB_BLOCKED_RETRY_MS = [3_600_000, 21_600_000] as const;
/**
 * A timer run this much before the retry time still tries. tick-runner starts an hourly job up to
 * 20 s early; without the tolerance that run would skip and the retry would come one hour late.
 */
export const OPENBB_BLOCKED_RETRY_TOLERANCE_MS = 300_000;
/** A blocked streak older than this makes the tick client exit 1 (the unit fails; 7 days). */
export const OPENBB_BLOCKED_ESCALATE_MS = 604_800_000;

/** Earliest next timer attempt of a job whose newest `attempts` runs were all blocked upstream. */
export const openbbBlockedRetryAt = (
  attempts: number,
  lastStartedAt: Date
): Date =>
  new Date(
    lastStartedAt.getTime() + OPENBB_BLOCKED_RETRY_MS[attempts <= 1 ? 0 : 1]
  );

/**
 * Part of the run warning of cboe-vx-curve when the CFE settlement file gave the rows (the fetcher
 * writes it: CFE_FALLBACK_NOTE in services/openbb/vertex_openbb/jobs/cboe.py). The Markets page
 * looks for it; tests on both sides pin the text.
 */
export const OPENBB_CFE_FALLBACK_NOTE = "used the CFE settlement file";

/**
 * Part of the run warning of cboe-option-iv when the Yahoo chain gave the rows (the fetcher
 * writes it: YAHOO_FALLBACK_NOTE in services/openbb/vertex_openbb/jobs/cboe.py). The Markets page
 * looks for it; tests on both sides pin the text.
 */
export const OPENBB_YAHOO_FALLBACK_NOTE = "used the Yahoo option chain";

/** The `error` text of a blocked run, also shown on the Markets page. */
export const openbbBlockedError = (blocked: {
  host: string;
  httpStatus: number;
}): string => `HTTP ${blocked.httpStatus} from ${blocked.host}`;
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

/**
 * Stored price series that the job `daily-prices` appends to (id -> kind of the market daily
 * series): the Core 7 ETFs, their futures, the Cboe yield indices and the derived Fed-model ratio.
 */
export const OPENBB_PRICE_SERIES_KINDS = {
  "CL=F": "future",
  DIA: "etf",
  "ES=F": "future",
  EY_TNX_RATIO: "derived",
  "GC=F": "future",
  GLD: "etf",
  IRX: "index",
  IWM: "etf",
  "NQ=F": "future",
  QQQ: "etf",
  "RTY=F": "future",
  "SI=F": "future",
  SLV: "etf",
  SPY: "etf",
  TNX: "index",
  USO: "etf",
  "YM=F": "future",
} as const;
export type OpenbbPriceSeriesId = keyof typeof OPENBB_PRICE_SERIES_KINDS;
const keysOf = <T extends object>(value: T) =>
  Object.keys(value) as [keyof T, ...(keyof T)[]];
export const OPENBB_PRICE_SERIES_IDS = keysOf(OPENBB_PRICE_SERIES_KINDS);
/** Symbols with a stored `1d` bar series that `daily-prices` appends to (ETFs and futures). */
export const OPENBB_DAILY_BAR_SYMBOLS = OPENBB_PRICE_SERIES_IDS.filter(
  (id) =>
    OPENBB_PRICE_SERIES_KINDS[id] === "etf" ||
    OPENBB_PRICE_SERIES_KINDS[id] === "future"
) as [OpenbbPriceSeriesId, ...OpenbbPriceSeriesId[]];
/** `source` passed to `upsertPoints` for `daily-prices` (missing price series are refused; a stored series keeps its own). */
export const OPENBB_DAILY_PRICES_SOURCE =
  "vertex-openbb daily-prices: IBKR first, Yahoo fills";

export type OpenbbJob = (typeof OPENBB_JOBS)[number];
export type OpenbbTable = (typeof OPENBB_TABLES)[number];

/** Tables each job may write; openbb.ingest refuses any other pair. */
export const OPENBB_JOB_TABLES: Readonly<
  Record<OpenbbJob, readonly OpenbbTable[]>
> = {
  "cboe-option-iv": ["option_iv_daily", "option_iv_term"],
  "cboe-vol-indices": ["daily_series"],
  "cboe-vx-curve": ["vx_curve"],
  "cftc-cot": ["cot_positions"],
  // Trades first: the tick posts tables in this order, so trades are stored before the ledger
  // (congress_filings.row_count) makes them visible.
  "congress-house": ["congress_trades", "congress_filings"],
  "congress-senate": ["congress_trades", "congress_filings"],
  "daily-prices": ["daily_series", "daily_bars"],
  famafrench: ["factor_returns"],
  "fed-events": ["event_calendar"],
  "fed-rates": ["macro_points"],
  "fed-regime": ["macro_points"],
  "finra-otc": ["finra_otc_weekly"],
  "finra-short-interest": ["short_interest"],
  "finra-short-volume": ["short_volume_daily"],
  "fred-keyless": ["macro_points"],
  "oecd-cli": ["macro_points"],
  "sec-13f": ["sec_13f_holdings", "sec_13f_filings"],
  "sec-filings": ["sec_filings"],
  // Rows, then the ledger that makes them visible, then the index days that count the ledger.
  "sec-form4": [
    "sec_form4_transactions",
    "sec_form4_owners",
    "sec_form4_filings",
    "sec_form4_index_days",
  ],
  "sec-ftd": ["sec_ftd", "cusip_symbols"],
  "sec-insider": ["sec_insider_trades"],
  "treasury-tga": ["macro_points", "event_calendar"],
};
/**
 * Tables that the tick posts only when every chunk of each named earlier table was stored: a ledger
 * row (row_count) must never claim rows that are missing, and a Form 4 index day must never count
 * filings whose ledger rows are missing. The 13F ledger is checked per filing by openbb.ingest
 * instead (stored holdings count = ledger rows).
 */
export const OPENBB_TABLE_REQUIRES: Readonly<
  Partial<Record<OpenbbTable, readonly OpenbbTable[]>>
> = {
  congress_filings: ["congress_trades"],
  sec_form4_filings: ["sec_form4_transactions", "sec_form4_owners"],
  sec_form4_index_days: ["sec_form4_filings"],
};
/** True for a series of `daily-prices`, false for a Cboe vol index. */
export const openbbIsPriceSeriesId = (id: string): id is OpenbbPriceSeriesId =>
  Object.hasOwn(OPENBB_PRICE_SERIES_KINDS, id);
const jobWritesTable = (job: OpenbbJob, table: OpenbbTable): boolean =>
  OPENBB_JOB_TABLES[job].includes(table);

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * A real calendar date: 2026-02-30 matches ISO_DATE but rolls over in Date.UTC. Zod runs the refine
 * even after the regex failed, so an unparsable string must give false, never throw.
 */
const isCalendarDate = (text: string): boolean => {
  const parsed = new Date(`${text}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text)
  );
};
const date = z
  .string()
  .regex(ISO_DATE)
  .refine(isCalendarDate, "must be a real calendar date");
const finite = z.number().finite();
const nullableFinite = finite.nullable();
/** Implied volatility as a decimal (0.153 = 15.3%); 10 (1,000%) bounds bad upstream values. */
const iv = finite.min(0).max(10).nullable();
const price = finite.positive();
const count = z.number().int().nonnegative();
/** The ticker rule of the research contracts: 1 to 16 of A-Z, 0-9, ".", "^", "=" and "-". */
export const TICKER_SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,16}$/u;
const symbol = z.string().regex(TICKER_SYMBOL_PATTERN);
/** FINRA Reg SHO symbol: the general rule plus FINRA's lowercase `p` (preferred) and `/` (class). */
const finraSymbol = z.string().regex(/^[A-Za-z0-9./^=-]{1,16}$/);
const accession = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);
const cusip = z.string().regex(/^[0-9A-Z]{9}$/);
const cik = z.string().regex(/^\d{1,10}$/);
const https = z
  .string()
  .max(2000)
  .regex(/^https:\/\//);
/**
 * Text of at most `max` UTF-16 code units (the fetcher counts the same way). Zod's own `.max` counts
 * code points, so an emoji-heavy string could pass it while exceeding the column budget; `.max` stays
 * for the OpenAPI maxLength.
 */
const utf16Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.length <= max, `at most ${max} UTF-16 units`);
const label = (max: number) => utf16Text(max).trim().min(1);
const macroId = z.string().regex(/^[A-Z0-9_]{1,40}$/);

export const OpenbbDailySeriesRowSchema = z.strictObject({
  /** Total-return close; absent (a fetcher before `daily-prices`) reads as null. */
  adjClose: nullableFinite.optional(),
  close: finite,
  date,
  high: nullableFinite,
  low: nullableFinite,
  open: nullableFinite,
  seriesId: z.enum([...OPENBB_VOL_INDEX_IDS, ...OPENBB_PRICE_SERIES_IDS]),
});
/** One `1d` bar; the rules of validateMarketBars (packages/db market-bars). */
export const OpenbbDailyBarRowSchema = z
  .strictObject({
    close: price,
    date,
    high: price,
    low: price,
    open: price,
    symbol: z.enum(OPENBB_DAILY_BAR_SYMBOLS),
    volume: finite.nonnegative().nullable(),
  })
  .refine(
    (bar) =>
      bar.low <= Math.min(bar.open, bar.close) &&
      bar.high >= Math.max(bar.open, bar.close),
    { message: "low <= open, close <= high", path: ["high"] }
  );
export const OpenbbVxCurveRowSchema = z.strictObject({
  asOf: date,
  contractMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  price,
});
export const OpenbbOptionIvDailyRowSchema = z.strictObject({
  asOf: date,
  /** Decimal IV of the 30-day at-the-money interpolation. */
  atmIv30d: iv,
  callIv25d30d: iv,
  callOi: count,
  callVolume: count,
  callWall: nullableFinite,
  contracts: count,
  gammaFlip: nullableFinite,
  netGex: nullableFinite,
  putIv25d30d: iv,
  putOi: count,
  putVolume: count,
  putWall: nullableFinite,
  underlying: symbol,
  underlyingPrice: price,
});
export const OpenbbOptionIvTermRowSchema = z
  .strictObject({
    asOf: date,
    /** Decimal IV at the at-the-money strike of this expiration. */
    atmIv: iv,
    atmStrike: nullableFinite,
    callOi: count,
    callVolume: count,
    dte: count,
    expiration: date,
    putOi: count,
    putVolume: count,
    underlying: symbol,
  })
  .refine((row) => row.expiration >= row.asOf, {
    message: "expiration must not be before asOf",
    path: ["expiration"],
  });
export const OpenbbCotRowSchema = z.strictObject({
  category: z.enum(OPENBB_COT_CATEGORIES),
  long: count,
  market: z.string().regex(/^[A-Z0-9]{1,8}$/),
  marketCode: z.string().regex(/^[0-9A-Z]{1,12}$/),
  openInterest: count,
  reportDate: date,
  reportType: z.enum(["tff", "disaggregated"]),
  short: count,
  spreading: count.nullable(),
});
export const OpenbbMacroPointRowSchema = z.strictObject({
  date,
  frequency: label(20),
  name: label(200),
  seriesId: macroId,
  source: label(80),
  unit: label(40),
  value: finite,
});
export const OpenbbEventRowSchema = z.strictObject({
  date,
  detail: utf16Text(2000).nullable(),
  eventKey: label(200),
  kind: z.string().regex(/^[a-z0-9_]{1,40}$/),
  source: label(80),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  title: label(300),
});
export const OpenbbFinraOtcRowSchema = z.strictObject({
  lastUpdated: date.nullable(),
  shares: count,
  symbol,
  tier: label(20),
  trades: count,
  venue: z.enum(["ats", "non_ats"]),
  weekStart: date,
});
export const OpenbbShortInterestRowSchema = z.strictObject({
  avgDailyVolume: count.nullable(),
  daysToCover: finite.nonnegative().nullable(),
  previousShortInterest: count.nullable(),
  settlementDate: date,
  shortInterest: count,
  symbol,
});
export const OpenbbShortVolumeRowSchema = z.strictObject({
  date,
  shortExemptVolume: count,
  shortVolume: count,
  symbol: finraSymbol,
  totalVolume: count,
});
export const OpenbbSecFilingRowSchema = z.strictObject({
  accessionNumber: accession,
  cik,
  description: utf16Text(2000),
  filingDate: date,
  formType: label(20),
  reportDate: date.nullable(),
  symbol,
  url: https,
});
export const OpenbbSecInsiderRowSchema = z.strictObject({
  accessionNumber: accession,
  acquiredDisposed: z.enum(["A", "D"]).nullable(),
  filingDate: date,
  ownerName: label(200),
  ownerTitle: label(200).nullable(),
  price: nullableFinite,
  rowNumber: count,
  shares: nullableFinite,
  sharesAfter: nullableFinite,
  symbol,
  transactionCode: label(10).nullable(),
  transactionDate: date.nullable(),
  url: https.nullable(),
});
export const OpenbbSecFtdRowSchema = z.strictObject({
  cusip,
  price: nullableFinite,
  quantity: count,
  settlementDate: date,
  symbol,
});
export const OpenbbSec13fRowSchema = z.strictObject({
  // Null on rows stored before smart-money PR 5 (top-50 books without a ledger row).
  accessionNumber: accession.nullable(),
  assetClass: label(40).nullable(),
  cusip,
  filedOn: date.nullable(),
  filerCik: cik,
  filerName: label(200),
  issuer: label(200),
  optionType: z.enum(["put", "call", ""]),
  periodEnding: date,
  shares: count.nullable(),
  symbol: symbol.nullable(),
  value: finite,
  weight: nullableFinite,
});
/** One parsed 13F-HR filing (ledger): its book is fully stored in sec_13f_holdings. */
export const OpenbbSec13fFilingRowSchema = z.strictObject({
  accessionNumber: accession,
  filedOn: date,
  filerCik: cik,
  filerName: label(200),
  periodEnding: date,
  rows: count,
});
/** CUSIP-to-ticker pair seen in the SEC fails-to-deliver files, with its newest settlement date. */
export const OpenbbCusipSymbolRowSchema = z.strictObject({
  cusip,
  lastSeen: date,
  symbol,
});
export const OpenbbFactorRowSchema = z.strictObject({
  date,
  factor: z.enum(OPENBB_FACTORS),
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  value: finite,
});

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
export type OpenbbCongressChamber = (typeof OPENBB_CONGRESS_CHAMBERS)[number];
/** House ids are digits; Senate ids are lowercase UUIDs. */
const HOUSE_DOC_ID = /^\d{1,12}$/;
const SENATE_DOC_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const congressDocId = z.string().max(36);
const docIdFitsChamber = (row: {
  chamber: OpenbbCongressChamber;
  docId: string;
}): boolean =>
  (row.chamber === "house" ? HOUSE_DOC_ID : SENATE_DOC_ID).test(row.docId);
const docIdIssue = {
  message: "docId does not match the chamber format",
  path: ["docId"],
};

export const OpenbbCongressTradeRowSchema = z
  .strictObject({
    amountHigh: count.nullable(),
    amountLabel: label(60),
    amountLow: count.nullable(),
    asset: utf16Text(500),
    assetType: label(40).nullable(),
    chamber: z.enum(OPENBB_CONGRESS_CHAMBERS),
    docId: congressDocId,
    filedOn: date,
    holder: z.enum(OPENBB_CONGRESS_HOLDERS).nullable(),
    member: label(200),
    rowNumber: count.min(1),
    ticker: symbol.nullable(),
    transactionDate: date.nullable(),
    transactionType: z.enum(OPENBB_CONGRESS_TRANSACTION_TYPES),
  })
  .refine(docIdFitsChamber, docIdIssue);
export const OpenbbCongressFilingRowSchema = z
  .strictObject({
    amends: z.boolean(),
    chamber: z.enum(OPENBB_CONGRESS_CHAMBERS),
    docId: congressDocId,
    filedOn: date,
    member: label(200),
    parserVersion: label(20),
    reason: z.enum(OPENBB_CONGRESS_UNPARSED_REASONS).nullable(),
    rowCount: count,
    stateDistrict: label(10).nullable(),
    status: z.enum(OPENBB_CONGRESS_FILING_STATUSES),
    url: https,
  })
  .refine(docIdFitsChamber, docIdIssue)
  .refine((row) => (row.status === "parsed") === (row.reason === null), {
    message: "reason must be null exactly when the filing is parsed",
    path: ["reason"],
  })
  .refine((row) => row.status === "parsed" || row.rowCount === 0, {
    message: "an unparsed filing has rowCount 0",
    path: ["rowCount"],
  });

export const OPENBB_FORM4_FORM_TYPES = ["4", "4/A"] as const;
export const OPENBB_FORM4_STATUSES = ["parsed", "unparsed"] as const;
export const OPENBB_FORM4_UNPARSED_REASONS = [
  "no_xml",
  "too_large",
  "not_found",
  "layout_unknown",
] as const;
/** SEC Form 4 transaction codes (General Instruction 8): OpenBB's code map plus K and V. */
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
export const OpenbbForm4FilingRowSchema = z
  .strictObject({
    acceptedAt: z.iso.datetime({ offset: true }).nullable(),
    accessionNumber: accession,
    formType: z.enum(OPENBB_FORM4_FORM_TYPES),
    indexDay: date,
    issuerCik: cik.nullable(),
    issuerName: label(200).nullable(),
    issuerSymbol: symbol.nullable(),
    parserVersion: label(20),
    periodOfReport: date.nullable(),
    plan10b51: z.boolean().nullable(),
    reason: z.enum(OPENBB_FORM4_UNPARSED_REASONS).nullable(),
    rowCount: count,
    status: z.enum(OPENBB_FORM4_STATUSES),
    url: https,
  })
  .refine((row) => (row.status === "parsed") === (row.reason === null), {
    message: "reason must be null exactly when the filing is parsed",
    path: ["reason"],
  })
  .refine((row) => row.status === "parsed" || row.rowCount === 0, {
    message: "an unparsed filing has rowCount 0",
    path: ["rowCount"],
  })
  .refine(
    (row) =>
      row.status === "unparsed" ||
      (row.acceptedAt !== null && row.issuerCik !== null),
    {
      message: "a parsed filing needs acceptedAt and issuerCik",
      path: ["acceptedAt"],
    }
  );
export const OpenbbForm4TransactionRowSchema = z.strictObject({
  accessionNumber: accession,
  acquiredDisposed: z.enum(["A", "D"]).nullable(),
  derivative: z.boolean(),
  directIndirect: z.enum(["D", "I"]).nullable(),
  price: nullableFinite,
  rowNumber: count.min(1),
  securityTitle: label(200),
  shares: nullableFinite,
  sharesAfter: nullableFinite,
  transactionCode: z.enum(OPENBB_FORM4_CODES).nullable(),
  transactionDate: date.nullable(),
});
export const OpenbbForm4OwnerRowSchema = z.strictObject({
  accessionNumber: accession,
  isDirector: z.boolean(),
  isOfficer: z.boolean(),
  isOther: z.boolean(),
  isTenPercentOwner: z.boolean(),
  officerTitle: label(200).nullable(),
  ownerCik: cik,
  ownerName: label(200),
});
export const OpenbbForm4IndexDayRowSchema = z
  .strictObject({
    complete: z.boolean(),
    entriesDone: count,
    entriesListed: count,
    indexDay: date,
  })
  .refine((row) => row.entriesDone <= row.entriesListed, {
    message: "entriesDone is above entriesListed",
    path: ["entriesDone"],
  })
  .refine((row) => row.complete === (row.entriesDone === row.entriesListed), {
    message: "complete must be true exactly when every entry is done",
    path: ["complete"],
  });

/** Row schema of each ingest table. */
export const OPENBB_ROW_SCHEMAS = {
  congress_filings: OpenbbCongressFilingRowSchema,
  congress_trades: OpenbbCongressTradeRowSchema,
  cot_positions: OpenbbCotRowSchema,
  cusip_symbols: OpenbbCusipSymbolRowSchema,
  daily_bars: OpenbbDailyBarRowSchema,
  daily_series: OpenbbDailySeriesRowSchema,
  event_calendar: OpenbbEventRowSchema,
  factor_returns: OpenbbFactorRowSchema,
  finra_otc_weekly: OpenbbFinraOtcRowSchema,
  macro_points: OpenbbMacroPointRowSchema,
  option_iv_daily: OpenbbOptionIvDailyRowSchema,
  option_iv_term: OpenbbOptionIvTermRowSchema,
  sec_13f_filings: OpenbbSec13fFilingRowSchema,
  sec_13f_holdings: OpenbbSec13fRowSchema,
  sec_filings: OpenbbSecFilingRowSchema,
  sec_form4_filings: OpenbbForm4FilingRowSchema,
  sec_form4_index_days: OpenbbForm4IndexDayRowSchema,
  sec_form4_owners: OpenbbForm4OwnerRowSchema,
  sec_form4_transactions: OpenbbForm4TransactionRowSchema,
  sec_ftd: OpenbbSecFtdRowSchema,
  sec_insider_trades: OpenbbSecInsiderRowSchema,
  short_interest: OpenbbShortInterestRowSchema,
  short_volume_daily: OpenbbShortVolumeRowSchema,
  vx_curve: OpenbbVxCurveRowSchema,
} as const satisfies Record<OpenbbTable, z.ZodType>;

/** Discriminated union of `{table, rows}`; `max` bounds rows (ingest chunk) or not (fetcher). */
const tableRows = (max?: number) => {
  const rows = <T extends z.ZodType>(row: T): z.ZodArray<T> =>
    max === undefined ? z.array(row) : z.array(row).min(1).max(max);
  return z.discriminatedUnion("table", [
    z.strictObject({
      rows: rows(OpenbbDailySeriesRowSchema),
      table: z.literal("daily_series"),
    }),
    z.strictObject({
      rows: rows(OpenbbDailyBarRowSchema),
      table: z.literal("daily_bars"),
    }),
    z.strictObject({
      rows: rows(OpenbbVxCurveRowSchema),
      table: z.literal("vx_curve"),
    }),
    z.strictObject({
      rows: rows(OpenbbOptionIvDailyRowSchema),
      table: z.literal("option_iv_daily"),
    }),
    z.strictObject({
      rows: rows(OpenbbOptionIvTermRowSchema),
      table: z.literal("option_iv_term"),
    }),
    z.strictObject({
      rows: rows(OpenbbCotRowSchema),
      table: z.literal("cot_positions"),
    }),
    z.strictObject({
      rows: rows(OpenbbMacroPointRowSchema),
      table: z.literal("macro_points"),
    }),
    z.strictObject({
      rows: rows(OpenbbEventRowSchema),
      table: z.literal("event_calendar"),
    }),
    z.strictObject({
      rows: rows(OpenbbFinraOtcRowSchema),
      table: z.literal("finra_otc_weekly"),
    }),
    z.strictObject({
      rows: rows(OpenbbShortInterestRowSchema),
      table: z.literal("short_interest"),
    }),
    z.strictObject({
      rows: rows(OpenbbShortVolumeRowSchema),
      table: z.literal("short_volume_daily"),
    }),
    z.strictObject({
      rows: rows(OpenbbSecFilingRowSchema),
      table: z.literal("sec_filings"),
    }),
    z.strictObject({
      rows: rows(OpenbbSecInsiderRowSchema),
      table: z.literal("sec_insider_trades"),
    }),
    z.strictObject({
      rows: rows(OpenbbSecFtdRowSchema),
      table: z.literal("sec_ftd"),
    }),
    z.strictObject({
      rows: rows(OpenbbSec13fRowSchema),
      table: z.literal("sec_13f_holdings"),
    }),
    z.strictObject({
      rows: rows(OpenbbSec13fFilingRowSchema),
      table: z.literal("sec_13f_filings"),
    }),
    z.strictObject({
      rows: rows(OpenbbCusipSymbolRowSchema),
      table: z.literal("cusip_symbols"),
    }),
    z.strictObject({
      rows: rows(OpenbbFactorRowSchema),
      table: z.literal("factor_returns"),
    }),
    z.strictObject({
      rows: rows(OpenbbCongressTradeRowSchema),
      table: z.literal("congress_trades"),
    }),
    z.strictObject({
      rows: rows(OpenbbCongressFilingRowSchema),
      table: z.literal("congress_filings"),
    }),
    z.strictObject({
      rows: rows(OpenbbForm4TransactionRowSchema),
      table: z.literal("sec_form4_transactions"),
    }),
    z.strictObject({
      rows: rows(OpenbbForm4OwnerRowSchema),
      table: z.literal("sec_form4_owners"),
    }),
    z.strictObject({
      rows: rows(OpenbbForm4FilingRowSchema),
      table: z.literal("sec_form4_filings"),
    }),
    z.strictObject({
      rows: rows(OpenbbForm4IndexDayRowSchema),
      table: z.literal("sec_form4_index_days"),
    }),
  ]);
};

export const OpenbbIngestBatchSchema = tableRows(OPENBB_MAX_INGEST_ROWS);
/** daily_series rows belong to one job: price ids to `daily-prices`, vol index ids to Cboe. */
const jobWritesSeries = (
  job: OpenbbJob,
  batch: z.infer<ReturnType<typeof tableRows>>
): boolean =>
  batch.table !== "daily_series" ||
  batch.rows.every(
    (row) => openbbIsPriceSeriesId(row.seriesId) === (job === "daily-prices")
  );
/** The host that refused the job's requests, and its HTTP status. */
export const OpenbbBlockedSourceSchema = z.strictObject({
  host: label(253),
  httpStatus: z.number().int().min(100).max(599),
});
/** One fetcher document (stdout of `python -I -m vertex_openbb <job>`). */
export const OpenbbBatchDocumentSchema = z
  .strictObject({
    // Set when every source of the job was blocked upstream (the tables are then empty).
    blocked: OpenbbBlockedSourceSchema.nullable().optional(),
    job: z.enum(OPENBB_JOBS),
    openbbVersion: label(40).nullable(),
    schemaVersion: z.literal(OPENBB_BATCH_SCHEMA_VERSION),
    tables: z.array(tableRows()),
    warnings: z.array(utf16Text(2000)).max(500),
  })
  .refine(
    (document) =>
      document.tables.every(({ table }) => jobWritesTable(document.job, table)),
    { message: "a table is not written by this job", path: ["tables"] }
  )
  .refine(
    (document) =>
      document.tables.every((batch) => jobWritesSeries(document.job, batch)),
    { message: "a series is not written by this job", path: ["tables"] }
  );

export const OpenbbIngestInputSchema = z
  .strictObject({
    batch: OpenbbIngestBatchSchema,
    job: z.enum(OPENBB_JOBS),
  })
  .refine((input) => jobWritesTable(input.job, input.batch.table), {
    message: "this job does not write this table",
    path: ["batch", "table"],
  })
  .refine(({ batch, job }) => jobWritesSeries(job, batch), {
    message: "this job does not write this series",
    path: ["batch", "rows"],
  });
export const OpenbbIngestOutputSchema = z.object({
  received: count,
  table: z.enum(OPENBB_TABLES),
  written: count,
});

export const OpenbbRecordRunInputSchema = z
  .strictObject({
    error: utf16Text(4000).nullable(),
    finishedAt: z.iso.datetime({ offset: true }),
    job: z.enum(OPENBB_JOBS),
    openbbVersion: label(40).nullable(),
    rowsReceived: count,
    rowsWritten: count,
    startedAt: z.iso.datetime({ offset: true }),
    status: z.enum(OPENBB_RUN_STATUSES),
    warnings: z.array(utf16Text(2000)).max(500),
  })
  .refine((run) => Date.parse(run.finishedAt) >= Date.parse(run.startedAt), {
    message: "finishedAt must not be before startedAt",
    path: ["finishedAt"],
  });
export const OpenbbRunSchema = z.object({
  // Set on the newest run of a job whose newest runs were all blocked upstream: the start of that
  // streak, its number of recorded runs, and the earliest next timer attempt.
  blocked: z
    .object({ attempts: count, nextRetryAt: z.date(), since: z.date() })
    .nullable(),
  error: z.string().nullable(),
  finishedAt: z.date(),
  id: z.string(),
  job: z.string(),
  openbbVersion: z.string().nullable(),
  rowsReceived: count,
  rowsWritten: count,
  startedAt: z.date(),
  status: z.enum(OPENBB_RUN_STATUSES),
  warnings: z.array(z.string()),
});

export const OpenbbStatusOutputSchema = z.object({
  runs: z.array(OpenbbRunSchema),
  tables: z.array(
    z.object({
      newestDate: date.nullable(),
      rows: count,
      table: z.string(),
    })
  ),
});

const curve = z
  .object({
    asOf: date,
    points: z.array(z.object({ contractMonth: z.string(), price: finite })),
  })
  .nullable();
export const OpenbbVolContextInputSchema = z.object({
  asOf: date.optional(),
});
/** Per-basis 1-year IV evaluation. `sessions` counts valid non-null observations in the window. */
export const OpenbbIvBasisResultSchema = z.object({
  asOf: date.nullable(),
  ivPercentile: finite.min(0).max(100).nullable(),
  ivRank: finite.min(0).max(100).nullable(),
  latestValue: nullableFinite,
  minSessions: z.literal(OPENBB_IV_PERCENTILE_MIN_SESSIONS),
  reason: z.string().min(1).nullable(),
  sessions: count,
  windowSessions: z.literal(OPENBB_IV_PERCENTILE_SESSIONS),
});
export const OpenbbIvProxyBasisResultSchema = OpenbbIvBasisResultSchema.extend({
  index: z.enum(OPENBB_VOL_INDEX_IDS),
});
/** Selected 1-year IV percentile & rank for one Core 7 ETF, with both `own` and `proxy` attached. */
export const OpenbbIvOneYearSchema = z.object({
  asOf: date.nullable(),
  basis: z.enum(OPENBB_IV_BASES).nullable(),
  ivPercentile: finite.min(0).max(100).nullable(),
  ivRank: finite.min(0).max(100).nullable(),
  latestValue: nullableFinite,
  minSessions: z.literal(OPENBB_IV_PERCENTILE_MIN_SESSIONS),
  own: OpenbbIvBasisResultSchema,
  proxy: OpenbbIvProxyBasisResultSchema,
  proxyIndex: z.enum(OPENBB_VOL_INDEX_IDS).nullable(),
  reason: z.string().min(1).nullable(),
  sessions: count,
  underlying: z.enum(OPENBB_CORE7),
  unit: z.enum(OPENBB_IV_UNITS).nullable(),
  windowSessions: z.literal(OPENBB_IV_PERCENTILE_SESSIONS),
});
export const OpenbbVolContextOutputSchema = z.object({
  asOf: date.nullable(),
  indices: z.array(
    z.object({ close: finite, date, id: z.enum(OPENBB_VOL_INDEX_IDS) })
  ),
  ivDaily: z.array(
    OpenbbOptionIvDailyRowSchema.extend({
      ivPercentile: finite.min(0).max(100).nullable(),
      sessions: count,
    })
  ),
  ivOneYear: z.array(OpenbbIvOneYearSchema),
  ratios: z.object({
    vix3mVix6m: nullableFinite,
    vix9dVix: nullableFinite,
    vixVix3m: nullableFinite,
  }),
  term: z.array(OpenbbOptionIvTermRowSchema),
  vxCurve: z.object({ earlier: curve, latest: curve }),
});

export const OpenbbCotInputSchema = z.object({
  market: z
    .string()
    .regex(/^[A-Z0-9]{1,8}$/)
    .optional(),
  weeks: z.number().int().min(1).max(520).default(52),
});
export const OpenbbCotOutputSchema = z.object({
  from: date,
  rows: z.array(
    z.object({
      category: z.enum(OPENBB_COT_CATEGORIES),
      long: count,
      market: z.string(),
      marketCode: z.string(),
      net: z.number().int(),
      openInterest: count,
      reportDate: date,
      reportType: z.enum(["tff", "disaggregated"]),
      short: count,
    })
  ),
});

/** Explicit history starts: nothing stored is older than 1900. */
const historyFrom = date.refine((text) => text >= "1900-01-01", {
  message: "from must be 1900-01-01 or later",
});

export const OpenbbMacroInputSchema = z.object({
  from: historyFrom.optional(),
  ids: z.array(macroId).min(1).max(100).optional(),
});
export const OpenbbMacroOutputSchema = z.object({
  from: date,
  series: z.array(
    z.object({
      firstDate: date,
      frequency: z.string(),
      id: z.string(),
      lastDate: date,
      name: z.string(),
      pointCount: count,
      points: z.array(z.object({ date, value: finite })),
      source: z.string(),
      unit: z.string(),
      updatedAt: z.date(),
    })
  ),
});

export const OpenbbEventsInputSchema = z
  .object({
    from: date.optional(),
    kinds: z
      .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
      .min(1)
      .max(20)
      .optional(),
    to: date.optional(),
  })
  .refine(
    (input) =>
      input.from === undefined ||
      input.to === undefined ||
      input.from <= input.to,
    { message: "from must not be after to", path: ["to"] }
  );
export const OpenbbEventsOutputSchema = z.object({
  events: z.array(OpenbbEventRowSchema),
  from: date,
  to: date,
});

const inputSymbol = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((text) => text.toUpperCase())
  .pipe(symbol);
/** Display horizons (trading sessions) supported by openbb.ivHistory. */
export const OPENBB_IV_HISTORY_HORIZONS = [63, 126, 252, 504] as const;
const ivHistoryHorizon = z.union([
  z.literal(63),
  z.literal(126),
  z.literal(252),
  z.literal(504),
]);
const historyAsOf = date.refine((text) => text >= "1900-01-01", {
  message: "asOf must be 1900-01-01 or later",
});
export const OpenbbIvHistoryInputSchema = z.object({
  asOf: historyAsOf.optional(),
  sessions: z.coerce.number().pipe(ivHistoryHorizon).default(252),
  symbol: inputSymbol,
});
/** One daily point of rolling 252-session IV rank and IV percentile history. */
export const OpenbbIvHistoryPointSchema = z.object({
  date,
  high52w: finite,
  iv: finite,
  ivPercentile: finite.min(0).max(100),
  ivRank: finite.min(0).max(100).nullable(),
  low52w: finite,
});
export const OpenbbIvHistoryOutputSchema = z.object({
  asOf: date.nullable(),
  basis: z.enum(OPENBB_IV_BASES).nullable(),
  latest: OpenbbIvHistoryPointSchema.nullable(),
  minSessions: z.literal(OPENBB_IV_PERCENTILE_MIN_SESSIONS),
  own: OpenbbIvBasisResultSchema,
  points: z.array(OpenbbIvHistoryPointSchema),
  proxy: OpenbbIvProxyBasisResultSchema.nullable(),
  proxyIndex: z.enum(OPENBB_VOL_INDEX_IDS).nullable(),
  reason: z.string().min(1).nullable(),
  requestedSessions: ivHistoryHorizon,
  symbol,
  unit: z.enum(OPENBB_IV_UNITS).nullable(),
  windowSessions: z.literal(OPENBB_IV_PERCENTILE_SESSIONS),
});
export const OpenbbShortsInputSchema = z.object({
  days: z.number().int().min(1).max(730).default(60),
  symbol: inputSymbol,
});
export const OpenbbShortsOutputSchema = z.object({
  from: date,
  ftd: z.array(OpenbbSecFtdRowSchema),
  otcWeekly: z.array(OpenbbFinraOtcRowSchema),
  shortInterest: z.array(OpenbbShortInterestRowSchema),
  shortVolume: z.array(
    OpenbbShortVolumeRowSchema.extend({ shortRatio: nullableFinite })
  ),
  symbol,
});

export const OpenbbSecInputSchema = z.object({ symbol: inputSymbol });
export const OPENBB_13F_CHANGES = [
  "new",
  "added",
  "reduced",
  "sold",
  "unchanged",
] as const;
/**
 * Quarter-over-quarter change of one (filer, CUSIP, option type) between the filer's two newest
 * ledger books (full books of consecutive quarters only). `previousShares`/`previousValue` are
 * null for a new position; `shares`/`value` are null for a sold one.
 */
export const Openbb13fChangeSchema = z.object({
  accessionNumber: accession,
  change: z.enum(OPENBB_13F_CHANGES),
  cusip,
  /** Filing date minus quarter end, in days. */
  delayDays: z.number().int(),
  filedOn: date,
  filerCik: cik,
  filerName: label(200),
  issuer: label(200),
  optionType: z.enum(["put", "call", ""]),
  period: date,
  previousPeriod: date,
  previousShares: count.nullable(),
  previousValue: nullableFinite,
  shares: count.nullable(),
  value: nullableFinite,
});
export const OpenbbSecOutputSchema = z.object({
  changes13f: z.array(Openbb13fChangeSchema),
  filings: z.array(OpenbbSecFilingRowSchema),
  ftd: z.array(OpenbbSecFtdRowSchema),
  holdings13f: z.array(OpenbbSec13fRowSchema),
  insiderTrades: z.array(OpenbbSecInsiderRowSchema),
  symbol,
});

/** Default window of the sec-form4 job and its state read (covers the 30-day stock page and 40-day clusters). */
export const SEC_FORM4_DEFAULT_DAYS = 40;
export const SEC_FORM4_STATE_MAX_DAYS = 400;
export const SEC_FORM4_STATE_MAX_ACCESSIONS = 200_000;
export const OpenbbForm4StateInputSchema = z
  .strictObject({ from: date, to: date })
  .refine((input) => input.from <= input.to, {
    message: "from must not be after to",
    path: ["from"],
  })
  .refine(
    (input) =>
      Date.parse(`${input.to}T00:00:00Z`) -
        Date.parse(`${input.from}T00:00:00Z`) <=
      SEC_FORM4_STATE_MAX_DAYS * 86_400_000,
    { message: `at most ${SEC_FORM4_STATE_MAX_DAYS} days`, path: ["to"] }
  );
/** Stored last rows that `daily-prices` continues from (scheduler read). */
export const OpenbbDailyPricesStateOutputSchema = z.strictObject({
  bars: z.array(
    z.strictObject({
      close: finite,
      lastDate: date,
      symbol: z.enum(OPENBB_DAILY_BAR_SYMBOLS),
    })
  ),
  series: z.array(
    z.strictObject({
      adjClose: nullableFinite,
      close: finite,
      id: z.enum(OPENBB_PRICE_SERIES_IDS),
      lastDate: date,
    })
  ),
});
export const OpenbbForm4StateOutputSchema = z.strictObject({
  completeDays: z.array(date),
  doneAccessions: z.array(accession),
  layoutUnknown: z.array(
    z.strictObject({ accessionNumber: accession, parserVersion: label(20) })
  ),
});

export const OPENBB_INSIDER_CLUSTER_DAYS = [7, 14, 30] as const;
/** Persons, cluster span and the most clusters one answer lists (design Glossary). */
export const OPENBB_INSIDER_CLUSTER_MIN_PERSONS = 3;
export const OPENBB_INSIDER_CLUSTER_SPAN_DAYS = 10;
export const OPENBB_INSIDER_CLUSTER_MAX = 200;
export const OpenbbInsiderClustersInputSchema = z.object({
  days: z.coerce
    .number()
    .pipe(z.union(OPENBB_INSIDER_CLUSTER_DAYS.map((d) => z.literal(d))))
    .default(7),
});
const timestamp = z.iso.datetime({ offset: true });
export const OpenbbInsiderClusterFilingSchema = z.object({
  acceptedAt: timestamp,
  accessionNumber: accession,
  owners: z.array(
    z.object({ cik, name: z.string(), title: z.string().nullable() })
  ),
  plan10b51: z.boolean().nullable(),
  shares: finite,
  url: https,
  value: finite,
  valueIncomplete: z.boolean(),
});
export const OpenbbInsiderClusterSchema = z.object({
  filings: z.array(OpenbbInsiderClusterFilingSchema),
  firstAcceptedAt: timestamp,
  issuerCik: cik,
  issuerName: z.string().nullable(),
  issuerSymbol: symbol.nullable(),
  lastAcceptedAt: timestamp,
  persons: count,
  shares: finite,
  value: finite,
  valueIncomplete: z.boolean(),
});
export const OpenbbForm4CoverageSchema = z.object({
  incompleteDays: z.array(date),
  lastOkAt: timestamp.nullable(),
  lastRunAt: timestamp.nullable(),
  lastStatus: z.enum(OPENBB_RUN_STATUSES).nullable(),
  newestCompleteDay: date.nullable(),
  overdue: z.boolean(),
});
export const OpenbbInsiderClustersOutputSchema = z.object({
  clusters: z.array(OpenbbInsiderClusterSchema),
  coverage: OpenbbForm4CoverageSchema,
  days: z.union(OPENBB_INSIDER_CLUSTER_DAYS.map((d) => z.literal(d))),
  delay: z.string(),
  receivedAt: timestamp,
  source: z.string(),
});

export const OpenbbFactorsInputSchema = z.object({
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  from: historyFrom.optional(),
});
export const OpenbbFactorsOutputSchema = z.object({
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  from: date,
  rows: z.array(OpenbbFactorRowSchema),
});

export const OPENBB_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "OpenBB storage: database request failed; request not confirmed; reload to check, then retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const openbb = oc.errors(OPENBB_API_ERRORS);
const tags = ["OpenBB"];
const route = (
  method: "GET" | "POST",
  name: string,
  path: string,
  summary: string
) =>
  openbb.route({
    method,
    operationId: `openbb.${name}`,
    path: `/openbb/${path}`,
    summary,
    tags,
  });

export const openbbContract = {
  cot: route(
    "GET",
    "cot",
    "cot",
    "CFTC COT net positioning per category and week"
  )
    .input(OpenbbCotInputSchema)
    .output(OpenbbCotOutputSchema),
  dailyPricesState: route(
    "POST",
    "dailyPricesState",
    "daily-prices-state",
    "Scheduler: stored last rows of the daily price series and 1d bar series"
  )
    .input(z.strictObject({}))
    .output(OpenbbDailyPricesStateOutputSchema),
  events: route(
    "GET",
    "events",
    "events",
    "Fed, Treasury and data release calendar"
  )
    .input(OpenbbEventsInputSchema)
    .output(OpenbbEventsOutputSchema),
  factors: route(
    "GET",
    "factors",
    "factors",
    "Fama-French factor returns (percent)"
  )
    .input(OpenbbFactorsInputSchema)
    .output(OpenbbFactorsOutputSchema),
  form4State: route(
    "POST",
    "form4State",
    "form4-state",
    "Scheduler: finished Form 4 index days and accessions of a window"
  )
    .input(OpenbbForm4StateInputSchema)
    .output(OpenbbForm4StateOutputSchema),
  ingest: route(
    "POST",
    "ingest",
    "ingest",
    "Scheduler: upsert one table chunk of an OpenBB fetcher batch"
  )
    .input(OpenbbIngestInputSchema)
    .output(OpenbbIngestOutputSchema),
  insiderClusters: route(
    "GET",
    "insiderClusters",
    "insider-clusters",
    "Insider cluster buys from SEC Form 4 (3+ reporting persons, open-market purchases, 10 days)"
  )
    .input(OpenbbInsiderClustersInputSchema)
    .output(OpenbbInsiderClustersOutputSchema),
  ivHistory: route(
    "GET",
    "ivHistory",
    "iv-history",
    "Rolling 252-session IV rank and IV percentile history for one ticker"
  )
    .input(OpenbbIvHistoryInputSchema)
    .output(OpenbbIvHistoryOutputSchema),
  macro: route("GET", "macro", "macro", "Macro series metadata and points")
    .input(OpenbbMacroInputSchema)
    .output(OpenbbMacroOutputSchema),
  recordRun: route(
    "POST",
    "recordRun",
    "runs",
    "Scheduler: record the outcome of one OpenBB job run"
  )
    .input(OpenbbRecordRunInputSchema)
    .output(z.object({ id: z.string() })),
  sec: route(
    "GET",
    "sec",
    "sec",
    "SEC filings, insider trades, 13F holders and FTD of a symbol"
  )
    .input(OpenbbSecInputSchema)
    .output(OpenbbSecOutputSchema),
  sec13fAccessions: route(
    "POST",
    "sec13fAccessions",
    "sec13f-accessions",
    "Scheduler: 13F accessions already stored (the sec-13f skip list)"
  )
    .input(z.object({}))
    .output(z.object({ accessions: z.array(accession) })),
  shorts: route(
    "GET",
    "shorts",
    "shorts",
    "FINRA short volume, short interest, OTC weekly and SEC FTD"
  )
    .input(OpenbbShortsInputSchema)
    .output(OpenbbShortsOutputSchema),
  status: route(
    "GET",
    "status",
    "status",
    "Last run per job and newest date per table"
  )
    .input(z.object({}))
    .output(OpenbbStatusOutputSchema),
  volContext: route(
    "GET",
    "volContext",
    "vol-context",
    "Vol index closes and ratios, VX curve, Core 7 IV with 1-year IV percentile/rank and term"
  )
    .input(OpenbbVolContextInputSchema)
    .output(OpenbbVolContextOutputSchema),
};

export type OpenbbBatchDocument = z.infer<typeof OpenbbBatchDocumentSchema>;
export type OpenbbIngestBatch = z.infer<typeof OpenbbIngestBatchSchema>;
export type OpenbbIngestInput = z.infer<typeof OpenbbIngestInputSchema>;
export type OpenbbDailyPricesState = z.infer<
  typeof OpenbbDailyPricesStateOutputSchema
>;
export type OpenbbRecordRunInput = z.infer<typeof OpenbbRecordRunInputSchema>;
export type OpenbbStatusOutput = z.infer<typeof OpenbbStatusOutputSchema>;
export type OpenbbIvBasisResult = z.infer<typeof OpenbbIvBasisResultSchema>;
export type OpenbbIvProxyBasisResult = z.infer<
  typeof OpenbbIvProxyBasisResultSchema
>;
export type OpenbbIvOneYear = z.infer<typeof OpenbbIvOneYearSchema>;
export type OpenbbIvHistoryHorizon =
  (typeof OPENBB_IV_HISTORY_HORIZONS)[number];
export type OpenbbIvHistoryInput = z.input<typeof OpenbbIvHistoryInputSchema>;
export type OpenbbIvHistoryPoint = z.infer<typeof OpenbbIvHistoryPointSchema>;
export type OpenbbIvHistoryOutput = z.infer<typeof OpenbbIvHistoryOutputSchema>;
export type OpenbbVolContextOutput = z.infer<
  typeof OpenbbVolContextOutputSchema
>;
export type OpenbbCotOutput = z.infer<typeof OpenbbCotOutputSchema>;
export type OpenbbMacroOutput = z.infer<typeof OpenbbMacroOutputSchema>;
export type OpenbbEventsOutput = z.infer<typeof OpenbbEventsOutputSchema>;
export type OpenbbShortsOutput = z.infer<typeof OpenbbShortsOutputSchema>;
export type OpenbbSecOutput = z.infer<typeof OpenbbSecOutputSchema>;
export type Openbb13fChange = z.infer<typeof Openbb13fChangeSchema>;
export type OpenbbForm4StateOutput = z.infer<
  typeof OpenbbForm4StateOutputSchema
>;
export type OpenbbInsiderClustersOutput = z.infer<
  typeof OpenbbInsiderClustersOutputSchema
>;
export type OpenbbInsiderCluster = z.infer<typeof OpenbbInsiderClusterSchema>;
