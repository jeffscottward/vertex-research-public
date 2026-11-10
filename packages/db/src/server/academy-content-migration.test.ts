import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { academyLessonSources, academyLessonSpecs } from "../schema/index.ts";

// Migration 0060: Academy course content (lesson sources and specs) moves into Postgres.
const dialect = new PgDialect();
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0062_academy_content.sql");
const rollback = read("../../rollback/0062_academy_content.down.sql");
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string; when: number }[];
};

describe("0062_academy_content migration", () => {
  it.each([
    ["academy_lesson_sources", academyLessonSources],
    ["academy_lesson_specs", academyLessonSpecs],
  ] as [string, PgTable][])(
    "matches the drizzle columns, checks and indexes of %s",
    (name, table) => {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);
      const start = migration.indexOf(`CREATE TABLE "${name}" (`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      expect(config.checks.length).toBeGreaterThan(0);
      for (const check of config.checks) {
        expect(body).toContain(
          `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
        );
      }
      for (const index of config.indexes) {
        expect(migration).toContain(
          `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${name}" USING btree`
        );
      }
    }
  );

  it("ties each lesson to a source of the same course", () => {
    const sources = getTableConfig(academyLessonSources);
    expect(sources.uniqueConstraints.map((unique) => unique.getName())).toEqual(
      ["academy_lesson_sources_source_course_key"]
    );
    expect(migration).toContain(
      'CONSTRAINT "academy_lesson_sources_source_course_key" UNIQUE("source_id","course")'
    );
    const specs = getTableConfig(academyLessonSpecs);
    expect(specs.foreignKeys.map((key) => key.getName())).toEqual([
      "academy_lesson_specs_source_fk",
    ]);
    expect(migration).toContain(
      'ALTER TABLE "academy_lesson_specs" ADD CONSTRAINT "academy_lesson_specs_source_fk" FOREIGN KEY ("source_id","course") REFERENCES "public"."academy_lesson_sources"("source_id","course") ON DELETE no action'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "academy_lesson_specs_source_idx" ON "academy_lesson_specs" USING btree ("source_id")'
    );
  });

  it("grants the app role read and import privileges on the two tables only, and seeds nothing", () => {
    const grants = [
      ...migration.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE ([^;]+) TO "vertex_research";/g
      ),
    ].map((match) => [match[1], match[2]]);
    expect(grants).toEqual([
      ["SELECT, INSERT, UPDATE, DELETE", '"academy_lesson_sources"'],
      ["SELECT, INSERT, UPDATE, DELETE", '"academy_lesson_specs"'],
    ]);
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).not.toMatch(/INSERT INTO|TRUNCATE|DROP /u);
    expect(migration).not.toContain(";;");
  });

  // A migration test pins its own position and order, never "last in the journal": later
  // migrations follow it (the drizzle migrator applies entries newer than the last one applied).
  it("is journaled as idx 62 after 0061, and later, so databases that ran 0061 still apply it", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0062_academy_content"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 62 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 61,
      tag: "0061_qc_port_definitions",
    });
    expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Number.POSITIVE_INFINITY
    );
  });

  it("has a guarded rollback that refuses while any content row exists and never cascades", () => {
    expect(rollback).toContain(
      "academy content tables are not empty; refusing rollback"
    );
    for (const table of ["academy_lesson_specs", "academy_lesson_sources"]) {
      expect(rollback).toContain(`EXISTS (SELECT 1 FROM "public"."${table}")`);
      expect(rollback).toContain(`DROP TABLE "public"."${table}";`);
    }
    // Specs reference sources, so the specs table is dropped first.
    expect(
      rollback.indexOf('DROP TABLE "public"."academy_lesson_specs"')
    ).toBeLessThan(
      rollback.indexOf('DROP TABLE "public"."academy_lesson_sources"')
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM|IF EXISTS "/u);
    // A busy table makes the rollback fail fast instead of queueing behind (and blocking) app reads.
    expect(rollback.indexOf("SET LOCAL lock_timeout = '10s';")).toBeGreaterThan(
      -1
    );
    expect(rollback.indexOf("SET LOCAL lock_timeout")).toBeLessThan(
      rollback.indexOf("LOCK TABLE")
    );
  });
});
