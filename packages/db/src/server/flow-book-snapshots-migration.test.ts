import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { flowBookSnapshots } from "../schema/index.ts";

describe("0094_flow_book_snapshots migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0094_flow_book_snapshots.sql");
  const rollback = read("../../rollback/0094_flow_book_snapshots.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowBookSnapshots);

  it("only creates flow_book_snapshots and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_book_snapshots"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_book_snapshots" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key, and check of flow_book_snapshots", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('"bid_prices" double precision[] NOT NULL');
    expect(migration).toContain('"ask_prices" double precision[] NOT NULL');
    expect(migration).toContain('PRIMARY KEY("symbol","captured_at")');
    const [check] = config.checks;
    expect(config.checks).toHaveLength(1);
    expect(check?.name).toBe("flow_book_snapshots_check");
    const rendered = new PgDialect().sqlToQuery(
      (check as NonNullable<typeof check>).value
    );
    expect(rendered.params).toEqual([]);
    expect(migration).toContain(
      `CONSTRAINT "flow_book_snapshots_check" CHECK (${rendered.sql})`
    );
  });

  it("checks array bounds with cardinality and 1D/finite guards", () => {
    expect(migration).not.toContain("array_length");
    expect(migration).toContain("array_ndims");
    expect(migration).toContain("'Infinity'::double precision");
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0094_flow_book_snapshots"
    );
  });

  it("the rollback drops only flow_book_snapshots, without cascade or IF EXISTS, after the timer stop note", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_book_snapshots"]);
    expect(rollback).toContain("systemctl stop vertex-flow.timer");
  });
});
