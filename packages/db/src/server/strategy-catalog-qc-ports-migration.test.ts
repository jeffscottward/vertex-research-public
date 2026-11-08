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

  return it("rolls back only unedited rows without presets or backtests", () => {
    for (const [, id] of rows) expect(rollback).toContain(`'${id}'`);
    return expect(rollback).toContain("refusing rollback");
  });
});
