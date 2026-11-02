import { describe, expect, it } from "vitest";

import { createRandom } from "./backtest-analytics.ts";
import {
  fitGarch11,
  garchNegativeLogLikelihood,
  ljungBox,
  nelderMead,
  volatilityClustering,
} from "./quant-volatility.ts";

// Objective that returns scripted values in call order (0 after the script ends).
const scripted = (values: number[]) => () => values.shift() ?? 0;
const ONE_STEP = { step: 1, tolerance: 1e-12, maxIterations: 1 };

// Standard normal draws (Box-Muller) from the seeded analytics generator.
const normals = (count: number, seed: number): number[] => {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  });
};

const simulateGarch = (
  count: number,
  alpha: number,
  beta: number,
  variance: number
): number[] => {
  const omega = variance * (1 - alpha - beta);
  let conditional = variance;
  return normals(count, 11).map((shock) => {
    const value = Math.sqrt(conditional) * shock;
    conditional = omega + alpha * value * value + beta * conditional;
    return value;
  });
};

describe("ljungBox", () => {
  it("matches statsmodels acorr_ljungbox", () => {
    // Reference: statsmodels 0.15.0 acorr_ljungbox(x, lags=[8]) -> Q 93.014605, p 1.134619e-16.
    const values = Array.from(
      { length: 40 },
      (_, index) =>
        Math.sin(index * 0.7) + 0.3 * Math.cos(index * 2.1) + (index % 5) * 0.1
    );
    const result = ljungBox(values)!;
    expect(result.lags).toBe(8);
    expect(result.q).toBeCloseTo(93.014_605, 5);
    return expect(result.pValue).toBeCloseTo(1.134_619e-16, 21);
  });

  it("needs twenty values with variation", () => {
    expect(ljungBox(new Array<number>(19).fill(1))).toBeNull();
    return expect(ljungBox(new Array<number>(30).fill(1))).toBeNull();
  });
});

describe("nelderMead", () => {
  // Start (0,0), step 1: vertices (0,0)=0, (1,0)=1, (0,1)=2. Centroid (0.5,0); reflection (1,-1).
  const run = (values: number[]) =>
    nelderMead(scripted([0, 1, 2, ...values]), [0, 0], ONE_STEP);

  it("accepts an expansion or falls back to the reflection", () => {
    expect(run([-1, -2])).toMatchObject({ point: [1.5, -2], value: -2 });
    return expect(run([-1, 5])).toMatchObject({ point: [1, -1], value: -1 });
  });

  it("accepts a reflection between the best and second-worst vertex", () =>
    expect(run([0.5]).value).toBe(0));

  it("accepts outside and inside contractions", () => {
    expect(run([1.5, 1.2]).iterations).toBe(1);
    return expect(run([3, 1.9]).converged).toBe(false);
  });

  it("shrinks towards the best vertex when a contraction fails", () => {
    expect(run([1.5, 1.7, -3, 4]).point).toEqual([0.5, 0]);
    return expect(run([3, 2.5, 4, -5]).point).toEqual([0, 0.5]);
  });

  it("stops once the simplex values agree", () => {
    const result = nelderMead(() => 1, [0, 0], {
      step: 1,
      tolerance: 0,
      maxIterations: 10,
    });
    expect(result.converged).toBe(true);
    return expect(result.iterations).toBe(0);
  });

  it("minimizes a smooth bowl", () => {
    const result = nelderMead(
      ([x = 0, y = 0]) => (x - 1) ** 2 + 3 * (y + 2) ** 2,
      [4, 4],
      { step: 0.5, tolerance: 1e-14, maxIterations: 500 }
    );
    expect(result.converged).toBe(true);
    expect(result.point[0]).toBeCloseTo(1, 5);
    return expect(result.point[1]).toBeCloseTo(-2, 5);
  });
});

describe("GARCH(1,1)", () => {
  it("computes the likelihood recursion exactly", () => {
    // Hand check (NumPy): residuals 0.01, -0.02, 0.015; variance 2e-4; alpha 0.1; beta 0.8.
    const result = garchNegativeLogLikelihood(
      [0.01, -0.02, 0.015],
      0.0002,
      0.1,
      0.8
    );
    expect(result.value).toBeCloseTo(-10.939_010_023_950_285, 12);
    return expect(result.nextVariance).toBeCloseTo(0.000_212_1, 15);
  });

  it("recovers the parameters of a simulated GARCH series", () => {
    const returns = simulateGarch(4000, 0.08, 0.9, 1e-4);
    const fit = fitGarch11(returns, 252)!;
    expect(fit.alpha).toBeGreaterThan(0.05);
    expect(fit.alpha).toBeLessThan(0.11);
    expect(fit.beta).toBeGreaterThan(0.86);
    expect(fit.beta).toBeLessThan(0.94);
    expect(fit.persistence).toBeCloseTo(fit.alpha + fit.beta, 12);
    expect(fit.omega).toBeGreaterThan(0);
    expect(fit.halfLifePeriods).toBeGreaterThan(10);
    expect(fit.horizonPeriods).toBe(21);
    expect(fit.nextPeriodVolAnnual).toBeCloseTo(
      fit.nextPeriodVol * Math.sqrt(252),
      12
    );
    expect(fit.longRunVolAnnual).toBeCloseTo(Math.sqrt(1e-4 * 252), 2);
    return expect(fit.converged).toBe(true);
  });

  it("needs fifty returns with variation", () => {
    expect(fitGarch11(new Array<number>(49).fill(0.01), 252)).toBeNull();
    return expect(fitGarch11(new Array<number>(60).fill(0.01), 252)).toBeNull();
  });
});

describe("volatilityClustering", () => {
  it("detects clustering in squared returns of a GARCH series", () => {
    const result = volatilityClustering(
      simulateGarch(1000, 0.15, 0.8, 1e-4),
      252
    );
    expect(result.ljungBoxSquared!.pValue).toBeLessThan(0.001);
    expect(result.garch).not.toBeNull();
    return expect(result.garchReason).toBeNull();
  });

  it("states why no GARCH fit exists", () => {
    expect(volatilityClustering([0.01, 0.02], 252).garchReason).toContain(
      "at least 50 returns"
    );
    expect(
      volatilityClustering(new Array<number>(60).fill(0.01), null).garchReason
    ).toContain("at least 50 returns");
    return expect(
      volatilityClustering(new Array<number>(60).fill(0.01), 252).garchReason
    ).toBe("The returns have no variation.");
  });
});
