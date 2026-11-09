import { describe, expect, it } from "vitest";

import { buildScene, buildTables } from "../index.ts";
import type { ParamValues } from "../position.ts";
import type { DataTable, Panel, SceneData } from "../scene-kit.ts";
import { volatilityScene, volatilityTables } from "./volatility.ts";
import { VOLATILITY_FORMULAS } from "./volatility-formulas.ts";
import {
  VOLATILITY_COLORS,
  VOLATILITY_ELEMENTS,
  VOLATILITY_FORMULA_IDS,
  VOLATILITY_MODELS,
  type VolatilityMode,
} from "./volatility-ids.ts";

const MODES = Object.keys(VOLATILITY_ELEMENTS) as VolatilityMode[];

/** Every param id any volatility mode reads. */
const PARAM_IDS = [
  "dailyVol",
  "dof",
  "confidence",
  "days",
  "position",
  "seed",
  "longRunVol",
  "alpha",
  "beta",
  "gamma",
  "shockDay",
  "shockPct",
  "targetVol",
  "maxLeverage",
  "drift",
  "processNoise",
  "measurementNoise",
  "threshold",
];

const scene = (mode: VolatilityMode, values: ParamValues = {}, t = 1) =>
  volatilityScene(mode, { azimuth: 0, t, values });
const tables = (mode: VolatilityMode, values: ParamValues = {}, t = 1) =>
  volatilityTables(mode, values, t);
const panel = (data: SceneData, id: string): Panel => {
  const found = data.panels.find((item) => item.id === id);
  if (found === undefined) throw new Error(`panel ${id} missing`);
  return found;
};
const cell = (data: readonly DataTable[], id: string, row: number, col = 1) =>
  data.find((table) => table.id === id)?.rows[row]?.[col] ?? "";
const numberIn = (text: string): number =>
  Number(/-?[\d,]*\.?\d+(e[-+]?\d+)?/u.exec(text)?.[0].replaceAll(",", ""));
/** y of the point at an index (negative counts from the end). */
const nthY = (points: readonly (readonly [number, number])[], index: number) =>
  points.at(index)?.[1] ?? Number.NaN;
const series = (data: SceneData, panelId: string, element: string) =>
  panel(data, panelId).series.filter((item) => item.element === element);

