import { describe, expect, it } from "vitest";
import {
  FLOW_LIQUIDITY_HEATMAP_RULES_VERSION,
  FLOW_LIQUIDITY_HEATMAP_VERSION,
  FlowLiquidityHeatmapInputSchema,
  FlowLiquidityHeatmapSchema,
  flowContract,
} from "./contracts/flow.ts";

describe("flow.liquidityHeatmap contract", () => {
  it("parses valid input with default 120 minutes and rejects non-futures or out-of-range windows", () => {
    expect(FlowLiquidityHeatmapInputSchema.parse({ symbol: "ES" })).toEqual({
      minutes: 120,
      symbol: "ES",
    });
    expect(
      FlowLiquidityHeatmapInputSchema.parse({ minutes: "15", symbol: "NQ" })
    ).toEqual({
      minutes: 15,
      symbol: "NQ",
    });
    expect(() =>
      FlowLiquidityHeatmapInputSchema.parse({ symbol: "SPY" })
    ).toThrow();
    expect(() =>
      FlowLiquidityHeatmapInputSchema.parse({ minutes: 5, symbol: "ES" })
    ).toThrow();
    expect(() =>
      FlowLiquidityHeatmapInputSchema.parse({ minutes: 400, symbol: "ES" })
    ).toThrow();
    expect(() =>
      FlowLiquidityHeatmapInputSchema.parse({ extra: 1, symbol: "ES" })
    ).toThrow();
  });

  it("validates a strict flow-liquidity-heatmap.v1 payload and exposes GET /flow/liquidity-heatmap", () => {
    expect(flowContract.liquidityHeatmap["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "flow.liquidityHeatmap",
      path: "/flow/liquidity-heatmap",
      tags: ["Flow"],
    });
    const sample = {
      axisEnd: "2026-11-23T15:00:05.000Z",
      axisStart: "2026-11-23T14:45:05.000Z",
      capture: "streamed" as const,
      columnSeconds: 5,
      columns: [
        {
          bestAsk: 6000.25,
          bestBid: 6000,
          capture: "streamed" as const,
          cells: [{ p: 0, s: 45, side: "bid" as const }],
          mid: 6000.125,
          state: "recorded" as const,
          t: "2026-11-23T14:59:55.000Z",
        },
      ],
      contract: "ESZ6",
      currentDom: [{ askSize: 30, bidSize: 45, p: 0, price: 6000 }],
      depth: {
        ageSeconds: 5,
        lastOkAt: "2026-11-23T15:00:00.000Z",
        lastStatus: "ok" as const,
        message: "streamed depth ESZ6: 12 snapshots, 20 levels",
        sessionOpen: true,
        source: "depth" as const,
        state: "fresh" as const,
      },
      minTick: 0.25,
      priceLevels: [6000, 6000.25],
      priceMax: 6000.25,
      priceMin: 6000,
      priceStep: 0.25,
      rules: {
        intensityQuantile: 0.95,
        largeTradeLimit: 40,
        maxColumns: 240,
        maxPriceBuckets: 80,
        sampleSeconds: 5,
        version: FLOW_LIQUIDITY_HEATMAP_RULES_VERSION,
      },
      scale: { maxSize: 45, p95Size: 45, totalCells: 1 },
      schemaVersion: FLOW_LIQUIDITY_HEATMAP_VERSION,
      symbol: "ES" as const,
      totals: {
        coveragePct: 100,
        largeTrades: 1,
        recordedColumns: 1,
        snapshots: 1,
        totalColumns: 1,
      },
      trades: [
        {
          capture: "streamed" as const,
          price: 6000.25,
          side: "buy" as const,
          signing: "quote" as const,
          size: 55,
          t: "2026-11-23T14:59:56.000Z",
        },
      ],
      tradesTruncated: false,
      walls: [
        {
          columnsPresent: 1,
          persistencePct: 100,
          price: 6000,
          side: "bid" as const,
          size: 45,
        },
      ],
      windowEnd: "2026-11-23T15:00:00.000Z",
      windowStart: "2026-11-23T14:45:00.000Z",
    };
    expect(FlowLiquidityHeatmapSchema.parse(sample)).toEqual(sample);
    expect(() =>
      FlowLiquidityHeatmapSchema.parse({ ...sample, unexpected: true })
    ).toThrow();
  });
});
