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

// Data migration 0062: the market intraday momentum reel strategy (card vertex-reel-backtest-dffkn31). Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(
  "../../migrations/0062_strategy_catalog_market_intraday_momentum.sql"
);
const rollback = read(
  "../../rollback/0062_strategy_catalog_market_intraday_momentum.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0062_strategy_catalog_market_intraday_momentum", () => {
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
      "strategy-seed-market-intraday-momentum",
      "market-intraday-momentum",
      "Market intraday momentum: GHLZ, ZAB and bias tracker (reel)",
      "python",
      "backtested",
      "docs/specs/strategies/market-intraday-momentum.md",
      "Reel ideas",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    expect(normalizeStrategyDescription(description)).toBe(description);
    for (const term of [
      "flat at the 16:00 close",
      "at 15:30 New York go long",
      "14-day noise band",
      "VWAP",
      "8-factor bias score",
      "same-day debit verticals on the ETF twin sized at 2% max loss",
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
      "intraday",
      "momentum",
      "long-short",
      "options",
      "defined-risk",
    ]);
  });

  it("is journaled after the LD34 catalog row", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0062_strategy_catalog_market_intraday_momentum"
    );
    expect(index).toBeGreaterThan(0);
    return expect(journal.entries[index - 1]?.tag).toBe(
      "0059_strategy_catalog_ld34"
    );
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  return it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback).toContain("'strategy-seed-market-intraday-momentum'");
    expect(rollback).not.toContain("ld34");
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
