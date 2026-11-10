// TRUE SLAP scorecard (method from IG reel Dew5OAejyOH, @willbchou; creator claims unverified).
// The reel names 8 criteria and gives NO numbers. Every proxy and cutoff below is OURS, not the reel's.
// Pure functions only: input = facts gathered by deep-value-sources.ts. No network, no orders.
// Ported from vertex-research packages/reporting/deep-value.mjs (PR #10 plus local fix ffa345d).

export const CRITERIA = [
  {
    id: "timeHorizon",
    label: "Time horizon",
    lens: "TRUE",
    proxy:
      "Cash runway: cash ÷ yearly operating cash burn (or positive operating cash flow)",
  },
  {
    id: "risk",
    label: "Risk",
    lens: "TRUE",
    proxy: "Balance sheet: total debt ÷ stockholders equity",
  },
  {
    id: "upside",
    label: "Upside",
    lens: "TRUE",
    proxy:
      "Implied price at the industry median EV ÷ sales vs last price (fallback: 52-week high)",
  },
  {
    id: "entry",
    label: "Entry",
    lens: "TRUE",
    proxy: "Position in the 52-week range and price vs 50-day average",
  },
  {
    id: "substance",
    label: "Substance",
    lens: "SLAP",
    proxy: "Annual revenue and revenue growth (SEC filings)",
  },
  {
    id: "longevity",
    label: "Longevity",
    lens: "SLAP",
    proxy: "Years of SEC financial reporting",
  },
  {
    id: "alignment",
    label: "Alignment",
    lens: "SLAP",
    proxy:
      "Share-count change over about 1 year (buyback vs dilution); insider ownership not collected",
  },
  {
    id: "price",
    label: "Price",
    lens: "SLAP",
    proxy: "Valuation: EV ÷ sales and price ÷ book",
  },
] as const;

export type CriterionId = (typeof CRITERIA)[number]["id"];

// Our cutoffs (not the reel's). Exported so the UI can show them.
export const CUTOFFS = {
  debtToEquity: [1.5, 0.5],
  evSales: [3, 1],
  priceBook: [2, 1],
  rangeLowerPct: 40,
  revenueUsd: 10e6,
  runwayMonths: [12, 24],
  shareChangePct: [10, 1],
  upsideToHighPct: [33, 100],
  yearsReporting: [5, 10],
} as const;
export const UNIVERSE_CUTOFFS = {
  maxMarketCap: 1e9,
  maxPrice: 10,
  minDollarVolume: 100e3,
  minMarketCap: 50e6,
} as const;
export const FLAG_CUTOFFS = {
  dilutionPct: 20,
  illiquidDollarVolume: 500e3,
  lowPrice: 5,
  penny: 1,
  shortRunwayMonths: 12,
} as const;

type Maybe<T> = T | null | undefined;

/** Scorecard inputs. Every field is optional: missing data scores null, not zero. */
export interface DeepValueFacts {
  asOf?: Maybe<string>;
  avgVolume?: Maybe<number>;
  balanceDate?: Maybe<string>;
  cash?: Maybe<number>;
  cik?: Maybe<number | string>;
  debtDate?: Maybe<string>;
  debtTagMissing?: Maybe<boolean>;
  equity?: Maybe<number>;
  errors?: string[];
  firstYear?: Maybe<number>;
  high52?: Maybe<number>;
  industry?: Maybe<string>;
  low52?: Maybe<number>;
  marketCap?: Maybe<number>;
  name?: Maybe<string>;
  nonUsdFiler?: Maybe<boolean>;
  operatingCashFlow?: Maybe<number>;
  peerCount?: Maybe<number>;
  peerEvSales?: Maybe<number>;
  price?: Maybe<number>;
  priceAdjusted?: Maybe<number>;
  revenue?: Maybe<number>;
  revenuePrior?: Maybe<number>;
  revenueYear?: Maybe<number | string>;
  roles?: Maybe<string[]>;
  sharesDate?: Maybe<string>;
  sharesOutstanding?: Maybe<number>;
  sharesSource?: Maybe<string>;
  sharesYearAgo?: Maybe<number>;
  sma50?: Maybe<number>;
  symbol?: string;
  totalDebt?: Maybe<number>;
  yearsReporting?: Maybe<number>;
}

