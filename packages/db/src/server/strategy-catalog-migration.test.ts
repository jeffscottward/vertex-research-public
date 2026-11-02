import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeStrategyDescription,
  normalizeStrategyName,
  normalizeStrategySection,
  normalizeStrategySlug,
  normalizeStrategySourceRef,
  normalizeStrategyTags,
} from "./strategy-library.ts";

// Data migration 0031: the research strategy catalog (card vertex-strategies-buildout).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0031_strategy_catalog.sql");
const rollback = read("../../rollback/0031_strategy_catalog.down.sql");
const journal = JSON.parse(read("../../migrations/meta/_journal.json"));
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python|external)', '(backtested|researching)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0031_strategy_catalog", () => {
  it("inserts 15 rows that pass the repository field rules", () => {
    expect(rows).toHaveLength(15);
    for (const [
      ,
      id,
      slug,
      name,
      description,
      ,
      ,
      sourceRef,
      tags,
      section,
    ] of rows) {
      expect(id).toBe(`strategy-seed-${slug}`);
      expect(normalizeStrategySlug(slug)).toBe(slug);
      expect(normalizeStrategyName(name?.replaceAll("''", "'"))).toBeTruthy();
      expect(normalizeStrategyDescription(description)).toBe(description);
      expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
      expect(normalizeStrategySection(section)).toBe(section);
      expect(normalizeStrategyTags(JSON.parse(tags ?? "[]"))).toEqual(
        JSON.parse(tags ?? "[]")
      );
      expect(repoFile(sourceRef ?? ""), slug).toBe(true);
      expect(repoFile(`docs/specs/strategies/${slug}.md`), slug).toBe(true);
    }
    expect(new Set(rows.map((row) => row[2])).size).toBe(15);
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled as idx 31 after 0030", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0031_strategy_catalog"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 31 });
    return expect(journal.entries[index - 1]).toMatchObject({
      tag: "0030_todos",
    });
  });

  it("rollback deletes only untouched catalog rows and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('"updated_at" <> s."created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP/i);
    for (const [, id] of rows) expect(rollback).toContain(`'${id}'`);
  });
});
