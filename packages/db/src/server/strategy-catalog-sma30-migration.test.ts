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

// Data migration 0035: 30-day moving average market timing (card vertex-30dma-timing).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(
  "../../migrations/0035_strategy_catalog_sma30_timing.sql"
);
const rollback = read(
  "../../rollback/0035_strategy_catalog_sma30_timing.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json"));
const results = JSON.parse(
  read("../../../../research/backtests/sma30-timing/results.json")
);
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '(backtested)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0035_strategy_catalog_sma30_timing", () => {
  it("inserts 1 row that passes the repository field rules", () => {
    expect(rows).toHaveLength(1);
    const [, id, slug, name, description, , , sourceRef, tags, section] =
      rows[0] ?? [];
    expect(id).toBe("strategy-seed-sma30-market-timing");
    expect(slug).toBe("sma30-market-timing");
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

  it("states the recorded verdict and the reproduced creator figures", () => {
    const description = rows[0]?.[4] ?? "";
    expect(results.pass_fail.passed).toBe(false);
    expect(description).toContain("FAIL");
    const repro = results.ken_french.reproduction["lag1_close_t_to_t+1"];
    expect(repro.timing.trades).toBe(results.creator_claims.trades);
    expect(Math.round(repro.timing_final_usd / 1e4) / 100).toBe(339.87);
    expect(description).toContain("339.87 M");
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled as idx 35 after 0034", () => {
    const index = journal.entries.findIndex(
      (entry: { tag: string }) =>
        entry.tag === "0035_strategy_catalog_sma30_timing"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 35 });
    return expect(journal.entries[index - 1]).toMatchObject({
      tag: "0034_autopilot",
    });
  });

  it("rollback deletes only the untouched catalog row and never cascades", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('"updated_at" <> s."created_at"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DROP/i);
    return expect(rollback).toContain("'strategy-seed-sma30-market-timing'");
  });
});
