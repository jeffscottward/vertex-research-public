import type {
  FlowLargeTradeRecord,
  FlowMinuteRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import { FlowTradeBubblesSchema } from "../contracts/flow.ts";
import {
  buildFlowTradeBubblesFromRows,
  readFlowTradeBubblesRows,
} from "./flow-trade-bubbles.ts";

const makeRepo = (over: {
  newest?: Date | null;
  minutes?: FlowMinuteRecord[];
  trades?: FlowLargeTradeRecord[];
  latest?: FlowSampleRecord[];
  latestOk?: FlowSampleRecord[];
}) => {
  const repo: Pick<
    FlowRepository,
    "latestSamples" | "newestDataAt" | "readLargeTrades" | "readMinutes"
  > = {
    latestSamples: vi.fn(async () => ({
      latest: over.latest ?? [],
      latestOk: over.latestOk ?? [],
    })),
    newestDataAt: vi.fn(async () => over.newest ?? null),
    readLargeTrades: vi.fn(async () => over.trades ?? []),
    readMinutes: vi.fn(async () => over.minutes ?? []),
  };
  return repo;
};

describe("flow-trade-bubbles server assembly", () => {
  it("anchors windowEnd to newest + 60s (clamped to now) so trades inside the newest minute are kept", async () => {
    const now = new Date("2026-11-23T18:00:00.000Z");
    const newest = new Date("2026-11-23T15:59:00.000Z");
    const minuteBar: FlowMinuteRecord = {
      absorption: null,
      buyVolume: 800,
      close: 6012.5,
      coveredSeconds: 60,
      delta: 100,
      high: 6013,
      largePrints: 1,
      largePrintVolume: 85,
      low: 6011.25,
      minute: newest,
      offExchangeVolume: 0,
      open: 6011.5,
      sellVolume: 700,
      stackedBuy: 0,
      stackedSell: 0,
      symbol: "ES",
      trades: 310,
      volume: 1500,
      vwap: 6012.25,
    };
    const trade: FlowLargeTradeRecord = {
      capture: "streamed",
      limitSize: 40,
      price: 6012.75,
      sampledAt: new Date("2026-11-23T15:59:55.000Z"),
      second: new Date("2026-11-23T15:59:42.000Z"),
      seq: 0,
      side: "buy",
      signing: "quote",
      size: 85,
      symbol: "ES",
    };
    const sample: FlowSampleRecord = {
      at: new Date("2026-11-23T15:59:55.000Z"),
      items: 1,
      message: null,
      source: "ticks",
      status: "ok",
      symbol: "ES",
    };
    const repo = makeRepo({
      latest: [sample],
      latestOk: [sample],
      minutes: [minuteBar],
      newest,
      trades: [trade],
    });

    const rows = await readFlowTradeBubblesRows(
      repo,
      { minutes: 60, symbol: "ES" },
      now
    );
    expect(rows.windowEnd.toISOString()).toBe("2026-11-23T16:00:00.000Z");
    expect(rows.windowStart.toISOString()).toBe("2026-11-23T15:00:00.000Z");
    expect(repo.readMinutes).toHaveBeenCalledWith({
      from: new Date("2026-11-23T15:00:00.000Z"),
      symbol: "ES",
      to: new Date("2026-11-23T16:00:00.000Z"),
    });
    expect(repo.readLargeTrades).toHaveBeenCalledWith({
      from: new Date("2026-11-23T15:00:00.000Z"),
      symbol: "ES",
      to: new Date("2026-11-23T16:00:00.000Z"),
    });
    expect(repo.latestSamples).toHaveBeenCalledWith("ES", ["ticks"]);

    const doc = buildFlowTradeBubblesFromRows(rows);
    expect(FlowTradeBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc.bubbles).toHaveLength(1);
    expect(doc.candles).toHaveLength(1);
    expect(doc.totals.buyVolume).toBe(85);
  });

  it("uses now when newestDataAt is null or at/after now", async () => {
    const now = new Date("2026-11-23T15:00:30.000Z");
    const repoNull = makeRepo({ newest: null });
    const rowsNull = await readFlowTradeBubblesRows(
      repoNull,
      { minutes: 30, symbol: "NQ" },
      now
    );
    expect(rowsNull.windowEnd.toISOString()).toBe(now.toISOString());
    expect(rowsNull.windowStart.toISOString()).toBe("2026-11-23T14:30:30.000Z");

    const repoFuture = makeRepo({
      newest: new Date("2026-11-23T15:01:00.000Z"),
    });
    const rowsFuture = await readFlowTradeBubblesRows(
      repoFuture,
      { minutes: 15, symbol: "NQ" },
      now
    );
    expect(rowsFuture.windowEnd.toISOString()).toBe(now.toISOString());
  });
});
