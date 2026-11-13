import { readFileSync } from "node:fs";

import {
  createMarketNotesRepository,
  createNodeDatabase,
  type Database,
  type MarketNoteNewRecord,
  type MarketNotesRepository,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Owner market notes against real Postgres: the insert-once rule, the row lock of a check, the
// active read (filtered before the row limit), the table checks and the guarded rollback.

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0072_market_notes.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0072_market_notes.down.sql"
);

const NOW = new Date("2026-11-11T14:00:00.000Z");
const TODAY = "2026-11-11";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const repository = (): MarketNotesRepository => {
  if (resource === undefined) throw new Error("Database not started");
  return createMarketNotesRepository(resource.db, { now: () => NOW });
};

const claim = (index: number) => ({
  checkedAt: null,
  evidence: null,
  id: `c${index}`,
  status: "unverified" as const,
  text: `Claim ${index}`,
});

const newNote = (
  sourceKey: string,
  overrides: Partial<MarketNoteNewRecord> = {}
): MarketNoteNewRecord => ({
  affected: { sectors: ["Semiconductors"], strategies: [], tickers: ["NVDA"] },
  asOf: "2026-11-10",
  claims: [claim(1), claim(2)],
  ownerMessageUrl: null,
  rawText: "Invented text of a note.",
  receivedAt: NOW,
  reviewBy: "2026-11-24",
  sourceAuthor: null,
  sourceKey,
  sourceKind: "owner-text",
  sourceUrl: null,
  stance: "neutral",
  stanceConfidence: "low",
  theme: "An invented theme",
  ...overrides,
});

const rowCount = async (): Promise<number> => {
  const [row] = await postgres().query<{ count: string }>(
    'SELECT count(*) AS count FROM "market_notes"'
  );
  return Number(row?.count);
};

