import { describe, expect, it } from "vitest";

import { FORMULAS } from "../formulas.ts";
import { spec as bisectionSpec } from "../lessons/specs/quantfinancetogo/implied-volatility-by-bisection.ts";
import { spec as marketMakerSpec } from "../lessons/specs/quantfinancetogo/market-maker-theta-vs-gamma.ts";
import { spec as smileSpec } from "../lessons/specs/quantfinancetogo/volatility-smile-and-skew.ts";
import type { ParamValues } from "../position.ts";
import type { Panel, SceneData } from "../scene-kit.ts";
import { QUANT_MODE_ELEMENTS } from "../schema.ts";
import { quantModel, quantScene, quantTables } from "./index.ts";
import {
  binomialModel,
  callBounds,
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
  minArbitrageFreeSteps,
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

  it("widens the search above 100% and stops at 800% for a price just under the stock", () => {
    const widened = impliedVol(60, 100, 100, 1, 0.05);
    expect(widened.guesses[0]?.high).toBe(2);
    expect(widened.iv).toBeGreaterThan(1);
    expect(callPrice(100, 100, 1, 0.05, widened.iv)).toBeCloseTo(60, 6);
    const steep = impliedVol(99.999, 100, 100, 1, 0.05);
    expect(steep.outside).toBeNull();
    expect(steep.guesses[0]?.high).toBe(8);
    expect(steep.iv).toBeCloseTo(8, 6);
  });

  it("prices a crash-prone market into a skew; without jumps it is flat (Part 38)", () => {
    const crashes = smileInputs({
      ...RUN,
      jumpIntensity: 0.1,
      jumpMedian: -25,
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

describe("no-arbitrage bounds of a quoted call", () => {
  it("has no implied volatility below max(S - Ke^(-rT), 0) or at/above S", () => {
    const bounds = callBounds(100, 100, 1, 0.05);
    expect(bounds.lower).toBeCloseTo(100 - 100 * Math.exp(-0.05), 12);
    expect(bounds.upper).toBe(100);
    expect(callBounds(100, 500, 1, 0.05).lower).toBe(0);
    const above = impliedVol(150, 100, 100, 1, 0.05);
    expect(above.outside).toBe("above");
    expect(above.iv).toBeNaN();
    expect(above.guesses).toHaveLength(0);
    expect(impliedVol(100, 100, 100, 1, 0.05).outside).toBe("above");
    // Deep in the money: the call must be worth at least 100 - 10e^(-0.05) = 90.49.
    const below = impliedVol(60, 100, 10, 1, 0.05);
    expect(below.outside).toBe("below");
    expect(below.iv).toBeNaN();
    expect(impliedVol(4.8, 100, 100, 1, 0.05).outside).toBe("below");
    expect(impliedVol(4.9, 100, 100, 1, 0.05).outside).toBeNull();
  });

  it("flags an out-of-bounds quote in the chart and tables instead of solving it", () => {
    const values = { ...RUN, marketPrice: 60, strike: 10 };
    const model = smileModel(values);
    expect(model.solved.outside).toBe("below");
    expect(model.anchor).toBe(0);
    for (const iv of model.smile) expect(iv).toBeGreaterThanOrEqual(0);
    const scene = optionsScene("smile", { azimuth: 0, t: 1, values });
    const bisection = panel(scene, "bisection");
    expect(bisection.title).toMatch(/outside no-arbitrage bounds/u);
    expect(
      bisection.markers.filter((marker) => marker.element === "guesses")
    ).toHaveLength(0);
    for (const view of scene.panels) {
      for (const series of view.series)
        for (const point of series.points)
          expect(point.every(Number.isFinite)).toBe(true);
      for (const marker of view.markers)
        expect(marker.y === undefined || Number.isFinite(marker.y)).toBe(true);
      expect([...view.xDomain, ...view.yDomain].every(Number.isFinite)).toBe(
        true
      );
    }
    expect(
      panel(scene, "smile").series.find((series) => series.element === "flat")
        ?.points
    ).toHaveLength(0);
    const [steps, strikes] = optionsTables("smile", values, 1);
    expect(steps?.note).toMatch(/outside no-arbitrage bounds.*undefined/u);
    expect(steps?.rows).toHaveLength(0);
    expect(strikes?.note).toMatch(/not shifted/u);
    for (const row of strikes?.rows ?? [])
      expect(row.join(" ")).not.toMatch(/NaN|Infinity/u);
    const rich = optionsTables("smile", { ...RUN, marketPrice: 120 }, 1)[0];
    expect(rich?.note).toMatch(/at or above the stock/u);
  });

  it("floors the anchored smile at 0% when a low quote shifts it below zero", () => {
    // A $5 quote is barely above the $4.88 lower bound: its implied volatility is tiny, and the
    // jump-model skew shifted down to it would go negative in the wing.
    const model = smileModel({ ...RUN, jumpMedian: -50, marketPrice: 4.9 });
    expect(model.solved.outside).toBeNull();
    expect(model.anchor).toBeLessThan(0);
    expect(model.smile.some((iv) => iv === 0)).toBe(true);
    for (const iv of model.smile) expect(iv).toBeGreaterThanOrEqual(0);
    const [, strikes] = optionsTables(
      "smile",
      { ...RUN, jumpMedian: -50, marketPrice: 4.9 },
      1
    );
    expect(strikes?.note).toMatch(/floored at 0%/u);
    for (const row of strikes?.rows ?? []) expect(row[2]).not.toMatch(/^-/u);
  });

  it("labels the jump parameter as the median jump in both smile lessons", () => {
    for (const lesson of [smileSpec, bisectionSpec]) {
      const param = lesson.params?.find((item) => item.id === "jumpMedian");
      expect(param?.label).toBe("Median jump");
      expect(
        lesson.params?.some((item) => /average jump/iu.test(item.label))
      ).toBe(false);
    }
    // ln(1 + median) is the log mean: half the jumps are bigger crashes, half smaller.
    const input = smileInputs({ jumpMedian: -25 });
    expect(input.jumpMedian).toBe(-0.25);
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

  it("draws at most the first levels of a long tree", () => {
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

describe("binomial no-arbitrage condition", () => {
  it("does not clamp p: a tree with σ ≤ |r|√Δt is flagged as not arbitrage-free", () => {
    const valid = crr(100, 100, 1, 0.05, 0.2, 1);
    expect(valid.arbitrageFree).toBe(true);
    // σ = 1% against r√Δt = 10%: the up move (1.01) does not beat cash growth (1.105).
    const broken = crr(100, 100, 1, 0.1, 0.01, 1);
    expect(broken.arbitrageFree).toBe(false);
    expect(broken.prob).toBeGreaterThan(1);
    expect(broken.up).toBeLessThan(Math.exp(0.1));
    // σ = 1.2%, r = 10%: r²T/σ² = 69.4, so 70 steps are needed; σ = 20%, r = 5% is fine with one.
    expect(minArbitrageFreeSteps(1, 0.1, 0.012)).toBe(70);
    expect(crr(100, 100, 1, 0.1, 0.012, 69).arbitrageFree).toBe(false);
    const enough = crr(100, 100, 1, 0.1, 0.012, 70);
    expect(enough.arbitrageFree).toBe(true);
    expect(enough.prob).toBeGreaterThan(0);
    expect(enough.prob).toBeLessThan(1);
    expect(minArbitrageFreeSteps(1, 0.05, 0.2)).toBe(1);
  });

  it("warns in the tree title and the tables instead of hiding the invalid tree", () => {
    // σ = 2%, r = 10%: r²T/σ² = 25 sits on the edge, so 26 steps are needed.
    const values = { ...RUN, iv: 2, rate: 10, steps: 3 };
    const model = binomialModel(values);
    expect(model.tree.arbitrageFree).toBe(false);
    expect(model.minSteps).toBe(26);
    const scene = optionsScene("binomial", { azimuth: 0, t: 1, values });
    expect(panel(scene, "tree").title).toMatch(
      /^Invalid 3-step tree: σ 2\.0% ≤ \|r\|√Δt .*not a probability; use at least 26 steps/u
    );
    expect(panel(scene, "convergence").title).toMatch(/under 26 steps/u);
    const [tree, convergence] = optionsTables("binomial", values, 1);
    expect(tree?.note).toMatch(/^Warning: this tree is not arbitrage-free/u);
    expect(convergence?.note).toMatch(/fewer than 26 steps/u);
    const fine = optionsTables("binomial", { ...RUN, iv: 20, steps: 3 }, 1);
    expect(fine[0]?.note).toBeUndefined();
    expect(fine[1]?.note).toBeUndefined();
    expect(
      panel(
        optionsScene("binomial", {
          azimuth: 0,
          t: 1,
          values: { ...RUN, steps: 3 },
        }),
        "tree"
      ).title
    ).toMatch(/^3-step tree/u);
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
    // The chart shows P&L at expiry; the creator's $1.59 / -$1.41 are today's (discounted) values.
    const growth = Math.exp(0.05);
    expect(calm.ratioNow.toFixed(2)).toBe("1.67");
    expect((calm.ratioNow / growth).toFixed(2)).toBe("1.59");
    const wild = hedgeModel({
      ...RUN,
      iv: 20,
      realizedVol: 24,
      rebalances: 252,
      spread: 0.1,
    });
    expect(wild.hedged.filter((value) => value > 0).length).toBeLessThan(5);
    expect(wild.ratioNow).toBeLessThan(-1.2);
    expect(wild.ratioNow.toFixed(2)).toBe("-1.48");
    expect((wild.ratioNow / growth).toFixed(2)).toBe("-1.41");
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

describe("lesson captions match the computed numbers", () => {
  it("market maker: the step-4 caption quotes the expiry values and today's creator figures", () => {
    const defaults = Object.fromEntries(
      (marketMakerSpec.params ?? []).map((param) => [param.id, param.default])
    ) as ParamValues;
    const input = hedgeInputs(defaults);
    const discount = Math.exp(-input.rate * input.years);
    const money = (value: number): string =>
      `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
    const calm = expectedHedgePnl(input, 0.16);
    const wild = expectedHedgePnl(input, 0.24);
    const caption =
      marketMakerSpec.steps?.find((step) => step.element === "marker")
        ?.caption ?? "";
    expect(caption).toContain(`${money(calm)} per call at expiry`);
    expect(caption).toContain(`(${money(calm * discount)} today`);
    expect(caption).toContain(`${money(Math.abs(wild))} at expiry`);
    expect(caption).toContain(`(${money(wild * discount)} today)`);
    expect(money(calm * discount)).toBe("$1.59");
    expect(money(wild * discount)).toBe("-$1.41");
    const marker = panel(
      optionsScene("hedge", { azimuth: 0, t: 1, values: defaults }),
      "ratio"
    ).markers.find((item) => item.element === "marker");
    expect(marker?.label).toContain(`${money(calm)} at expiry`);
  });
});
