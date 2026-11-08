import { describe, expect, it } from "vitest";
import type { SceneData } from "../scene-kit.ts";
import {
  ols,
  solveLinear,
  statisticsScene,
  statisticsTables,
} from "./statistics.ts";
import { STATISTICS_FORMULAS } from "./statistics-formulas.ts";
import {
  STATISTICS_ELEMENTS,
  STATISTICS_FORMULA_IDS,
  STATISTICS_MODELS,
} from "./statistics-ids.ts";

const drawn = (scene: SceneData): Set<string> =>
  new Set(
    scene.panels.flatMap((panel) => [
      ...panel.series.map((s) => s.element),
      ...panel.markers.map((m) => m.element),
      ...panel.bars.map((b) => b.element),
    ])
  );

const scene = (
  mode: "regression" | "factor",
  values: Record<string, number> = {},
  t = 1
) => statisticsScene(mode, { azimuth: 0, t, values });

describe("statistics contract", () => {
  it("draws every element id of each mode, with data", () => {
    const reg = scene("regression", { outlier: 20 });
    const fac = scene("factor");
    for (const [mode, s] of [
      ["regression", reg],
      ["factor", fac],
    ] as const) {
      const ids = drawn(s);
      for (const id of STATISTICS_ELEMENTS[mode])
        if (id !== "axes") expect(ids).toContain(id);
      for (const panel of s.panels) {
        expect(panel.xDomain[0]).toBeLessThan(panel.xDomain[1]);
        expect(panel.yDomain[0]).toBeLessThan(panel.yDomain[1]);
      }
    }
  });

  it("fills formulas and models without placeholders", () => {
    for (const id of STATISTICS_FORMULA_IDS) {
      const f = STATISTICS_FORMULAS[id];
      expect(f.id).toBe(id);
      expect(`${f.title}${f.text}${f.mathml}`).not.toMatch(/TODO/);
    }
    for (const line of Object.values(STATISTICS_MODELS))
      expect(line).not.toMatch(/TODO/);
  });
});

describe("regression mode", () => {
  it("recovers beta and alpha with low noise and is deterministic", () => {
    const values = {
      alphaPct: 6,
      beta: 1.5,
      months: 600,
      noise: 0.5,
      outlier: 0,
      seed: 3,
    };
    const tables = statisticsTables("regression", values, 1);
    expect(tables).toEqual(statisticsTables("regression", values, 1));
    const row = tables[0]?.rows;
    expect(Number(row?.[0]?.[2])).toBeCloseTo(1.5, 1);
    expect(Math.abs(Number(row?.[1]?.[2]) - 6)).toBeLessThan(1);
    expect(tables[0]?.note).not.toMatch(/outlier/);
  });

  it("an outlier moves the fit", () => {
    const base = scene("regression", { noise: 1, outlier: 0 });
    const hit = scene("regression", { noise: 1, outlier: 40 });
    const fit = (s: SceneData) =>
      s.panels[0]?.series.find((x) => x.element === "fit")?.points;
    expect(fit(hit)).not.toEqual(fit(base));
    expect(drawn(hit).has("outlier")).toBe(true);
    expect(base.panels[0]?.markers.some((m) => m.element === "outlier")).toBe(
      false
    );
    expect(statisticsTables("regression", { outlier: 40 }, 1)[0]?.note).toMatch(
      /outlier/
    );
  });

  it("factor models shrink the fund's alpha and raise R²", () => {
    const models = statisticsTables(
      "regression",
      {
        alphaPct: 0,
        momBeta: 0.8,
        months: 600,
        noise: 1,
        sizeBeta: 0.8,
        valueBeta: 0.8,
      },
      1
    )[1]?.rows as string[][];
    const [market, three, four] = models.map((r) => ({
      alpha: Number(r[1]),
      r2: Number.parseFloat(r[3] as string),
    })) as { alpha: number; r2: number }[] as [
      { alpha: number; r2: number },
      { alpha: number; r2: number },
      { alpha: number; r2: number },
    ];
    expect(market.alpha).toBeGreaterThan(four.alpha + 3);
    expect(Math.abs(four.alpha)).toBeLessThan(1);
    expect(four.r2).toBeGreaterThan(three.r2);
    expect(three.r2).toBeGreaterThan(market.r2);
  });

  it("reveals months with t and clamps inputs", () => {
    const early = scene("regression", { months: 1 }, 0);
    expect(early.now).toBe(3);
    expect(early.horizon).toBe(12);
    const bad = scene("regression", { months: Number.NaN, noise: -5 }, 0.5);
    expect(bad.horizon).toBe(60);
  });
});

