// Facts for the TRUE SLAP scorecard. Free sources only, read-only:
//  - SEC EDGAR company_tickers.json + XBRL companyfacts (public API; SEC asks for a descriptive
//    User-Agent with a contact address, max 10 req/s).
//  - Yahoo Finance chart API daily bars (same path as the rotation-matrix collector).
// No IBKR gateway (live engines share it). No scraping. No orders.
// Ported from vertex-research packages/reporting/deep-value-sources.mjs (PR #10 plus local fix ffa345d).
// The contact address is configuration (VERTEX_RESEARCH_CONTACT_EMAIL, or a full SEC_USER_AGENT),
// never committed; a placeholder is used when both are unset.

import type { DeepValueFacts } from "./deep-value.ts";
import { dig, field, type LensIo, messageOf, yahooSymbol } from "./lens-io.ts";

const YAHOO_UA = "Mozilla/5.0 (X11; Linux x86_64) vertex-research/deep-value";
const PLACEHOLDER_CONTACT = "owner@example.com";
const DAY_MS = 864e5;

/** SEC_USER_AGENT, else "vertex-research deep-value (personal research; <contact>)". */
export const secUserAgent = (env: LensIo["env"]): string =>
  env["SEC_USER_AGENT"] ||
  `vertex-research deep-value (personal research; ${env["VERTEX_RESEARCH_CONTACT_EMAIL"]?.trim() || PLACEHOLDER_CONTACT})`;

/** One XBRL fact row from SEC companyfacts. */
export type SecFactRow = Readonly<{
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  accn?: string;
}>;

type SecFacts = Readonly<
  Record<
    string,
    Readonly<
      Record<
        string,
        Readonly<{ units?: Readonly<Record<string, readonly SecFactRow[]>> }>
      >
    >
  >
>;

/** The parts of an SEC companyfacts document this extractor reads (not validated, as upstream). */
export type CompanyFacts = Readonly<{ facts?: SecFacts }>;

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
const OCF = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
];
// Fundamentals dropped for filers that report mainly in another currency.
const NON_USD_DROPPED = [
  "revenue",
  "revenuePrior",
  "revenueYear",
  "cash",
  "equity",
  "totalDebt",
  "operatingCashFlow",
  "debtTagMissing",
] as const;

const units = (
  facts: SecFacts,
  tag: string,
  namespace = "us-gaap",
  unit = "USD"
): readonly SecFactRow[] => facts[namespace]?.[tag]?.units?.[unit] ?? [];

const annual = (rows: readonly SecFactRow[]): SecFactRow[] =>
  rows.filter(
    (row) =>
      row.fp === "FY" &&
      /10-K|20-F|40-F/.test(row.form ?? "") &&
      Boolean(row.start) &&
      Boolean(row.end) &&
      Date.parse(row.end) - Date.parse(String(row.start)) > 300 * DAY_MS
  );

const latestBy = (rows: readonly SecFactRow[]): SecFactRow[] =>
  [...rows].sort(
    (a, b) =>
      (b.end ?? "").localeCompare(a.end ?? "") ||
      (b.filed ?? "").localeCompare(a.filed ?? "")
  );

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Newest instant (no start date) value across `tags`; the first tag wins a tie. */
const instant = (
  facts: SecFacts,
  tags: readonly string[]
): SecFactRow | null => {
  let best: SecFactRow | null = null;
  for (const tag of tags) {
    const row = latestBy(units(facts, tag).filter((r) => !r.start))[0];
    if (row && (!best || row.end > best.end)) best = row;
  }
  return best;
};

const revenueFacts = (facts: SecFacts, out: DeepValueFacts): void => {
  // Revenue: latest fiscal-year value across the known tags; prior year from the same tag.
  let best: SecFactRow[] = [];
  for (const tag of REVENUE) {
    const rows = latestBy(annual(units(facts, tag)));
    const top = rows[0];
    if (top && (best[0] === undefined || top.end > best[0].end)) best = rows;
  }
  const top = best[0];
  if (top === undefined) return;
  out.revenue = top.val;
  out.revenueYear = top.fy ?? top.end.slice(0, 4);
  const cutoff = isoDay(Date.parse(top.end) - 300 * DAY_MS);
  const prior = best.find((row) => row.end <= cutoff);
  if (prior) out.revenuePrior = prior.val;
};

