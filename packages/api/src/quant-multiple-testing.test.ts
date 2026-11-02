import { describe, expect, it } from "vitest";

import {
  benjaminiHochberg,
  type CurrentTrial,
  deflatedSharpe,
  expectedMaxSharpe,
  multipleTesting,
  type TrialReturns,
  usableTrial,
} from "./quant-multiple-testing.ts";

const trial = (
  id: string,
  meanReturn: number | null,
  stdReturn: number | null = 0.01,
  returns = 252
): TrialReturns => ({
  firstT: "2023-01-01",
  id,
  lastT: "2024-01-01",
  meanReturn,
  returns,
  stdReturn,
});

const current = (
  meanReturn: number,
  skew = 0,
  excessKurtosis = 0
): CurrentTrial => ({
  excessKurtosis,
  periodsPerYear: 252 / (365 / 365.25),
  returns: trial("self", meanReturn),
  skew,
});

describe("expectedMaxSharpe", () => {
  it("matches the closed form and is zero for a single trial", () => {
    // Reference: sqrt(V) * ((1 - gamma) * Phi^-1(1 - 1/N) + gamma * Phi^-1(1 - 1/(N e))), SciPy norm.ppf.
    expect(expectedMaxSharpe(10, 0.01)).toBeCloseTo(0.157_459_830_134_575, 8);
    expect(expectedMaxSharpe(100, 0.5 / 250)).toBeCloseTo(
      0.113_172_001_865_132_14,
      8
    );
    return expect(expectedMaxSharpe(1, 0.5)).toBe(0);
  });
});

describe("deflatedSharpe", () => {
  it("matches Bailey and Lopez de Prado's published example", () => {
    // Annual SR 2.5, 5 years daily, 100 trials, V[SR] = 0.5 (annual), skew -3, kurtosis 10 -> DSR ~ 0.9004.
    const result = deflatedSharpe({
      kurtosis: 10,
      observations: 1250,
      sharpe: 2.5 / Math.sqrt(250),
      sharpeVariance: 0.5 / 250,
      skew: -3,
      trials: 100,
    })!;
    return expect(result.probability).toBeCloseTo(0.9004, 4);
  });

  it("matches the optimizer's hand-computed case", () => {
    const result = deflatedSharpe({
      kurtosis: 3,
      observations: 100,
      sharpe: 0.3,
      sharpeVariance: 0.01,
      skew: 0,
      trials: 10,
    })!;
    expect(result.expectedMaxSharpe).toBeCloseTo(0.157_459_8, 7);
    expect(result.z).toBeCloseTo(1.387_384_1, 6);
    return expect(result.probability).toBeCloseTo(0.917_338, 6);
  });

  it("is undefined for one observation or a non-positive deflation term", () => {
    const base = {
      kurtosis: 3,
      observations: 100,
      sharpe: 0.3,
      sharpeVariance: 0.01,
      skew: 0,
      trials: 10,
    };
    expect(deflatedSharpe({ ...base, observations: 1 })).toBeNull();
    return expect(deflatedSharpe({ ...base, skew: 10 })).toBeNull();
  });
});

