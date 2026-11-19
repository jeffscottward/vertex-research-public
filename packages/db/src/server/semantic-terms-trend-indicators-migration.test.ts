import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Data migration 0074: agent vocabulary (source "none", not certified) for the five Trend Trio indicators.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(
  "../../migrations/0074_semantic_terms_trend_indicators.sql"
);
const rollback = read(
  "../../rollback/0074_semantic_terms_trend_indicators.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};

const TERM_IDS = [
  "supertrend",
  "ultimate_ma",
  "alphatrend",
  "chandelier_exit",
  "slingshot",
];

const ROW =
  /\('([a-z][a-z0-9_]{1,62})', '((?:[^']|'')+)', '((?:[^']|'')+)', '(\[[^\]]*\])'::jsonb, '([a-z]+)', null, '\[\]'::jsonb, '((?:[^']|'')+)', '\[\]'::jsonb, (true|false)\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0074_semantic_terms_trend_indicators", () => {
  it("seeds exactly the five uncertified terms with source none within the schema check", () => {
    expect(rows.map((row) => row[1])).toEqual(TERM_IDS);
    for (const [
      ,
      ,
      label,
      description,
      synonyms,
      source,
      unit,
      certified,
    ] of rows) {
      expect(source).toBe("none");
      expect(certified).toBe("false");
      const text = (value?: string) => value?.replaceAll("''", "'") ?? "";
      expect(text(label).length).toBeGreaterThanOrEqual(1);
      expect(text(label).length).toBeLessThanOrEqual(120);
      expect(text(unit).length).toBeGreaterThanOrEqual(1);
      expect(text(unit).length).toBeLessThanOrEqual(40);
      expect(text(description).length).toBeGreaterThanOrEqual(1);
      expect(text(description).length).toBeLessThanOrEqual(2000);
      expect(unit).toBe("price");
      // No two-letter synonyms ("ST", "AT", "CE"): short forms have other meanings in trading text.
      const names = JSON.parse(synonyms ?? "null") as unknown;
      expect(Array.isArray(names)).toBe(true);
      for (const name of names as unknown[]) {
        expect(typeof name).toBe("string");
        expect(String(name).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("never overwrites an existing term", () => {
    return expect(migration).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it("is journaled right after 0073", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0074_semantic_terms_trend_indicators"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 74 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 73,
      tag: "0073_strategy_catalog_trend_trio",
    });
  });

  return it("has a guarded rollback that refuses on operator work and deletes only these terms", () => {
    const ids = TERM_IDS.map((id) => `'${id}'`).join(", ");
    expect(rollback).toContain(`"id" IN (${ids})`);
    expect(rollback).toContain(`t."id" IN (${ids})`);
    expect(rollback).toContain('"public"."semantic_sql_attributes"');
    expect(rollback).toContain('t."updated_by" IS NOT NULL');
    expect(rollback).toContain('t."certified"');
    expect(rollback).toContain('t."certified_at" IS NOT NULL');
    expect(rollback).toContain('t."certified_by" IS NOT NULL');
    expect(rollback).toContain('t."certification_note" IS NOT NULL');
    expect(rollback).not.toMatch(/\bCASCADE\s*;/u);
    return expect(rollback).toContain("refusing rollback");
  });
});
