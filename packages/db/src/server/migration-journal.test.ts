import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drizzle applies a journal entry only when its `when` is newer than the last applied one, so an
// entry whose `when` is not strictly newer (for example after two branches both take the same number
// and are merged) is skipped silently. These checks fail the merge instead. Per-migration tests check
// their own SQL, not their journal position: the order is checked here only.

type JournalEntry = Readonly<{ idx: number; tag: string; when: number }>;

const FIX =
  "after merging the base branch, run `pnpm db:renumber` (see CONVENTIONS.md, Migration numbers)";
const migrations = new URL("../../migrations/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrations), "utf8")
) as { entries: JournalEntry[] };

describe("migration journal", () => {
  it("numbers entries 0..n with matching tag prefixes and unique numbers", () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx, FIX).toBe(index);
      expect(entry.tag, FIX).toMatch(
        new RegExp(`^${String(index).padStart(4, "0")}_[a-z0-9_]+$`, "u")
      );
    });
  });

  it("has strictly increasing when values", () => {
    const late = journal.entries.filter(
      (entry, index) =>
        index > 0 && entry.when <= (journal.entries[index - 1]?.when ?? 0)
    );
    expect(
      late.map((entry) => entry.tag),
      FIX
    ).toEqual([]);
  });

  it("has exactly one SQL file per entry and no other SQL files", () => {
    const files = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files, FIX).toEqual(
      journal.entries.map((entry) => `${entry.tag}.sql`).sort()
    );
  });

  it("chains every snapshot to the one before it", () => {
    // drizzle-kit generate diffs against this chain; two snapshots with one prevId break it.
    const snapshots = readdirSync(new URL("meta/", migrations))
      .filter((name) => /^\d{4}_snapshot\.json$/u.test(name))
      .sort()
      .map((name) => ({
        name,
        ...(JSON.parse(
          readFileSync(new URL(`meta/${name}`, migrations), "utf8")
        ) as { id: string; prevId: string }),
      }));
    const broken = snapshots
      .slice(1)
      .filter((snapshot, offset) => snapshot.prevId !== snapshots[offset]?.id)
      .map((snapshot) => snapshot.name);
    expect(broken, FIX).toEqual([]);
  });
});
