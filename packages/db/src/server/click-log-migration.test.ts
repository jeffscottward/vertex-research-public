import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { uiClickEvents } from "../schema/index.ts";

const dialect = new PgDialect();

describe("0046_click_log migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0046_click_log.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0046_click_log.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };
  const config = getTableConfig(uiClickEvents);

  it("only creates the click table and grants the app role insert, read and delete", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE "ui_click_events" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, checks, foreign key and indexes", () => {
    const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = migration.slice(start, migration.indexOf("\n);", start));
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const index of config.indexes) {
      expect(migration).toContain(
        `CREATE INDEX "${index.config.name}" ON "${config.name}"`
      );
    }
    for (const check of config.checks) {
      expect(body).toContain(
        `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
      );
    }
    expect(config.foreignKeys).toHaveLength(1);
    expect(migration).toContain(
      `ADD CONSTRAINT "${config.foreignKeys[0]?.getName()}" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade`
    );
  });

  it("is journaled as idx 46 after 0045", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0046_click_log"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 46 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 45,
      tag: "0045_market_bar_futures_symbols",
    });
  });

  it("has a guarded rollback that refuses a non-empty table", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain(
      'EXISTS (SELECT 1 FROM "public"."ui_click_events")'
    );
    expect(rollback).toContain('DROP TABLE "public"."ui_click_events";');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/u);
  });
});
