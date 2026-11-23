import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { openbbFreshnessState } from "../schema/index.ts";

describe("0092_price_freshness_state migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0092_price_freshness_state.sql");
  const rollback = read("../../rollback/0092_price_freshness_state.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(openbbFreshnessState);

  it("only creates price_freshness_state and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["price_freshness_state"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_freshness_state" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of price_freshness_state", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('"monitor" text PRIMARY KEY NOT NULL');
    expect(migration).toContain(
      `"active_keys" text[] DEFAULT '{}'::text[] NOT NULL`
    );
    expect(migration).toContain(
      `"pending_keys" text[] DEFAULT '{}'::text[] NOT NULL`
    );
    const [check] = config.checks;
    expect(config.checks).toHaveLength(1);
    expect(check?.name).toBe("price_freshness_state_check");
    const rendered = new PgDialect().sqlToQuery(
      (check as NonNullable<typeof check>).value
    );
    expect(rendered.params).toEqual([]);
    expect(migration).toContain(
      `CONSTRAINT "price_freshness_state_check" CHECK (${rendered.sql})`
    );
  });

  it("guards pending columns against NULL and requires non-empty pending_keys on alert", () => {
    expect(migration).not.toContain("array_length");
    expect(migration).toContain(
      '"price_freshness_state"."pending_event_id" is not null'
    );
    expect(migration).toContain(
      '"price_freshness_state"."pending_kind" is not null'
    );
    expect(migration).toContain(
      '"price_freshness_state"."pending_delivery" is not null'
    );
    expect(migration).toContain(
      'cardinality("price_freshness_state"."pending_keys") > 0'
    );
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0092_price_freshness_state"
    );
  });

  it("the rollback drops only price_freshness_state, without cascade, after the timer stop note", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["price_freshness_state"]);
    expect(rollback).toContain("systemctl stop vertex-openbb-freshness.timer");
  });
});
