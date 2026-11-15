import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeStrategyExternalValidation,
  normalizeStrategyName,
  normalizeStrategySection,
  normalizeStrategySlug,
  normalizeStrategySourceRef,
  normalizeStrategyTags,
} from "./strategy-library.ts";

// Data migration 0073: the Trend Trio reconstruction from the Technical Trading reel (card vertex-trend-trio).
// Research only. The description and the outcome tag are set after the study, so they are not asserted here.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0073_strategy_catalog_trend_trio.sql");
const rollback = read(
  "../../rollback/0073_strategy_catalog_trend_trio.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '(\{(?:[^']|'')*\})'::jsonb, '(normal|high)', '((?:[^']|'')+)'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0073_strategy_catalog_trend_trio", () => {
  it("inserts one research-only reconstruction row that passes the repository field rules", () => {
    expect(rows).toHaveLength(1);
    const [
      ,
      id,
      slug,
      name,
      ,
      kind,
      status,
      sourceRef,
      tags,
      section,
      params,
      priority,
      external,
    ] = rows[0] ?? [];
    expect([id, slug, kind, status, sourceRef, section, priority]).toEqual([
      "strategy-seed-trend-trio",
      "trend-trio",
      "python",
      "backtested",
      "docs/specs/strategies/trend-trio.md",
      "Reel ideas",
      "normal",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    expect(name).toMatch(
      /^Trend Trio \(Vertex reconstruction, rules guessed\)/u
    );
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(normalizeStrategySection(section)).toBe(section);
    expect(typeof JSON.parse(params ?? "null")).toBe("object");
    const parsed = JSON.parse(tags ?? "[]");
    expect(normalizeStrategyTags(parsed)).toEqual(parsed);
    for (const tag of ["research-only", "backtest-study", "reconstruction"])
      expect(parsed).toContain(tag);
    expect(parsed).not.toContain("validated");
    const claim = JSON.parse(external?.replaceAll("''", "'") ?? "null");
    expect(normalizeStrategyExternalValidation(claim)).toEqual(claim);
    expect(claim.sourceUrl).toBe("https://www.instagram.com/reel/DfuMtdWKDB7/");
    expect(claim.claimedMetrics.length).toBeGreaterThan(0);
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled right after 0072", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0073_strategy_catalog_trend_trio"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 73 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 72,
      tag: "0072_market_notes",
    });
    return expect(journal.entries[index + 1]).toMatchObject({
      idx: 74,
      tag: "0074_semantic_terms_trend_indicators",
    });
  });

  return it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback).toContain("'strategy-seed-trend-trio'");
    expect(rollback.match(/'strategy-seed-[a-z0-9-]+'/gu)).toEqual([
      "'strategy-seed-trend-trio'",
      "'strategy-seed-trend-trio'",
    ]);
    for (const table of [
      "strategy_presets",
      "backtest_results",
      "backtest_runs",
      "optimization_runs",
      "strategy_specs",
      "deployment_requests",
      "autopilot_candidates",
    ]) {
      expect(rollback).toContain(`"public"."${table}"`);
    }
    return expect(rollback).toContain("refusing rollback");
  });
});
