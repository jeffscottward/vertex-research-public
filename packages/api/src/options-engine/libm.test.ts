import { describe, expect, it } from "vitest";
import {
  erf,
  erfc,
  exp,
  ldexpRound,
  log,
  pyRound,
  pySum,
  roundHalfEven,
} from "./libm.ts";

// Expected values: CPython 3.12 math / round / sum on glibc 2.44 (correctly rounded on these inputs).
describe("exp and log", () => {
  it("round correctly, also into the subnormal range", () => {
    expect([-709.08, -740, -745.1, 709.7, 1e-300, 0.5].map(exp)).toEqual([
      1.123_230_200_869_036_4e-308, 4.2e-322, 5e-324,
      1.654_984_027_680_264_4e308, 1, 1.648_721_270_700_128_2,
    ]);
    expect([5e-324, 1e-310, 1.5, 0.75, 1e308, 2].map(log)).toEqual([
      -744.440_071_921_381_2,
      -713.801_378_828_154_2,
      0.405_465_108_108_164_4,
      -0.287_682_072_451_780_9,
      709.196_208_642_166_1,
      Math.LN2,
    ]);
    expect(log(1)).toBe(0);
  });

  it("keeps the IEEE special values", () => {
    expect([Number.NaN, 710, -746].map(exp)).toEqual([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
    ]);
    expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(log)).toEqual([
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it("rounds subnormal ties to even once", () => {
    // (hi + lo) * 2^-1072 = 4.5 or 5.5 units of 2^-1074.
    expect(ldexpRound(1.125, 0, -1072)).toBe(4 * Number.MIN_VALUE);
    expect(ldexpRound(1.375, 0, -1072)).toBe(6 * Number.MIN_VALUE);
    expect(ldexpRound(1.125, 2 ** -60, -1072)).toBe(5 * Number.MIN_VALUE);
    expect(ldexpRound(1.125, -(2 ** -60), -1072)).toBe(4 * Number.MIN_VALUE);
  });
});

describe("erf and erfc", () => {
  it("round correctly on the series and the continued fraction", () => {
    expect([-3, -0.3, 0.4, 3, 27, 26.6].map(erfc)).toEqual([
      1.999_977_909_503_001_5, 1.328_626_759_459_127_4, 0.571_607_644_953_331_5,
      2.209_049_699_858_544e-5, 5.237_05e-319, 1.088_512_588_544_227e-309,
    ]);
    expect([-3, 0.3, 2.7, -1e-300].map(erf)).toEqual([
      -0.999_977_909_503_001_4, 0.328_626_759_459_127_4,
      0.999_865_667_260_059_4, -1.128_379_167_095_512_6e-300,
    ]);
  });

  it("saturate and keep the special values", () => {
    expect([Number.NaN, 28, -10, 0].map(erfc)).toEqual([Number.NaN, 0, 2, 1]);
    expect([Number.NaN, 10, -12].map(erf)).toEqual([Number.NaN, 1, -1]);
    expect(Object.is(erf(-0), -0)).toBe(true);
  });
});

describe("CPython rounding and sum", () => {
  it("round(x, n) rounds the exact binary value to the nearest decimal, ties to even", () => {
    const cases: [number, number, number][] = [
      [0.007_812_5, 6, 0.007_812],
      [0.023_437_5, 6, 0.023_438],
      [-0.007_812_5, 6, -0.007_812],
      [2.675, 2, 2.67],
      [5e-324, 2, 0],
      [1e22, 2, 1e22],
      [123, 2, 123],
    ];
    for (const [x, digits, expected] of cases)
      expect(pyRound(x, digits)).toBe(expected);
    expect(Object.is(pyRound(-0.001, 2), -0)).toBe(true);
    expect(
      [Number.NaN, Number.POSITIVE_INFINITY, 0].map((x) => pyRound(x, 2))
    ).toEqual([Number.NaN, Number.POSITIVE_INFINITY, 0]);
  });

  it("round(x) rounds ties to even and never gives -0", () => {
    expect([2.5, 3.5, -2.5, -3.5, 7.2].map(roundHalfEven)).toEqual([
      2, 4, -2, -4, 7,
    ]);
    expect(Object.is(roundHalfEven(-0.4), 0)).toBe(true);
  });

  it("sum() compensates like CPython 3.12", () => {
    expect(pySum([1e100, 1, -1e100])).toBe(1);
    expect(pySum(new Array(10).fill(0.1))).toBe(1);
    expect(pySum([1, 1e100, 1, -1e100])).toBe(2);
    expect(pySum([])).toBe(0);
    expect(pySum([Number.POSITIVE_INFINITY, 1])).toBe(Number.POSITIVE_INFINITY);
  });
});
