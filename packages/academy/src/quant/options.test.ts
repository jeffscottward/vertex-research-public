import { describe, expect, it } from "vitest";

import { FORMULAS } from "../formulas.ts";
import type { ParamValues } from "../position.ts";
import type { Panel, SceneData } from "../scene-kit.ts";
import { QUANT_MODE_ELEMENTS } from "../schema.ts";
import { quantModel, quantScene, quantTables } from "./index.ts";
import {
  binomialModel,
  callPrice,
  crr,
  DRAWN_LEVELS,
  expectedHedgePnl,
  HEDGE_BUDGET,
  hedgeInputs,
  hedgeModel,
  histogram,
  impliedVol,
  mertonCall,
  optionsScene,
  optionsTables,
  SHOWN_GUESSES,
  smileInputs,
  smileModel,
} from "./options.ts";
import { OPTIONS_FORMULAS } from "./options-formulas.ts";
import {
  OPTIONS_COLORS,
  OPTIONS_ELEMENTS,
  OPTIONS_FORMULA_IDS,
  OPTIONS_MODELS,
  type OptionsMode,
} from "./options-ids.ts";

const MODES = Object.keys(OPTIONS_ELEMENTS) as OptionsMode[];

/** Test-run inputs of the transcripts (Parts 31, 33, 35, 37, 38): S = K = 100, r = 5%, one year. */
const RUN: ParamValues = { dte: 365, rate: 5, spot: 100, strike: 100 };

const panel = (scene: SceneData, id: string): Panel => {
  const found = scene.panels.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`panel ${id} missing`);
  return found;
};

describe("options contract", () => {
  it("registers every mode, formula and color with the schema and the formula library", () => {
    for (const mode of MODES)
      expect(QUANT_MODE_ELEMENTS[mode]).toEqual(OPTIONS_ELEMENTS[mode]);
    for (const id of OPTIONS_FORMULA_IDS) {
      const formula = OPTIONS_FORMULAS[id];
      expect(FORMULAS[id]).toBe(formula);
      expect(formula.id).toBe(id);
      expect(formula.mathml.startsWith('<math display="block">')).toBe(true);
      for (const text of [formula.mathml, formula.text, formula.title])
        expect(text).not.toMatch(/TODO/u);
    }
    const drawn = new Set<string>(
      MODES.flatMap((mode) => OPTIONS_ELEMENTS[mode])
    );
    for (const id of Object.keys(OPTIONS_COLORS))
      expect(drawn.has(id)).toBe(true);
    for (const mode of MODES) {
      expect(OPTIONS_MODELS[mode]).not.toMatch(/TODO/u);
      expect(quantModel(mode)).toBe(OPTIONS_MODELS[mode]);
    }
  });

  it.each(MODES)(
    "%s draws exactly its contract elements with finite data",
    (mode) => {
      for (const t of [0, 0.5, 1]) {
        const scene = quantScene(mode, { azimuth: 0, t, values: {} });
        expect(scene).toEqual(
          optionsScene(mode, { azimuth: 0, t, values: {} })
        );
        const contract = new Set<string>(OPTIONS_ELEMENTS[mode]);
        const drawn = new Set<string>(["axes"]);
        for (const view of scene.panels) {
          for (const element of view.elements)
            expect(contract.has(element)).toBe(true);
          const items = [...view.series, ...view.markers];
          for (const item of items) {
            expect(view.elements).toContain(item.element);
            drawn.add(item.element);
          }
          for (const series of view.series)
            for (const point of series.points)
              expect(point.every(Number.isFinite)).toBe(true);
          for (const marker of view.markers)
            for (const value of [marker.x, marker.y])
              expect(value === undefined || Number.isFinite(value)).toBe(true);
          for (const domain of [view.xDomain, view.yDomain]) {
            expect(domain.every(Number.isFinite)).toBe(true);
            expect(domain[1]).toBeGreaterThan(domain[0]);
          }
        }
        expect([...drawn].sort()).toEqual([...contract].sort());
        expect(scene.now).toBeLessThanOrEqual(scene.horizon);
        const tables = quantTables(mode, {}, t);
        expect(tables).toEqual(optionsTables(mode, {}, t));
        expect(tables.length).toBeGreaterThan(0);
        for (const table of tables) {
          expect(table.rows.length).toBeGreaterThan(0);
          for (const row of table.rows) {
            expect(row).toHaveLength(table.columns.length);
            expect(row.join(" ")).not.toMatch(/NaN|Infinity|undefined/u);
          }
        }
      }
    }
  );
});

