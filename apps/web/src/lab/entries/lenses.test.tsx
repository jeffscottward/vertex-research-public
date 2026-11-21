// @vitest-environment jsdom
import {
  CongressTradesFeedOutputSchema,
  DeepValueOutputSchema,
  DeepValueScoreOutputSchema,
  MarketContextOutputSchema,
  MarketVolatilityOutputSchema,
  RotationMatrixOutputSchema,
  SectorRotationMapOutputSchema,
  SmartMoneyRankingOutputSchema,
} from "@darkfactory/api";
import { afterEach, describe, expect, it } from "vitest";

import {
  LAB_MARKET_CONTEXT,
  LAB_MARKET_VOLATILITY,
  labQuadrant,
} from "../fixtures/lenses.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import {
  LENSES_LAB_ENTRIES,
  labCongressTradesGateway,
  labResearchLensesGateway,
  labRiskAllocatorGateway,
  labSectorRotationGateway,
  labSmartMoneyGateway,
} from "./lenses.tsx";

afterEach(async () => {
  await unmountLab();
});

const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  "congress-trades": ["Congress trades", "Rep. Demo Member (fake)"],
  "deep-value": ["Deep value screen", "SLV"],
  "insider-clusters": ["Insider cluster buys", "Demo Widgets Inc (fake)"],
  markets: ["Market context", "Demo headline"],
  "risk-allocator": ["Risk allocator", "Owner risk caps"],
  "rotation-matrix": ["Rotation matrix", "Demo Semiconductors"],
  "sector-rotation": ["Sector rotation", "Technology"],
  "smart-money": ["Smart money", "Demo large options trades (fake data)"],
};

describe("lenses lab entries", () => {
  it.each(LENSES_LAB_ENTRIES)("renders $id with fake data", async (entry) => {
    const [title, fake] = EXPECTED[entry.id] ?? ["?", "?"];
    const host = await mountLab(entry.render(new URLSearchParams()));
    expect(host.querySelector("h1")?.textContent).toBe(title);
    expect(entry.title).toBe(title);
    expect(host.textContent).toContain(fake);
  });

  it("serves contract-valid research lens fixtures", async () => {
    for (const period of ["1D", "1M", "3M", "6M"] as const)
      RotationMatrixOutputSchema.parse(
        await labResearchLensesGateway.rotationMatrix(period)
      );
    DeepValueOutputSchema.parse(await labResearchLensesGateway.deepValue());
    const score = DeepValueScoreOutputSchema.parse(
      await labResearchLensesGateway.score("NVDA")
    );
    expect(score.symbol).toBe("NVDA");
    MarketVolatilityOutputSchema.parse(LAB_MARKET_VOLATILITY);
    MarketContextOutputSchema.parse(LAB_MARKET_CONTEXT);
  });

  it("maps stored sectors and custom lists daily or weekly", async () => {
    const sectors = SectorRotationMapOutputSchema.parse(
      await labSectorRotationGateway.map({})
    );
    expect(sectors.source).toBe("stored");
    const custom = SectorRotationMapOutputSchema.parse(
      await labSectorRotationGateway.map({
        benchmark: "QQQ",
        timeframe: "daily",
        universe: { kind: "custom", symbols: ["GLD", "SLV"] },
      })
    );
    expect(custom.series.map((series) => series.symbol)).toEqual([
      "GLD",
      "SLV",
    ]);
    expect(await labSectorRotationGateway.universes()).toHaveLength(3);
    expect([
      labQuadrant(101, 101),
      labQuadrant(101, 99),
      labQuadrant(99, 101),
      labQuadrant(99, 99),
    ]).toEqual(["leading", "weakening", "improving", "lagging"]);
  });

  it("serves congress feeds for every window", async () => {
    for (const days of [7, 30, 90] as const) {
      const feed = CongressTradesFeedOutputSchema.parse(
        await labCongressTradesGateway.feed({
          chamber: "",
          days,
          member: "",
          ticker: "",
        })
      );
      expect(feed.members).toContain("Rep. Demo Member (fake)");
      expect(feed.trades.length).toBeGreaterThan(0);
    }
  });

  it("applies the congress filters to the fake feed", async () => {
    const feed = await labCongressTradesGateway.feed({
      chamber: "senate",
      days: 90,
      member: "Sen. Sample Legislator (fake)",
      ticker: "FAKE",
    });
    expect(feed.trades.length).toBeGreaterThan(0);
    expect(
      feed.trades.every(
        (row) =>
          row.chamber === "senate" &&
          row.member === "Sen. Sample Legislator (fake)" &&
          row.ticker === "FAKE"
      )
    ).toBe(true);
    return expect(feed.filings.every((row) => row.chamber === "senate")).toBe(
      true
    );
  });

  it("serves contract-valid smart-money rankings for every window and sort", async () => {
    for (const sessions of [1, 5, 20] as const)
      for (const sort of ["net_bullish", "net_bearish", "total"] as const) {
        const ranking = SmartMoneyRankingOutputSchema.parse(
          await labSmartMoneyGateway.ranking({ sessions, sort, ticker: "" })
        );
        expect(ranking.sessions).toHaveLength(sessions);
        expect(ranking.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(ranking.totals.tickers).toBe(6);
      }
    const bearish = await labSmartMoneyGateway.ranking({
      sessions: 1,
      sort: "net_bearish",
      ticker: "",
    });
    expect(bearish.rows[0]?.ticker).toBe("FAKE");
    const total = await labSmartMoneyGateway.ranking({
      sessions: 1,
      sort: "total",
      ticker: "",
    });
    expect(total.rows[0]?.ticker).toBe("DEMO");
    const one = await labSmartMoneyGateway.ranking({
      sessions: 5,
      sort: "net_bullish",
      ticker: "SMPL",
    });
    expect(one.rows.map((row) => [row.ticker, row.rank])).toEqual([
      ["SMPL", 1],
    ]);
    return expect(one.totals.premium).toBe(one.rows[0]?.premium);
  });

  it("suggests an allocation with the real allocator", async () => {
    const caps = await labRiskAllocatorGateway.caps();
    expect(caps.leapsPremiumPct).toBeGreaterThan(0);
    const suggestion = await labRiskAllocatorGateway.suggest({
      asOf: "2026-10-30",
      candidates: [
        { expiry: "2027-12-17", kind: "option", symbol: "NVDA", unitCost: 500 },
      ],
      nlv: 250_000,
    });
    expect(suggestion.rows[0]?.symbol).toBe("NVDA");
  });
});
