import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  GOLIVE_DRAFT_KINDS,
  GOLIVE_DRAFT_STATES,
  GOLIVE_ENTRY_BASES,
  GOLIVE_EXIT_REASONS,
  GOLIVE_EXIT_RULE_VALUE,
  GOLIVE_NODE_BADGES,
  GOLIVE_PLAN_APPROVAL_BASES,
  GOLIVE_PLAN_STATUSES,
  GOLIVE_STRUCTURES,
  goLiveDraftRuns,
  goLiveDrafts,
  goLivePlans,
} from "../schema/index.ts";

const TAG = "0067_golive_drafts";
const TABLES = ["golive_plans", "golive_draft_runs", "golive_drafts"];

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
  const tableBody = (name: string): string => {
    const start = migration.indexOf(`CREATE TABLE "${name}" (`);
    expect(start).toBeGreaterThanOrEqual(0);
    return migration.slice(start, migration.indexOf("\n);", start));
  };
  const list = (values: readonly string[]): string =>
    `in (${values.map((value) => `'${value}'`).join(", ")})`;

  it("only creates tables and grants the app role what the repository uses", () => {
    expect(migration).not.toMatch(
      /^\s*(TRUNCATE|UPDATE|DELETE|INSERT|DROP)\s/im
    );
    for (const table of TABLES)
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "vertex_research"`
      );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE/u);
  });

  it.each(
    [goLivePlans, goLiveDraftRuns, goLiveDrafts].map((table) =>
      getTableConfig(table)
    )
  )(
    "matches the drizzle columns, checks, keys and indexes of $name",
    (config) => {
      const body = tableBody(config.name);
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
      for (const key of config.foreignKeys)
        expect(migration).toContain(
          `ALTER TABLE "${config.name}" ADD CONSTRAINT "${key.getName()}" FOREIGN KEY ("plan_id","plan_version") REFERENCES "public"."golive_plans"("id","version") ON DELETE restrict`
        );
    }
  );

  it("keys a plan by id and version and lets one plan be in force", () => {
    expect(tableBody("golive_plans")).toContain(
      'CONSTRAINT "golive_plans_id_version_pk" PRIMARY KEY("id","version")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "golive_plans_version_idx" ON "golive_plans" USING btree ("version")'
    );
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "golive_plans_in_force_idx" ON "golive_plans" USING btree ("exit_rule") WHERE "golive_plans"."status" in ('proposed', 'approved')`
    );
    expect(getTableConfig(goLiveDrafts).foreignKeys).toHaveLength(1);
    expect(getTableConfig(goLiveDraftRuns).foreignKeys).toHaveLength(1);
  });

  it("checks the same value lists as the schema constants", () => {
    const plans = tableBody("golive_plans");
    expect(plans).toContain(`"status" ${list(GOLIVE_PLAN_STATUSES)}`);
    expect(plans).toContain(
      `"approval_basis" ${list(GOLIVE_PLAN_APPROVAL_BASES)}`
    );
    expect(plans).toContain(`"exit_rule" = '${GOLIVE_EXIT_RULE_VALUE}'`);
    const drafts = tableBody("golive_drafts");
    expect(drafts).toContain(`"kind" ${list(GOLIVE_DRAFT_KINDS)}`);
    expect(drafts).toContain(`"structure" ${list(GOLIVE_STRUCTURES)}`);
    expect(drafts).toContain(`"state" ${list(GOLIVE_DRAFT_STATES)}`);
    expect(drafts).toContain(`"entry_basis" ${list(GOLIVE_ENTRY_BASES)}`);
    expect(drafts).toContain(`"exit_reason" ${list(GOLIVE_EXIT_REASONS)}`);
    expect(drafts).toContain(
      `"node_badge_at_decision" ${list(GOLIVE_NODE_BADGES)}`
    );
    expect(drafts).toContain(`"exit_rule" = '${GOLIVE_EXIT_RULE_VALUE}'`);
  });

  it("ties approval fields to the plan status and decision fields to the draft state", () => {
    const plans = tableBody("golive_plans");
    expect(plans).toContain(
      `("golive_plans"."status" <> 'proposed' or "golive_plans"."approval_basis" is null)`
    );
    expect(plans).toContain(
      `("golive_plans"."status" <> 'approved' or ("golive_plans"."approval_basis" is not null and "golive_plans"."owner_message_url" is not null and "golive_plans"."approved_by" is not null and "golive_plans"."approved_at" is not null))`
    );
    expect(plans).toContain(
      `("golive_plans"."approval_basis" is distinct from 'owner_delegation' or "golive_plans"."evidence_url" is not null)`
    );
    const drafts = tableBody("golive_drafts");
    expect(drafts).toContain(
      `("golive_drafts"."kind" <> 'entry' or ("golive_drafts"."entry_basis" is not null and "golive_drafts"."exit_reason" is null and "golive_drafts"."parent_draft_id" is null))`
    );
    expect(drafts).toContain(
      `("golive_drafts"."kind" <> 'exit' or ("golive_drafts"."exit_reason" is not null and "golive_drafts"."entry_basis" is null and "golive_drafts"."parent_draft_id" is not null))`
    );
    expect(drafts).toContain(
      `("golive_drafts"."state" in ('approved', 'rejected')) = ("golive_drafts"."decided_by" is not null) and ("golive_drafts"."state" in ('approved', 'rejected')) = ("golive_drafts"."decided_at" is not null)`
    );
  });

  it("stores an approved order exactly when the draft is approved", () => {
    const drafts = tableBody("golive_drafts");
    // Nullable and without a default: only an approval writes it.
    expect(drafts).toMatch(/^\s+"approved_order" jsonb,$/mu);
    expect(drafts).toContain(
      `CONSTRAINT "golive_drafts_approved_order_check" CHECK (("golive_drafts"."state" = 'approved') = ("golive_drafts"."approved_order" is not null) and ("golive_drafts"."approved_order" is null or jsonb_typeof("golive_drafts"."approved_order") = 'object'))`
    );
    const config = getTableConfig(goLiveDrafts);
    const column = config.columns.find(
      (entry) => entry.name === "approved_order"
    );
    expect(column?.getSQLType()).toBe("jsonb");
    expect(column?.notNull).toBe(false);
    expect(column?.hasDefault).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain(
      "golive_drafts_approved_order_check"
    );
  });

  it("gives every draft a revision above 0 that starts at 1", () => {
    const drafts = tableBody("golive_drafts");
    expect(drafts).toMatch(/^\s+"revision" integer DEFAULT 1 NOT NULL,$/mu);
    expect(drafts).toContain(
      'CONSTRAINT "golive_drafts_revision_check" CHECK ("golive_drafts"."revision" > 0)'
    );
    const config = getTableConfig(goLiveDrafts);
    const column = config.columns.find((entry) => entry.name === "revision");
    expect(column?.getSQLType()).toBe("integer");
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(1);
    expect(config.checks.map((check) => check.name)).toContain(
      "golive_drafts_revision_check"
    );
    // Only the drafts table has it: a plan gets a new version, and a run row is replaced.
    for (const table of ["golive_plans", "golive_draft_runs"])
      expect(tableBody(table)).not.toContain('"revision"');
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

  it("has a rollback that refuses while an approved draft exists and never cascades", () => {
    expect(rollback).toContain(
      `IF EXISTS (SELECT 1 FROM "public"."golive_drafts" WHERE "state" = 'approved') THEN`
    );
    expect(rollback).toContain(
      "RAISE EXCEPTION 'golive_drafts has an approved draft"
    );
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE|IF EXISTS "/u);
    for (const table of TABLES)
      expect(rollback).toContain(`DROP TABLE "public"."${table}";`);
    // The plans table is the foreign-key target, so it is dropped last.
    expect(
      rollback.indexOf('DROP TABLE "public"."golive_plans"')
    ).toBeGreaterThan(
      rollback.indexOf('DROP TABLE "public"."golive_draft_runs"')
    );
    // The approved_order column and its check go with the table: no separate statement. Only an
    // approved draft holds an order, and an approved draft blocks the rollback above.
    expect(rollback).not.toMatch(/ALTER TABLE|approved_order|revision/u);
  });
});
