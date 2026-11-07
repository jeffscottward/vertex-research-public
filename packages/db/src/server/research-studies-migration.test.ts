import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { researchStudies } from "../schema/index.ts";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("0050_research_studies migration", () => {
  const migration = read("../../migrations/0050_research_studies.sql");
  const rollback = read("../../rollback/0050_research_studies.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(researchStudies);
  const dialect = new PgDialect();

  it("matches the drizzle columns and checks", () => {
    const start = migration.indexOf('CREATE TABLE "research_studies" (');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = migration.slice(start, migration.indexOf("\n);", start));
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(config.checks).toHaveLength(2);
    for (const check of config.checks)
      expect(body).toContain(
        `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
      );
  });

  it("grants the app role what the repository uses and never deletes", () => {
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "research_studies" TO "vertex_research"'
    );
    expect(migration).not.toMatch(/^\s*(TRUNCATE|UPDATE|DELETE|DROP)\s/im);
    expect(migration).toContain('ON CONFLICT ("id") DO NOTHING;');
  });

  it("seeds the ADX/RVOL study that the web fixture holds", () => {
    const seed = /\$study\$([\s\S]*)\$study\$::jsonb/u.exec(migration)?.[1];
    expect(seed).toBeDefined();
    const document = JSON.parse(seed ?? "") as Record<string, unknown>;
    expect(document).toMatchObject({
      id: "adx-rvol-filters",
      ran: "2026-10-31",
      spec: "docs/specs/research/adx-filter.md",
    });
    expect(migration).toContain(
      "'adx-rvol-filters',\n  'docs/specs/research/adx-filter.md',\n  '2026-10-31',"
    );
    const fixture: unknown = JSON.parse(
      read(
        "../../../../apps/web/src/features/research-studies/fixtures/adx-filter-study.json"
      )
    );
    expect(document).toEqual(fixture);
  });

  it("is the 51st journal entry and the rollback keeps imported studies", () => {
    expect(journal.entries[50]).toMatchObject({
      idx: 50,
      tag: "0050_research_studies",
    });
    expect(rollback).toContain(
      "RAISE EXCEPTION 'research_studies holds imported studies"
    );
    expect(rollback).toContain(
      `WHERE "id" <> 'adx-rvol-filters' OR "updated_at" <> "created_at"`
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(rollback).toContain('DROP TABLE "public"."research_studies";');
  });
});
