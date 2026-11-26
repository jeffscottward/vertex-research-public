import { describe, expect, it } from "vitest";
import {
  bubbleDirectionalSign,
  foldOptionBubbles,
  OPTION_BUBBLES_RULES,
  type OptionBubblesMinuteRow,
  type OptionBubblesPrintRow,
} from "./flow-option-bubbles-rules.ts";

// Friday 2026-11-20 regular options hours (EST = UTC-5): 09:30 to 16:15 ET.
const RANGE = {
  from: new Date("2026-11-20T14:30:00.000Z"),
  to: new Date("2026-11-20T21:15:00.000Z"),
};

const makePrint = (
  id: string,
  tradedAt: string,
  overrides: Partial<OptionBubblesPrintRow> = {}
): OptionBubblesPrintRow => ({
  consolidation: "sweep",
  dte: 5,
  expiry: "2026-11-25",
  goldenSweep: false,
  id,
  iv: 16.5,
  moneyness: "otm",
  openInterest: 1000,
  opening: false,
  premium: 300_000,
  price: 2.5,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 1200,
  strike: 685,
  ticker: "SPY",
  tradedAt: new Date(tradedAt),
  underlyingPrice: 683.25,
  unusual: false,
  volumeOverOi: false,
  ...overrides,
});

const makeMinute = (
  minute: string,
  overrides: Partial<OptionBubblesMinuteRow> = {}
): OptionBubblesMinuteRow => ({
  callPremium: 200_000,
  callPrints: 4,
  lastPrice: 683.25,
  lastTradedAt: new Date(Date.parse(minute) + 45_000),
  minute: new Date(minute),
  putPremium: 150_000,
  putPrints: 3,
  ...overrides,
});

describe("bubbleDirectionalSign", () => {
  it("computes bullish (+1), bearish (-1), and unsigned (0) via shared OPTION_SIDE_SIGN", () => {
    expect(bubbleDirectionalSign("call", "above_ask")).toBe(1);
    expect(bubbleDirectionalSign("call", "ask")).toBe(1);
    expect(bubbleDirectionalSign("call", "bid")).toBe(-1);
    expect(bubbleDirectionalSign("call", "below_bid")).toBe(-1);
    expect(bubbleDirectionalSign("call", "mid")).toBe(0);
    expect(bubbleDirectionalSign("call", "unknown")).toBe(0);

    expect(bubbleDirectionalSign("put", "above_ask")).toBe(-1);
    expect(bubbleDirectionalSign("put", "ask")).toBe(-1);
    expect(bubbleDirectionalSign("put", "bid")).toBe(1);
    expect(bubbleDirectionalSign("put", "below_bid")).toBe(1);
    expect(bubbleDirectionalSign("put", "mid")).toBe(0);
    expect(bubbleDirectionalSign("put", "unknown")).toBe(0);
    expect(
      bubbleDirectionalSign("call", "unexpected" as unknown as "unknown")
    ).toBe(0);
    expect(
      bubbleDirectionalSign("put", "toString" as unknown as "unknown")
    ).toBe(0);
  });
});

