import { describe, expect, it } from "vitest";

import {
  applySweepParams,
  assessSweepRobustness,
  sweepCoordinates,
  sweepDimensionValues,
  sweepIndex,
  sweepNeighbours,
  sweepParamApplies,
  sweepParamLimits,
  sweepValueCount,
} from "./backtest-sweep-grid.ts";

// A 5 x 5 synthetic grid with one known isolated spike and one known plateau.
//          col 0 col 1 col 2 col 3 col 4
// row 0:    0.2   0.2   0.2   0.2   0.2
// row 1:    0.2   3.0   0.2   0.2   0.2    <- spike at (1, 1), index 6
// row 2:    0.2   0.2   1.0   1.0   1.0
// row 3:    0.2   0.2   1.0   1.0   1.0    <- plateau of 1.0 at rows 2-4, columns 2-4
// row 4:    0.2   0.2   1.0   1.0   1.0
const SHAPE = [5, 5] as const;
const SPIKE = 6;
const PLATEAU_CENTRE = 18;
const syntheticGrid = (): number[] =>
  Array.from({ length: 25 }, (_, index) => {
    if (index === SPIKE) return 3;
    const [row, column] = sweepCoordinates(index, SHAPE) as [number, number];
    return row >= 2 && column >= 2 ? 1 : 0.2;
  });

describe("parameter sweep robustness", () => {
  it("ranks the plateau above the higher isolated spike and flags only the spike", () => {
    const result = assessSweepRobustness(SHAPE, syntheticGrid());
    // The single best raw value is the spike, but its neighbourhood is poor.
    expect(result.worst[SPIKE]).toBe(0.2);
    expect(result.neighbourMean[SPIKE]).toBeCloseTo(0.2, 12);
    expect(result.spike[SPIKE]).toBe(true);
    expect(result.spike.filter(Boolean)).toHaveLength(1);
    // Plateau cells whose whole neighbourhood is 1.0 rank first, ties by cell index.
    expect(result.ranking.slice(0, 4)).toEqual([PLATEAU_CENTRE, 19, 23, 24]);
    expect(result.rank[PLATEAU_CENTRE]).toBe(1);
    expect(result.worst[PLATEAU_CENTRE]).toBe(1);
    expect(result.neighbours[PLATEAU_CENTRE]).toBe(4);
    // Next come cells whose worst neighbour is 0.2, the higher own value first: the spike.
    expect(result.ranking[4]).toBe(SPIKE);
    expect(result.rank[SPIKE]).toBe(5);
    // The plateau edge next to the 0.2 cells keeps a neighbour mean above half its value.
    expect(result.neighbourMean[12]).toBeCloseTo(0.6, 12);
    expect(result.spike[12]).toBe(false);
    expect(result.ranking).toHaveLength(25);
  });

  it("returns the same result for the same grid", () =>
    expect(assessSweepRobustness(SHAPE, syntheticGrid())).toEqual(
      assessSweepRobustness(SHAPE, syntheticGrid())
    ));

  it("leaves cells without a value unranked and out of their neighbours' scores", () => {
    const result = assessSweepRobustness([3], [1, null, 0.5]);
    expect(result.worst).toEqual([1, null, 0.5]);
    expect(result.neighbours).toEqual([0, 2, 0]);
    expect(result.neighbourMean).toEqual([null, 0.75, null]);
    expect(result.rank).toEqual([1, null, 2]);
    expect(result.ranking).toEqual([0, 2]);
    // No neighbour with a value means no evidence of a spike.
    expect(result.spike).toEqual([false, false, false]);
  });

  it("ranks a cell without valued neighbours after every supported cell", () => {
    // Cell 0 has the highest value, but its only neighbour was rejected by the engine.
    const result = assessSweepRobustness([4], [3, null, 1, 0.5]);
    expect(result.worst).toEqual([3, null, 0.5, 0.5]);
    expect(result.ranking).toEqual([2, 3, 0]);
    return expect(result.rank).toEqual([3, null, 1, 2]);
  });

  it("treats non-finite values as missing", () => {
    const result = assessSweepRobustness(
      [3],
      [Number.NaN, Number.POSITIVE_INFINITY, 2]
    );
    expect(result.worst).toEqual([null, null, 2]);
    return expect(result.ranking).toEqual([2]);
  });

  it("flags spikes only for positive cell values", () => {
    expect(assessSweepRobustness([3], [-1, -0.1, -1]).spike).toEqual([
      false,
      false,
      false,
    ]);
    const positive = assessSweepRobustness([3], [-1, 0.5, -1]);
    expect(positive.spike).toEqual([false, true, false]);
    return expect(positive.worst).toEqual([-1, -1, -1]);
  });

  it("does not flag a cell whose neighbours average exactly half of it", () => {
    expect(assessSweepRobustness([2], [2, 1]).spike).toEqual([false, false]);
    return expect(assessSweepRobustness([2], [2, 0.99]).spike).toEqual([
      true,
      false,
    ]);
  });

  it("scores a one-cell grid by its own value", () => {
    const result = assessSweepRobustness([1], [0.3]);
    expect(result.worst).toEqual([0.3]);
    expect(result.neighbours).toEqual([0]);
    return expect(result.rank).toEqual([1]);
  });

  it("rejects a value list that does not match the grid", () =>
    expect(() => assessSweepRobustness([2, 2], [1, 2, 3])).toThrow(RangeError));
});

