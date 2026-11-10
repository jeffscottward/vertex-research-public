import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeStrategyDescription,
  normalizeStrategyExternalValidation,
  normalizeStrategyName,
  normalizeStrategyPriority,
  normalizeStrategySection,
  normalizeStrategySlug,
  normalizeStrategySourceRef,
  normalizeStrategyTags,
} from "./strategy-library.ts";

// Migration 0065: strategies.priority and strategies.external_validation, and the volume spike
// breakout strategy from YouTube video XLMG6-SATRk (high priority, externally pre-validated). Research only.
const TAG = "0065_strategy_catalog_volume_spike_breakout";
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read(`../../migrations/${TAG}.sql`);
const rollback = read(`../../rollback/${TAG}.down.sql`);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string; when: number }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));
const unquote = (value: string | undefined) =>
  (value ?? "").replaceAll("''", "'");

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb, '([a-z]+)', '((?:[^']|'')+)'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe(TAG, () => {
  it("adds the priority and external claim columns before the row", () => {
    const [ddl, data] = [
      migration.slice(0, migration.indexOf("INSERT INTO")),
      migration.slice(migration.indexOf("INSERT INTO")),
    ];
    expect(ddl).toContain(
      `ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL`
    );
    expect(ddl).toContain('ADD COLUMN "external_validation" jsonb;');
    expect(ddl).toContain(
      `CHECK ("strategies"."priority" in ('normal', 'high'))`
    );
    expect(ddl).toContain(
      `ADD CONSTRAINT "strategies_external_validation_check" CHECK ("strategies"."external_validation" is null or jsonb_typeof("strategies"."external_validation") = 'object')`
    );
    expect(ddl.match(/--> statement-breakpoint/gu)).toHaveLength(4);
    return expect(data).toContain('"priority", "external_validation"');
  });

  it("inserts one research-only row that passes the repository field rules", () => {
    expect(rows).toHaveLength(1);
    const [
      ,
      id,
      slug,
      name,
      rawDescription,
      kind,
      status,
      sourceRef,
      tags,
      section,
      priority,
    ] = rows[0] ?? [];
    const description = unquote(rawDescription);
    expect([id, slug, name, kind, status, sourceRef, section]).toEqual([
      "strategy-seed-volume-spike-breakout",
      "volume-spike-breakout",
      "Volume spike breakout: NAS100 15m (YouTube, externally pre-validated)",
      "python",
      "backtested",
      "docs/specs/strategies/volume-spike-breakout.md",
      "Reel ideas",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    expect(normalizeStrategyDescription(description)).toBe(description);
    for (const term of [
      "NAS100 15-minute candles",
      "at least 3 x the mean of the 50 candles before it",
      "fixed 15-point stop",
      "no entry on Wednesday",
      "That is the source's claim",
      "it is not validated by Vertex",
      "QQQ debit verticals sized at 2% max loss",
      "deflated Sharpe ratio with N = 10,000",
      "Research only",
    ])
      expect(description).toContain(term);
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(normalizeStrategySection(section)).toBe(section);
    expect(normalizeStrategyPriority(priority)).toBe("high");
    const parsed = JSON.parse(tags ?? "[]");
    expect(normalizeStrategyTags(parsed)).toEqual(parsed);
    return expect(parsed).toEqual([
      "research-only",
      "backtest-study",
      "externally-pre-validated",
      "youtube",
      "intraday",
      "breakout",
      "volume",
      "long-short",
      "options",
      "defined-risk",
    ]);
  });

  it("stores the source's claim in the shape the repository accepts", () => {
    const claim = JSON.parse(unquote(rows[0]?.[11])) as {
      claimedMethod: string;
      claimedMetrics: { label: string; value: string }[];
    };
    expect(normalizeStrategyExternalValidation(claim)).toEqual(claim);
    expect(claim).toMatchObject({
      sourceUrl: "https://youtu.be/XLMG6-SATRk",
      sourceTitle:
        "I Backtested 10,000 Strategies - Here is the Most Profitable (5 million trades)",
      sourceAuthor: "Lil Fish (@not_a_lil_fish), YouTube",
      publishedOn: "2026-09-24",
    });
    expect(claim.claimedMethod).toContain(
      "no correction for the number of strategies tried"
    );
    expect(claim.claimedMethod).toContain("The source's own verdict");
    return expect(claim.claimedMetrics).toEqual([
      { label: "Rank", value: "1 of 10,500 by total net R" },
      { label: "Trades", value: "657 (1.75 per week)" },
      { label: "Win rate", value: "14%" },
      { label: "Average reward : risk", value: "8.88" },
      { label: "Net per trade", value: "+0.457R" },
      { label: "Total net", value: "300R" },
      { label: "Max drawdown", value: "71R, 37 losses in a row" },
      {
        label: "Out-of-sample 6 months",
        value: "+1.154R per trade, 59 trades",
      },
    ]);
  });

  // migration-journal.test.ts owns the full order; this pins no neighbouring tag (CONVENTIONS.md#migration-numbers).
  it("is journaled once, newer than the entry before it", () => {
    const matches = journal.entries.filter((entry) => entry.tag === TAG);
    expect(matches).toHaveLength(1);
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(index).toBeGreaterThan(0);
    return expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Number.POSITIVE_INFINITY
    );
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback).toContain("'strategy-seed-volume-spike-breakout'");
    expect(rollback).not.toContain("market-intraday-momentum");
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
    return expect(rollback).toContain(
      "catalog strategy has operator edits or linked rows; refusing rollback"
    );
  });

  return it("drops the two columns only after the row is gone and no other row uses them", () => {
    const remove = rollback.indexOf('DELETE FROM "public"."strategies"');
    const guard = rollback.indexOf(
      `s."priority" <> 'normal' OR s."external_validation" IS NOT NULL`
    );
    const refuse = rollback.indexOf(
      "another strategy uses priority or external_validation; refusing rollback"
    );
    const drops = [
      'DROP CONSTRAINT "strategies_external_validation_check"',
      'DROP CONSTRAINT "strategies_priority_check"',
      'DROP COLUMN "external_validation"',
      'DROP COLUMN "priority"',
    ].map((statement) => rollback.indexOf(statement));
    expect(remove).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(remove);
    expect(refuse).toBeGreaterThan(guard);
    for (const drop of drops) expect(drop).toBeGreaterThan(refuse);
    expect(rollback.trimStart()).toMatch(/^--[^\n]*\n(?:--[^\n]*\n)*BEGIN;/u);
    return expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
  });
});
