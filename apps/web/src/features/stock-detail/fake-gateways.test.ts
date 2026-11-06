import {
  MarketBarsOutputSchema,
  OptionsChainExpiriesOutputSchema,
  OptionsChainOutputSchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  createFakeMarketDataGateway,
  createFakeOptionsChainGateway,
  FAKE_NOW,
  fakeSpot,
} from "./fake-gateways.ts";

describe("fake options chain gateway", () => {
  const gateway = createFakeOptionsChainGateway();

  it("returns contract-valid, deterministic dummy chains", async () => {
    const listed = OptionsChainExpiriesOutputSchema.parse(
      await gateway.expiries({ symbol: "nvda" })
    );
    expect(listed.symbol).toBe("NVDA");
    expect(listed.spot).toBe(fakeSpot("NVDA"));
    expect(listed.expiries[0]).toEqual({ date: "2026-11-06", dte: 2 });
    expect(listed.expiries.map((item) => item.date)).toContain("2026-12-18");
    const nearest = OptionsChainOutputSchema.parse(
      await gateway.chain({ symbol: "NVDA" })
    );
    expect(nearest.expiry).toBe("2026-11-06");
    expect(nearest.rows).toHaveLength(41);
    expect(nearest.notes[0]).toContain("DUMMY DATA");
    const again = await gateway.chain({ symbol: "NVDA" });
    expect(again).toEqual(nearest);
    const later = await gateway.chain({ expiry: "2026-12-18", symbol: "NVDA" });
    expect(later.dte).toBe(44);
    expect(later.rows[20]?.call?.greeks?.delta).toBeGreaterThan(0.4);
  });

  it("uses small strike steps for cheap symbols and fails on request", async () => {
    const cheap = createFakeOptionsChainGateway({
      now: new Date("2026-11-06T12:00:00Z"),
    });
    for (const symbol of ["A", "AB", "ABC", "ABCD", "ZZ"]) {
      const chain = await cheap.chain({ symbol });
      const [first, second] = chain.rows;
      expect((second?.strike ?? 0) - (first?.strike ?? 0)).toBeGreaterThan(0);
    }
    await expect(gateway.chain({ symbol: "FAIL" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(gateway.expiries({ symbol: "noopt" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      gateway.chain({ expiry: "2030-01-01", symbol: "NVDA" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("fake market data gateway", () => {
  it("returns contract-valid dummy bars ending at the fake spot", async () => {
    const gateway = createFakeMarketDataGateway();
    const daily = MarketBarsOutputSchema.parse(
      await gateway.bars({ symbol: "spy" })
    );
    expect(daily.bars).toHaveLength(252);
    expect(daily.bars.at(-1)?.c).toBe(fakeSpot("SPY"));
    expect(daily.request).toMatchObject({ barSize: "1 day", duration: "1 Y" });
    expect(daily.fetchedAt).toBe(FAKE_NOW.toISOString());
    const intraday = await gateway.bars({
      barSize: "5 mins",
      duration: "1 W",
      symbol: "SPY",
      useRTH: false,
      whatToShow: "MIDPOINT",
    });
    expect(intraday.bars).toHaveLength(390);
    expect(intraday.request).toMatchObject({
      useRTH: false,
      whatToShow: "MIDPOINT",
    });
    await expect(gateway.bars({ symbol: "FAIL" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
