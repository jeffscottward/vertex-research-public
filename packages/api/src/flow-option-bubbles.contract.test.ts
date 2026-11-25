import { describe, expect, it } from "vitest";
import {
  FLOW_OPTION_BUBBLES_MAX_BUBBLES,
  FLOW_OPTION_BUBBLES_MAX_GAPS,
  FLOW_OPTION_BUBBLES_MAX_POINTS,
  FLOW_OPTION_BUBBLES_MIN_PREMIUMS,
  FLOW_OPTION_BUBBLES_SYMBOLS,
  FLOW_OPTION_BUBBLES_VERSION,
  type FlowOptionBubbles,
  FlowOptionBubblesInputSchema,
  FlowOptionBubblesSchema,
  flowContract,
} from "./contracts/flow.ts";

const sampleDocument: FlowOptionBubbles = {
  bubbles: [
    {
      at: "2026-11-20T15:14:22.000Z",
      consolidation: "sweep",
      contract: "SPY 2026-11-27 685C",
      directionalSign: 1,
      dte: 7,
      expiry: "2026-11-27",
      goldenSweep: true,
      id: "print-1",
      iv: 18.2,
      moneyness: "otm",
      opening: true,
      premium: 1_420_000,
      price: 3.38,
      right: "call",
      sentiment: "bullish",
      side: "above_ask",
      size: 4200,
      strike: 685,
      underlyingPrice: 683.42,
      unusual: true,
      volumeOverOi: true,
    },
  ],
  gaps: [
    {
      end: "2026-11-20T16:15:00.000Z",
      start: "2026-11-20T16:00:00.000Z",
    },
  ],
  minPremiumUsd: 250_000,
  options: {
    ageSeconds: 18,
    lastOkAt: "2026-11-20T16:30:00.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  pricePoints: [
    {
      minute: "2026-11-20T15:14:00.000Z",
      price: 683.42,
      unread: false,
    },
  ],
  rules: {
    defaultMinPremiumUsd: 250_000,
    maxBubbles: FLOW_OPTION_BUBBLES_MAX_BUBBLES,
    retentionDays: 14,
    storedMinPremiumUsd: 10_000,
    version: "option-bubbles.v1",
  },
  schemaVersion: FLOW_OPTION_BUBBLES_VERSION,
  session: "2026-11-20",
  sessionEnd: "2026-11-20T21:15:00.000Z",
  sessionStart: "2026-11-20T14:30:00.000Z",
  storedUntil: "2026-11-20T15:14:22.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    askSidePremium: 1_420_000,
    bearishPremium: 0,
    bidSidePremium: 0,
    bullishPremium: 1_420_000,
    callBubbles: 1,
    callPremium: 1_420_000,
    latestPrice: 683.42,
    maxBubblePremium: 1_420_000,
    plottedBubbles: 1,
    putBubbles: 0,
    putPremium: 0,
    sessionGrossPremium: 8_200_000,
    sessionPrints: 190,
    shownBubbles: 1,
    unplottedBubbles: 0,
    unsignedPremium: 0,
  },
  truncated: false,
  unread: {
    from: "2026-11-20T16:00:00.000Z",
    ranges: 1,
    to: "2026-11-20T16:15:00.000Z",
  },
};

describe("flow.optionBubbles input contract", () => {
  it("accepts SPY and ES with default or explicit numeric/string minPremiumUsd thresholds", () => {
    expect(FLOW_OPTION_BUBBLES_SYMBOLS).toEqual(["SPY", "ES"]);
    expect(FLOW_OPTION_BUBBLES_MIN_PREMIUMS).toEqual([
      100_000, 250_000, 500_000, 1_000_000,
    ]);

    expect(FlowOptionBubblesInputSchema.parse({ symbol: "SPY" })).toEqual({
      minPremiumUsd: 250_000,
      symbol: "SPY",
    });

    for (const threshold of FLOW_OPTION_BUBBLES_MIN_PREMIUMS) {
      expect(
        FlowOptionBubblesInputSchema.parse({
          minPremiumUsd: threshold,
          symbol: "ES",
        })
      ).toEqual({
        minPremiumUsd: threshold,
        symbol: "ES",
      });
      expect(
        FlowOptionBubblesInputSchema.parse({
          minPremiumUsd: String(threshold),
          symbol: "SPY",
        })
      ).toEqual({
        minPremiumUsd: threshold,
        symbol: "SPY",
      });
    }
  });

  it("rejects unsupported symbols, unsupported premium floors, and extra fields", () => {
    expect(
      FlowOptionBubblesInputSchema.safeParse({ symbol: "QQQ" }).success
    ).toBe(false);
    expect(
      FlowOptionBubblesInputSchema.safeParse({ symbol: "NQ" }).success
    ).toBe(false);
    expect(
      FlowOptionBubblesInputSchema.safeParse({
        minPremiumUsd: 50_000,
        symbol: "SPY",
      }).success
    ).toBe(false);
    expect(
      FlowOptionBubblesInputSchema.safeParse({
        extra: true,
        symbol: "SPY",
      }).success
    ).toBe(false);
  });
});

describe("flow-option-bubbles.v1 output contract", () => {
  it("accepts valid documents and enforces strict caps and field bounds", () => {
    expect(FlowOptionBubblesSchema.parse(sampleDocument)).toEqual(
      sampleDocument
    );

    expect(
      FlowOptionBubblesSchema.safeParse({
        ...sampleDocument,
        extra: "nope",
      }).success
    ).toBe(false);

    expect(
      FlowOptionBubblesSchema.safeParse({
        ...sampleDocument,
        bubbles: Array.from(
          { length: FLOW_OPTION_BUBBLES_MAX_BUBBLES + 1 },
          (_, i) => ({
            ...sampleDocument.bubbles[0],
            id: `p-${i}`,
          })
        ),
      }).success
    ).toBe(false);

    expect(
      FlowOptionBubblesSchema.safeParse({
        ...sampleDocument,
        pricePoints: Array.from(
          { length: FLOW_OPTION_BUBBLES_MAX_POINTS + 1 },
          (_, i) => ({
            minute: new Date(
              Date.parse("2026-11-20T14:30:00.000Z") + i * 60_000
            ).toISOString(),
            price: 683,
            unread: false,
          })
        ),
      }).success
    ).toBe(false);

    expect(
      FlowOptionBubblesSchema.safeParse({
        ...sampleDocument,
        gaps: Array.from({ length: FLOW_OPTION_BUBBLES_MAX_GAPS + 1 }, () => ({
          end: "2026-11-20T16:15:00.000Z",
          start: "2026-11-20T16:00:00.000Z",
        })),
      }).success
    ).toBe(false);
  });

  it("exposes flow.optionBubbles as GET /flow/option-bubbles", () => {
    expect(flowContract.optionBubbles["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "flow.optionBubbles",
      path: "/flow/option-bubbles",
    });
  });
});
