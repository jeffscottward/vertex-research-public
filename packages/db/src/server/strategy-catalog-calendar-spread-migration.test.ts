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

// Data migration 0055: long calendar spread (card vertex-calendar-spread).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(
  "../../migrations/0055_strategy_catalog_calendar_spread.sql"
);
const rollback = read(
  "../../rollback/0055_strategy_catalog_calendar_spread.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json"));
const results = read(
  "../../../../research/backtests/calendar-spread/results.md"
);
const spec = read("../../../../docs/specs/strategies/long-calendar-spread.md");
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(native)', '(backtested)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0055_strategy_catalog_calendar_spread", () => {
  it("inserts 1 row that passes the repository field rules", () => {
    expect(rows).toHaveLength(1);
    const [, id, slug, name, description, , , sourceRef, tags, section] =
      rows[0] ?? [];
    expect(id).toBe("strategy-seed-long-calendar-spread");
    expect(slug).toBe("long-calendar-spread");
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name?.replaceAll("''", "'"))).toBeTruthy();
    const text = description?.replaceAll("''", "'");
    expect(normalizeStrategyDescription(text)).toBe(text);
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(normalizeStrategySection(section)).toBe(section);
    expect(normalizeStrategyTags(JSON.parse(tags ?? "[]"))).toEqual(
      JSON.parse(tags ?? "[]")
    );
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(repoFile(`docs/specs/strategies/${slug}.md`)).toBe(true);
  });

  it("states the verdict recorded in the results and the spec", () => {
    const description = rows[0]?.[4] ?? "";
    expect(results).toContain("## Verdict: FAIL");
    expect(spec).toContain("## Verdict: FAIL (modeled)");
    expect(spec).toContain(
      "## Pass/fail rule (fixed 2026-11-08, before the first run)"
    );
    expect(description).toContain("FAIL");
    expect(description).toContain("MODELED");
    expect(rows[0]?.[8]).toContain('"failed"');
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled as idx 55 after 0054", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) =>
        entry.tag === "0055_strategy_catalog_calendar_spread"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 55 });
    return expect(journal.entries[index - 1]).toMatchObject({
      tag: "0054_agent_model_run_grants",
    });
  });

  it("rollback deletes only the untouched catalog row and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('"updated_at" <> s."created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP/i);
    return expect(rollback).toContain("'strategy-seed-long-calendar-spread'");
  });
});
