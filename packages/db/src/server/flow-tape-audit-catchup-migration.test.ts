import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { flowTapeAudits, flowTapeGaps } from "../schema/index.ts";

describe("0101_flow_tape_audit_catchup migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0101_flow_tape_audit_catchup.sql");
  const rollback = read("../../rollback/0101_flow_tape_audit_catchup.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };

  it("only creates flow_tape_audits and flow_tape_gaps and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_tape_audits", "flow_tape_gaps"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_tape_gaps" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE "flow_tape_audits" TO "vertex_research"'
    );
  });

  it.each([
    ["flow_tape_audits", flowTapeAudits, 'PRIMARY KEY("symbol","from_second")'],
    ["flow_tape_gaps", flowTapeGaps, 'PRIMARY KEY("symbol","start_time")'],
  ] as const)(
    "matches the drizzle columns, key and check of %s",
    (name, table, key) => {
      const config = getTableConfig(table);
      const body = migration.slice(
        migration.indexOf(`CREATE TABLE "${name}"`),
        migration.indexOf(
          "--> statement-breakpoint",
          migration.indexOf(`CREATE TABLE "${name}"`)
        )
      );
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      expect(body).toContain(key);
      const [check] = config.checks;
      expect(config.checks).toHaveLength(1);
      expect(check?.name).toBe(`${name}_check`);
      const rendered = new PgDialect().sqlToQuery(
        (check as NonNullable<typeof check>).value
      );
      expect(rendered.params).toEqual([]);
      expect(body).toContain(
        `CONSTRAINT "${name}_check" CHECK (${rendered.sql})`
      );
    }
  );

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0101_flow_tape_audit_catchup"
    );
  });

  it("the rollback drops only the two tables, without cascade, after the timer stop note", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_tape_audits", "flow_tape_gaps"]);
    expect(rollback).toContain("systemctl stop vertex-flow.timer");
  });
});