// Debt: use the tag set whose latest value is newest; on a tie take the larger total (conservative, since
// issuers tag debt differently, e.g. convertible notes outside LongTermDebt). Parts must share that balance date.
const debtFacts = (facts: SecFacts, out: DeepValueFacts): void => {
  let debt: Readonly<{ end: string; val: number }> | null = null;
  for (const parts of DEBT_PARTS) {
    const latest = parts
      .map((tag) => latestBy(units(facts, tag).filter((r) => !r.start))[0])
      .filter((row): row is SecFactRow => row !== undefined);
    const end = latest
      .map((row) => row.end)
      .sort()
      .at(-1);
    if (end === undefined) continue;
    const val = latest
      .filter((row) => row.end === end)
      .reduce((sum, row) => sum + row.val, 0);
    if (!debt || end > debt.end || (end === debt.end && val > debt.val))
      debt = { end, val };
  }
  if (debt) {
    out.totalDebt = debt.val;
    out.debtDate = debt.end;
  } else out.debtTagMissing = true;
};

/** More rows in other three-letter currencies than in USD. */
const reportsMainlyNonUsd = (facts: SecFacts): boolean => {
  let usd = 0;
  let other = 0;
  for (const tag of Object.values(facts["us-gaap"] ?? {}))
    for (const [unit, rows] of Object.entries(tag.units ?? {})) {
      if (unit === "USD") usd += rows.length;
      else if (/^[A-Z]{3}$/.test(unit)) other += rows.length;
    }
  return other > usd;
};

const yearAgoMs = (end: string): number => Date.parse(end) - 365 * DAY_MS;
const nearYearAgo = (row: Readonly<{ end: string }>, target: number): boolean =>
  Math.abs(Date.parse(row.end) - target) <= 120 * DAY_MS;

/** "a" > "b" on accession numbers; false when either is missing (as JavaScript compares undefined). */
const laterAccession = (
  a: string | undefined,
  b: string | undefined
): boolean => a !== undefined && b !== undefined && a > b;

const shareFacts = (facts: SecFacts, out: DeepValueFacts): void => {
  // Shares: dei cover-page count, latest and about 1 year earlier.
  // Several share classes report separate rows for the same date: sum one filing's rows per date.
  const byEnd = new Map<
    string,
    { end: string; accn: string | undefined; val: number }
  >();
  for (const row of units(
    facts,
    "EntityCommonStockSharesOutstanding",
    "dei",
    "shares"
  )) {
    const current = byEnd.get(row.end);
    if (!current || laterAccession(row.accn, current.accn))
      byEnd.set(row.end, { accn: row.accn, end: row.end, val: row.val });
    else if (row.accn === current.accn) current.val += row.val;
  }
  const shares = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
  const latest = shares[0];
  if (latest) {
    out.sharesOutstanding = latest.val;
    out.sharesDate = latest.end;
    const target = yearAgoMs(latest.end);
    const ago = shares.find((row) => nearYearAgo(row, target));
    if (ago) out.sharesYearAgo = ago.val;
  }
  // Multi-class issuers sometimes tag only one class on the cover page: use basic weighted shares when larger.
  const weighted = latestBy(
    units(
      facts,
      "WeightedAverageNumberOfSharesOutstandingBasic",
      "us-gaap",
      "shares"
    )
  );
  const top = weighted[0];
  if (
    top &&
    (!out.sharesOutstanding || top.val > out.sharesOutstanding * 1.5)
  ) {
    out.sharesOutstanding = top.val;
    out.sharesDate = top.end;
    out.sharesSource = "weighted-average basic";
    const target = yearAgoMs(top.end);
    const span = (row: SecFactRow): number =>
      Date.parse(row.end) - Date.parse(String(row.start));
    const ago = weighted.find(
      (row) =>
        nearYearAgo(row, target) &&
        Math.abs(span(row) - span(top)) < 40 * DAY_MS
    );
    out.sharesYearAgo = ago ? ago.val : undefined;
  }
};

