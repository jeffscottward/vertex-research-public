import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { signalAlertEvents, signalAlertRules } from "../schema/index.ts";

describe("0049_signal_alerts migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0049_signal_alerts.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0049_signal_alerts.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; tag: string }[] };

  it("only creates tables and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signal_alert_rules" TO "vertex_research"'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "signal_alert_events" TO "vertex_research"'
    );
  });

  it.each(
    [signalAlertRules, signalAlertEvents].map((table) => getTableConfig(table))
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
    for (const check of config.checks)
      expect(body).toContain(`CONSTRAINT "${check.name}" CHECK`);
    for (const index of config.indexes)
      expect(migration).toContain(
        `INDEX "${index.config.name}" ON "${config.name}"`
      );
  });

  it("is the 50th journal entry and the rollback refuses while rules exist", () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 49,
      tag: "0049_signal_alerts",
    });
    expect(rollback).toContain(
      "RAISE EXCEPTION 'signal_alert_rules is not empty"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    expect(
      rollback.indexOf('DROP TABLE "public"."signal_alert_events"')
    ).toBeLessThan(
      rollback.indexOf('DROP TABLE "public"."signal_alert_rules"')
    );
  });
});
