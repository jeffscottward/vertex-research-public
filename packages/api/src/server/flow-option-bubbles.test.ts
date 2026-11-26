import { describe, expect, it } from "vitest";
import { FlowOptionBubblesSchema } from "../contracts/flow.ts";
import { buildFlowOptionBubbles } from "./flow-option-bubbles.ts";

const NOW = new Date("2026-11-20T16:00:00.000Z");

describe("buildFlowOptionBubbles", () => {
  it("returns an empty valid document when session is null", () => {
    const doc = buildFlowOptionBubbles({
      gaps: [],
      latest: [],
      latestOk: [],
      minPremiumUsd: 250_000,
      minutes: [],
      now: NOW,
      prints: [],
      session: null,
      symbol: "ES",
    });

    expect(FlowOptionBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc).toMatchObject({
      bubbles: [],
      gaps: [],
      minPremiumUsd: 250_000,
      pricePoints: [],
      schemaVersion: "flow-option-bubbles.v1",
      session: null,
      sessionEnd: null,
      sessionStart: null,
      storedUntil: null,
      symbol: "ES",
      ticker: "SPX",
      truncated: false,
      unread: null,
    });
    expect(doc.options.state).toBe("never");
  });

  it("assembles a populated SPY document with options freshness and session bounds", () => {
    const sampleAt = new Date("2026-11-20T15:59:30.000Z");
    const doc = buildFlowOptionBubbles({
      gaps: [
        {
          endTime: new Date("2026-11-20T15:20:00.000Z"),
          startTime: new Date("2026-11-20T15:10:00.000Z"),
        },
      ],
      latest: [
        {
          at: sampleAt,
          items: 40,
          message: null,
          source: "options",
          status: "ok",
          symbol: "SPY",
        },
      ],
      latestOk: [
        {
          at: sampleAt,
          items: 40,
          message: null,
          source: "options",
          status: "ok",
          symbol: "SPY",
        },
      ],
      minPremiumUsd: 500_000,
      minutes: [
        {
          callPremium: 700_000,
          callPrints: 2,
          lastPrice: 684.2,
          lastTradedAt: new Date("2026-11-20T15:30:40.000Z"),
          minute: new Date("2026-11-20T15:30:00.000Z"),
          putPremium: 100_000,
          putPrints: 1,
        },
      ],
      now: NOW,
      prints: [
        {
          consolidation: "sweep",
          dte: 3,
          expiry: "2026-11-23",
          goldenSweep: true,
          id: "spy-big-1",
          iv: 17.4,
          moneyness: "otm",
          openInterest: 12_000,
          opening: true,
          premium: 650_000,
          price: 3.25,
          right: "call",
          sentiment: "bullish",
          side: "above_ask",
          size: 2000,
          strike: 686,
          ticker: "SPY",
          tradedAt: new Date("2026-11-20T15:30:22.000Z"),
          underlyingPrice: 684.15,
          unusual: true,
          volumeOverOi: true,
        },
      ],
      session: "2026-11-20",
      symbol: "SPY",
    });

    expect(FlowOptionBubblesSchema.parse(doc)).toEqual(doc);
    expect(doc.session).toBe("2026-11-20");
    expect(doc.sessionStart).toBe("2026-11-20T14:30:00.000Z");
    expect(doc.sessionEnd).toBe("2026-11-20T21:15:00.000Z");
    expect(doc.options.state).toBe("fresh");
    expect(doc.bubbles).toHaveLength(1);
    expect(doc.pricePoints).toHaveLength(1);
    expect(doc.unread?.ranges).toBe(1);
  });
});
