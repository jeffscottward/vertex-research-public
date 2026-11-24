import { describe, expect, it } from "vitest";
import { FlowStrikeHeatmapSchema } from "../contracts/flow.ts";
import {
  buildFlowStrikeHeatmap,
  type FlowStrikeHeatmapRows,
} from "./flow-strike-heatmap.ts";

const NOW = new Date("2026-11-20T15:02:00.000Z");

const okSample = {
  at: new Date("2026-11-20T15:01:00.000Z"),
  items: 12,
  message: "quantdata flow: 12 prints",
  source: "options" as const,
  status: "ok" as const,
  symbol: "SPY" as const,
};

const baseRows = (
  overrides: Partial<FlowStrikeHeatmapRows> = {}
): FlowStrikeHeatmapRows => ({
  bucketMinutes: 15,
  buckets: [
    {
      lastTradedAt: new Date("2026-11-20T14:40:00.000Z"),
      premium: 400_000,
      prints: 4,
      right: "call",
      side: "ask",
      slotIndex: 0,
      strike: 602,
      volume: 400,
    },
  ],
  gaps: [],
  latest: [okSample],
  latestOk: [okSample],
  now: NOW,
  session: "2026-11-20",
  slotPrices: [
    {
      price: 600.8,
      pricedAt: new Date("2026-11-20T14:40:00.000Z"),
      slotIndex: 0,
    },
  ],
  symbol: "SPY",
  ...overrides,
});

describe("buildFlowStrikeHeatmap", () => {
  it("builds a schema-valid heatmap for SPY and clips overlapping open gaps to the session", () => {
    const doc = buildFlowStrikeHeatmap(
      baseRows({
        gaps: [
          // Starts before 09:30 ET (14:30Z) and overlaps into slot 0
          {
            endTime: new Date("2026-11-20T14:40:00.000Z"),
            startTime: new Date("2026-11-20T14:00:00.000Z"),
          },
          // Point gap right at session open
          {
            endTime: new Date("2026-11-20T14:30:00.000Z"),
            startTime: new Date("2026-11-20T14:30:00.000Z"),
          },
          // Outside session -> ignored
          {
            endTime: new Date("2026-11-20T22:00:00.000Z"),
            startTime: new Date("2026-11-20T21:15:00.000Z"),
          },
        ],
      })
    );
    expect(FlowStrikeHeatmapSchema.parse(doc)).toEqual(doc);
    expect(doc.ticker).toBe("SPY");
    expect(doc.unread).toEqual({
      from: "2026-11-20T14:30:00.000Z",
      ranges: 2,
      to: "2026-11-20T14:40:00.000Z",
    });
    expect(doc.slots[0]?.unread).toBe(true);
    expect(doc.options.state).toBe("fresh");
  });

  it("returns unread: null for a complete session with no overlapping gaps", () => {
    const doc = buildFlowStrikeHeatmap(baseRows({ gaps: [] }));
    expect(FlowStrikeHeatmapSchema.parse(doc)).toEqual(doc);
    expect(doc.unread).toBeNull();
    expect(doc.slots[0]?.unread).toBe(false);
  });

  it("maps ES to SPX ticker and handles null session cleanly", () => {
    const doc = buildFlowStrikeHeatmap(
      baseRows({
        bucketMinutes: 30,
        buckets: [],
        gaps: [],
        latest: [],
        latestOk: [],
        session: null,
        slotPrices: [],
        symbol: "ES",
      })
    );
    expect(FlowStrikeHeatmapSchema.parse(doc)).toEqual(doc);
    expect(doc.symbol).toBe("ES");
    expect(doc.ticker).toBe("SPX");
    expect(doc.session).toBeNull();
    expect(doc.unread).toBeNull();
    expect(doc.slots).toEqual([]);
    expect(doc.strikes).toEqual([]);
    expect(doc.cells).toEqual([]);
    expect(doc.options.state).toBe("never");
  });
});
