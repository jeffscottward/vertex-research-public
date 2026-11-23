import { describe, expect, it } from "vitest";
import {
  directionalSignOf,
  foldStrikeHeatmap,
  STRIKE_HEATMAP_RULES,
  type StrikeHeatmapBucketRow,
} from "./flow-strike-heatmap-rules.ts";

const RANGE = {
  from: new Date("2026-11-20T14:30:00.000Z"),
  to: new Date("2026-11-20T21:15:00.000Z"),
};

const bucket = (
  overrides: Partial<StrikeHeatmapBucketRow> = {}
): StrikeHeatmapBucketRow => ({
  lastTradedAt: new Date("2026-11-20T14:35:00.000Z"),
  premium: 100_000,
  prints: 2,
  right: "call",
  side: "ask",
  slotIndex: 0,
  strike: 600,
  volume: 100,
  ...overrides,
});

describe("directionalSignOf", () => {
  it("classifies call/put × aggressor sides consistently with OPTION_SIDE_SIGN", () => {
    expect(directionalSignOf("call", "above_ask")).toBe(1);
    expect(directionalSignOf("call", "ask")).toBe(1);
    expect(directionalSignOf("put", "bid")).toBe(1);
    expect(directionalSignOf("put", "below_bid")).toBe(1);
    expect(directionalSignOf("put", "above_ask")).toBe(-1);
    expect(directionalSignOf("put", "ask")).toBe(-1);
    expect(directionalSignOf("call", "bid")).toBe(-1);
    expect(directionalSignOf("call", "below_bid")).toBe(-1);
    expect(directionalSignOf("call", "mid")).toBe(0);
    expect(directionalSignOf("put", "unknown")).toBe(0);
  });
});

