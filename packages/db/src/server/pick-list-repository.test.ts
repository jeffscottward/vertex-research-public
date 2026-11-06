import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  pickListMembers,
  pickListSnapshots,
  pickLists,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  comparePickListMembers,
  createPickListRepository,
  type ImportPickListSnapshotInput,
  type PickListMemberRow,
  validatePickListMembers,
} from "./pick-list-repository.ts";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repositories.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: "select" | "insert" | "update" | "delete";
  conflict?: unknown;
  set?: Record<string, unknown>;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (
  outcomes: Array<readonly Record<string, unknown>[] | Error>
) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: () => chain,
      onConflictDoUpdate: (conflict: unknown) => {
        operation.conflict = conflict;
        return chain;
      },
      orderBy: () => chain,
      returning: () => chain,
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const outcome = outcomes.shift() ?? [];
        return (
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome)
        ).then(resolve, reject);
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: (operation: (transaction: unknown) => Promise<unknown>) =>
      operation(database),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

let ids = 0;
const repositoryFor = (double: ReturnType<typeof createDouble>) => {
  ids = 0;
  return createPickListRepository(double.database, {
    generateId: () => `id-${++ids}`,
    now: () => NOW,
  });
};

const listRow = (overrides: Record<string, unknown> = {}) => ({
  bucketBasketId: null,
  bucketSymbol: null,
  createdAt: NOW,
  id: "list-1",
  name: "Wish list",
  slug: "wishlist",
  source: "wishlist",
  sourceLabel: "Owner wish list",
  updatedAt: NOW,
  userId: "user-a",
  ...overrides,
});
const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  asOf: "2026-11-05",
  id: "snap-1",
  importedAt: NOW,
  method: "manual",
  pickListId: "list-1",
  ...overrides,
});
const member = (
  symbol: string,
  overrides: Partial<PickListMemberRow> = {}
): PickListMemberRow => ({
  addedOn: null,
  rank: null,
  rating: null,
  sector: null,
  symbol,
  targetPrice: null,
  thesis: null,
  weight: null,
  ...overrides,
});
const memberRow = (
  symbol: string,
  overrides: Partial<PickListMemberRow> & { snapshotId?: string } = {}
) => ({ snapshotId: "snap-1", ...member(symbol), ...overrides });
const pgError = (code: string) => Object.assign(new Error("pg"), { code });
const sqlOf = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

const importInput = (
  overrides: Partial<ImportPickListSnapshotInput> = {}
): ImportPickListSnapshotInput => ({
  asOf: "2026-11-05",
  members: [
    member(" nvda ", {
      addedOn: "2026-10-01",
      rank: 2,
      rating: " Buy ",
      sector: "Technology",
      targetPrice: "200.5",
      thesis: "  ",
      weight: "0.25",
    }),
    member("AAPL", { rank: 1 }),
  ],
  method: "manual",
  name: " Wish list ",
  slug: "wishlist",
  source: "wishlist",
  sourceLabel: " Owner wish list ",
  userId: "user-a",
  ...overrides,
});

