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

// Data migration 0057: 11 QuantConnect-inspired ideas (card vertex-qc-ports). Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0057_strategy_catalog_qc_ports.sql");
const rollback = read("../../rollback/0057_strategy_catalog_qc_ports.down.sql");
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '\[\]'::jsonb\)/g;
const rows = [...migration.matchAll(ROW)];

describe("0057_strategy_catalog_qc_ports", () => {
  it("inserts 11 research-only rows that pass the repository field rules", () => {
    expect(rows).toHaveLength(11);
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
      expect(text).toContain("MODELED");
      expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
      expect(normalizeStrategySection(section)).toBe(section);
      const parsed = JSON.parse(tags ?? "[]");
      expect(normalizeStrategyTags(parsed)).toEqual(parsed);
      expect(parsed).toContain("research-only");
      expect(repoFile(sourceRef ?? "")).toBe(true);
    }
  });

  it("never overwrites an existing slug", () => {
    return expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("refuses the rollback while the 0061 definitions exist, before deleting anything", () => {
    const guard = rollback.indexOf(
      `FROM "public"."strategy_definition_revisions" d WHERE d."created_by" = 'migration:0061'`
    );
    expect(guard).toBeGreaterThan(-1);
    expect(rollback).toContain(
      "the qc-port definitions of 0061 still exist; roll back 0061 first"
    );
    expect(guard).toBeLessThan(
      rollback.indexOf('DELETE FROM "public"."strategies"')
    );
  });

  return it("rolls back only unedited rows that nothing references", () => {
    for (const [, id] of rows) expect(rollback).toContain(`'${id}'`);
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
