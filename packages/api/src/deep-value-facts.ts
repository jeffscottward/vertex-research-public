import { z } from "zod";

import type { DeepValueFacts } from "./deep-value-score.ts";

// Fact extraction for the TRUE SLAP scorecard. Port of vertex-research
// packages/reporting/deep-value-sources.mjs (ffa345d): pure parsers for SEC EDGAR XBRL companyfacts and
// Yahoo Finance chart bars. The network calls live in server/research-lenses.ts.

const DAY_MS = 864e5;

const XbrlRowSchema = z.object({
  accn: z.string().optional(),
  end: z.string(),
  filed: z.string().optional(),
  form: z.string().nullable().optional(),
  fp: z.string().nullable().optional(),
  fy: z.number().int().nullable().optional(),
  start: z.string().optional(),
  val: z.number(),
});

export const CompanyFactsSchema = z.object({
  facts: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.object({ units: z.record(z.string(), z.array(XbrlRowSchema)) })
      )
    )
    .default({}),
});

export type XbrlRow = z.infer<typeof XbrlRowSchema>;
export type CompanyFacts = z.infer<typeof CompanyFactsSchema>;
type FactGroups = CompanyFacts["facts"];

const REVENUE = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];
const CASH = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  "Cash",
];
const EQUITY = [
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
];
const DEBT_PARTS = [
  ["LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"],
  [
    "LongTermDebtAndCapitalLeaseObligations",
    "LongTermDebtAndCapitalLeaseObligationsCurrent",
  ],
  ["LongTermDebt"],
  ["LongTermDebtNoncurrent", "LongTermDebtCurrent"],
  ["DebtCurrent", "LongTermDebtNoncurrent"],
  ["ConvertibleLongTermNotesPayable"],
  ["ConvertibleNotesPayable"],
  ["SeniorNotes"],
  ["NotesPayable"],
  ["LongTermLineOfCredit"],
];
const OPERATING_CASH_FLOW = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
];
const rowsOf = (
  groups: FactGroups,
  tag: string,
  namespace = "us-gaap",
  unit = "USD"
): XbrlRow[] => groups[namespace]?.[tag]?.units[unit] ?? [];

const duration = (row: XbrlRow): number =>
  Date.parse(row.end) - Date.parse(row.start ?? row.end);

// Full fiscal years from annual reports only.
const annual = (rows: XbrlRow[]): XbrlRow[] =>
  rows.filter(
    (row) =>
      row.fp === "FY" &&
      /10-K|20-F|40-F/u.test(row.form ?? "") &&
      row.start !== undefined &&
      duration(row) > 300 * DAY_MS
  );

// Newest period first; a later filing wins for the same period.
const newestFirst = (rows: XbrlRow[]): XbrlRow[] =>
  [...rows].sort(
    (a, b) =>
      b.end.localeCompare(a.end) || (b.filed ?? "").localeCompare(a.filed ?? "")
  );

const latestInstant = (groups: FactGroups, tag: string): XbrlRow | undefined =>
  newestFirst(rowsOf(groups, tag).filter((row) => row.start === undefined))[0];

const newestInstant = (
  groups: FactGroups,
  tags: readonly string[]
): XbrlRow | undefined => {
  let best: XbrlRow | undefined;
  for (const tag of tags) {
    const row = latestInstant(groups, tag);
    if (row !== undefined && (best === undefined || row.end > best.end))
      best = row;
  }
  return best;
};

type Facts = Partial<DeepValueFacts>;

