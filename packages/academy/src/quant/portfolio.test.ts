import { describe, expect, it } from "vitest";

import { FORMULAS } from "../formulas.ts";
import { buildScene, buildTables } from "../index.ts";
import type { ParamValues } from "../position.ts";
import type { Panel, SceneData } from "../scene-kit.ts";
import { DEFAULT_ELEMENT_COLORS } from "../scenes.ts";
import { QUANT_MODE_ELEMENTS } from "../schema.ts";
import { quantModel, quantScene, quantTables } from "./index.ts";
import {
  blendModel,
  CLOUD_SIZE,
  diversifyModel,
  frontierModel,
  portfolioScene,
  portfolioTables,
  riskParityModel,
  smlModel,
} from "./portfolio.ts";
import { PORTFOLIO_FORMULAS } from "./portfolio-formulas.ts";
import {
  PORTFOLIO_COLORS,
  PORTFOLIO_ELEMENTS,
  PORTFOLIO_FORMULA_IDS,
  PORTFOLIO_MODELS,
  type PortfolioMode,
} from "./portfolio-ids.ts";

const MODES = Object.keys(PORTFOLIO_ELEMENTS) as PortfolioMode[];
const scene = (mode: PortfolioMode, values: ParamValues = {}, t = 0) =>
  portfolioScene(mode, { azimuth: 0, t, values });
const panel = (data: SceneData, id: string): Panel => {
  const found = data.panels.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`panel ${id} missing`);
  return found;
};
const labels = (data: SceneData): string[] =>
  data.panels.flatMap((item) => [
    item.title,
    ...item.series.map((series) => series.label),
    ...item.markers.map((marker) => marker.label),
  ]);
const drawn = (item: Panel): Set<string> =>
  new Set([
    ...item.series.map((series) => series.element),
    ...item.markers.map((marker) => marker.element),
    ...item.bars.map((bar) => bar.element),
  ]);