describe("pick list validation", () => {
  it("normalizes members", () => {
    expect(validatePickListMembers(importInput().members)).toEqual([
      {
        addedOn: "2026-10-01",
        rank: 2,
        rating: "Buy",
        sector: "Technology",
        symbol: "NVDA",
        targetPrice: "200.5",
        thesis: null,
        weight: "0.25",
      },
      member("AAPL", { rank: 1 }),
    ]);
  });

  it.each([
    [[], "1 to 200 members"],
    [Array.from({ length: 201 }, (_, i) => member(`A${i}`)), "1 to 200"],
    [[member("1BAD")], "invalid member symbol"],
    [[member("A"), member("a")], "duplicate member: A"],
    [[member("A", { rank: 0 })], "rank for A"],
    [[member("A", { rank: 1.5 })], "rank for A"],
    [[member("A", { rank: 1001 })], "rank for A"],
    [[member("A", { weight: "1.5" })], "weight for A"],
    [[member("A", { weight: "abc" })], "weight for A"],
    [[member("A", { weight: "0.123456789" })], "weight for A"],
    [[member("A", { targetPrice: "0" })], "target price for A"],
    [[member("A", { targetPrice: "1.23456" })], "target price for A"],
    [[member("A", { sector: "x".repeat(61) })], "sector must be at most 60"],
    [[member("A", { rating: "x".repeat(41) })], "rating must be at most 40"],
    [[member("A", { thesis: "x".repeat(2001) })], "thesis must be at most"],
    [[member("A", { addedOn: "2026-02-30" })], "addedOn must be"],
    [[member("A", { addedOn: "soon" })], "addedOn must be"],
  ])("rejects invalid members %#", (members, message) => {
    expect(() => validatePickListMembers(members)).toThrow(
      InvalidRepositoryInputError
    );
    expect(() => validatePickListMembers(members)).toThrow(message);
  });

  it("accepts boundary weights and prices", () => {
    expect(
      validatePickListMembers([
        member("A", { targetPrice: "0.0001", weight: "1" }),
        member("B", { weight: "0" }),
      ]).map((row) => row.weight)
    ).toEqual(["1", "0"]);
  });

  it("orders by rank with nulls last, then symbol", () => {
    const rows = [
      member("C"),
      member("B", { rank: 2 }),
      member("A"),
      member("Z", { rank: 1 }),
      member("D", { rank: 2 }),
      member("A"),
    ];
    expect(
      [...rows].sort(comparePickListMembers).map((row) => row.symbol)
    ).toEqual(["Z", "B", "D", "A", "A", "C"]);
  });
});

