import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  researchScreenBars,
  researchScreenRows,
  researchScreenRuns,
  researchScreenScheduler,
  researchScreenSwinglytics,
} from "../schema/index.ts";

const dialect = new PgDialect();
const tables = [
  researchScreenRuns,
  researchScreenRows,
  researchScreenBars,
  researchScreenScheduler,
  researchScreenSwinglytics,
];
/** The order the down file drops in: the tables that reference the runs go first. */
const dropOrder = [
  "research_screen_rows",
  "research_screen_bars",
  "research_screen_runs",
  "research_screen_scheduler",
  "research_screen_swinglytics",
];

describe("0076_research_screen migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0076_research_screen.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0076_research_screen.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("only creates objects and grants the app role read, insert and update", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/imu
    );
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    for (const table of tables) {
      const { name } = getTableConfig(table);
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE ON TABLE "${name}" TO "vertex_research";`
      );
    }
    expect(migration.match(/GRANT /gu)).toHaveLength(tables.length);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE/u);
    expect(migration.match(/CREATE TABLE /gu)).toHaveLength(tables.length);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    it(`matches the drizzle columns, checks, foreign keys and indexes of ${config.name}`, () => {
      const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gmu)].map(
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
      for (const foreignKey of config.foreignKeys) {
        expect(migration).toContain(
          `ADD CONSTRAINT "${foreignKey.getName()}" FOREIGN KEY`
        );
      }
    });
  }

  it("allows one running run and one run per slot", () => {
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "research_screen_runs_slot_at_idx" ON "research_screen_runs" USING btree ("slot_at");`
    );
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "research_screen_runs_running_idx" ON "research_screen_runs" USING btree ("status") WHERE "research_screen_runs"."status" = 'running';`
    );
  });

  it("removes rows and bars with their report and keeps rows when a run goes", () => {
    for (const name of ["research_screen_rows", "research_screen_bars"]) {
      expect(migration).toContain(
        `ALTER TABLE "${name}" ADD CONSTRAINT "${name}_report_id_research_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_reports"("id") ON DELETE cascade`
      );
    }
    for (const column of ["attempt_run_id", "good_run_id"]) {
      expect(migration).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "public"."research_screen_runs"("id") ON DELETE set null`
      );
    }
  });

  it("is journaled with the index of its file number, directly after the entry before it", () => {
    // The number changes when another migration merges first (pnpm db:renumber), so the test reads it.
    const index = journal.entries.findIndex((entry) =>
      entry.tag.endsWith("_research_screen")
    );
    const entry = journal.entries[index];
    expect(entry?.tag).toBe(
      `${String(entry?.idx).padStart(4, "0")}_research_screen`
    );
    expect(journal.entries[index - 1]?.idx).toBe((entry?.idx ?? 0) - 1);
  });

  it("has a rollback that drops exactly the 5 tables in order inside one transaction", () => {
    const statements = rollback
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replaceAll(/\s+/gu, " ").trim())
      .filter((statement) => statement !== "");
    const quoted = dropOrder.map((name) => `"public"."${name}"`);

    expect(statements).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog, public",
      "SET LOCAL row_security = off",
      `LOCK TABLE ${quoted.join(", ")} IN ACCESS EXCLUSIVE MODE`,
      ...quoted.map((name) => `DROP TABLE ${name}`),
      "COMMIT",
    ]);
    expect(dropOrder.toSorted()).toEqual(
      tables.map((table) => getTableConfig(table).name).sort()
    );
  });

  it("says in the rollback header why there is no emptiness guard", () => {
    const header = rollback.slice(0, rollback.indexOf("BEGIN;"));

    expect(header).toContain("No emptiness guard, on purpose");
    expect(header).toContain("filled again by the next runs");
    expect(header).toContain("accepted for a rollback");
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM|IF EXISTS/u);
  });
});
