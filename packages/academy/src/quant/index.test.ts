import { describe, expect, it } from "vitest";

import { FORMULAS } from "../formulas.ts";
import { buildScene, DEFAULT_ELEMENT_COLORS } from "../scenes.ts";
import {
  FORMULA_IDS,
  type LessonSpecInput,
  LessonSpecSchema,
  QUANT_MODE_ELEMENTS,
  QUANT_MODES,
  type QuantMode,
  SCENE_ELEMENTS,
} from "../schema.ts";
import { buildTables } from "../tables.ts";
import { GROWTH_ELEMENTS } from "./growth-ids.ts";
import { QUANT_COLORS, quantModel, quantScene, quantTables } from "./index.ts";
import { OPTIONS_ELEMENTS } from "./options-ids.ts";
import { PORTFOLIO_ELEMENTS } from "./portfolio-ids.ts";
import { PROCESS_ELEMENTS } from "./process-ids.ts";
import { STATISTICS_ELEMENTS } from "./statistics-ids.ts";
import { TESTING_ELEMENTS } from "./testing-ids.ts";
import { TRADING_ELEMENTS } from "./trading-ids.ts";
import { VOLATILITY_ELEMENTS } from "./volatility-ids.ts";

const GROUP_ELEMENTS = [
  PROCESS_ELEMENTS,
  GROWTH_ELEMENTS,
  PORTFOLIO_ELEMENTS,
  STATISTICS_ELEMENTS,
  TESTING_ELEMENTS,
  VOLATILITY_ELEMENTS,
  TRADING_ELEMENTS,
  OPTIONS_ELEMENTS,
];

const finite = (value: number | undefined): boolean =>
  value === undefined || Number.isFinite(value);

describe("quant scene registry", () => {
  it("gives every mode to exactly one group, with axes first", () => {
    const modes = GROUP_ELEMENTS.flatMap((group) => Object.keys(group));
    expect(new Set(modes).size).toBe(modes.length);
    expect([...QUANT_MODES].sort()).toEqual([...modes].sort());
    for (const mode of QUANT_MODES) {
      expect(QUANT_MODE_ELEMENTS[mode][0], mode).toBe("axes");
      for (const element of QUANT_MODE_ELEMENTS[mode]) {
        expect(SCENE_ELEMENTS.quant).toContain(element);
        expect(element.length).toBeLessThanOrEqual(24);
      }
    }
  });

  it("names every formula once and renders each one", () => {
    expect(new Set(FORMULA_IDS).size).toBe(FORMULA_IDS.length);
    for (const id of FORMULA_IDS) {
      expect(FORMULAS[id].id).toBe(id);
      expect(FORMULAS[id].title.length).toBeGreaterThan(2);
      expect(FORMULAS[id].text).not.toMatch(/TODO/u);
      expect(FORMULAS[id].mathml.startsWith("<math")).toBe(true);
    }
  });

  it("keeps the option-scene colors and adds a color for every quant element", () => {
    expect(DEFAULT_ELEMENT_COLORS["axes"]).toBe("gray");
    expect(DEFAULT_ELEMENT_COLORS["bars"]).toBe("green");
    for (const element of SCENE_ELEMENTS.quant)
      expect(
        DEFAULT_ELEMENT_COLORS[element] ?? QUANT_COLORS[element],
        element
      ).toBeDefined();
  });

  it.each(QUANT_MODES.map((mode) => [mode] as const))(
    "builds mode %s from fallbacks: finite, every element drawn, a model line and tables",
    (mode: QuantMode) => {
      expect(quantModel(mode)).not.toMatch(/TODO/u);
      expect(quantModel(mode).length).toBeGreaterThan(10);
      for (const t of [0, 0.5, 1]) {
        const scene = quantScene(mode, { azimuth: 0.6, t, values: {} });
        expect(scene.panels.length).toBeGreaterThan(0);
        expect(
          Number.isFinite(scene.now) && Number.isFinite(scene.horizon)
        ).toBe(true);
        const drawn = new Set<string>();
        for (const panel of scene.panels) {
          expect(panel.xDomain.every(Number.isFinite), panel.id).toBe(true);
          expect(panel.yDomain.every(Number.isFinite), panel.id).toBe(true);
          for (const series of panel.series) {
            drawn.add(series.element);
            for (const [x, y] of series.points)
              expect(Number.isFinite(x) && Number.isFinite(y), panel.id).toBe(
                true
              );
          }
          for (const marker of panel.markers) {
            drawn.add(marker.element);
            expect(
              finite(marker.x) && finite(marker.y) && finite(marker.x2)
            ).toBe(true);
          }
          for (const bar of panel.bars) {
            drawn.add(bar.element);
            expect(Number.isFinite(bar.x) && Number.isFinite(bar.y)).toBe(true);
          }
          if (panel.surface !== undefined) {
            drawn.add(panel.surface.element);
            expect(panel.surface.z.flat().every(Number.isFinite)).toBe(true);
          }
          for (const element of [
            ...panel.series.map((series) => series.element),
            ...panel.markers.map((marker) => marker.element),
            ...panel.bars.map((bar) => bar.element),
          ])
            expect(panel.elements, `${mode} ${panel.id}`).toContain(element);
        }
        for (const element of QUANT_MODE_ELEMENTS[mode])
          if (element !== "axes")
            expect(drawn.has(element), `${mode} draws ${element}`).toBe(true);
      }
      const tables = quantTables(mode, {}, 0.5);
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables)
        for (const row of table.rows)
          expect(row.join(" ")).not.toMatch(/NaN|undefined/u);
    }
  );
});

describe("quant lessons through the shared builders", () => {
  const spec = (mode: QuantMode, element: string): LessonSpecInput => ({
    course: "quantfinancetogo",
    formulas: ["randomWalk"],
    kind: "concept",
    params: [{ default: 3, id: "seed", label: "Random path" }],
    scene: { mode, type: "quant" },
    slug: "quant-test",
    sourceId: "QftgReel01",
    steps: [
      { caption: "The axes of the chart.", color: "gray", element: "axes" },
      { caption: "The first drawing.", color: "gold", element },
      {
        caption: "The axes again, for reference.",
        color: "gray",
        element: "axes",
      },
    ],
    summary: "A test lesson for the quant scene registry.",
    tags: {
      instruments: [],
      regime: ["any"],
      risk: "none",
      timeframe: "years",
    },
    takeaways: ["One takeaway here.", "Another takeaway here."],
    title: "Quant test",
  });

  it("accepts a step element of the lesson's mode and refuses one of another mode", () => {
    const walk = QUANT_MODE_ELEMENTS.walk[1] as string;
    expect(LessonSpecSchema.safeParse(spec("walk", walk)).success).toBe(true);
    const result = LessonSpecSchema.safeParse(spec("walk", "nope"));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "element nope is not drawn by quant mode walk"
    );
  });

  it("builds the scene and the tables with the inputs and constants first", () => {
    const lesson = LessonSpecSchema.parse(spec("walk", "paths"));
    const scene = buildScene(lesson, { seed: 3 }, 0.5);
    expect(scene.panels.length).toBeGreaterThan(0);
    const tables = buildTables(lesson, { seed: 3 }, 0.5);
    expect(tables.map((table) => table.id).slice(0, 2)).toEqual([
      "inputs",
      "constants",
    ]);
    expect(tables[1]?.rows[0]).toEqual(["Model", quantModel("walk")]);
  });
});