describe("smile", () => {
  it("bisects to the 24.1% implied volatility of a $12 call (Part 31)", () => {
    const result = impliedVol(12, 100, 100, 1, 0.05);
    expect(result.iv).toBeCloseTo(0.2411, 4);
    expect(result.guesses.map((guess) => guess.vol).slice(0, 3)).toEqual([
      0.5, 0.25, 0.125,
    ]);
    expect(result.guesses).toHaveLength(SHOWN_GUESSES);
    expect(Math.abs((result.guesses.at(-1)?.price ?? 0) - 12)).toBeLessThan(
      0.005
    );
  });

  it("widens the search above 100% and stops at 800% for an impossible price", () => {
    const widened = impliedVol(60, 100, 100, 1, 0.05);
    expect(widened.guesses[0]?.high).toBe(2);
    expect(widened.iv).toBeGreaterThan(1);
    expect(callPrice(100, 100, 1, 0.05, widened.iv)).toBeCloseTo(60, 6);
    const impossible = impliedVol(150, 100, 100, 1, 0.05);
    expect(impossible.guesses[0]?.high).toBe(8);
    expect(impossible.iv).toBeCloseTo(8, 6);
  });

  it("prices a crash-prone market into a skew; without jumps it is flat (Part 38)", () => {
    const crashes = smileInputs({
      ...RUN,
      jumpIntensity: 0.1,
      jumpMean: -25,
      jumpVol: 5,
      marketVol: 15,
    });
    const ivAt = (strike: number): number =>
      impliedVol(mertonCall(crashes, strike), 100, strike, 1, 0.05).iv;
    expect(ivAt(60)).toBeGreaterThan(0.21);
    expect(ivAt(100)).toBeCloseTo(0.172, 3);
    expect(ivAt(140)).toBeCloseTo(0.159, 3);
    const calm = smileModel({ ...RUN, jumpIntensity: 0, marketVol: 15 });
    for (const iv of calm.smile) expect(iv).toBeCloseTo(0.15, 6);
    expect(calm.anchor).toBeCloseTo(0, 9);
    expect(mertonCall({ ...crashes, lambda: 0 }, 100)).toBeCloseTo(
      callPrice(100, 100, 1, 0.05, 0.15),
      9
    );
  });

  it("anchors the smile at a quoted price and reveals guesses with t", () => {
    const quoted = smileModel({ ...RUN, marketPrice: 12 });
    expect(quoted.market).toBe(12);
    expect(quoted.solved.iv).toBeCloseTo(0.2411, 4);
    expect(quoted.smile[16]).toBeCloseTo(quoted.solved.iv, 9);
    expect(quoted.anchor).not.toBe(0);
    const [steps, strikes] = optionsTables(
      "smile",
      { ...RUN, marketPrice: 12 },
      1
    );
    expect(strikes?.note).toMatch(/shifted by/u);
    expect(steps?.rows[0]).toEqual([
      "1",
      "0.0% - 100.0%",
      "50.00%",
      expect.stringMatching(/^\$/u),
      "too high: go down",
    ]);
    expect(steps?.rows[2]?.[4]).toBe("too low: go up");
    const own = smileModel({ ...RUN, marketPrice: 0 });
    expect(own.market).toBeCloseTo(mertonCall(own.input, 100), 9);
    const guessesAt = (t: number): number =>
      panel(
        optionsScene("smile", { azimuth: 0, t, values: RUN }),
        "bisection"
      ).markers.filter((marker) => marker.element === "guesses").length;
    expect(guessesAt(0)).toBe(1);
    expect(guessesAt(0.5)).toBe(5);
    expect(guessesAt(1)).toBe(SHOWN_GUESSES);
  });
});

describe("binomial", () => {
  it("reproduces the Part 37 tree prices and converges to Black-Scholes", () => {
    const prices = [1, 2, 3, 10].map((steps) =>
      crr(100, 100, 1, 0.05, 0.2, steps).price.toFixed(2)
    );
    expect(prices).toEqual(["12.16", "9.54", "11.04", "10.25"]);
    const one = crr(100, 100, 1, 0.05, 0.2, 1);
    expect(one.up).toBeCloseTo(1.2214, 4);
    expect(one.prob).toBeCloseTo(0.5775, 4);
    expect(one.levels[0]).toEqual([one.price]);
    expect(one.levels[1]?.[0]).toBe(0);
    expect(one.levels[1]?.[1]).toBeCloseTo(22.14, 2);
    const model = binomialModel({ ...RUN, iv: 20, steps: 250 });
    expect(model.bs).toBeCloseTo(10.45, 2);
    expect(Math.abs(model.tree.price - model.bs)).toBeLessThan(0.01);
    expect(model.convergence).toHaveLength(250);
  });

  it("draws at most the first levels of a long tree and clamps the risk-neutral weight", () => {
    const scene = optionsScene("binomial", {
      azimuth: 0,
      t: 1,
      values: { ...RUN, iv: 20, steps: 40 },
    });
    const tree = panel(scene, "tree");
    expect(tree.title).toMatch(/^First 8 of 40 steps/u);
    expect(tree.markers).toHaveLength(
      ((DRAWN_LEVELS + 1) * (DRAWN_LEVELS + 2)) / 2
    );
    expect(tree.series).toHaveLength(DRAWN_LEVELS * (DRAWN_LEVELS + 1));
    const short = panel(
      optionsScene("binomial", {
        azimuth: 0,
        t: 1,
        values: { ...RUN, steps: 2 },
      }),
      "tree"
    );
    expect(short.title).toMatch(/^2-step tree/u);
    expect(crr(100, 100, 1, 0.1, 0.01, 1).prob).toBe(1);
    const [, convergence] = optionsTables(
      "binomial",
      { ...RUN, iv: 20, steps: 7 },
      0
    );
    expect(convergence?.rows.map((row) => row[0])).toEqual([
      "1",
      "2",
      "3",
      "5",
      "7",
      "10",
      "25",
      "50",
    ]);
  });
});

