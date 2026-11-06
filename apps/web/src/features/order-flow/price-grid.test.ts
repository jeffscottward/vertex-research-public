import { describe, expect, it } from "vitest";

import {
  autoBucketSeconds,
  autoPriceStep,
  bucketCount,
  bucketOptions,
  decimalsOf,
  deriveTickSize,
  formatBucketSeconds,
  groupPrice,
  levelCount,
} from "./price-grid.ts";

describe("deriveTickSize", () => {
  it("finds the increment the prints trade in", () => {
    expect(deriveTickSize([100.01, 100.03, 100.04])).toBe(0.01);
    expect(deriveTickSize([4500.25, 4500.5, 4501.25])).toBe(0.25);
    expect(deriveTickSize([4500, 4505, 4515])).toBe(5);
    expect(deriveTickSize([0.1 + 0.2, 0.4])).toBe(0.1);
  });

  it("ignores a rare sub-penny print when 95% of prices are in cents", () => {
    const prices = Array.from({ length: 40 }, (_, index) => 100 + index / 100);
    expect(deriveTickSize([...prices, 100.0051])).toBe(0.01);
  });

  it("falls back to one unit at the price's decimals for a single price, null for none", () => {
    expect(deriveTickSize([100.25])).toBe(0.01);
    expect(deriveTickSize([42])).toBe(1);
    expect(deriveTickSize([])).toBeNull();
    expect(deriveTickSize([Number.NaN])).toBeNull();
  });
});

describe("groupPrice / levelCount / autoPriceStep", () => {
  it("groups to the step multiple at or below the price without float drift", () => {
    expect(groupPrice(100.03, 0.01)).toBe(100.03);
    expect(groupPrice(100.07, 0.05)).toBe(100.05);
    expect(groupPrice(4500.75, 0.25)).toBe(4500.75);
    expect(groupPrice(4500.6, 0.5)).toBe(4500.5);
    expect(decimalsOf(0.25)).toBe(2);
  });

  it("counts levels inclusive and widens the step until the grid fits", () => {
    expect(levelCount(100, 100.39, 0.01)).toBe(40);
    expect(autoPriceStep(0.01, 100, 100.39, 40)).toBe(0.01);
    expect(autoPriceStep(0.01, 100, 100.4, 40)).toBe(0.02);
    expect(autoPriceStep(0.25, 4500, 4530, 40)).toBe(1.25);
  });
});

describe("time buckets", () => {
  it("auto-sizes buckets so a window gets roughly 6-20 of them", () => {
    // 90 s window: 5 s buckets -> 19.
    expect(autoBucketSeconds(1000, 1090)).toBe(5);
    expect(bucketCount(1000, 1090, 5)).toBe(19);
    // 25 minutes: 2 min buckets -> 13.
    const auto = autoBucketSeconds(36_000, 36_000 + 25 * 60);
    expect(auto).toBe(120);
    expect(bucketCount(36_000, 37_500, auto)).toBeGreaterThanOrEqual(6);
    // A one-second burst still gets one bucket.
    expect(autoBucketSeconds(50, 50)).toBe(1);
  });

  it("offers sizes giving 2-120 buckets plus the auto size", () => {
    const options = bucketOptions(1000, 1090);
    expect(options).toContain(5);
    expect(options).toContain(1);
    expect(options).toContain(120);
    // 5 min buckets would put the whole window in one.
    expect(options).not.toContain(300);
    expect(bucketOptions(50, 50)).toEqual([1]);
  });

  it("formats sizes", () => {
    expect(formatBucketSeconds(30)).toBe("30 s");
    expect(formatBucketSeconds(300)).toBe("5 min");
    expect(formatBucketSeconds(3600)).toBe("1 h");
  });
});
