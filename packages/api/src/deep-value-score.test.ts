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
  asOf: "2026-10-21",
  avgVolume: 500_000,
  cash: 30e6,
  cik: 1,
  equity: 100e6,
  firstYear: 2011,
  high52: 12,
  industry: "Metal Fabrications",
  low52: 6,
  name: "Alpha Industries",
  operatingCashFlow: 5e6,
  peerCount: 12,
  peerEvSales: 1,
  price: 8,
  priceAdjusted: 8,
  revenue: 200e6,
  revenuePrior: 180e6,
  revenueYear: "2025",
  roles: ["wish"],
  sharesOutstanding: 10e6,
  sharesYearAgo: 10e6,
  sma50: 7.5,
  symbol: "AAA",
  totalDebt: 10e6,
  yearsReporting: 15,
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
      debtToEquity: 0.1,
      dollarVolume: 4e6,
      enterpriseValue: 60e6,
      evSales: 0.3,
      marketCap: 80e6,
      priceBook: 0.8,
      runwayMonths: Number.POSITIVE_INFINITY,
      shareChangePct: 0,
    });
    expect(metrics.revenueGrowthPct).toBeCloseTo(11.111, 3);
    expect(metrics.rangePct).toBeCloseTo(33.333, 3);
    expect(metrics.upsideToHighPct).toBeCloseTo(50, 6);
    // (1 x 200M - 10M + 30M) / 10M shares = 22 per share vs 8.
    return expect(metrics.peerUpsidePct).toBeCloseTo(175, 6);
  });

  it("falls back to a stored market cap and leaves unknown metrics null", () => {
    const metrics = deriveDeepValueMetrics({ marketCap: 5e6, symbol: "BBB" });
    expect(metrics.marketCap).toBe(5e6);
    expect(metrics.enterpriseValue).toBe(5e6);
    expect(deriveDeepValueMetrics({ symbol: "CCC" })).toEqual({
      debtToEquity: null,
      dollarVolume: null,
      enterpriseValue: null,
      evSales: null,
      marketCap: null,
      peerUpsidePct: null,
      priceBook: null,
      rangePct: null,
      revenueGrowthPct: null,
      runwayMonths: null,
      shareChangePct: null,
      upsideToHighPct: null,
    });
    return expect(
      deriveDeepValueMetrics({
        high52: 5,
        low52: 5,
        operatingCashFlow: -1e6,
        price: 5,
        symbol: "DDD",
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
      alignment: 2,
      entry: 2,
      longevity: 2,
      price: 2,
      risk: 2,
      substance: 2,
      timeHorizon: 2,
      upside: 2,
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
      cash: 30e6,
      equity: 60e6,
      high52: 14,
      low52: 2,
      operatingCashFlow: -20e6,
      price: 10,
      priceAdjusted: 10,
      revenue: 5e6,
      revenuePrior: 4e6,
      sharesYearAgo: 9.5e6,
      sma50: 9,
      totalDebt: 60e6,
      yearsReporting: 6,
    };
    const result = scoreDeepValueCriteria(noPeer);
    expect(scores(noPeer)).toEqual({
      alignment: 1,
      entry: 1,
      longevity: 1,
      price: 1,
      risk: 1,
      substance: 1,
      timeHorizon: 1,
      upside: 1,
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
      cash: 1e6,
      cik: 2,
      equity: 10e6,
      high52: 21,
      low52: 10,
      operatingCashFlow: -12e6,
      peerEvSales: 0.1,
      price: 20,
      revenue: 0,
      sharesOutstanding: 10e6,
      sharesYearAgo: 5e6,
      sma50: 20.5,
      symbol: "WWW",
      totalDebt: 50e6,
      yearsReporting: 2,
    };
    const result = scoreDeepValueCriteria(facts);
    expect(scores(facts)).toEqual({
      alignment: 0,
      entry: 0,
      longevity: 0,
      price: 0,
      risk: 0,
      substance: 0,
      timeHorizon: 0,
      upside: 0,
    });
    expect(result.upside.evidence).toBe(
      "Fallback (no peer median): 5% back to the adjusted 52-week high $21.00."
    );
    expect(result.entry.evidence).toBe(
      "At 91% of the 52-week range, below the 50-day average $20.50."
    );
    expect(result.substance.evidence).toBe("Revenue $0 (FY ?).");
    return expect(result.price.evidence).toBe(
      "EV ÷ sales not computed (no market cap or positive revenue reported), price ÷ book 20.00."
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
      scoreDeepValueCriteria({ equity: -5e6, symbol: "NEG" }).risk
    ).toEqual({
      evidence: "Stockholders equity is negative ($-5.0M).",
      score: 0,
    });
    expect(
      scoreDeepValueCriteria({
        debtTagMissing: true,
        equity: 5e6,
        symbol: "UNT",
      }).risk.evidence
    ).toBe(
      "Debt ÷ equity 0.00 (debt not tagged in SEC data, counted as $0; check the 10-K, equity $5.0M)."
    );
    expect(
      scoreDeepValueCriteria({ equity: 5e6, symbol: "ZER" }).risk.evidence
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
      evidence: "At 17% of the 52-week range.",
      score: 1,
    });
    const { priceAdjusted: _adjusted, ...raw } = strong;
    expect(scoreDeepValueCriteria(raw).entry.score).toBe(2);
    expect(
      scoreDeepValueCriteria({
        price: 10,
        revenue: 5e6,
        sharesOutstanding: 1e6,
        symbol: "EVS",
      }).price
    ).toEqual({
      evidence:
        "EV ÷ sales 2.00, price ÷ book not computed (no market cap or positive book value reported).",
      score: 1,
    });
    return expect(
      scoreDeepValueCriteria({ ...strong, revenue: 50e6, revenuePrior: 60e6 })
        .substance.score
    ).toBe(1);
  });
});

