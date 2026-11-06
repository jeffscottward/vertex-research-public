import {
  MarketBarsOutputSchema,
  MarketDepthOutputSchema,
  MarketTicksOutputSchema,
  OptionsAnalyticsOutputSchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  createSeededRandom,
  hashSeed,
  LAB_ACCOUNT,
  LAB_NOW_ISO,
  LAB_TICKERS,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  labReadOnly,
  roundTo,
} from "./core.ts";
import {
  labBars,
  labBarsOutput,
  labDepthEntitlementError,
  labDepthOutput,
  labOptionsAnalytics,
  labTicksOutput,
} from "./market.ts";

describe("lab fixture core", () => {
  it("gives the same random sequence for the same seed", () => {
    const first = createSeededRandom("seed");
    const second = createSeededRandom("seed");
    const other = createSeededRandom("other");
    const a = [first(), first(), first()];
    expect([second(), second(), second()]).toEqual(a);
    expect(other()).not.toBe(a[0]);
    for (const value of a) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
    expect(hashSeed("")).toBe(8);
  });

  it("uses a fictional account and fixed clock", () => {
    expect(LAB_ACCOUNT.name).toBe("Demo Capital");
    expect(LAB_TICKERS).toContain("NVDA");
    expect(LAB_NOW_ISO).toBe("2026-10-30T20:00:00.000Z");
    expect(labDaysAgo(1)).toBe("2026-10-29");
    expect(labMinutesAgo(60)).toBe("2026-10-30T19:00:00.000Z");
    expect(roundTo(1.234_56)).toBe(1.23);
    expect(roundTo(1.5, 0)).toBe(2);
  });

  it("prices known and unknown tickers deterministically", () => {
    expect(labBasePrice("NVDA")).toBe(138.2);
    expect(labBasePrice("ZZZZ")).toBe(labBasePrice("ZZZZ"));
    expect(labBasePrice("ZZZZ")).toBeGreaterThanOrEqual(20);
  });

  it("rejects write calls", async () => {
    await expect(labReadOnly()).rejects.toThrow("dummy data only");
  });
});

describe("lab market fixtures", () => {
  it("builds the same valid bars every time", () => {
    const first = labBarsOutput({ symbol: "nvda" });
    expect(labBarsOutput({ symbol: "NVDA" })).toEqual(first);
    expect(MarketBarsOutputSchema.parse(first)).toEqual(first);
    expect(first.count).toBe(250);
    expect(first.request).toMatchObject({
      barSize: "1 day",
      exchange: "SMART",
      secType: "STK",
      symbol: "NVDA",
    });
    for (const bar of first.bars) {
      expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c));
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
    }
  });

  it("follows the requested bar size and contract", () => {
    const output = labBarsOutput({
      barSize: "1 hour",
      contractMonth: "202612",
      currency: "USD",
      duration: "1 M",
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
      useRTH: false,
      whatToShow: "MIDPOINT",
    });
    expect(output.count).toBe(400);
    expect(output.bars[1]?.t).toBe((output.bars[0]?.t ?? 0) + 3600);
    expect(output.request).toMatchObject({
      contractMonth: "202612",
      exchange: "CME",
      secType: "FUT",
      useRTH: false,
    });
    expect(labBars("SPY", 3, "5 mins")).toHaveLength(3);
    const weekdays = labBars("SPY", 30).map((bar) =>
      new Date(bar.t * 1000).getUTCDay()
    );
    expect(weekdays).not.toContain(0);
    expect(weekdays).not.toContain(6);
  });

  it("builds a valid options snapshot for cheap and expensive tickers", () => {
    for (const symbol of ["SPY", "NVDA", "SLV"]) {
      const snapshot = labOptionsAnalytics(symbol);
      expect(OptionsAnalyticsOutputSchema.parse(snapshot)).toEqual(snapshot);
      expect(labOptionsAnalytics(symbol)).toEqual(snapshot);
    }
    expect(labOptionsAnalytics("SPY", 6).flow.hours).toBe(6);
  });
});

describe("lab order flow fixtures", () => {
  it("builds valid, deterministic fictional prints and quotes", () => {
    const ticks = labTicksOutput({ symbol: "nvda" });
    expect(labTicksOutput({ symbol: "NVDA" })).toEqual(ticks);
    expect(MarketTicksOutputSchema.parse(ticks)).toEqual(ticks);
    expect(ticks.trades).toHaveLength(500);
    expect(ticks.quotes.length).toBeGreaterThan(0);
    // The first prints come before the first quote.
    expect(ticks.quotes[0]?.t ?? 0).toBeGreaterThan(ticks.trades[0]?.t ?? 0);
    expect(new Set(ticks.trades.map((trade) => trade.x))).toEqual(
      new Set(["LAB-A", "LAB-B"])
    );
    expect(ticks.contract.longName).toContain("fake data");
    const futures = labTicksOutput({
      count: 100,
      exchange: "CME",
      quotes: false,
      secType: "FUT",
      symbol: "ES",
    });
    expect(MarketTicksOutputSchema.parse(futures).trades).toHaveLength(100);
    expect(futures.quotes).toEqual([]);
    for (const trade of futures.trades) {
      expect((trade.p * 4) % 1).toBe(0);
      expect(trade.x).toBeNull();
    }
  });

  it("builds a valid SMART book with a venue notice and a single-exchange futures book", () => {
    const depth = labDepthOutput({ symbol: "SPY" });
    expect(MarketDepthOutputSchema.parse(depth)).toEqual(depth);
    expect(depth.bids).toHaveLength(10);
    expect(depth.asks[0]?.price ?? 0).toBeGreaterThan(
      depth.bids[0]?.price ?? 0
    );
    expect(depth).toMatchObject({
      request: { smartDepth: true },
      sizeMultiplier: 100,
      venues: { missing: ["LAB-D"] },
    });
    const futures = labDepthOutput({
      exchange: "CME",
      rows: 5,
      secType: "FUT",
      symbol: "ES",
    });
    expect(MarketDepthOutputSchema.parse(futures).asks).toHaveLength(5);
    expect(futures).toMatchObject({ sizeMultiplier: 1, venues: null });
    expect(labDepthEntitlementError()).toMatchObject({ code: "ENTITLEMENT" });
  });
});
