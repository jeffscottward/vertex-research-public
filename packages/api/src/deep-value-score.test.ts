import { describe, expect, it } from "vitest";

import {
  DEEP_VALUE_CRITERIA,
  type DeepValueFacts,
  deepValueRiskFlags,
  deriveDeepValueMetrics,
  formatUsd,
  scoreDeepValueCriteria,
  scoreDeepValueTicker,
  withDeepValuePeers,
} from "./deep-value-score.ts";

// Synthetic facts only. Expected scores follow the cutoffs in deep-value-score.ts (ours, not the reel's).

const strong: DeepValueFacts = {
  symbol: "AAA",
  name: "Alpha Industries",
  industry: "Metal Fabrications",
  roles: ["wish"],
  asOf: "2026-10-21",
  cik: 1,
  price: 8,
  priceAdjusted: 8,
  high52: 12,
  low52: 6,
  sma50: 7.5,
  avgVolume: 500_000,
  sharesOutstanding: 10e6,
  sharesYearAgo: 10e6,
  cash: 30e6,
  equity: 100e6,
  totalDebt: 10e6,
  operatingCashFlow: 5e6,
  revenue: 200e6,
  revenuePrior: 180e6,
  revenueYear: "2025",
  yearsReporting: 15,
  firstYear: 2011,
  peerEvSales: 1,
  peerCount: 12,
};

const scores = (facts: DeepValueFacts) =>
  Object.fromEntries(
    Object.entries(scoreDeepValueCriteria(facts)).map(([id, entry]) => [
      id,
      entry.score,
    ])
  );

describe("deep value metrics", () => {
  it("derives market cap, EV, ratios, runway, range and peer upside", () => {
    const metrics = deriveDeepValueMetrics(strong);
    expect(metrics).toMatchObject({
      marketCap: 80e6,
      enterpriseValue: 60e6,
      evSales: 0.3,
      priceBook: 0.8,
      debtToEquity: 0.1,
      runwayMonths: Number.POSITIVE_INFINITY,
      shareChangePct: 0,
      dollarVolume: 4e6,
    });
    expect(metrics.revenueGrowthPct).toBeCloseTo(11.111, 3);
    expect(metrics.rangePct).toBeCloseTo(33.333, 3);
    expect(metrics.upsideToHighPct).toBeCloseTo(50, 6);
    // (1 x 200M - 10M + 30M) / 10M shares = 22 per share vs 8.
    return expect(metrics.peerUpsidePct).toBeCloseTo(175, 6);
  });

  it("falls back to a stored market cap and leaves unknown metrics null", () => {
    const metrics = deriveDeepValueMetrics({ symbol: "BBB", marketCap: 5e6 });
    expect(metrics.marketCap).toBe(5e6);
    expect(metrics.enterpriseValue).toBe(5e6);
    expect(deriveDeepValueMetrics({ symbol: "CCC" })).toEqual({
      marketCap: null,
      enterpriseValue: null,
      evSales: null,
      priceBook: null,
      debtToEquity: null,
      runwayMonths: null,
      revenueGrowthPct: null,
      shareChangePct: null,
      rangePct: null,
      upsideToHighPct: null,
      peerUpsidePct: null,
      dollarVolume: null,
    });
    return expect(
      deriveDeepValueMetrics({
        symbol: "DDD",
        price: 5,
        high52: 5,
        low52: 5,
        operatingCashFlow: -1e6,
      })
    ).toMatchObject({ rangePct: null, runwayMonths: null });
  });

  it("uses the adjusted price for the range and the raw price for peer upside", () => {
    const metrics = deriveDeepValueMetrics({
      ...strong,
      price: 9,
      priceAdjusted: 6,
    });
    expect(metrics.rangePct).toBe(0);
    expect(metrics.upsideToHighPct).toBe(100);
    return expect(metrics.peerUpsidePct).toBeCloseTo((22 / 9 - 1) * 100, 6);
  });

  return it("formats US dollar amounts", () => {
    expect(formatUsd(2.5e9)).toBe("$2.50B");
    expect(formatUsd(-12.34e6)).toBe("$-12.3M");
    return expect(formatUsd(45_678.4)).toBe("$45,678");
  });
});