export type DerivedMetrics = Readonly<{
  marketCap: number | null;
  enterpriseValue: number | null;
  evSales: number | null;
  priceBook: number | null;
  debtToEquity: number | null;
  /** Infinity when operating cash flow is positive. */
  runwayMonths: number | null;
  revenueGrowthPct: number | null;
  shareChangePct: number | null;
  rangePct: number | null;
  upsideToHighPct: number | null;
  peerUpsidePct: number | null;
  dollarVolume: number | null;
}>;

export type CriterionResult = Readonly<{
  score: number | null;
  evidence: string;
}>;

export type Flag = Readonly<{ id: string; label: string }>;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** One decimal (every caller passes a finite value). */
const r1 = (value: number): number => Math.round(value * 10) / 10;
const money = (value: Maybe<number>): string => {
  if (!finite(value)) return "n/a";
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
};
const result = (score: number | null, evidence: string): CriterionResult => ({
  evidence,
  score,
});
const missing = (what: string): CriterionResult =>
  result(null, `No data: ${what}`);
const signed = (value: number): string =>
  `${value >= 0 ? "+" : ""}${r1(value)}`;
/** 2 at or past `strong`, 1 at or past `fair`, else 0 (higher is better). */
const tierUp = (value: number, fair: number, strong: number): number =>
  value >= strong ? 2 : value >= fair ? 1 : 0;
/** 2 at or under `strong`, 1 at or under `fair`, else 0 (lower is better). */
const tierDown = (value: number, fair: number, strong: number): number =>
  value <= strong ? 2 : value <= fair ? 1 : 0;

const ratio = (
  numerator: number | null,
  denominator: Maybe<number>
): number | null =>
  finite(numerator) && finite(denominator) && denominator > 0
    ? numerator / denominator
    : null;

const runwayOf = (facts: DeepValueFacts): number | null => {
  const flow = facts.operatingCashFlow;
  if (!finite(flow)) return null;
  if (flow >= 0) return Number.POSITIVE_INFINITY;
  return finite(facts.cash) ? (facts.cash / -flow) * 12 : null;
};

const peerUpsideOf = (
  facts: DeepValueFacts,
  debt: number | null
): number | null => {
  const { peerEvSales, revenue, sharesOutstanding: shares, price } = facts;
  if (
    !(
      finite(peerEvSales) &&
      finite(revenue) &&
      revenue > 0 &&
      finite(shares) &&
      shares > 0 &&
      finite(price) &&
      price > 0
    )
  )
    return null;
  const equityValue =
    peerEvSales * revenue - (debt ?? 0) + (finite(facts.cash) ? facts.cash : 0);
  return (equityValue / shares / price - 1) * 100;
};

/** Market cap (price x shares, else the stated cap), debt and enterprise value. */
const valuationOf = (
  facts: DeepValueFacts
): Readonly<{
  marketCap: number | null;
  debt: number | null;
  enterpriseValue: number | null;
}> => {
  const shares = facts.sharesOutstanding;
  const marketCap =
    finite(facts.price) && finite(shares)
      ? facts.price * shares
      : finite(facts.marketCap)
        ? facts.marketCap
        : null;
  const debt = finite(facts.totalDebt) ? facts.totalDebt : null;
  const enterpriseValue = finite(marketCap)
    ? marketCap + (debt ?? 0) - (finite(facts.cash) ? facts.cash : 0)
    : null;
  return { debt, enterpriseValue, marketCap };
};

/** Derived metrics from raw facts. All inputs optional. */
export const derive = (facts: DeepValueFacts = {}): DerivedMetrics => {
  const shares = facts.sharesOutstanding;
  const { marketCap, debt, enterpriseValue } = valuationOf(facts);
  // Same basis as the adjusted 52-week range.
  const px = finite(facts.priceAdjusted) ? facts.priceAdjusted : facts.price;
  const { high52, low52, revenue, revenuePrior, sharesYearAgo } = facts;
  return {
    debtToEquity:
      finite(facts.equity) && facts.equity > 0
        ? (debt ?? 0) / facts.equity
        : null,
    dollarVolume:
      finite(facts.price) && finite(facts.avgVolume)
        ? facts.price * facts.avgVolume
        : null,
    enterpriseValue,
    evSales: ratio(enterpriseValue, revenue),
    marketCap,
    // Peer upside: equity value at the industry median EV/sales, per share, vs price.
    peerUpsidePct: peerUpsideOf(facts, debt),
    priceBook: ratio(marketCap, facts.equity),
    rangePct:
      finite(px) && finite(high52) && finite(low52) && high52 > low52
        ? ((px - low52) / (high52 - low52)) * 100
        : null,
    revenueGrowthPct:
      finite(revenue) && finite(revenuePrior) && revenuePrior > 0
        ? (revenue / revenuePrior - 1) * 100
        : null,
    runwayMonths: runwayOf(facts),
    shareChangePct:
      finite(shares) && finite(sharesYearAgo) && sharesYearAgo > 0
        ? (shares / sharesYearAgo - 1) * 100
        : null,
    upsideToHighPct:
      finite(px) && finite(high52) && px > 0 ? (high52 / px - 1) * 100 : null,
  };
};

