// Tests for apps/web/src/features/flow/liquidity-heatmap-view-model.ts.
import type { FlowLiquidityHeatmap } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildLiquidityHeatmapPlot,
  captureBadge,
  columnCenterX,
  columnIndexFromRatio,
  depthStatusLine,
  HEAT_TIER_STOPS,
  heatCellTier,
  heatmapAriaLabel,
  heatmapRuleLine,
  heatmapSymbolOf,
  inspectColumnSummary,
  liquidityHeatmapTitle,
  tradeDotRadius,
  tradeRows,
  wallRows,
} from "./liquidity-heatmap-view-model.ts";

const makeDoc = (
  overrides: Partial<FlowLiquidityHeatmap> = {}
): FlowLiquidityHeatmap => ({
  axisEnd: "2026-11-23T15:00:00.000Z",
  axisStart: "2026-11-23T14:55:00.000Z",
  capture: "streamed",
  columns: [
    {
      bestAsk: 6001.25,
      bestBid: 6001,
      capture: "streamed",
      cells: [
        { p: 2, s: 90, side: "ask" },
        { p: 1, s: 40, side: "bid" },
        { p: 0, s: 10, side: "bid" },
      ],
      mid: 6001.125,
      state: "recorded",
      t: "2026-11-23T14:55:00.000Z",
    },
    {
      bestAsk: 6001.5,
      bestBid: 6001.25,
      capture: "streamed",
      cells: [
        { p: 1, s: 65, side: "bid" },
        { p: 2, s: 110, side: "ask" },
      ],
      mid: 6001.375,
      state: "recorded",
      t: "2026-11-23T14:56:00.000Z",
    },
    {
      bestAsk: null,
      bestBid: null,
      capture: null,
      cells: [],
      mid: null,
      state: "no_data",
      t: "2026-11-23T14:57:00.000Z",
    },
    {
      bestAsk: null,
      bestBid: 6001,
      capture: "sampled",
      cells: [{ p: 1, s: 55, side: "bid" }],
      mid: null,
      state: "recorded",
      t: "2026-11-23T14:58:00.000Z",
    },
    {
      bestAsk: 6001.5,
      bestBid: 6001.25,
      capture: "streamed",
      cells: [
        { p: 1, s: 80, side: "bid" },
        { p: 2, s: 100, side: "ask" },
      ],
      mid: 6001.375,
      state: "recorded",
      t: "2026-11-23T14:59:00.000Z",
    },
  ],
  columnSeconds: 60,
  contract: "ESZ6",
  currentDom: [
    { askSize: 0, bidSize: 40, p: 0, price: 6000 },
    { askSize: 30, bidSize: 80, p: 1, price: 6001 },
    { askSize: 100, bidSize: 0, p: 2, price: 6002 },
  ],
  depth: {
    ageSeconds: 8,
    lastOkAt: "2026-11-23T14:59:52.000Z",
    lastStatus: "ok",
    message: "streamed depth ESZ6: 12 snapshots, 20 levels",
    sessionOpen: true,
    source: "depth",
    state: "fresh",
  },
  minTick: 0.25,
  priceLevels: [6000, 6001, 6002],
  priceMax: 6002,
  priceMin: 6000,
  priceStep: 1,
  rules: {
    intensityQuantile: 0.95,
    largeTradeLimit: 25,
    maxColumns: 240,
    maxPriceBuckets: 80,
    sampleSeconds: 5,
    version: "flow-liquidity-heatmap-rules.v1",
  },
  scale: { maxSize: 110, p95Size: 100, totalCells: 8 },
  schemaVersion: "flow-liquidity-heatmap.v1",
  symbol: "ES",
  totals: {
    coveragePct: 80,
    largeTrades: 2,
    recordedColumns: 4,
    snapshots: 4,
    totalColumns: 5,
  },
  trades: [
    {
      capture: "streamed",
      price: 6001.25,
      side: "buy",
      signing: "quote",
      size: 35,
      t: "2026-11-23T14:56:15.000Z",
    },
    {
      capture: "streamed",
      price: 6001,
      side: "sell",
      signing: "tick",
      size: 80,
      t: "2026-11-23T14:59:10.000Z",
    },
  ],
  tradesTruncated: false,
  walls: [
    {
      columnsPresent: 3,
      persistencePct: 75,
      price: 6002,
      side: "ask",
      size: 100,
    },
    {
      columnsPresent: 4,
      persistencePct: 100,
      price: 6001,
      side: "bid",
      size: 80,
    },
  ],
  windowEnd: "2026-11-23T15:00:00.000Z",
  windowStart: "2026-11-23T14:55:00.000Z",
  ...overrides,
});

