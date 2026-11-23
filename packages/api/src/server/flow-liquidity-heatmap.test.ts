import type {
  FlowBookSnapshotRecord,
  FlowLargeTradeRecord,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildFlowLiquidityHeatmapFromRows,
  FLOW_BOOK_SNAPSHOTS_READ_LIMIT,
  readFlowLiquidityHeatmapRows,
} from "./flow-liquidity-heatmap.ts";

describe("flow-liquidity-heatmap server assembly", () => {
  it("reads snapshots, large trades, and depth freshness with 3-minute left buffer and builds flow-liquidity-heatmap.v1", async () => {
    const now = new Date("2026-11-23T15:00:00.000Z");
    const snap: FlowBookSnapshotRecord = {
      askPrices: [6000.25],
      askSizes: [30],
      bestAsk: 6000.25,
      bestBid: 6000,
      bidPrices: [6000],
      bidSizes: [40],
      capture: "streamed",
      capturedAt: new Date("2026-11-23T14:58:00.000Z"),
      contract: "ESZ6",
      minTick: 0.25,
      symbol: "ES",
    };
    const trade: FlowLargeTradeRecord = {
      capture: "streamed",
      limitSize: 40,
      price: 6000.25,
      sampledAt: now,
      second: new Date("2026-11-23T14:58:02.000Z"),
      seq: 0,
      side: "buy",
      signing: "quote",
      size: 60,
      symbol: "ES",
    };
    const repo = {
      latestSamples: vi.fn(async () => ({
        latest: [
          {
            at: now,
            items: 12,
            message: "streamed depth ESZ6: 12 snapshots, 20 levels",
            source: "depth" as const,
            status: "ok" as const,
            symbol: "ES" as const,
          },
        ],
        latestOk: [
          {
            at: now,
            items: 12,
            message: "streamed depth ESZ6: 12 snapshots, 20 levels",
            source: "depth" as const,
            status: "ok" as const,
            symbol: "ES" as const,
          },
        ],
      })),
      readBookSnapshots: vi.fn(async () => [snap]),
      readLargeTrades: vi.fn(async () => [trade]),
    };

    const rows = await readFlowLiquidityHeatmapRows(
      repo,
      { minutes: 15, symbol: "ES" },
      now
    );

    expect(repo.readBookSnapshots).toHaveBeenCalledWith({
      from: new Date("2026-11-23T14:42:00.000Z"),
      limit: FLOW_BOOK_SNAPSHOTS_READ_LIMIT,
      symbol: "ES",
      to: now,
    });
    expect(repo.readLargeTrades).toHaveBeenCalledWith({
      from: new Date("2026-11-23T14:42:00.000Z"),
      symbol: "ES",
      to: now,
    });
    expect(repo.latestSamples).toHaveBeenCalledWith("ES", ["depth"]);

    const doc = buildFlowLiquidityHeatmapFromRows(rows);
    expect(doc.symbol).toBe("ES");
    expect(doc.capture).toBe("streamed");
    expect(doc.contract).toBe("ESZ6");
    expect(doc.depth.state).toBe("fresh");
    expect(doc.trades).toHaveLength(1);
    expect(doc.walls[0]?.size).toBe(40);
  });
});