type Scorer = (
  facts: DeepValueFacts,
  derived: DerivedMetrics
) => CriterionResult;

const timeHorizon: Scorer = (facts, derived) => {
  const runway = derived.runwayMonths;
  if (runway === Number.POSITIVE_INFINITY)
    return result(
      2,
      `Operating cash flow is positive (${money(facts.operatingCashFlow)}/yr); no runway limit.`
    );
  if (!finite(runway)) return missing("operating cash flow or cash");
  const [fair, strong] = CUTOFFS.runwayMonths;
  return result(
    tierUp(runway, fair, strong),
    `About ${Math.round(runway)} months of cash (${money(facts.cash)}) at ${money(-Number(facts.operatingCashFlow))}/yr burn.`
  );
};

const risk: Scorer = (facts, derived) => {
  if (finite(facts.equity) && facts.equity <= 0)
    return result(
      0,
      `Stockholders equity is negative (${money(facts.equity)}).`
    );
  if (!finite(derived.debtToEquity)) return missing("stockholders equity");
  const [fair, strong] = CUTOFFS.debtToEquity;
  const debt = facts.debtTagMissing
    ? "not tagged in SEC data, counted as $0; check the 10-K"
    : money(facts.totalDebt ?? 0);
  return result(
    tierDown(derived.debtToEquity, fair, strong),
    `Debt ÷ equity ${derived.debtToEquity.toFixed(2)} (debt ${debt}, equity ${money(facts.equity)}).`
  );
};

// Upside: peer valuation when the industry median is known; else 52-week-high headroom (overlaps with Entry).
const upside: Scorer = (facts, derived) => {
  const [fair, strong] = CUTOFFS.upsideToHighPct;
  if (finite(derived.peerUpsidePct))
    return result(
      tierUp(derived.peerUpsidePct, fair, strong),
      `${signed(derived.peerUpsidePct)}% to the price implied by the industry median EV ÷ sales ${Number(facts.peerEvSales).toFixed(2)} (n=${facts.peerCount ?? "?"}).`
    );
  if (!finite(derived.upsideToHighPct))
    return missing("peer valuation and 52-week high");
  return result(
    tierUp(derived.upsideToHighPct, fair, strong),
    `Fallback (no peer median): ${r1(derived.upsideToHighPct)}% back to the adjusted 52-week high $${Number(facts.high52).toFixed(2)}.`
  );
};

const entry: Scorer = (facts, derived) => {
  if (!finite(derived.rangePct)) return missing("52-week range");
  const low = derived.rangePct <= CUTOFFS.rangeLowerPct;
  const sma50 = facts.sma50;
  if (!finite(sma50))
    return result(
      low ? 1 : 0,
      `At ${Math.round(derived.rangePct)}% of the 52-week range.`
    );
  const px = finite(facts.priceAdjusted) ? facts.priceAdjusted : facts.price;
  // Number() keeps the JavaScript comparison of a missing price (false) and a null price (0).
  const above = Number(px) >= sma50;
  return result(
    (low ? 1 : 0) + (above ? 1 : 0),
    `At ${Math.round(derived.rangePct)}% of the 52-week range, ${above ? "above" : "below"} the 50-day average $${sma50.toFixed(2)}.`
  );
};

const substance: Scorer = (facts, derived) => {
  const revenue = facts.revenue;
  if (!finite(revenue)) return missing("annual revenue");
  const grow = finite(derived.revenueGrowthPct)
    ? derived.revenueGrowthPct
    : null;
  const score =
    revenue >= CUTOFFS.revenueUsd && (grow === null || grow >= 0)
      ? 2
      : revenue > 0
        ? 1
        : 0;
  return result(
    score,
    `Revenue ${money(revenue)} (FY ${facts.revenueYear ?? "?"})${grow === null ? "" : `, ${signed(grow)}% vs prior year`}.`
  );
};

