import { describe, expect, it } from "vitest";
import { buildScene, buildTables } from "../index.ts";
import type { SceneData } from "../scene-kit.ts";
import { TESTING_FORMULAS } from "./testing-formulas.ts";
import {
  TESTING_COLORS,
  TESTING_ELEMENTS,
  TESTING_FORMULA_IDS,
  TESTING_MODELS,
  type TestingMode,
} from "./testing-ids.ts";
import {
  expectedMaxSharpe,
  normInv,
  pValue,
  significanceModel,
  snoopingModel,
  testingScene,
  testingTables,
} from "./testing.ts";

const MODES = Object.keys(TESTING_ELEMENTS) as TestingMode[];

const scene = (mode: TestingMode, values = {}, t = 1): SceneData =>
  testingScene(mode, { azimuth: 0, t, values });

const finite = (data: SceneData): boolean =>
  [data.now, data.horizon].every(Number.isFinite) &&
  data.panels.every(
    (panel) =>
      [...panel.xDomain, ...panel.yDomain].every(Number.isFinite) &&
      panel.series.every((s) =>
        s.points.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))
      ) &&
      panel.markers.every((m) =>
        [m.x, m.y, m.x2].every((v) => v === undefined || Number.isFinite(v))
      )
  );

const noNaN = (mode: TestingMode, values: object, t: number): boolean =>
  testingTables(mode, values as never, t).every((table) =>
    table.rows.every((row) => row.every((cell) => !cell.includes("NaN")))
  );

describe("testing contract", () => {
  it.each(MODES)("%s draws every element in its panels", (mode) => {
    for (const t of [0, 0.5, 1]) {
      const data = scene(mode, {}, t);
      expect(finite(data)).toBe(true);
      for (const id of TESTING_ELEMENTS[mode].filter((e) => e !== "axes")) {
        const panel = data.panels.find((p) => p.elements.includes(id));
        const drawn = [...(panel?.series ?? []), ...(panel?.markers ?? [])];
        expect(drawn.some((d) => d.element === id)).toBe(true);
      }
    }
    expect(TESTING_MODELS[mode]).not.toContain("TODO");
  });

  it.each(MODES)("%s stays finite on extreme and invalid inputs", (mode) => {
    const inputs = [
      { alpha: -1, rules: 1e9, sharpe: 1e9, years: 1e9, seed: 1e12 },
      { alpha: 0, rules: -5, sharpe: -1e9, years: -3, seed: -1 },
      { alpha: "abc", rules: "abc", sharpe: "abc", years: "abc", seed: "abc" },
      { alpha: 0, rules: 0, sharpe: 0, years: 0, seed: 0 },
    ];
    for (const values of inputs)
      for (const t of [-1, 0, 0.5, 1, 2]) {
        expect(finite(scene(mode, values, t))).toBe(true);
        expect(noNaN(mode, values, t)).toBe(true);
      }
  });

  it.each(MODES)("%s runs through buildScene and buildTables", (mode) => {
    const lesson = { params: [], scene: { mode, type: "quant" } } as never;
    expect(buildScene(lesson, {}, 0.5).panels.length).toBe(2);
    expect(buildTables(lesson, {}, 0.5).length).toBeGreaterThan(2);
  });

  it("has formulas for every id and colors on drawn ids", () => {
    for (const id of TESTING_FORMULA_IDS) {
      const formula = TESTING_FORMULAS[id];
      expect(formula.id).toBe(id);
      expect(formula.title.length).toBeGreaterThan(0);
      expect(formula.text).not.toContain("TODO");
      expect(formula.mathml.startsWith("<math")).toBe(true);
    }
    expect(Object.keys(TESTING_COLORS).length).toBeGreaterThan(0);
  });
});

