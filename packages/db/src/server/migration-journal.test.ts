import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drizzle applies a journal entry only when its `when` is newer than the last applied one, so an
// entry whose `when` is not strictly newer (for example after two branches both take the same number
// and are merged) is skipped silently. These checks fail the merge instead.

type JournalEntry = Readonly<{ idx: number; tag: string; when: number }>;

const migrations = new URL("../../migrations/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrations), "utf8")
) as { entries: JournalEntry[] };

describe("migration journal", () => {
  it("numbers entries 0..n with matching tag prefixes and unique numbers", () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(entry.tag).toMatch(
        new RegExp(`^${String(index).padStart(4, "0")}_[a-z0-9_]+$`, "u")
      );
    });
  });

  it("has strictly increasing when values", () => {
    const late = journal.entries.filter(
      (entry, index) =>
        index > 0 && entry.when <= (journal.entries[index - 1]?.when ?? 0)
    );
    expect(late.map((entry) => entry.tag)).toEqual([]);
  });

  it("has exactly one SQL file per entry and no other SQL files", () => {
    const files = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files).toEqual(
      journal.entries.map((entry) => `${entry.tag}.sql`).sort()
    );
  });
});