describe("portfolio contract", () => {
  it.each(MODES)("%s draws exactly its contract elements", (mode) => {
    const data = scene(mode);
    const contract = PORTFOLIO_ELEMENTS[mode];
    const listed = new Set(data.panels.flatMap((item) => item.elements));
    expect([...listed].sort()).toEqual([...contract].sort());
    for (const item of data.panels) {
      for (const element of drawn(item))
        expect(item.elements).toContain(element);
    }
    const everything = new Set(data.panels.flatMap((item) => [...drawn(item)]));
    for (const element of contract.filter((id) => id !== "axes"))
      expect(everything.has(element), `${mode} draws ${element}`).toBe(true);
    expect(QUANT_MODE_ELEMENTS[mode]).toEqual(contract);
  });

  it.each(MODES)("%s has finite geometry inside a valid scrubber", (mode) => {
    for (const t of [0, 0.5, 1]) {
      const data = scene(mode, {}, t);
      expect(data.horizon).toBe(100);
      expect(data.now).toBeCloseTo(t * 100);
      expect(data.timeUnit).toBe("pct");
      for (const item of data.panels) {
        expect(item.xDomain[0]).toBeLessThan(item.xDomain[1]);
        expect(item.yDomain[0]).toBeLessThan(item.yDomain[1]);
        const numbers = [
          ...item.series.flatMap((series) => series.points.flat()),
          ...item.markers.flatMap((marker) => [marker.x ?? 0, marker.y ?? 0]),
          ...item.bars.flatMap((bar) => [bar.x, bar.y, bar.width]),
        ];
        expect(numbers.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it.each(MODES)("%s is deterministic for the same inputs", (mode) => {
    expect(scene(mode, { seed: 5 }, 0.4)).toEqual(
      scene(mode, { seed: 5 }, 0.4)
    );
  });

  it.each(MODES)("%s builds well-formed tables", (mode) => {
    const tables = portfolioTables(mode, {}, 1);
    expect(tables.length).toBeGreaterThan(0);
    const ids = tables.map((table) => table.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("inputs");
    expect(ids).not.toContain("constants");
    for (const table of tables) {
      expect(table.rows.length).toBeGreaterThan(0);
      for (const row of table.rows)
        expect(row).toHaveLength(table.columns.length);
      expect(JSON.stringify(table)).not.toMatch(/NaN|undefined|TODO/u);
    }
  });

  it.each(MODES)("%s stays finite for extreme and invalid inputs", (mode) => {
    const ids = [
      "retA",
      "volA",
      "retB",
      "volB",
      "retC",
      "volC",
      "rho",
      "rhoAB",
      "rhoAC",
      "rhoBC",
      "rf",
      "mixes",
      "seed",
      "vol",
      "assets",
      "marketReturn",
      "alpha",
      "mispricing",
      "gap",
      "stockVol",
      "bondVol",
      "stockWeight",
      "riskAversion",
      "tau",
      "view",
      "confidence",
    ];
    for (const value of [1e300, -1e300, 0, -5, "abc"]) {
      const values = Object.fromEntries(ids.map((id) => [id, value]));
      for (const t of [0, 1]) {
        const data = scene(mode, values, t);
        for (const item of data.panels) {
          expect(item.xDomain.every(Number.isFinite)).toBe(true);
          expect(item.yDomain.every(Number.isFinite)).toBe(true);
          expect(item.yDomain[0]).toBeLessThan(item.yDomain[1]);
          const numbers = [
            ...item.series.flatMap((series) => series.points.flat()),
            ...item.markers.flatMap((marker) => [marker.x ?? 0, marker.y ?? 0]),
            ...item.bars.flatMap((bar) => [bar.x, bar.y]),
          ];
          expect(numbers.every(Number.isFinite), `${mode} ${value}`).toBe(true);
        }
        for (const table of portfolioTables(mode, values, t))
          for (const row of table.rows)
            expect(row.join(" ")).not.toMatch(/NaN|undefined|Infinity/u);
      }
    }
  });

  it.each(MODES)("%s builds through the shared lesson builders", (mode) => {
    const lesson = { params: [], scene: { mode, type: "quant" } } as never;
    expect(buildScene(lesson, {}, 0.5)).toEqual(scene(mode, {}, 0.5));
    const tables = buildTables(lesson, {}, 0.5);
    expect(tables.map((table) => table.id)).toEqual(
      expect.arrayContaining(portfolioTables(mode, {}, 0.5).map((t) => t.id))
    );
  });

  it("routes every mode through the quant dispatcher", () => {
    for (const mode of MODES) {
      expect(quantScene(mode, { azimuth: 0, t: 0, values: {} })).toEqual(
        scene(mode)
      );
      expect(quantTables(mode, {}, 0)).toEqual(portfolioTables(mode, {}, 0));
      expect(quantModel(mode)).toBe(PORTFOLIO_MODELS[mode]);
    }
  });

  it("names a model, colors and formulas without placeholders", () => {
    for (const mode of MODES) {
      expect(PORTFOLIO_MODELS[mode]).not.toMatch(/TODO/u);
      for (const element of PORTFOLIO_ELEMENTS[mode]) {
        expect(
          PORTFOLIO_COLORS[element] ?? DEFAULT_ELEMENT_COLORS[element],
          `${mode}.${element} color`
        ).toBeDefined();
      }
    }
    expect(Object.keys(PORTFOLIO_FORMULAS).sort()).toEqual(
      [...PORTFOLIO_FORMULA_IDS].sort()
    );
    for (const id of PORTFOLIO_FORMULA_IDS) {
      const formula = PORTFOLIO_FORMULAS[id];
      expect(formula.id).toBe(id);
      expect(FORMULAS[id]).toBe(formula);
      expect(formula.mathml).toMatch(/^<math display="block">.*<\/math>$/u);
      expect(`${formula.title} ${formula.text} ${formula.mathml}`).not.toMatch(
        /TODO/u
      );
    }
  });
});

describe("frontier", () => {
  it("reproduces the Part 13 frontier and the Part 8 Sharpe ratios", () => {
    const model = frontierModel({});
    expect(model.minVar.vol).toBeCloseTo(5.7, 1);
    expect(model.minVar.ret).toBeCloseTo(4.4, 1);
    const at18 = model.frontier.reduce((best, point) =>
      Math.abs(point.vol - 18) < Math.abs(best.vol - 18) ? point : best
    );
    expect(at18.ret).toBeCloseTo(9.1, 1);
    expect(model.sharpe(at18)).toBeCloseTo(0.34, 2);
    const b = model.assets[1];
    expect(b === undefined ? 0 : model.sharpe(b)).toBeCloseTo(0.22, 2);
    // Part 8: wild 12 % at 24 % and calm 6 % at 3 % with a 3 % safe rate.
    const part8 = frontierModel({ retA: 6, retC: 12, volA: 3, volC: 24 });
    expect(part8.assets.map((asset) => part8.sharpe(asset).toFixed(2))).toEqual(
      ["1.00", "0.22", "0.38"]
    );
  });

  it("keeps the frontier efficient and the tangency on top of every mix", () => {
    const model = frontierModel({});
    for (let index = 1; index < model.frontier.length; index += 1) {
      const previous = model.frontier[index - 1];
      const current = model.frontier[index];
      expect(current?.ret).toBeGreaterThan(previous?.ret ?? 0);
      expect(current?.vol).toBeGreaterThanOrEqual(previous?.vol ?? 0);
    }
    const best = model.sharpe(model.tangency);
    for (const mix of [...model.cloud, ...model.frontier])
      expect(model.sharpe(mix)).toBeLessThanOrEqual(best + 1e-12);
    for (const mix of model.cloud) {
      expect(mix.weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(
        1
      );
      expect(Math.min(...mix.weights)).toBeGreaterThanOrEqual(0);
      expect(mix.vol).toBeGreaterThanOrEqual(model.minVar.vol - 1e-9);
    }
  });

  it("reveals the random cloud with t and draws CML and capital lines", () => {
    const cloudAt = (values: ParamValues, t: number): number =>
      panel(scene("frontier", values, t), "frontier").markers.filter(
        (marker) => marker.element === "cloud"
      ).length;
    expect([0, 0.5, 1].map((t) => cloudAt({}, t))).toEqual([15, 83, 150]);
    expect(cloudAt({ mixes: 1000 }, 1)).toBe(CLOUD_SIZE);
    expect(cloudAt({ mixes: 3 }, 1)).toBe(10);
    // A smaller cloud is the start of the same seeded draw.
    expect(frontierModel({ mixes: 40 }).cloud).toEqual(
      frontierModel({}).cloud.slice(0, 40)
    );
    const data = panel(scene("frontier"), "frontier");
    const lines = data.series.filter((series) => series.element === "lines");
    expect(lines.map((line) => line.label)).toEqual([
      "A: Sharpe 0.17",
      "B: Sharpe 0.22",
      "C: Sharpe 0.32",
    ]);
    for (const line of [
      ...lines,
      ...data.series.filter((s) => s.element === "cml"),
    ])
      expect(line.points[0]).toEqual([0, 3]);
    expect(labels(scene("frontier"))).toContain("Risk-free 3.0%");
    const cml = data.series.find((series) => series.element === "cml");
    const slope = ((cml?.points[1]?.[1] ?? 0) - 3) / (cml?.points[1]?.[0] ?? 1);
    expect(slope).toBeCloseTo(
      frontierModel({}).sharpe(frontierModel({}).tangency)
    );
  });

  it("takes one shared correlation or pairwise ones", () => {
    expect(frontierModel({}).correlations).toEqual({ AB: 0, AC: 0, BC: 0.5 });
    expect(frontierModel({ rho: 0.3 }).correlations).toEqual({
      AB: 0.3,
      AC: 0.3,
      BC: 0.3,
    });
    expect(frontierModel({ rho: 0.3, rhoBC: 2 }).correlations).toEqual({
      AB: 0.3,
      AC: 0.3,
      BC: 1,
    });
    // Lower correlation lowers the minimum-variance risk.
    expect(frontierModel({ rho: -0.5 }).minVar.vol).toBeLessThan(
      frontierModel({ rho: 0.8 }).minVar.vol
    );
    // A different seed draws a different cloud; tiny volatilities are floored.
    expect(frontierModel({ seed: 2 }).cloud).not.toEqual(
      frontierModel({}).cloud
    );
    expect(frontierModel({ volA: 0 }).assets[0]?.vol).toBe(0.5);
  });

  it("tabulates assets, correlations and the optimal mixes", () => {
    const [assets, portfolios] = portfolioTables("frontier", {}, 0);
    expect(assets?.rows[1]).toEqual(["B", "7.0%", "18.0%", "0.22"]);
    expect(assets?.note).toContain("B-C 0.50");
    expect(portfolios?.rows.map((row) => row[0])).toEqual([
      "Minimum variance",
      "Tangency (max Sharpe)",
    ]);
    expect(portfolios?.note).toContain("of 20301 grid mixes");
    expect(portfolios?.note).toContain("15 random mixes drawn");
  });
});

describe("diversify", () => {
  it("reproduces Part 10 mix risks and Part 11 diversification", () => {
    const part10 = diversifyModel({ rho: 0.8 });
    expect(part10.mixVol(0.8)).toBeCloseTo(18.97, 2);
    expect(part10.mixVol(0)).toBeCloseTo(14.14, 2);
    expect(part10.mixVol(-0.5)).toBeCloseTo(10, 6);
    expect(part10.sample).toBeCloseTo(0.8, 1);
    const part11 = diversifyModel({ rho: 0.3 });
    expect(part11.countVol(1)).toBeCloseTo(20, 6);
    expect(part11.countVol(10)).toBeCloseTo(12.2, 1);
    expect(part11.countVol(50)).toBeCloseTo(11.2, 1);
    expect(part11.floor).toBeCloseTo(10.95, 2);
  });

  it("draws the scatter, the 50/50 curve with its marker and the count floor", () => {
    const data = scene("diversify", { assets: 40, rho: 0.5, vol: 30 }, 1);
    expect(data.layout).toBe("grid");
    expect(panel(data, "scatter").markers).toHaveLength(250);
    expect(panel(scene("diversify"), "scatter").markers).toHaveLength(25);
    const marker = panel(data, "mix").markers[0];
    expect(marker?.x).toBe(0.5);
    expect(marker?.y).toBeCloseTo(30 * Math.sqrt(0.75));
    const count = panel(data, "count");
    expect(count.series[0]?.points).toHaveLength(40);
    expect(count.xDomain).toEqual([1, 40]);
    expect(count.markers[0]?.y).toBeCloseTo(30 * Math.sqrt(0.5));
    expect(count.title).toContain("at N = 40");
  });

  it("handles perfect and negative correlation", () => {
    const perfect = diversifyModel({ rho: 1 });
    expect(perfect.sample).toBeCloseTo(1, 6);
    const inverse = diversifyModel({ rho: -1 });
    expect(inverse.sample).toBeCloseTo(-1, 6);
    expect(inverse.floor).toBe(0);
    expect(inverse.floorRho).toBe(0);
    const negative = scene("diversify", { rho: -0.4 });
    // Equal correlation −0.4 exists for at most 1 + 1/0.4 = 3.5, so 3 assets.
    expect(panel(negative, "count").title).toContain("only possible for N ≤ 3");
    expect(panel(negative, "count").series[0]?.points).toHaveLength(3);
    const negativeModel = diversifyModel({ rho: -0.4 });
    // N = 2 on the count curve is the 50/50 mix: one ρ for both panels.
    expect(negativeModel.countVol(2)).toBeCloseTo(
      negativeModel.mixVol(-0.4),
      9
    );
    expect(inverse.validCount).toBe(2);
    expect(inverse.countVol(2)).toBe(0);
    const [counts] = portfolioTables("diversify", { rho: -0.4 }, 1);
    expect(counts?.rows.map((row) => row[0])).toEqual(["1", "2", "3"]);
    expect(counts?.note).toContain("at most 3 assets");
    expect(diversifyModel({ assets: 1, vol: 0 })).toMatchObject({
      assets: 2,
      vol: 0.5,
    });
  });

  it("shrinks impossible correlation sets to a valid matrix and never shows a riskless Sharpe", () => {
    const det = (c: Readonly<{ AB: number; AC: number; BC: number }>) =>
      1 + 2 * c.AB * c.AC * c.BC - c.AB ** 2 - c.AC ** 2 - c.BC ** 2;
    // All three pairs at −0.9 cannot hold together: det = 1 − 1.458 − 2.43 < 0.
    const model = frontierModel({ rho: -0.9 });
    expect(model.correlationsValid).toBe(false);
    expect(model.entered).toEqual({ AB: -0.9, AC: -0.9, BC: -0.9 });
    expect(det(model.correlations)).toBeGreaterThanOrEqual(0);
    expect(det(model.correlations)).toBeLessThan(1e-9);
    expect(model.correlationScale).toBeCloseTo(0.5 / 0.9, 6);
    expect(model.correlations.AB).toBeCloseTo(-0.5, 6);
    for (const point of [model.minVar, model.tangency, ...model.cloud])
      expect(Number.isFinite(model.sharpe(point))).toBe(true);
    expect(Math.abs(model.sharpe(model.tangency))).toBeLessThan(1e4);
    const data = scene("frontier", { rho: -0.9 });
    expect(panel(data, "frontier").title).toContain("Invalid correlations");
    const [assets, portfolios] = portfolioTables("frontier", { rho: -0.9 }, 1);
    expect(assets?.note).toContain("not positive semidefinite");
    // The min-variance mix of the shrunk (singular) matrix is riskless: no Sharpe ratio for it.
    expect(model.minVar.vol).toBeLessThan(0.25);
    expect(portfolios?.rows[0]?.[4]).toBe("riskless");
    expect(frontierModel({}).correlationsValid).toBe(true);
    expect(
      frontierModel({ rhoAB: 0.9, rhoAC: 0.9, rhoBC: -0.9 }).correlationsValid
    ).toBe(false);
    expect(
      frontierModel({ rhoAB: 0.9, rhoAC: 0.9, rhoBC: 0.9 }).correlationsValid
    ).toBe(true);
  });

  it("tabulates N and correlation rows without duplicates", () => {
    const [counts, mixes] = portfolioTables("diversify", { assets: 30 }, 1);
    expect(counts?.rows.map((row) => row[0])).toEqual([
      "1",
      "2",
      "5",
      "10",
      "20",
      "30",
    ]);
    expect(mixes?.rows.map((row) => row[0])).toEqual([
      "-0.50",
      "0.00",
      "0.30",
      "0.80",
    ]);
    expect(mixes?.note).toContain("250 drawn days");
  });
});

describe("sml", () => {
  it("puts the line at rf + beta x premium with the stocks near it", () => {
    const model = smlModel({ marketReturn: 8, rf: 3 });
    expect(model.capm(1.2)).toBeCloseTo(9);
    expect(model.stocks.map((stock) => stock.beta)).toEqual([
      0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4,
    ]);
    for (const stock of model.stocks)
      expect(Math.abs(stock.expected - model.capm(stock.beta))).toBeLessThan(2);
    expect(model.alphaStock.expected - model.capm(model.alphaStock.beta)).toBe(
      2
    );
    expect(model.pair.high - model.pair.low).toBeCloseTo(2);
  });

  it("labels the alpha above or below the line and the APT pair", () => {
    const above = labels(scene("sml"));
    expect(above).toContain("α +2.0%: above the line, underpriced");
    expect(above).toContain("Market 8.0%");
    expect(above.some((label) => label.startsWith("Same β 1.1"))).toBe(true);
    const below = labels(scene("sml", { mispricing: -3 }));
    expect(below).toContain("α -3.0%: below the line, overpriced");
    expect(smlModel({ alpha: 0 }).gap).toBe(0.5);
    expect(smlModel({ alpha: 1, gap: 4 }).gap).toBe(4);
  });

  it("tabulates every stock with its alpha", () => {
    const [table] = portfolioTables("sml", { alpha: -1.5 }, 0);
    expect(table?.rows).toHaveLength(11);
    expect(table?.rows[8]).toEqual([
      "Mispriced",
      "0.5",
      "5.50%",
      "4.00%",
      "-1.50%",
    ]);
    expect(table?.rows[9]?.[4]).toBe("+0.75%");
  });
});

describe("riskparity", () => {
  it("reproduces the Part 42 numbers", () => {
    const model = riskParityModel({});
    expect(model.classic.stockRisk).toBeCloseTo(0.918, 3);
    expect(model.parity.stockWeight).toBeCloseTo(0.25);
    expect(model.parity.stockRisk).toBeCloseTo(0.5);
    expect(riskParityModel({ rho: 0 }).classic.stockRisk).toBeGreaterThan(0.9);
    expect(riskParityModel({ rho: 0.3 }).classic.stockRisk).toBeLessThan(0.95);
    // Inverse volatility splits risk equally for any correlation.
    expect(riskParityModel({ rho: -1 }).parity.bondRisk).toBeCloseTo(0.5);
  });

  it("draws capital and risk bars in two panels", () => {
    const data = scene("riskparity", { stockWeight: 80 });
    expect(data.panels.map((item) => item.id)).toEqual(["classic", "parity"]);
    const classic = panel(data, "classic");
    expect(classic.bars.every((bar) => bar.tone === true)).toBe(true);
    expect(classic.bars.map((bar) => [bar.element, Math.round(bar.y)])).toEqual(
      [
        ["capital", 80],
        ["risk", 98],
        ["capital", 20],
        ["risk", 2],
      ]
    );
    expect(classic.markers.map((marker) => marker.label)).toEqual([
      "Money 80%",
      "Risk 98%",
      "Money 20%",
      "Risk 2%",
    ]);
    expect(panel(data, "parity").title).toContain("each carries 50.0%");
  });

  it("extends the bar range below zero for a negative risk share", () => {
    const hedged = scene("riskparity", { rho: -0.9, stockWeight: 90 });
    const classic = panel(hedged, "classic");
    const lowest = Math.min(...classic.bars.map((bar) => bar.y));
    expect(lowest).toBeLessThan(0);
    expect(classic.yDomain[0]).toBeLessThan(lowest);
    expect(classic.yDomain[1]).toBeGreaterThan(100);
  });

  it("tabulates both mixes", () => {
    const [table] = portfolioTables("riskparity", {}, 0);
    expect(table?.rows.map((row) => row.slice(0, 4))).toEqual([
      ["Chosen mix", "Stocks", "60.0%", "91.8%"],
      ["Chosen mix", "Bonds", "40.0%", "8.2%"],
      ["Risk parity", "Stocks", "25.0%", "50.0%"],
      ["Risk parity", "Bonds", "75.0%", "50.0%"],
    ]);
  });
});

describe("blend", () => {
  it("reproduces the Part 43 implied and posterior returns", () => {
    const model = blendModel({});
    expect(model.prior.stock).toBeCloseTo(3.525, 6);
    expect(model.prior.bond).toBeCloseTo(0.475, 6);
    expect(model.posterior(0.5).stock).toBeCloseTo(4.7625, 6);
    // At 50 % the view is as uncertain as the market: Ω = τσ².
    expect(model.omega).toBeCloseTo(0.05 * 0.15 ** 2, 9);
  });

  it("matches the full Black-Litterman formula for one view", () => {
    const tau = 0.05;
    const confidence = 0.3;
    const model = blendModel({ confidence: 30, tau, view: 2 });
    const covariance = 0.2 * 0.15 * 0.05;
    const omega = (tau * 0.15 ** 2 * (1 - confidence)) / confidence;
    const gain = 1 / (tau * 0.15 ** 2 + omega);
    const surprise = 2 - model.prior.stock;
    const posterior = model.posterior(confidence);
    expect(posterior.stock).toBeCloseTo(
      model.prior.stock + tau * 0.15 ** 2 * gain * surprise,
      9
    );
    expect(posterior.bond).toBeCloseTo(
      model.prior.bond + tau * covariance * gain * surprise,
      9
    );
  });

  it("returns the prior without trust and the view with full trust", () => {
    const none = portfolioTables("blend", { confidence: 0 }, 0)[0];
    expect(none?.rows[0]?.[4]).toBe("3.525%");
    expect(none?.note).toContain("Ω ∞");
    const full = scene("blend", { confidence: 100, view: 7 });
    const marker = panel(full, "confidence").markers[0];
    expect(marker?.x).toBe(100);
    expect(marker?.y).toBeCloseTo(7);
    expect(marker?.label).toBe("100% sure: 7.00%");
  });

  it("draws prior, view and posterior bars and the confidence curve", () => {
    const data = scene("blend");
    const returns = panel(data, "returns");
    expect(returns.bars.map((bar) => bar.element)).toEqual([
      "prior",
      "view",
      "posterior",
      "prior",
      "posterior",
    ]);
    expect(returns.markers.map((marker) => marker.label)).toEqual([
      "Implied 3.5%",
      "View 6.0%",
      "Posterior 4.8%",
      "Implied 0.5%",
      "Posterior 0.6%",
    ]);
    const curve = panel(data, "confidence").series[0]?.points ?? [];
    expect(curve[0]).toEqual([0, 3.525]);
    expect(curve.at(-1)?.[1]).toBeCloseTo(6);
    expect(blendModel({ riskAversion: 5 }).prior.stock).toBeCloseTo(7.05);
    const flat = scene("blend", { riskAversion: 0, view: 0 });
    expect(panel(flat, "returns").yDomain).toEqual([0, 1.15]);
  });
});