/** Longevity: first fiscal year with any us-gaap fact. */
const firstFiscalYear = (facts: SecFacts): number | null => {
  let first: number | null = null;
  for (const tag of Object.values(facts["us-gaap"] ?? {}))
    for (const rows of Object.values(tag.units ?? {}))
      for (const row of rows)
        if (row.fy && (first === null || row.fy < first)) first = row.fy;
  return first;
};

/** Extract scorecard facts from an SEC companyfacts document. Pure; `now` sets years of reporting. */
export const factsFromCompanyFacts = (
  document: CompanyFacts | null | undefined,
  now: Date = new Date()
): DeepValueFacts => {
  const facts: SecFacts = document?.facts ?? {};
  const out: DeepValueFacts = {};
  revenueFacts(facts, out);
  const cash = instant(facts, CASH);
  if (cash) {
    out.cash = cash.val;
    out.balanceDate = cash.end;
  }
  const equity = instant(facts, EQUITY);
  if (equity) out.equity = equity.val;
  debtFacts(facts, out);
  // Filers that report mainly in another currency (e.g. RMB 20-F filers) mix converted and local figures: drop them.
  if (reportsMainlyNonUsd(facts)) {
    for (const key of NON_USD_DROPPED) Reflect.deleteProperty(out, key);
    out.nonUsdFiler = true;
  }
  // As upstream: operating cash flow is read after the non-USD drop, so it is kept for those filers.
  const flow = OCF.map((tag) => latestBy(annual(units(facts, tag)))[0]).find(
    (row) => row !== undefined
  );
  if (flow) out.operatingCashFlow = flow.val;
  shareFacts(facts, out);
  const first = firstFiscalYear(facts);
  if (first !== null) {
    out.firstYear = first;
    out.yearsReporting = now.getUTCFullYear() - first;
  }
  return out;
};

type Maybe<T> = T | null | undefined;

export type YahooBar = Readonly<{
  close?: Maybe<number>;
  adj?: Maybe<number>;
  volume?: Maybe<number>;
}>;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export type BarFacts = Pick<
  DeepValueFacts,
  "price" | "priceAdjusted" | "high52" | "low52" | "sma50" | "avgVolume"
>;

/** Price facts from Yahoo daily bars (ascending). Pure. */
export const factsFromBars = (bars: readonly YahooBar[]): BarFacts => {
  // Adjusted closes for range/average (special distributions and splits do not create fake upside); raw last close for price.
  const closes = bars
    .map((bar) => (finite(bar.adj) ? bar.adj : bar.close))
    .filter(finite);
  const lastAdj = closes.at(-1);
  if (lastAdj === undefined) return {};
  const lastRaw = bars.at(-1)?.close;
  const last50 = closes.slice(-50);
  const volumes = bars
    .slice(-30)
    .map((bar) => bar.volume)
    .filter(finite);
  const year = closes.slice(-252);
  return {
    avgVolume: volumes.length
      ? volumes.reduce((a, b) => a + b, 0) / volumes.length
      : null,
    high52: Math.max(...year),
    low52: Math.min(...year),
    price: finite(lastRaw) ? lastRaw : lastAdj,
    priceAdjusted: lastAdj,
    sma50: last50.length === 50 ? last50.reduce((a, b) => a + b, 0) / 50 : null,
  };
};

export type YahooChart = Readonly<{
  asOf: string | null;
  name: string | null;
  bars: YahooBar[];
}>;

