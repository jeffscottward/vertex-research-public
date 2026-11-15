import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Data migration 0075: one strategy DSL sentence appended to three of the 0074 trend indicator descriptions.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const seed = read("../../migrations/0074_semantic_terms_trend_indicators.sql");
const migration = read(
  "../../migrations/0075_semantic_terms_trend_dsl_names.sql"
);
const rollback = read(
  "../../rollback/0075_semantic_terms_trend_dsl_names.down.sql"
);

const TERM_IDS = ["supertrend", "alphatrend", "chandelier_exit"];
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

/** The description of `id` in the 0074 seed (third quoted value of its row). */
const seededDescription = (id: string): string => {
  const row = new RegExp(
    `\\('${id}', '(?:[^']|'')+', '((?:[^']|'')+)', `,
    "u"
  ).exec(seed);
  return (row?.[1] ?? "").replaceAll("''", "'");
};

const UPDATE =
  /UPDATE "semantic_terms"\nSET "description" = "description" \|\| '((?:[^']|'')+)', "updated_at" = now\(\)\nWHERE "id" = '([a-z_]+)' AND md5\("description"\) = '([0-9a-f]{32})'\n {2}AND ([^;]+);/gu;
const updates = [...migration.matchAll(UPDATE)].map((match) => ({
  appended: match[1] ?? "",
  guard: match[4] ?? "",
  hash: match[3] ?? "",
  id: match[2] ?? "",
}));

describe("0075_semantic_terms_trend_dsl_names", () => {
  it("appends one sentence to each of the three terms and to no other row", () => {
    expect(updates.map((update) => update.id)).toEqual(TERM_IDS);
    expect(migration.match(/^UPDATE /gmu)).toHaveLength(3);
    expect(migration).not.toMatch(/\b(?:INSERT|DELETE|BEGIN|COMMIT)\b/u);
    for (const { appended } of updates) {
      // One leading space joins the sentence to the 0074 text; no quote needs SQL escaping.
      expect(appended).toMatch(/^ In the strategy DSL it is the indicator "/u);
      expect(appended).not.toContain("'");
    }
  });

  it("updates a row only while it has the 0074 text and no operator mark", () => {
    expect(updates).toHaveLength(3);
    for (const { guard, hash, id } of updates) {
      expect(hash).toBe(md5(seededDescription(id)));
      expect(guard.replaceAll(/\s+/gu, " ")).toBe(MARKS.join(" AND "));
    }
  });

  it("keeps each description within the schema check", () => {
    expect(updates).toHaveLength(3);
    for (const { appended, id } of updates) {
      const length = (seededDescription(id) + appended).length;
      expect(length).toBeGreaterThan(seededDescription(id).length);
      expect(length).toBeLessThanOrEqual(2000);
    }
  });

  it("has a rollback that removes the same sentence and refuses unless all three rows are in the 0075 state", () => {
    expect(updates).toHaveLength(3);
    for (const { appended, id } of updates) {
      expect(rollback).toContain(
        `(t."id" = '${id}' AND md5(t."description") = '${md5(seededDescription(id) + appended)}')`
      );
      expect(rollback).toContain(
        `SET "description" = left("description", length("description") - length('${appended}')), "updated_at" = now()\nWHERE "id" = '${id}';`
      );
    }
    // The marks are one AND chain inside the row count of the DO block.
    expect(rollback.replaceAll(/\s+/gu, " ")).toContain(
      `) AND ${ROLLBACK_MARKS.join(" AND ")} ) <> 3 THEN`
    );
    expect(rollback).toContain("refusing rollback");
    expect(rollback.match(/^UPDATE /gmu)).toHaveLength(3);
    expect(rollback).not.toMatch(/\bDELETE\b/u);
  });
});