const expectFinite = (data: SceneData): void => {
  expect(Number.isFinite(data.horizon)).toBe(true);
  expect(Number.isFinite(data.now)).toBe(true);
  for (const item of data.panels) {
    for (const value of [...item.xDomain, ...item.yDomain])
      expect(Number.isFinite(value)).toBe(true);
    expect(item.yDomain[1]).toBeGreaterThan(item.yDomain[0]);
    for (const line of item.series) {
      expect(line.points.length).toBeLessThanOrEqual(3000);
      for (const [x, y] of line.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
    for (const marker of item.markers)
      for (const value of [marker.x, marker.y, marker.x2])
        if (value !== undefined) expect(Number.isFinite(value)).toBe(true);
    expect(
      item.markers.filter((marker) => marker.kind === "dot").length
    ).toBeLessThanOrEqual(400);
    for (const bar of item.bars)
      for (const value of [bar.x, bar.y, bar.width])
        expect(Number.isFinite(value)).toBe(true);
  }
};

const expectCleanTables = (data: readonly DataTable[]): void => {
  expect(data.length).toBeGreaterThan(0);
  for (const table of data) {
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(row.length).toBe(table.columns.length);
      for (const text of row) {
        expect(text).not.toMatch(/NaN|undefined|Infinity/u);
        expect(text.length).toBeGreaterThan(0);
      }
    }
    expect(table.note ?? "").not.toMatch(/NaN|undefined|Infinity/u);
  }
};

describe("volatility contract", () => {
  it("keeps axes first, a model note per mode and colors for every new id", () => {
    for (const mode of MODES) {
      expect(VOLATILITY_ELEMENTS[mode][0]).toBe("axes");
      expect(VOLATILITY_MODELS[mode].length).toBeGreaterThan(40);
      for (const element of VOLATILITY_ELEMENTS[mode].slice(1))
        if (element !== "bars")
          expect(VOLATILITY_COLORS[element]).toBeDefined();
    }
  });

  it("has a formula with title, text and MathML for every id", () => {
    for (const id of VOLATILITY_FORMULA_IDS) {
      const formula = VOLATILITY_FORMULAS[id];
      expect(formula.id).toBe(id);
      expect(formula.title.length).toBeGreaterThan(3);
      expect(formula.text.length).toBeGreaterThan(10);
      expect(formula.text).not.toMatch(/TODO/u);
      expect(formula.mathml.startsWith("<math")).toBe(true);
    }
    expect(Object.keys(VOLATILITY_FORMULAS).sort()).toEqual(
      [...VOLATILITY_FORMULA_IDS].sort()
    );
  });
});

describe.each(MODES)("mode %s", (mode) => {
  it("draws finite data at t = 0, 0.5 and 1 with clean tables", () => {
    for (const t of [0, 0.5, 1]) {
      expectFinite(scene(mode, {}, t));
      expectCleanTables(tables(mode, {}, t));
    }
  });

  it("draws every element of the mode in a panel that lists it", () => {
    const data = scene(mode);
    expect(data.panels[0]?.elements[0]).toBe("axes");
    for (const element of VOLATILITY_ELEMENTS[mode].slice(1)) {
      const drawn = data.panels.some(
        (item) =>
          item.elements.includes(element) &&
          (item.series.some((line) => line.element === element) ||
            item.markers.some((marker) => marker.element === element) ||
            item.bars.some((bar) => bar.element === element))
      );
      expect(drawn, element).toBe(true);
    }
    for (const item of data.panels) {
      const used = [
        ...item.series.map((line) => line.element),
        ...item.markers.map((marker) => marker.element),
        ...item.bars.map((bar) => bar.element),
      ];
      for (const element of used) expect(item.elements).toContain(element);
    }
  });

  it("is deterministic per seed and changes with the seed", () => {
    expect(scene(mode, { seed: 11 })).toEqual(scene(mode, { seed: 11 }));
    expect(tables(mode, { seed: 11 })).toEqual(tables(mode, { seed: 11 }));
    expect(JSON.stringify(scene(mode, { seed: 11 }))).not.toBe(
      JSON.stringify(scene(mode, { seed: 12 }))
    );
  });

  it("moves the scrubber with t and treats a non-finite t as the end", () => {
    const start = scene(mode, {}, 0);
    const end = scene(mode, {}, 1);
    expect(start.now).toBe(1);
    expect(end.now).toBe(end.horizon);
    expect(scene(mode, {}, Number.NaN).now).toBe(end.horizon);
    expect(scene(mode, {}, 5).now).toBe(end.horizon);
  });

  it.each([
    ["huge", 1e12],
    ["negative", -1e6],
    ["zero", 0],
    ["text", "abc"],
    ["numeric text", "3"],
  ])("stays finite with %s inputs", (_name, value) => {
    const values = Object.fromEntries(PARAM_IDS.map((id) => [id, value]));
    for (const t of [0, 0.5, 1]) {
      expectFinite(scene(mode, values, t));
      expectCleanTables(tables(mode, values, t));
    }
  });

  it("runs through buildScene and buildTables", () => {
    const lesson = {
      params: [{ default: 7, id: "seed", kind: "number", label: "Seed" }],
      scene: { mode, type: "quant" },
    } as never;
    expectFinite(buildScene(lesson, { seed: 7 }, 0.5));
    const all = buildTables(lesson, { seed: 7 }, 0.5);
    expect(all.map((table) => table.id)).toEqual(
      expect.arrayContaining(["inputs", "constants"])
    );
    for (const table of all)
      for (const row of table.rows)
        for (const text of row) expect(text).not.toMatch(/NaN|undefined/u);
    expect(all.length).toBeGreaterThan(2);
  });
});

describe("tail", () => {
  it("puts fat-tailed VaR and ES beyond the bell curve at the same vol", () => {
    const data = tables("tail");
    const normalVar = numberIn(cell(data, "var-es", 0, 1));
    const fatVar = numberIn(cell(data, "var-es", 0, 2));
    const normalEs = numberIn(cell(data, "var-es", 2, 1));
    const fatEs = numberIn(cell(data, "var-es", 2, 2));
    expect(normalVar).toBeCloseTo(2.33, 2);
    expect(normalEs).toBeCloseTo(2.67, 2);
    expect(fatVar).toBeGreaterThan(normalVar);
    expect(fatEs).toBeGreaterThan(normalEs);
    expect(numberIn(cell(data, "var-es", 1, 1))).toBe(2326);
    const simulatedVar = numberIn(cell(data, "var-es", 0, 3));
    expect(Math.abs(simulatedVar - fatVar)).toBeLessThan(0.3);
  });

  it("counts many more 5-sigma days than the bell curve expects", () => {
    const data = tables("tail");
    expect(numberIn(cell(data, "tail-counts", 0, 1))).toBeLessThan(0.1);
    expect(numberIn(cell(data, "tail-counts", 0, 3))).toBeGreaterThan(40);
    expect(numberIn(cell(data, "tail-counts", 1, 1))).toBe(252);
    expect(numberIn(cell(data, "tail-counts", 1, 3))).toBeGreaterThan(252);
  });

  it("widens with daily vol and thins the tails with more degrees of freedom", () => {
    const narrow = panel(scene("tail", { dailyVol: 1 }), "histogram");
    const wide = panel(scene("tail", { dailyVol: 2 }), "histogram");
    expect(wide.xDomain[1]).toBeCloseTo(2 * narrow.xDomain[1]);
    const fatCount = numberIn(
      cell(tables("tail", { dof: 3 }), "tail-counts", 0, 2)
    );
    const thinCount = numberIn(
      cell(tables("tail", { dof: 30 }), "tail-counts", 0, 2)
    );
    expect(thinCount).toBeLessThan(fatCount);
  });

  it("moves VaR deeper with a higher confidence and scales dollars with the position", () => {
    const low = numberIn(
      cell(tables("tail", { confidence: 95 }), "var-es", 0, 1)
    );
    const high = numberIn(
      cell(tables("tail", { confidence: 99.9 }), "var-es", 0, 1)
    );
    expect(high).toBeGreaterThan(low);
    const small = numberIn(
      cell(tables("tail", { position: 1000 }), "var-es", 1, 2)
    );
    const big = numberIn(
      cell(tables("tail", { position: 100_000 }), "var-es", 1, 2)
    );
    expect(big).toBeCloseTo(100 * small, -2);
  });

  it("shows a gain as a negative VaR on a one-day sample", () => {
    const signs = [1, 2, 3, 4, 5, 6].map((seed) =>
      cell(tables("tail", { seed }, 0), "var-es", 1, 3).startsWith("-")
    );
    expect(signs).toContain(true);
    expect(signs).toContain(false);
  });
});

describe("volcluster", () => {
  it("reproduces the GARCH numbers of the reel (1% a day, 4% drop)", () => {
    const data = tables("volcluster", { longRunVol: 15.874_507_866 });
    expect(cell(data, "news-impact", 1, 1)).toMatch(/^1\.58% a day/u);
    expect(cell(data, "news-impact", 1, 2)).toMatch(/^1\.58% a day/u);
    expect(cell(data, "decay", 1, 1)).toMatch(/^1\.49% a day/u);
    expect(cell(data, "decay", 2, 1)).toMatch(/^1\.39% a day/u);
    expect(cell(data, "decay", 3, 1)).toMatch(/^1\.16% a day/u);
    expect(data.find((table) => table.id === "decay")?.note).toMatch(/13\.5/u);
    const ratio = numberIn(cell(data, "clustering", 2, 1));
    expect(ratio).toBeGreaterThan(3);
  });

  it("reproduces the GJR numbers of the reel (drop 1.78%, rise 1.11%)", () => {
    const data = tables("volcluster", {
      alpha: 0.02,
      beta: 0.9,
      gamma: 0.12,
      longRunVol: 15.874_507_866,
    });
    expect(cell(data, "news-impact", 0, 2)).toMatch(/^1\.11% a day/u);
    expect(cell(data, "news-impact", 1, 2)).toMatch(/^1\.78% a day/u);
    const news = scene("volcluster", { gamma: 0.12 });
    const garch = series(news, "news-impact", "garch")[0]?.points ?? [];
    const gjr = series(news, "news-impact", "gjr")[0]?.points ?? [];
    expect(nthY(gjr, 0)).toBeGreaterThan(nthY(garch, 0));
    expect(nthY(gjr, -1)).toBeLessThan(nthY(garch, -1));
  });

  it("puts the news-impact shock marker at the shock size, inside the move axis", () => {
    for (const shockPct of [-4, 6, -12]) {
      const news = panel(scene("volcluster", { shockPct }), "news-impact");
      const [low, high] = news.xDomain;
      expect(news.markers).toHaveLength(1);
      for (const marker of news.markers) {
        expect(marker.x).toBe(shockPct);
        expect(marker.x ?? Number.NaN).toBeGreaterThanOrEqual(low);
        expect(marker.x ?? Number.NaN).toBeLessThanOrEqual(high);
      }
    }
  });

  it("caps alpha + beta + gamma/2 below 1 and says so", () => {
    const data = tables("volcluster", { alpha: 0.3, beta: 0.9, gamma: 0.2 });
    const note = data.find((table) => table.id === "news-impact")?.note ?? "";
    expect(note).toMatch(/lowered/u);
    const decay = data.find((table) => table.id === "decay")?.note ?? "";
    expect(numberIn(decay.split("=")[1] ?? "")).toBeLessThan(1);
    expect(tables("volcluster")[0]?.note).not.toMatch(/lowered/u);
  });

  it("lifts volatility right after the shock day and labels its sign", () => {
    const quiet = { shockDay: 300, shockPct: -15 };
    const data = scene("volcluster", quiet);
    const vol = series(data, "vol", "gjr")[0]?.points ?? [];
    expect(nthY(vol, 301)).toBeGreaterThan(nthY(vol, 300) * 1.5);
    expect(panel(data, "returns").markers[0]?.label).toMatch(/-15\.0%/u);
    expect(
      panel(scene("volcluster", { shockPct: 6 }), "returns").markers[0]?.label
    ).toMatch(/\+6\.0%/u);
    const wide = panel(scene("volcluster", { longRunVol: 40 }), "vol");
    const calm = panel(scene("volcluster", { longRunVol: 10 }), "vol");
    expect(wide.yDomain[1]).toBeGreaterThan(calm.yDomain[1]);
  });

  it("reveals returns up to the scrubber day", () => {
    const half = scene("volcluster", { days: 400 }, 0.5);
    expect(half.now).toBe(200);
    expect(panel(half, "returns").bars).toHaveLength(200);
    expect(series(half, "returns", "band")[0]?.revealTo).toBe(200);
  });
});

describe("voltarget", () => {
  it("cuts exposure to target / forecast and caps it", () => {
    const data = scene("voltarget", { maxLeverage: 1.5, targetVol: 10 });
    const forecast = series(data, "forecast", "forecast")[0]?.points ?? [];
    const exposure = series(data, "exposure", "exposure")[0]?.points ?? [];
    for (const [index, [, vol]] of forecast.entries())
      expect(nthY(exposure, index)).toBeCloseTo(Math.min(1000 / vol, 150), 6);
    expect(Math.max(...exposure.map((point) => point[1]))).toBeLessThanOrEqual(
      150
    );
  });

  it("brings realized vol near the target and lowers it vs buy and hold", () => {
    const data = tables("voltarget");
    const hold = numberIn(cell(data, "vol-target", 0, 1));
    const targeted = numberIn(cell(data, "vol-target", 0, 2));
    expect(targeted).toBeLessThan(hold);
    expect(Math.abs(targeted - 10)).toBeLessThan(2);
    const higher = numberIn(
      cell(tables("voltarget", { targetVol: 20 }), "vol-target", 0, 2)
    );
    expect(higher).toBeGreaterThan(targeted);
  });

  it("raises the forecast with a higher long-run vol", () => {
    const calm = panel(scene("voltarget", { longRunVol: 10 }), "forecast");
    const wild = panel(scene("voltarget", { longRunVol: 40 }), "forecast");
    expect(wild.yDomain[1]).toBeGreaterThan(calm.yDomain[1]);
  });

  it("keeps a wiped-out account at zero instead of going negative", () => {
    const data = scene("voltarget", {
      alpha: 0.5,
      beta: 0.49,
      days: 2520,
      drift: -50,
      longRunVol: 150,
      maxLeverage: 10,
      targetVol: 100,
    });
    const equity = series(data, "equity", "targeted")[0]?.points ?? [];
    expect(Math.min(...equity.map((point) => point[1]))).toBeGreaterThanOrEqual(
      0
    );
  });
});

describe("filter", () => {
  it("tracks the truth better than the raw observations", () => {
    const data = tables("filter");
    const observed = numberIn(cell(data, "kalman", 2));
    const filtered = numberIn(cell(data, "kalman", 3));
    expect(filtered).toBeLessThan(observed);
    expect(cell(data, "kalman", 0)).toBe(cell(data, "kalman", 1));
  });

  it("starts with a high gain that settles, lower when observations are noisier", () => {
    const gain = series(scene("filter"), "gain", "gain")[0]?.points ?? [];
    expect(nthY(gain, 0)).toBeGreaterThan(nthY(gain, -1));
    const noisy = numberIn(
      cell(tables("filter", { measurementNoise: 8 }), "kalman", 1)
    );
    const clean = numberIn(
      cell(tables("filter", { measurementNoise: 0.5 }), "kalman", 1)
    );
    expect(noisy).toBeLessThan(clean);
  });

  it("fires fewer fades with a higher threshold", () => {
    const loose = panel(scene("filter", { threshold: 1 }), "prices");
    const strict = panel(scene("filter", { threshold: 3 }), "prices");
    const fades = (item: Panel) =>
      item.markers.filter((marker) => marker.element === "fades").length;
    expect(fades(loose)).toBeGreaterThan(fades(strict));
  });

  it("draws observations as dots up to 250 days and as a thin line beyond", () => {
    const short = panel(scene("filter", { days: 250 }), "prices");
    expect(short.markers.some((marker) => marker.element === "observed")).toBe(
      true
    );
    const long = panel(
      scene("filter", { days: 1000, threshold: 0.1 }),
      "prices"
    );
    expect(long.series.some((line) => line.element === "observed")).toBe(true);
    expect(long.markers.some((marker) => marker.element === "observed")).toBe(
      false
    );
    expect(long.markers.length).toBe(400);
  });

  it("has no reversion average before any fade can be followed", () => {
    expect(cell(tables("filter", {}, 0), "kalman", 5)).toBe("n/a");
  });
});