const longevity: Scorer = (facts) => {
  const years = facts.yearsReporting;
  if (!finite(years)) return missing("SEC reporting history");
  const [fair, strong] = CUTOFFS.yearsReporting;
  return result(
    tierUp(years, fair, strong),
    `${years} years of SEC financial data (since ${facts.firstYear ?? "?"}).`
  );
};

const alignment: Scorer = (_facts, derived) => {
  const change = derived.shareChangePct;
  if (!finite(change)) return missing("share count 1 year ago");
  const [fair, strong] = CUTOFFS.shareChangePct;
  return result(
    tierDown(change, fair, strong),
    `Shares ${signed(change)}% in about 1 year (${change <= strong ? "buyback or flat" : "dilution"}).`
  );
};

const price: Scorer = (_facts, derived) => {
  const { evSales, priceBook } = derived;
  if (!(finite(evSales) || finite(priceBook)))
    return missing("revenue and positive book value");
  const below = (value: number | null, cutoff: number): boolean =>
    finite(value) && value <= cutoff;
  const cheap =
    below(evSales, CUTOFFS.evSales[1]) ||
    below(priceBook, CUTOFFS.priceBook[1]);
  const fair =
    below(evSales, CUTOFFS.evSales[0]) ||
    below(priceBook, CUTOFFS.priceBook[0]);
  return result(
    cheap ? 2 : fair ? 1 : 0,
    `EV ÷ sales ${finite(evSales) ? evSales.toFixed(2) : "n/a"}, price ÷ book ${finite(priceBook) ? priceBook.toFixed(2) : "n/a"}.`
  );
};

const SCORERS: Readonly<Record<CriterionId, Scorer>> = {
  alignment,
  entry,
  longevity,
  price,
  risk,
  substance,
  timeHorizon,
  upside,
};

export type CriteriaResults = Record<CriterionId, CriterionResult>;

export const scoreCriteria = (
  facts: DeepValueFacts,
  derived: DerivedMetrics = derive(facts)
): CriteriaResults => {
  const out = {} as CriteriaResults;
  for (const criterion of CRITERIA)
    out[criterion.id] = SCORERS[criterion.id](facts, derived);
  return out;
};

export const riskFlags = (
  facts: DeepValueFacts,
  derived: DerivedMetrics = derive(facts)
): Flag[] => {
  const F = FLAG_CUTOFFS;
  const flags: Flag[] = [];
  const add = (id: string, label: string): void => {
    flags.push({ id, label });
  };
  if (finite(facts.price) && facts.price < F.penny)
    add("penny", `Penny stock (price < $${F.penny})`);
  else if (finite(facts.price) && facts.price < F.lowPrice)
    add("low-price", `Low price (< $${F.lowPrice})`);
  const { dollarVolume, shareChangePct, runwayMonths } = derived;
  if (finite(dollarVolume) && dollarVolume < F.illiquidDollarVolume)
    add("illiquid", `Very low liquidity (${money(dollarVolume)}/day traded)`);
  if (finite(shareChangePct) && shareChangePct > F.dilutionPct)
    add("dilution", `Dilution risk (shares +${r1(shareChangePct)}% in 1 year)`);
  if (finite(runwayMonths) && runwayMonths < F.shortRunwayMonths)
    add(
      "short-runway",
      `Short cash runway (~${Math.round(runwayMonths)} months)`
    );
  if (finite(facts.equity) && facts.equity <= 0)
    add("negative-equity", "Negative stockholders equity");
  if (facts.nonUsdFiler)
    add(
      "non-usd",
      "Reports mainly in a non-USD currency: fundamentals not scored"
    );
  if (facts.debtTagMissing)
    add("debt-unknown", "Debt not tagged in SEC data (counted as $0)");
  if (!facts.cik)
    add(
      "no-sec-data",
      "No SEC financial data (foreign filer, fund or new listing)"
    );
  return flags;
};

export type ScoredTicker = Readonly<{
  symbol: string | undefined;
  name: string | null;
  industry: string | null;
  roles: string[];
  price: number | null;
  marketCap: number | null;
  metrics: Omit<DerivedMetrics, "runwayMonths"> &
    Readonly<{ runwayMonths: number | null; cashFlowPositive: boolean }>;
  criteria: CriteriaResults;
  total: number;
  coverage: number;
  normalized: number | null;
  reasons: string[];
  flags: Flag[];
  asOf: string | null;
}>;