const revenueFacts = (groups: FactGroups): Facts => {
  // Latest fiscal-year value across the known tags; prior year from the same tag.
  let best: XbrlRow[] = [];
  for (const tag of REVENUE) {
    const rows = newestFirst(annual(rowsOf(groups, tag)));
    const head = rows[0];
    const current = best[0];
    if (head !== undefined && (current === undefined || head.end > current.end))
      best = rows;
  }
  const latest = best[0];
  if (latest === undefined) return {};
  const priorEnd = new Date(Date.parse(latest.end) - 300 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const prior = best.find((row) => row.end <= priorEnd);
  return {
    revenue: latest.val,
    revenueYear:
      typeof latest.fy === "number"
        ? String(latest.fy)
        : latest.end.slice(0, 4),
    ...(prior === undefined ? {} : { revenuePrior: prior.val }),
  };
};

const debtFacts = (groups: FactGroups): Facts => {
  // Use the tag set whose latest value is newest; on a tie take the larger total (conservative, since
  // issuers tag debt differently). Parts must share that balance date.
  let debt: { end: string; val: number } | undefined;
  for (const parts of DEBT_PARTS) {
    const latest = parts.flatMap((tag) => {
      const row = latestInstant(groups, tag);
      return row === undefined ? [] : [row];
    });
    const end = latest
      .map((row) => row.end)
      .sort()
      .at(-1);
    if (end === undefined) continue;
    const val = latest
      .filter((row) => row.end === end)
      .reduce((sum, row) => sum + row.val, 0);
    if (
      debt === undefined ||
      end > debt.end ||
      (end === debt.end && val > debt.val)
    )
      debt = { end, val };
  }
  return debt === undefined
    ? { debtTagMissing: true }
    : { totalDebt: debt.val };
};

const coverShares = (groups: FactGroups): Facts => {
  // dei cover-page count, latest and about 1 year earlier. Several share classes report separate rows
  // for the same date: sum one filing's rows per date.
  const byEnd = new Map<string, { end: string; accn: string; val: number }>();
  for (const row of rowsOf(
    groups,
    "EntityCommonStockSharesOutstanding",
    "dei",
    "shares"
  )) {
    const accn = row.accn ?? "";
    const current = byEnd.get(row.end);
    if (current === undefined || accn > current.accn)
      byEnd.set(row.end, { accn, end: row.end, val: row.val });
    else if (accn === current.accn) current.val += row.val;
  }
  const cover = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
  const head = cover[0];
  if (head === undefined) return {};
  const target = Date.parse(head.end) - 365 * DAY_MS;
  const ago = cover.find(
    (row) => Math.abs(Date.parse(row.end) - target) <= 120 * DAY_MS
  );
  return {
    sharesOutstanding: head.val,
    ...(ago === undefined ? {} : { sharesYearAgo: ago.val }),
  };
};

const shareFacts = (groups: FactGroups): Facts => {
  const cover = coverShares(groups);
  // Multi-class issuers sometimes tag only one class on the cover page: use basic weighted shares when larger.
  const weighted = newestFirst(
    rowsOf(
      groups,
      "WeightedAverageNumberOfSharesOutstandingBasic",
      "us-gaap",
      "shares"
    )
  );
  const latest = weighted[0];
  if (
    latest === undefined ||
    (cover.sharesOutstanding !== undefined &&
      latest.val <= cover.sharesOutstanding * 1.5)
  )
    return cover;
  const target = Date.parse(latest.end) - 365 * DAY_MS;
  const ago = weighted.find(
    (row) =>
      Math.abs(Date.parse(row.end) - target) <= 120 * DAY_MS &&
      Math.abs(duration(row) - duration(latest)) < 40 * DAY_MS
  );
  return {
    sharesOutstanding: latest.val,
    ...(ago === undefined ? {} : { sharesYearAgo: ago.val }),
  };
};

// Row counts per currency and the first fiscal year across all us-gaap facts.
const reportingProfile = (
  groups: FactGroups
): { nonUsd: boolean; firstYear: number | undefined } => {
  let usdRows = 0;
  let otherRows = 0;
  let firstYear = Number.POSITIVE_INFINITY;
  for (const fact of Object.values(groups["us-gaap"] ?? {})) {
    for (const [unit, rows] of Object.entries(fact.units)) {
      if (unit === "USD") usdRows += rows.length;
      else if (/^[A-Z]{3}$/u.test(unit)) otherRows += rows.length;
      for (const row of rows)
        if (typeof row.fy === "number") firstYear = Math.min(firstYear, row.fy);
    }
  }
  return {
    firstYear: Number.isFinite(firstYear) ? firstYear : undefined,
    nonUsd: otherRows > usdRows,
  };
};

const usdFundamentals = (groups: FactGroups): Facts => {
  const cash = newestInstant(groups, CASH);
  const equity = newestInstant(groups, EQUITY);
  const cashFlow = OPERATING_CASH_FLOW.map(
    (tag) => newestFirst(annual(rowsOf(groups, tag)))[0]
  ).find((row) => row !== undefined);
  return {
    ...revenueFacts(groups),
    ...(cash === undefined ? {} : { cash: cash.val }),
    ...(equity === undefined ? {} : { equity: equity.val }),
    ...debtFacts(groups),
    ...(cashFlow === undefined ? {} : { operatingCashFlow: cashFlow.val }),
  };
};

/** Extract scorecard facts from an SEC companyfacts document. `now` sets the longevity year. */
export const factsFromCompanyFacts = (
  document: CompanyFacts,
  now: Date = new Date()
): Facts => {
  const groups = document.facts;
  const profile = reportingProfile(groups);
  // Filers that report mainly in another currency (e.g. RMB 20-F filers) mix converted and local
  // figures: their USD fundamentals (revenue, cash, equity, debt, operating cash flow) are dropped.
  const fundamentals: Facts = profile.nonUsd
    ? { nonUsdFiler: true }
    : usdFundamentals(groups);
  return {
    ...fundamentals,
    ...shareFacts(groups),
    // Longevity: first fiscal year with any us-gaap fact.
    ...(profile.firstYear === undefined
      ? {}
      : {
          firstYear: profile.firstYear,
          yearsReporting: now.getUTCFullYear() - profile.firstYear,
        }),
  };
};

export type DailyBar = Readonly<{
  close: number;
  adj: number | null;
  volume: number | null;
}>;

/** Price facts from daily bars (ascending). Adjusted closes for range and average; raw last close for price. */
export const factsFromBars = (
  bars: readonly DailyBar[]
): Partial<DeepValueFacts> => {
  const last = bars.at(-1);
  if (last === undefined) return {};
  // Special distributions and splits must not create fake upside: range and average use adjusted closes.
  const closes = bars.map((bar) => bar.adj ?? bar.close);
  const year = closes.slice(-252);
  const last50 = closes.slice(-50);
  const volumes = bars
    .slice(-30)
    .flatMap((bar) => (bar.volume === null ? [] : [bar.volume]));
  return {
    avgVolume:
      volumes.length === 0
        ? null
        : volumes.reduce((sum, value) => sum + value, 0) / volumes.length,
    high52: Math.max(...year),
    low52: Math.min(...year),
    price: last.close,
    priceAdjusted: closes.at(-1) as number,
    sma50:
      last50.length === 50
        ? last50.reduce((sum, value) => sum + value, 0) / 50
        : null,
  };
};

const nullableNumbers = z.array(z.number().nullable()).optional();

export const YahooChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          indicators: z.object({
            adjclose: z
              .array(z.object({ adjclose: nullableNumbers }))
              .optional(),
            quote: z
              .array(
                z.object({ close: nullableNumbers, volume: nullableNumbers })
              )
              .optional(),
          }),
          meta: z
            .object({
              longName: z.string().nullable().optional(),
              shortName: z.string().nullable().optional(),
            })
            .optional(),
          timestamp: z.array(z.number()).optional(),
        })
      )
      .nullable(),
  }),
});

export type YahooChart = z.infer<typeof YahooChartSchema>;

/** Bars, name and last bar date from a Yahoo chart document. Bars without a finite close are dropped. */
export const barsFromYahooChart = (
  chart: YahooChart
): { asOf: string | null; name: string | null; bars: DailyBar[] } => {
  const result = chart.chart.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators.quote?.[0];
  const adjusted = result?.indicators.adjclose?.[0]?.adjclose ?? [];
  const bars = timestamps.flatMap((_, index) => {
    const close = quote?.close?.[index];
    if (typeof close !== "number" || !Number.isFinite(close)) return [];
    return [
      {
        adj: adjusted[index] ?? null,
        close,
        volume: quote?.volume?.[index] ?? null,
      },
    ];
  });
  const lastTime = timestamps.at(-1);
  return {
    asOf:
      lastTime === undefined
        ? null
        : new Date(lastTime * 1000).toISOString().slice(0, 10),
    bars,
    name: result?.meta?.longName ?? result?.meta?.shortName ?? null,
  };
};