/** Reads the one-year daily chart document (pure). */
export const parseYahooChart = (document: unknown): YahooChart => {
  const chart = dig(document, "chart", "result", 0);
  const quote = dig(chart, "indicators", "quote", 0);
  const adjusted = dig(chart, "indicators", "adjclose", 0, "adjclose");
  const adj: readonly unknown[] = Array.isArray(adjusted) ? adjusted : [];
  const stamps = dig(chart, "timestamp");
  const timestamps: readonly unknown[] = Array.isArray(stamps) ? stamps : [];
  const last = timestamps.at(-1);
  const name =
    dig(chart, "meta", "longName") ?? dig(chart, "meta", "shortName") ?? null;
  return {
    asOf:
      last === undefined
        ? null
        : new Date(Number(last) * 1000).toISOString().slice(0, 10),
    bars: timestamps
      .map((_, i) => ({
        adj: adj[i] as Maybe<number>,
        close: dig(quote, "close", i) as Maybe<number>,
        volume: dig(quote, "volume", i) as Maybe<number>,
      }))
      .filter((bar) => finite(bar.close)),
    name: name as string | null,
  };
};

export type SecTicker = Readonly<{ cik: unknown; title: unknown }>;

export type GatheredFacts = DeepValueFacts & {
  symbol: string;
  errors: string[];
};

export type DeepValueSources = Readonly<{
  secTickerMap: () => Promise<ReadonlyMap<string, SecTicker>>;
  yahooBars: (symbol: string) => Promise<YahooChart>;
  gatherFacts: (
    symbol: string,
    extra?: Readonly<Partial<DeepValueFacts>>
  ) => Promise<GatheredFacts>;
}>;

/**
 * SEC and Yahoo readers over injected IO. SEC calls are serialized at about 8 per second, and the
 * ticker map is cached once read (per instance, as upstream per process).
 */
export const createDeepValueSources = (
  io: Pick<LensIo, "env" | "fetch" | "now" | "sleep">
): DeepValueSources => {
  let secGate: Promise<void> = Promise.resolve();
  let tickerMap: ReadonlyMap<string, SecTicker> | null = null;
  const userAgent = secUserAgent(io.env);

  const secFetch = async (url: string): Promise<unknown> => {
    const turn = secGate.then(() => io.sleep(125));
    secGate = turn;
    await turn;
    const response = await io.fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
    return response.json();
  };

  const secTickerMap = async (): Promise<ReadonlyMap<string, SecTicker>> => {
    if (tickerMap) return tickerMap;
    const document = await secFetch(
      "https://www.sec.gov/files/company_tickers.json"
    );
    tickerMap = new Map(
      Object.values((document ?? {}) as Record<string, unknown>).map((row) => [
        String(field(row, "ticker")).toUpperCase(),
        { cik: field(row, "cik_str"), title: field(row, "title") },
      ])
    );
    return tickerMap;
  };

  const yahooBars = async (symbol: string): Promise<YahooChart> => {
    const response = await io.fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=1y&interval=1d`,
      {
        headers: { accept: "application/json", "user-agent": YAHOO_UA },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    return parseYahooChart(await response.json());
  };

  /** Gather all facts for one ticker. Errors per source are recorded, not thrown. */
  const gatherFacts = async (
    symbol: string,
    extra: Readonly<Partial<DeepValueFacts>> = {}
  ): Promise<GatheredFacts> => {
    const sym = String(symbol).trim().toUpperCase();
    const facts: GatheredFacts = { symbol: sym, ...extra, errors: [] };
    try {
      const chart = await yahooBars(sym);
      Object.assign(facts, factsFromBars(chart.bars), { asOf: chart.asOf });
      facts.name ??= chart.name;
    } catch (error) {
      facts.errors.push(`prices: ${messageOf(error)}`);
    }
    try {
      const map = await secTickerMap();
      const hit = map.get(sym.replace(".", "-")) ?? map.get(sym);
      if (hit) {
        facts.cik = hit.cik as number | string;
        facts.name ??= hit.title as string;
        const document = await secFetch(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(hit.cik).padStart(10, "0")}.json`
        );
        if (document)
          Object.assign(
            facts,
            factsFromCompanyFacts(document as CompanyFacts, io.now())
          );
      }
    } catch (error) {
      facts.errors.push(`sec: ${messageOf(error)}`);
    }
    return facts;
  };

  return { gatherFacts, secTickerMap, yahooBars };
};
