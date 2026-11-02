import type {
  DeepValueCriterion,
  DeepValueCriterionId,
  DeepValueCriterionResult,
  DeepValueFlag,
  DeepValuePeerMedian,
  DeepValueRow,
} from "./contracts/research-lenses.ts";

// TRUE SLAP scorecard (method from IG reel Dew5OAejyOH, @willbchou; the creator's claims are unverified).
// Port of vertex-research packages/reporting/deep-value.mjs (ffa345d). The reel names 8 criteria and gives
// NO numbers: every proxy and cutoff below is OURS, not the reel's. Pure functions only; no network, no orders.

export const DEEP_VALUE_CRITERIA: readonly DeepValueCriterion[] = [
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
];

// Our cutoffs (not the reel's). [low, high] pairs: the first bound earns 1 point, the second 2 points.
const DEEP_VALUE_CUTOFFS = {
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

const DEEP_VALUE_FLAG_CUTOFFS = {
  dilutionPct: 20,
  illiquidDollarVolume: 500e3,
  lowPrice: 5,
  penny: 1,
  shortRunwayMonths: 12,
} as const;

/** Raw facts for one ticker, from Yahoo daily bars and SEC XBRL companyfacts. All optional. */
export interface DeepValueFacts {
  asOf?: string | null;
  avgVolume?: number | null;
  cash?: number;
  cik?: number;
  debtTagMissing?: boolean;
  equity?: number;
  firstYear?: number;
  high52?: number;
  industry?: string | null;
  low52?: number;
  marketCap?: number;
  name?: string | null;
  nonUsdFiler?: boolean;
  operatingCashFlow?: number;
  peerCount?: number;
  peerEvSales?: number;
  price?: number;
  priceAdjusted?: number;
  revenue?: number;
  revenuePrior?: number;
  revenueYear?: string;
  roles?: string[];
  sharesOutstanding?: number;
  sharesYearAgo?: number;
  sma50?: number | null;
  symbol: string;
  totalDebt?: number;
  yearsReporting?: number;
}

export interface DeepValueMetrics {
  debtToEquity: number | null;
  dollarVolume: number | null;
  enterpriseValue: number | null;
  evSales: number | null;
  marketCap: number | null;
  peerUpsidePct: number | null;
  priceBook: number | null;
  rangePct: number | null;
  revenueGrowthPct: number | null;
  // Infinity means operating cash flow is positive (no runway limit).
  runwayMonths: number | null;
  shareChangePct: number | null;
  upsideToHighPct: number | null;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number =>
  finite(value) && value > 0;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const signed = (value: number): string =>
  `${value >= 0 ? "+" : ""}${round1(value)}`;

export const formatUsd = (value: number): string => {
  const size = Math.abs(value);
  if (size >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (size >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
};

/** 2 when `value` reaches `bounds[1]`, 1 when it reaches `bounds[0]`, else 0. `higher` = larger is better. */
const tier = (
  value: number,
  bounds: readonly [number, number],
  higher: boolean
): number => {
  const reaches = (bound: number) => (higher ? value >= bound : value <= bound);
  if (reaches(bounds[1])) return 2;
  return reaches(bounds[0]) ? 1 : 0;
};

const result = (
  score: number | null,
  evidence: string
): DeepValueCriterionResult => ({ evidence, score });
const missing = (what: string): DeepValueCriterionResult =>
  result(null, `No data: ${what}`);

// Months of cash at the current burn; Infinity when operating cash flow is positive.
const runwayOf = (f: DeepValueFacts): number | null => {
  if (!finite(f.operatingCashFlow)) return null;
  if (f.operatingCashFlow >= 0) return Number.POSITIVE_INFINITY;
  return finite(f.cash) ? (f.cash / -f.operatingCashFlow) * 12 : null;
};

// Position of `px` inside the 52-week range, in percent.
const rangeOf = (f: DeepValueFacts, px: number | undefined): number | null =>
  finite(px) && finite(f.high52) && finite(f.low52) && f.high52 > f.low52
    ? ((px - f.low52) / (f.high52 - f.low52)) * 100
    : null;

// Equity value at the industry median EV/sales, per share, vs price.
const peerUpsideOf = (
  f: DeepValueFacts,
  debt: number,
  cash: number
): number | null => {
  const { peerEvSales, revenue, sharesOutstanding: shares, price } = f;
  if (
    !(
      finite(peerEvSales) &&
      positive(revenue) &&
      positive(shares) &&
      positive(price)
    )
  )
    return null;
  return ((peerEvSales * revenue - debt + cash) / shares / price - 1) * 100;
};

const ratio = (
  numerator: number | null | undefined,
  denominator: number | null | undefined
): number | null =>
  finite(numerator) && positive(denominator) ? numerator / denominator : null;

const changePct = (
  current: number | undefined,
  before: number | undefined
): number | null => {
  const value = ratio(current, before);
  return value === null ? null : (value - 1) * 100;
};

/** Derived metrics from raw facts. */
export const deriveDeepValueMetrics = (f: DeepValueFacts): DeepValueMetrics => {
  const price = f.price;
  let marketCap: number | null = null;
  if (finite(price) && finite(f.sharesOutstanding))
    marketCap = price * f.sharesOutstanding;
  else if (finite(f.marketCap)) marketCap = f.marketCap;
  const debt = finite(f.totalDebt) ? f.totalDebt : 0;
  const cash = finite(f.cash) ? f.cash : 0;
  const enterpriseValue = marketCap === null ? null : marketCap + debt - cash;
  // Same basis as the adjusted 52-week range.
  const px = finite(f.priceAdjusted) ? f.priceAdjusted : price;
  const equity = positive(f.equity) ? f.equity : null;
  return {
    debtToEquity: ratio(debt, equity),
    dollarVolume:
      finite(price) && finite(f.avgVolume) ? price * f.avgVolume : null,
    enterpriseValue,
    evSales: ratio(enterpriseValue, f.revenue),
    marketCap,
    peerUpsidePct: peerUpsideOf(f, debt, cash),
    priceBook: ratio(marketCap, equity),
    rangePct: rangeOf(f, px),
    revenueGrowthPct: changePct(f.revenue, f.revenuePrior),
    runwayMonths: runwayOf(f),
    shareChangePct: changePct(f.sharesOutstanding, f.sharesYearAgo),
    upsideToHighPct: changePct(f.high52, positive(px) ? px : undefined),
  };
};

const scoreTimeHorizon = (
  f: DeepValueFacts,
  d: DeepValueMetrics
): DeepValueCriterionResult => {
  if (d.runwayMonths === null) return missing("operating cash flow or cash");
  if (d.runwayMonths === Number.POSITIVE_INFINITY)
    return result(
      2,
      `Operating cash flow is positive (${formatUsd(f.operatingCashFlow as number)}/yr); no runway limit.`
    );
  return result(
    tier(d.runwayMonths, DEEP_VALUE_CUTOFFS.runwayMonths, true),
    `About ${Math.round(d.runwayMonths)} months of cash (${formatUsd(f.cash as number)}) at ${formatUsd(-(f.operatingCashFlow as number))}/yr burn.`
  );
};

const scoreRisk = (
  f: DeepValueFacts,
  d: DeepValueMetrics
): DeepValueCriterionResult => {
  if (finite(f.equity) && f.equity <= 0)
    return result(
      0,
      `Stockholders equity is negative (${formatUsd(f.equity)}).`
    );
  if (d.debtToEquity === null) return missing("stockholders equity");
  const debt = f.debtTagMissing
    ? "not tagged in SEC data, counted as $0; check the 10-K"
    : formatUsd(f.totalDebt ?? 0);
  return result(
    tier(d.debtToEquity, DEEP_VALUE_CUTOFFS.debtToEquity, false),
    `Debt ÷ equity ${d.debtToEquity.toFixed(2)} (debt ${debt}, equity ${formatUsd(f.equity as number)}).`
  );
};

const scoreUpside = (
  f: DeepValueFacts,
  d: DeepValueMetrics
): DeepValueCriterionResult => {
  // Peer valuation when the industry median is known; else 52-week-high headroom (overlaps with Entry).
  if (d.peerUpsidePct !== null)
    return result(
      tier(d.peerUpsidePct, DEEP_VALUE_CUTOFFS.upsideToHighPct, true),
      `${signed(d.peerUpsidePct)}% to the price implied by the industry median EV ÷ sales ${(f.peerEvSales as number).toFixed(2)} (n=${f.peerCount ?? "?"}).`
    );
  if (d.upsideToHighPct === null)
    return missing("peer valuation and 52-week high");
  return result(
    tier(d.upsideToHighPct, DEEP_VALUE_CUTOFFS.upsideToHighPct, true),
    `Fallback (no peer median): ${round1(d.upsideToHighPct)}% back to the adjusted 52-week high $${(f.high52 as number).toFixed(2)}.`
  );
};

const scoreEntry = (
  f: DeepValueFacts,
  d: DeepValueMetrics
): DeepValueCriterionResult => {
  if (d.rangePct === null) return missing("52-week range");
  const low = d.rangePct <= DEEP_VALUE_CUTOFFS.rangeLowerPct;
  const sma = finite(f.sma50) ? f.sma50 : null;
  const px = (finite(f.priceAdjusted) ? f.priceAdjusted : f.price) as number;
  const above = sma !== null && px >= sma;
  const average =
    sma === null
      ? ""
      : `, ${above ? "above" : "below"} the 50-day average $${sma.toFixed(2)}`;
  return result(
    (low ? 1 : 0) + (above ? 1 : 0),
    `At ${Math.round(d.rangePct)}% of the 52-week range${average}.`
  );
};

const scoreSubstance = (
  f: DeepValueFacts,
  d: DeepValueMetrics
): DeepValueCriterionResult => {
  if (!finite(f.revenue)) return missing("annual revenue");
  const grow = d.revenueGrowthPct;
  let score = f.revenue > 0 ? 1 : 0;
  if (
    f.revenue >= DEEP_VALUE_CUTOFFS.revenueUsd &&
    (grow === null || grow >= 0)
  )
    score = 2;
  const growth = grow === null ? "" : `, ${signed(grow)}% vs prior year`;
  return result(
    score,
    `Revenue ${formatUsd(f.revenue)} (FY ${f.revenueYear ?? "?"})${growth}.`
  );
};

const scoreLongevity = (f: DeepValueFacts): DeepValueCriterionResult => {
  if (!finite(f.yearsReporting)) return missing("SEC reporting history");
  return result(
    tier(f.yearsReporting, DEEP_VALUE_CUTOFFS.yearsReporting, true),
    `${f.yearsReporting} years of SEC financial data (since ${f.firstYear ?? "?"}).`
  );
};

const scoreAlignment = (d: DeepValueMetrics): DeepValueCriterionResult => {
  if (d.shareChangePct === null) return missing("share count 1 year ago");
  const flat = d.shareChangePct <= DEEP_VALUE_CUTOFFS.shareChangePct[1];
  return result(
    tier(d.shareChangePct, DEEP_VALUE_CUTOFFS.shareChangePct, false),
    `Shares ${signed(d.shareChangePct)}% in about 1 year (${flat ? "buyback or flat" : "dilution"}).`
  );
};

const scorePrice = (d: DeepValueMetrics): DeepValueCriterionResult => {
  if (d.evSales === null && d.priceBook === null)
    return missing("revenue and positive book value");
  const within = (index: 0 | 1) =>
    (d.evSales !== null && d.evSales <= DEEP_VALUE_CUTOFFS.evSales[index]) ||
    (d.priceBook !== null &&
      d.priceBook <= DEEP_VALUE_CUTOFFS.priceBook[index]);
  let score = within(0) ? 1 : 0;
  if (within(1)) score = 2;
  const fmt = (value: number | null) =>
    value === null ? "n/a" : value.toFixed(2);
  return result(
    score,
    `EV ÷ sales ${fmt(d.evSales)}, price ÷ book ${fmt(d.priceBook)}.`
  );
};

export const scoreDeepValueCriteria = (
  f: DeepValueFacts,
  d: DeepValueMetrics = deriveDeepValueMetrics(f)
): Record<DeepValueCriterionId, DeepValueCriterionResult> => ({
  alignment: scoreAlignment(d),
  entry: scoreEntry(f, d),
  longevity: scoreLongevity(f),
  price: scorePrice(d),
  risk: scoreRisk(f, d),
  substance: scoreSubstance(f, d),
  timeHorizon: scoreTimeHorizon(f, d),
  upside: scoreUpside(f, d),
});

export const deepValueRiskFlags = (
  f: DeepValueFacts,
  d: DeepValueMetrics = deriveDeepValueMetrics(f)
): DeepValueFlag[] => {
  const cut = DEEP_VALUE_FLAG_CUTOFFS;
  const flags: DeepValueFlag[] = [];
  if (finite(f.price) && f.price < cut.penny)
    flags.push({ id: "penny", label: `Penny stock (price < $${cut.penny})` });
  else if (finite(f.price) && f.price < cut.lowPrice)
    flags.push({ id: "low-price", label: `Low price (< $${cut.lowPrice})` });
  if (d.dollarVolume !== null && d.dollarVolume < cut.illiquidDollarVolume)
    flags.push({
      id: "illiquid",
      label: `Very low liquidity (${formatUsd(d.dollarVolume)}/day traded)`,
    });
  if (d.shareChangePct !== null && d.shareChangePct > cut.dilutionPct)
    flags.push({
      id: "dilution",
      label: `Dilution risk (shares +${round1(d.shareChangePct)}% in 1 year)`,
    });
  if (finite(d.runwayMonths) && d.runwayMonths < cut.shortRunwayMonths)
    flags.push({
      id: "short-runway",
      label: `Short cash runway (~${Math.round(d.runwayMonths)} months)`,
    });
  if (finite(f.equity) && f.equity <= 0)
    flags.push({
      id: "negative-equity",
      label: "Negative stockholders equity",
    });
  if (f.nonUsdFiler)
    flags.push({
      id: "non-usd",
      label: "Reports mainly in a non-USD currency: fundamentals not scored",
    });
  if (f.debtTagMissing)
    flags.push({
      id: "debt-unknown",
      label: "Debt not tagged in SEC data (counted as $0)",
    });
  if (f.cik === undefined)
    flags.push({
      id: "no-sec-data",
      label: "No SEC financial data (foreign filer, fund or new listing)",
    });
  return flags;
};

/** Attach the peer median for the ticker's industry (if known). */
export const withDeepValuePeers = (
  facts: DeepValueFacts,
  medians: Readonly<Record<string, DeepValuePeerMedian>> = {}
): DeepValueFacts => {
  const median =
    typeof facts.industry === "string" ? medians[facts.industry] : undefined;
  return median === undefined
    ? facts
    : { ...facts, peerCount: median.n, peerEvSales: median.evSales };
};

/** Score one ticker: total (0-16), per-criterion score and evidence, flags and pass reasons. */
export const scoreDeepValueTicker = (
  facts: DeepValueFacts
): Omit<DeepValueRow, "rank" | "errors"> => {
  const d = deriveDeepValueMetrics(facts);
  const criteria = scoreDeepValueCriteria(facts, d);
  const scores = Object.values(criteria).flatMap((entry) =>
    entry.score === null ? [] : [entry.score]
  );
  const total = scores.reduce((sum, score) => sum + score, 0);
  const coverage = scores.length;
  const cashFlowPositive = d.runwayMonths === Number.POSITIVE_INFINITY;
  return {
    asOf: facts.asOf ?? null,
    coverage,
    criteria,
    flags: deepValueRiskFlags(facts, d),
    industry: facts.industry ?? null,
    marketCap: d.marketCap,
    metrics: {
      ...d,
      cashFlowPositive,
      runwayMonths: cashFlowPositive ? null : d.runwayMonths,
    },
    name: facts.name ?? null,
    // Normalized to 16 so a name with missing data is not ranked as if the missing criteria scored 0.
    normalized:
      coverage === 0 ? null : Math.round((total / (coverage * 2)) * 160) / 10,
    price: finite(facts.price) ? facts.price : null,
    reasons: DEEP_VALUE_CRITERIA.filter(
      (criterion) => criteria[criterion.id].score === 2
    ).map(
      (criterion) => `${criterion.label}: ${criteria[criterion.id].evidence}`
    ),
    roles: facts.roles ?? [],
    symbol: facts.symbol,
    total,
  };
};
