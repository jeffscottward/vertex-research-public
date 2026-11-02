import { describe, expect, it } from "vitest";

import { genomeDefinition } from "./autopilot-genome.ts";
import {
  AUTOPILOT_GATE,
  type AutopilotLedger,
  evaluateGate,
  evaluateInSample,
  neighbourCheck,
  outOfSampleSharpe,
  splitIndex,
} from "./autopilot-gate.ts";
import {
  type BarColumns,
  InstantBacktestInputError,
} from "./instant-backtest-engine.ts";
import type { StrategyDefinition } from "./strategy-dsl.ts";

const DAY_MS = 86_400_000;

// A rising series with a 40-bar cycle: buying above a short average and leaving below it earns
// money in every part of the series.
const trending = (size: number): BarColumns => {
  const c = Float64Array.from(
    { length: size },
    (_, index) => 100 * Math.exp(0.0008 * index) + 4 * Math.sin(index / 6.4)
  );
  const o = Float64Array.from(c, (close, index) =>
    index === 0 ? close : (c[index - 1] as number)
  );
  return {
    c,
    h: Float64Array.from(
      c,
      (close, index) => Math.max(close, o[index] as number) + 0.3
    ),
    l: Float64Array.from(
      c,
      (close, index) => Math.min(close, o[index] as number) - 0.3
    ),
    o,
    t: Float64Array.from(
      { length: size },
      (_, index) => Date.UTC(2015, 0, 1) + index * DAY_MS
    ),
  };
};

const momentum: StrategyDefinition = genomeDefinition(
  {
    entry: [{ block: "trendEma", params: [20] }],
    exit: [{ block: "exitBelowSma", params: [5] }],
    stop: null,
    target: null,
  },
  "AP momentum"
);

const never: StrategyDefinition = {
  ...momentum,
  entry: {
    all: [
      {
        left: { field: "close", type: "price" },
        op: ">",
        right: { type: "const", value: 1e9 },
      },
    ],
  },
};

const ledger = (total: number, spread = 0.0002): AutopilotLedger => ({
  key: "TEST/1d",
  others: Array.from({ length: Math.min(total - 1, 40) }, (_, index) => ({
    firstT: "2015-01-01T00:00:00.000Z",
    id: `t${index}`,
    lastT: "2018-06-01T00:00:00.000Z",
    meanReturn: spread * ((index % 7) - 3),
    returns: 600,
    stdReturn: 0.01,
  })),
  total,
});

describe("autopilot gate", () => {
  const bars = trending(1000);

  it("scores only the in-sample bars", () => {
    const result = evaluateInSample(bars, momentum, 2);
    expect(splitIndex(1000)).toBe(600);
    expect(result.summary.returns).toBe(599);
    expect(result.summary.lastT).toBe(
      new Date(bars.t[599] as number).toISOString()
    );
    expect(result.trades).toBeGreaterThan(
      AUTOPILOT_GATE.inSampleTradesForFullFitness
    );
    expect(result.sharpe).toBeGreaterThan(0);
    expect(result.fitness).toBe(result.sharpe);
    const idle = evaluateInSample(bars, never, 2);
    expect(idle.fitness).toBeNull();
    expect(idle.trades).toBe(0);
    expect(idle.sharpe).toBeNull();
  });

  it("scales the fitness down for few trades", () => {
    const rare = genomeDefinition(
      {
        entry: [{ block: "emaCross", params: [20, 200] }],
        exit: [{ block: "exitBelowSma", params: [200] }],
        stop: null,
        target: null,
      },
      "AP rare"
    );
    const result = evaluateInSample(trending(1000), rare, 2);
    expect(result.trades).toBeGreaterThan(0);
    expect(result.trades).toBeLessThan(
      AUTOPILOT_GATE.inSampleTradesForFullFitness
    );
    expect(result.fitness).toBeCloseTo(
      (result.sharpe as number) *
        (result.trades / AUTOPILOT_GATE.inSampleTradesForFullFitness)
    );
  });

  it("passes a robust candidate when it is the only trial", () => {
    const inSample = evaluateInSample(bars, momentum, 2);
    const report = evaluateGate({
      bars,
      costBps: 2,
      definition: momentum,
      inSample,
      ledger: ledger(1),
      seed: "a",
    });
    const failed = report.checks
      .filter((item) => !item.passed)
      .map((item) => item.id);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.folds).toHaveLength(3);
    expect(report.curve.length).toBeLessThanOrEqual(AUTOPILOT_GATE.curvePoints);
    expect(report.splitT).toBe(new Date(bars.t[600] as number).toISOString());
    expect(report.costStress.costBps).toBe(4);
    expect(report.deflatedSharpe?.trials).toBe(1);
    expect(report.version).toBe("autopilot-gate-v1");
  });

  it("rejects the same candidate when it was one of many trials", () => {
    const inSample = evaluateInSample(bars, momentum, 2);
    const report = evaluateGate({
      bars,
      costBps: 2,
      definition: momentum,
      inSample,
      ledger: ledger(1_000_000, 0.004),
      seed: "a",
    });
    const dsr = report.checks.find((item) => item.id === "deflatedSharpe");
    expect(dsr?.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.deflatedSharpe?.trials).toBe(1_000_000);
    expect(report.fdr?.tested).toBe(1_000_000);
  });

  it("rejects a candidate without trades and explains every check", () => {
    const inSample = evaluateInSample(bars, never, 0);
    const report = evaluateGate({
      bars,
      costBps: 0,
      definition: never,
      inSample,
      ledger: ledger(5),
      seed: "b",
    });
    expect(report.passed).toBe(false);
    expect(report.monteCarlo).toBeNull();
    expect(report.deflatedSharpe).toBeNull();
    expect(report.fdr).toBeNull();
    expect(report.oos.sharpe).toBeNull();
    expect(report.checks.every((item) => !item.passed)).toBe(true);
    expect(report.checks.find((item) => item.id === "monteCarlo")?.detail).toBe(
      "No out-of-sample trades to resample."
    );
    expect(report.costStress.costBps).toBe(2);
  });

  it("refuses too few bars and non-increasing times", () => {
    expect(() => evaluateInSample(trending(100), momentum, 2)).toThrow(
      InstantBacktestInputError
    );
    const flat = { ...bars, t: new Float64Array(1000) };
    expect(() => evaluateInSample(flat, momentum, 2)).toThrow(
      "Bar times must increase"
    );
    expect(() => outOfSampleSharpe(trending(10), momentum, 2)).toThrow(
      InstantBacktestInputError
    );
  });

  it("measures the out-of-sample Sharpe of a full run", () => {
    expect(outOfSampleSharpe(bars, momentum, 2)).toBeGreaterThan(0.5);
    expect(outOfSampleSharpe(bars, never, 2)).toBeNull();
  });

  it("checks the parameter neighbourhood", () => {
    expect(neighbourCheck(1, [0.9, 0.8, 0.6, 0.2]).passed).toBe(true);
    expect(neighbourCheck(1, [0.9, 0.4, 0.3, null]).passed).toBe(false);
    expect(neighbourCheck(1, [0.9, -0.1]).value).toBe(0.5);
    expect(neighbourCheck(1, []).passed).toBe(false);
    expect(neighbourCheck(null, [1, 2]).value).toBe(0);
    expect(neighbourCheck(-1, [-0.4]).passed).toBe(false);
  });
});
