import type { FlowGex, FlowSnapshot } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildFlowGexPriceChart,
  buildFlowPriceOverlayLevels,
} from "./gamma-levels-view-model.ts";

const sampleGex = (overrides: Partial<FlowGex> = {}): FlowGex => ({
  at: "2026-11-25T15:30:00Z",
  basis: 10,
  ivRegime: "contango",
  levels: {
    callWall: 6100,
    flip: 5980,
    kingNode: 6100,
    maxPain: 6000,
    putWall: 5900,
  },
  netDex: 1e6,
  regime: "positive",
  spot: 6000,
  symbolLevels: {
    callWall: 6110,
    flip: 5990,
    kingNode: 6110,
    maxPain: 6010,
    putWall: 5910,
  },
  ticker: "SPX",
  totalGex: 1e9,
  zeroDteShare: 0.4,
  ...overrides,
});

const sampleSnapshot = (overrides: Partial<FlowSnapshot> = {}): FlowSnapshot =>
  ({
    confluence: { factors: [], summary: "neutral" },
    events: [],
    freshness: [],
    gex: sampleGex(),
    minutes: [
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 6005,
        coveredSeconds: 60,
        cvd: 5,
        delta: 5,
        minute: "2026-11-25T14:30:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 6004,
      },
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 6012,
        coveredSeconds: 60,
        cvd: 10,
        delta: 5,
        minute: "2026-11-25T14:31:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 6008,
      },
      // 10-minute gap splits the polyline into two segments.
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 6018,
        coveredSeconds: 60,
        cvd: 15,
        delta: 5,
        minute: "2026-11-25T14:41:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 6012,
      },
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 6020,
        coveredSeconds: 60,
        cvd: 20,
        delta: 5,
        minute: "2026-11-25T14:42:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 6015,
      },
    ],
    notes: [],
    optionsFlow: {
      bearishPremium: 0,
      bullishPremium: 0,
      callPremium: 0,
      putPremium: 0,
      topPrints: [],
      trades: 0,
    },
    orderFlow: { book: null, cvd: 0, delta: 0, volume: 0 },
    schemaVersion: "flow-snapshot.v1",
    symbol: "ES",
    windowEnd: "2026-11-25T15:30:00Z",
    windowStart: "2026-11-25T13:30:00Z",
    ...overrides,
  }) as unknown as FlowSnapshot;

describe("buildFlowPriceOverlayLevels", () => {
  it("returns null without valid gex levels or positive price span", () => {
    expect(
      buildFlowPriceOverlayLevels({
        chartHeight: 200,
        chartY: 16,
        gex: null,
        priceMax: 6050,
        priceMin: 5950,
        symbol: "ES",
      })
    ).toBeNull();
    expect(
      buildFlowPriceOverlayLevels({
        chartHeight: 200,
        chartY: 16,
        gex: sampleGex(),
        priceMax: 6000,
        priceMin: 6000,
        symbol: "ES",
      })
    ).toBeNull();
  });

  it("splits in-range lines from off-scale above/below levels and merges coincident walls", () => {
    const built = buildFlowPriceOverlayLevels({
      chartHeight: 200,
      chartY: 16,
      gex: sampleGex(),
      priceMax: 6050,
      priceMin: 5950,
      referencePrice: 6000,
      symbol: "ES",
    });
    expect(built).not.toBeNull();
    expect(built?.offScaleAbove.map((l) => l.key)).toEqual([
      "callWall+kingNode",
    ]);
    expect(built?.offScaleAbove[0]?.distanceText).toBe("+1.8%");
    expect(built?.offScaleBelow.map((l) => l.key)).toEqual(["putWall"]);
    expect(built?.offScaleBelow[0]?.distanceText).toBe("-1.5%");
    expect(built?.offScaleAbove[0]?.priceText).toBe("6,110.00");
    // y grows downward: 6,010 is 60% up a 5,950-6,050 axis that is 200 high and starts at 16.
    expect(
      built?.visibleLines.map(({ key, labelY, pillText, y }) => ({
        key,
        labelY,
        pillText,
        y,
      }))
    ).toEqual([
      { key: "maxPain", labelY: 96, pillText: "◎ Max pain 6,010.00", y: 96 },
      { key: "flip", labelY: 136, pillText: "⇄ Flip 5,990.00", y: 136 },
    ]);
    expect(built?.asOfText).toBe("Nov 25, 10:30 AM EST");

    // Two levels closer than one pill height: the lower pill moves down, its line does not.
    const close = buildFlowPriceOverlayLevels({
      chartHeight: 200,
      chartY: 16,
      gex: sampleGex({
        symbolLevels: {
          callWall: null,
          flip: 6008,
          kingNode: null,
          maxPain: 6010,
          putWall: null,
        },
      }),
      priceMax: 6050,
      priceMin: 5950,
      symbol: "ES",
    });
    expect(
      close?.visibleLines.map(({ key, labelY, y }) => ({ key, labelY, y }))
    ).toEqual([
      { key: "maxPain", labelY: 96, y: 96 },
      { key: "flip", labelY: 114, y: 100 },
    ]);

    // When all levels are inside range, merged king+wall marks isMergedWithKing.
    const full = buildFlowPriceOverlayLevels({
      chartHeight: 200,
      chartY: 16,
      gex: sampleGex({ spot: null }),
      priceMax: 6200,
      priceMin: 5850,
      symbol: "ES",
    });
    expect(full?.visibleLines[0]?.isMergedWithKing).toBe(true);
    expect(full?.offScaleAbove).toEqual([]);
    expect(full?.offScaleBelow).toEqual([]);

    // Non-positive reference price omits distanceText on off-scale items.
    const noRef = buildFlowPriceOverlayLevels({
      chartHeight: 200,
      chartY: 16,
      gex: sampleGex({ spot: null }),
      priceMax: 6050,
      priceMin: 5950,
      referencePrice: null,
      symbol: "ES",
    });
    expect(noRef?.offScaleAbove[0]?.distanceText).toBeNull();
  });
});

