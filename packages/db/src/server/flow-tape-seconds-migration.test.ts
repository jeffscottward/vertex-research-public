import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { flowTapeSeconds } from "../schema/index.ts";

describe("0091_flow_tape_seconds migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0091_flow_tape_seconds.sql");
  const rollback = read("../../rollback/0091_flow_tape_seconds.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowTapeSeconds);

  it("only creates flow_tape_seconds and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_tape_seconds"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_tape_seconds" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of flow_tape_seconds", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('"trades" integer[] NOT NULL');
    expect(migration).toContain('"contracts" integer[] NOT NULL');
    expect(migration).toContain('PRIMARY KEY("symbol","minute")');
    const [check] = config.checks;
    expect(config.checks).toHaveLength(1);
    expect(check?.name).toBe("flow_tape_seconds_check");
    // The check of the schema, rendered as drizzle-kit renders it into the migration.
    const rendered = new PgDialect().sqlToQuery(
      (check as NonNullable<typeof check>).value
    );
    expect(rendered.params).toEqual([]);
    expect(migration).toContain(
      `CONSTRAINT "flow_tape_seconds_check" CHECK (${rendered.sql})`
    );
  });

  it("checks the array sizes with cardinality, so an empty array is refused", () => {
    // array_length of an empty array is NULL, and a check that evaluates to NULL passes.
    expect(migration).not.toContain("array_length");
    expect(migration).toContain(
      'cardinality("flow_tape_seconds"."trades") = 60'
    );
    expect(migration).toContain(
      'cardinality("flow_tape_seconds"."contracts") = 60'
    );
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0091_flow_tape_seconds"
    );
  });

  it("the rollback drops only flow_tape_seconds, without cascade, after the timer stop note", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_tape_seconds"]);
    expect(rollback).toContain("systemctl stop vertex-flow.timer");
  });
});
