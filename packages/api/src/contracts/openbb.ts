import { oc } from "@orpc/contract";
import { z } from "zod";

// OpenBB data sources (openbb.*, docs/vertex-rebuild/openbb.md). The Python fetcher in
// services/openbb prints one `openbb-batch.v1` document per job; scripts/openbb/tick.ts checks it
// with these schemas and posts it to openbb.ingest in chunks, then openbb.recordRun. Reads are
// operator-only and read-only. Research only: nothing here places, changes or cancels orders.

export const OPENBB_BATCH_SCHEMA_VERSION = "openbb-batch.v1";
/** Rows one openbb.ingest call may carry. */
export const OPENBB_MAX_INGEST_ROWS = 2000;
/** Stored sessions the IV percentile needs before it is reported. */
export const OPENBB_IV_PERCENTILE_MIN_SESSIONS = 20;
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
] as const;
export const OPENBB_TABLES = [
  "daily_series",
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
  "factor_returns",
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
export const OPENBB_RUN_STATUSES = ["ok", "partial", "failed"] as const;
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
  famafrench: ["factor_returns"],
  "fed-events": ["event_calendar"],
  "fed-rates": ["macro_points"],
  "fed-regime": ["macro_points"],
  "finra-otc": ["finra_otc_weekly"],
  "finra-short-interest": ["short_interest"],
  "finra-short-volume": ["short_volume_daily"],
  "fred-keyless": ["macro_points"],
  "oecd-cli": ["macro_points"],
  "sec-13f": ["sec_13f_holdings"],
  "sec-filings": ["sec_filings"],
  "sec-ftd": ["sec_ftd"],
  "sec-insider": ["sec_insider_trades"],
  "treasury-tga": ["macro_points", "event_calendar"],
};
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
const symbol = z.string().regex(/^[A-Z0-9.^=-]{1,16}$/);
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
  close: finite,
  date,
  high: nullableFinite,
  low: nullableFinite,
  open: nullableFinite,
  seriesId: z.enum(OPENBB_VOL_INDEX_IDS),
});
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
  symbol,
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
  assetClass: label(40).nullable(),
  cusip,
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
export const OpenbbFactorRowSchema = z.strictObject({
  date,
  factor: z.enum(OPENBB_FACTORS),
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  value: finite,
});

/** Row schema of each ingest table. */
export const OPENBB_ROW_SCHEMAS = {
  cot_positions: OpenbbCotRowSchema,
  daily_series: OpenbbDailySeriesRowSchema,
  event_calendar: OpenbbEventRowSchema,
  factor_returns: OpenbbFactorRowSchema,
  finra_otc_weekly: OpenbbFinraOtcRowSchema,
  macro_points: OpenbbMacroPointRowSchema,
  option_iv_daily: OpenbbOptionIvDailyRowSchema,
  option_iv_term: OpenbbOptionIvTermRowSchema,
  sec_13f_holdings: OpenbbSec13fRowSchema,
  sec_filings: OpenbbSecFilingRowSchema,
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
      rows: rows(OpenbbFactorRowSchema),
      table: z.literal("factor_returns"),
    }),
  ]);
};

export const OpenbbIngestBatchSchema = tableRows(OPENBB_MAX_INGEST_ROWS);
/** One fetcher document (stdout of `python -I -m vertex_openbb <job>`). */
export const OpenbbBatchDocumentSchema = z
  .strictObject({
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
  );

export const OpenbbIngestInputSchema = z
  .strictObject({
    batch: OpenbbIngestBatchSchema,
    job: z.enum(OPENBB_JOBS),
  })
  .refine((input) => jobWritesTable(input.job, input.batch.table), {
    message: "this job does not write this table",
    path: ["batch", "table"],
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

export const OpenbbMacroInputSchema = z.object({
  from: date.optional(),
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
export const OpenbbSecOutputSchema = z.object({
  filings: z.array(OpenbbSecFilingRowSchema),
  ftd: z.array(OpenbbSecFtdRowSchema),
  holdings13f: z.array(OpenbbSec13fRowSchema),
  insiderTrades: z.array(OpenbbSecInsiderRowSchema),
  symbol,
});

export const OpenbbFactorsInputSchema = z.object({
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  from: date.optional(),
});
export const OpenbbFactorsOutputSchema = z.object({
  from: date,
  frequency: z.enum(OPENBB_FACTOR_FREQUENCIES),
  rows: z.array(OpenbbFactorRowSchema),
});

export const OPENBB_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "OpenBB storage unavailable", status: 503 },
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
  ingest: route(
    "POST",
    "ingest",
    "ingest",
    "Scheduler: upsert one table chunk of an OpenBB fetcher batch"
  )
    .input(OpenbbIngestInputSchema)
    .output(OpenbbIngestOutputSchema),
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
    "Vol index closes and ratios, VX curve, Core 7 IV with IV percentile and term"
  )
    .input(OpenbbVolContextInputSchema)
    .output(OpenbbVolContextOutputSchema),
};

export type OpenbbBatchDocument = z.infer<typeof OpenbbBatchDocumentSchema>;
export type OpenbbIngestBatch = z.infer<typeof OpenbbIngestBatchSchema>;
export type OpenbbIngestInput = z.infer<typeof OpenbbIngestInputSchema>;
export type OpenbbRecordRunInput = z.infer<typeof OpenbbRecordRunInputSchema>;
export type OpenbbVolContextOutput = z.infer<
  typeof OpenbbVolContextOutputSchema
>;
export type OpenbbCotOutput = z.infer<typeof OpenbbCotOutputSchema>;
export type OpenbbMacroOutput = z.infer<typeof OpenbbMacroOutputSchema>;
export type OpenbbEventsOutput = z.infer<typeof OpenbbEventsOutputSchema>;
export type OpenbbShortsOutput = z.infer<typeof OpenbbShortsOutputSchema>;
export type OpenbbSecOutput = z.infer<typeof OpenbbSecOutputSchema>;
