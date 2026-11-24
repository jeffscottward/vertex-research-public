import { describe, expect, it } from "vitest";
import {
  buildDepthCurve,
  DEPTH_CURVE_HEIGHT,
  DEPTH_CURVE_WIDTH,
  formatCompactSize,
} from "./depth-curve.ts";
import { buildDepthLadder } from "./depth-ladder.ts";

describe("formatCompactSize", () => {
  it("formats zero, small integers, decimals, thousands and millions cleanly", () => {
    expect(formatCompactSize(0)).toBe("0");
    expect(formatCompactSize(42)).toBe("42");
    expect(formatCompactSize(12.5)).toBe("12.5");
    expect(formatCompactSize(1000)).toBe("1K");
    expect(formatCompactSize(1250)).toBe("1.3K");
    expect(formatCompactSize(2_500_000)).toBe("2.5M");
    expect(formatCompactSize(3_000_000)).toBe("3M");
  });
});

describe("buildDepthCurve", () => {
  it("returns null for an empty book", () => {
    const ladder = buildDepthLadder({ asks: [], bids: [], sizeMultiplier: 1 });
    expect(
      buildDepthCurve(ladder, {
        digits: 2,
        minTick: 0.01,
        symbol: "SPY",
        unit: "shares",
      })
    ).toBeNull();
  });

  it("aggregates multi-venue SMART rows per price and builds exact step curves", () => {
    const ladder = buildDepthLadder({
      asks: [
        { price: 100.02, size: 3, venue: "ARCA" },
        { price: 100.02, size: 2, venue: "BATS" },
        { price: 100.04, size: 4, venue: "NSDQ" },
      ],
      bids: [
        { price: 100, size: 2, venue: "ARCA" },
        { price: 100, size: 1, venue: "ARCA" },
        { price: 100, size: 3, venue: "IEX" },
        { price: 99.98, size: 5, venue: "NSDQ" },
      ],
      sizeMultiplier: 100,
    });

    const curve = buildDepthCurve(ladder, {
      digits: 2,
      minTick: 0.01,
      symbol: "SPY",
      unit: "shares",
    });

    expect(curve).not.toBeNull();
    if (curve === null) throw new Error("expected depth curve");

    expect(curve.width).toBe(DEPTH_CURVE_WIDTH);
    expect(curve.height).toBe(DEPTH_CURVE_HEIGHT);

    // Distinct price levels aggregated per side, best-first.
    expect(curve.bids.map((b) => [b.price, b.size, b.cumulative])).toEqual([
      [100, 600, 600],
      [99.98, 500, 1100],
    ]);
    expect(curve.bids[0]?.venues).toEqual(["ARCA", "IEX"]);
    expect(curve.asks.map((a) => [a.price, a.size, a.cumulative])).toEqual([
      [100.02, 500, 500],
      [100.04, 400, 900],
    ]);
    expect(curve.asks[0]?.venues).toEqual(["ARCA", "BATS"]);

    // Totals match the ladder exactly.
    expect(curve.totalBid).toBe(ladder.totalBid);
    expect(curve.totalAsk).toBe(ladder.totalAsk);
    expect(curve.bidSharePct).toBe(55);
    expect(curve.askSharePct).toBe(45);

    // Step geometry: bids step downward toward best bid (x increases, y increases toward baseline).
    expect(curve.bids[1]?.x).toBeLessThan(curve.bids[0]?.x ?? 0);
    expect(curve.bids[1]?.y).toBeLessThan(curve.bids[0]?.y ?? 0);
    // Asks step upward outward from best ask (x increases, y decreases toward top).
    expect(curve.asks[0]?.x).toBeLessThan(curve.asks[1]?.x ?? 0);
    expect(curve.asks[1]?.y).toBeLessThan(curve.asks[0]?.y ?? 0);

    // Paths start/end cleanly at plot edges and baseline.
    expect(curve.bidLinePath.startsWith(`M ${curve.plotLeft} `)).toBe(true);
    expect(curve.bidAreaPath.endsWith(" Z")).toBe(true);
    expect(curve.askLinePath.includes(`L ${curve.plotRight} `)).toBe(true);
    expect(curve.askAreaPath.endsWith(" Z")).toBe(true);

    // Normal two-sided book includes spread band and mid marker.
    expect(curve.spreadBand).not.toBeNull();
    expect(curve.spreadBand?.width).toBeGreaterThan(0);
    expect(curve.midMarker).toEqual({
      label: "Mid 100.01",
      state: "normal",
      x: expect.any(Number),
    });
    expect(curve.bestBidPoint?.price).toBe(100);
    expect(curve.bestAskPoint?.price).toBe(100.02);
    expect(curve.yMax).toBeGreaterThanOrEqual(1100);
    expect(curve.yTicks[0]).toEqual({
      label: "0",
      pos: curve.plotBottom,
      value: 0,
    });
    // X-axis tick marks align exactly to the plotted coordinate of their printed price.
    const bidTick = curve.xTicks.find((tick) => tick.label === "100.00");
    const askTick = curve.xTicks.find((tick) => tick.label === "100.04");
    expect(bidTick?.pos).toBe(curve.bestBidPoint?.x);
    expect(askTick?.pos).toBe(curve.asks[1]?.x);

    // Exact step path vertices match the aggregated level coordinates.
    const [bestBid, outerBid] = curve.bids;
    const [bestAsk, outerAsk] = curve.asks;
    expect(curve.bidLinePath).toBe(
      `M ${curve.plotLeft} ${outerBid?.y} L ${outerBid?.x} ${outerBid?.y} L ${outerBid?.x} ${bestBid?.y} L ${bestBid?.x} ${bestBid?.y} L ${bestBid?.x} ${curve.plotBottom}`
    );
    expect(curve.askLinePath).toBe(
      `M ${bestAsk?.x} ${curve.plotBottom} L ${bestAsk?.x} ${bestAsk?.y} L ${outerAsk?.x} ${bestAsk?.y} L ${outerAsk?.x} ${outerAsk?.y} L ${curve.plotRight} ${outerAsk?.y}`
    );
    expect(curve.xTicks.length).toBeGreaterThanOrEqual(2);
    expect(curve.ariaLabel).toContain("SPY");
    expect(curve.ariaLabel).toContain("1,100");
    expect(curve.ariaLabel).toContain("900");
    expect(curve.ariaLabel).toContain("shares");
    expect(curve.ariaLabel).toContain("spread 0.02");
  });

  it("handles bids-only and asks-only one-sided books without a mid marker or spread band", () => {
    const bidsOnly = buildDepthCurve(
      buildDepthLadder({
        asks: [],
        bids: [
          { price: 4500, size: 12, venue: null },
          { price: 4499.75, size: 8, venue: null },
        ],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.25, symbol: "ES", unit: "contracts" }
    );
    expect(bidsOnly).not.toBeNull();
    expect(bidsOnly?.bidLinePath).not.toBe("");
    expect(bidsOnly?.askLinePath).toBe("");
    expect(bidsOnly?.askAreaPath).toBe("");
    expect(bidsOnly?.bestBidPoint?.price).toBe(4500);
    expect(bidsOnly?.bestAskPoint).toBeNull();
    expect(bidsOnly?.midMarker).toBeNull();
    expect(bidsOnly?.spreadBand).toBeNull();
    expect(bidsOnly?.bidSharePct).toBe(100);
    expect(bidsOnly?.askSharePct).toBe(0);
    expect(bidsOnly?.ariaLabel).toContain("bids only");

    const asksOnly = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 4500.25, size: 7, venue: null }],
        bids: [],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: null, symbol: "ES", unit: "contracts" }
    );
    expect(asksOnly).not.toBeNull();
    expect(asksOnly?.bidLinePath).toBe("");
    expect(asksOnly?.bidAreaPath).toBe("");
    expect(asksOnly?.askLinePath).not.toBe("");
    expect(asksOnly?.bestBidPoint).toBeNull();
    expect(asksOnly?.bestAskPoint?.price).toBe(4500.25);
    expect(asksOnly?.midMarker).toBeNull();
    expect(asksOnly?.spreadBand).toBeNull();
    expect(asksOnly?.xTicks).toHaveLength(1);
    expect(asksOnly?.xTicks[0]?.label).toBe("4500.25");
    expect(asksOnly?.ariaLabel).toContain("asks only");
  });

  it("marks locked and crossed books honestly without a spread band", () => {
    const locked = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.02, size: 5, venue: null }],
        bids: [{ price: 100.02, size: 4, venue: null }],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.01, symbol: "SPY", unit: "shares" }
    );
    expect(locked?.spreadBand).toBeNull();
    expect(locked?.midMarker?.state).toBe("locked");
    expect(locked?.midMarker?.label).toBe("Locked 100.02");
    expect(locked?.ariaLabel).toContain("locked book");

    const crossed = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.01, size: 1500, venue: null }],
        bids: [{ price: 100.03, size: 2200, venue: null }],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.01, symbol: "SPY", unit: "shares" }
    );
    expect(crossed?.spreadBand).toBeNull();
    expect(crossed?.midMarker?.state).toBe("crossed");
    expect(crossed?.midMarker?.label).toBe("Crossed 100.02");
    expect(crossed?.ariaLabel).toContain("crossed book");
  });

  it("handles zero-size levels and every nice Y-scale step branch without NaN", () => {
    const zero = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.05, size: 0, venue: null }],
        bids: [{ price: 100, size: 0, venue: null }],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.01, symbol: "SPY", unit: "shares" }
    );
    expect(zero?.yMax).toBe(1);
    expect(zero?.bidSharePct).toBeNull();
    expect(zero?.askSharePct).toBeNull();
    expect(zero?.bidLinePath).not.toContain("NaN");
    expect(zero?.askLinePath).not.toContain("NaN");

    // Exercise each nice-step bucket (normalized <= 1, <= 2, <= 2.5, <= 5, > 5).
    for (const size of [30, 55, 70, 120, 200]) {
      const curve = buildDepthCurve(
        buildDepthLadder({
          asks: [{ price: 100.02, size, venue: null }],
          bids: [{ price: 100, size: Math.floor(size / 2), venue: null }],
          sizeMultiplier: 1,
        }),
        { digits: 2, minTick: null, symbol: "SPY", unit: "shares" }
      );
      expect(curve).not.toBeNull();
      expect(curve?.yMax).toBeGreaterThanOrEqual(size);
      expect(curve?.yTicks.at(-1)?.value).toBe(curve?.yMax);
    }
  });

  it("aligns X-axis ticks on tight spreads and falls back to midpoint on sub-precision spans", () => {
    const twoCent = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.02, size: 10, venue: null }],
        bids: [{ price: 100, size: 10, venue: null }],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.01, symbol: "SPY", unit: "shares" }
    );
    expect(twoCent?.xTicks.map((tick) => tick.label)).toEqual([
      "100.00",
      "100.01",
      "100.02",
    ]);
    expect(twoCent?.xTicks[0]?.pos).toBe(twoCent?.bestBidPoint?.x);
    expect(twoCent?.xTicks[1]?.pos).toBe(twoCent?.midMarker?.x);
    expect(twoCent?.xTicks[2]?.pos).toBe(twoCent?.bestAskPoint?.x);

    const subPrecision = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.002, size: 10, venue: null }],
        bids: [{ price: 100.001, size: 10, venue: null }],
        sizeMultiplier: 1,
      }),
      {
        digits: 2,
        minTick: Number.POSITIVE_INFINITY,
        symbol: "SPY",
        unit: "shares",
      }
    );
    expect(subPrecision?.xTicks).toHaveLength(1);
    expect(subPrecision?.xTicks[0]?.label).toBe("100.0015");
    expect(subPrecision?.xTicks[0]?.pos).toBe(subPrecision?.midMarker?.x);
    expect(subPrecision?.bidLinePath).not.toContain("NaN");
  });

  it("preserves half-tick precision in mid labels on 1-tick stock and futures spreads", () => {
    const stockOneTick = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 100.01, size: 5, venue: null }],
        bids: [{ price: 100, size: 5, venue: null }],
        sizeMultiplier: 100,
      }),
      { digits: 2, minTick: 0.01, symbol: "SPY", unit: "shares" }
    );
    expect(stockOneTick?.midMarker?.label).toBe("Mid 100.005");

    const futuresOneTick = buildDepthCurve(
      buildDepthLadder({
        asks: [{ price: 5800.25, size: 7, venue: null }],
        bids: [{ price: 5800, size: 9, venue: null }],
        sizeMultiplier: 1,
      }),
      { digits: 2, minTick: 0.25, symbol: "ES", unit: "contracts" }
    );
    expect(futuresOneTick?.midMarker?.label).toBe("Mid 5800.125");
  });
});
