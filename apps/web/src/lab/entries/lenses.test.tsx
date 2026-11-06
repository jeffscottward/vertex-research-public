// @vitest-environment jsdom
import {
  CongressTradesFeedOutputSchema,
  DeepValueOutputSchema,
  DeepValueScoreOutputSchema,
  MarketContextOutputSchema,
  MarketVolatilityOutputSchema,
  RotationMatrixOutputSchema,
  SectorRotationMapOutputSchema,
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
} from "./lenses.tsx";

afterEach(async () => {
  await unmountLab();
});

const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  "congress-trades": ["Congress trades", "Rep. Demo Member (fake)"],
  "deep-value": ["Deep value screen", "SLV"],
  markets: ["Market context", "Demo headline"],
  "risk-allocator": ["Risk allocator", "Owner risk caps"],
  "rotation-matrix": ["Rotation matrix", "Demo Semiconductors"],
  "sector-rotation": ["Sector rotation", "Technology"],
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
        await labCongressTradesGateway.feed(days)
      );
      expect(feed.members).toContain("Rep. Demo Member (fake)");
    }
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
