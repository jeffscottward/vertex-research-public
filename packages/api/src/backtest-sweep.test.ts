import { describe, expect, it } from "vitest";

import { runBacktestSweep } from "./backtest-sweep.ts";
import {
  BACKTEST_SWEEP_MAX_CELLS,
  type BacktestSweepInput,
  BacktestSweepInputSchema,
} from "./contracts/backtest-sweep.ts";
import {
  type BarColumns,
  runInstantBacktest,
} from "./instant-backtest-engine.ts";

const DAY_MS = 86_400_000;

const waveColumns = (size: number): BarColumns => {
  const close = Float64Array.from(
    { length: size },
    (_, index) => 100 + index * 0.05 + 10 * Math.sin(index / 20)
  );
  return {
    c: close,
    h: close.map((value) => value + 1),
    l: close.map((value) => value - 1),
    o: close.map((value, index) =>
      index === 0 ? value : (close[index - 1] as number)
    ),
    t: Float64Array.from({ length: size }, (_, index) => index * DAY_MS),
  };
};

const baseInput: BacktestSweepInput = {
  costBps: 2,
  dimensions: [
    { from: 5, param: "fast", step: 5, to: 15 },
    { from: 10, param: "slow", step: 10, to: 30 },
  ],
  from: "1970-01-01",
  metric: "totalReturn",
  rule: { fast: 5, kind: "smaCross", slow: 50 },
  symbol: "SPY",
  timeframe: "1d",
  to: "1972-12-31",
};