describe("foldOptionBubbles", () => {
  it("exposes stable option-bubbles.v1 rules", () => {
    expect(OPTION_BUBBLES_RULES).toEqual({
      defaultMinPremiumUsd: 250_000,
      maxBubbles: 120,
      retentionDays: 14,
      storedMinPremiumUsd: 10_000,
      version: "option-bubbles.v1",
    });
  });

  it("folds price path, gaps, chronological bubbles, side/moneyness mapping, and totals", () => {
    const fold = foldOptionBubbles({
      gaps: [
        // Outside session (before)
        {
          endTime: new Date("2026-11-20T14:29:00.000Z"),
          startTime: new Date("2026-11-20T14:00:00.000Z"),
        },
        // Overlapping start (clipped to session open)
        {
          endTime: new Date("2026-11-20T14:35:00.000Z"),
          startTime: new Date("2026-11-20T14:20:00.000Z"),
        },
        // Zero-width gap aligned exactly to 15:00
        {
          endTime: new Date("2026-11-20T15:00:00.000Z"),
          startTime: new Date("2026-11-20T15:00:00.000Z"),
        },
        // Overlapping end (clipped to session close)
        {
          endTime: new Date("2026-11-20T21:30:00.000Z"),
          startTime: new Date("2026-11-20T21:10:00.000Z"),
        },
        // Outside session (after)
        {
          endTime: new Date("2026-11-20T22:00:00.000Z"),
          startTime: new Date("2026-11-20T21:15:00.000Z"),
        },
      ],
      minPremiumUsd: 250_000,
      minutes: [
        makeMinute("2026-11-20T15:00:00.000Z", { lastPrice: 684.1 }),
        makeMinute("2026-11-20T14:31:00.000Z", { lastPrice: 682.5 }),
        makeMinute("2026-11-20T14:40:00.000Z", { lastPrice: null }),
        makeMinute("2026-11-20T14:42:00.000Z", { lastPrice: 0 }),
        makeMinute("2026-11-20T14:43:00.000Z", { lastPrice: Number.NaN }),
        // Outside session range -> counted in session totals only if passed, never plotted
        makeMinute("2026-11-20T21:15:00.000Z", { lastPrice: 685 }),
      ],
      prints: [
        // Below floor -> ignored
        makePrint("below", "2026-11-20T14:35:00.000Z", { premium: 120_000 }),
        // Invalid strike -> ignored
        makePrint("bad-strike", "2026-11-20T14:36:00.000Z", { strike: 0 }),
        // Put above ask (bearish, ask-side)
        makePrint("p-2", "2026-11-20T15:05:00.000Z", {
          consolidation: "block",
          dte: -1,
          goldenSweep: true,
          iv: Number.POSITIVE_INFINITY,
          moneyness: "unknown",
          opening: true,
          premium: 900_000,
          price: Number.NaN,
          right: "put",
          sentiment: "bearish",
          side: "above_ask",
          strike: 680,
          underlyingPrice: 683.9,
          unusual: true,
          volumeOverOi: true,
        }),
        // Call at bid (bearish, bid-side, unplotted null underlyingPrice)
        makePrint("p-3", "2026-11-20T14:50:00.000Z", {
          moneyness: "atm",
          premium: 400_000,
          right: "call",
          sentiment: "bearish",
          side: "bid",
          underlyingPrice: null,
        }),
        // Put at below_bid (bullish, bid-side)
        makePrint("p-1", "2026-11-20T14:32:00.000Z", {
          moneyness: "itm",
          premium: 600_000,
          right: "put",
          sentiment: "bullish",
          side: "below_bid",
          underlyingPrice: 682.7,
        }),
        // Call at unknown side (unsigned, mid/not_classified)
        makePrint("p-4", "2026-11-20T15:10:00.000Z", {
          premium: 300_000,
          right: "call",
          sentiment: "neutral",
          side: "unknown",
          underlyingPrice: 684.3,
        }),
        // Call at ask (bullish, ask-side)
        makePrint("p-5", "2026-11-20T14:32:00.000Z", {
          premium: 500_000,
          right: "call",
          sentiment: "bullish",
          side: "ask",
          underlyingPrice: 682.8,
        }),
      ],
      range: RANGE,
    });

    // Gaps clipped & sorted oldest first
    expect(fold.gaps).toEqual([
      {
        end: "2026-11-20T14:35:00.000Z",
        start: "2026-11-20T14:30:00.000Z",
      },
      {
        end: "2026-11-20T15:00:00.000Z",
        start: "2026-11-20T15:00:00.000Z",
      },
      {
        end: "2026-11-20T21:15:00.000Z",
        start: "2026-11-20T21:10:00.000Z",
      },
    ]);
    expect(fold.unread).toEqual({
      from: "2026-11-20T14:30:00.000Z",
      ranges: 3,
      to: "2026-11-20T21:15:00.000Z",
    });

    // Price points sorted oldest first, flagged unread on overlap
    expect(fold.pricePoints).toEqual([
      {
        minute: "2026-11-20T14:31:00.000Z",
        price: 682.5,
        unread: true,
      },
      {
        minute: "2026-11-20T15:00:00.000Z",
        price: 684.1,
        unread: true,
      },
    ]);

    // Chronological order (at asc, id asc)
    expect(fold.bubbles.map((b) => b.id)).toEqual([
      "p-1",
      "p-5",
      "p-3",
      "p-2",
      "p-4",
    ]);
    expect(fold.truncated).toBe(false);

    // Mapped fields and sanitized non-finite values
    const p2 = fold.bubbles.find((b) => b.id === "p-2");
    expect(p2).toMatchObject({
      contract: "SPY 2026-11-25 680P",
      directionalSign: -1,
      dte: null,
      goldenSweep: true,
      iv: null,
      moneyness: "not_reported",
      price: null,
      side: "above_ask",
    });
    const p4 = fold.bubbles.find((b) => b.id === "p-4");
    expect(p4).toMatchObject({
      directionalSign: 0,
      side: "not_classified",
    });

    expect(fold.totals).toEqual({
      askSidePremium: 1_400_000,
      bearishPremium: 1_300_000,
      bidSidePremium: 1_000_000,
      bullishPremium: 1_100_000,
      callBubbles: 3,
      callPremium: 1_200_000,
      latestPrice: 684.1,
      maxBubblePremium: 900_000,
      plottedBubbles: 4,
      putBubbles: 2,
      putPremium: 1_500_000,
      sessionGrossPremium: 2_100_000,
      sessionPrints: 42,
      shownBubbles: 5,
      unplottedBubbles: 1,
      unsignedPremium: 300_000,
    });
    expect(fold.storedUntil).toBe("2026-11-20T21:15:45.000Z");
  });

  it("caps to largest prints when exceeding maxBubbles, breaks ties by tradedAt desc then id desc, and marks truncated", () => {
    const fold = foldOptionBubbles({
      gaps: [],
      maxBubbles: 2,
      minPremiumUsd: 100_000,
      minutes: [],
      prints: [
        makePrint("a", "2026-11-20T15:00:00.000Z", {
          premium: 500_000,
          underlyingPrice: 683,
        }),
        makePrint("b", "2026-11-20T15:00:00.000Z", {
          premium: 500_000,
          underlyingPrice: 683.2,
        }),
        makePrint("c", "2026-11-20T14:55:00.000Z", {
          premium: 500_000,
          underlyingPrice: 682.9,
        }),
        makePrint("top", "2026-11-20T14:40:00.000Z", {
          premium: 1_000_000,
          underlyingPrice: 682.5,
        }),
      ],
      range: RANGE,
    });

    expect(fold.truncated).toBe(true);
    // "top" (1M) + "b" (500k, latest time, higher id) kept, returned chronologically
    expect(fold.bubbles.map((b) => b.id)).toEqual(["top", "b"]);
    // Falls back to latest bubble underlyingPrice when no minute rows exist
    expect(fold.totals.latestPrice).toBe(683.2);
    expect(fold.storedUntil).toBe("2026-11-20T15:00:00.000Z");
    expect(fold.unread).toBeNull();
  });

  it("returns empty arrays and null storedUntil/latestPrice when both minutes and prints are empty", () => {
    const fold = foldOptionBubbles({
      gaps: [],
      minPremiumUsd: 250_000,
      minutes: [],
      prints: [],
      range: RANGE,
    });

    expect(fold.bubbles).toEqual([]);
    expect(fold.pricePoints).toEqual([]);
    expect(fold.gaps).toEqual([]);
    expect(fold.unread).toBeNull();
    expect(fold.storedUntil).toBeNull();
    expect(fold.truncated).toBe(false);
    expect(fold.totals.latestPrice).toBeNull();
  });

  it("does not show Quant Data flags of a print with open interest 0", () => {
    const flagged = { opening: true, volumeOverOi: true };
    const fold = foldOptionBubbles({
      gaps: [],
      minPremiumUsd: 250_000,
      minutes: [],
      prints: [
        makePrint("zero", "2026-11-20T14:40:00.000Z", {
          ...flagged,
          openInterest: 0,
        }),
        makePrint("known", "2026-11-20T14:41:00.000Z", {
          ...flagged,
          openInterest: 900,
        }),
      ],
      range: RANGE,
    });

    expect(fold.bubbles.map((b) => [b.id, b.opening, b.volumeOverOi])).toEqual([
      ["zero", false, false],
      ["known", true, true],
    ]);
  });

  it("picks earliest start and latest end across unordered gaps and handles non-overlapping gaps", () => {
    const fold = foldOptionBubbles({
      gaps: [
        {
          endTime: new Date("2026-11-20T17:00:00.000Z"),
          startTime: new Date("2026-11-20T16:30:00.000Z"),
        },
        {
          endTime: new Date("2026-11-20T18:00:00.000Z"),
          startTime: new Date("2026-11-20T15:00:00.000Z"),
        },
        {
          endTime: new Date("2026-11-20T15:30:00.000Z"),
          startTime: new Date("2026-11-20T15:00:00.000Z"),
        },
      ],
      minPremiumUsd: 250_000,
      minutes: [makeMinute("2026-11-20T14:45:00.000Z", { lastPrice: 681.5 })],
      prints: [],
      range: RANGE,
    });

    expect(fold.unread).toEqual({
      from: "2026-11-20T15:00:00.000Z",
      ranges: 3,
      to: "2026-11-20T18:00:00.000Z",
    });
    expect(fold.pricePoints).toEqual([
      {
        minute: "2026-11-20T14:45:00.000Z",
        price: 681.5,
        unread: false,
      },
    ]);
  });

  it("falls back safely on NaN maxBubbles, excludes out-of-session prints, and breaks ties deterministically", () => {
    const defensive = foldOptionBubbles({
      gaps: [],
      maxBubbles: Number.NaN,
      minPremiumUsd: 100_000,
      minutes: [],
      prints: [
        makePrint("before-open", "2026-11-20T14:29:59.000Z", {
          premium: 900_000,
        }),
        makePrint("after-close", "2026-11-20T21:15:00.000Z", {
          premium: 900_000,
        }),
        makePrint("in-session-b", "2026-11-20T15:00:00.000Z", {
          premium: 500_000,
        }),
        makePrint("in-session-a", "2026-11-20T15:00:00.000Z", {
          premium: 500_000,
        }),
      ],
      range: RANGE,
    });
    expect(defensive.bubbles.map((b) => b.id)).toEqual([
      "in-session-a",
      "in-session-b",
    ]);
    expect(defensive.truncated).toBe(false);
  });
});
