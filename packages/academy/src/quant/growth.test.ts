import { describe, expect, it } from "vitest";

import { QUANT_MODE_ELEMENTS } from "../schema.ts";
import { dragPaths, growthScene, growthTables, logPath } from "./growth.ts";
import { GROWTH_FORMULAS } from "./growth-formulas.ts";
import {
  GROWTH_ELEMENTS,
  GROWTH_FORMULA_IDS,
  GROWTH_MODELS,
} from "./growth-ids.ts";

const ctx = (values: Record<string, number>, t = 1) => ({
  azimuth: 0,
  t,
  values,
});

const elementsOf = (mode: keyof typeof GROWTH_ELEMENTS, t = 1) => {
  const scene = growthScene(mode, ctx({}, t));
  return new Set(
    scene.panels.flatMap((panel) => [
      ...panel.elements,
      ...panel.series.map((series) => series.element),
      ...panel.markers.map((marker) => marker.element),
    ])
  );
};

describe("growth contract", () => {
  it("draws exactly the declared elements of every mode", () => {
    for (const mode of Object.keys(
      GROWTH_ELEMENTS
    ) as (keyof typeof GROWTH_ELEMENTS)[]) {
      expect([...elementsOf(mode)].sort()).toEqual(
        [...GROWTH_ELEMENTS[mode]].sort()
      );
      expect(QUANT_MODE_ELEMENTS[mode]).toEqual(GROWTH_ELEMENTS[mode]);
      expect(GROWTH_MODELS[mode]).not.toBe("TODO");
      for (const table of growthTables(mode, {}, 0.5))
        for (const row of table.rows)
          expect(row).toHaveLength(table.columns.length);
    }
  });

  it("defines every formula", () => {
    for (const id of GROWTH_FORMULA_IDS) {
      expect(GROWTH_FORMULAS[id].id).toBe(id);
      expect(GROWTH_FORMULAS[id].mathml).toContain("<math");
      expect(GROWTH_FORMULAS[id].text).not.toBe("TODO");
      expect(GROWTH_FORMULAS[id].mathml).not.toContain("<mo> </mo>");
    }
    expect(GROWTH_FORMULAS.presentValue.mathml).toContain("<mtext>PV</mtext>");
  });
});

describe("compound", () => {
  it("matches the lesson numbers: $100 at 5% for 10 years", () => {
    const scene = growthScene(
      "compound",
      ctx({ amount: 100, rate: 5, years: 10 })
    );
    expect(scene.now).toBe(10);
    const [growth, rates] = scene.panels;
    expect(growth?.markers[0]?.y).toBeCloseTo(162.89, 2);
    expect(growth?.markers[1]?.y).toBeCloseTo(61.39, 2);
    expect(rates?.markers[0]?.x).toBe(5);
    const [years, byRate] = growthTables(
      "compound",
      { amount: 100, rate: 5, years: 10 },
      1
    );
    expect(years?.rows).toHaveLength(11);
    expect(byRate?.rows).toEqual([
      ["2.0%", "$82.03"],
      ["5.0%", "$61.39"],
      ["10.0%", "$38.55"],
    ]);
  });

  it("thins long horizons and widens the rate axis for high rates", () => {
    const scene = growthScene("compound", ctx({ rate: 30, years: 50 }, 0));
    expect(scene.now).toBe(0);
    expect(scene.panels[1]?.xDomain).toEqual([0, 60]);
    const [years] = growthTables("compound", { rate: 30, years: 50 }, 0);
    expect(years?.rows.length).toBeLessThanOrEqual(14);
    expect(years?.rows.at(-1)?.[0]).toBe("50");
  });
});

describe("logreturns", () => {
  it("log sum equals the actual change and simple sum does not", () => {
    const { prices, simple, log } = logPath({});
    expect(prices).toHaveLength(253);
    const end = Math.log((prices.at(-1) ?? 0) / 100) * 100;
    expect(log.at(-1)).toBeCloseTo(end, 8);
    expect(simple.at(-1)).not.toBeCloseTo(end, 1);
  });

  it("tabulates the down/up example", () => {
    const [example, path] = growthTables(
      "logreturns",
      { downPct: 50, upPct: 100 },
      1
    );
    expect(example?.rows[2]).toEqual(["Up 100%", "$100.00", "100.0%", "0.693"]);
    expect(example?.rows[3]?.[2]).toBe("50.0%");
    expect(example?.rows[3]?.[1]).toBe("Actual 0.0%");
    expect(path?.rows[2]?.[1]).toBe(path?.rows[3]?.[1]);
    const scene = growthScene("logreturns", ctx({ days: 10 }, 0.5));
    expect(scene.now).toBe(5);
  });
});

describe("drag", () => {
  it("growth rate is mu minus half the variance", () => {
    const scene = growthScene("drag", ctx({ mu: 10, vol: 50, years: 30 }, 0.5));
    expect(scene.now).toBe(15);
    expect(scene.panels[0]?.markers[1]?.y).toBeCloseTo(-2.5, 8);
    expect(scene.panels[0]?.xDomain).toEqual([0, 80]);
    const wide = growthScene("drag", ctx({ vol: 120 }));
    expect(wide.panels[0]?.xDomain).toEqual([0, 120]);
  });

  it("simulated median falls below the mean at high volatility", () => {
    const paths = dragPaths({ years: 5 });
    expect(paths[0]).toHaveLength(61);
    const [rule, wealth] = growthTables("drag", { mu: 10, vol: 50 }, 1);
    expect(rule?.rows.map((row) => row[3])).toEqual(["9.5%", "-2.5%"]);
    const mean = Number(wealth?.rows[1]?.[1]?.slice(1));
    const median = Number(wealth?.rows[3]?.[1]?.slice(1));
    expect(median).toBeLessThan(mean);
    expect(growthTables("drag", { vol: 30 }, 0)[0]?.rows).toHaveLength(3);
  });
});
