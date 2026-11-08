import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  flowBook,
  flowEvents,
  flowGex,
  flowMinutes,
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
