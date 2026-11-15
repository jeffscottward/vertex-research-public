import { describe, expect, it } from "vitest";
import {
  atmIv,
  bsDelta,
  bsPrice,
  halfSpread,
  legCost,
  normCdf,
  smileIv,
  strikeStep,
} from "./pricing.ts";

// Expected values: services/research/strategies/qc_ports/options.py.
describe("Black-Scholes", () => {
  it("matches options.py prices and deltas", () => {
    expect(bsPrice("call", 100, 105, 0.25, 0.04, 0.015, 0.2)).toBe(
      2.255_872_058_581_793_7
    );
    expect(bsPrice("put", 100, 95, 0.25, 0.04, 0.015, 0.2)).toBe(
      1.697_824_016_427_450_3
    );
    expect(bsDelta("call", 100, 105, 0.25, 0.04, 0.015, 0.2)).toBe(
      0.352_357_072_436_099_8
    );
    expect(bsDelta("put", 100, 95, 0.25, 0.04, 0.015, 0.2)).toBe(
      -0.264_848_426_845_834_1
    );
    expect(normCdf(1)).toBe(0.841_344_746_068_542_9);
  });

  it("is the intrinsic value and a step delta at expiry", () => {
    expect([
      bsPrice("call", 100, 90, 0, 0, 0, 0.2),
      bsPrice("call", 100, 110, 0, 0, 0, 0.2),
    ]).toEqual([10, 0]);
    expect([
      bsPrice("put", 100, 110, 0, 0, 0, 0.2),
      bsPrice("put", 100, 90, 0, 0, 0, 0.2),
    ]).toEqual([10, 0]);
    expect([
      bsDelta("call", 100, 90, 0, 0, 0, 0.2),
      bsDelta("call", 100, 110, 0, 0, 0, 0.2),
    ]).toEqual([1, 0]);
    expect([
      bsDelta("put", 100, 110, 0, 0, 0, 0.2),
      bsDelta("put", 100, 90, 0, 0, 0, 0.2),
    ]).toEqual([-1, 0]);
  });

  it("refuses bad inputs", () => {
    expect(() => bsPrice("straddle" as "call", 100, 100, 1, 0, 0, 0.2)).toThrow(
      "right must be call or put"
    );
    expect(() => bsPrice("call", Number.NaN, 100, 1, 0, 0, 0.2)).toThrow(
      "spot must be a finite number"
    );
    expect(() =>
      bsDelta("put", 100, 100, 1, 0, Number.POSITIVE_INFINITY, 0.2)
    ).toThrow("q must be a finite number");
    expect(() => bsPrice("call", 100, 0, 1, 0, 0, 0.2)).toThrow(
      "spot and strike must be above 0"
    );
    expect(() => bsPrice("call", 100, 100, 1, 0, 0, 0)).toThrow(
      "sigma must be above 0"
    );
    expect(() => bsPrice("call", 100, 100, -1, 0, 0, 0.2)).toThrow(
      "t, r and q must not be negative"
    );
  });
});

describe("volatility and cost model", () => {
  it("scales the IV index and applies the clamped, floored skew", () => {
    expect(atmIv("GVZ", 17.3)).toBe(0.164_35);
    expect(smileIv(0.2, 100, 90, 0.25, -0.3)).toBe(0.263_216_309_394_695_76);
    expect(smileIv(0.2, 100, 50, 0.25, -0.3)).toBe(0.38); // clamped at -3
    expect(smileIv(0.2, 100, 300, 0.25, -0.3)).toBe(0.1); // floored at 0.5 ATM
    expect([
      smileIv(0.2, 100, 90, 0, -0.3),
      smileIv(0.2, 100, 90, 0.25, 0),
    ]).toEqual([0.2, 0.2]);
    expect(() => atmIv("XYZ", 20)).toThrow("No ATM factor for XYZ");
    expect(() => atmIv("VIX", Number.NaN)).toThrow(
      "level must be a finite number"
    );
    expect(() => atmIv("VIX", 0)).toThrow("IV index level must be above 0");
    expect(() => smileIv(0, 100, 90, 0.25, -0.3)).toThrow(
      "ATM IV must be above 0"
    );
  });

  it("prices legs at commission plus half the spread", () => {
    expect([strikeStep(25), strikeStep(24.99)]).toEqual([1, 0.5]);
    expect([legCost("SPY", 3), legCost("SPY", 0.2)]).toEqual([3.65, 1.65]);
    expect(halfSpread("USO", 0)).toBe(0.01);
    expect(() => halfSpread("XYZ", 1)).toThrow("No spread model for XYZ");
    expect(() => halfSpread("SPY", Number.NaN)).toThrow(
      "mid must be a finite number"
    );
    expect(() => halfSpread("SPY", -1)).toThrow("mid must not be negative");
  });
});
