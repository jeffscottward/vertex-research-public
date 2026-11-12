import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeStrategyDescription,
  normalizeStrategyExternalValidation,
  normalizeStrategyName,
  normalizeStrategySection,
  normalizeStrategySlug,
  normalizeStrategySourceRef,
  normalizeStrategyTags,
} from "./strategy-library.ts";

// Data migration 0068: the Triple RSI strategy from QuantifiedStrategies (card vertex-triple-rsi), tested and
// failed in the Vertex options form. Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0068_strategy_catalog_triple_rsi.sql");
const rollback = read(
  "../../rollback/0068_strategy_catalog_triple_rsi.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb, '(normal|high)', '((?:[^']|'')+)'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0068_strategy_catalog_triple_rsi", () => {
  it("inserts one research-only row, tagged failed, that passes the repository field rules", () => {
    expect(rows).toHaveLength(1);
    const [
      ,
      id,
      slug,
      name,
      description,
      kind,
      status,
      sourceRef,
      tags,
      section,
      priority,
      external,
    ] = rows[0] ?? [];
    expect([id, slug, kind, status, sourceRef, section, priority]).toEqual([
      "strategy-seed-triple-rsi",
      "triple-rsi",
      "python",
      "backtested",
      "docs/specs/strategies/triple-rsi.md",
      "Entry timing",
      "normal",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    const text = description?.replaceAll("''", "'");
    expect(normalizeStrategyDescription(text)).toBe(text);
    for (const term of [
      "5-day RSI is below 30",
      "fallen three days in a row",
      "200-day average",
      "crosses above 50",
      "That is the source's claim",
      "TESTED, FAILED",
      "90.0% on 90 trades",
      "fails the strict gate and the lower bar",
      "Research only",
    ])
      expect(text).toContain(term);
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(normalizeStrategySection(section)).toBe(section);
    const parsed = JSON.parse(tags ?? "[]");
    expect(normalizeStrategyTags(parsed)).toEqual(parsed);
    expect(parsed).toContain("research-only");
    expect(parsed).toContain("failed");
    expect(parsed).toContain("externally-pre-validated");
    expect(parsed).not.toContain("validated");
    const claim = JSON.parse(external?.replaceAll("''", "'") ?? "null");
    expect(normalizeStrategyExternalValidation(claim)).toEqual(claim);
    expect(claim.sourceUrl).toBe(
      "https://www.quantifiedstrategies.com/triple-rsi-trading-strategy/"
    );
  });

  it("is journaled right after 0067_golive_drafts", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0068_strategy_catalog_triple_rsi"
    );
    expect(index).toBeGreaterThan(0);
    return expect(journal.entries[index - 1]?.tag).toBe("0067_golive_drafts");
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  return it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback).toContain("'strategy-seed-triple-rsi'");
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
