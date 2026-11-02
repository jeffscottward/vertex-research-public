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

// Data migration 0033: the 50 QuantJourney example strategies (card vertex-quantsmd).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(
  "../../migrations/0033_strategy_catalog_quantjourney.sql"
);
const rollback = read(
  "../../rollback/0033_strategy_catalog_quantjourney.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json"));
const library = JSON.parse(
  read("../../../../research/backtests/quantjourney/library.json")
) as {
  strategies: {
    id: string;
    slug: string;
    section: string;
    dashboard: string;
    github: string;
    rerun: { status: string };
  }[];
};

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(external)', '(backtested|idea)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0033_strategy_catalog_quantjourney", () => {
  it("inserts one row per inventory entry that passes the repository field rules", () => {
    expect(rows).toHaveLength(50);
    expect(rows.map((row) => row[2])).toEqual(
      library.strategies.map((entry) => entry.slug)
    );
    for (const [
      ,
      id,
      slug,
      name,
      description,
      ,
      status,
      sourceRef,
      tags,
      section,
    ] of rows) {
      const entry = library.strategies.find((s) => s.slug === slug);
      expect(id).toBe(`strategy-seed-${slug}`);
      expect(normalizeStrategySlug(slug)).toBe(slug);
      expect(normalizeStrategyName(name?.replaceAll("''", "'"))).toBeTruthy();
      const text = description?.replaceAll("''", "'") ?? "";
      expect(normalizeStrategyDescription(text)).toBe(text);
      expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
      expect(normalizeStrategySection(section)).toBe(entry?.section);
      const parsed = JSON.parse(tags ?? "[]");
      expect(normalizeStrategyTags(parsed)).toEqual(parsed);
      expect(parsed).toContain("quantjourney");
      expect(text).toContain(`Dashboard: ${entry?.dashboard}`);
      expect(text).toContain(`GitHub: ${entry?.github}`);
      expect(text).toContain("Research only.");
      expect(status).toBe(
        entry?.rerun.status === "no-data" ? "idea" : "backtested"
      );
      expect(
        existsSync(new URL(`../../../../${sourceRef}`, import.meta.url))
      ).toBe(true);
    }
  });

  it("never overwrites an existing slug or promotes a row to paper", () => {
    expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
    return expect(migration).not.toMatch(/'paper'|'live_candidate'/);
  });

  it("is journaled as idx 33 after 0032", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) =>
        entry.tag === "0033_strategy_catalog_quantjourney"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 33 });
    return expect(journal.entries[index - 1]).toMatchObject({
      tag: "0032_strategy_catalog_carousel",
    });
  });

  it("rollback deletes only untouched catalog rows and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('"updated_at" <> s."created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP/i);
    for (const [, id] of rows) expect(rollback).toContain(`'${id}'`);
  });
});
