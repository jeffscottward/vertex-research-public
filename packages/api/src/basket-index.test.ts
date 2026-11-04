import { describe, expect, it } from "vitest";

import {
  barDate,
  computeBasketIndex,
  type DailyClose,
  normalizeWeights,
} from "./basket-index.ts";

const series = (entries: Record<string, number>): DailyClose[] =>
  Object.entries(entries).map(([date, close]) => ({ date, close }));

const thirds = [
  { symbol: "VSCO", weight: 1 / 3 },
  { symbol: "ESTA", weight: 1 / 3 },
  { symbol: "AVTR", weight: 1 / 3 },
];

const closes = {
  VSCO: series({ "2026-10-22": 20, "2026-10-23": 22, "2026-10-26": 24 }),
  ESTA: series({ "2026-10-22": 40, "2026-10-23": 40, "2026-10-26": 30 }),
  AVTR: series({ "2026-10-22": 10, "2026-10-23": 12, "2026-10-26": 11 }),
};
const spy = series({ "2026-10-22": 500, "2026-10-23": 505, "2026-10-26": 510 });
// Created on Thursday 2026-10-22 during the session (14:00 New York).
const createdAt = new Date("2026-10-22T18:00:00Z");

describe("normalizeWeights", () => {
  it("scales weights to sum 1 and keeps zero sums at zero", () => {
    const weights = normalizeWeights([
      { symbol: "A", weight: 2 },
      { symbol: "B", weight: 6 },
    ]);
    expect(weights.map((member) => member.weight)).toEqual([0.25, 0.75]);
    expect(
      normalizeWeights([{ symbol: "A", weight: 0 }]).map((m) => m.weight)
    ).toEqual([0]);
    const sum = normalizeWeights(thirds).reduce((t, m) => t + m.weight, 0);
    expect(sum).toBeCloseTo(1, 12);
  });
});

describe("barDate", () => {
  it("maps the history service's UTC-midnight seconds to a date key", () => {
    expect(barDate(Date.UTC(2026, 9, 23) / 1000)).toBe("2026-10-23");
  });
});

