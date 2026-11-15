import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { plays } from "../schema/index.ts";

const dialect = new PgDialect();

describe("0050_plays migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0050_plays.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0050_plays.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };
  const config = getTableConfig(plays);

  it("only creates the table and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "plays" TO "vertex_research"'
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE/u);
  });

  it("matches the drizzle columns, checks and indexes of plays", () => {
    const start = migration.indexOf('CREATE TABLE "plays" (');
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
        `CREATE INDEX "${index.config.name}" ON "plays"`
      );
    }
    for (const check of config.checks) {
      expect(body).toContain(
        `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
      );
    }
    expect(config.foreignKeys).toHaveLength(0);
  });

  it("requires defined risk: a positive max loss and defined_risk true", () => {
    expect(migration).toContain('"max_loss_usd" numeric NOT NULL');
    expect(migration).toContain('"defined_risk" boolean DEFAULT true NOT NULL');
    expect(migration).toContain('CHECK ("plays"."max_loss_usd" > 0)');
    expect(migration).toContain('CHECK ("plays"."defined_risk" = true)');
    expect(migration).toContain("in ('idea', 'armed', 'taken', 'dropped')");
  });

  it("is journaled as idx 50 after 0049", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0050_plays"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 50 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 49,
      tag: "0049_signal_alerts",
    });
  });

  it("has a guarded rollback that refuses while any play exists", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('EXISTS (SELECT 1 FROM "public"."plays")');
    expect(rollback).toContain('DROP TABLE "public"."plays";');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/u);
  });
});
