import { describe, expect, it } from "vitest";
import {
  analysisTimeZone,
  closeReturns,
  isIntradayBarSize,
  returnHistogram,
  returnStats,
  sessionStats,
} from "./bar-analysis.ts";

const day = (iso: string): number => Date.parse(iso) / 1000;

describe("close-to-close bar analysis", () => {
  it("computes simple returns attributed to the later bar and skips unusable closes", () => {
    const bars = [
      { t: 1, c: 100 },
      { t: 2, c: 110 },
      { t: 3, c: 99 },
      { t: 4, c: Number.NaN },
      { t: 5, c: 99 },
      { t: 6, c: 0 },
      { t: 7, c: 50 },
    ];
    const returns = closeReturns(bars);
    // NaN close breaks the chain; a zero close is a -100% return and cannot start the next one.
    expect(returns.map((row) => row.t)).toEqual([2, 3, 6]);
    expect(returns[2]!.r).toBe(-1);
    expect(returns[0]!.r).toBeCloseTo(0.1, 12);
    expect(returns[1]!.r).toBeCloseTo(-0.1, 12);
    expect(closeReturns([])).toEqual([]);
    return expect(closeReturns([{ t: 1, c: 10 }])).toEqual([]);
  });

  it("reports count, mean, sample stdev, adjusted skew, min and max", () => {
    const symmetric = returnStats([0.1, -0.1, 0]);
    expect(symmetric.count).toBe(3);
    expect(symmetric.mean).toBeCloseTo(0, 12);
    expect(symmetric.stdev).toBeCloseTo(0.1, 12);
    expect(symmetric.skew).toBeCloseTo(0, 12);
    expect(symmetric.min).toBe(-0.1);
    expect(symmetric.max).toBe(0.1);
    // Matches spreadsheet SKEW(1, 2, 3, 10).
    return expect(returnStats([1, 2, 3, 10]).skew).toBeCloseTo(1.763_632, 5);
  });

  it("returns nulls instead of invented values when there is too little data", () => {
    expect(returnStats([])).toEqual({
      count: 0,
      mean: null,
      stdev: null,
      skew: null,
      min: null,
      max: null,
    });
    expect(returnStats([0.02])).toEqual({
      count: 1,
      mean: 0.02,
      stdev: null,
      skew: null,
      min: 0.02,
      max: 0.02,
    });
    const pair = returnStats([0.01, 0.03]);
    expect(pair.stdev).not.toBeNull();
    expect(pair.skew).toBeNull();
    return expect(returnStats([0.01, 0.01, 0.01]).skew).toBeNull();
  });

  it("bins every finite return into a fixed number of equal-width bins", () => {
    const bins = returnHistogram([-0.1, 0, 0.1, 0.1, Number.NaN], 2);
    expect(bins).toHaveLength(2);
    expect(bins[0]).toMatchObject({ count: 1 });
    expect(bins[0]!.from).toBeCloseTo(-0.1, 12);
    expect(bins[0]!.to).toBeCloseTo(0, 12);
    expect(bins[1]).toMatchObject({ count: 3 });
    expect(bins[1]!.to).toBeCloseTo(0.1, 12);
    const many = returnHistogram(
      Array.from({ length: 101 }, (_, index) => (index - 50) / 1000)
    );
    expect(many).toHaveLength(20);
    expect(many.reduce((sum, bin) => sum + bin.count, 0)).toBe(101);
    expect(returnHistogram([0.02, 0.02])).toEqual([
      { from: 0.02, to: 0.02, count: 2 },
    ]);
    expect(returnHistogram([])).toEqual([]);
    return expect(() => returnHistogram([0.1], 0)).toThrow(RangeError);
  });

  it("groups returns by UTC weekday in Monday-first order", () => {
    const rows = sessionStats(
      [
        { t: day("2024-01-02T00:00:00Z"), r: 0.02 },
        { t: day("2024-01-01T00:00:00Z"), r: -0.01 },
        { t: day("2024-01-08T00:00:00Z"), r: 0.03 },
        { t: day("2024-01-05T00:00:00Z"), r: 0 },
      ],
      "weekday"
    );
    expect(rows.map((row) => row.label)).toEqual(["Mon", "Tue", "Fri"]);
    expect(rows[0]).toMatchObject({ count: 2, positiveShare: 0.5 });
    expect(rows[0]!.meanReturn).toBeCloseTo(0.01, 12);
    return expect(rows[2]).toMatchObject({
      count: 1,
      meanReturn: 0,
      positiveShare: 0,
    });
  });

  it("groups intraday returns by hour in the requested IANA zone", () => {
    const returns = [
      { t: day("2024-01-02T14:30:00Z"), r: 0.001 },
      { t: day("2024-01-02T15:00:00Z"), r: -0.002 },
      { t: day("2024-01-03T14:45:00Z"), r: 0.003 },
    ];
    expect(
      sessionStats(returns, "hour").map((row) => [row.label, row.count])
    ).toEqual([
      ["14:00", 2],
      ["15:00", 1],
    ]);
    expect(
      sessionStats(returns, "hour", "America/New_York").map((row) => [
        row.label,
        row.count,
      ])
    ).toEqual([
      ["09:00", 2],
      ["10:00", 1],
    ]);
    return expect(sessionStats([], "hour")).toEqual([]);
  });

  return it("uses the contract zone only for intraday bars and falls back to UTC for unknown zones", () => {
    expect(isIntradayBarSize("1 day")).toBe(false);
    expect(isIntradayBarSize("5 mins")).toBe(true);
    expect(analysisTimeZone("1 day", "US/Eastern")).toBe("UTC");
    expect(analysisTimeZone("5 mins", "US/Eastern")).toBe("US/Eastern");
    expect(analysisTimeZone("5 mins", "Not/AZone")).toBe("UTC");
    return expect(analysisTimeZone("5 mins", null)).toBe("UTC");
  });
});
