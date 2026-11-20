import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { jevVerdictLog } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import { createJevVerdictLogRepository } from "./jev-verdict-log.ts";

const now = new Date("2026-11-19T12:00:00.000Z");

const fakeDatabase = (rows: unknown[] = []) => {
  const inserted: unknown[] = [];
  const database = {
    insert: () => ({ values: async (row: unknown) => inserted.push(row) }),
    select: () => ({ from: () => ({ orderBy: async () => rows }) }),
  } as unknown as DatabaseExecutor;
  return { database, inserted };
};

const deps = { generateId: () => "log-1", now: () => now };

describe("jev verdict log repository", () => {
  it("appends one row per verdict", async () => {
    const { database, inserted } = fakeDatabase();
    const repository = createJevVerdictLogRepository(database, deps);
    await expect(
      repository.append({
        choice: "BULLISH",
        dataAsOf: "2026-11-18",
        decidedAt: new Date("2026-11-19T11:59:00.000Z"),
        model: "jev-1",
        probabilities: { BEARISH: 0.1, BULLISH: 0.7, NEUTRAL: 0.2 },
        source: "jev-verdict",
        sourceVersion: null,
        stance: "BULLISH",
        symbol: "SPY",
      })
    ).resolves.toEqual({ id: "log-1" });
    expect(inserted).toEqual([
      {
        choice: "BULLISH",
        dataAsOf: "2026-11-18",
        decidedAt: new Date("2026-11-19T11:59:00.000Z"),
        id: "log-1",
        loggedAt: now,
        model: "jev-1",
        probBearish: 0.1,
        probBullish: 0.7,
        probNeutral: 0.2,
        source: "jev-verdict",
        sourceVersion: null,
        stance: "BULLISH",
        symbol: "SPY",
      },
    ]);
  });

  it("lists rows as forecast records (schema version 1)", async () => {
    const { database } = fakeDatabase([
      {
        choice: null,
        dataAsOf: null,
        decidedAt: new Date("2026-11-19T11:59:00.000Z"),
        id: "log-1",
        loggedAt: now,
        model: null,
        probBearish: 0.3,
        probBullish: 0.3,
        probNeutral: 0.4,
        source: "jev-verdict",
        sourceVersion: null,
        stance: "NEUTRAL",
        symbol: "QQQ",
      },
    ]);
    const repository = createJevVerdictLogRepository(database, deps);
    await expect(repository.listForecasts()).resolves.toEqual([
      {
        dataAsOf: null,
        decidedAt: "2026-11-19T11:59:00.000Z",
        model: null,
        probabilities: { BEARISH: 0.3, BULLISH: 0.3, NEUTRAL: 0.4 },
        schemaVersion: 1,
        source: "jev-verdict",
        sourceVersion: null,
        symbol: "QQQ",
      },
    ]);
  });

  it("has no update or delete method", () => {
    const repository = createJevVerdictLogRepository(
      fakeDatabase().database,
      deps
    );
    expect(Object.keys(repository).sort()).toEqual(["append", "listForecasts"]);
  });
});

describe("0082_jev_verdict_log migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0082_jev_verdict_log.sql");
  const rollback = read("../../rollback/0082_jev_verdict_log.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };

  it("creates the table and grants the app role read and insert only", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "jev_verdict_log" TO "vertex_research"'
    );
    expect(migration).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)/u);
    const config = getTableConfig(jevVerdictLog);
    const start = migration.indexOf('CREATE TABLE "jev_verdict_log" (');
    const body = migration.slice(start, migration.indexOf("\n);", start));
    const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect(sqlColumns.sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    for (const index of config.indexes)
      expect(migration).toContain(
        `INDEX "${index.config.name}" ON "jev_verdict_log"`
      );
  });

  it("is journal entry 82 and the rollback stops until the rows were exported", () => {
    expect(journal.entries[82]).toMatchObject({
      idx: 82,
      tag: "0082_jev_verdict_log",
    });
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/u);
    expect(rollback).toContain("\\copy (SELECT * FROM jev_verdict_log");
    expect(rollback).toMatch(
      /IF EXISTS \(SELECT 1 FROM "public"."jev_verdict_log"\)\s+AND coalesce\(current_setting\('vertex.jev_verdict_log_exported', true\), ''\) <> 'yes' THEN\s+RAISE EXCEPTION/u
    );
    expect(rollback.indexOf("RAISE EXCEPTION")).toBeLessThan(
      rollback.indexOf('DROP TABLE "public"."jev_verdict_log"')
    );
  });
});
