import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  pickListMembers,
  pickListSnapshots,
  pickLists,
} from "../schema/index.ts";

const dialect = new PgDialect();

describe("0048_pick_lists migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0048_pick_lists.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0048_pick_lists.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };
  const tables = [pickLists, pickListSnapshots, pickListMembers].map((table) =>
    getTableConfig(table)
  );

  it("only creates tables and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "pick_lists" TO "vertex_research"'
    );
    for (const name of ["pick_list_snapshots", "pick_list_members"]) {
      expect(migration).toContain(
        `GRANT SELECT, INSERT, DELETE ON TABLE "${name}" TO "vertex_research"`
      );
    }
  });

  it.each(tables)(
    "matches the drizzle columns, checks, foreign keys and indexes of $name",
    (config) => {
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
          `CREATE UNIQUE INDEX "${index.config.name}" ON "${config.name}"`
        );
      }
      for (const check of config.checks) {
        expect(body).toContain(
          `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
        );
      }
      expect(config.foreignKeys).toHaveLength(
        config.name === "pick_lists" ? 2 : 1
      );
      for (const foreignKey of config.foreignKeys) {
        const column = foreignKey.reference().columns[0]?.name;
        expect(foreignKey.onDelete).toBe(
          column === "bucket_basket_id" ? "set null" : "cascade"
        );
        expect(migration).toContain(
          `ADD CONSTRAINT "${foreignKey.getName()}" FOREIGN KEY`
        );
      }
    }
  );

  it("clears the bucket basket link when that basket is deleted", () => {
    expect(migration).toContain(
      'FOREIGN KEY ("bucket_basket_id") REFERENCES "public"."baskets"("id") ON DELETE set null'
    );
  });

  it("is journaled as idx 48 after 0047", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0048_pick_lists"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 48 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 47,
      tag: "0047_sector_rotation",
    });
  });

  it("has a guarded rollback that refuses while any pick list exists", () => {
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain('EXISTS (SELECT 1 FROM "public"."pick_lists")');
    for (const name of [
      "pick_list_members",
      "pick_list_snapshots",
      "pick_lists",
    ]) {
      expect(rollback).toContain(`DROP TABLE "public"."${name}";`);
    }
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/u);
  });
});