/** Score one ticker. Returns total (0–16), per-criterion score+evidence, flags and pass reasons. */
export const scoreTicker = (facts: DeepValueFacts): ScoredTicker => {
  const derived = derive(facts);
  const criteria = scoreCriteria(facts, derived);
  const scores = Object.values(criteria)
    .map((criterion) => criterion.score)
    .filter((score): score is number => score !== null);
  const total = scores.reduce((a, b) => a + b, 0);
  const coverage = scores.length;
  const cashFlowPositive = derived.runwayMonths === Number.POSITIVE_INFINITY;
  return {
    asOf: facts.asOf ?? null,
    coverage,
    criteria,
    flags: riskFlags(facts, derived),
    industry: facts.industry ?? null,
    marketCap: derived.marketCap,
    // JSON-safe: no Infinity.
    metrics: {
      ...derived,
      cashFlowPositive,
      runwayMonths: cashFlowPositive ? null : derived.runwayMonths,
    },
    name: facts.name ?? null,
    // Normalized to 16 so a name with missing data is not ranked as if the missing criteria scored 0.
    normalized: coverage
      ? Math.round((total / (coverage * 2)) * 160) / 10
      : null,
    price: facts.price ?? null,
    reasons: CRITERIA.filter(
      (criterion) => criteria[criterion.id].score === 2
    ).map(
      (criterion) => `${criterion.label}: ${criteria[criterion.id].evidence}`
    ),
    roles: facts.roles ?? [],
    symbol: facts.symbol,
    total,
  };
};

export type UniverseCandidate = Readonly<{
  price: number;
  marketCap: Maybe<number>;
  volume: number;
}>;

/** Optional starting universe for the owner's goal (deep value, low price, little coverage). Cutoffs are ours. */
export const inUniverse = (
  row: UniverseCandidate,
  cutoffs: Readonly<
    Record<keyof typeof UNIVERSE_CUTOFFS, number>
  > = UNIVERSE_CUTOFFS
): boolean =>
  finite(row.price) &&
  row.price > 0 &&
  row.price <= cutoffs.maxPrice &&
  finite(row.marketCap) &&
  row.marketCap >= cutoffs.minMarketCap &&
  row.marketCap <= cutoffs.maxMarketCap &&
  finite(row.price * row.volume) &&
  row.price * row.volume >= cutoffs.minDollarVolume;

type Rankable = Readonly<{
  symbol: string;
  total: number;
  coverage: number;
  normalized: number | null;
  flags: readonly unknown[];
}>;

/** Rank: full-data names first (coverage ≥ 6), then by total, then fewer flags. */
export const rank = <T extends Rankable>(
  rows: readonly T[]
): (T & Readonly<{ rank: number }>)[] =>
  [...rows]
    .sort(
      (a, b) =>
        Number(b.coverage >= 6) - Number(a.coverage >= 6) ||
        b.total - a.total ||
        Number(b.normalized) - Number(a.normalized) ||
        a.flags.length - b.flags.length ||
        a.symbol.localeCompare(b.symbol)
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));

export type PeerMedian = Readonly<{ evSales: number; n: number }>;

/** Industry median EV ÷ sales from gathered facts (industries with ≥ 5 names). Pure. */
export const industryMedians = (
  factsList: readonly DeepValueFacts[],
  minCount = 5
): Record<string, PeerMedian> => {
  const groups = new Map<string, number[]>();
  for (const facts of factsList) {
    const { evSales } = derive(facts);
    if (!(facts.industry && finite(evSales)) || evSales <= 0) continue;
    groups.set(facts.industry, [
      ...(groups.get(facts.industry) ?? []),
      evSales,
    ]);
  }
  const out: Record<string, PeerMedian> = {};
  for (const [industry, values] of groups) {
    if (values.length < minCount) continue;
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const at = (i: number): number => values[i] as number;
    out[industry] = {
      evSales:
        values.length % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2,
      n: values.length,
    };
  }
  return out;
};

/** Attach the peer median for the ticker's industry (if known). */
export const withPeers = <T extends DeepValueFacts>(
  facts: T,
  medians: Readonly<Record<string, PeerMedian>> = {}
): T => {
  const peer = facts.industry ? medians[facts.industry] : undefined;
  return peer
    ? { ...facts, peerCount: peer.n, peerEvSales: peer.evSales }
    : facts;
};