const parse = (input: unknown) => BacktestSweepInputSchema.safeParse(input);
const messages = (input: unknown): string[] => {
  const result = parse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("runBacktestSweep", () => {
  const bars = waveColumns(800);
  const request = BacktestSweepInputSchema.parse(baseInput);

  it("runs every grid cell with the cell's parameters and the shared costs", () => {
    const grid = runBacktestSweep(bars, request);
    expect(grid.dimensions).toEqual([
      { param: "fast", values: [5, 10, 15] },
      { param: "slow", values: [10, 20, 30] },
    ]);
    expect(grid.cells).toHaveLength(9);
    const cell = grid.cells[5];
    expect(cell?.coordinates).toEqual([1, 2]);
    expect(cell?.params).toEqual([10, 30]);
    const { stats } = runInstantBacktest(bars, {
      costBps: 2,
      rule: { fast: 10, kind: "smaCross", slow: 30 },
      stopLossPct: 0,
      takeProfitPct: 0,
    });
    expect(cell?.metrics).toEqual({
      cagr: stats.cagr,
      maxDrawdown: stats.maxDrawdown,
      profitFactor: stats.profitFactor,
      sharpe: stats.sharpe,
      sortino: stats.sortino,
      totalReturn: stats.totalReturn,
      winRate: stats.winRate,
    });
    expect(cell?.trades).toBe(stats.trades);
    return expect(cell?.error).toBeNull();
  });

  it("keeps rejected cells without values and out of the ranking", () => {
    const grid = runBacktestSweep(bars, request);
    // fast 10 / slow 10 and fast 15 / slow 10 break the fast < slow rule.
    for (const index of [3, 6]) {
      const cell = grid.cells[index];
      expect(cell?.error).toBe("fast must be shorter than slow");
      expect(cell?.trades).toBeNull();
      expect(cell?.metrics.totalReturn).toBeNull();
      expect(cell?.robustness).toEqual({
        neighbourMean: expect.any(Number),
        neighbours: expect.any(Number),
        rank: null,
        spike: false,
        worst: null,
      });
    }
    expect(grid.ranking).toHaveLength(7);
    expect(grid.ranking).not.toContain(3);
    return expect(grid.ranking).not.toContain(6);
  });

  it("ranks by the requested metric and returns the same grid every time", () => {
    const sharpe = BacktestSweepInputSchema.parse({
      ...baseInput,
      metric: "sharpe",
    });
    const first = runBacktestSweep(bars, sharpe);
    expect(runBacktestSweep(bars, sharpe)).toEqual(first);
    const best = first.cells[first.ranking[0] as number];
    expect(best?.robustness.rank).toBe(1);
    return expect(best?.robustness.worst).toBe(
      Math.min(
        ...first.cells
          .filter(
            (cell) =>
              cell.robustness.rank !== null &&
              Math.abs(
                (cell.coordinates[0] as number) -
                  (best?.coordinates[0] as number)
              ) +
                Math.abs(
                  (cell.coordinates[1] as number) -
                    (best?.coordinates[1] as number)
                ) <=
                1
          )
          .map((cell) => cell.metrics.sharpe as number)
      )
    );
  });

  it("sweeps risk settings with decimal steps for a breakout rule", () => {
    const grid = runBacktestSweep(
      bars,
      BacktestSweepInputSchema.parse({
        ...baseInput,
        dimensions: [
          { from: 0.5, param: "stopLossPct", step: 0.5, to: 1.5 },
          { from: 0, param: "trendSma", step: 50, to: 100 },
        ],
        rule: {
          entryLookback: 20,
          exitLookback: 10,
          kind: "breakout",
          trendSma: 0,
        },
      })
    );
    expect(grid.dimensions[0]?.values).toEqual([0.5, 1, 1.5]);
    const { stats } = runInstantBacktest(bars, {
      costBps: 2,
      rule: {
        entryLookback: 20,
        exitLookback: 10,
        kind: "breakout",
        trendSma: 100,
      },
      stopLossPct: 1,
      takeProfitPct: 0,
    });
    return expect(grid.cells[5]?.metrics.totalReturn).toBe(stats.totalReturn);
  });

  it("does not hide errors that are not engine input errors", () => {
    const broken = {
      ...bars,
      get c(): Float64Array {
        throw new TypeError("column read failed");
      },
    };
    return expect(() => runBacktestSweep(broken, request)).toThrow(TypeError);
  });
});

describe("BacktestSweepInputSchema", () => {
  it("fills defaults for costs, risk settings and the ranking metric", () => {
    const { costBps, metric, stopLossPct, takeProfitPct, ...rest } = baseInput;
    return expect(BacktestSweepInputSchema.parse(rest)).toMatchObject({
      costBps: 0,
      metric: "totalReturn",
      stopLossPct: 0,
      takeProfitPct: 0,
    });
  });

  it("rejects parameters that the rule does not use and repeated parameters", () => {
    expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 5, param: "entryLookback", step: 5, to: 15 }],
      })
    ).toEqual(["entryLookback does not apply to the smaCross rule"]);
    return expect(
      messages({
        ...baseInput,
        dimensions: [
          { from: 5, param: "fast", step: 5, to: 15 },
          { from: 2, param: "fast", step: 1, to: 3 },
        ],
      })
    ).toEqual(["fast appears more than once"]);
  });

  it("rejects reversed ranges, fractional windows and values out of range", () => {
    expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 15, param: "fast", step: 5, to: 5 }],
      })
    ).toEqual(["from must not be more than to"]);
    expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 5, param: "fast", step: 2.5, to: 15 }],
      })
    ).toEqual(["fast needs whole numbers"]);
    expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 0, param: "slow", step: 10, to: 30 }],
      })
    ).toEqual(["slow must be from 1 to 5000"]);
    return expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 90, param: "stopLossPct", step: 5, to: 100 }],
      })
    ).toEqual(["stopLossPct must be from 0 to 99"]);
  });

  it("limits values per dimension and cells per sweep", () => {
    expect(
      messages({
        ...baseInput,
        dimensions: [{ from: 1, param: "fast", step: 1, to: 51 }],
      })
    ).toEqual(["A dimension may have at most 50 values; this one has 51"]);
    expect(
      messages({
        ...baseInput,
        dimensions: [
          { from: 1, param: "fast", step: 1, to: 40 },
          { from: 50, param: "slow", step: 1, to: 89 },
        ],
      })
    ).toEqual([
      `A sweep may have at most ${BACKTEST_SWEEP_MAX_CELLS} cells; this one has 1600`,
    ]);
    expect(parse({ ...baseInput, dimensions: [] }).success).toBe(false);
    return expect(
      parse({
        ...baseInput,
        dimensions: [
          { from: 5, param: "fast", step: 1, to: 5 },
          { from: 50, param: "slow", step: 1, to: 50 },
          { from: 0, param: "stopLossPct", step: 1, to: 0 },
          { from: 0, param: "takeProfitPct", step: 1, to: 0 },
          { from: 0, param: "takeProfitPct", step: 1, to: 0 },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects a date range that ends before it starts", () =>
    expect(
      messages({ ...baseInput, from: "1972-01-01", to: "1971-01-01" })
    ).toEqual(["from must not be after to"]));
});
