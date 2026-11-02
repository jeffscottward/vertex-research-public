import { describe, expect, it } from "vitest";

import {
  avoidZero,
  chiSquareSurvival,
  logGamma,
  normalCdfPrecise,
  normalQuantile,
  regularizedBeta,
  regularizedGammaQ,
  studentTCdf,
  studentTQuantile,
} from "./quant-distributions.ts";

// Reference values: SciPy 1.18.1 (special.gammaln, betainc, gammaincc; stats.t, chi2, norm).
describe("special functions", () => {
  it("matches ln Gamma, including the reflection branch", () => {
    expect(logGamma(0.25)).toBeCloseTo(1.288_022_524_698_077_4, 12);
    expect(logGamma(10.5)).toBeCloseTo(13.940_625_219_403_763, 11);
    return expect(logGamma(1)).toBeCloseTo(0, 13);
  });

  it("matches the regularized incomplete beta on both continued-fraction sides", () => {
    expect(regularizedBeta(0.3, 2.5, 3.5)).toBeCloseTo(
      0.296_752_989_295_666_46,
      12
    );
    expect(regularizedBeta(0.9, 0.5, 7)).toBeCloseTo(
      0.999_999_978_070_215_7,
      12
    );
    expect(regularizedBeta(0, 2, 3)).toBe(0);
    return expect(regularizedBeta(1, 2, 3)).toBe(1);
  });

  it("matches the regularized upper incomplete gamma for series and fraction", () => {
    expect(regularizedGammaQ(3, 2.5)).toBeCloseTo(0.543_813_115_883_329_7, 12);
    expect(regularizedGammaQ(0.5, 0.1)).toBeCloseTo(
      0.654_720_846_018_576_8,
      12
    );
    expect(regularizedGammaQ(5, 20)).toBeCloseTo(1.694_474_393_006_737e-5, 15);
    return expect(regularizedGammaQ(2, 0)).toBe(1);
  });

  it("replaces values below the Lentz floor", () => {
    expect(avoidZero(0)).toBe(1e-300);
    return expect(avoidZero(-2)).toBe(-2);
  });
});

describe("distributions", () => {
  it("matches the Student t CDF and quantile", () => {
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.974_994_114_091_444_3, 10);
    expect(studentTCdf(-1.5, 3)).toBeCloseTo(0.115_291_932_622_411_47, 10);
    expect(studentTCdf(0.7, 120)).toBeCloseTo(0.757_358_922_257_179_7, 10);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228_138_851_986_274, 9);
    expect(studentTQuantile(0.025, 4)).toBeCloseTo(-2.776_445_105_197_794, 9);
    return expect(studentTQuantile(0.9, 1000)).toBeCloseTo(
      1.282_398_721_460_924_7,
      9
    );
  });

  it("rejects quantile probabilities outside (0, 1)", () => {
    expect(() => studentTQuantile(1, 5)).toThrow(RangeError);
    return expect(() => normalQuantile(0)).toThrow(RangeError);
  });

  it("matches the chi-square upper tail", () => {
    expect(chiSquareSurvival(18.307, 10)).toBeCloseTo(
      0.050_000_589_091_398_12,
      11
    );
    expect(chiSquareSurvival(3.2, 1)).toBeCloseTo(0.073_638_270_120_302_58, 11);
    return expect(chiSquareSurvival(40, 20)).toBeCloseTo(
      0.004_995_412_308_307_578_5,
      12
    );
  });

  it("matches the standard normal CDF and quantile in all three regions", () => {
    expect(normalCdfPrecise(1.96)).toBeCloseTo(0.975_002_104_851_779_5, 12);
    expect(normalCdfPrecise(-3.5)).toBeCloseTo(
      0.000_232_629_079_035_525_02,
      14
    );
    expect(normalQuantile(0.975)).toBeCloseTo(1.959_963_984_540_054, 8);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090_232_306_167_813, 8);
    expect(normalQuantile(0.9999)).toBeCloseTo(3.719_016_485_455_709, 8);
    return expect(normalQuantile(0.3)).toBeCloseTo(-0.524_400_512_708_040_9, 8);
  });
});
