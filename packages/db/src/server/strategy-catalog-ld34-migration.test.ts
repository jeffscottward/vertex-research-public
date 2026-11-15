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

// Data migration 0059: the LD34 reel strategy (card vertex-reel-backtest-dffcosd). Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0059_strategy_catalog_ld34.sql");
const rollback = read("../../rollback/0059_strategy_catalog_ld34.down.sql");
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0059_strategy_catalog_ld34", () => {
  it("inserts one research-only row that passes the repository field rules", () => {
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
    ] = rows[0] ?? [];
    expect([id, slug, name, kind, status, sourceRef, section]).toEqual([
      "strategy-seed-ld34-nested-donchian-breakout",
      "ld34-nested-donchian-breakout",
      "LD34 nested Donchian long-only breakout (reel)",
      "python",
      "backtested",
      "docs/specs/strategies/ld34-nested-donchian-breakout.md",
      "Reel ideas",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    expect(normalizeStrategyDescription(description)).toBe(description);
    for (const term of [
      "20/50/100/200-day Donchian",
      "2x ATR(14)",
      "1% risk",
      "2x ATR trail from +1R",
      "breakeven at +2R",
      "call debit verticals sized at 2% max loss",
      "Research only",
    ])
      expect(description).toContain(term);
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(normalizeStrategySection(section)).toBe(section);
    const parsed = JSON.parse(tags ?? "[]");
    expect(normalizeStrategyTags(parsed)).toEqual(parsed);
    expect(parsed).toEqual([
      "research-only",
      "backtest-study",
      "reel-idea",
      "breakout",
      "trend-following",
      "long-only",
      "options",
      "defined-risk",
    ]);
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  return it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback).toContain("'strategy-seed-ld34-nested-donchian-breakout'");
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
