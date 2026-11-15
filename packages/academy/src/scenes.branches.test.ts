import { describe, expect, it } from "vitest";

import { lessonBySlug } from "./lessons/index.ts";
import { defaultValues, type ParamValues } from "./position.ts";
import type { DataTable } from "./scene-kit.ts";
import { buildScene, gammaFlip, gexProfile } from "./scenes.ts";
import type { LessonSpec, Scene } from "./schema.ts";
import { buildTables } from "./tables.ts";

const base = lessonBySlug("theta-is-the-price-of-gamma");
if (base === null) throw new Error("fixture lesson missing");

const withScene = (scene: Scene): Pick<LessonSpec, "params" | "scene"> => ({
  params: base.params,
  scene,
});
const defaults = defaultValues(base.params);
const row = (tables: readonly DataTable[], id: string, label: string) =>
  tables
    .find((table) => table.id === id)
    ?.rows.find((cells) => cells[0] === label)?.[1];

describe("stock-only positions (no expiry)", () => {
  const lesson = withScene({
    legs: [{ kind: "stock", qty: 1, side: "long" }],
    type: "payoff",
    view: "2d",
  });

  it("uses the lesson's days horizon for the chart and tables", () => {
    const scene = buildScene(lesson, defaults, 0.5);
    expect(scene.panels[0]?.xDomain.every(Number.isFinite)).toBe(true);
    const tables = buildTables(lesson, defaults, 0.5);
    const timeline = tables.find((table) => table.id === "timeline");
    expect(timeline?.rows.at(-1)?.[0]).toBe("30");
  });

  it("falls back to each param default when a value is missing", () => {
    const tables = buildTables(lesson, {}, 0);
    const inputs = tables.find((table) => table.id === "inputs");
    expect(inputs?.rows.map((cells) => cells[1])).toEqual(
      base.params.map((param) => String(param.default))
    );
  });
});

describe("GEX scene", () => {
  const gex2d = withScene({ type: "gex", view: "2d" });
  const gex3d = withScene({ type: "gex", view: "3d" });

  it.each([
    [300, 5],
    [100, 1],
    [20, 0.5],
  ])("spaces strikes by spot %d at %d", (spot, step) => {
    const rows = gexProfile({ spot }, 0);
    expect(rows.length).toBeGreaterThan(1);
    expect((rows[1]?.strike ?? 0) - (rows[0]?.strike ?? 0)).toBeCloseTo(step);
  });

  it("draws a unit-width bar when only one strike fits the range", () => {
    const values: ParamValues = { callWall: 1, putWall: 1, spot: 1 };
    expect(gexProfile(values, 0)).toHaveLength(1);
    const scene = buildScene(gex2d, values, 0.5);
    expect(scene.panels[0]?.bars?.[0]?.width).toBe(1);
  });

  it("omits the flip marker when net gamma never changes sign", () => {
    const values: ParamValues = { ...defaults, callWall: 100, putWall: 100 };
    expect(gammaFlip(values, 0)).toBeNull();
    const scene = buildScene(gex2d, values, 0.2);
    expect(
      scene.panels[0]?.markers?.some((marker) => marker.element === "flip")
    ).toBe(false);
    const tables = buildTables(gex2d, values, 0.2);
    expect(row(tables, "gex-summary", "Gamma flip level")).toBe(
      "None in range"
    );
  });

  it("reports a negative-gamma regime when puts dominate", () => {
    const values: ParamValues = {
      ...defaults,
      callWall: 1000,
      putWall: 100,
      spot: 100,
    };
    const tables = buildTables(gex2d, values, 0);
    expect(row(tables, "gex-summary", "Regime")).toMatch(/^Negative gamma/u);
  });

  it("adds a strike-by-time surface in 3D", () => {
    const scene = buildScene(gex3d, defaults, 0.5);
    expect(scene.layout).toBe("grid");
    const surface = scene.panels[1]?.surface;
    expect(surface?.z).toHaveLength(12);
    expect(surface?.z[0]).toHaveLength(surface?.xs.length ?? -1);
  });
});

describe("IV/RV tables", () => {
  it("reports IV/RV as 0 when realized vol is zero", () => {
    const lesson = withScene({ type: "ivrv" });
    const tables = buildTables(
      lesson,
      {
        drift: 0,
        rvBase: 0,
        volOfVol: 0,
      },
      0.5
    );
    expect(row(tables, "ivrv", "IV / RV")).toBe("0.00");
  });
});

describe("option scenes without legs", () => {
  it("returns only the inputs and constants tables", () => {
    const lesson = withScene({ legs: [], type: "payoff", view: "2d" });
    const tables = buildTables(lesson, defaults, 0.5);
    expect(tables.map((table) => table.id)).toEqual(["inputs", "constants"]);
  });
});

describe("number formatting", () => {
  it("prints a non-finite value as ∞", () => {
    const lesson = withScene({ type: "ivrv" });
    const tables = buildTables(lesson, { spot: Number.MAX_VALUE }, 0.5);
    expect(row(tables, "ivrv", "30-day move priced by IV")).toBe("±∞");
  });
});

describe("distribution without legs", () => {
  it("adds the expected-move table", () => {
    const lesson = withScene({ legs: [], type: "distribution" });
    const tables = buildTables(lesson, defaults, 0.5);
    expect(tables.map((table) => table.id)).toContain("expected-move");
  });
});
