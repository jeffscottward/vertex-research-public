import { describe, expect, it } from "vitest";

import {
  foldPutCallDays,
  foldPutCallSession,
  PUT_CALL_RATIO_LOOKBACK_DAYS,
  PUT_CALL_RATIO_RULES,
  type PutCallDayRow,
  type PutCallMinuteRow,
  putCallRatioOf,
} from "./flow-put-call-ratio-rules.ts";

const M0 = new Date("2026-11-20T14:30:00.000Z");
const at = (minuteOffset: number): Date =>
  new Date(M0.getTime() + minuteOffset * 60_000);

const minuteRow = (
  minuteOffset: number,
  overrides: Partial<PutCallMinuteRow> = {}
): PutCallMinuteRow => ({
  callPremium: 100_000,
  callPrints: 1,
  callVolume: 100,
  lastPrice: 661.2,
  lastTradedAt: new Date(at(minuteOffset).getTime() + 30_000),
  minute: at(minuteOffset),
  putPremium: 100_000,
  putPrints: 1,
  putVolume: 100,
  ...overrides,
});

const dayRow = (
  session: string,
  overrides: Partial<PutCallDayRow> = {}
): PutCallDayRow => ({
  callPremium: 1_000_000,
  callPrints: 10,
  callVolume: 1000,
  lastPrice: 661.5,
  putPremium: 800_000,
  putPrints: 8,
  putVolume: 900,
  session,
  ...overrides,
});

describe("PUT_CALL_RATIO_RULES and putCallRatioOf", () => {
  it("freezes the v1 rules and lookback", () => {
    expect(PUT_CALL_RATIO_RULES).toEqual({
      minPremiumUsd: 10_000,
      parity: 1,
      retentionDays: 14,
      version: "put-call-ratio.v1",
    });
    expect(PUT_CALL_RATIO_LOOKBACK_DAYS).toBe(20);
  });

  it("divides put by call when call > 0 and returns null otherwise", () => {
    expect(putCallRatioOf(150, 100)).toBe(1.5);
    expect(putCallRatioOf(0, 100)).toBe(0);
    expect(putCallRatioOf(150, 0)).toBeNull();
    expect(putCallRatioOf(0, 0)).toBeNull();
    expect(putCallRatioOf(100, -10)).toBeNull();
  });
});

