import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { marketNotes } from "../schema/index.ts";

const TAG = "0072_market_notes";

describe(`${TAG} migration`, () => {
  const migration = readFileSync(
    new URL(`../../migrations/${TAG}.sql`, import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(`../../rollback/${TAG}.down.sql`, import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string; when: number }[] };
  const config = getTableConfig(marketNotes);
  const start = migration.indexOf('CREATE TABLE "market_notes" (');
  const body = migration.slice(start, migration.indexOf("\n);", start));

  it("only creates the table and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "market_notes" TO "vertex_research"'
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE/iu);
  });

  it("matches the drizzle columns, checks and indexes of market_notes", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "market_notes_content_check",
      "market_notes_fields_check",
      "market_notes_source_check",
    ]);
    for (const check of config.checks)
      expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
    for (const index of config.indexes)
      expect(migration).toContain(
        `INDEX "${index.config.name}" ON "market_notes"`
      );
  });

  it("keeps one note per source key and indexes the list order", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "market_notes_source_key_idx" ON "market_notes" USING btree ("source_key")'
    );
    expect(migration).toContain(
      'CREATE INDEX "market_notes_received_at_idx" ON "market_notes" USING btree ("received_at")'
    );
  });

  it("checks the stored values, the raw text length and the source URL rule", () => {
    expect(body).toContain(
      `"market_notes"."source_kind" in ('reel', 'article', 'owner-text')`
    );
    expect(body).toContain(
      `"market_notes"."stance" in ('risk-on', 'risk-off', 'neutral')`
    );
    expect(body).toContain(
      `"market_notes"."stance_confidence" in ('low', 'medium', 'high')`
    );
    expect(body).toContain(`"market_notes"."status" in ('active', 'retired')`);
    expect(body).toContain(
      'char_length("market_notes"."raw_text") between 1 and 200000'
    );
    expect(body).toContain(
      `("market_notes"."source_kind" = 'owner-text' and "market_notes"."source_url" is null) or ("market_notes"."source_kind" in ('reel', 'article') and "market_notes"."source_url" is not null)`
    );
    expect(body).toContain(`"status" text DEFAULT 'active' NOT NULL`);
  });

  it("checks the claims array, the affected object, the theme length and the date order", () => {
    // CASE keeps jsonb_array_length away from a value that is not an array.
    expect(body).toContain(
      `case when jsonb_typeof("market_notes"."claims") = 'array' then jsonb_array_length("market_notes"."claims") between 1 and 12 else false end`
    );
    expect(body).toContain(
      `jsonb_typeof("market_notes"."affected") = 'object'`
    );
    expect(body).toContain(
      'char_length("market_notes"."theme") between 1 and 300'
    );
    expect(body).toContain(
      '"market_notes"."review_by" >= "market_notes"."as_of"'
    );
  });

  // migration-journal.test.ts owns the full order; this pins no neighbouring tag (CONVENTIONS.md#migration-numbers).
  it("is journaled once, newer than the entry before it", () => {
    expect(journal.entries.filter((entry) => entry.tag === TAG)).toHaveLength(
      1
    );
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(index).toBeGreaterThan(0);
    return expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Number.POSITIVE_INFINITY
    );
  });

  it("has a rollback that refuses while notes exist and never cascades", () => {
    expect(rollback).toContain("RAISE EXCEPTION 'market_notes is not empty");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(rollback).toContain('DROP TABLE "public"."market_notes";');
    for (const index of config.indexes)
      expect(rollback).toContain(`DROP INDEX "public"."${index.config.name}";`);
  });
});
