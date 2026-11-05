import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  researchCompanyResearch,
  researchReportCategories,
  researchReportDatasets,
  researchReportRevisions,
  researchReports,
} from "../schema/index.ts";

const dialect = new PgDialect();
const tables = [
  researchReports,
  researchReportCategories,
  researchReportRevisions,
  researchReportDatasets,
  researchCompanyResearch,
];

describe("0044_research_reports migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0044_research_reports.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0044_research_reports.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("only creates objects and grants the app role access to the research tables", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    for (const table of [researchReports, researchReportCategories]) {
      const { name } = getTableConfig(table);
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${name}" TO "vertex_research"`
      );
    }
    for (const table of [
      researchReportRevisions,
      researchReportDatasets,
      researchCompanyResearch,
    ]) {
      const { name } = getTableConfig(table);
      expect(migration).toContain(
        `GRANT SELECT, INSERT ON TABLE "${name}" TO "vertex_research"`
      );
    }
    expect(migration).toContain(
      `CONSTRAINT "research_report_datasets_private_check" CHECK (("research_report_datasets"."dataset" = 'portfolio') = ("research_report_datasets"."body" is null))`
    );
  });

  for (const table of tables) {
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
        expect(migration).toContain(
          `CREATE INDEX "${index.config.name}" ON "${config.name}"`
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
        expect(foreignKey.reference().foreignTable).toBeDefined();
      }
    });
  }

  it("is journaled as idx 44 after 0043", () => {
    const index = journal.entries.findIndex(
      (entry) => entry.tag === "0044_research_reports"
    );
    expect(journal.entries[index]).toMatchObject({ idx: 44 });
    expect(journal.entries[index - 1]).toMatchObject({
      idx: 43,
      tag: "0043_quant_lab",
    });
  });

  it("has a guarded rollback that refuses non-empty tables", () => {
    expect(rollback).toContain("refusing rollback");
    for (const table of tables) {
      const { name } = getTableConfig(table);
      expect(rollback).toContain(`EXISTS (SELECT 1 FROM "public"."${name}")`);
      expect(rollback).toContain(`DROP TABLE "public"."${name}";`);
    }
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/u);
  });
});
