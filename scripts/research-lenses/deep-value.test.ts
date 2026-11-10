import { describe, expect, it } from "vitest";
import {
  CRITERIA,
  type DeepValueFacts,
  derive,
  industryMedians,
  inUniverse,
  rank,
  riskFlags,
  scoreCriteria,
  scoreTicker,
  UNIVERSE_CUTOFFS,
  withPeers,
} from "./deep-value.ts";

const strong: DeepValueFacts = {
  avgVolume: 400e3,
  cash: 60e6,
  cik: 1,
  equity: 250e6,
  firstYear: 2010,
  high52: 9,
  low52: 3,
  operatingCashFlow: 15e6,
  price: 4,
  revenue: 300e6,
  revenuePrior: 280e6,
  revenueYear: 2025,
  sharesOutstanding: 50e6,
  sharesYearAgo: 52e6,
  sma50: 3.8,
  symbol: "GOOD",
  totalDebt: 20e6,
  yearsReporting: 15,
};

const criteriaOf = (facts: DeepValueFacts) =>
  scoreTicker({ ...strong, ...facts }).criteria;

describe("TRUE SLAP scorecard (ported from vertex-research)", () => {
  it("has 8 criteria in TRUE and SLAP lenses", () => {
    expect(CRITERIA).toHaveLength(8);
    expect(
      CRITERIA.filter((c) => c.lens === "TRUE").map((c) => c.label)
    ).toEqual(["Time horizon", "Risk", "Upside", "Entry"]);
    expect(
      CRITERIA.filter((c) => c.lens === "SLAP").map((c) => c.label)
    ).toEqual(["Substance", "Longevity", "Alignment", "Price"]);
  });

  it("scores a strong name 16/16 with evidence and reasons", () => {
    const r = scoreTicker(strong);
    expect(r.total).toBe(16);
    expect(r.coverage).toBe(8);
    expect(r.normalized).toBe(16);
    expect(r.reasons).toHaveLength(8);
    for (const c of Object.values(r.criteria))
      expect(c.evidence.length).toBeGreaterThan(10);
    expect(r.metrics.cashFlowPositive).toBe(true);
    expect(r.metrics.runwayMonths).toBeNull(); // JSON-safe (no Infinity)
    expect(r.flags.map((f) => f.id)).toEqual(["low-price"]);
    expect(r).toMatchObject({
      asOf: null,
      industry: null,
      marketCap: 200e6,
      name: null,
      price: 4,
      roles: [],
      symbol: "GOOD",
    });
    expect(Object.keys(r.criteria)).toEqual(CRITERIA.map((c) => c.id));
  });

  it("applies each criterion threshold", () => {
    expect(
      criteriaOf({ cash: 60e6, operatingCashFlow: -40e6 }).timeHorizon.score
    ).toBe(1); // 18 months
    expect(
      criteriaOf({ cash: 60e6, operatingCashFlow: -120e6 }).timeHorizon.score
    ).toBe(0); // 6 months
    expect(
      criteriaOf({ cash: 60e6, operatingCashFlow: -20e6 }).timeHorizon
    ).toEqual({
      evidence: "About 36 months of cash ($60.0M) at $20.0M/yr burn.",
      score: 2,
    });
    expect(criteriaOf({ totalDebt: 300e6 }).risk.score).toBe(1);
    expect(criteriaOf({ totalDebt: 600e6 }).risk.score).toBe(0);
    expect(criteriaOf({ equity: -5 }).risk.score).toBe(0);
    expect(criteriaOf({ high52: 5 }).upside.score).toBe(0);
    expect(criteriaOf({ high52: 6 }).upside.score).toBe(1);
    expect(criteriaOf({ sma50: 5 }).entry.score).toBe(1); // low in range, below 50-day
    expect(criteriaOf({ high52: 4.2 }).entry.score).toBe(1); // high in range, above 50-day
    expect(criteriaOf({ revenue: 5e6 }).substance.score).toBe(1);
    expect(criteriaOf({ revenuePrior: 400e6 }).substance.score).toBe(1); // shrinking
    expect(criteriaOf({ revenue: -1 }).substance.score).toBe(0);
    expect(criteriaOf({ yearsReporting: 6 }).longevity.score).toBe(1);
    expect(criteriaOf({ yearsReporting: 2 }).longevity.score).toBe(0);
    expect(criteriaOf({ sharesYearAgo: 47e6 }).alignment.score).toBe(1); // +6.4%
    expect(criteriaOf({ sharesYearAgo: 40e6 }).alignment.score).toBe(0); // +25%
    expect(
      criteriaOf({ high52: 60, low52: 20, price: 30, sma50: 29 }).price.score
    ).toBe(0); // EV/sales 4.9, P/B 6
    expect(criteriaOf({ price: 12 }).price.score).toBe(1); // EV/sales 1.9, P/B 2.4
  });

  it("writes evidence the way the vertex-research lens shows it", () => {
    const c = scoreCriteria(strong);
    expect(c.timeHorizon.evidence).toBe(
      "Operating cash flow is positive ($15.0M/yr); no runway limit."
    );
    expect(c.risk.evidence).toBe(
      "Debt ÷ equity 0.08 (debt $20.0M, equity $250.0M)."
    );
    expect(c.upside.evidence).toBe(
      "Fallback (no peer median): 125% back to the adjusted 52-week high $9.00."
    );
    expect(c.entry.evidence).toBe(
      "At 17% of the 52-week range, above the 50-day average $3.80."
    );
    expect(c.substance.evidence).toBe(
      "Revenue $300.0M (FY 2025), +7.1% vs prior year."
    );
    expect(c.longevity.evidence).toBe(
      "15 years of SEC financial data (since 2010)."
    );
    expect(c.alignment.evidence).toBe(
      "Shares -3.8% in about 1 year (buyback or flat)."
    );
    expect(c.price.evidence).toBe("EV ÷ sales 0.53, price ÷ book 0.80.");
    expect(criteriaOf({ equity: -2.5e9 }).risk.evidence).toBe(
      "Stockholders equity is negative ($-2.50B)."
    );
    expect(
      criteriaOf({ cash: 5000, operatingCashFlow: -60_000 }).timeHorizon
        .evidence
    ).toBe("About 1 months of cash ($5,000) at $60,000/yr burn.");
    expect(criteriaOf({ sharesYearAgo: 40e6 }).alignment.evidence).toBe(
      "Shares +25% in about 1 year (dilution)."
    );
    expect(
      criteriaOf({
        firstYear: undefined,
        revenuePrior: undefined,
        revenueYear: undefined,
      })
    ).toMatchObject({
      longevity: { evidence: "15 years of SEC financial data (since ?)." },
      substance: { evidence: "Revenue $300.0M (FY ?)." },
    });
    expect(criteriaOf({ totalDebt: undefined }).risk.evidence).toBe(
      "Debt ÷ equity 0.00 (debt $0, equity $250.0M)."
    );
    expect(criteriaOf({ totalDebt: Number.NaN }).risk.evidence).toBe(
      "Debt ÷ equity 0.00 (debt n/a, equity $250.0M)."
    );
    expect(
      criteriaOf({ debtTagMissing: true, totalDebt: undefined }).risk.evidence
    ).toBe(
      "Debt ÷ equity 0.00 (debt not tagged in SEC data, counted as $0; check the 10-K, equity $250.0M)."
    );
    expect(criteriaOf({ high52: 4.2, sma50: undefined }).entry).toEqual({
      evidence: "At 83% of the 52-week range.",
      score: 0,
    });
    expect(
      scoreCriteria({
        peerEvSales: 1,
        price: 2,
        revenue: 10e6,
        sharesOutstanding: 10e6,
      }).upside
    ).toEqual({
      evidence:
        "-50% to the price implied by the industry median EV ÷ sales 1.00 (n=?).",
      score: 0,
    });
    expect(criteriaOf({ equity: 0 }).price.evidence).toBe(
      "EV ÷ sales 0.53, price ÷ book n/a."
    );
    expect(criteriaOf({ revenue: null }).price).toEqual({
      evidence: "EV ÷ sales n/a, price ÷ book 0.80.",
      score: 2,
    });
  });

  it("entry uses the adjusted price and treats a missing price as below the average", () => {
    expect(criteriaOf({ priceAdjusted: 3.5 }).entry.evidence).toBe(
      "At 8% of the 52-week range, below the 50-day average $3.80."
    );
    expect(criteriaOf({ sma50: null }).entry).toEqual({
      evidence: "At 17% of the 52-week range.",
      score: 1,
    });
    expect(criteriaOf({ high52: 9, low52: 3, sma50: 4.5 }).entry.score).toBe(1);
    const noPrice = scoreCriteria({
      high52: 9,
      low52: 3,
      priceAdjusted: 4,
      sma50: -1,
    });
    expect(noPrice.entry.score).toBe(2);
    const nullPrice = scoreCriteria({
      high52: 9,
      low52: 3,
      price: null,
      sma50: 1,
    });
    expect(nullPrice.entry).toEqual({
      evidence: "No data: 52-week range",
      score: null,
    });
  });

  it("scores missing data as null, not zero, and normalizes for it", () => {
    const r = scoreTicker({ high52: 4, low52: 1.5, price: 2, symbol: "X" });
    expect(r.criteria.substance.score).toBeNull();
    expect(r.criteria.substance.evidence).toMatch(/^No data/);
    expect(r.coverage).toBe(2);
    expect(r.flags.some((f) => f.id === "no-sec-data")).toBe(true);
    const empty = scoreTicker({});
    expect(empty.coverage).toBe(0);
    expect(empty.normalized).toBeNull();
    expect(Object.values(empty.criteria).map((c) => c.evidence)).toEqual([
      "No data: operating cash flow or cash",
      "No data: stockholders equity",
      "No data: peer valuation and 52-week high",
      "No data: 52-week range",
      "No data: annual revenue",
      "No data: SEC reporting history",
      "No data: share count 1 year ago",
      "No data: revenue and positive book value",
    ]);
    expect(
      scoreCriteria({ operatingCashFlow: -1 }).timeHorizon.score
    ).toBeNull();
  });

  it("raises risk flags: penny, illiquid, dilution, short runway, negative equity", () => {
    const ids = riskFlags({
      avgVolume: 10e3,
      cash: 1,
      cik: 1,
      equity: -1,
      operatingCashFlow: -12,
      price: 0.5,
      sharesOutstanding: 130,
      sharesYearAgo: 100,
    }).map((f) => f.id);
    expect(ids).toEqual([
      "penny",
      "illiquid",
      "dilution",
      "short-runway",
      "negative-equity",
    ]);
    expect(riskFlags({ cik: "320193", price: 50 })).toEqual([]);
    expect(
      riskFlags({ debtTagMissing: true, nonUsdFiler: true }).map((f) => f.id)
    ).toEqual(["non-usd", "debt-unknown", "no-sec-data"]);
    expect(
      riskFlags({
        cik: 1,
        price: 0.5,
        sharesOutstanding: 1,
        sharesYearAgo: 1,
      })[0]
    ).toEqual({
      id: "penny",
      label: "Penny stock (price < $1)",
    });
  });

  it("derives valuation", () => {
    const d = derive(strong);
    expect(d.marketCap).toBe(200e6);
    expect(d.enterpriseValue).toBe(160e6);
    expect(Math.abs((d.evSales ?? 0) - 160 / 300)).toBeLessThan(1e-9);
    expect(derive().marketCap).toBeNull();
    expect(derive({ marketCap: 5e6 })).toMatchObject({
      enterpriseValue: 5e6,
      marketCap: 5e6,
    });
    expect(
      derive({ cash: 1e6, marketCap: 5e6, totalDebt: 2e6 }).enterpriseValue
    ).toBe(6e6);
    expect(derive({ cash: 1, operatingCashFlow: -1 }).runwayMonths).toBe(12);
    expect(derive({ operatingCashFlow: 0 }).runwayMonths).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("applies the optional universe cutoffs (ours)", () => {
    expect(inUniverse({ marketCap: 200e6, price: 4, volume: 100e3 })).toBe(
      true
    );
    expect(inUniverse({ marketCap: 200e6, price: 12, volume: 100e3 })).toBe(
      false
    );
    expect(inUniverse({ marketCap: 2e9, price: 4, volume: 100e3 })).toBe(false);
    expect(inUniverse({ marketCap: 200e6, price: 4, volume: 1e3 })).toBe(false);
    expect(inUniverse({ marketCap: null, price: 4, volume: 100e3 })).toBe(
      false
    );
    expect(inUniverse({ marketCap: 200e6, price: 0, volume: 100e3 })).toBe(
      false
    );
    expect(
      inUniverse({
        marketCap: 200e6,
        price: 4,
        volume: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
    expect(
      inUniverse(
        { marketCap: 20e6, price: 4, volume: 100e3 },
        { ...UNIVERSE_CUTOFFS, minMarketCap: 1 }
      )
    ).toBe(true);
  });

  it("ranks full-data names first, then total, normalized, fewer flags and symbol", () => {
    const a = {
      coverage: 8,
      flags: [],
      normalized: 10,
      symbol: "A",
      total: 10,
    };
    const b = { coverage: 2, flags: [], normalized: 16, symbol: "B", total: 4 };
    const c = {
      coverage: 8,
      flags: [{ id: "penny" }],
      normalized: 10,
      symbol: "C",
      total: 10,
    };
    expect(rank([b, c, a]).map((r) => `${r.rank}${r.symbol}`)).toEqual([
      "1A",
      "2C",
      "3B",
    ]);
    const d = {
      coverage: 2,
      flags: [],
      normalized: null,
      symbol: "D",
      total: 4,
    };
    const e = {
      coverage: 2,
      flags: [],
      normalized: null,
      symbol: "E",
      total: 4,
    };
    expect(rank([e, b, d]).map((r) => r.symbol)).toEqual(["B", "D", "E"]);
  });
});

describe("industry peers", () => {
  it("uses the industry median EV/sales when known, else the 52-week-high fallback", () => {
    const peers = Array.from({ length: 5 }, (_, i) => ({
      cash: 0,
      industry: "Tools",
      price: 10,
      revenue: 100e6,
      sharesOutstanding: 10e6,
      symbol: `P${i}`,
      totalDebt: 0,
    }));
    const med = industryMedians(peers); // each EV/sales = 1.0
    expect(med["Tools"]).toEqual({ evSales: 1, n: 5 });
    // Implied equity = 300M + 60M - 20M = 340M / 50M sh = 6.8 vs 4 => +70%.
    const r = scoreTicker(withPeers({ ...strong, industry: "Tools" }, med));
    expect(r.criteria.upside.score).toBe(1);
    expect(r.criteria.upside.evidence).toBe(
      "+70% to the price implied by the industry median EV ÷ sales 1.00 (n=5)."
    );
    expect(scoreTicker(strong).criteria.upside.evidence).toMatch(/^Fallback/);
    const rich = scoreTicker({ ...strong, peerEvSales: 3 });
    expect(rich.criteria.upside).toEqual({
      evidence:
        "+370% to the price implied by the industry median EV ÷ sales 3.00 (n=?).",
      score: 2,
    });
    expect(
      scoreTicker({ ...strong, peerEvSales: 0.1 }).criteria.upside
    ).toEqual({
      evidence:
        "-65% to the price implied by the industry median EV ÷ sales 0.10 (n=?).",
      score: 0,
    });
  });

  it("needs 5 positive EV/sales names per industry and takes the even-count median", () => {
    const peer = (
      industry: string | null,
      revenue: number | null,
      price = 10
    ) => ({
      industry,
      price,
      revenue,
      sharesOutstanding: 1e6,
    });
    const med = industryMedians([
      ...[10, 20, 30, 40, 50, 60].map((price) => peer("Even", 10e6, price)),
      ...[1, 2, 3, 4].map((price) => peer("Few", 10e6, price)),
      peer(null, 10e6),
      peer("Even", null),
      { ...peer("Even", 10e6), cash: 1e9 },
    ]);
    expect(med).toEqual({ Even: { evSales: 3.5, n: 6 } });
    expect(industryMedians([peer("Few", 1e6)], 1)).toEqual({
      Few: { evSales: 10, n: 1 },
    });
  });

  it("attaches peers only for a known industry", () => {
    const med = { Tools: { evSales: 2, n: 7 } };
    const plain = { symbol: "X" };
    expect(withPeers(plain, med)).toBe(plain);
    const other = { industry: "Other", symbol: "Y" };
    expect(withPeers(other, med)).toBe(other);
    expect(withPeers(other)).toBe(other);
    expect(withPeers({ industry: "Tools", symbol: "Z" }, med)).toEqual({
      industry: "Tools",
      peerCount: 7,
      peerEvSales: 2,
      symbol: "Z",
    });
  });
});
