import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { generateDrizzleJson } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import * as schema from "../schema/index.ts";

// Drizzle applies a journal entry only when its `when` is newer than the last applied one, so an
// entry whose `when` is not strictly newer (for example after two branches both take the same number
// and are merged) is skipped silently. These checks fail the merge instead. Per-migration tests check
// their own SQL, not their journal position: the order is checked here only.
// The last check compares the newest snapshot with the schema: `drizzle-kit generate` writes the
// next migration from their difference, so a snapshot that differs gives a wrong migration.

type JournalEntry = Readonly<{ idx: number; tag: string; when: number }>;

const FIX =
  "after merging the base branch, run `pnpm db:renumber` (see CONVENTIONS.md, Migration numbers)";
const SNAPSHOT_FIX =
  "the newest snapshot does not match packages/db/src/schema. The diff shows the entries that differ: `-` lines are the schema (Expected), `+` lines are the snapshot (Received). If no migration makes the change yet, run `pnpm db:generate` and commit the migration. If a migration already makes the change, correct the entries in the newest snapshot until they match the schema, and do not commit a generated migration that repeats existing SQL (see CONVENTIONS.md, Migration numbers)";
const migrations = new URL("../../migrations/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrations), "utf8")
) as { entries: JournalEntry[] };

type Snapshot = Readonly<Record<string, unknown>>;

// `id` and `prevId` identify a snapshot file. `_meta` is drizzle-kit's rename record of one
// `generate` run (always empty for PostgreSQL in drizzle-kit 0.31.11). None of them is schema
// content.
const NOT_SCHEMA = new Set(["id", "prevId", "_meta"]);

const snapshotNames = (): string[] =>
  readdirSync(new URL("meta/", migrations))
    .filter((name) => /^\d{4}_snapshot\.json$/u.test(name))
    .sort();

const isMap = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The schema content of a drizzle-kit snapshot as one flat map. An entry of an object section is
// named "<section>.<name>", for example "tables.public.market_notes"; another value is named
// "<section>".
const schemaEntries = (snapshot: Snapshot): Snapshot =>
  Object.fromEntries(
    Object.entries(snapshot)
      .filter(([section]) => !NOT_SCHEMA.has(section))
      .flatMap(([section, value]): [string, unknown][] =>
        isMap(value)
          ? Object.entries(value).map(([name, entry]) => [
              `${section}.${name}`,
              entry,
            ])
          : [[section, value]]
      )
  );

// The entries that differ between the schema and a snapshot file: their names, and each side with
// its own content, so a failed comparison shows these entries and not the whole snapshot.
const snapshotDrift = (
  fromSchema: Snapshot,
  fromFile: Snapshot
): { names: string[]; schema: Snapshot; snapshot: Snapshot } => {
  const schemaSide = schemaEntries(fromSchema);
  const fileSide = schemaEntries(fromFile);
  const names = [
    ...new Set([...Object.keys(schemaSide), ...Object.keys(fileSide)]),
  ]
    .filter((name) => !isDeepStrictEqual(schemaSide[name], fileSide[name]))
    .sort();
  const only = (side: Snapshot): Snapshot =>
    Object.fromEntries(
      names.filter((name) => name in side).map((name) => [name, side[name]])
    );
  return { names, schema: only(schemaSide), snapshot: only(fileSide) };
};

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
    const snapshots = snapshotNames().map((name) => ({
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

  it("keeps the newest snapshot equal to the schema", () => {
    // drizzle-kit generate writes the next migration from the difference between the schema and
    // this snapshot, so a snapshot that lacks a table makes the next migration create it again.
    const newest = snapshotNames().at(-1);
    if (newest === undefined) {
      throw new Error("packages/db/migrations/meta has no snapshot file");
    }
    const fromFile = JSON.parse(
      readFileSync(new URL(`meta/${newest}`, migrations), "utf8")
    ) as Snapshot;
    // No `casing`, because packages/db/drizzle.config.ts sets none: a `casing` that is added there
    // must be passed here too (`drizzle-kit generate` reads no filter option). The JSON round trip
    // drops the keys whose value is undefined, as the snapshot file does.
    const fromSchema = JSON.parse(
      JSON.stringify(generateDrizzleJson(schema))
    ) as Snapshot;
    const drift = snapshotDrift(fromSchema, fromFile);
    expect(
      drift.snapshot,
      `${SNAPSHOT_FIX}. Entries that differ: ${drift.names.join(", ")}`
    ).toEqual(drift.schema);
  });
});

describe("snapshotDrift", () => {
  const table = (notNull: boolean) => ({
    columns: { id: { name: "id", notNull } },
  });
  const snapshot = (
    id: string,
    tables: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => ({ id, prevId: `${id}-previous`, tables, version: "7", ...extra });

  it("reports nothing for the same content under different ids and rename records", () => {
    expect(
      snapshotDrift(
        snapshot("schema", { "public.a": table(true) }),
        snapshot(
          "file",
          { "public.a": table(true) },
          { _meta: { columns: { '"public"."a"."old"': '"public"."a"."id"' } } }
        )
      )
    ).toEqual({ names: [], schema: {}, snapshot: {} });
  });

  it("gives the schema side of a table that the snapshot lacks", () => {
    expect(
      snapshotDrift(
        snapshot("schema", {
          "public.a": table(true),
          "public.b": table(true),
        }),
        snapshot("file", { "public.a": table(true) })
      )
    ).toEqual({
      names: ["tables.public.b"],
      schema: { "tables.public.b": table(true) },
      snapshot: {},
    });
  });

  it("gives the snapshot side of a table that only the snapshot has", () => {
    expect(
      snapshotDrift(
        snapshot("schema", { "public.a": table(true) }),
        snapshot("file", { "public.a": table(true), "public.b": table(true) })
      )
    ).toEqual({
      names: ["tables.public.b"],
      schema: {},
      snapshot: { "tables.public.b": table(true) },
    });
  });

  it("gives both sides of a changed table and of a changed plain value", () => {
    expect(
      snapshotDrift(
        snapshot("schema", { "public.a": table(true) }),
        snapshot("file", { "public.a": table(false) }, { version: "8" })
      )
    ).toEqual({
      names: ["tables.public.a", "version"],
      schema: { "tables.public.a": table(true), version: "7" },
      snapshot: { "tables.public.a": table(false), version: "8" },
    });
  });

  it("names an entry of a section that only one side has", () => {
    expect(
      snapshotDrift(
        snapshot(
          "schema",
          { "public.a": table(true) },
          { enums: { "public.e": {} } }
        ),
        snapshot("file", { "public.a": table(true) })
      )
    ).toEqual({
      names: ["enums.public.e"],
      schema: { "enums.public.e": {} },
      snapshot: {},
    });
  });
});
