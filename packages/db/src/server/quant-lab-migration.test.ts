import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { paperCaptures, strategySpecs } from "../schema/index.ts";

const dialect = new PgDialect();

describe("0043_quant_lab migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0043_quant_lab.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0043_quant_lab.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("only creates objects and grants read and insert to the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).not.toMatch(/CASCADE/);
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "paper_captures" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "strategy_specs" TO "vertex_research"'
    );
    expect(migration).not.toMatch(/GRANT [^;]*(UPDATE|DELETE)/);
  });

  for (const table of [paperCaptures, strategySpecs]) {
    const config = getTableConfig(table);
    it(`matches the drizzle columns, checks, foreign keys and indexes of ${config.name}`, () => {
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
        const unique = index.config.unique ? "UNIQUE " : "";
        expect(migration).toContain(
          `CREATE ${unique}INDEX "${index.config.name}" ON "${config.name}"`
        );
      }
      for (const check of config.checks) {
        expect(body).toContain(
          `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
        );
      }
      for (const foreignKey of config.foreignKeys) {
        expect(migration).toContain(
          `ADD CONSTRAINT "${foreignKey.getName()}" FOREIGN KEY`
        );
      }
    });
  }

  it("is journaled as idx 43 after 0042", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0043_quant_lab"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 43 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 42,
      tag: "0042_basket_benchmark_base",
    });
  });

  it("rollback refuses while rows exist and drops only the two Quant Lab tables", () => {
    expect(rollback).toContain(
      "quant lab tables are not empty; refusing rollback"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
    expect(
      [...rollback.matchAll(/DROP TABLE "public"\."([a-z_]+)"/g)].map(
        (match) => match[1]
      )
    ).toEqual(["strategy_specs", "paper_captures"]);
  });
});