describe("TRUE SLAP criteria", () => {
  it("scores a strong name 2 on every criterion", () => {
    const result = scoreDeepValueCriteria(strong);
    expect(scores(strong)).toEqual({
      timeHorizon: 2,
      risk: 2,
      upside: 2,
      entry: 2,
      substance: 2,
      longevity: 2,
      alignment: 2,
      price: 2,
    });
    expect(result.timeHorizon.evidence).toBe(
      "Operating cash flow is positive ($5.0M/yr); no runway limit."
    );
    expect(result.risk.evidence).toBe(
      "Debt ÷ equity 0.10 (debt $10.0M, equity $100.0M)."
    );
    expect(result.upside.evidence).toBe(
      "+175% to the price implied by the industry median EV ÷ sales 1.00 (n=12)."
    );
    expect(result.entry.evidence).toBe(
      "At 33% of the 52-week range, above the 50-day average $7.50."
    );
    expect(result.substance.evidence).toBe(
      "Revenue $200.0M (FY 2025), +11.1% vs prior year."
    );
    expect(result.longevity.evidence).toBe(
      "15 years of SEC financial data (since 2011)."
    );
    expect(result.alignment.evidence).toBe(
      "Shares +0% in about 1 year (buyback or flat)."
    );
    return expect(result.price.evidence).toBe(
      "EV ÷ sales 0.30, price ÷ book 0.80."
    );
  });

  it("scores middle tiers 1", () => {
    const { peerEvSales: _peer, peerCount: _count, ...base } = strong;
    const noPeer: DeepValueFacts = {
      ...base,
      operatingCashFlow: -20e6,
      cash: 30e6,
      totalDebt: 60e6,
      price: 10,
      priceAdjusted: 10,
      high52: 14,
      low52: 2,
      sma50: 9,
      revenue: 5e6,
      revenuePrior: 4e6,
      yearsReporting: 6,
      sharesYearAgo: 9.5e6,
      equity: 60e6,
    };
    const result = scoreDeepValueCriteria(noPeer);
    expect(scores(noPeer)).toEqual({
      timeHorizon: 1,
      risk: 1,
      upside: 1,
      entry: 1,
      substance: 1,
      longevity: 1,
      alignment: 1,
      price: 1,
    });
    expect(result.timeHorizon.evidence).toBe(
      "About 18 months of cash ($30.0M) at $20.0M/yr burn."
    );
    expect(result.upside.evidence).toBe(
      "Fallback (no peer median): 40% back to the adjusted 52-week high $14.00."
    );
    return expect(result.alignment.evidence).toBe(
      "Shares +5.3% in about 1 year (dilution)."
    );
  });

  it("scores weak names 0", () => {
    const facts: DeepValueFacts = {
      symbol: "WWW",
      cik: 2,
      price: 20,
      high52: 21,
      low52: 10,
      sma50: 20.5,
      sharesOutstanding: 10e6,
      sharesYearAgo: 5e6,
      cash: 1e6,
      equity: 10e6,
      totalDebt: 50e6,
      operatingCashFlow: -12e6,
      revenue: 0,
      yearsReporting: 2,
      peerEvSales: 0.1,
    };
    const result = scoreDeepValueCriteria(facts);
    expect(scores(facts)).toEqual({
      timeHorizon: 0,
      risk: 0,
      upside: 0,
      entry: 0,
      substance: 0,
      longevity: 0,
      alignment: 0,
      price: 0,
    });
    expect(result.upside.evidence).toBe(
      "Fallback (no peer median): 5% back to the adjusted 52-week high $21.00."
    );
    expect(result.entry.evidence).toBe(
      "At 91% of the 52-week range, below the 50-day average $20.50."
    );
    expect(result.substance.evidence).toBe("Revenue $0 (FY ?).");
    return expect(result.price.evidence).toBe(
      "EV ÷ sales n/a, price ÷ book 20.00."
    );
  });

  it("records missing data instead of a score", () => {
    const result = scoreDeepValueCriteria({ symbol: "NNN" });
    expect(Object.values(result).map((entry) => entry.score)).toEqual(
      new Array(8).fill(null)
    );
    return expect(
      DEEP_VALUE_CRITERIA.map((criterion) => result[criterion.id].evidence)
    ).toEqual([
      "No data: operating cash flow or cash",
      "No data: stockholders equity",
      "No data: peer valuation and 52-week high",
      "No data: 52-week range",
      "No data: annual revenue",
      "No data: SEC reporting history",
      "No data: share count 1 year ago",
      "No data: revenue and positive book value",
    ]);
  });

  return it("handles negative equity, untagged debt, unknown peers and history gaps", () => {
    expect(
      scoreDeepValueCriteria({ symbol: "NEG", equity: -5e6 }).risk
    ).toEqual({
      score: 0,
      evidence: "Stockholders equity is negative ($-5.0M).",
    });
    expect(
      scoreDeepValueCriteria({
        symbol: "UNT",
        equity: 5e6,
        debtTagMissing: true,
      }).risk.evidence
    ).toBe(
      "Debt ÷ equity 0.00 (debt not tagged in SEC data, counted as $0; check the 10-K, equity $5.0M)."
    );
    expect(
      scoreDeepValueCriteria({ symbol: "ZER", equity: 5e6 }).risk.evidence
    ).toBe("Debt ÷ equity 0.00 (debt $0, equity $5.0M).");
    const { peerCount: _count, ...unknownCount } = strong;
    expect(scoreDeepValueCriteria(unknownCount).upside.evidence).toContain(
      "(n=?)"
    );
    const { firstYear: _first, sma50: _sma, ...gaps } = strong;
    const result = scoreDeepValueCriteria({ ...gaps, priceAdjusted: 7 });
    expect(result.longevity.evidence).toBe(
      "15 years of SEC financial data (since ?)."
    );
    expect(result.entry).toEqual({
      score: 1,
      evidence: "At 17% of the 52-week range.",
    });
    const { priceAdjusted: _adjusted, ...raw } = strong;
    expect(scoreDeepValueCriteria(raw).entry.score).toBe(2);
    expect(
      scoreDeepValueCriteria({
        symbol: "EVS",
        price: 10,
        sharesOutstanding: 1e6,
        revenue: 5e6,
      }).price
    ).toEqual({ score: 1, evidence: "EV ÷ sales 2.00, price ÷ book n/a." });
    return expect(
      scoreDeepValueCriteria({ ...strong, revenue: 50e6, revenuePrior: 60e6 })
        .substance.score
    ).toBe(1);
  });
});

