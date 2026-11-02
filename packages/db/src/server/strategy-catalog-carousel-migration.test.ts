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

// Data migration 0032: carousel strategies validated against published references
// (card vertex-ig-carousel-strategies).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0032_strategy_catalog_carousel.sql");
const rollback = read("../../rollback/0032_strategy_catalog_carousel.down.sql");
const journal = JSON.parse(read("../../migrations/meta/_journal.json"));
const validation = JSON.parse(
  read("../../../../research/backtests/carousel/validation.json")
);
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '(backtested)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0032_strategy_catalog_carousel", () => {
  it("inserts 4 rows that pass the repository field rules", () => {
    expect(rows).toHaveLength(4);
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
      const text = description?.replaceAll("''", "'");
      expect(normalizeStrategyDescription(text)).toBe(text);
      expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
      expect(normalizeStrategySection(section)).toBe(section);
      expect(normalizeStrategyTags(JSON.parse(tags ?? "[]"))).toEqual(
        JSON.parse(tags ?? "[]")
      );
      expect(repoFile(sourceRef ?? ""), slug).toBe(true);
      expect(repoFile(`docs/specs/strategies/${slug}.md`), slug).toBe(true);
    }
    expect(new Set(rows.map((row) => row[2])).size).toBe(4);
  });

  it("lists only strategies whose recorded validation passed", () => {
    const passed = new Map(
      validation.strategies.map(
        (entry: { slug: string; validated: boolean }) => [
          entry.slug,
          entry.validated,
        ]
      )
    );
    for (const [, , slug] of rows) expect(passed.get(slug), slug).toBe(true);
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled as idx 32 after 0031", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0032_strategy_catalog_carousel"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 32 });
    return expect(journal.entries[index - 1]).toMatchObject({
      tag: "0031_strategy_catalog",
    });
  });

  it("rollback deletes only untouched catalog rows and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('"updated_at" <> s."created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP/i);
    for (const [, id] of rows) expect(rollback).toContain(`'${id}'`);
  });
});