describe("computeBasketIndex", () => {
  it("fixes the base at the first full session close after creation and values later dates", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes,
      benchmark: spy,
      storedBase: null,
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(result.baseState).toBe("fixed");
    expect(result.newlyFixedBase).toEqual({
      date: "2026-10-23",
      prices: { VSCO: 22, ESTA: 40, AVTR: 12 },
      benchmark: 505,
    });
    const last = result.points.at(-1);
    // (24/22 + 30/40 + 11/12) / 3 * 100
    expect(last?.value).toBeCloseTo(((24 / 22 + 0.75 + 11 / 12) / 3) * 100, 10);
    expect(last?.benchmark).toBeCloseTo((510 / 505) * 100, 10);
    expect(
      result.points.find((p) => p.date === "2026-10-23")?.value
    ).toBeCloseTo(100, 10);
    expect(result.latest?.date).toBe("2026-10-26");
    expect(result.latest?.changePct).toBeCloseTo((last?.value ?? 0) - 100, 10);
    expect(result.latest?.dayChangePct).toBeCloseTo(
      ((last?.value ?? 0) / 100 - 1) * 100,
      10
    );
    const contributionSum = result.members.reduce(
      (total, member) => total + (member.contribution ?? 0),
      0
    );
    expect(contributionSum).toBeCloseTo((last?.value ?? 0) - 100, 10);
    expect(result.members[0]).toMatchObject({
      symbol: "VSCO",
      basePrice: 22,
      lastPrice: 24,
      lastDate: "2026-10-26",
      stale: false,
    });
    expect(result.members[0]?.returnPct).toBeCloseTo((24 / 22 - 1) * 100, 10);
    expect(result.staleSymbols).toEqual([]);
  });

  it("uses a provisional base until a full session after creation exists", () => {
    const during = computeBasketIndex({
      members: thirds,
      closes,
      benchmark: spy,
      storedBase: null,
      baseValue: 100,
      anchorAt: new Date("2026-10-26T14:00:00Z"),
      // 2026-10-26 15:00 New York: the 10-26 bar is not final yet.
      now: new Date("2026-10-26T19:00:00Z"),
      dataAsOf: new Date("2026-10-26T19:00:00Z"),
    });
    expect(during.baseState).toBe("provisional");
    expect(during.newlyFixedBase).toBeNull();
    expect(during.base?.date).toBe("2026-10-23");

    const afterClose = computeBasketIndex({
      members: thirds,
      closes,
      benchmark: null,
      storedBase: null,
      baseValue: 100,
      anchorAt: new Date("2026-10-23T14:00:00Z"),
      // 2026-10-26 16:30 New York: the 10-26 close is final.
      now: new Date("2026-10-26T20:30:00Z"),
      dataAsOf: new Date("2026-10-26T20:30:00Z"),
    });
    expect(afterClose.baseState).toBe("fixed");
    expect(afterClose.newlyFixedBase?.date).toBe("2026-10-26");
    expect(afterClose.points.every((point) => point.benchmark === null)).toBe(
      true
    );
  });

  it("never fixes the base from data fetched before that session's close", () => {
    const input = {
      members: thirds,
      closes,
      benchmark: null,
      storedBase: null,
      baseValue: 100,
      anchorAt: new Date("2026-10-23T14:00:00Z"),
      // 2026-10-26 16:30 New York: the clock says the 10-26 close is final.
      now: new Date("2026-10-26T20:30:00Z"),
    };
    // The bars were fetched at 15:50 New York and served from the cache: 10-26 is an intraday bar.
    const cached = computeBasketIndex({
      ...input,
      dataAsOf: new Date("2026-10-26T19:50:00Z"),
    });
    expect(cached.baseState).toBe("provisional");
    expect(cached.newlyFixedBase).toBeNull();
    expect(cached.base?.date).toBe("2026-10-26");

    const unknown = computeBasketIndex({ ...input, dataAsOf: null });
    expect(unknown.baseState).toBe("provisional");
    expect(unknown.newlyFixedBase).toBeNull();
  });

  it("falls back to the latest common date when no final close exists", () => {
    const result = computeBasketIndex({
      members: [{ symbol: "VSCO", weight: 1 }],
      closes: { VSCO: series({ "2026-10-26": 24 }) },
      benchmark: null,
      storedBase: null,
      baseValue: 100,
      anchorAt: new Date("2026-10-26T14:00:00Z"),
      now: new Date("2026-10-26T15:00:00Z"),
      dataAsOf: new Date("2026-10-26T15:00:00Z"),
    });
    expect(result.baseState).toBe("provisional");
    expect(result.base?.date).toBe("2026-10-26");
    expect(result.latest?.dayChangePct).toBeNull();
  });

  it("marks a date with a missing member price stale instead of zero", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes: {
        ...closes,
        ESTA: series({ "2026-10-22": 40, "2026-10-23": 40, "2026-10-26": -1 }),
      },
      benchmark: spy,
      storedBase: {
        date: "2026-10-22",
        prices: { VSCO: 20, ESTA: 40, AVTR: 10 },
        benchmark: null,
      },
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    const last = result.points.at(-1);
    expect(last).toMatchObject({
      date: "2026-10-26",
      value: null,
      stale: true,
      missing: ["ESTA"],
    });
    expect(result.staleSymbols).toEqual(["ESTA"]);
    expect(result.latest?.date).toBe("2026-10-23");
    const esta = result.members.find((member) => member.symbol === "ESTA");
    expect(esta).toMatchObject({
      stale: true,
      lastDate: "2026-10-23",
      lastPrice: 40,
    });
    const vsco = result.members.find((member) => member.symbol === "VSCO");
    // Contribution uses the latest valued date (10-23), not the newer 10-26 price.
    expect(vsco?.contribution).toBeCloseTo((1 / 3) * (22 / 20 - 1) * 100, 10);
  });

  it("returns pending with no values when a member has no history at all", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes: { VSCO: closes.VSCO, ESTA: null },
      benchmark: spy,
      storedBase: null,
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(result.baseState).toBe("pending");
    expect(result.base).toBeNull();
    expect(result.latest).toBeNull();
    expect(
      result.points.every(
        (point) => point.value === null && point.benchmark === null
      )
    ).toBe(true);
    expect(result.staleSymbols).toEqual(["ESTA", "AVTR"]);
    expect(result.members.find((m) => m.symbol === "ESTA")).toMatchObject({
      basePrice: null,
      lastPrice: null,
      lastDate: null,
      returnPct: null,
      contribution: null,
    });
  });

  it("includes the anchor day when membership starts before the open", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes,
      benchmark: null,
      storedBase: null,
      baseValue: 100,
      // 2026-10-23 08:00 New York, before the 09:30 open.
      anchorAt: new Date("2026-10-23T12:00:00Z"),
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(result.newlyFixedBase?.date).toBe("2026-10-23");
  });

  it("marks values stale when a stored base lacks a member price", () => {
    const result = computeBasketIndex({
      members: [
        { symbol: "VSCO", weight: 0.5 },
        { symbol: "AVTR", weight: 0.5 },
      ],
      closes,
      benchmark: null,
      storedBase: {
        date: "2026-10-22",
        prices: { VSCO: 20 },
        benchmark: null,
      },
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(
      result.points.every((point) => point.value === null && point.stale)
    ).toBe(true);
    expect(result.latest).toBeNull();
    expect(result.members[1]).toMatchObject({
      basePrice: null,
      contribution: null,
    });
  });

  it("keeps the SPY line with a stored benchmark base older than the fetched window", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes,
      benchmark: spy,
      // A base fixed more than a year ago: no fetched close exists on its date.
      storedBase: {
        date: "2025-06-02",
        prices: { VSCO: 10, ESTA: 20, AVTR: 5 },
        benchmark: 400,
      },
      baseValue: 100,
      anchorAt: new Date("2025-06-01T14:00:00Z"),
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(result.baseState).toBe("fixed");
    expect(result.base?.benchmark).toBe(400);
    expect(result.points.at(-1)?.benchmark).toBeCloseTo((510 / 400) * 100, 10);
    expect(result.latest?.benchmark).toBeCloseTo((510 / 400) * 100, 10);
  });

  it("reads a missing stored benchmark base from the window and leaves it null otherwise", () => {
    const input = {
      members: thirds,
      closes,
      benchmark: spy,
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    };
    const inWindow = computeBasketIndex({
      ...input,
      storedBase: {
        date: "2026-10-22",
        prices: { VSCO: 20, ESTA: 40, AVTR: 10 },
        benchmark: null,
      },
    });
    expect(inWindow.base?.benchmark).toBe(500);
    expect(inWindow.points.at(-1)?.benchmark).toBeCloseTo(102, 10);

    const outside = computeBasketIndex({
      ...input,
      storedBase: {
        date: "2025-06-02",
        prices: { VSCO: 10, ESTA: 20, AVTR: 5 },
        benchmark: null,
      },
    });
    expect(outside.base?.benchmark).toBeNull();
    expect(outside.points.every((point) => point.benchmark === null)).toBe(
      true
    );
  });

  it("reports no day change when the session before the latest value is stale", () => {
    const result = computeBasketIndex({
      members: thirds,
      closes: {
        ...closes,
        // 10-23 has no ESTA close, so that point is stale; 10-26 is valued again.
        ESTA: series({ "2026-10-22": 40, "2026-10-26": 30 }),
      },
      benchmark: spy,
      storedBase: {
        date: "2026-10-22",
        prices: { VSCO: 20, ESTA: 40, AVTR: 10 },
        benchmark: 500,
      },
      baseValue: 100,
      anchorAt: createdAt,
      now: new Date("2026-10-27T15:00:00Z"),
      dataAsOf: new Date("2026-10-27T15:00:00Z"),
    });
    expect(result.points.map((point) => point.stale)).toEqual([
      false,
      true,
      false,
    ]);
    expect(result.latest?.date).toBe("2026-10-26");
    expect(result.latest?.dayChangePct).toBeNull();
  });
});