describe("factor mode", () => {
  it("bucket bars follow the spread, negative allowed", () => {
    const bars = (spread: number, buckets: number) =>
      scene("factor", { buckets, spread, years: 80 }).panels[0]?.bars ?? [];
    const up = bars(10, 5);
    expect(nth(up, -1).y).toBeGreaterThan(nth(up, 0).y);
    const down = bars(-10, 10);
    expect(down).toHaveLength(10);
    expect(nth(down, -1).y).toBeLessThan(nth(down, 0).y);
    expect(scene("factor", { buckets: 10 }).panels[0]?.title).toMatch(/decile/);
    expect(scene("factor", { buckets: 5 }).panels[0]?.title).toMatch(
      /quintile/
    );
    expect(scene("factor", { buckets: 3 }).panels[0]?.title).toMatch(/bucket/);
  });

  it("marks the crash and publication and reveals by t", () => {
    const s = scene("factor", { crashPct: 40, crashYear: 10 }, 0.5);
    const panel = s.panels[1];
    const drop = panel?.markers.find((m) => m.kind === "dot");
    expect(drop?.label).toMatch(/-40/);
    expect(panel?.markers.some((m) => m.element === "publication")).toBe(true);
    expect(s.now).toBe(15);
    expect(panel?.series[0]?.revealTo).toBe(15);
    const quiet = scene("factor", { crashPct: 0, pubYear: 0 });
    expect(quiet.panels[1]?.markers).toHaveLength(0);
  });

  it("correlates b with a and reports stats; publication cuts the premium", () => {
    const corr = (rho: number) =>
      Number(
        /(-?[\d.]+)\.$/.exec(
          statisticsTables("factor", { crashPct: 0, rho, years: 100 }, 1)[1]
            ?.note as string
        )?.[1]
      );
    expect(corr(0.9)).toBeGreaterThan(0.8);
    expect(corr(-0.9)).toBeLessThan(-0.8);
    const ret = (decayPct: number) =>
      Number(
        statisticsTables(
          "factor",
          { crashPct: 0, decayPct, pubYear: 10, spread: 12, years: 100 },
          1
        )[1]?.rows[0]?.[1]
      );
    expect(ret(0)).toBeGreaterThan(ret(100) + 5);
    const flat = statisticsTables(
      "factor",
      { bVol: 0, crashPct: 0, factorVol: 0, pubYear: 0 },
      1
    );
    expect(flat[1]?.rows[0]?.[3]).toBe("0");
    expect(flat[1]?.note).toMatch(/: 0\./);
  });
});

describe("input hygiene", () => {
  it("clamps extreme params to the same results as the bounds", () => {
    expect(scene("regression", { beta: 1e9, noise: 1e9 })).toEqual(
      scene("regression", { beta: 5, noise: 50 })
    );
    expect(
      scene("factor", { crashPct: 1e9, factorVol: -5, spread: 1e9 })
    ).toEqual(scene("factor", { crashPct: 100, factorVol: 0, spread: 50 }));
    for (const data of [
      scene("regression", { alphaPct: 1e12, beta: Number.NaN }),
      scene("factor", { bSpread: 1e12, bVol: 1e12 }),
    ])
      for (const panel of data.panels)
        for (const d of [...panel.xDomain, ...panel.yDomain])
          expect(Number.isFinite(d)).toBe(true);
  });

  it("factor time scrubber is in years, not percent", () => {
    const data = scene("factor", { years: 30 }, 0.5);
    expect(data.timeLabel).toBe("Years");
    expect(data.timeUnit).not.toBe("pct");
    expect(data.now).toBeCloseTo(15);
    expect(data.horizon).toBe(30);
  });
});

describe("solvers", () => {
  it("solves linear systems with pivoting and singular columns", () => {
    expect(
      solveLinear(
        [
          [0, 1],
          [1, 0],
        ],
        [2, 3]
      )
    ).toEqual([3, 2]);
    expect(
      solveLinear(
        [
          [0, 0],
          [0, 1],
        ],
        [0, 4]
      )
    ).toEqual([0, 4]);
  });

  it("returns zero R² for constant y", () => {
    expect(ols([[1, 2, 3]], [5, 5, 5]).r2).toBe(0);
  });
});

const nth = <T>(values: readonly T[], index: number): T =>
  values.at(index) as T;
