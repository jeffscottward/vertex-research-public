import { describe, expect, it } from "vitest";

import type { ParamValues } from "../position.ts";
import type { DataTable, SceneData } from "../scene-kit.ts";
import {
  gbmRun,
  meanrevRun,
  processScene,
  processTables,
  pullTest,
  walkRun,
} from "./process.ts";
import { PROCESS_FORMULAS } from "./process-formulas.ts";
import {
  PROCESS_COLORS,
  PROCESS_ELEMENTS,
  PROCESS_FORMULA_IDS,
  PROCESS_MODELS,
  type ProcessMode,
} from "./process-ids.ts";

const scene = (mode: ProcessMode, values: ParamValues, t = 1): SceneData =>
  processScene(mode, { azimuth: 0, t, values });

const table = (tables: readonly DataTable[], id: string): DataTable => {
  const found = tables.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`table ${id} missing`);
  return found;
};

const cell = (found: DataTable, label: string, column = 1): string => {
  const row = found.rows.find((candidate) => candidate[0] === label);
  if (row === undefined) throw new Error(`row ${label} missing`);
  return row[column] as string;
};

const finite = (data: SceneData): boolean =>
  data.panels.every(
    (panel) =>
      panel.series.every((series) =>
        series.points.every(
          ([x, y]) => Number.isFinite(x) && Number.isFinite(y)
        )
      ) &&
      panel.bars.every(
        (bar) => Number.isFinite(bar.x) && Number.isFinite(bar.y)
      )
  );

const ROULETTE = {
  drift: -0.027,
  paths: 1000,
  seed: 7,
  start: 0,
  steps: 1000,
  stepVol: 1,
};

describe("process contract", () => {
  it("has a formula, a model line and only known elements for every id", () => {
    for (const id of PROCESS_FORMULA_IDS) {
      expect(PROCESS_FORMULAS[id].id).toBe(id);
      expect(PROCESS_FORMULAS[id].mathml).toMatch(/^<math display="block">/u);
      expect(PROCESS_FORMULAS[id].text).not.toContain("TODO");
      expect(PROCESS_FORMULAS[id].mathml).not.toContain("<mo> </mo>");
    }
    expect(PROCESS_FORMULAS.gbm.mathml).toContain("<mtext>median</mtext>");
    expect(PROCESS_FORMULAS.gbm.text).toContain("median S_0·e^((μ - σ²/2)t)");
    for (const mode of Object.keys(PROCESS_ELEMENTS) as ProcessMode[]) {
      expect(PROCESS_MODELS[mode]).not.toContain("TODO");
      const drawn = new Set(
        scene(mode, {}).panels.flatMap((panel) => [
          ...panel.elements,
          ...panel.series.map((series) => series.element),
          ...panel.markers.map((marker) => marker.element),
          ...panel.bars.map((bar) => bar.element),
        ])
      );
      expect([...drawn].sort()).toEqual([...PROCESS_ELEMENTS[mode]].sort());
    }
    expect(Object.keys(PROCESS_COLORS).sort()).toEqual([
      "band",
      "decay",
      "halfLife",
      "mean",
    ]);
  });
});

