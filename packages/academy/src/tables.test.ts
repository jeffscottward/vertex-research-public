import { describe, expect, it } from "vitest";

import { lessonBySlug } from "./lessons/index.ts";
import { defaultValues } from "./position.ts";
import type { DataTable } from "./scene-kit.ts";
import { buildTables } from "./tables.ts";

const moveRow = (
  tables: readonly DataTable[],
  id: string
): string | undefined =>
  tables
    .find((table) => table.id === id)
    ?.rows.find((row) => row[0]?.startsWith("Expected move"))?.[1];

describe("compare-scene risk tables", () => {
  it.each([
    "option-selling-adjustments-in-volatility",
    "long-delta-conviction-ladder",
  ])("gives each side of %s its own horizon", (slug) => {
    const lesson = lessonBySlug(slug);
    if (lesson === null) throw new Error(`missing ${slug}`);
    const tables = buildTables(lesson, defaultValues(lesson.params), 0.5);
    expect(moveRow(tables, "risk-a")).toBeDefined();
    expect(moveRow(tables, "risk-a")).not.toBe(moveRow(tables, "risk-b"));
  });
});

describe("GEX table note", () => {
  it("states the same dealer convention as the chart (calls +GEX, puts -GEX)", () => {
    const base = lessonBySlug("theta-is-the-price-of-gamma");
    if (base === null) throw new Error("fixture lesson missing");
    const lesson = {
      ...base,
      scene: { type: "gex" as const, view: "2d" as const },
    };
    const note = buildTables(lesson, defaultValues(lesson.params), 0.5).find(
      (table) => table.note?.includes("Open interest is modeled")
    )?.note;
    expect(note).toContain("dealers long calls (+GEX) and short puts (-GEX)");
  });
});
