import { describe, expect, it } from "vitest";

import { createRandom } from "../../packages/api/src/backtest-analytics.ts";
import {
  DEFAULT_SCORECARD_PARAMS,
  type SymbolBars,
  scoreForecasts,
} from "../../packages/api/src/forecast-scorecard.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";
import {
  baselineCopyControl,
  type Control,
  controlGrid,
  perfectControl,
  plantedControl,
} from "./forecast-scorecard-controls.ts";

const DAY_MS = 86_400_000;
const HORIZON = DEFAULT_SCORECARD_PARAMS.horizonBars;
const PRIOR_MIN = DEFAULT_SCORECARD_PARAMS.priorMinWindows;
const PARAMS = { ...DEFAULT_SCORECARD_PARAMS, resamples: 300 };

// A seeded random walk on consecutive Monday-to-Friday dates, without equal prices.
const walk = (count: number, seed: number): SymbolBars => {
  const random = createRandom(seed);
  const dates: string[] = [];
  const prices: number[] = [];
  let price = 100;
  for (let day = 0; dates.length < count; day += 1) {
    const date = new Date(Date.UTC(2015, 0, 5) + day * DAY_MS);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    price *= 1 + (random() - 0.48) * 0.04;
    dates.push(date.toISOString().slice(0, 10));
    prices.push(price);
  }
  return { dates, prices };
};

// About 44 grid points per symbol, in more than 40 two-week clusters.
const barsBySymbol = new Map([
  ["BBB", walk(710, 2)],
  ["CCC", walk(705, 3)],
  ["AAA", walk(700, 1)],
]);
const grid = controlGrid(barsBySymbol, HORIZON, PRIOR_MIN);
const score = (control: Control, bars = barsBySymbol) =>
  scoreForecasts(control.records, bars, PARAMS, createRandom(5));

describe("controlGrid", () => {
  it("starts at the first bar with enough earlier windows and steps by the horizon", () => {
    const bars = at([...barsBySymbol.values()], 2);
    const points = grid.filter((point) => point.symbol === "AAA");
    // 250 windows have ended at bar 259 (windows end at bars 10..259).
    expect(at(points, 0).date).toBe(at(bars.dates, PRIOR_MIN + HORIZON - 1));
    const indices = points.map((point) => bars.dates.indexOf(point.date));
    expect(
      indices.every((index, position) => index === 259 + position * 10)
    ).toBe(true);
    // The last point has ten later bars; one more step has not.
    expect(at(indices, indices.length - 1) + HORIZON).toBeLessThan(700);
    expect(
      at(indices, indices.length - 1) + 2 * HORIZON
    ).toBeGreaterThanOrEqual(700);
    expect(grid.map((point) => point.symbol)).toEqual(
      [...grid.map((point) => point.symbol)].sort()
    );
  });

  it("computes the prior and the direction from the prices", () => {
    const bars = at([...barsBySymbol.values()], 2);
    const point = at(
      grid.filter((entry) => entry.symbol === "AAA"),
      3
    );
    const bar = bars.dates.indexOf(point.date);
    let ups = 0;
    for (let start = 0; start + HORIZON <= bar; start += 1)
      ups += Number(at(bars.prices, start + HORIZON) > at(bars.prices, start));
    expect(point.prior).toBe((ups + 1) / (bar - HORIZON + 1 + 2));
    expect(point.up).toBe(
      at(bars.prices, bar + HORIZON) > at(bars.prices, bar)
    );
  });

  it("leaves out a grid bar with a flat outcome and keeps the grid step", () => {
    const base = walk(320, 4);
    const prices = [...base.prices];
    prices[279] = at(prices, 269);
    const flat = controlGrid(
      new Map([["AAA", { dates: base.dates, prices }]]),
      HORIZON,
      PRIOR_MIN
    );
    // The window from bar 269 to bar 279 is flat, so the grid bar 269 is left out.
    const indices = flat.map((point) => base.dates.indexOf(point.date));
    expect(indices).toEqual([259, 279, 289, 299, 309]);
  });

  it("is empty for short bars", () => {
    expect(
      controlGrid(new Map([["AAA", walk(200, 1)]]), HORIZON, PRIOR_MIN)
    ).toEqual([]);
  });
});