describe("pick list repository", () => {
  it("imports a snapshot: upserts the list, replaces the same date and returns the latest", async () => {
    const double = createDouble([
      [listRow()],
      [],
      [],
      [],
      [
        snapshotRow({ asOf: "2026-11-01", id: "old" }),
        snapshotRow({ id: "id-2" }),
        snapshotRow({ asOf: "2026-10-01", id: "older" }),
      ],
      [
        memberRow("NVDA", { rank: 2, snapshotId: "id-2", weight: "0.25" }),
        memberRow("AAPL", { rank: 1, snapshotId: "id-2" }),
      ],
    ]);
    const result = await repositoryFor(double).importSnapshot(importInput());

    expect(result.snapshotCount).toBe(3);
    expect(result.list).toEqual(listRow());
    expect(result.latest).toEqual({
      asOf: "2026-11-05",
      id: "id-2",
      importedAt: NOW,
      members: [
        member("AAPL", { rank: 1 }),
        member("NVDA", { rank: 2, weight: "0.25" }),
      ],
      method: "manual",
      pickListId: "list-1",
    });
    const [upsert, remove, snapshot, members, readSnapshots, readMembers] =
      double.operations;
    expect(upsert?.table).toBe(pickLists);
    expect(upsert?.values).toMatchObject({
      id: "id-1",
      name: "Wish list",
      sourceLabel: "Owner wish list",
      userId: "user-a",
    });
    expect(upsert?.conflict).toMatchObject({
      set: {
        name: "Wish list",
        sourceLabel: "Owner wish list",
        updatedAt: NOW,
      },
    });
    expect(remove?.table).toBe(pickListSnapshots);
    expect(sqlOf(remove?.where)).toContain('"as_of" = $2');
    expect(snapshot?.values).toEqual({
      asOf: "2026-11-05",
      id: "id-2",
      importedAt: NOW,
      method: "manual",
      pickListId: "list-1",
    });
    expect(members?.table).toBe(pickListMembers);
    expect(members?.values).toHaveLength(2);
    expect(readSnapshots?.table).toBe(pickListSnapshots);
    expect(readMembers?.table).toBe(pickListMembers);
  });

  it.each([
    [{ userId: " " }, "userId must not be blank"],
    [{ source: "Bad Source" }, "source must be"],
    [{ slug: "-x" }, "slug must be"],
    [{ sourceLabel: " " }, "sourceLabel must be 1 to 80"],
    [{ name: "x".repeat(81) }, "name must be 1 to 80"],
    [{ asOf: "2026-13-01" }, "asOf must be"],
    [
      { method: "scraped" as unknown as ImportPickListSnapshotInput["method"] },
      "method must be",
    ],
  ])("rejects invalid import input %#", async (overrides, message) => {
    const double = createDouble([]);
    await expect(
      repositoryFor(double).importSnapshot(importInput(overrides))
    ).rejects.toThrow(message);
    expect(double.operations).toHaveLength(0);
  });

  it("maps storage errors on import", async () => {
    await expect(
      repositoryFor(createDouble([pgError("23514")])).importSnapshot(
        importInput()
      )
    ).rejects.toThrow("field constraint");
    await expect(
      repositoryFor(createDouble([pgError("23503")])).importSnapshot(
        importInput()
      )
    ).rejects.toThrow("does not exist");
    await expect(
      repositoryFor(createDouble([pgError("40001")])).importSnapshot(
        importInput()
      )
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
    const plain = new Error("boom");
    await expect(
      repositoryFor(createDouble([plain])).importSnapshot(importInput())
    ).rejects.toBe(plain);
  });

  it("fails when the upsert or the snapshot read returns nothing", async () => {
    await expect(
      repositoryFor(createDouble([[]])).importSnapshot(importInput())
    ).rejects.toThrow("pick list upsert");
    await expect(
      repositoryFor(createDouble([[listRow()], [], [], [], []])).importSnapshot(
        importInput()
      )
    ).rejects.toThrow("pick list snapshot read");
  });

  it("rejects a stored snapshot with an unknown method", async () => {
    const double = createDouble([
      [listRow()],
      [snapshotRow({ method: "scraped" })],
      [],
    ]);
    await expect(repositoryFor(double).get("list-1", "user-a")).rejects.toThrow(
      "pick list snapshot method"
    );
  });

  it("lists by user with latest snapshots, skipping lists without snapshots", async () => {
    const double = createDouble([
      [
        listRow(),
        listRow({ id: "list-2", slug: "other" }),
        listRow({ id: "list-3" }),
      ],
      [
        snapshotRow(),
        snapshotRow({ id: "snap-2", method: "adapter", pickListId: "list-2" }),
      ],
      [memberRow("MSFT"), memberRow("TSLA", { snapshotId: "snap-2" })],
    ]);
    const result = await repositoryFor(double).listByUser("user-a");
    expect(result.map((item) => [item.list.id, item.snapshotCount])).toEqual([
      ["list-1", 1],
      ["list-2", 1],
    ]);
    expect(result[0]?.latest.members.map((row) => row.symbol)).toEqual([
      "MSFT",
    ]);
    expect(result[1]?.latest.method).toBe("adapter");
    expect(sqlOf(double.operations[0]?.where)).toContain('"user_id" = $1');
  });

  it("returns an empty list without further reads and skips member reads without snapshots", async () => {
    const empty = createDouble([[]]);
    expect(await repositoryFor(empty).listByUser("user-a")).toEqual([]);
    expect(empty.operations).toHaveLength(1);

    const noSnapshots = createDouble([[listRow()], []]);
    expect(await repositoryFor(noSnapshots).listByUser("user-a")).toEqual([]);
    expect(noSnapshots.operations).toHaveLength(2);
  });

  it("lists the lists of users found by email", async () => {
    const double = createDouble([
      [{ id: "user-a" }, { id: "user-b" }],
      [listRow(), listRow({ id: "list-2", slug: "other", userId: "user-b" })],
      [snapshotRow(), snapshotRow({ id: "snap-2", pickListId: "list-2" })],
      [memberRow("MSFT"), memberRow("TSLA", { snapshotId: "snap-2" })],
    ]);
    const result = await repositoryFor(double).listByUserEmails([
      " Owner@Domain.TEST ",
      "owner@domain.test",
      "test@domain.test",
      "  ",
    ]);
    expect(result.map((item) => item.list.id)).toEqual(["list-1", "list-2"]);
    const emailQuery = double.operations[0]?.where;
    expect(sqlOf(emailQuery)).toContain('lower("user"."email") in ($1, $2)');
    expect(sqlOf(double.operations[1]?.where)).toContain(
      '"user_id" in ($1, $2)'
    );
  });

  it("reads nothing without emails and stops when no user matches", async () => {
    const none = createDouble([]);
    expect(await repositoryFor(none).listByUserEmails([" "])).toEqual([]);
    expect(await repositoryFor(none).listByUserEmails(undefined)).toEqual([]);
    expect(none.operations).toHaveLength(0);
    const unknown = createDouble([[]]);
    expect(
      await repositoryFor(unknown).listByUserEmails(["nobody@domain.test"])
    ).toEqual([]);
    expect(unknown.operations).toHaveLength(1);
    await expect(
      repositoryFor(createDouble([pgError("57P01")])).listByUserEmails([
        "owner@domain.test",
      ])
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
  });

  it("validates and maps errors for reads", async () => {
    const repository = repositoryFor(createDouble([]));
    await expect(repository.listByUser(" ")).rejects.toThrow("userId");
    await expect(repository.get(" ", "user-a")).rejects.toThrow("id");
    await expect(repository.get("list-1", "")).rejects.toThrow("userId");
    await expect(
      repositoryFor(createDouble([pgError("57P01")])).listByUser("user-a")
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
    await expect(
      repositoryFor(createDouble([pgError("57P01")])).get("list-1", "user-a")
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
  });

  it("gets one list scoped to the owner, or null", async () => {
    const double = createDouble([
      [listRow()],
      [snapshotRow()],
      [memberRow("A")],
    ]);
    const found = await repositoryFor(double).get("list-1", "user-a");
    expect(found?.latest.members).toEqual([member("A")]);
    expect(sqlOf(double.operations[0]?.where)).toContain('"user_id" = $2');
    expect(
      await repositoryFor(createDouble([[]])).get("list-1", "user-b")
    ).toBeNull();
  });

  it("sets the bucket symbol or returns null when missing", async () => {
    const double = createDouble([
      [{ id: "list-1" }],
      [listRow({ bucketBasketId: "basket-1", bucketSymbol: "WISH" })],
      [snapshotRow()],
      [memberRow("A")],
    ]);
    const result = await repositoryFor(double).setBucket(
      "list-1",
      "user-a",
      " wish ",
      "basket-1"
    );
    expect(result?.list.bucketSymbol).toBe("WISH");
    expect(result?.list.bucketBasketId).toBe("basket-1");
    expect(double.operations[0]?.set).toEqual({
      bucketBasketId: "basket-1",
      bucketSymbol: "WISH",
      updatedAt: NOW,
    });
    expect(
      await repositoryFor(createDouble([[]])).setBucket(
        "list-1",
        "user-a",
        "WISH",
        "basket-1"
      )
    ).toBeNull();
  });

  it("validates and maps errors for setBucket", async () => {
    const repository = repositoryFor(createDouble([]));
    await expect(
      repository.setBucket(" ", "user-a", "WISH", "basket-1")
    ).rejects.toThrow("id");
    await expect(
      repository.setBucket("list-1", " ", "WISH", "basket-1")
    ).rejects.toThrow("userId");
    await expect(
      repository.setBucket("list-1", "user-a", "1WISH", "basket-1")
    ).rejects.toThrow("bucket symbol");
    await expect(
      repository.setBucket("list-1", "user-a", "WISH", " ")
    ).rejects.toThrow("basketId");
    await expect(
      repositoryFor(createDouble([pgError("23514")])).setBucket(
        "list-1",
        "user-a",
        "WISH",
        "basket-1"
      )
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("uses default id and clock dependencies", async () => {
    const double = createDouble([
      [listRow()],
      [],
      [],
      [],
      [snapshotRow()],
      [memberRow("A")],
    ]);
    await createPickListRepository(double.database).importSnapshot(
      importInput()
    );
    const values = double.operations[0]?.values as {
      id: string;
      createdAt: Date;
    };
    expect(values.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(values.createdAt).toBeInstanceOf(Date);
  });
});
