import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Data migration 0081: agent vocabulary (source "none", not certified) for flow control. These cases pin the seed text
// of 0081, which never changes; migration 0084 replaces the texts of futures_deep_trades and flow_control_state after
// the streamed tape (semantic-terms-flow-streamed-tape-migration.test.ts).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../migrations/0081_semantic_terms_flow_control.sql");
const rollback = read(
  "../../rollback/0081_semantic_terms_flow_control.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};

const TERM_IDS = [
  "options_net_drift",
  "futures_deep_trades",
  "flow_control_state",
];

const ROW =
  /\('([a-z][a-z0-9_]{1,62})', '((?:[^']|'')+)', '((?:[^']|'')+)', '(\[[^\]]*\])'::jsonb, '([a-z]+)', null, '\[\]'::jsonb, '((?:[^']|'')+)', '\[\]'::jsonb, (true|false)\)/g;
const rows = [...migration.matchAll(ROW)];
const text = (value?: string) => value?.replaceAll("''", "'") ?? "";
const descriptionOf = (id: string): string =>
  text(rows.find((row) => row[1] === id)?.[3]);
const synonymsOf = (id: string): string[] =>
  JSON.parse(rows.find((row) => row[1] === id)?.[4] ?? "[]") as string[];

describe("0081_semantic_terms_flow_control", () => {
  it("seeds exactly the three uncertified terms with source none within the schema check", () => {
    expect(rows.map((row) => row[1])).toEqual(TERM_IDS);
    for (const [
      ,
      ,
      label,
      description,
      synonyms,
      source,
      unit,
      certified,
    ] of rows) {
      expect(source).toBe("none");
      expect(certified).toBe("false");
      expect(text(label).length).toBeGreaterThanOrEqual(1);
      expect(text(label).length).toBeLessThanOrEqual(120);
      expect(text(unit).length).toBeGreaterThanOrEqual(1);
      expect(text(unit).length).toBeLessThanOrEqual(40);
      expect(text(description).length).toBeGreaterThanOrEqual(1);
      expect(text(description).length).toBeLessThanOrEqual(2000);
      const names = JSON.parse(synonyms ?? "null") as unknown;
      expect(Array.isArray(names)).toBe(true);
      for (const name of names as unknown[]) {
        expect(typeof name).toBe("string");
        expect(String(name).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("each description names the tool flow_control, a sign, a horizon and a coverage statement", () => {
    for (const id of TERM_IDS) {
      const description = descriptionOf(id);
      expect(description).toContain("flow_control");
      expect(description).toContain("Sign:");
      expect(description).toContain("Horizon:");
      expect(description).toContain("Coverage");
    }
  });

  it("flow_control_state says the futures state needs the full tape, is no_data sampled_tape until then, and the agreement is not_comparable", () => {
    const description = descriptionOf("flow_control_state");
    expect(description).toContain(
      "The futures state needs the full futures tape"
    );
    expect(description).toContain(
      "the futures side is no_data with the reason sampled_tape"
    );
    expect(description).toContain("not_comparable");
  });

  it("flow_control_state lists the eight no-data reasons and not partial", () => {
    const description = descriptionOf("flow_control_state");
    expect(description).toContain(
      "(market_closed, source_unavailable, storage_failed, stale, gap, session_start, sampled_tape, not_collected)"
    );
    expect(description).not.toContain("partial");
  });

  it("options_net_drift says it is not drift_level and has no bare drift synonym", () => {
    expect(descriptionOf("options_net_drift")).toContain(
      "This is not drift_level"
    );
    for (const id of TERM_IDS) expect(synonymsOf(id)).not.toContain("drift");
  });

  it("no description holds a rule number", () => {
    for (const id of TERM_IDS)
      for (const number of [
        "0.3",
        "0.1",
        "0.15",
        "30 min",
        "40 contracts",
        "10 contracts",
        "50 contracts",
      ])
        expect(descriptionOf(id)).not.toContain(number);
  });

  it("never overwrites an existing term", () => {
    expect(migration).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0081_semantic_terms_flow_control"
    );
  });

  it("has a guarded rollback that refuses on operator work and deletes only these terms", () => {
    const ids = TERM_IDS.map((id) => `'${id}'`).join(", ");
    expect(rollback).toContain(
      `DELETE FROM "public"."semantic_terms" WHERE "id" IN (${ids});`
    );
    expect(rollback).toContain(`t."id" IN (${ids})`);
    expect(rollback).toContain('"public"."semantic_sql_attributes"');
    expect(rollback).toContain('t."updated_by" IS NOT NULL');
    expect(rollback).toContain('t."certified"');
    expect(rollback).toContain('t."certified_at" IS NOT NULL');
    expect(rollback).toContain('t."certified_by" IS NOT NULL');
    expect(rollback).toContain('t."certification_note" IS NOT NULL');
    expect(rollback).not.toMatch(/\bCASCADE\s*;/u);
    expect(rollback).toContain(
      "flow control terms have operator edits or linked rows; refusing rollback"
    );
  });
});
