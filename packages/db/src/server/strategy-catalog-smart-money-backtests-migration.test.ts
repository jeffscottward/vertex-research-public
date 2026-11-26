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

// Data migration 0095: Smart-money PR 7 backtest catalog rows (card vertex-smart-money-pr7-backtests).
// Updates insider-purchase-confirmation when untouched and inserts smart-money-congress-buys +
// smart-money-large-bullish-premium. Research only.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const TAG = "0095_strategy_catalog_smart_money_backtests";
const migration = read(`../../migrations/${TAG}.sql`);
const rollback = read(`../../rollback/${TAG}.down.sql`);
const migration0031 = read("../../migrations/0031_strategy_catalog.sql");
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};
const repoFile = (path: string) =>
  existsSync(new URL(`../../../../${path}`, import.meta.url));

const INSERT_ROW =
  /\('(strategy-seed-[a-z0-9-]+)', '([a-z0-9-]+)', '((?:[^']|'')+)', '((?:[^']|'')+)', '(python)', '([a-z_]+)', '([^']+)', '(\[[^\]]*\])'::jsonb, '([^']+)', '(\[[^\]]*\])'::jsonb\)/g;
const insertedRows = [...migration.matchAll(INSERT_ROW)];

describe(TAG, () => {
  it("updates insider-purchase-confirmation with AND-guarded predicates without touching updated_at", () => {
    expect(migration).toContain('UPDATE "public"."strategies"');
    expect(migration).toContain(
      `WHERE "id" = 'strategy-seed-insider-purchase-confirmation'`
    );
    expect(migration).toContain(`AND "slug" = 'insider-purchase-confirmation'`);
    expect(migration).toContain('AND "updated_at" = "created_at"');
    expect(migration).toContain(`AND "tags" ? 'needs-data'`);
    const setClause = migration.match(/SET([\s\S]*?)WHERE/u)?.[1] ?? "";
    expect(setClause).not.toContain('"updated_at"');

    const statusMatch = migration.match(/"status"\s*=\s*'([^']+)'/u);
    const sourceRefMatch = migration.match(/"source_ref"\s*=\s*'([^']+)'/u);
    const descMatch = migration.match(/"description"\s*=\s*'((?:[^']|'')+)'/u);
    const tagsMatch = migration.match(/"tags"\s*=\s*'(\[[^\]]*\])'::jsonb/u);

    expect(statusMatch?.[1]).toBe("backtested");
    expect(sourceRefMatch?.[1]).toBe(
      "docs/specs/strategies/insider-purchase-confirmation.md"
    );
    expect(repoFile(sourceRefMatch?.[1] ?? "")).toBe(true);
    expect(normalizeStrategySourceRef(sourceRefMatch?.[1])).toBe(
      sourceRefMatch?.[1]
    );

    const description = descMatch?.[1]?.replaceAll("''", "'") ?? "";
    expect(normalizeStrategyDescription(description)).toBe(description);
    expect(description.length).toBeLessThanOrEqual(2000);
    expect(description).toContain("no-edge");
    expect(description).toContain("SEC");
    expect(description).toContain("2 business days");
    expect(description).toContain("10b5-1");
    expect(description).toContain("Research only");

    const parsedTags = JSON.parse(tagsMatch?.[1] ?? "[]");
    expect(normalizeStrategyTags(parsedTags)).toEqual(parsedTags);
    expect(parsedTags).toEqual([
      "freestockalerts",
      "alerts",
      "daily",
      "insider",
      "smart-money",
      "backtest-study",
      "failed",
    ]);
  });

  it("inserts two research-only smart-money rows that pass the repository field rules", () => {
    expect(insertedRows).toHaveLength(2);
    const [congress, premium] = insertedRows;
    expect(congress).toBeDefined();
    expect(premium).toBeDefined();

    for (const row of insertedRows) {
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
      ] = row;
      expect(id).toBe(`strategy-seed-${slug}`);
      expect(kind).toBe("python");
      expect(section).toBe("Idea discovery");
      expect(normalizeStrategySlug(slug)).toBe(slug);
      expect(normalizeStrategyName(name?.replaceAll("''", "'"))).toBe(
        name?.replaceAll("''", "'")
      );
      const text = description?.replaceAll("''", "'") ?? "";
      expect(normalizeStrategyDescription(text)).toBe(text);
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text).toContain("Research only");
      expect(normalizeStrategySourceRef(sourceRef)).toBe(sourceRef);
      expect(repoFile(sourceRef ?? "")).toBe(true);
      expect(normalizeStrategySection(section)).toBe(section);
      expect(JSON.parse(params ?? "null")).toEqual([]);
      const parsed = JSON.parse(tags ?? "[]");
      expect(normalizeStrategyTags(parsed)).toEqual(parsed);
      expect(parsed).toContain("research-only");
      expect(parsed).toContain("smart-money");
      expect(parsed).toContain("backtest-study");
      expect(status).toMatch(/^(backtested|researching)$/u);
    }

    // Congress row: backtested, no-edge, tagged failed.
    expect(congress?.[2]).toBe("smart-money-congress-buys");
    expect(congress?.[6]).toBe("backtested");
    expect(JSON.parse(congress?.[8] ?? "[]")).toEqual([
      "research-only",
      "smart-money",
      "congress",
      "daily",
      "backtest-study",
      "failed",
    ]);
    expect(congress?.[4]).toContain("45-day");
    expect(congress?.[4]).toContain("no-edge");

    // Large bullish premium row: researching, needs-data, needs-more-data until 2027-10-16.
    expect(premium?.[2]).toBe("smart-money-large-bullish-premium");
    expect(premium?.[6]).toBe("researching");
    expect(JSON.parse(premium?.[8] ?? "[]")).toEqual([
      "research-only",
      "smart-money",
      "options-flow",
      "daily",
      "needs-data",
      "backtest-study",
    ]);
    expect(premium?.[4]).toContain("sold puts");
    expect(premium?.[4]).toContain("needs-more-data");
    expect(premium?.[4]).toContain("2027-10-16");
  });

  it("never overwrites an existing slug on INSERT", () => {
    expect(migration).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it("is journaled under its own number, right after the entry before it", () => {
    const number = Number.parseInt(TAG.slice(0, 4), 10);
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(journal.entries[index]).toMatchObject({ idx: number });
    expect(journal.entries[index - 1]).toMatchObject({ idx: number - 1 });
  });

  it("rolls back only unedited, unreferenced rows and restores the exact 0031 insider row", () => {
    for (const id of [
      "strategy-seed-insider-purchase-confirmation",
      "strategy-seed-smart-money-congress-buys",
      "strategy-seed-smart-money-large-bullish-premium",
    ]) {
      expect(rollback).toContain(`'${id}'`);
    }
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
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain(
      `LOCK TABLE "public"."strategies" IN ACCESS EXCLUSIVE MODE`
    );

    // Exact 0031 description must be restored verbatim.
    const orig0031 = migration0031.match(
      /'strategy-seed-insider-purchase-confirmation', 'insider-purchase-confirmation', 'Insider Purchase Confirmation', '((?:[^']|'')+)'/u
    );
    expect(orig0031?.[1]).toBeTruthy();
    expect(rollback).toContain(`"description" = '${orig0031?.[1]}'`);
    expect(rollback).toContain(`"status" = 'researching'`);
    expect(rollback).toContain(
      `"source_ref" = 'services/research/strategies/alert_templates.py'`
    );
    expect(rollback).toContain(
      `"tags" = '["freestockalerts","alerts","daily","insider","needs-data"]'::jsonb`
    );

    // The restore runs only on a row that is in the state the forward migration wrote.
    const restore = rollback.slice(rollback.lastIndexOf("UPDATE"));
    expect(restore).toContain(`AND "status" = 'backtested'`);
    expect(restore).toContain(
      `AND "source_ref" = 'docs/specs/strategies/insider-purchase-confirmation.md'`
    );
    expect(restore).toContain(`AND "tags" ? 'backtest-study'`);
  });
});
