import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  breadth90Days,
  breadth90Events,
  breadth90Status,
} from "../schema/index.ts";

const TAG = "0066_breadth_90";

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

  it("only creates tables and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "breadth90_days" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "breadth90_events" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "breadth90_status" TO "vertex_research"'
    );
  });

  it.each(
    [breadth90Days, breadth90Events, breadth90Status].map((table) =>
      getTableConfig(table)
    )
  )("matches the drizzle columns, checks and indexes of $name", (config) => {
    const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = migration.slice(start, migration.indexOf("\n);", start));
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const check of config.checks)
      expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
    for (const index of config.indexes)
      expect(migration).toContain(
        `INDEX "${index.config.name}" ON "${config.name}"`
      );
  });

  it("keeps events unique by kind, date and tier", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "breadth90_events_kind_date_tier_idx" ON "breadth90_events" USING btree ("kind","date","tier")'
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

  it("has a rollback that refuses while events exist and never cascades", () => {
    expect(rollback).toContain(
      "RAISE EXCEPTION 'breadth90_events is not empty"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    for (const table of [
      "breadth90_events",
      "breadth90_status",
      "breadth90_days",
    ])
      expect(rollback).toContain(`DROP TABLE "public"."${table}";`);
  });
});