describe("foldPutCallSession", () => {
  it("returns empty points, null storedUntil and zero totals for an empty list", () => {
    expect(foldPutCallSession([])).toEqual({
      points: [],
      storedUntil: null,
      totals: {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        premiumHigh: null,
        premiumLow: null,
        premiumRatio: null,
        prints: 0,
        putPremium: 0,
        putPrints: 0,
        putVolume: 0,
        volumeHigh: null,
        volumeLow: null,
        volumeRatio: null,
      },
    });
  });

  it("folds running cumulative ratios, handles put-only start, carries forward positive prices, and picks first-win highs and lows", () => {
    const fold = foldPutCallSession([
      // Minute 0: puts only -> null ratios, no positive price yet
      minuteRow(0, {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        lastPrice: null,
        lastTradedAt: new Date(at(0).getTime() + 45_000),
        putPremium: 200_000,
        putPrints: 2,
        putVolume: 200,
      }),
      // Minute 1: calls arrive -> running premium 200k/100k = 2.0, volume 200/100 = 2.0; price 661.2
      minuteRow(1, {
        callPremium: 100_000,
        callPrints: 1,
        callVolume: 100,
        lastPrice: 661.2,
        lastTradedAt: new Date(at(1).getTime() + 20_000),
        putPremium: 0,
        putPrints: 0,
        putVolume: 0,
      }),
      // Minute 2: tie at 2.0 for both ratios -> minute 1 stays the high; non-positive price ignored (keeps 661.2)
      minuteRow(2, {
        callPremium: 100_000,
        callPrints: 1,
        callVolume: 100,
        lastPrice: 0,
        lastTradedAt: new Date(at(2).getTime() + 10_000),
        putPremium: 200_000,
        putPrints: 2,
        putVolume: 200,
      }),
      // Minute 3: heavy calls pull ratios down -> premium 400k/800k = 0.5, volume 400/500 = 0.8; new price 662.0
      minuteRow(3, {
        callPremium: 600_000,
        callPrints: 3,
        callVolume: 300,
        lastPrice: 662.0,
        // Out-of-order earlier lastTradedAt tests the max comparison branch
        lastTradedAt: new Date(at(1).getTime() + 5000),
        putPremium: 0,
        putPrints: 0,
        putVolume: 0,
      }),
      // Minute 4: same low ratios -> minute 3 stays the low (first wins)
      minuteRow(4, {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        lastPrice: null,
        lastTradedAt: new Date(at(4).getTime() + 55_000),
        putPremium: 0,
        putPrints: 0,
        putVolume: 0,
      }),
    ]);

    expect(fold.storedUntil).toBe(
      new Date(at(4).getTime() + 55_000).toISOString()
    );
    expect(fold.points.map((point) => point.premiumRatio)).toEqual([
      null,
      2,
      2,
      0.5,
      0.5,
    ]);
    expect(fold.points.map((point) => point.volumeRatio)).toEqual([
      null,
      2,
      2,
      0.8,
      0.8,
    ]);
    expect(fold.points.map((point) => point.price)).toEqual([
      null,
      661.2,
      661.2,
      662.0,
      662.0,
    ]);
    expect(fold.totals).toEqual({
      callPremium: 800_000,
      callPrints: 5,
      callVolume: 500,
      premiumHigh: { minute: at(1).toISOString(), ratio: 2 },
      premiumLow: { minute: at(3).toISOString(), ratio: 0.5 },
      premiumRatio: 0.5,
      prints: 9,
      putPremium: 400_000,
      putPrints: 4,
      putVolume: 400,
      volumeHigh: { minute: at(1).toISOString(), ratio: 2 },
      volumeLow: { minute: at(3).toISOString(), ratio: 0.8 },
      volumeRatio: 0.8,
    });
  });

  it("updates the high when a later minute exceeds an earlier ratio", () => {
    const fold = foldPutCallSession([
      minuteRow(0, {
        callPremium: 200_000,
        callVolume: 200,
        putPremium: 100_000,
        putVolume: 100,
      }),
      minuteRow(1, {
        callPremium: 0,
        callVolume: 0,
        putPremium: 500_000,
        putVolume: 500,
      }),
    ]);
    expect(fold.totals.premiumHigh).toEqual({
      minute: at(1).toISOString(),
      ratio: 3,
    });
    expect(fold.totals.premiumLow).toEqual({
      minute: at(0).toISOString(),
      ratio: 0.5,
    });
    expect(fold.totals.volumeHigh).toEqual({
      minute: at(1).toISOString(),
      ratio: 3,
    });
    expect(fold.totals.volumeLow).toEqual({
      minute: at(0).toISOString(),
      ratio: 0.5,
    });
  });
});

describe("foldPutCallDays", () => {
  it("computes ratios, filters non-positive prices to null, and applies the incomplete predicate", () => {
    const result = foldPutCallDays(
      [
        dayRow("2026-11-18", {
          callPremium: 0,
          callPrints: 0,
          callVolume: 0,
          lastPrice: 0,
          putPremium: 500_000,
          putPrints: 5,
          putVolume: 500,
        }),
        dayRow("2026-11-19", { lastPrice: null }),
        dayRow("2026-11-20", { lastPrice: 662.4 }),
      ],
      (session) => session === "2026-11-19"
    );

    expect(result).toEqual([
      {
        callPremium: 0,
        callPrints: 0,
        callVolume: 0,
        incomplete: false,
        premiumRatio: null,
        price: null,
        prints: 5,
        putPremium: 500_000,
        putPrints: 5,
        putVolume: 500,
        session: "2026-11-18",
        volumeRatio: null,
      },
      {
        callPremium: 1_000_000,
        callPrints: 10,
        callVolume: 1000,
        incomplete: true,
        premiumRatio: 0.8,
        price: null,
        prints: 18,
        putPremium: 800_000,
        putPrints: 8,
        putVolume: 900,
        session: "2026-11-19",
        volumeRatio: 0.9,
      },
      {
        callPremium: 1_000_000,
        callPrints: 10,
        callVolume: 1000,
        incomplete: false,
        premiumRatio: 0.8,
        price: 662.4,
        prints: 18,
        putPremium: 800_000,
        putPrints: 8,
        putVolume: 900,
        session: "2026-11-20",
        volumeRatio: 0.9,
      },
    ]);
  });
});
