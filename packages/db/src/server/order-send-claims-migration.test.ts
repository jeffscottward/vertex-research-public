import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { vertexOrderSendClaims } from "../schema/index.ts";

const TAG = "0071_vertex_order_send_claims";

describe(`${TAG} migration`, () => {
  const migration = readFileSync(
    new URL(`../../migrations/${TAG}.sql`, import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(`../../rollback/${TAG}.down.sql`, import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string; when: number }[] };
  const config = getTableConfig(vertexOrderSendClaims);
  const dialect = new PgDialect();
  const start = migration.indexOf('CREATE TABLE "vertex_order_send_claims" (');
  const body = migration.slice(start, migration.indexOf("\n);", start));

  it("matches the drizzle columns, primary key and check", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(body).toContain(
      'CONSTRAINT "vertex_order_send_claims_pk" PRIMARY KEY("order_ref","attempt")'
    );
    expect(config.checks.map((check) => check.name)).toEqual([
      "vertex_order_send_claims_fields_check",
    ]);
    for (const check of config.checks)
      expect(body).toContain(
        `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
      );
  });

  it("only creates the table and grants the app role insert and select", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "vertex_order_send_claims" TO "vertex_research";'
    );
    expect(migration.match(/GRANT /gu)).toHaveLength(1);
  });

  // migration-journal.test.ts owns the full order; this pins no neighbouring tag (CONVENTIONS.md#migration-numbers).
  it("is journaled once, newer than the entry before it", () => {
    expect(journal.entries.filter((entry) => entry.tag === TAG)).toHaveLength(
      1
    );
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(index).toBeGreaterThan(0);
    return expect(journal.entries[index]?.when).toBeGreaterThan(
      journal.entries[index - 1]?.when ?? Number.POSITIVE_INFINITY
    );
  });

  it("has a guarded rollback that drops only this table and never cascades", () => {
    expect(rollback).toContain(
      'LOCK TABLE "public"."vertex_order_send_claims" IN ACCESS EXCLUSIVE MODE;'
    );
    expect(rollback).toContain(
      "RAISE EXCEPTION 'vertex_order_send_claims has a send with no outcome; refusing rollback';"
    );
    expect(rollback).toContain(
      'DROP TABLE "public"."vertex_order_send_claims";'
    );
    expect(rollback.match(/^DROP /gmu)).toHaveLength(1);
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
  });
});
