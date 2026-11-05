import { describe, expect, it } from "vitest";

import type { SectorRotationPoint } from "./contracts/sector-rotation.ts";
import {
  alignRelativeStrength,
  type ClosePoint,
  computeRotationPoints,
  computeTimeframePoints,
  daysBefore,
  ema,
  isoWeekStart,
  isWeekComplete,
  latestOf,
  quadrantChanges,
  quadrantOf,
  SECTOR_ROTATION_PARAMS,
  sma,
  toWeekly,
  warmupPeriods,
} from "./sector-rotation.ts";

// Fixtures are synthetic: weekday dates from 2025-01-06 and prices built from formulas.
const weekdays = (count: number, start = "2025-01-06"): string[] => {
  const out: string[] = [];
  const day = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6)
      out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
};

const series = (
  dates: readonly string[],
  price: (index: number) => number
): ClosePoint[] => dates.map((date, index) => ({ close: price(index), date }));

describe("sector rotation building blocks", () => {
  it("maps ratio and momentum to the four quadrants, 100 inclusive", () => {
    expect(quadrantOf(101, 101)).toBe("leading");
    expect(quadrantOf(100, 100)).toBe("leading");
    expect(quadrantOf(101, 99)).toBe("weakening");
    expect(quadrantOf(99, 99)).toBe("lagging");
    expect(quadrantOf(99, 100)).toBe("improving");
  });

  it("seeds the EMA with the first value and smooths with alpha 2 ÷ (span + 1)", () => {
    expect(ema([10, 20, 20], 3)).toEqual([10, 15, 17.5]);
    expect(ema([], 5)).toEqual([]);
  });

  it("returns a trailing SMA that is null until the window is full", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it("finds the Monday of the ISO week, also across a year boundary", () => {
    expect(isoWeekStart("2025-01-08")).toBe("2025-01-06");
    expect(isoWeekStart("2025-01-12")).toBe("2025-01-06");
    expect(isoWeekStart("2025-01-01")).toBe("2024-12-30");
  });

  it("treats a week as final once a later week starts or on its Friday", () => {
    expect(isWeekComplete("2026-10-30", "2026-11-02")).toBe(true);
    expect(isWeekComplete("2026-11-02", "2026-11-02")).toBe(false);
    expect(isWeekComplete("2026-11-04", "2026-11-05")).toBe(false);
    expect(isWeekComplete("2026-11-06", "2026-11-06")).toBe(true);
  });

  it("keeps the last close of each ISO week, including a partial current week", () => {
    const closes = series(
      ["2024-12-30", "2025-01-03", "2025-01-06", "2025-01-10", "2025-01-13"],
      (index) => index + 1
    );
    expect(toWeekly(closes)).toEqual([
      { close: 2, date: "2025-01-03" },
      { close: 4, date: "2025-01-10" },
      { close: 5, date: "2025-01-13" },
    ]);
  });

  it("aligns on shared dates with usable closes and sorts by date", () => {
    const symbol: ClosePoint[] = [
      { close: 30, date: "2025-01-08" },
      { close: 20, date: "2025-01-07" },
      { close: 0, date: "2025-01-06" },
      { close: 10, date: "2025-01-09" },
    ];
    const benchmark: ClosePoint[] = [
      { close: 10, date: "2025-01-06" },
      { close: 40, date: "2025-01-07" },
      { close: 60, date: "2025-01-08" },
      { close: Number.NaN, date: "2025-01-09" },
    ];
    expect(alignRelativeStrength(symbol, benchmark)).toEqual([
      { date: "2025-01-07", rs: 50 },
      { date: "2025-01-08", rs: 50 },
    ]);
  });

  it("subtracts calendar days", () => {
    expect(daysBefore("2025-03-01", 1)).toBe("2025-02-28");
    expect(daysBefore("2026-11-02", 366)).toBe("2025-11-01");
  });
});

describe("computeRotationPoints", () => {
  it("matches a hand computation with the smallest parameters", () => {
    // rsSmoothing 1 keeps rs; trend = mean of two; momentum = rate of change of the ratio.
    const params = {
      momentumLag: 1,
      momentumSmoothing: 1,
      rsSmoothing: 1,
      trendWindow: 2,
    };
    const dates = weekdays(7);
    const rs = [100, 100, 100, 100, 100, 110, 99];
    const benchmark = series(dates, () => 50);
    const symbol = series(dates, (index) => (rs[index] as number) / 2);
    const ratio5 = (100 * 110) / 105;
    const ratio6 = (100 * 99) / 104.5;
    const points = computeRotationPoints(symbol, benchmark, params);
    expect(warmupPeriods(params)).toBe(5);
    expect(points).toHaveLength(2);
    expect(points[0]?.date).toBe(dates[5]);
    expect(points[0]?.ratio).toBeCloseTo(ratio5, 10);
    expect(points[0]?.momentum).toBeCloseTo(ratio5, 10);
    expect(points[0]?.quadrant).toBe("leading");
    expect(points[1]?.ratio).toBeCloseTo(ratio6, 10);
    expect(points[1]?.momentum).toBeCloseTo((100 * ratio6) / ratio5, 10);
    expect(points[1]?.quadrant).toBe("lagging");
  });

  it("puts a constant relative strength exactly at 100 / 100", () => {
    const dates = weekdays(120);
    const benchmark = series(dates, (index) => 400 + index);
    const symbol = series(dates, (index) => 2 * (400 + index));
    const points = computeRotationPoints(
      symbol,
      benchmark,
      SECTOR_ROTATION_PARAMS.daily
    );
    expect(points).toHaveLength(
      120 - warmupPeriods(SECTOR_ROTATION_PARAMS.daily)
    );
    for (const point of points) {
      expect(point.ratio).toBeCloseTo(100, 10);
      expect(point.momentum).toBeCloseTo(100, 10);
    }
  });

  it("turns clockwise (leading → weakening → lagging → improving) on a cyclical relative strength", () => {
    const dates = weekdays(400);
    const benchmark = series(dates, () => 100);
    const symbol = series(
      dates,
      (index) => 100 * (1 + 0.08 * Math.sin((2 * Math.PI * index) / 120))
    );
    const points = computeRotationPoints(
      symbol,
      benchmark,
      SECTOR_ROTATION_PARAMS.daily
    );
    const order = ["leading", "weakening", "lagging", "improving"];
    const changes = quadrantChanges(points);
    expect(changes.length).toBeGreaterThanOrEqual(8);
    for (const change of changes)
      expect(order[(order.indexOf(change.from) + 1) % 4]).toBe(change.to);
  });

  it("returns nothing when history is shorter than the warm-up", () => {
    const dates = weekdays(20);
    expect(
      computeRotationPoints(
        series(dates, () => 1),
        series(dates, () => 1),
        SECTOR_ROTATION_PARAMS.daily
      )
    ).toEqual([]);
  });
});

describe("computeTimeframePoints", () => {
  const dates = weekdays(520);
  const benchmark = series(dates, (index) => 300 + index / 10);
  const symbol = series(
    dates,
    (index) =>
      (300 + index / 10) * (1 + 0.05 * Math.sin((2 * Math.PI * index) / 90))
  );

  it("computes daily points from the given date on", () => {
    const from = dates[400] as string;
    const points = computeTimeframePoints(symbol, benchmark, "daily", from);
    expect(points[0]?.date).toBe(from);
    expect(points).toHaveLength(120);
  });

  it("computes weekly points on the last close of each week", () => {
    const points = computeTimeframePoints(
      symbol,
      benchmark,
      "weekly",
      "2000-01-01"
    );
    expect(points).toHaveLength(
      104 - warmupPeriods(SECTOR_ROTATION_PARAMS.weekly)
    );
    for (const point of points)
      expect(new Date(`${point.date}T00:00:00Z`).getUTCDay()).toBe(5);
  });
});

describe("latestOf", () => {
  const point = (
    date: string,
    quadrant: SectorRotationPoint["quadrant"]
  ): SectorRotationPoint => ({ date, momentum: 100, quadrant, ratio: 100 });

  it("is null for an empty series", () => {
    expect(latestOf([])).toBeNull();
  });

  it("counts the current quadrant streak and its first date", () => {
    expect(
      latestOf([
        point("2025-01-06", "leading"),
        point("2025-01-07", "lagging"),
        point("2025-01-08", "improving"),
        point("2025-01-09", "improving"),
      ])
    ).toEqual({
      ...point("2025-01-09", "improving"),
      periods: 2,
      since: "2025-01-08",
    });
  });

  it("covers the whole series when the quadrant never changed", () => {
    expect(
      latestOf([point("2025-01-06", "leading"), point("2025-01-07", "leading")])
    ).toMatchObject({ periods: 2, since: "2025-01-06" });
  });
});