describe("walk", () => {
  it("draws a seeded coin walk with the expected line, envelope and histogram", () => {
    const data = scene("walk", ROULETTE);
    expect(finite(data)).toBe(true);
    expect(data.horizon).toBe(1000);
    expect(data.now).toBe(1000);
    const [paths, terminal] = data.panels;
    expect(paths?.series.filter((s) => s.element === "paths")).toHaveLength(40);
    const mean = paths?.series.find((s) => s.element === "mean");
    // 18 of 37 pockets win: an edge of about -2.7 cents per bet.
    expect(mean?.points.at(-1)?.[1]).toBeCloseTo(-27, 0);
    expect(paths?.series.filter((s) => s.element === "band")).toHaveLength(4);
    const bars = terminal?.bars ?? [];
    const total = bars.reduce((sum, bar) => sum + bar.y, 0);
    expect(total).toBeGreaterThan(990);
    expect(bars.some((bar) => bar.tone === true)).toBe(true);
    expect(bars.some((bar) => bar.tone === false && bar.y > 0)).toBe(true);
    // Same inputs, same chart; the time fraction reveals the paths.
    expect(scene("walk", ROULETTE)).toEqual(data);
    expect(scene("walk", ROULETTE, 0).now).toBe(1);
    expect(scene("walk", ROULETTE, 0.5).panels[0]?.series[0]?.revealTo).toBe(
      500
    );
  });

  it("reports edge against luck and the terminal spread", () => {
    const tables = processTables("walk", ROULETTE, 1);
    const checkpoints = table(tables, "walk-checkpoints");
    expect(checkpoints.rows.map((row) => row[0])).toEqual([
      "10",
      "25",
      "100",
      "400",
      "1000",
    ]);
    expect(checkpoints.rows.at(-1)?.[1]).toBe("-$27.00");
    expect(checkpoints.note).toContain("1,371 steps");
    const terminal = table(tables, "walk-terminal");
    expect(cell(terminal, "Within ±1σ√n of n·μ", 2)).toBe("68.3%");
    expect(cell(terminal, "Paths ending above start")).toMatch(/^\d+ \(/u);
  });

  it("supports uniform and normal steps and a walk without edge", () => {
    for (const shape of ["uniform", "normal"]) {
      const values = { paths: 50, seed: 3, shape, steps: 120, stepVol: 0.5 };
      const data = scene("walk", values);
      expect(finite(data)).toBe(true);
      const run = walkRun(values);
      expect(run.sd).toBe(0.5);
      expect(run.checkpoints).toEqual([10, 25, 100, 120]);
      expect(
        table(processTables("walk", values, 0), "walk-checkpoints").note
      ).toContain("No edge");
    }
    const coin = walkRun({ paths: 5, steps: 1 });
    expect(coin.mean).toBe(0);
    expect(coin.xs).toEqual([0, 1]);
    // A drift beyond the coin size keeps a small spread.
    expect(walkRun({ drift: 5, paths: 5, steps: 10 }).sd).toBeGreaterThan(0);
    // Long walks are drawn every k-th step (5000 steps: every 13th, then the last).
    const long = walkRun({ paths: 2, steps: 5000 });
    expect(long.xs).toHaveLength(386);
    expect(long.xs.at(-1)).toBe(5000);
    expect(long.shown[0]).toHaveLength(386);
  });

  it("caches recent runs and rebuilds after many inputs", () => {
    const first = walkRun({ paths: 3, seed: 100, steps: 20 });
    expect(walkRun({ paths: 3, seed: 100, steps: 20 })).toBe(first);
    for (let seed = 101; seed < 110; seed += 1)
      walkRun({ paths: 3, seed, steps: 20 });
    const again = walkRun({ paths: 3, seed: 100, steps: 20 });
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
});

describe("gbm", () => {
  const MONTE_CARLO = {
    drift: 8,
    paths: 2000,
    seed: 11,
    spot: 10_000,
    vol: 20,
    years: 30,
  };

  it("fans price paths with median, percentile band, expected value and a lognormal histogram", () => {
    const data = scene("gbm", MONTE_CARLO, 0.5);
    expect(finite(data)).toBe(true);
    expect(data.horizon).toBe(7560);
    expect(data.now).toBe(3780);
    const [fanPanel, terminal] = data.panels;
    expect(fanPanel?.series.filter((s) => s.element === "band")).toHaveLength(
      2
    );
    const expected = fanPanel?.series.find((s) => s.element === "mean");
    expect(expected?.points.at(-1)?.[1]).toBeCloseTo(
      10_000 * Math.exp(0.08 * 30),
      0
    );
    expect(fanPanel?.yDomain[0]).toBe(0);
    expect(terminal?.title).toContain("30.0 years");
    expect(terminal?.bars.some((bar) => bar.tone === true)).toBe(true);
    const run = gbmRun(MONTE_CARLO);
    expect(run.xs).toHaveLength(253);
    expect(run.median[0]).toBe(10_000);
  });

  it("tables the loss share and median against mean", () => {
    const rows = table(processTables("gbm", MONTE_CARLO, 1), "gbm-terminal");
    expect(cell(rows, "Median final price", 2)).toBe("$60,496.47");
    expect(cell(rows, "Mean final price", 2)).toBe("$110,231.76");
    expect(cell(rows, "Paths ending below start (loss share)", 2)).toBe("5.0%");
    expect(cell(rows, "Paths ending below start (loss share)")).toMatch(
      /of 2000/u
    );
    expect(cell(rows, "Volatility per trading day", 2)).toBe("1.26%");
  });

  it("simulates short horizons day by day", () => {
    const values = { drift: 8, paths: 50, vol: 4, years: 0.25 };
    const data = scene("gbm", values);
    expect(finite(data)).toBe(true);
    expect(data.panels[1]?.title).toContain("0.25 years");
    expect(gbmRun(values).xs.at(-1)).toBe(63);
    expect(gbmRun({ paths: 10, years: 0 }).tradingDays).toBe(1);
  });
});

describe("meanrev", () => {
  const SPREAD = {
    days: 1008,
    halfLife: 10,
    paths: 100,
    seed: 5,
    start: 3,
    vol: 1,
  };

  it("pulls paths back to the mean with a stationary band and half-life markers", () => {
    const data = scene("meanrev", SPREAD, 0.25);
    expect(finite(data)).toBe(true);
    expect(data.now).toBe(252);
    const [paths, decay] = data.panels;
    const band = paths?.series.find((s) => s.element === "band");
    expect(band?.points[0]?.[1]).toBeCloseTo(
      1 / Math.sqrt(1 - 2 ** (-2 / 10)),
      6
    );
    expect(paths?.markers[0]).toMatchObject({ kind: "vline", x: 10 });
    expect(decay?.markers[1]).toMatchObject({ kind: "dot", x: 10, y: 50 });
    const expected = decay?.series[0]?.points ?? [];
    const atHalfLife = expected.find(([day]) => Math.abs(day - 10.08) < 1e-6);
    expect(atHalfLife?.[1]).toBeCloseTo(100 * 2 ** -1.008, 6);
    expect(decay?.series).toHaveLength(2);
    expect(scene("meanrev", SPREAD, 0).now).toBe(0.5);
    expect(meanrevRun(SPREAD).xs).toHaveLength(337);
  });

  it("tables the model, the decay check and the regression test", () => {
    const tables = processTables("meanrev", SPREAD, 1);
    expect(cell(table(tables, "meanrev-model"), "Half-life")).toBe("10.0 days");
    const decay = table(tables, "meanrev-decay");
    expect(decay.rows.map((row) => row[0])).toEqual([
      "0",
      "10",
      "20",
      "30",
      "1008",
    ]);
    expect(decay.rows[1]?.[1]).toBe("1.500");
    const test = table(tables, "meanrev-test");
    expect(cell(test, "Verdict at the -2.9 limit")).toBe("Pull back detected");
    expect(cell(test, "Estimated half-life")).toMatch(/days$/u);
  });

  it("finds no reliable pull in a short pure random walk", () => {
    const walk = { days: 60, halfLife: 1000, paths: 1, seed: 1, start: 0 };
    const data = scene("meanrev", walk);
    expect(data.panels[1]?.series).toHaveLength(1);
    const test = table(processTables("meanrev", walk, 1), "meanrev-test");
    expect(cell(test, "Estimated half-life")).toBe("none (no pull back)");
    expect(cell(test, "Verdict at the -2.9 limit")).toBe(
      "No reliable pull back"
    );
  });

  it("simulates the AR(1) the formula shows, with long-run sd σ/√(1 - φ²)", () => {
    const values = {
      days: 2000,
      halfLife: 5,
      paths: 1,
      seed: 11,
      start: 0,
      vol: 2,
    };
    const run = meanrevRun(values);
    expect(run.phi).toBeCloseTo(Math.exp(-run.theta), 12);
    const expected = 2 / Math.sqrt(1 - run.phi ** 2);
    expect(run.stationary).toBeCloseTo(expected, 12);
    const settled = run.first.slice(100);
    const mean = settled.reduce((sum, x) => sum + x, 0) / settled.length;
    const sd = Math.sqrt(
      settled.reduce((sum, x) => sum + (x - mean) ** 2, 0) /
        (settled.length - 1)
    );
    expect(sd / expected).toBeGreaterThan(0.85);
    expect(sd / expected).toBeLessThan(1.15);
    const model = table(processTables("meanrev", values, 1), "meanrev-model");
    expect(cell(model, "Long-run sd = σ / √(1 - φ²)")).toBe(
      expected.toFixed(3)
    );
    const formula = PROCESS_FORMULAS.ornsteinUhlenbeck;
    expect(formula.text).toContain("X_(t+1) = φ·X_t + σ·ε_t");
    expect(formula.text).toContain("σ / √(1 - φ²)");
    expect(formula.mathml).toContain("<mi>φ</mi>");
    expect(formula.mathml).not.toContain("<mo> </mo>");
  });

  it("estimates the slope, t statistic and half-life of a path", () => {
    const halving = pullTest([16, 8, 4, 2, 1.5, 0.25, 0.5, 0.125]);
    expect(halving.slope).toBeLessThan(0);
    expect(halving.halfLife).toBeGreaterThan(0);
    const away = pullTest([0, 1, 3, 6, 10]);
    expect(away.slope).toBeGreaterThan(0);
    expect(away.halfLife).toBe(Number.POSITIVE_INFINITY);
  });
});