describe("benjaminiHochberg", () => {
  it("matches statsmodels fdr_bh in input order", () => {
    // Reference: statsmodels 0.15.0 multipletests(p, method="fdr_bh").
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005, 0.2, 0.5]);
    const expected = [0.03, 0.06, 0.06, 0.03, 0.24, 0.5];
    for (const [index, value] of expected.entries())
      expect(q[index]).toBeCloseTo(value, 12);
    return expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe("usableTrial", () => {
  it("annualizes by observed frequency and tests the mean", () => {
    const result = usableTrial(trial("a", 0.001))!;
    // 252 returns over 365 days -> 252.69 periods per year.
    expect(result.annualSharpe).toBeCloseTo(
      0.1 * Math.sqrt(252 / (365 / 365.25)),
      10
    );
    return expect(result.pValue).toBeLessThan(0.1);
  });

  it("rejects trials without enough returns, spread or elapsed time", () => {
    expect(usableTrial(trial("a", 0.001, 0.01, 2))).toBeNull();
    expect(usableTrial(trial("a", null))).toBeNull();
    expect(usableTrial(trial("a", 0.001, null))).toBeNull();
    expect(usableTrial(trial("a", 0.001, 0))).toBeNull();
    expect(usableTrial(trial("a", 0.001, 1e-17))).toBeNull();
    expect(usableTrial({ ...trial("a", 0.001), firstT: null })).toBeNull();
    expect(usableTrial({ ...trial("a", 0.001), lastT: null })).toBeNull();
    return expect(
      usableTrial({ ...trial("a", 0.001), lastT: "2023-01-01T00:00:00Z" })
    ).toBeNull();
  });
});

describe("multipleTesting", () => {
  it("deflates against every trial in the ledger and ranks the backtest with BH", () => {
    const result = multipleTesting(
      {
        key: "strategy-1",
        others: [trial("b", 0.0002), trial("c", -0.0004), trial("d", null)],
        scope: "strategy",
        total: 4,
      },
      current(0.002)
    );
    expect(result.ledger).toEqual({
      key: "strategy-1",
      sampled: 4,
      scope: "strategy",
      trials: 4,
      usableTrials: 3,
    });
    expect(result.deflatedSharpe?.trials).toBe(4);
    expect(result.deflatedSharpe?.expectedMaxSharpe).toBeGreaterThan(0);
    expect(result.deflatedSharpeReason).toBeNull();
    expect(result.benjaminiHochberg).toMatchObject({
      alpha: 0.05,
      discoveries: 1,
      tested: 3,
    });
    return expect(result.benjaminiHochberg?.qValue).toBeLessThan(0.05);
  });

  it("counts results outside the sample as BH tests with p = 1", () => {
    const result = multipleTesting(
      {
        key: "strategy-1",
        others: [trial("b", 0.0002)],
        scope: "strategy",
        total: 10,
      },
      current(0.002)
    );
    expect(result.ledger.sampled).toBe(2);
    expect(result.benjaminiHochberg?.tested).toBe(10);
    return expect(result.deflatedSharpe?.trials).toBe(10);
  });

  it("uses no deflation for a single trial (DSR equals PSR against zero)", () => {
    const result = multipleTesting(
      { key: "task-1", others: [], scope: "task", total: 1 },
      current(0.001)
    );
    expect(result.deflatedSharpe?.expectedMaxSharpe).toBe(0);
    return expect(result.deflatedSharpe?.sharpeVariance).toBe(0);
  });

  it("states why when the Sharpe variance or the deflation term is unknown", () => {
    const unknownVariance = multipleTesting(
      { key: "task-1", others: [trial("b", null)], scope: "task", total: 3 },
      current(0.001)
    );
    expect(unknownVariance.deflatedSharpe).toBeNull();
    expect(unknownVariance.deflatedSharpeReason).toContain("variance");
    const undefinedTerm = multipleTesting(
      { key: "task-1", others: [], scope: "task", total: 1 },
      current(0.002, 80, -2)
    );
    expect(undefinedTerm.deflatedSharpe).toBeNull();
    return expect(undefinedTerm.deflatedSharpeReason).toContain("skew");
  });

  it("explains a backtest without usable returns", () => {
    const missing = multipleTesting(
      { key: "task-1", others: [trial("b", 0.001)], scope: "task", total: 2 },
      null
    );
    expect(missing.deflatedSharpe).toBeNull();
    expect(missing.benjaminiHochberg).toBeNull();
    expect(missing.ledger.usableTrials).toBe(1);
    const flat = multipleTesting(
      { key: "task-1", others: [], scope: "task", total: 1 },
      { ...current(0.001), returns: trial("self", 0.001, 0) }
    );
    return expect(flat.benjaminiHochbergReason).toContain(
      "three equity returns"
    );
  });
});
