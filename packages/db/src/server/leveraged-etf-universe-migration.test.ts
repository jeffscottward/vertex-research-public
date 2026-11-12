import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { leveragedEtfUniverse } from "../schema/index.ts";

const TAG = "0067_leveraged_etf_universe";

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
  const config = getTableConfig(leveragedEtfUniverse);
  const dialect = new PgDialect();
  const start = migration.indexOf('CREATE TABLE "leveraged_etf_universe" (');
  const body = migration.slice(start, migration.indexOf("\n);", start));

  it("matches the drizzle columns, checks and index", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "leveraged_etf_universe_fund_check",
      "leveraged_etf_universe_gate_check",
      "leveraged_etf_universe_options_check",
    ]);
    for (const check of config.checks)
      expect(body).toContain(
        `CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`
      );
    expect(migration).toContain(
      'CREATE INDEX "leveraged_etf_universe_option_gate_idx" ON "leveraged_etf_universe" USING btree ("option_gate");'
    );
  });

  it("keys the table by symbol and stores leverage with two decimals", () => {
    expect(body).toContain('"symbol" text PRIMARY KEY NOT NULL');
    expect(body).toContain('"leverage" numeric(4, 2) NOT NULL');
    expect(body).toContain('"nearest_expiries" jsonb NOT NULL');
    expect(body).toContain('"option_gate_reasons" jsonb NOT NULL');
  });

  it("only creates the table and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN"
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "leveraged_etf_universe" TO "vertex_research"'
    );
    // The read-only role reads only the tables of certified semantic terms (0056).
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

  it("has a rollback that drops only this table and its index and never cascades", () => {
    expect(rollback).toContain(
      'LOCK TABLE "public"."leveraged_etf_universe" IN ACCESS EXCLUSIVE MODE;'
    );
    expect(rollback).toContain(
      'DROP INDEX "public"."leveraged_etf_universe_option_gate_idx";'
    );
    expect(rollback).toContain('DROP TABLE "public"."leveraged_etf_universe";');
    expect(rollback.match(/^DROP /gmu)).toHaveLength(2);
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
  });
});