describe("foldStrikeHeatmap", () => {
  it("returns empty series and zero totals when no valid buckets exist", () => {
    const empty = foldStrikeHeatmap({
      bucketMinutes: 15,
      buckets: [
        // malformed rows filtered out
        bucket({ strike: 0 }),
        bucket({ slotIndex: -1 }),
        bucket({ slotIndex: 27 }),
        bucket({ premium: -1 }),
        bucket({ prints: 0 }),
        bucket({ volume: -5 }),
      ],
      gaps: [],
      range: RANGE,
      slotPrices: [],
    });
    expect(empty).toEqual({
      cells: [],
      slots: [],
      storedUntil: null,
      strikes: [],
      totals: {
        bearishPremium: 0,
        bullishPremium: 0,
        callPremium: 0,
        grossPremium: 0,
        latestPrice: null,
        netPremium: 0,
        omittedGrossPremium: 0,
        omittedNetPremium: 0,
        omittedPrints: 0,
        omittedStrikes: 0,
        prints: 0,
        putPremium: 0,
        shownStrikes: 0,
        totalStrikes: 0,
        unsignedPrints: 0,
        volume: 0,
      },
    });
  });

  it("folds bullish, bearish, and unsigned rows into slots, strikes, and cells with carried-forward spot and gaps", () => {
    const fold = foldStrikeHeatmap({
      bucketMinutes: 15,
      buckets: [
        // Slot 0, strike 600: +120k (call@ask), -40k (put@ask), unsigned 30k (call@mid)
        bucket({
          lastTradedAt: new Date("2026-11-20T14:32:00.000Z"),
          premium: 120_000,
          prints: 3,
          right: "call",
          side: "ask",
          slotIndex: 0,
          strike: 600,
          volume: 120,
        }),
        bucket({
          lastTradedAt: new Date("2026-11-20T14:34:00.000Z"),
          premium: 40_000,
          prints: 1,
          right: "put",
          side: "ask",
          slotIndex: 0,
          strike: 600,
          volume: 40,
        }),
        bucket({
          lastTradedAt: new Date("2026-11-20T14:33:00.000Z"),
          premium: 30_000,
          prints: 1,
          right: "call",
          side: "mid",
          slotIndex: 0,
          strike: 600,
          volume: 30,
        }),
        // Slot 2, strike 605: +200k (put@below_bid)
        bucket({
          lastTradedAt: new Date("2026-11-20T15:05:00.000Z"),
          premium: 200_000,
          prints: 2,
          right: "put",
          side: "below_bid",
          slotIndex: 2,
          strike: 605,
          volume: 200,
        }),
      ],
      gaps: [
        // Zero-duration point gap right at slot 1 start (14:45Z)
        {
          endTime: new Date("2026-11-20T14:45:00.000Z"),
          startTime: new Date("2026-11-20T14:45:00.000Z"),
        },
        // Late open gap extending to slot 3 (15:15-15:30Z)
        {
          endTime: new Date("2026-11-20T15:25:00.000Z"),
          startTime: new Date("2026-11-20T15:15:00.000Z"),
        },
      ],
      range: RANGE,
      slotPrices: [
        // Leading slot 0 has no price -> null; slot 1 gets 601.5 -> carried into slots 2 and 3
        {
          price: 601.5,
          pricedAt: new Date("2026-11-20T14:50:00.000Z"),
          slotIndex: 1,
        },
        // Invalid prices ignored
        {
          price: 0,
          pricedAt: new Date("2026-11-20T14:51:00.000Z"),
          slotIndex: 2,
        },
        {
          price: 602,
          pricedAt: new Date("2026-11-20T15:35:00.000Z"),
          slotIndex: 99,
        },
      ],
    });

    expect(fold.storedUntil).toBe("2026-11-20T15:05:00.000Z");
    expect(fold.slots).toHaveLength(4);
    expect(fold.slots.map((s) => s.price)).toEqual([null, 601.5, 601.5, 601.5]);
    expect(fold.slots.map((s) => s.unread)).toEqual([false, true, false, true]);
    expect(fold.slots[0]).toMatchObject({
      bearishPremium: 40_000,
      bullishPremium: 120_000,
      grossPremium: 190_000,
      netPremium: 80_000,
      prints: 5,
      unsignedPrints: 1,
      volume: 190,
    });
    expect(fold.strikes.map((s) => s.strike)).toEqual([605, 600]);
    expect(fold.cells.map((c) => `${c.strike}:${c.slotIndex}`)).toEqual([
      "605:2",
      "600:0",
    ]);
    expect(fold.totals).toEqual({
      bearishPremium: 40_000,
      bullishPremium: 320_000,
      callPremium: 150_000,
      grossPremium: 390_000,
      latestPrice: 601.5,
      netPremium: 280_000,
      omittedGrossPremium: 0,
      omittedNetPremium: 0,
      omittedPrints: 0,
      omittedStrikes: 0,
      prints: 7,
      putPremium: 240_000,
      shownStrikes: 2,
      totalStrikes: 2,
      unsignedPrints: 1,
      volume: 390,
    });
  });

  it("keeps top maxStrikes by grossPremium, |netPremium|, proximity to spot, then strike desc, and tracks omitted totals", () => {
    const fold = foldStrikeHeatmap({
      bucketMinutes: 30,
      buckets: [
        // Strike 600: gross 500k
        bucket({ premium: 500_000, slotIndex: 13, strike: 600 }),
        // Strike 604 & 596: tied gross 200k, tied |net| 200k; 604 is closer to spot 603 -> wins tie
        bucket({ premium: 200_000, slotIndex: 0, strike: 604 }),
        bucket({ premium: 200_000, slotIndex: 0, strike: 596 }),
        // Strike 590: tied gross 200k, |net| 0 (unsigned) -> loses to 604 & 596
        bucket({ premium: 200_000, side: "mid", slotIndex: 0, strike: 590 }),
        // Strike 610: gross 50k -> omitted
        bucket({
          premium: 50_000,
          prints: 1,
          right: "put",
          side: "ask",
          slotIndex: 0,
          strike: 610,
        }),
      ],
      gaps: [],
      maxStrikes: 2,
      range: RANGE,
      slotPrices: [
        {
          price: 603,
          pricedAt: new Date("2026-11-20T14:35:00.000Z"),
          slotIndex: 0,
        },
      ],
    });

    // Final 30m slot (index 13) is capped at 16:15 ET (21:15Z)
    expect(fold.slots[13]).toMatchObject({
      end: "2026-11-20T21:15:00.000Z",
      start: "2026-11-20T21:00:00.000Z",
    });
    // Kept strikes sorted descending by strike: 604 then 600
    expect(fold.strikes.map((s) => s.strike)).toEqual([604, 600]);
    expect(fold.cells.map((c) => c.strike)).toEqual([604, 600]);
    expect(fold.totals).toMatchObject({
      omittedGrossPremium: 450_000,
      omittedNetPremium: 150_000,
      omittedPrints: 5,
      omittedStrikes: 3,
      shownStrikes: 2,
      totalStrikes: 5,
    });
  });

  it("breaks equal spot distance by strike desc", () => {
    const fold = foldStrikeHeatmap({
      bucketMinutes: 15,
      buckets: [
        bucket({ premium: 100_000, slotIndex: 0, strike: 598 }),
        bucket({ premium: 100_000, slotIndex: 0, strike: 602 }),
      ],
      gaps: [],
      maxStrikes: 1,
      range: RANGE,
      slotPrices: [
        {
          price: 600,
          pricedAt: new Date("2026-11-20T14:35:00.000Z"),
          slotIndex: 0,
        },
      ],
    });
    expect(fold.strikes.map((s) => s.strike)).toEqual([602]);
  });

  it("falls back to strike desc when grossPremium, |netPremium|, and spot distance tie or spot is null", () => {
    const fold = foldStrikeHeatmap({
      bucketMinutes: 15,
      buckets: [
        bucket({ premium: 100_000, slotIndex: 0, strike: 598 }),
        bucket({ premium: 100_000, slotIndex: 0, strike: 602 }),
      ],
      gaps: [],
      maxStrikes: 1,
      range: RANGE,
      slotPrices: [],
    });
    expect(fold.strikes.map((s) => s.strike)).toEqual([602]);
    expect(STRIKE_HEATMAP_RULES.version).toBe("strike-heatmap.v1");
  });

  it("sorts multiple cells of the same strike ascending by slotIndex", () => {
    const fold = foldStrikeHeatmap({
      bucketMinutes: 15,
      buckets: [
        bucket({ slotIndex: 3, strike: 600 }),
        bucket({ slotIndex: 1, strike: 600 }),
      ],
      gaps: [],
      range: RANGE,
      slotPrices: [],
    });
    expect(fold.cells.map((c) => c.slotIndex)).toEqual([1, 3]);
  });
});