describe("risk flags", () => {
  it("flags penny, illiquid, dilution, short runway, negative equity, currency, debt and SEC gaps", () => {
    const flags = deepValueRiskFlags({
      symbol: "PNY",
      price: 0.5,
      avgVolume: 100_000,
      sharesOutstanding: 13e6,
      sharesYearAgo: 10e6,
      cash: 1e6,
      operatingCashFlow: -4e6,
      equity: -1,
      nonUsdFiler: true,
      debtTagMissing: true,
    });
    return expect(flags.map((flag) => [flag.id, flag.label])).toEqual([
      ["penny", "Penny stock (price < $1)"],
      ["illiquid", "Very low liquidity ($50,000/day traded)"],
      ["dilution", "Dilution risk (shares +30% in 1 year)"],
      ["short-runway", "Short cash runway (~3 months)"],
      ["negative-equity", "Negative stockholders equity"],
      [
        "non-usd",
        "Reports mainly in a non-USD currency: fundamentals not scored",
      ],
      ["debt-unknown", "Debt not tagged in SEC data (counted as $0)"],
      [
        "no-sec-data",
        "No SEC financial data (foreign filer, fund or new listing)",
      ],
    ]);
  });

  return it("flags a low price and nothing for a clean name", () => {
    expect(
      deepValueRiskFlags({ ...strong, price: 3 }).map((flag) => flag.id)
    ).toEqual(["low-price"]);
    return expect(deepValueRiskFlags(strong)).toEqual([]);
  });
});

describe("ticker score", () => {
  it("totals, normalizes and explains the scorecard", () => {
    const row = scoreDeepValueTicker(strong);
    expect(row).toMatchObject({
      symbol: "AAA",
      name: "Alpha Industries",
      industry: "Metal Fabrications",
      roles: ["wish"],
      price: 8,
      marketCap: 80e6,
      total: 16,
      coverage: 8,
      normalized: 16,
      flags: [],
      asOf: "2026-10-21",
    });
    expect(row.metrics).toMatchObject({
      runwayMonths: null,
      cashFlowPositive: true,
    });
    expect(row.reasons).toHaveLength(8);
    return expect(row.reasons[0]).toBe(
      "Time horizon: Operating cash flow is positive ($5.0M/yr); no runway limit."
    );
  });

  it("keeps a finite runway and normalizes partial coverage", () => {
    const row = scoreDeepValueTicker({
      symbol: "PRT",
      cash: 10e6,
      operatingCashFlow: -5e6,
    });
    expect(row.metrics).toMatchObject({
      runwayMonths: 24,
      cashFlowPositive: false,
    });
    return expect([row.total, row.coverage, row.normalized]).toEqual([
      2, 1, 16,
    ]);
  });

  it("returns nulls for an empty fact set", () => {
    return expect(scoreDeepValueTicker({ symbol: "EMP" })).toMatchObject({
      name: null,
      industry: null,
      roles: [],
      price: null,
      marketCap: null,
      total: 0,
      coverage: 0,
      normalized: null,
      reasons: [],
      asOf: null,
    });
  });

  it("attaches the industry peer median only when it is known", () => {
    const medians = { "Metal Fabrications": { evSales: 1.5, n: 7 } };
    expect(withDeepValuePeers(strong, medians)).toMatchObject({
      peerEvSales: 1.5,
      peerCount: 7,
    });
    const other = { ...strong, industry: "Other" };
    expect(withDeepValuePeers(other, medians)).toBe(other);
    const noIndustry: DeepValueFacts = { symbol: "NOI" };
    expect(withDeepValuePeers(noIndustry)).toBe(noIndustry);
    return expect(
      withDeepValuePeers({ ...noIndustry, industry: null }, medians)
    ).not.toHaveProperty("peerEvSales");
  });

  return it("lists the 8 criteria in TRUE then SLAP order", () => {
    return expect(
      DEEP_VALUE_CRITERIA.map(
        (criterion) => `${criterion.lens}:${criterion.id}`
      )
    ).toEqual([
      "TRUE:timeHorizon",
      "TRUE:risk",
      "TRUE:upside",
      "TRUE:entry",
      "SLAP:substance",
      "SLAP:longevity",
      "SLAP:alignment",
      "SLAP:price",
    ]);
  });
});