describe("risk flags", () => {
  it("flags penny, illiquid, dilution, short runway, negative equity, currency, debt and SEC gaps", () => {
    const flags = deepValueRiskFlags({
      avgVolume: 100_000,
      cash: 1e6,
      debtTagMissing: true,
      equity: -1,
      nonUsdFiler: true,
      operatingCashFlow: -4e6,
      price: 0.5,
      sharesOutstanding: 13e6,
      sharesYearAgo: 10e6,
      symbol: "PNY",
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
      asOf: "2026-10-21",
      coverage: 8,
      flags: [],
      industry: "Metal Fabrications",
      marketCap: 80e6,
      name: "Alpha Industries",
      normalized: 16,
      price: 8,
      roles: ["wish"],
      symbol: "AAA",
      total: 16,
    });
    expect(row.metrics).toMatchObject({
      cashFlowPositive: true,
      runwayMonths: null,
    });
    expect(row.reasons).toHaveLength(8);
    return expect(row.reasons[0]).toBe(
      "Time horizon: Operating cash flow is positive ($5.0M/yr); no runway limit."
    );
  });

  it("keeps a finite runway and normalizes partial coverage", () => {
    const row = scoreDeepValueTicker({
      cash: 10e6,
      operatingCashFlow: -5e6,
      symbol: "PRT",
    });
    expect(row.metrics).toMatchObject({
      cashFlowPositive: false,
      runwayMonths: 24,
    });
    return expect([row.total, row.coverage, row.normalized]).toEqual([
      2, 1, 16,
    ]);
  });

  it("returns nulls for an empty fact set", () => {
    return expect(scoreDeepValueTicker({ symbol: "EMP" })).toMatchObject({
      asOf: null,
      coverage: 0,
      industry: null,
      marketCap: null,
      name: null,
      normalized: null,
      price: null,
      reasons: [],
      roles: [],
      total: 0,
    });
  });

  it("attaches the industry peer median only when it is known", () => {
    const medians = { "Metal Fabrications": { evSales: 1.5, n: 7 } };
    expect(withDeepValuePeers(strong, medians)).toMatchObject({
      peerCount: 7,
      peerEvSales: 1.5,
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
