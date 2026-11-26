import { describe, expect, it } from "vitest";

import {
  FLOW_TRADE_BUBBLES_MAX_BUBBLES,
  FLOW_TRADE_BUBBLES_MAX_CANDLES,
  FLOW_TRADE_BUBBLES_RULES_VERSION,
  FLOW_TRADE_BUBBLES_VERSION,
  type FlowFreshness,
  FlowTradeBubblesSchema,
} from "./contracts/flow.ts";
import {
  buildFlowTradeBubbles,
  FLOW_TRADE_BUBBLES_RETENTION_DAYS,
  type StoredTradeBubbleInput,
  type StoredTradeCandleInput,
} from "./flow-trade-bubbles-rules.ts";

const START = new Date("2026-11-23T14:00:00.000Z");
const END = new Date("2026-11-23T15:00:00.000Z");

const freshTape: FlowFreshness = {
  ageSeconds: 8,
  lastOkAt: "2026-11-23T14:59:52.000Z",
  lastStatus: "ok",
  message: null,
  sessionOpen: true,
  source: "ticks",
  state: "fresh",
};
const makeCandle = (
  minuteOffset: number,
  over: Partial<StoredTradeCandleInput> = {}
): StoredTradeCandleInput => ({
  close: 6002,
  coveredSeconds: 60,
  high: 6003,
  low: 6000.5,
  minute: new Date(START.getTime() + minuteOffset * 60_000),
  open: 6001,
  volume: 1200,
  vwap: 6001.75,
  ...over,
});

const makeTrade = (
  secondOffset: number,
  over: Partial<StoredTradeBubbleInput> = {}
): StoredTradeBubbleInput => ({
  capture: "streamed",
  limitSize: 40,
  price: 6002,
  second: new Date(START.getTime() + secondOffset * 1000),
  seq: 0,
  side: "buy",
  signing: "quote",
  size: 60,
  ...over,
});