describe("snooping", () => {
  it("expected max follows σ√(2 ln N)", () => {
    expect(expectedMaxSharpe(1, 0.5)).toBe(0);
    expect(expectedMaxSharpe(100, 1)).toBeCloseTo(Math.sqrt(2 * Math.log(100)));
  });

  it("is seeded, best grows with N and out of sample is unrelated", () => {
    const a = snoopingModel({ rules: 1000, seed: 3, years: 5 });
    expect(snoopingModel({ rules: 1000, seed: 3, years: 5 })).toEqual(a);
    expect(snoopingModel({ rules: 1000, seed: 4, years: 5 })).not.toEqual(a);
    expect(a.runningBest.at(-1)).toBeGreaterThan(a.runningBest[9] as number);
    const tables = testingTables(
      "snooping",
      { rules: 1000, seed: 3, years: 5 },
      1
    );
    const corr = Number(tables[0]?.rows[6]?.[1]);
    expect(Math.abs(corr)).toBeLessThan(0.15);
  });

  it("more years shrink the luck", () => {
    const short = snoopingModel({ rules: 200, seed: 1, years: 1 });
    const long = snoopingModel({ rules: 200, seed: 1, years: 25 });
    expect(long.runningBest.at(-1)).toBeLessThan(
      short.runningBest.at(-1) as number
    );
  });

  it("time grows the rules tested on a log scale", () => {
    const values = { rules: 400, seed: 2, years: 5 };
    const start = scene("snooping", values, 0);
    const mid = scene("snooping", values, 0.5);
    const end = scene("snooping", values, 1);
    expect([start.now, mid.now, end.now]).toEqual([1, 20, 400]);
    expect(end.horizon).toBe(400);
    expect(mid.panels[0]?.series[0]?.revealTo).toBe(20);
    const dots = (d: SceneData) =>
      d.panels[1]?.markers.filter((m) => m.element === "points").length;
    expect([dots(start), dots(mid), dots(end)]).toEqual([1, 20, 300]);
    const marker = end.panels[0]?.markers.find((m) => m.element === "marker");
    expect(marker?.x).toBe(400);
  });

  it("handles a single rule", () => {
    expect(scene("snooping", { rules: 1 }, 1).now).toBe(1);
    expect(testingTables("snooping", { rules: 1 }, 0)[0]?.rows[6]?.[1]).toBe(
      "0.00"
    );
  });
});

describe("significance", () => {
  it("matches the lesson: SR 1 needs about 4 years for t = 2", () => {
    const model = significanceModel({ alpha: 0.05, sharpe: 1, years: 4 });
    expect(model.t).toBeCloseTo(2);
    expect(model.critical).toBeCloseTo(1.96, 2);
    expect(model.yearsNeeded).toBeCloseTo(3.84, 1);
    expect(pValue(1.5)).toBeCloseTo(0.1336, 3);
    expect(normInv(0.5)).toBeCloseTo(0);
  });

  it("reads alpha in percent, flags significance and handles zero Sharpe", () => {
    const row = (values: object, index: number) =>
      testingTables("significance", values as never, 1)[0]?.rows[index]?.[1];
    expect(row({ alpha: 5, sharpe: 2, years: 5 }, 4)).toBe("yes");
    expect(row({ sharpe: 0 }, 4)).toBe("no");
    expect(row({ sharpe: 0 }, 7)).toBe("∞");
    const s = scene("significance", { sharpe: -3, years: 1 });
    const band = s.panels[1]?.markers.find((m) => m.element === "pvalue");
    expect(band?.x).toBe(3);
  });

  it("time sweeps the years of data used", () => {
    const values = { alpha: 0.05, sharpe: 1, years: 8 };
    const at = (t: number) =>
      scene("significance", values, t).panels[0]?.markers.find(
        (m) => m.element === "marker"
      );
    expect(at(0.5)?.x).toBe(4);
    expect(at(1)?.x).toBe(8);
    expect(at(0)?.x).toBeCloseTo(0.05);
    const tail = (t: number) =>
      scene("significance", values, t).panels[1]?.markers[0]?.label;
    expect(tail(0.25)).not.toBe(tail(1));
    expect(testingTables("significance", values, 0.5)[0]?.rows[0]?.[1]).toBe(
      "4.00"
    );
  });
});