describe("market notes repository (Postgres)", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 8,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("stores one row when the same source is added many times at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository().insert(
          newNote("text:same-source", { theme: `Theme of writer ${index}` })
        )
      )
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.note.id)).size).toBe(1);
    // Every writer gets the stored note: the theme of the one insert that won.
    expect(new Set(results.map((result) => result.note.theme)).size).toBe(1);
    expect(await rowCount()).toBe(1);
    const stored = await repository().findBySourceKey("text:same-source");
    expect(stored).toMatchObject({
      claims: [claim(1), claim(2)],
      id: results[0]?.note.id,
      status: "active",
    });
    expect(stored).not.toHaveProperty("rawText");
    expect((await repository().get(results[0]?.note.id ?? ""))?.rawText).toBe(
      "Invented text of a note."
    );
  });

  it("keeps every check when different claims of one note are checked at once", async () => {
    const claims = Array.from({ length: 8 }, (_, index) => claim(index + 1));
    const { note } = await repository().insert(
      newNote("text:checked-at-once", { claims })
    );
    const results = await Promise.all(
      claims.map((entry, index) =>
        repository().recordChecks(note.id, [
          {
            claimId: entry.id,
            evidence: `Evidence ${index + 1}\nsecond line`,
            status: index % 2 === 0 ? "supported" : "contradicted",
          },
        ])
      )
    );
    expect(results.map((result) => result.kind)).toEqual(
      claims.map(() => "ok")
    );
    const stored = await repository().get(note.id);
    expect(stored?.claims).toEqual(
      claims.map((entry, index) => ({
        ...entry,
        checkedAt: NOW.toISOString(),
        evidence: `Evidence ${index + 1}\nsecond line`,
        status: index % 2 === 0 ? "supported" : "contradicted",
      }))
    );
    expect(stored?.updatedAt).toEqual(NOW);
    // An unknown claim id writes nothing.
    await expect(
      repository().recordChecks(note.id, [
        { claimId: "c1", evidence: "Replaced", status: "cannot-check" },
        { claimId: "c12", evidence: "No such claim", status: "supported" },
      ])
    ).resolves.toEqual({ claimId: "c12", kind: "unknown-claim" });
    expect((await repository().get(note.id))?.claims).toEqual(stored?.claims);
  });

  it("refuses checks and a renew on a retired note, and a renew before today or before the market date", async () => {
    const { note } = await repository().insert(
      newNote("text:review-rules", {
        asOf: "2026-11-12",
        reviewBy: "2026-11-20",
      })
    );
    await expect(
      repository().review(note.id, { kind: "renew", reviewBy: "2026-11-10" })
    ).resolves.toEqual({ kind: "review-date-past" });
    await expect(
      repository().review(note.id, { kind: "renew", reviewBy: TODAY })
    ).resolves.toEqual({ kind: "review-date-before-as-of" });
    await expect(
      repository().review(note.id, { kind: "renew", reviewBy: "2026-12-01" })
    ).resolves.toMatchObject({ kind: "ok", note: { reviewBy: "2026-12-01" } });
    await expect(
      repository().review(note.id, { kind: "retire" })
    ).resolves.toMatchObject({ kind: "ok", note: { status: "retired" } });
    await expect(
      repository().review(note.id, { kind: "retire" })
    ).resolves.toMatchObject({ kind: "ok", note: { status: "retired" } });
    await expect(
      repository().review(note.id, { kind: "renew", reviewBy: "2026-12-24" })
    ).resolves.toEqual({ kind: "retired" });
    await expect(
      repository().recordChecks(note.id, [
        { claimId: "c1", evidence: "Too late", status: "supported" },
      ])
    ).resolves.toEqual({ kind: "retired" });
    expect(await repository().get(note.id)).toMatchObject({
      claims: [claim(1), claim(2)],
      reviewBy: "2026-12-01",
      status: "retired",
    });
    await expect(
      repository().review("no-such-note", { kind: "retire" })
    ).resolves.toEqual({ kind: "not-found" });
  });

  it("still returns an old active note after 55 newer notes that are retired or expired", async () => {
    await postgres().query('DELETE FROM "market_notes"');
    const old = await repository().insert(
      newNote("text:old-active", {
        receivedAt: new Date("2026-10-01T10:00:00.000Z"),
        theme: "The old active note",
      })
    );
    for (let index = 0; index < 55; index += 1) {
      const expired = index % 5 === 0;
      const { note } = await repository().insert(
        newNote(`text:newer-${index}`, {
          asOf: "2026-10-20",
          receivedAt: new Date(NOW.getTime() - index * 60_000),
          // Every fifth note is expired (its review date is before today); the others are retired.
          reviewBy: expired ? "2026-11-10" : "2026-11-24",
        })
      );
      if (!expired) await repository().review(note.id, { kind: "retire" });
    }
    // Scope "all": 56 rows fit in one answer, newest first, and the old active note is the last.
    const all = await repository().list(TODAY);
    expect(all.truncated).toBe(false);
    expect(all.notes).toHaveLength(56);
    expect(all.notes.at(-1)?.id).toBe(old.note.id);
    expect(all.notes.map((note) => note.receivedAt.getTime())).toEqual(
      all.notes
        .map((note) => note.receivedAt.getTime())
        .sort((left, right) => right - left)
    );
    expect(new Set(all.notes.map((note) => note.id)).size).toBe(56);

    const active = await repository().listActive(TODAY);
    expect(active.notes.map((note) => note.id)).toEqual([old.note.id]);
    expect(active.truncated).toBe(false);
    // The review date itself is still active; the day after is not.
    expect((await repository().listActive("2026-11-24")).notes).toHaveLength(1);
    expect((await repository().listActive("2026-11-25")).notes).toEqual([]);
    // Before the review date of the expired notes, they are active too: newest first.
    const earlier = await repository().listActive("2026-11-10");
    expect(earlier.notes).toHaveLength(12);
    expect(earlier.notes.at(-1)?.id).toBe(old.note.id);
  });

  it("keeps the old active note in scope all and reports the rows that are left out", async () => {
    const old = await repository().findBySourceKey("text:old-active");
    // 50 more retired notes, each newer than every row so far: 106 rows in the store.
    for (let index = 0; index < 50; index += 1) {
      const { note } = await repository().insert(
        newNote(`text:newest-${index}`, {
          receivedAt: new Date(NOW.getTime() + (index + 1) * 60_000),
        })
      );
      await repository().review(note.id, { kind: "retire" });
    }
    expect(await rowCount()).toBe(106);
    const all = await repository().list(TODAY);
    expect(all.notes).toHaveLength(100);
    expect(all.truncated).toBe(true);
    // The old active note is guaranteed and is the last row; the other 99 rows are the newest
    // ones of any status, so the six oldest rows (expired and retired) are left out.
    expect(all.notes.at(-1)?.id).toBe(old?.id);
    expect(all.notes.at(-2)?.sourceKey).toBe("text:newer-48");
    expect(all.notes[0]?.sourceKey).toBe("text:newest-49");
    expect(new Set(all.notes.map((note) => note.id)).size).toBe(100);

    // More active notes than one active read holds: the newest 50, and truncated says so.
    await postgres().query(
      "UPDATE \"market_notes\" SET status = 'active', review_by = '2026-11-24' WHERE source_key LIKE 'text:newest-%'"
    );
    const active = await repository().listActive(TODAY);
    expect(active.notes).toHaveLength(50);
    expect(active.truncated).toBe(true);
    expect(active.notes.map((note) => note.id)).not.toContain(old?.id);
    // Scope "all" guarantees the same 50 rows as the active read; the others come by recency.
    const merged = await repository().list(TODAY);
    expect(merged.notes).toHaveLength(100);
    expect(merged.truncated).toBe(true);
    expect(
      merged.notes.slice(0, 50).every((note) => note.status === "active")
    ).toBe(true);
  });

  it("keeps an old active note in scope all after 55 newer expired notes and 50 newer retired ones", async () => {
    await postgres().query('DELETE FROM "market_notes"');
    const old = await repository().insert(
      newNote("text:old-active", {
        receivedAt: new Date("2026-10-01T10:00:00.000Z"),
      })
    );
    // 55 newer notes that are expired, not retired: their stored status is still "active".
    for (let index = 0; index < 55; index += 1)
      await repository().insert(
        newNote(`text:expired-${index}`, {
          asOf: "2026-10-20",
          receivedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
          reviewBy: "2026-11-10",
        })
      );
    // 50 retired notes that are newer still: 106 rows, more than one answer holds.
    for (let index = 0; index < 50; index += 1) {
      const { note } = await repository().insert(
        newNote(`text:retired-${index}`, {
          receivedAt: new Date(NOW.getTime() + (index + 1) * 60_000),
        })
      );
      await repository().review(note.id, { kind: "retire" });
    }
    const [stored] = await postgres().query<{ count: string }>(
      "SELECT count(*) AS count FROM \"market_notes\" WHERE status = 'active'"
    );
    expect(Number(stored?.count)).toBe(56);

    // Agents read the old note, so the card must hold it too.
    const active = await repository().listActive(TODAY);
    expect(active.notes.map((note) => note.id)).toEqual([old.note.id]);
    const all = await repository().list(TODAY);
    expect(all.notes).toHaveLength(100);
    expect(all.truncated).toBe(true);
    expect(all.notes.at(-1)?.id).toBe(old.note.id);
    // The rows left out are the six oldest expired notes.
    expect(all.notes.at(-2)?.sourceKey).toBe("text:expired-48");
    expect(new Set(all.notes.map((note) => note.id)).size).toBe(100);
  });

  it("refuses rows that the table checks do not allow", async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        affected: '{"tickers":[],"sectors":[],"strategies":[]}',
        as_of: "2026-11-10",
        claims: JSON.stringify([claim(1)]),
        id: "check-row",
        raw_text: "Text",
        received_at: NOW.toISOString(),
        review_by: "2026-11-24",
        source_key: "text:check-row",
        source_kind: "owner-text",
        source_url: null,
        stance: "neutral",
        stance_confidence: "low",
        status: "active",
        theme: "A theme",
        ...overrides,
      };
      const columns = Object.keys(row);
      return postgres().query(
        `INSERT INTO "market_notes" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row)
      );
    };
    const before = await rowCount();
    const cases: [string, Record<string, unknown>][] = [
      ["market_notes_content_check", { claims: "{}" }],
      ["market_notes_content_check", { claims: '"text"' }],
      ["market_notes_content_check", { claims: "[]" }],
      [
        "market_notes_content_check",
        {
          claims: JSON.stringify(
            Array.from({ length: 13 }, (_, index) => claim(index + 1))
          ),
        },
      ],
      ["market_notes_content_check", { affected: "[]" }],
      ["market_notes_content_check", { theme: "" }],
      ["market_notes_content_check", { theme: "t".repeat(301) }],
      ["market_notes_content_check", { review_by: "2026-11-09" }],
      ["market_notes_fields_check", { status: "expired" }],
      ["market_notes_fields_check", { source_kind: "podcast" }],
      ["market_notes_fields_check", { stance: "bullish" }],
      ["market_notes_fields_check", { stance_confidence: "certain" }],
      ["market_notes_fields_check", { raw_text: "" }],
      ["market_notes_fields_check", { raw_text: "x".repeat(200_001) }],
      ["market_notes_source_check", { source_url: "https://example.com/a" }],
      ["market_notes_source_check", { source_kind: "reel" }],
    ];
    for (const [constraint, overrides] of cases)
      await expect(
        insert(overrides),
        `${constraint} ${Object.keys(overrides).join(",")}`
      ).rejects.toThrow(constraint);
    expect(await rowCount()).toBe(before);
    // The limits themselves are allowed: 12 claims, 300 characters, review on the market date.
    await insert({
      claims: JSON.stringify(
        Array.from({ length: 12 }, (_, index) => claim(index + 1))
      ),
      review_by: "2026-11-10",
      theme: "t".repeat(300),
    });
    await expect(insert({ id: "second-id" })).rejects.toThrow(
      "market_notes_source_key_idx"
    );
    expect(await rowCount()).toBe(before + 1);
  });

  it("has a rollback that refuses while notes exist and drops the empty table", async () => {
    // This case makes its own row: it does not depend on a row of another case.
    await postgres().query('DELETE FROM "market_notes"');
    await repository().insert(newNote("text:blocks-the-rollback"));
    expect(await rowCount()).toBe(1);
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      "market_notes is not empty; refusing rollback"
    );
    // The refused rollback left its transaction open on that connection: end it.
    await postgres().query("ROLLBACK");
    expect(await rowCount()).toBe(1);

    await postgres().query('DELETE FROM "market_notes"');
    await postgres().query(rollbackSql);
    const [gone] = await postgres().query<{ name: string | null }>(
      "SELECT to_regclass('public.market_notes')::text AS name"
    );
    expect(gone?.name).toBeNull();

    // The migration applies again on the rolled-back database.
    await postgres().query(migrationSql);
    await expect(
      repository().insert(newNote("text:after-rollback"))
    ).resolves.toMatchObject({ created: true });
  });
});