describe("controls against the scorer", () => {
  const controls = [
    baselineCopyControl(grid),
    perfectControl(grid),
    plantedControl(grid, 0.05, createRandom(11)),
    plantedControl(grid, 0.1, createRandom(12)),
    plantedControl(grid, 0.2, createRandom(13)),
  ];

  it("names the controls and their records", () => {
    expect(controls.map((control) => control.id)).toEqual([
      "baseline-copy",
      "perfect",
      "planted-0.05",
      "planted-0.10",
      "planted-0.20",
    ]);
    expect(at(at(controls, 0).records, 0)).toEqual({
      dataAsOf: at(grid, 0).date,
      decidedAt: null,
      model: null,
      probabilities: {
        BEARISH: 1 - at(grid, 0).prior,
        BULLISH: at(grid, 0).prior,
        NEUTRAL: 0,
      },
      schemaVersion: 1,
      source: "control:baseline-copy",
      sourceVersion: null,
      symbol: "AAA",
    });
    expect(at(at(controls, 4).records, 0).source).toBe("control:planted");
    expect(at(at(controls, 4).records, 0).sourceVersion).toBe("0.20");
    expect(at(at(controls, 1).records, 0).source).toBe("control:perfect");
  });

  it.each(controls)("agrees with the scorer to 1e-9: $id", (control) => {
    const result = score(control);
    expect(control.check.records).toBe(grid.length);
    expect(result.ledger.byStatus.SCORED).toBe(control.check.records);
    expect(result.score.clusters).toBeGreaterThanOrEqual(40);
    expect(
      Math.abs(
        (result.score.skill?.half ?? Number.NaN) - control.check.skillHalf
      )
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(
        (result.score.skill?.prior ?? Number.NaN) - control.check.skillPrior
      )
    ).toBeLessThan(1e-9);
  });

  it("gives the known answers", () => {
    expect(Math.abs(at(controls, 0).check.skillPrior)).toBeLessThan(1e-9);
    expect(
      Math.abs(score(at(controls, 0)).score.skill?.prior ?? 1)
    ).toBeLessThan(1e-9);
    expect(at(controls, 1).check.skillPrior).toBe(1);
    expect(score(at(controls, 1)).score.skill?.best).toBe(1);
    expect(score(at(controls, 1)).score.skillStatus).toBe("SKILL");
    expect(score(at(controls, 4)).score.skillStatus).toBe("SKILL");
    expect(at(controls, 4).check.skillPrior).toBeGreaterThan(
      at(controls, 2).check.skillPrior
    );
  });

  it("limits the planted forecast to 0.01..0.99 and repeats for the same seed", () => {
    // The first draw points to the truth (up), the second away from it (down).
    const draws = [0.1, 0.9];
    let calls = 0;
    const extreme = plantedControl(
      [
        { date: "2020-01-06", prior: 0.995, symbol: "AAA", up: true },
        { date: "2020-01-20", prior: 0.005, symbol: "AAA", up: true },
      ],
      0.2,
      () => {
        calls += 1;
        return at(draws, calls - 1);
      }
    );
    expect(extreme.records.map((entry) => entry.probabilities.BULLISH)).toEqual(
      [0.99, 0.01]
    );
    const again = plantedControl(grid, 0.2, createRandom(13));
    expect(again).toEqual(at(controls, 4));
    expect(plantedControl(grid, 0.2, createRandom(14))).not.toEqual(again);
  });

  it("gives empty controls for an empty grid", () => {
    expect(baselineCopyControl([])).toEqual({
      check: { records: 0, skillHalf: 0, skillPrior: 0 },
      id: "baseline-copy",
      records: [],
    });
  });

  it("fails the agreement when prices are one row off against the dates", () => {
    const shifted = new Map(
      [...barsBySymbol.entries()].map(([symbol, bars]) => [
        symbol,
        { dates: bars.dates.slice(0, -1), prices: bars.prices.slice(1) },
      ])
    );
    const control = at(controls, 4);
    const result = score(control, shifted);
    const agrees =
      result.ledger.byStatus.SCORED === control.check.records &&
      Math.abs(
        (result.score.skill?.half ?? Number.NaN) - control.check.skillHalf
      ) < 1e-9 &&
      Math.abs(
        (result.score.skill?.prior ?? Number.NaN) - control.check.skillPrior
      ) < 1e-9;
    expect(agrees).toBe(false);
  });
});