describe("buildFlowGexPriceChart", () => {
  it("returns null when gex is absent or basis-less for futures", () => {
    expect(buildFlowGexPriceChart(sampleSnapshot({ gex: null }))).toBeNull();
    expect(
      buildFlowGexPriceChart(
        sampleSnapshot({ gex: sampleGex({ basis: null, symbolLevels: null }) })
      )
    ).toBeNull();
  });

  it("builds segmented close/VWAP lines with all gamma levels in bounds", () => {
    const chart = buildFlowGexPriceChart(sampleSnapshot());
    expect(chart).not.toBeNull();
    expect(chart?.hasMinuteSeries).toBe(true);
    expect(chart?.priceSegments).toHaveLength(2);
    expect(chart?.vwapSegments).toHaveLength(2);
    expect(chart?.lines).toHaveLength(4);
    expect(chart?.spotLabel).toBe("Last 6,020.00");
    expect(chart?.priceTicks).toHaveLength(5);
    expect(chart?.timeTicks).toHaveLength(3);
  });

  it("falls back to spot reference when no intraday minute closes exist yet", () => {
    const noMinutes = buildFlowGexPriceChart(
      sampleSnapshot({
        minutes: [
          {
            bearishPremium: 0,
            bookPressure: null,
            bullishPremium: 0,
            buyVolume: 0,
            callPremium: 0,
            close: null,
            coveredSeconds: 0,
            cvd: 0,
            delta: 0,
            minute: "invalid-date",
            optionTrades: 0,
            putPremium: 0,
            sellVolume: 0,
            trades: 0,
            volume: 0,
            vwap: null,
          },
        ],
      })
    );
    expect(noMinutes?.hasMinuteSeries).toBe(false);
    expect(noMinutes?.spotLabel).toBe("Spot 6,010.00");
    // The spot marker sits at the right edge of the plot; the level pills use the left edge.
    expect(noMinutes?.spotX).toBe(698);

    // Also works when both minutes and spot are null.
    const noSpot = buildFlowGexPriceChart(
      sampleSnapshot({
        gex: sampleGex({ spot: null }),
        minutes: [],
      })
    );
    expect(noSpot?.spotY).toBeNull();
    expect(noSpot?.spotLabel).toBeNull();

    // Single isolated minute points separated by a gap (and null close/vwap) produce no polylines.
    const isolated = buildFlowGexPriceChart(
      sampleSnapshot({
        minutes: [
          {
            bearishPremium: 0,
            bookPressure: null,
            bullishPremium: 0,
            buyVolume: 0,
            callPremium: 0,
            close: null,
            coveredSeconds: 0,
            cvd: 0,
            delta: 0,
            minute: "2026-11-25T14:20:00Z",
            optionTrades: 0,
            putPremium: 0,
            sellVolume: 0,
            trades: 0,
            volume: 0,
            vwap: null,
          },
          {
            bearishPremium: 0,
            bookPressure: null,
            bullishPremium: 0,
            buyVolume: 1,
            callPremium: 0,
            close: 6005,
            coveredSeconds: 60,
            cvd: 1,
            delta: 1,
            minute: "2026-11-25T14:25:00Z",
            optionTrades: 0,
            putPremium: 0,
            sellVolume: 0,
            trades: 1,
            volume: 1,
            vwap: 6005,
          },
          {
            bearishPremium: 0,
            bookPressure: null,
            bullishPremium: 0,
            buyVolume: 1,
            callPremium: 0,
            close: 6008,
            coveredSeconds: 60,
            cvd: 2,
            delta: 1,
            minute: "2026-11-25T14:40:00Z",
            optionTrades: 0,
            putPremium: 0,
            sellVolume: 0,
            trades: 1,
            volume: 1,
            vwap: 6007,
          },
        ],
      })
    );
    expect(isolated?.priceSegments).toEqual([]);
    expect(isolated?.vwapSegments).toEqual([]);
  });
});