describe("buildFlowTradeBubbles", () => {
  it("returns an empty valid document when no candles or large trades exist", () => {
    const doc = buildFlowTradeBubbles({
      largeTrades: [],
      minuteBars: [],
      minutes: 60,
      symbol: "NQ",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });
    expect(FlowTradeBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc.schemaVersion).toBe(FLOW_TRADE_BUBBLES_VERSION);
    expect(doc.symbol).toBe("NQ");
    expect(doc.captureMode).toBe("none");
    expect(doc.priceRange).toBeNull();
    expect(doc.candles).toEqual([]);
    expect(doc.bubbles).toEqual([]);
    expect(doc.rules).toEqual({
      deepTradeLimit: 10,
      deepTradeLimitMeasuredOn: "2026-11-13",
      maxBubbles: FLOW_TRADE_BUBBLES_MAX_BUBBLES,
      retentionDays: FLOW_TRADE_BUBBLES_RETENTION_DAYS,
      version: FLOW_TRADE_BUBBLES_RULES_VERSION,
    });
    expect(doc.totals).toEqual({
      buyTrades: 0,
      buyVolume: 0,
      largestBubble: null,
      maxSize: null,
      netVolume: 0,
      p95Size: null,
      sellTrades: 0,
      sellVolume: 0,
      shownTrades: 0,
      totalTrades: 0,
      truncated: false,
    });
  });

  it("sorts candles and bubbles chronologically, computes totals, p95, sizeMultiple, and priceRange", () => {
    const doc = buildFlowTradeBubbles({
      largeTrades: [
        makeTrade(125, {
          capture: "streamed",
          price: 6004.5,
          seq: 1,
          side: "sell",
          signing: "tick",
          size: 120,
        }),
        makeTrade(60, {
          capture: "streamed",
          price: 6001.25,
          seq: 0,
          side: "buy",
          signing: "quote",
          size: 40,
        }),
        makeTrade(125, {
          capture: "streamed",
          price: 6002.75,
          seq: 0,
          side: "buy",
          signing: "quote",
          size: 120,
        }),
      ],
      minuteBars: [
        makeCandle(2, { close: 6003.5, high: 6004, low: 6002, open: 6002.25 }),
        makeCandle(1, {
          close: 6002.25,
          high: 6002.5,
          low: 5999.75,
          open: 6001,
        }),
      ],
      minutes: 60,
      symbol: "ES",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });

    expect(FlowTradeBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc.captureMode).toBe("streamed");
    expect(doc.candles.map((c) => c.minute)).toEqual([
      "2026-11-23T14:01:00.000Z",
      "2026-11-23T14:02:00.000Z",
    ]);
    expect(
      doc.bubbles.map((b) => [b.second, b.seq, b.side, b.sizeMultiple])
    ).toEqual([
      ["2026-11-23T14:01:00.000Z", 0, "buy", 1],
      ["2026-11-23T14:02:05.000Z", 0, "buy", 3],
      ["2026-11-23T14:02:05.000Z", 1, "sell", 3],
    ]);
    expect(doc.priceRange).toEqual({ max: 6004.5, min: 5999.75 });
    expect(doc.totals.totalTrades).toBe(3);
    expect(doc.totals.shownTrades).toBe(3);
    expect(doc.totals.truncated).toBe(false);
    expect(doc.totals.buyTrades).toBe(2);
    expect(doc.totals.sellTrades).toBe(1);
    expect(doc.totals.buyVolume).toBe(160);
    expect(doc.totals.sellVolume).toBe(120);
    expect(doc.totals.netVolume).toBe(40);
    expect(doc.totals.maxSize).toBe(120);
    expect(doc.totals.p95Size).toBe(120);
    // Tie on size (120 vs 120) breaks by newest (second, seq) -> seq 1 wins.
    expect(doc.totals.largestBubble?.seq).toBe(1);
    expect(doc.totals.largestBubble?.side).toBe("sell");
  });

  it("classifies sampled and mixed capture modes and drops invalid or out-of-window rows", () => {
    const sampledDoc = buildFlowTradeBubbles({
      largeTrades: [
        makeTrade(-10, { capture: "sampled", size: 50 }), // before window
        makeTrade(3600, { capture: "sampled", size: 50 }), // at windowEnd (exclusive)
        makeTrade(10, { capture: "sampled", price: 0, size: 50 }), // non-positive price
        makeTrade(11, { capture: "sampled", limitSize: 0, size: 50 }), // non-positive limit
        makeTrade(12, { capture: "sampled", size: Number.NaN }), // non-finite size
        makeTrade(13, { capture: "sampled", second: new Date("invalid") }), // invalid Date
        makeTrade(15, {
          capture: "sampled",
          price: 6005,
          seq: Number.NaN,
          size: 55,
        }),
      ],
      minuteBars: [
        makeCandle(-1), // before window
        makeCandle(60), // at windowEnd (exclusive)
        makeCandle(0, { minute: new Date("invalid") }), // invalid Date
        makeCandle(1, { open: 0 }),
        makeCandle(1, { high: 0 }),
        makeCandle(1, { low: 0 }),
        makeCandle(1, { close: 0 }),
        makeCandle(1, { vwap: 0 }),
        makeCandle(2, {
          close: 6002,
          high: 5999,
          low: 6005,
          open: 6001,
          vwap: 6001.5,
        }), // swapped high/low normalized
        makeCandle(3, { coveredSeconds: 99, volume: -5 }), // clamped coveredSeconds & volume
        makeCandle(4, { coveredSeconds: Number.NaN }), // non-finite coveredSeconds -> 0
      ],
      minutes: 60,
      symbol: "ES",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });
    expect(FlowTradeBubblesSchema.parse(sampledDoc)).toEqual(sampledDoc);
    expect(sampledDoc.captureMode).toBe("sampled");
    expect(sampledDoc.bubbles).toHaveLength(1);
    expect(sampledDoc.bubbles[0]?.seq).toBe(0);
    expect(sampledDoc.candles).toHaveLength(3);
    expect(sampledDoc.candles[0]?.low).toBe(5999);
    expect(sampledDoc.candles[0]?.high).toBe(6005);
    expect(sampledDoc.candles[1]?.coveredSeconds).toBe(60);
    expect(sampledDoc.candles[1]?.volume).toBe(0);
    expect(sampledDoc.candles[2]?.coveredSeconds).toBe(0);

    const mixedDoc = buildFlowTradeBubbles({
      largeTrades: [
        makeTrade(15, { capture: "sampled", seq: 0, size: 55 }),
        makeTrade(20, { capture: "streamed", seq: 0, size: 75 }),
      ],
      minuteBars: [],
      minutes: 60,
      symbol: "ES",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });
    expect(mixedDoc.captureMode).toBe("mixed");
    expect(mixedDoc.priceRange).toEqual({ max: 6002, min: 6002 });
  });

  it("truncates to the largest MAX_BUBBLES trades while preserving full window totals and chronological order", () => {
    const trades = Array.from(
      { length: FLOW_TRADE_BUBBLES_MAX_BUBBLES + 5 },
      (_, idx) =>
        makeTrade(idx + 1, {
          price: 6000 + (idx % 10) * 0.25,
          seq: idx,
          side: idx % 2 === 0 ? "buy" : "sell",
          size: idx < 5 ? 40 : 50 + idx,
        })
    );
    const candles = Array.from(
      { length: FLOW_TRADE_BUBBLES_MAX_CANDLES + 3 },
      (_, idx) => makeCandle(idx * 0.1)
    );
    const doc = buildFlowTradeBubbles({
      largeTrades: trades,
      minuteBars: candles,
      minutes: 60,
      symbol: "ES",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });
    expect(FlowTradeBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc.totals.totalTrades).toBe(FLOW_TRADE_BUBBLES_MAX_BUBBLES + 5);
    expect(doc.totals.shownTrades).toBe(FLOW_TRADE_BUBBLES_MAX_BUBBLES);
    expect(doc.totals.truncated).toBe(true);
    expect(doc.bubbles).toHaveLength(FLOW_TRADE_BUBBLES_MAX_BUBBLES);
    // The 5 smallest (size 40) were dropped; smallest kept is size 55 (idx 5).
    expect(Math.min(...doc.bubbles.map((b) => b.size))).toBe(55);
    // Chronological order preserved.
    for (let i = 1; i < doc.bubbles.length; i += 1) {
      const prev = doc.bubbles[i - 1]!;
      const curr = doc.bubbles[i]!;
      expect(Date.parse(prev.second) <= Date.parse(curr.second)).toBe(true);
    }
    expect(doc.candles).toHaveLength(FLOW_TRADE_BUBBLES_MAX_CANDLES);
  });

  it("breaks largestBubble ties by newer second even when seq is smaller", () => {
    const doc = buildFlowTradeBubbles({
      largeTrades: [
        makeTrade(10, { seq: 5, size: 100 }),
        makeTrade(20, { seq: 0, size: 100 }),
      ],
      minuteBars: [],
      minutes: 60,
      symbol: "ES",
      tape: freshTape,
      windowEnd: END,
      windowStart: START,
    });
    expect(doc.totals.largestBubble?.second).toBe("2026-11-23T14:00:20.000Z");
    expect(doc.totals.largestBubble?.seq).toBe(0);
  });
});
