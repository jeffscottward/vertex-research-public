import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  FLOW_TRADE_BUBBLES_MAX_BUBBLES,
  FLOW_TRADE_BUBBLES_MAX_CANDLES,
  FLOW_TRADE_BUBBLES_RULES_VERSION,
  FLOW_TRADE_BUBBLES_VERSION,
  FlowTradeBubblesInputSchema,
  FlowTradeBubblesSchema,
} from "./contracts/flow.ts";

const sampleDocument = () => ({
  bubbles: [
    {
      capture: "streamed" as const,
      limitSize: 40,
      price: 6012.25,
      second: "2026-11-23T14:32:10.000Z",
      seq: 0,
      side: "buy" as const,
      signing: "quote" as const,
      size: 85,
      sizeMultiple: 2.13,
    },
  ],
  candles: [
    {
      close: 6012.5,
      coveredSeconds: 60,
      high: 6013,
      low: 6011.25,
      minute: "2026-11-23T14:32:00.000Z",
      open: 6011.5,
      volume: 1450,
      vwap: 6012.1,
    },
  ],
  captureMode: "streamed" as const,
  minutes: 60,
  priceRange: { max: 6013, min: 6011.25 },
  rules: {
    deepTradeLimit: 40,
    deepTradeLimitMeasuredOn: "2026-11-13",
    maxBubbles: FLOW_TRADE_BUBBLES_MAX_BUBBLES,
    retentionDays: 730,
    version: FLOW_TRADE_BUBBLES_RULES_VERSION,
  },
  schemaVersion: FLOW_TRADE_BUBBLES_VERSION,
  symbol: "ES" as const,
  tape: {
    ageSeconds: 12,
    lastOkAt: "2026-11-23T14:35:00.000Z",
    lastStatus: "ok" as const,
    message: null,
    sessionOpen: true,
    source: "ticks" as const,
    state: "fresh" as const,
  },
  tickSize: 0.25,
  totals: {
    buyTrades: 1,
    buyVolume: 85,
    largestBubble: {
      capture: "streamed" as const,
      limitSize: 40,
      price: 6012.25,
      second: "2026-11-23T14:32:10.000Z",
      seq: 0,
      side: "buy" as const,
      signing: "quote" as const,
      size: 85,
      sizeMultiple: 2.13,
    },
    maxSize: 85,
    netVolume: 85,
    p95Size: 85,
    sellTrades: 0,
    sellVolume: 0,
    shownTrades: 1,
    totalTrades: 1,
    truncated: false,
  },
  windowEnd: "2026-11-23T14:35:00.000Z",
  windowStart: "2026-11-23T13:35:00.000Z",
});

describe("flow.tradeBubbles input contract", () => {
  it("accepts ES and NQ with numeric or string window minutes and defaults to 120", () => {
    expect(FlowTradeBubblesInputSchema.parse({ symbol: "ES" })).toEqual({
      minutes: 120,
      symbol: "ES",
    });
    expect(
      FlowTradeBubblesInputSchema.parse({ minutes: "120", symbol: "NQ" })
    ).toEqual({
      minutes: 120,
      symbol: "NQ",
    });
    expect(
      FlowTradeBubblesInputSchema.parse({ minutes: 390, symbol: "ES" })
    ).toEqual({
      minutes: 390,
      symbol: "ES",
    });
  });

  it.each([
    [{ symbol: "SPY" }],
    [{ symbol: "QQQ" }],
    [{ minutes: 14, symbol: "ES" }],
    [{ minutes: 391, symbol: "ES" }],
    [{ minutes: 60.5, symbol: "NQ" }],
    [{ extra: true, symbol: "ES" }],
    [{}],
  ])("refuses %j", (input) => {
    expect(FlowTradeBubblesInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("flow-trade-bubbles.v1 output contract", () => {
  it("accepts a valid document and registers GET /flow/trade-bubbles", () => {
    expect(FlowTradeBubblesSchema.parse(sampleDocument())).toEqual(
      sampleDocument()
    );
    const meta = appContract.flow.tradeBubbles["~orpc"];
    expect(meta.route).toMatchObject({
      method: "GET",
      operationId: "flow.tradeBubbles",
      path: "/flow/trade-bubbles",
    });
  });

  it("enforces caps on candles and bubbles and rejects unknown fields", () => {
    const doc = sampleDocument();
    expect(
      FlowTradeBubblesSchema.safeParse({ ...doc, unexpected: 1 }).success
    ).toBe(false);
    expect(
      FlowTradeBubblesSchema.safeParse({
        ...doc,
        bubbles: Array.from(
          { length: FLOW_TRADE_BUBBLES_MAX_BUBBLES + 1 },
          (_, seq) => ({ ...doc.bubbles[0], seq })
        ),
      }).success
    ).toBe(false);
    expect(
      FlowTradeBubblesSchema.safeParse({
        ...doc,
        candles: Array.from(
          { length: FLOW_TRADE_BUBBLES_MAX_CANDLES + 1 },
          () => doc.candles[0]
        ),
      }).success
    ).toBe(false);
  });
});
