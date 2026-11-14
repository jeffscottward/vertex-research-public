import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { marketNotes } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createMarketNotesRepository,
  MARKET_NOTES_ACTIVE_LIMIT,
  MARKET_NOTES_LIST_LIMIT,
  type MarketNoteNewRecord,
  type MarketNoteRecord,
} from "./market-notes.ts";
import { DatabasePersistenceError } from "./repository-errors.ts";

const NOW = new Date("2026-11-11T14:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  columns?: Record<string, unknown>;
  conflictTarget?: unknown;
  kind: "select" | "insert" | "update";
  limit?: number;
  lock?: string;
  orderBy?: SQL[];
  returning?: Record<string, unknown>;
  scope: "database" | "transaction";
  set?: Record<string, unknown>;
  table?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued rows.
const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      for: (strength: string) => {
        operation.lock = strength;
        return chain;
      },
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      onConflictDoNothing: (config: { target: unknown }) => {
        operation.conflictTarget = config.target;
        return chain;
      },
      orderBy: (...order: SQL[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: (columns: Record<string, unknown>) => {
        operation.returning = columns;
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
      values: (values: Record<string, unknown>) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    return chain;
  };
  const handle = (scope: Operation["scope"]) => ({
    insert: (table: unknown) => builder({ kind: "insert", scope, table }),
    select: (columns?: Record<string, unknown>) =>
      builder({
        kind: "select",
        scope,
        ...(columns === undefined ? {} : { columns }),
      }),
    update: (table: unknown) => builder({ kind: "update", scope, table }),
  });
  let transactions = 0;
  const database = {
    ...handle("database"),
    transaction: async (operation: (transaction: unknown) => unknown) => {
      transactions += 1;
      return await operation(handle("transaction"));
    },
  } as unknown as Database;
  return { database, operations, transactions: () => transactions };
};

const whereOf = (operation: Operation | undefined) =>
  dialect.sqlToQuery(operation?.where as SQL);

const newNote = (
  overrides: Partial<MarketNoteNewRecord> = {}
): MarketNoteNewRecord => ({
  affected: { sectors: ["Semiconductors"], strategies: [], tickers: ["NVDA"] },
  asOf: "2026-11-10",
  claims: [
    {
      checkedAt: null,
      evidence: null,
      id: "c1",
      status: "unverified",
      text: "Breadth is narrowing",
    },
    {
      checkedAt: null,
      evidence: null,
      id: "c2",
      status: "unverified",
      text: "Semis lead the tape",
    },
  ],
  ownerMessageUrl: null,
  rawText: "Transcript of the reel.",
  receivedAt: NOW,
  reviewBy: "2026-11-24",
  sourceAuthor: "Example Analyst",
  sourceKey: "https://www.instagram.com/reel/abc",
  sourceKind: "reel",
  sourceUrl: "https://www.instagram.com/reel/abc/?igsh=x",
  stance: "risk-off",
  stanceConfidence: "medium",
  theme: "Narrow breadth under a rising index",
  ...overrides,
});

const stored = (
  overrides: Partial<MarketNoteRecord> = {}
): MarketNoteRecord => {
  const { rawText: _rawText, ...note } = newNote();
  return {
    ...note,
    createdAt: NOW,
    id: "note-1",
    status: "active",
    updatedAt: NOW,
    ...overrides,
  };
};

const repositoryFor = (database: Database) =>
  createMarketNotesRepository(database, {
    generateId: () => "note-1",
    now: () => NOW,
  });

describe("createMarketNotesRepository", () => {
  const ORDER = [
    '"market_notes"."received_at" desc',
    '"market_notes"."id" desc',
  ];
  /** Row `index` is received `index` minutes before NOW: a higher index is an older row. */
  const rowAt = (index: number, overrides: Partial<MarketNoteRecord> = {}) =>
    stored({
      id: `note-${String(index).padStart(3, "0")}`,
      receivedAt: new Date(NOW.getTime() - index * 60_000),
      ...overrides,
    });

  it("lists today's active notes and then the newest notes of any status, without raw text", async () => {
    // Two active rows: a new one and one that is older than every other row.
    const guaranteed = [rowAt(1), rowAt(900)];
    const newest = [
      rowAt(0, { status: "retired" }),
      rowAt(1),
      rowAt(2, { status: "retired" }),
    ];
    const double = createDouble([guaranteed, newest]);
    await expect(
      repositoryFor(double.database).list("2026-11-11")
    ).resolves.toEqual({
      // One answer, newest first, each row once.
      notes: [newest[0], guaranteed[0], newest[2], guaranteed[1]],
      truncated: false,
    });
    expect(MARKET_NOTES_LIST_LIMIT).toBe(100);
    expect(MARKET_NOTES_ACTIVE_LIMIT).toBe(50);
    const [active, any] = double.operations;
    expect(active?.table).toBe(marketNotes);
    // The guaranteed rows are the rows of the active read: not retired and not expired today.
    expect(whereOf(active).sql).toBe(
      '("market_notes"."status" = $1 and "market_notes"."review_by" >= $2)'
    );
    expect(whereOf(active).params).toEqual(["active", "2026-11-11"]);
    expect(active?.limit).toBe(MARKET_NOTES_ACTIVE_LIMIT);
    expect(any?.where).toBeUndefined();
    // One row more than an answer holds: it shows that older rows exist.
    expect(any?.limit).toBe(MARKET_NOTES_LIST_LIMIT + 1);
    for (const select of [active, any]) {
      expect(select?.columns).toHaveProperty("claims");
      expect(select?.columns).not.toHaveProperty("rawText");
      expect(
        select?.orderBy?.map((order) => dialect.sqlToQuery(order).sql)
      ).toEqual(ORDER);
    }
  });

  it("orders rows with one receive time by id, newest id first", async () => {
    const same = (id: string, status: "active" | "retired") =>
      stored({ id, status });
    const double = createDouble([
      [same("b", "active")],
      [same("c", "retired"), same("b", "active"), same("a", "retired")],
    ]);
    const { notes } = await repositoryFor(double.database).list("2026-11-11");
    expect(notes.map((row) => row.id)).toEqual(["c", "b", "a"]);
    const reversed = createDouble([
      [same("b", "active")],
      [same("a", "retired"), same("c", "retired")],
    ]);
    expect(
      (await repositoryFor(reversed.database).list("2026-11-11")).notes.map(
        (row) => row.id
      )
    ).toEqual(["c", "b", "a"]);
  });

  it("keeps every row of the active read and says when older rows are left out", async () => {
    // 50 old active rows, then 101 newer retired rows (the newest read is full).
    const guaranteed = Array.from({ length: 50 }, (_, index) =>
      rowAt(1000 + index)
    );
    const retired = Array.from({ length: 101 }, (_, index) =>
      rowAt(index, { status: "retired" })
    );
    const full = await repositoryFor(
      createDouble([guaranteed, retired]).database
    ).list("2026-11-11");
    expect(full.notes).toHaveLength(MARKET_NOTES_LIST_LIMIT);
    expect(full.truncated).toBe(true);
    expect(full.notes.slice(0, 50)).toEqual(retired.slice(0, 50));
    expect(full.notes.slice(50)).toEqual(guaranteed);

    // Exactly 100 rows in the store: all of them are in the answer.
    const exact = await repositoryFor(
      createDouble([guaranteed, [...retired.slice(0, 50), ...guaranteed]])
        .database
    ).list("2026-11-11");
    expect(exact.notes).toHaveLength(100);
    expect(exact.truncated).toBe(false);

    // 101 rows, none active: the oldest one is left out.
    const noActive = await repositoryFor(
      createDouble([[], retired]).database
    ).list("2026-11-11");
    expect(noActive.notes).toEqual(retired.slice(0, 100));
    expect(noActive.truncated).toBe(true);
  });

  it("lists the notes that are active on a date, filtered before the limit", async () => {
    const double = createDouble([[stored()]]);
    await expect(
      repositoryFor(double.database).listActive("2026-11-11")
    ).resolves.toEqual({ notes: [stored()], truncated: false });
    const [select] = double.operations;
    expect(select?.table).toBe(marketNotes);
    const query = whereOf(select);
    expect(query.sql).toBe(
      '("market_notes"."status" = $1 and "market_notes"."review_by" >= $2)'
    );
    expect(query.params).toEqual(["active", "2026-11-11"]);
    expect(select?.limit).toBe(MARKET_NOTES_ACTIVE_LIMIT + 1);
    expect(select?.columns).not.toHaveProperty("rawText");
    expect(
      select?.orderBy?.map((order) => dialect.sqlToQuery(order).sql)
    ).toEqual(ORDER);

    // The 51st row is not returned: it only shows that more active notes exist.
    const rows = Array.from({ length: 51 }, (_, index) => rowAt(index));
    await expect(
      repositoryFor(createDouble([rows]).database).listActive("2026-11-11")
    ).resolves.toEqual({ notes: rows.slice(0, 50), truncated: true });
  });

  it("finds a note by its source key, or returns null", async () => {
    const double = createDouble([[stored()], []]);
    const repository = repositoryFor(double.database);
    await expect(
      repository.findBySourceKey("https://www.instagram.com/reel/abc")
    ).resolves.toEqual(stored());
    await expect(
      repository.findBySourceKey("text:missing")
    ).resolves.toBeNull();
    const query = whereOf(double.operations[0]);
    expect(query.sql).toBe('"market_notes"."source_key" = $1');
    expect(query.params).toEqual(["https://www.instagram.com/reel/abc"]);
    expect(double.operations[0]?.columns).not.toHaveProperty("rawText");
    expect(double.operations[0]?.limit).toBe(1);
  });

  it("gets one note with its raw text, or returns null", async () => {
    const detail = { ...stored(), rawText: "Transcript of the reel." };
    const double = createDouble([[detail], []]);
    const repository = repositoryFor(double.database);
    await expect(repository.get("note-1")).resolves.toEqual(detail);
    await expect(repository.get("missing")).resolves.toBeNull();
    // No column list: the whole row, raw text included.
    expect(double.operations[0]?.columns).toBeUndefined();
    const query = whereOf(double.operations[0]);
    expect(query.sql).toBe('"market_notes"."id" = $1');
    expect(query.params).toEqual(["note-1"]);
  });

  it("inserts a new note as active with the generated id and the clock time", async () => {
    const double = createDouble([[stored()]]);
    await expect(
      repositoryFor(double.database).insert(newNote())
    ).resolves.toEqual({ created: true, note: stored() });
    expect(double.operations).toHaveLength(1);
    const [insert] = double.operations;
    expect(insert?.table).toBe(marketNotes);
    expect(insert?.values).toEqual({
      ...newNote(),
      createdAt: NOW,
      id: "note-1",
      status: "active",
      updatedAt: NOW,
    });
    expect(insert?.conflictTarget).toBe(marketNotes.sourceKey);
    expect(insert?.returning).not.toHaveProperty("rawText");
  });

  it("returns the stored note unchanged when the source key already exists", async () => {
    const existing = stored({ id: "note-0", theme: "The first theme" });
    const double = createDouble([[], [existing]]);
    await expect(
      repositoryFor(double.database).insert(newNote({ theme: "A new theme" }))
    ).resolves.toEqual({ created: false, note: existing });
    expect(double.operations.map((operation) => operation.kind)).toEqual([
      "insert",
      "select",
    ]);
    expect(whereOf(double.operations[1]).params).toEqual([
      "https://www.instagram.com/reel/abc",
    ]);
  });

  it("fails when the insert conflicts and no stored note can be read", async () => {
    const double = createDouble([[], []]);
    await expect(
      repositoryFor(double.database).insert(newNote())
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
  });

  it("uses a random id and the system clock by default", async () => {
    const double = createDouble([[stored()]]);
    const before = Date.now();
    await createMarketNotesRepository(double.database).insert(newNote());
    const values = double.operations[0]?.values as {
      createdAt: Date;
      id: string;
    };
    expect(values.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(values.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("records checks on the locked row and leaves other claims as they were", async () => {
    const double = createDouble([[stored()], []]);
    const result = await repositoryFor(double.database).recordChecks("note-1", [
      {
        claimId: "c2",
        evidence: "SOXX +2.1% vs SPY +0.3%",
        status: "supported",
      },
    ]);
    const claims = [
      stored().claims[0],
      {
        checkedAt: "2026-11-11T14:00:00.000Z",
        evidence: "SOXX +2.1% vs SPY +0.3%",
        id: "c2",
        status: "supported",
        text: "Semis lead the tape",
      },
    ];
    expect(result).toEqual({
      kind: "ok",
      note: stored({ claims: claims as never, updatedAt: NOW }),
    });
    expect(double.transactions()).toBe(1);
    const [select, update] = double.operations;
    expect(select).toMatchObject({
      kind: "select",
      lock: "update",
      scope: "transaction",
    });
    expect(whereOf(select).params).toEqual(["note-1"]);
    expect(update).toMatchObject({
      kind: "update",
      scope: "transaction",
      set: { claims, updatedAt: NOW },
      table: marketNotes,
    });
    expect(whereOf(update).sql).toBe('"market_notes"."id" = $1');
  });

  it("reads the clock once per check, after the row lock, for checkedAt and updatedAt", async () => {
    const double = createDouble([[stored()], []]);
    // What the newest statement was each time the clock was read.
    const readAfter: string[] = [];
    const repository = createMarketNotesRepository(double.database, {
      now: () => {
        const newest = double.operations.at(-1);
        readAfter.push(`${newest?.kind} for ${newest?.lock}`);
        return new Date("2026-11-11T16:00:00.000Z");
      },
    });
    const result = await repository.recordChecks("note-1", [
      { claimId: "c1", evidence: "x", status: "cannot-check" },
    ]);
    expect(readAfter).toEqual(["select for update"]);
    expect(double.operations.map((operation) => operation.kind)).toEqual([
      "select",
      "update",
    ]);
    expect(result).toMatchObject({
      kind: "ok",
      note: {
        claims: [{ checkedAt: "2026-11-11T16:00:00.000Z" }, {}],
        updatedAt: new Date("2026-11-11T16:00:00.000Z"),
      },
    });
    // A review reads the clock the same way.
    const reviewed = createDouble([[stored()], []]);
    readAfter.length = 0;
    await createMarketNotesRepository(reviewed.database, {
      now: () => {
        const newest = reviewed.operations.at(-1);
        readAfter.push(`${newest?.kind} for ${newest?.lock}`);
        return new Date("2026-11-11T16:00:00.000Z");
      },
    }).review("note-1", { kind: "retire" });
    expect(readAfter).toEqual(["select for update"]);
  });

  it("takes no checks on a retired note", async () => {
    const double = createDouble([[stored({ status: "retired" })]]);
    await expect(
      repositoryFor(double.database).recordChecks("note-1", [
        { claimId: "c1", evidence: "x", status: "supported" },
      ])
    ).resolves.toEqual({ kind: "retired" });
    expect(double.operations).toHaveLength(1);
  });

  it("writes nothing for a missing note or an unknown claim id", async () => {
    const missing = createDouble([[]]);
    await expect(
      repositoryFor(missing.database).recordChecks("missing", [
        { claimId: "c1", evidence: "x", status: "supported" },
      ])
    ).resolves.toEqual({ kind: "not-found" });
    expect(missing.operations).toHaveLength(1);

    const unknown = createDouble([[stored()]]);
    await expect(
      repositoryFor(unknown.database).recordChecks("note-1", [
        { claimId: "c1", evidence: "x", status: "supported" },
        { claimId: "c9", evidence: "y", status: "contradicted" },
      ])
    ).resolves.toEqual({ claimId: "c9", kind: "unknown-claim" });
    expect(unknown.operations).toHaveLength(1);
  });

  it("renews the review date of an active note", async () => {
    const double = createDouble([[stored({ reviewBy: "2026-11-01" })], []]);
    await expect(
      repositoryFor(double.database).review("note-1", {
        kind: "renew",
        reviewBy: "2026-11-11",
      })
    ).resolves.toEqual({
      kind: "ok",
      note: stored({ reviewBy: "2026-11-11", updatedAt: NOW }),
    });
    const [select, update] = double.operations;
    expect(select).toMatchObject({ lock: "update", scope: "transaction" });
    expect(update).toMatchObject({
      kind: "update",
      scope: "transaction",
      set: { reviewBy: "2026-11-11", updatedAt: NOW },
    });
    expect(whereOf(update).params).toEqual(["note-1"]);
  });

  it("refuses a renew with a past date, a date before the market date, on a retired note or on a missing note", async () => {
    const past = createDouble([[stored()]]);
    await expect(
      repositoryFor(past.database).review("note-1", {
        kind: "renew",
        reviewBy: "2026-11-10",
      })
    ).resolves.toEqual({ kind: "review-date-past" });
    expect(past.operations).toHaveLength(1);

    // The market date is later than the new review date (a note about a coming session).
    const early = createDouble([[stored({ asOf: "2026-11-20" })]]);
    await expect(
      repositoryFor(early.database).review("note-1", {
        kind: "renew",
        reviewBy: "2026-11-19",
      })
    ).resolves.toEqual({ kind: "review-date-before-as-of" });
    expect(early.operations).toHaveLength(1);

    const retired = createDouble([[stored({ status: "retired" })]]);
    await expect(
      repositoryFor(retired.database).review("note-1", {
        kind: "renew",
        reviewBy: "2026-12-01",
      })
    ).resolves.toEqual({ kind: "retired" });
    expect(retired.operations).toHaveLength(1);

    const missing = createDouble([[]]);
    await expect(
      repositoryFor(missing.database).review("missing", { kind: "retire" })
    ).resolves.toEqual({ kind: "not-found" });
    expect(missing.operations).toHaveLength(1);
  });

  it("retires a note once and returns a retired note unchanged", async () => {
    // An expired note (review date in the past) can still be retired.
    const first = createDouble([[stored({ reviewBy: "2026-11-01" })], []]);
    await expect(
      repositoryFor(first.database).review("note-1", { kind: "retire" })
    ).resolves.toEqual({
      kind: "ok",
      note: stored({ reviewBy: "2026-11-01", status: "retired" }),
    });
    expect(first.operations[1]?.set).toEqual({
      status: "retired",
      updatedAt: NOW,
    });

    const earlier = new Date("2026-11-05T00:00:00.000Z");
    const again = createDouble([
      [stored({ status: "retired", updatedAt: earlier })],
    ]);
    await expect(
      repositoryFor(again.database).review("note-1", { kind: "retire" })
    ).resolves.toEqual({
      kind: "ok",
      note: stored({ status: "retired", updatedAt: earlier }),
    });
    expect(again.operations).toHaveLength(1);
  });
});
