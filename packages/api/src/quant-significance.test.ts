import { describe, expect, it } from "vitest";

import { createRandom } from "./backtest-analytics.ts";
import { at, mean, quantile, stdev } from "./quant-arrays.ts";
import {
  bootstrapTest,
  meanTTest,
  stationaryBootstrap,
  stationaryResample,
} from "./quant-significance.ts";

const RETURNS = [
  0.01, -0.004, 0.007, 0.012, -0.002, 0.003, 0.009, -0.006, 0.004, 0.008,
];

// Fixed sequence generator for exact resampling checks.
const sequence = (values: readonly number[]) => {
  let index = 0;
  return () => {
    const value = at(values, index % values.length);
    index += 1;
    return value;
  };
};

describe("quant arrays", () => {
  it("rejects out-of-range reads and interpolates quantiles", () => {
    expect(() => at([1], 3)).toThrow(RangeError);
    expect(mean([])).toBe(0);
    expect(stdev([1])).toBe(0);
    return expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe("meanTTest", () => {
  // Reference: SciPy 1.18.1 stats.ttest_1samp(r, 0) and its confidence_interval(0.95).
  it("matches SciPy's one-sample t-test", () => {
    const test = meanTTest(RETURNS)!;
    expect(test.n).toBe(10);
    expect(test.df).toBe(9);
    expect(test.mean).toBeCloseTo(0.0041, 15);
    expect(test.stdError).toBeCloseTo(0.001_974_560_429_282_651_3, 15);
    expect(test.t).toBeCloseTo(2.076_411_508_707_035, 12);
    expect(test.pValue).toBeCloseTo(0.033_828_765_274_355_27, 10);
    expect(test.pValueTwoSided).toBeCloseTo(0.067_657_530_548_710_54, 10);
    expect(test.ciLower).toBeCloseTo(-0.000_366_766_018_479_647_6, 10);
    return expect(test.ciUpper).toBeCloseTo(0.008_566_766_018_479_648, 10);
  });

  it("needs three observations with spread", () => {
    expect(meanTTest([0.1, 0.2])).toBeNull();
    expect(meanTTest([0.25, 0.25, 0.25])).toBeNull();
    // Rounding leaves a deviation near 1e-17 for constant non-binary returns.
    expect(meanTTest([0.1, 0.1, 0.1])).toBeNull();
    return expect(meanTTest([0, 0, 0])).toBeNull();
  });
});

describe("stationaryResample", () => {
  it("continues the block and wraps around while no restart is drawn", () =>
    // First draw picks index 3; later draws (0.99) never restart with block length 10.
    expect(
      stationaryResample([1, 2, 3, 4, 5], 10, sequence([0.6, 0.99]))
    ).toEqual([4, 5, 1, 2, 3]));

  it("restarts at a new random index when the restart draw is below 1/L", () =>
    // Draws: start 0.0 -> index 0; restart (0.1 < 0.5) then 0.8 -> index 4; no restart (0.9) -> 0.
    expect(
      stationaryResample(
        [1, 2, 3, 4, 5],
        2,
        sequence([0, 0.1, 0.8, 0.9, 0.9, 0.9])
      )
    ).toEqual([1, 5, 1, 2, 3]));
});

describe("bootstrapTest", () => {
  it("counts centred samples at or beyond the estimate", () => {
    // Estimate 1; centred samples -1, 0, 1, 2 -> two are >= 1 -> p = 3 / 5.
    const test = bootstrapTest(1, [0, 1, 2, 3, Number.NaN])!;
    expect(test.pValue).toBeCloseTo(0.6, 15);
    expect(test.ciLower).toBeCloseTo(0.075, 12);
    return expect(test.ciUpper).toBeCloseTo(2.925, 12);
  });

  it("returns null without finite samples", () =>
    expect(bootstrapTest(1, [Number.NaN])).toBeNull());
});

describe("stationaryBootstrap", () => {
  it("is deterministic, brackets the estimates and rejects H0 for a strong positive drift", () => {
    const drift = Array.from(
      { length: 250 },
      (_, index) => 0.002 + 0.01 * Math.sin(index * 1.7)
    );
    const run = () =>
      stationaryBootstrap(drift, 6, 500, Math.sqrt(252), createRandom(7))!;
    const result = run();
    expect(run()).toEqual(result);
    expect(result.expectedBlockLength).toBe(6);
    expect(result.resamples).toBe(500);
    expect(result.mean.ciLower).toBeLessThan(result.mean.estimate);
    expect(result.mean.ciUpper).toBeGreaterThan(result.mean.estimate);
    expect(result.mean.pValue).toBeLessThan(0.01);
    expect(result.sharpe!.estimate).toBeGreaterThan(2);
    return expect(result.sharpe!.pValue).toBeLessThan(0.01);
  });

  it("does not reject H0 for a zero-mean series", () => {
    const flat = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0 ? 0.01 : -0.01
    );
    const result = stationaryBootstrap(flat, 1, 400, 1, createRandom(3))!;
    return expect(result.mean.pValue).toBeGreaterThan(0.2);
  });

  it("drops the Sharpe test without spread and degrades to null without data", () => {
    const constant = stationaryBootstrap(
      [0.25, 0.25, 0.25],
      1,
      10,
      1,
      createRandom(1)
    )!;
    expect(constant.sharpe).toBeNull();
    expect(constant.mean.pValue).toBeCloseTo(1 / 11, 15);
    expect(stationaryBootstrap([0.01, 0.02], 1, 10, 1, createRandom(1))).toBe(
      null
    );
    return expect(
      stationaryBootstrap(
        [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1],
        1,
        5,
        1,
        sequence([0, 0.1])
      )
    ).toBeNull();
  });
});