describe("parameter sweep grid", () => {
  it("lists the cells one step away in exactly one dimension", () => {
    expect(sweepNeighbours(13, [3, 3, 3])).toEqual([4, 10, 12, 14, 16, 22]);
    expect(sweepNeighbours(0, [3, 3, 3])).toEqual([1, 3, 9]);
    expect(sweepNeighbours(0, [1])).toEqual([]);
    return expect(sweepNeighbours(4, [2, 3])).toEqual([1, 3, 5]);
  });

  it("maps cell indexes to row-major coordinates and back", () => {
    expect(sweepCoordinates(5, [2, 3])).toEqual([1, 2]);
    expect(sweepCoordinates(0, [2, 3])).toEqual([0, 0]);
    for (let index = 0; index < 24; index += 1)
      expect(sweepIndex(sweepCoordinates(index, [2, 3, 4]), [2, 3, 4])).toBe(
        index
      );
  });

  it("expands a from/to/step range without floating-point drift", () => {
    expect(sweepDimensionValues({ from: 0, step: 0.25, to: 1 })).toEqual([
      0, 0.25, 0.5, 0.75, 1,
    ]);
    expect(sweepDimensionValues({ from: 0.1, step: 0.1, to: 0.3 })).toEqual([
      0.1, 0.2, 0.3,
    ]);
    expect(sweepDimensionValues({ from: 1, step: 4, to: 10 })).toEqual([
      1, 5, 9,
    ]);
    expect(sweepDimensionValues({ from: 7, step: 1, to: 7 })).toEqual([7]);
    expect(sweepValueCount({ from: 5, step: 5, to: 30 })).toBe(6);
    return expect(sweepValueCount({ from: 0, step: 0.001, to: 10_000 })).toBe(
      10_000_001
    );
  });

  it("knows which parameters belong to which rule and their limits", () => {
    expect(sweepParamApplies("fast", "smaCross")).toBe(true);
    expect(sweepParamApplies("fast", "breakout")).toBe(false);
    expect(sweepParamApplies("trendSma", "breakout")).toBe(true);
    expect(sweepParamApplies("stopLossPct", "breakout")).toBe(true);
    expect(sweepParamApplies("takeProfitPct", "smaCross")).toBe(true);
    expect(sweepParamLimits("trendSma")).toEqual({
      integer: true,
      max: 5000,
      min: 0,
    });
    expect(sweepParamLimits("slow")).toEqual({
      integer: true,
      max: 5000,
      min: 1,
    });
    return expect(sweepParamLimits("stopLossPct")).toEqual({
      integer: false,
      max: 99,
      min: 0,
    });
  });

  it("puts each cell's values into the rule and the risk settings", () => {
    expect(
      applySweepParams(
        {
          rule: { fast: 50, kind: "smaCross", slow: 200 },
          stopLossPct: 0,
          takeProfitPct: 5,
        },
        [
          { param: "fast", value: 10 },
          { param: "stopLossPct", value: 2.5 },
        ]
      )
    ).toEqual({
      rule: { fast: 10, kind: "smaCross", slow: 200 },
      stopLossPct: 2.5,
      takeProfitPct: 5,
    });
    return expect(
      applySweepParams(
        {
          rule: {
            entryLookback: 20,
            exitLookback: 10,
            kind: "breakout",
            trendSma: 0,
          },
          stopLossPct: 1,
          takeProfitPct: 0,
        },
        [
          { param: "trendSma", value: 100 },
          { param: "takeProfitPct", value: 8 },
        ]
      )
    ).toEqual({
      rule: {
        entryLookback: 20,
        exitLookback: 10,
        kind: "breakout",
        trendSma: 100,
      },
      stopLossPct: 1,
      takeProfitPct: 8,
    });
  });
});