describe("liquidity-heatmap-view-model", () => {
  it("maps symbols, titles, capture badges, and depth status lines", () => {
    expect(heatmapSymbolOf("SPY")).toBe("ES");
    expect(heatmapSymbolOf("ES")).toBe("ES");
    expect(heatmapSymbolOf("QQQ")).toBe("NQ");
    expect(heatmapSymbolOf("NQ")).toBe("NQ");

    expect(liquidityHeatmapTitle("ES")).toBe("Liquidity heatmap (ES)");
    expect(liquidityHeatmapTitle("SPY")).toBe(
      "Liquidity heatmap (ES, the future of the S&P 500 group)"
    );
    expect(liquidityHeatmapTitle("QQQ")).toBe(
      "Liquidity heatmap (NQ, the future of the Nasdaq 100 group)"
    );

    expect(captureBadge("streamed")).toEqual({
      label: "Streamed L2",
      tone: "success",
    });
    expect(captureBadge("sampled")).toEqual({
      label: "Sampled 1m",
      tone: "info",
    });
    expect(captureBadge("mixed")).toEqual({
      label: "Mixed L2",
      tone: "warning",
    });
    expect(captureBadge("none")).toEqual({
      label: "No depth",
      tone: "neutral",
    });

    const freshLine = depthStatusLine(makeDoc());
    expect(freshLine).toContain("CME L2 ESZ6: fresh");
    expect(freshLine).toContain("streamed 5s L2");
    expect(freshLine).not.toContain("last read:");

    const staleLine = depthStatusLine(
      makeDoc({
        contract: null,
        depth: {
          ageSeconds: 400,
          lastOkAt: null,
          lastStatus: "unavailable",
          message: "depth stream halted: cap",
          sessionOpen: true,
          source: "depth",
          state: "stale",
        },
      })
    );
    expect(staleLine).toContain("CME L2 ES: stale");
    expect(staleLine).toContain("last read: depth stream halted: cap");

    const neverNoMsg = depthStatusLine(
      makeDoc({
        depth: {
          ageSeconds: null,
          lastOkAt: null,
          lastStatus: null,
          message: null,
          sessionOpen: false,
          source: "depth",
          state: "never",
        },
      })
    );
    expect(neverNoMsg).toContain("never collected");
    expect(neverNoMsg).not.toContain("last read:");
  });

  it("computes heatCellTier and tradeDotRadius across all tiers and edge inputs", () => {
    expect(HEAT_TIER_STOPS).toHaveLength(5);
    expect(heatCellTier(0, 100)).toBe(0);
    expect(heatCellTier(10, 0)).toBe(0);
    expect(heatCellTier(Number.NaN, 100)).toBe(0);
    expect(heatCellTier(10, Number.POSITIVE_INFINITY)).toBe(0);
    expect(heatCellTier(10, 100)).toBe(1);
    expect(heatCellTier(25, 100)).toBe(2);
    expect(heatCellTier(45, 100)).toBe(3);
    expect(heatCellTier(70, 100)).toBe(4);
    expect(heatCellTier(80, 100)).toBe(5);
    expect(heatCellTier(250, 100)).toBe(5);

    expect(tradeDotRadius(0)).toBe(3);
    expect(tradeDotRadius(-5)).toBe(3);
    expect(tradeDotRadius(Number.NaN)).toBe(3);
    expect(tradeDotRadius(25)).toBeCloseTo(5.5, 5);
    expect(tradeDotRadius(500)).toBe(11);
  });

  it("builds SVG plot geometry breaking mid/BBO lines across gaps and nulls, merging gaps, and stacking dual-side DOM bars", () => {
    const doc = makeDoc();
    const plot = buildLiquidityHeatmapPlot(doc);

    expect(plot.gapRects).toHaveLength(1);
    expect(plot.gapRects[0]?.startIndex).toBe(2);
    expect(plot.gapRects[0]?.endIndex).toBe(2);
    // Cols 0-1 form a 2-point polyline segment; col 4 is an isolated 1-point mid dot
    expect(plot.midSegments).toHaveLength(1);
    expect(plot.midDots).toHaveLength(1);
    expect(plot.bestBidSegments).toHaveLength(2); // cols 0-1 and cols 3-4
    expect(plot.bestAskSegments).toHaveLength(1); // cols 0-1 (col 4 is isolated)
    expect(plot.cells).toHaveLength(8);
    expect(plot.tradeDots).toHaveLength(2);
    expect(plot.tradeDots[0]?.side).toBe("buy");
    expect(plot.tradeDots[1]?.side).toBe("sell");
    // p=0 has bid only, p=1 has BOTH ask and bid (2 bars), p=2 has ask only => 4 bars
    expect(plot.domBars).toHaveLength(4);
    expect(plot.defaultInspectIndex).toBe(4);
    expect(plot.priceTicks).toHaveLength(3);
    expect(plot.timeTicks).toHaveLength(5);
    expect(columnCenterX(plot, 2)).toBeGreaterThan(plot.chartX);
    expect(columnIndexFromRatio(5, 0.5)).toBe(2);
    expect(columnIndexFromRatio(0, 0.5)).toBeNull();
  });

  it("handles trailing gaps, zero-p95 cells, single price level, empty documents, and truncated trade rules", () => {
    const emptyDoc = makeDoc({
      capture: "none",
      columns: [],
      currentDom: [],
      priceLevels: [],
      priceMax: null,
      priceMin: null,
      scale: { maxSize: 0, p95Size: 0, totalCells: 0 },
      totals: {
        coveragePct: 0,
        largeTrades: 0,
        recordedColumns: 0,
        snapshots: 0,
        totalColumns: 0,
      },
      trades: [
        {
          capture: "streamed",
          price: 6000,
          side: "buy",
          signing: "quote",
          size: 30,
          t: "2026-11-23T14:56:00.000Z",
        },
      ],
      tradesTruncated: true,
      walls: [],
    });
    const emptyPlot = buildLiquidityHeatmapPlot(emptyDoc);
    expect(emptyPlot.cells).toEqual([]);
    expect(emptyPlot.tradeDots).toEqual([]);
    expect(emptyPlot.domBars).toEqual([]);
    expect(emptyPlot.priceTicks).toEqual([]);
    expect(emptyPlot.timeTicks).toEqual([]);
    expect(emptyPlot.defaultInspectIndex).toBeNull();
    expect(columnCenterX(emptyPlot, 0)).toBe(emptyPlot.chartX);
    expect(heatmapAriaLabel(emptyDoc)).toContain("no recorded L2 depth");
    expect(heatmapRuleLine(emptyDoc)).toContain("newest 1 plotted");

    // Trailing gap + single price level + cell with p95Size=0 (skipped) + non-empty tick dedup
    const singlePriceDoc = makeDoc({
      columns: [
        {
          bestAsk: 6000,
          bestBid: 6000,
          capture: "streamed",
          cells: [{ p: 0, s: 10, side: "both" }],
          mid: 6000,
          state: "recorded",
          t: "2026-11-23T14:55:00.000Z",
        },
        {
          bestAsk: null,
          bestBid: null,
          capture: null,
          cells: [],
          mid: null,
          state: "no_data",
          t: "2026-11-23T14:56:00.000Z",
        },
      ],
      currentDom: [],
      priceLevels: [6000],
      priceMax: 6000,
      priceMin: 6000,
      scale: { maxSize: 10, p95Size: 0, totalCells: 1 },
      trades: [],
    });
    const singlePlot = buildLiquidityHeatmapPlot(singlePriceDoc);
    expect(singlePlot.gapRects).toHaveLength(1);
    expect(singlePlot.gapRects[0]?.endIndex).toBe(1);
    expect(singlePlot.cells).toEqual([]);
    expect(singlePlot.priceTicks).toHaveLength(1);
    expect(singlePlot.midDots).toHaveLength(1);
  });

  it("formats column inspection summaries, wall rows, trade rows, aria label, and rule line", () => {
    const doc = makeDoc();
    expect(inspectColumnSummary(doc, -1)).toBeNull();
    expect(inspectColumnSummary(doc, 99)).toBeNull();

    const rec = inspectColumnSummary(doc, 0);
    expect(rec?.captureLabel).toBe("Streamed");
    expect(rec?.midLabel).toBe("6,001.13");
    expect(rec?.spreadLabel).toBe("0.25");
    expect(rec?.topLevelLabel).toBe("90 ask @ 6,002.00");

    const gap = inspectColumnSummary(doc, 2);
    expect(gap?.captureLabel).toBe("No data gap");
    expect(gap?.midLabel).toBe("No price");
    expect(gap?.spreadLabel).toBe("No spread");
    expect(gap?.topLevelLabel).toBe("No resting depth");

    const sampled = inspectColumnSummary(doc, 3);
    expect(sampled?.captureLabel).toBe("Sampled");
    expect(sampled?.midLabel).toBe("No price");
    expect(sampled?.spreadLabel).toBe("No spread");

    // Out-of-bounds cell p index falls back to "No resting depth"
    const badCellDoc = makeDoc({
      columns: [
        {
          bestAsk: 6001,
          bestBid: 6000,
          capture: "streamed",
          cells: [{ p: 9, s: 50, side: "bid" }],
          mid: 6000.5,
          state: "recorded",
          t: "2026-11-23T14:55:00.000Z",
        },
      ],
    });
    expect(inspectColumnSummary(badCellDoc, 0)?.topLevelLabel).toBe(
      "No resting depth"
    );

    const walls = wallRows(doc);
    expect(walls).toEqual([
      {
        key: "ask:6002",
        persistence: "75% (3 col)",
        price: "6,002.00",
        side: "Ask",
        size: "100",
      },
      {
        key: "bid:6001",
        persistence: "100% (4 col)",
        price: "6,001.00",
        side: "Bid",
        size: "80",
      },
    ]);

    const trades = tradeRows(doc);
    expect(trades).toHaveLength(2);
    expect(trades[0]?.side).toBe("Sell");
    expect(trades[0]?.signing).toBe("Tick");
    expect(trades[1]?.side).toBe("Buy");
    expect(trades[1]?.signing).toBe("Quote");

    expect(heatmapAriaLabel(doc)).toContain(
      "ES Bookmap-style liquidity heatmap"
    );
    expect(heatmapRuleLine(doc)).toContain("95th percentile");
    expect(heatmapRuleLine(doc)).not.toContain("newest");
  });
});
