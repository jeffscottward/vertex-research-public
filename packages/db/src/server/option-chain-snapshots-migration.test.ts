import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  optionChainSnapshotQuotes,
  optionChainSnapshots,
} from "../schema/index.ts";

const TAG = "0092_option_chain_snapshots";

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

  it("only creates tables and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "option_chain_snapshots" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "option_chain_snapshot_quotes" TO "vertex_research"'
    );
  });

  it.each(
    [optionChainSnapshots, optionChainSnapshotQuotes].map((table) =>
      getTableConfig(table)
    )
  )("matches the drizzle columns, checks and indexes of $name", (config) => {
    const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = migration.slice(start, migration.indexOf("\n);", start));
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const fk of config.foreignKeys)
      expect(fk.reference().foreignTable).toBeDefined();
    for (const check of config.checks)
      expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
    for (const index of config.indexes)
      expect(migration).toContain(
        `INDEX "${index.config.name}" ON "${config.name}"`
      );
  });

  it("keeps snapshots unique by snapshot time, underlying and expiry", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "option_chain_snapshots_at_underlying_expiry_idx" ON "option_chain_snapshots" USING btree ("snapshot_at","underlying","expiry")'
    );
  });

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

  it("has a guarded rollback that refuses while snapshots exist and never cascades", () => {
    expect(rollback).toContain(
      "RAISE EXCEPTION 'option_chain_snapshots is not empty"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    for (const table of [
      "option_chain_snapshot_quotes",
      "option_chain_snapshots",
    ])
      expect(rollback).toContain(`DROP TABLE "public"."${table}";`);
  });
});
