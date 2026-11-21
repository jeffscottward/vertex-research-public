import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Data migration 0084: the flow control term texts after the streamed tape (pull request #328, migration 0083).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const seed = read("../../migrations/0081_semantic_terms_flow_control.sql");
const migration = read(
  "../../migrations/0084_semantic_terms_flow_streamed_tape.sql"
);
const rollback = read(
  "../../rollback/0084_semantic_terms_flow_streamed_tape.down.sql"
);
const journal = JSON.parse(read("../../migrations/meta/_journal.json")) as {
  entries: { idx: number; tag: string }[];
};

const TERM_IDS = ["futures_deep_trades", "flow_control_state"];
/** The five operator-mark conditions as [text before the column, column, text after it]. */
const MARK_PARTS = [
  ["", "updated_by", " IS NULL"],
  ["NOT ", "certified", ""],
  ["", "certified_at", " IS NULL"],
  ["", "certified_by", " IS NULL"],
  ["", "certification_note", " IS NULL"],
] as const;
/** The conditions as the migration writes them (`"column"`) and as the rollback does (`t."column"`). */
const MARKS = MARK_PARTS.map(
  ([before, column, after]) => `${before}"${column}"${after}`
);
const ROLLBACK_MARKS = MARK_PARTS.map(
  ([before, column, after]) => `${before}t."${column}"${after}`
);

const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const unquote = (value?: string) => (value ?? "").replaceAll("''", "'");

/** The description of `id` in the 0081 seed (third quoted value of its row). */
const seededDescription = (id: string): string =>
  unquote(
    new RegExp(`\\('${id}', '(?:[^']|'')+', '((?:[^']|'')+)', `, "u").exec(
      seed
    )?.[1]
  );

const UPDATE =
  /UPDATE "semantic_terms"\nSET "description" = '((?:[^']|'')+)', "updated_at" = now\(\)\nWHERE "id" = '([a-z_]+)' AND md5\("description"\) = '([0-9a-f]{32})'\n {2}AND ([^;]+);/gu;
const updates = [...migration.matchAll(UPDATE)].map((match) => ({
  description: unquote(match[1]),
  guard: match[4] ?? "",
  hash: match[3] ?? "",
  id: match[2] ?? "",
}));
const descriptionOf = (id: string): string =>
  updates.find((update) => update.id === id)?.description ?? "";

/** Mirrors FLOW_NO_DATA_REASONS of packages/api/src/contracts/flow.ts (the db package does not import the api). */
const NO_DATA_REASONS =
  "(market_closed, source_unavailable, storage_failed, stale, gap, session_start, not_collected)";

describe("0084_semantic_terms_flow_streamed_tape", () => {
  it("replaces the description of the two terms and touches no other row", () => {
    expect(updates.map((update) => update.id)).toEqual(TERM_IDS);
    expect(migration.match(/^UPDATE /gmu)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(?:INSERT|DELETE|BEGIN|COMMIT)\b/u);
  });

  it("updates a row only while it has the 0081 text and no operator mark", () => {
    for (const { guard, hash, id } of updates) {
      expect(seededDescription(id).length).toBeGreaterThan(0);
      expect(hash).toBe(md5(seededDescription(id)));
      expect(guard.replaceAll(/\s+/gu, " ")).toBe(MARKS.join(" AND "));
    }
  });

  it("keeps each description within the schema check and the terms_query answer limit", () => {
    for (const { description } of updates) {
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(2000);
      // terms_query answers "Not available. <description>" within the same 2000-character limit.
      expect(`Not available. ${description}`.length).toBeLessThanOrEqual(2000);
    }
  });

  it("no longer says that the futures tape is sampled or names the reason sampled_tape", () => {
    for (const id of TERM_IDS) {
      const description = descriptionOf(id);
      expect(description).not.toContain("sampled_tape");
      expect(description).not.toContain("tape is sampled");
      expect(description).not.toContain("not_comparable: it is not computed");
      expect(description).toContain("streamed");
    }
  });

  it("each description still names the tool flow_control, a sign, a horizon and a coverage statement", () => {
    for (const id of TERM_IDS) {
      const description = descriptionOf(id);
      expect(description).toContain("Call the tool flow_control");
      expect(description).toContain("Sign:");
      expect(description).toContain("Horizon:");
      expect(description).toContain("Coverage caveat:");
      expect(description).toContain("not checked against a second source");
    }
  });

  it("futures_deep_trades names both capture modes and says that sampled sums are lower bounds", () => {
    const description = descriptionOf("futures_deep_trades");
    expect(description).toContain("field capture: streamed");
    expect(description).toContain("field capture: sampled");
    expect(description).toContain("lower bounds");
    expect(description).toContain(
      "A minute without coverage is a gap, not zero."
    );
  });

  it("flow_control_state lists the seven no-data reasons, the entry holds and the five agreement states", () => {
    const description = descriptionOf("flow_control_state");
    expect(description).toContain(NO_DATA_REASONS);
    expect(description).toContain(
      "(few_trades, delta_against or price_against)"
    );
    expect(description).toContain(
      "agree (the same control side), diverge, one_sided, both_balanced or not_comparable"
    );
    expect(description).toContain("is null when no entry is checked");
    expect(description).toContain("futuresRules");
    expect(description).toContain("The futures side is never mixed.");
    expect(description).not.toContain("partial");
  });

  it("no description holds a rule number", () => {
    for (const id of TERM_IDS)
      for (const number of [
        "0.3",
        "0.1",
        "0.15",
        "30 min",
        "55",
        "40 contracts",
        "10 contracts",
        "50 contracts",
      ])
        expect(descriptionOf(id)).not.toContain(number);
  });

  it("has a journal entry with its tag", () => {
    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0084_semantic_terms_flow_streamed_tape"
    );
  });

  it("has a rollback that restores the 0081 text and refuses unless both rows are in the 0084 state", () => {
    for (const { description, id } of updates) {
      expect(rollback).toContain(
        `(t."id" = '${id}' AND md5(t."description") = '${md5(description)}')`
      );
      expect(rollback).toContain(
        `SET "description" = '${seededDescription(id).replaceAll("'", "''")}', "updated_at" = now()\nWHERE "id" = '${id}';`
      );
    }
    // The marks are one AND chain inside the row count of the DO block.
    expect(rollback.replaceAll(/\s+/gu, " ")).toContain(
      `) AND ${ROLLBACK_MARKS.join(" AND ")} ) <> 2 THEN`
    );
    expect(rollback).toContain("refusing rollback");
    expect(rollback.match(/^UPDATE /gmu)).toHaveLength(2);
    expect(rollback).not.toMatch(/\bDELETE\b/u);
  });
});