describe("hedge", () => {
  it("shrinks the P&L spread from about $15 to about $0.4 with daily hedging (Part 33)", () => {
    const model = hedgeModel({
      ...RUN,
      iv: 20,
      paths: 2000,
      realizedVol: 20,
      rebalances: 252,
    });
    const spread = (values: readonly number[]): number => {
      const center =
        values.reduce((sum, value) => sum + value, 0) / values.length;
      return Math.sqrt(
        values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
          (values.length - 1)
      );
    };
    expect(spread(model.unhedged)).toBeGreaterThan(10);
    expect(spread(model.hedged)).toBeGreaterThan(0.3);
    expect(spread(model.hedged)).toBeLessThan(0.55);
    const daily = model.std.find((point) => point[0] === 252)?.[1] ?? 0;
    const yearly = model.std[0]?.[1] ?? 0;
    expect(yearly).toBeGreaterThan(5 * daily);
    expect(model.mainPaths).toBe(Math.floor(HEDGE_BUDGET.main / 253));
  });

  it("earns when realized vol stays below implied and loses above it (Part 35)", () => {
    const calm = hedgeModel({
      ...RUN,
      iv: 20,
      realizedVol: 16,
      rebalances: 252,
      spread: 0.1,
    });
    expect(calm.hedged.every((value) => value > 0)).toBe(true);
    expect(calm.ratioNow).toBeCloseTo(1.7, 1);
    const wild = hedgeModel({
      ...RUN,
      iv: 20,
      realizedVol: 24,
      rebalances: 252,
      spread: 0.1,
    });
    expect(wild.hedged.filter((value) => value > 0).length).toBeLessThan(5);
    expect(wild.ratioNow).toBeLessThan(-1.2);
    const even = hedgeInputs({ ...RUN, iv: 20, realizedVol: 20 });
    expect(expectedHedgePnl(even, 0.2)).toBeCloseTo(0, 12);
    const ys = calm.ratio.map((point) => point[1]);
    for (let index = 1; index < ys.length; index += 1)
      expect(ys[index]).toBeLessThan(ys[index - 1] ?? 0);
    const [summary] = optionsTables("hedge", { ...RUN, spread: 0.1 }, 0);
    expect(summary?.note).toMatch(/plus \$0\.10 spread/u);
    const [plain, , ratio] = optionsTables("hedge", RUN, 0);
    expect(plain?.note).not.toMatch(/spread/u);
    expect(ratio?.note).not.toMatch(/spread/u);
  });

  it("keeps Black-Scholes evaluations within about 60k and stretches the ratio axis to the marker", () => {
    for (const values of [
      { paths: 5000, rebalances: 252 },
      { paths: 5000, rebalances: 100 },
      { paths: 5000, rebalances: 1 },
      { paths: 20, rebalances: 13 },
    ]) {
      const model = hedgeModel({ ...RUN, ...values });
      expect(model.evaluations).toBeLessThanOrEqual(61_000);
      expect(model.std.map((point) => point[0])).toContain(values.rebalances);
    }
    const scene = optionsScene("hedge", {
      azimuth: 0,
      t: 0,
      values: { ...RUN, iv: 10, realizedVol: 40 },
    });
    const ratio = panel(scene, "ratio");
    expect(ratio.xDomain).toEqual([50, 400]);
  });

  it("bins a histogram as step outlines of path shares", () => {
    const outline = histogram([0, 0, 1], 0, 1);
    expect(outline).toHaveLength(80);
    expect(outline[0]).toEqual([0, (2 / 3) * 100]);
    expect(outline.at(-1)).toEqual([1, (1 / 3) * 100]);
    expect(histogram([5, 5], 5, 5)[0]?.[1]).toBe(100);
  });
});
