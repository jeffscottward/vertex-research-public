import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  FLOW_OPTION_TICKER_VALUES,
  FLOW_SOURCE_VALUES,
  FLOW_SYMBOL_VALUES,
  flowBook,
  flowEvents,
  flowGex,
  flowLargeTrades,
  flowMinutes,
  flowNetDrift,
  flowOptionGaps,
  flowOptionPrints,
  flowSamples,
} from "../schema/index.ts";

const TABLES = [
  flowSamples,
  flowMinutes,
  flowBook,
  flowOptionPrints,
  flowEvents,
  flowGex,
];

describe("0052_flow_pipeline migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0052_flow_pipeline.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0052_flow_pipeline.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("only creates tables and grants the app role what the flow repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_samples", "flow_minutes", "flow_book", "flow_option_prints", "flow_events", "flow_gex" TO "vertex_research"'
    );
  });

  it.each(TABLES.map((table) => getTableConfig(table)))(
    "matches the drizzle columns, checks and indexes of $name",
    (config) => {
      const start = migration.indexOf(`CREATE TABLE "${config.name}" (`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf("\n);", start));
      const sqlColumns = [...body.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
        (match) => match[1]
      );
      expect([...sqlColumns].sort()).toEqual(
        config.columns.map((column) => column.name).sort()
      );
      for (const check of config.checks)
        expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
      for (const index of config.indexes)
        expect(migration).toContain(
          `INDEX "${index.config.name}" ON "${config.name}"`
        );
    }
  );

  it("is the 53rd journal entry and the rollback drops only the flow tables", () => {
    expect(journal.entries[52]).toMatchObject({
      idx: 52,
      tag: "0052_flow_pipeline",
    });
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    const drops = [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)];
    expect(drops.map((match) => match[1]).sort()).toEqual(
      TABLES.map((table) => getTableConfig(table).name).sort()
    );
  });
});

describe("0053_flow_option_gaps migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0053_flow_option_gaps.sql");
  const rollback = read("../../rollback/0053_flow_option_gaps.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowOptionGaps);

  it("only creates flow_option_gaps and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_option_gaps"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_option_gaps" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("symbol","start_time")');
    for (const check of config.checks)
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
  });

  it("is the 54th journal entry and the rollback drops only flow_option_gaps", () => {
    expect(journal.entries[53]).toMatchObject({
      idx: 53,
      tag: "0053_flow_option_gaps",
    });
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_option_gaps"]);
  });
});

describe("0077_flow_net_drift migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0077_flow_net_drift.sql");
  const rollback = read("../../rollback/0077_flow_net_drift.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowNetDrift);
  const CHECKS = [
    "flow_book_check",
    "flow_events_check",
    "flow_gex_check",
    "flow_minutes_check",
    "flow_option_gaps_check",
    "flow_option_prints_check",
    "flow_samples_check",
  ];
  const addText = (name: string): string => {
    const line = migration
      .split("\n")
      .find((entry) => entry.includes(`ADD CONSTRAINT "${name}" CHECK`));
    if (line === undefined) throw new Error(`no ADD for ${name}`);
    return line;
  };

  it("creates flow_net_drift, replaces the seven checks and changes no row", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT)\s|DROP TABLE/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_net_drift"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_net_drift" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of flow_net_drift", () => {
    const create = migration.slice(0, migration.indexOf(");"));
    const sqlColumns = [...create.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("ticker","part","minute")');
    expect(config.checks.map((check) => check.name)).toEqual([
      "flow_net_drift_check",
    ]);
    expect(migration).toContain('CONSTRAINT "flow_net_drift_check" CHECK');
  });

  it("drops and adds each of the seven checks with the four symbols", () => {
    for (const name of CHECKS) {
      expect(migration.split(`DROP CONSTRAINT "${name}"`).length - 1).toBe(1);
      expect(migration.split(`ADD CONSTRAINT "${name}"`).length - 1).toBe(1);
      expect(addText(name)).toContain("'QQQ', 'NQ'");
    }
    expect(addText("flow_gex_check")).toContain("'NDX'");
    expect(addText("flow_option_prints_check")).toContain("'NDX'");
    expect(addText("flow_samples_check")).toContain("'net_drift'");
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0077_flow_net_drift"
    );
  });

  it("every schema symbol, ticker and source value is in the check text of the migration", () => {
    for (const symbol of FLOW_SYMBOL_VALUES)
      expect(addText("flow_samples_check")).toContain(`'${symbol}'`);
    for (const ticker of FLOW_OPTION_TICKER_VALUES) {
      expect(addText("flow_gex_check")).toContain(`'${ticker}'`);
      expect(addText("flow_option_prints_check")).toContain(`'${ticker}'`);
    }
    for (const source of FLOW_SOURCE_VALUES)
      expect(addText("flow_samples_check")).toContain(`'${source}'`);
  });

  it("the rollback restores the old checks, drops only flow_net_drift and deletes no row", () => {
    expect(rollback).not.toMatch(
      /CASCADE|TRUNCATE|IF EXISTS "|^\s*DELETE\s/imu
    );
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_net_drift"]);
    for (const name of CHECKS) {
      const add = rollback
        .split("\n")
        .find((line) => line.includes(`ADD CONSTRAINT "${name}" CHECK`));
      expect(add).toContain("in ('SPY', 'ES')");
      expect(add).not.toContain("QQQ");
      expect(rollback).toContain(`DROP CONSTRAINT "${name}";`);
    }
  });
});

describe("0078_flow_large_trades migration", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const migration = read("../../migrations/0078_flow_large_trades.sql");
  const rollback = read("../../rollback/0078_flow_large_trades.down.sql");
  const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const config = getTableConfig(flowLargeTrades);

  it("only creates flow_large_trades and grants the app role", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP|ALTER)\s/im
    );
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    ).toEqual(["flow_large_trades"]);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_large_trades" TO "vertex_research"'
    );
  });

  it("matches the drizzle columns, key and check of flow_large_trades", () => {
    const sqlColumns = [...migration.matchAll(/^\s+"([a-z_0-9]+)" /gm)].map(
      (match) => match[1]
    );
    expect([...sqlColumns].sort()).toEqual(
      config.columns.map((column) => column.name).sort()
    );
    expect(migration).toContain('PRIMARY KEY("symbol","second","seq")');
    expect(config.checks.map((check) => check.name)).toEqual([
      "flow_large_trades_check",
    ]);
    for (const check of config.checks)
      expect(migration).toContain(`CONSTRAINT "${check.name}" CHECK`);
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0078_flow_large_trades"
    );
  });

  it("the rollback drops only flow_large_trades, without cascade", () => {
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS/u);
    expect(
      [...rollback.matchAll(/^DROP TABLE "public"\."(\w+)";$/gmu)].map(
        (match) => match[1]
      )
    ).toEqual(["flow_large_trades"]);
  });
});
