import { describe, expect, it } from "vitest";

import {
  blackScholes,
  expectedMove,
  lognormalPdf,
  mulberry32,
  normCdf,
  probabilityAbove,
  realizedVol,
  round,
} from "./math.ts";

describe("normCdf", () => {
  it("matches reference values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.841_344_746, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.024_997_895, 6);
  });
});

describe("blackScholes", () => {
  const base = { spot: 100, strike: 100, years: 1, rate: 0.05, vol: 0.2 };

  it("prices the textbook call and put", () => {
    expect(blackScholes({ ...base, kind: "call" }).price).toBeCloseTo(
      10.4506,
      3
    );
    expect(blackScholes({ ...base, kind: "put" }).price).toBeCloseTo(5.5735, 3);
  });

  it("satisfies put-call parity", () => {
    const call = blackScholes({ ...base, kind: "call", strike: 110 }).price;
    const put = blackScholes({ ...base, kind: "put", strike: 110 }).price;
    expect(call - put).toBeCloseTo(100 - 110 * Math.exp(-0.05), 6);
  });

  it("returns Greeks with the expected signs", () => {
    const call = blackScholes({ ...base, kind: "call" });
    const put = blackScholes({ ...base, kind: "put" });
    expect(call.delta).toBeCloseTo(0.6368, 3);
    expect(put.delta).toBeCloseTo(call.delta - 1, 6);
    expect(call.gamma).toBeCloseTo(put.gamma, 9);
    expect(call.gamma).toBeGreaterThan(0);
    expect(call.vega).toBeGreaterThan(0);
    expect(call.theta).toBeLessThan(0);
  });

  it("returns intrinsic value at expiry", () => {
    expect(
      blackScholes({ ...base, kind: "call", years: 0, spot: 112 }).price
    ).toBe(12);
    expect(
      blackScholes({ ...base, kind: "put", years: 0, spot: 112 }).price
    ).toBe(0);
    expect(
      blackScholes({ ...base, kind: "call", years: 0, spot: 112 }).delta
    ).toBe(1);
  });
});

describe("distribution helpers", () => {
  it("scales the expected move with the square root of time", () => {
    const one = expectedMove(100, 0.2, 30);
    const four = expectedMove(100, 0.2, 120);
    expect(four / one).toBeCloseTo(2, 6);
  });

  it("integrates the lognormal density to about one", () => {
    let total = 0;
    for (let x = 1; x < 400; x += 0.25)
      total += lognormalPdf(x, 100, 0.3, 90, 0) * 0.25;
    expect(total).toBeCloseTo(1, 3);
  });

  it("returns 0.5 above the drift-adjusted median", () => {
    const median = 100 * Math.exp(-0.5 * 0.2 * 0.2 * 1);
    expect(probabilityAbove(median, 100, 0.2, 365, 0)).toBeCloseTo(0.5, 6);
  });

  it("produces a deterministic seeded sequence", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("edge cases", () => {
  it("has zero density at non-positive prices", () => {
    expect(lognormalPdf(0, 100, 0.2, 30, 0)).toBe(0);
  });

  it("computes realized vol and rejects missing or non-positive closes", () => {
    expect(realizedVol([100, 101, 99, 102], 3, 3)).toBeGreaterThan(0);
    expect(realizedVol([100, 101], 3, 1)).toBeNull();
    expect(realizedVol([], 2, 1)).toBeNull();
    expect(realizedVol([100, 0, 101], 2, 2)).toBeNull();
    expect(realizedVol([100, 101], 1, 2)).toBeNull();
  });

  it("rounds to two digits by default", () => {
    expect(round(1.234_56)).toBe(1.23);
    expect(round(1.234_56, 3)).toBe(1.235);
  });
});
