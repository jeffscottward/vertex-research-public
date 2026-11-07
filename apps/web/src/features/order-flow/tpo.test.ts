import type { MarketBar } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import { buildTpoProfile, valueAreaRange } from "./tpo.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const bar = (iso: string, l: number, h: number): MarketBar => ({
  c: (l + h) / 2,
  h,
  l,
  o: l,
  t: at(iso),
  v: 1000,
});

// 2026-10-29 RTH in New York (EDT, UTC-4): A 09:30, B 10:00, C 10:30, D 11:00.
const DAY_ONE = [
  bar("2026-10-29T13:30:00Z", 100, 103),
  bar("2026-10-29T14:00:00Z", 102, 105),
  bar("2026-10-29T14:30:00Z", 101, 103),
  bar("2026-10-29T15:00:00Z", 103, 106),
];

describe("buildTpoProfile", () => {
  it("letters each 30-minute period across every level its range covers", () => {
    const profile = buildTpoProfile(DAY_ONE, "America/New_York", {
      priceStep: 1,
    });
    expect(profile?.sessions).toHaveLength(1);
    const session = profile?.sessions[0];
    expect(session?.date).toBe("2026-10-29");
    expect(session?.periods.map((period) => period.letter).join("")).toBe(
      "ABCD"
    );
    expect(
      session?.levels.map((level) => `${level.price}:${level.letters}`)
    ).toEqual([
      "106:D",
      "105:BD",
      "104:BD",
      "103:ABCD",
      "102:ABC",
      "101:AC",
      "100:A",
    ]);
    expect(session?.totalTpos).toBe(15);
  });

  it("finds the POC, the 70% value area grown from it, the initial balance and single prints", () => {
    const session = buildTpoProfile(DAY_ONE, "America/New_York", {
      priceStep: 1,
    })?.sessions[0];
    expect(session).toMatchObject({
      high: 106,
      initialBalance: { high: 105, low: 100, periods: 2 },
      low: 100,
      poc: 103,
      singlePrints: [106, 100],
      // 103 (4) + 102/101 (5) + 104/105 (4) = 13 of 15 TPOs >= 70%.
      valueAreaHigh: 105,
      valueAreaLow: 101,
      valueAreaTpos: 13,
    });
  });

  it("splits sessions by calendar day in the exchange time zone", () => {
    const profile = buildTpoProfile(
      [
        ...DAY_ONE,
        // 23:00 ET on the 29th: still the 29th in New York, the 30th in UTC.
        bar("2026-10-30T03:00:00Z", 104, 104.5),
        bar("2026-10-30T13:30:00Z", 110, 111),
      ],
      "America/New_York",
      { priceStep: 1 }
    );
    expect(profile?.sessions.map((session) => session.date)).toEqual([
      "2026-10-29",
      "2026-10-30",
    ]);
    expect(profile?.sessions[0]?.periods).toHaveLength(5);
    const second = profile?.sessions[1];
    expect(second?.initialBalance).toEqual({ high: 111, low: 110, periods: 1 });
    expect(second?.periods[0]?.letter).toBe("A");
  });

  it("derives a price step that keeps sessions under 60 rows", () => {
    const profile = buildTpoProfile(
      [
        bar("2026-10-29T13:30:00Z", 500.01, 502.37),
        bar("2026-10-29T14:00:00Z", 501.5, 503.12),
      ],
      "America/New_York"
    );
    expect(profile?.tickSize).toBe(0.01);
    // 500.01-503.12 at 0.01 is 312 rows; 0.05 is 63; 0.10 is 32.
    expect(profile?.priceStep).toBe(0.1);
    expect(profile?.sessions[0]?.levels.length).toBeLessThanOrEqual(60);
  });

  it("profiles unrounded float bar prices (1e-8 tick) on a readable step", () => {
    // Same shape as the charts-order-flow e2e mock: 100 + sin(i / 2) +- 0.4, never rounded.
    const start = at("2026-10-29T13:30:00Z");
    const bars = Array.from({ length: 13 }, (_, index): MarketBar => {
      const mid = 100 + Math.sin(index / 2);
      return {
        c: mid + 0.1,
        h: mid + 0.4,
        l: mid - 0.4,
        o: mid - 0.1,
        t: start + index * 1800,
        v: 500,
      };
    });
    const profile = buildTpoProfile(bars, "America/New_York");
    expect(profile?.tickSize).toBe(1e-8);
    // Range 98.62-101.40: 0.01 is 279 rows, 0.1 is 29.
    expect(profile?.priceStep).toBe(0.1);
    const session = profile?.sessions[0];
    expect(session?.levels.length).toBeLessThanOrEqual(60);
    expect(session?.totalTpos).toBeGreaterThan(0);
    expect(session?.levels.some((level) => level.price === session.poc)).toBe(
      true
    );
  });

  it("falls back to the auto step for a non-finite step option", () => {
    for (const priceStep of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(
        buildTpoProfile(DAY_ONE, "America/New_York", { priceStep })?.priceStep
      ).toBe(1);
    }
  });

  it("returns null without usable bars", () => {
    expect(buildTpoProfile([], "UTC")).toBeNull();
    expect(
      buildTpoProfile([bar("2026-10-29T13:30:00Z", 10, 9)], "UTC")
    ).toBeNull();
  });
});

describe("valueAreaRange", () => {
  it("adds both pairs on a tie and stops once the share is reached", () => {
    expect(valueAreaRange([1, 2, 5, 2, 1], 2)).toEqual({
      high: 4,
      low: 0,
      tpos: 11,
    });
    expect(valueAreaRange([10], 0)).toEqual({ high: 0, low: 0, tpos: 10 });
    // Only levels above the POC: grows upward until 70%.
    expect(valueAreaRange([6, 2, 1, 1], 0)).toEqual({
      high: 2,
      low: 0,
      tpos: 9,
    });
  });
});

describe("buildTpoProfile gaps", () => {
  it("keeps an empty level between two periods that do not overlap", () => {
    const profile = buildTpoProfile(
      [
        bar("2026-10-29T13:30:00Z", 100, 101),
        bar("2026-10-29T14:00:00Z", 103, 104),
      ],
      "America/New_York",
      { priceStep: 1 }
    );
    const levels = profile?.sessions[0]?.levels ?? [];
    expect(levels.map((level) => `${level.price}:${level.letters}`)).toEqual([
      "104:B",
      "103:B",
      "102:",
      "101:A",
      "100:A",
    ]);
    expect(levels.find((level) => level.price === 102)?.count).toBe(0);
  });
});
