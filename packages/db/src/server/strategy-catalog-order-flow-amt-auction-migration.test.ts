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

// Data migration 0080: the order flow / AMT auction rules of card vertex-orderflow-amt-strategy, written
// after the study ran (both rules no-edge). Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const TAG = "0080_strategy_catalog_order_flow_amt_auction";
const migration = read(`../../migrations/${TAG}.sql`);
const rollback = read(`../../rollback/${TAG}.down.sql`);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '(\[[^\]]*\])'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe(TAG, () => {
  it("inserts one research-only tested-failed row that passes the repository field rules", () => {
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
      params,
    ] = rows[0] ?? [];
    expect([id, slug, kind, status, sourceRef, section]).toEqual([
      "strategy-seed-order-flow-amt-auction",
      "order-flow-amt-auction",
      "python",
      "backtested",
      "docs/specs/strategies/order-flow-amt-auction.md",
      "Entry timing",
    ]);
    expect(normalizeStrategySlug(slug)).toBe(slug);
    expect(normalizeStrategyName(name)).toBe(name);
    const text = description?.replaceAll("''", "'") ?? "";
    expect(normalizeStrategyDescription(text)).toBe(text);
    expect(text).toContain("Rule A no edge: 1,839 out-of-sample trades");
    expect(text).toContain("Rule C no edge: 2,564 out-of-sample trades");
    expect(text).toContain("Order flow (true delta) is not tested");
    expect(name).toContain("order flow not yet tested");
    expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
    expect(repoFile(sourceRef ?? "")).toBe(true);
    expect(normalizeStrategySection(section)).toBe(section);
    // strategies_json_check (0019): params must be a JSON array (typed param specs), never an object.
    expect(JSON.parse(params ?? "null")).toEqual([]);
    const parsed = JSON.parse(tags ?? "[]");
    expect(normalizeStrategyTags(parsed)).toEqual(parsed);
    for (const tag of ["research-only", "amt", "failed"])
      expect(parsed).toContain(tag);
    // No research_studies document is imported, so the row must not claim one; order flow is not tested.
    for (const tag of ["validated", "backtest-study", "order-flow"])
      expect(parsed).not.toContain(tag);
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled right after 0079", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(journal.entries[index]).toMatchObject({ idx: 80 });
    return expect(journal.entries[index - 1]).toMatchObject({
      idx: 79,
      tag: "0079_strategy_catalog_flow_control_continuation",
    });
  });

  return it("rolls back only the unedited row while nothing references it", () => {
    expect(rollback.match(/'strategy-seed-[a-z0-9-]+'/gu)).toEqual([
      "'strategy-seed-order-flow-amt-auction'",
      "'strategy-seed-order-flow-amt-auction'",
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
