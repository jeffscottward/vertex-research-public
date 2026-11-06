import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { watchlistItems } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createWatchlistRepository,
  normalizeWatchlistSymbol,
} from "./repositories.ts";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const dialect = new PgDialect();

interface Operation {
  conflict?: unknown;
  kind: "select" | "insert" | "update" | "delete";
  set?: Record<string, unknown>;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

// Chainable query double: records each operation and resolves the queued outcome.
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
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      onConflictDoNothing: (config: unknown) => {
        operation.conflict = config;
        return chain;
      },
      returning: () => chain,
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
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: () => builder({ kind: "select" }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    update: (table: unknown) => builder({ kind: "update", table }),
    delete: (table: unknown) => builder({ kind: "delete", table }),
  } as unknown as Database;
  return { database, operations };
};

const whereSql = (operation: Operation) => {
  return dialect.sqlToQuery(operation.where!);
};

const row = (symbol: string, overrides: Record<string, unknown> = {}) => ({
  id: `id-${symbol}`,
  userId: "user-a",
  symbol,
  note: null,
  buyZoneLow: null,
  buyZoneHigh: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  ...overrides,
});

const repositoryFor = (double: ReturnType<typeof createDouble>) => {
  let counter = 0;
  return createWatchlistRepository(double.database, {
    now: () => FIXED_NOW,
    generateId: () => `gen-${++counter}`,
  });
};

describe("watchlist symbol normalization", () =>
  it("trims, uppercases and rejects malformed symbols", () => {
    expect(normalizeWatchlistSymbol("  aaa ")).toBe("AAA");
    expect(normalizeWatchlistSymbol("bbb.x")).toBe("BBB.X");
    expect(normalizeWatchlistSymbol("C-D")).toBe("C-D");
    for (const bad of ["", "1AB", "A$B", "ABCDEFGHIJK", ".A", "A B"]) {
      expect(normalizeWatchlistSymbol(bad)).toBeNull();
    }
  }));

describe("watchlist repository", () => {
  it("lists only the requested user's rows", async () => {
    const double = createDouble([[row("AAA")]]);
    const items = await repositoryFor(double).listByUser("user-a");
    expect(items.map((item) => item.symbol)).toEqual(["AAA"]);
    const query = whereSql(double.operations[0]!);
    expect(query.sql).toContain('"watchlist_items"."user_id" = $1');
    return expect(query.params).toEqual(["user-a"]);
  });

  it("normalizes, dedupes and upserts by (user, symbol) without overwriting existing rows", async () => {
    const double = createDouble([[row("BBB.X", { id: "gen-2" })]]);
    const result = await repositoryFor(double).addMany("user-a", [
      "aaa",
      " AAA ",
      "bbb.x",
    ]);
    const insert = double.operations[0]!;
    expect(insert.table).toBe(watchlistItems);
    expect(insert.values).toEqual([
      {
        id: "gen-1",
        userId: "user-a",
        symbol: "AAA",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: "gen-2",
        userId: "user-a",
        symbol: "BBB.X",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ]);
    expect(insert.conflict).toEqual({
      target: [watchlistItems.userId, watchlistItems.symbol],
    });
    expect(result.added.map((item) => item.symbol)).toEqual(["BBB.X"]);
    return expect(result.existing).toEqual(["AAA"]);
  });

  it("refuses invalid or empty symbol batches before touching storage", async () => {
    const double = createDouble([]);
    const repository = repositoryFor(double);
    await expect(
      repository.addMany("user-a", ["AAA", "9ZZ"])
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(repository.addMany("user-a", [])).rejects.toBeInstanceOf(
      InvalidRepositoryInputError
    );
    await expect(repository.addMany(" ", ["AAA"])).rejects.toBeInstanceOf(
      InvalidRepositoryInputError
    );
    return expect(double.operations).toEqual([]);
  });

  it("updates note and buy zone scoped to id and owner", async () => {
    const double = createDouble([
      [row("AAA", { note: "base", buyZoneLow: "10.5", buyZoneHigh: "12" })],
    ]);
    const item = await repositoryFor(double).update({
      id: "id-AAA",
      userId: "user-a",
      note: "  base  ",
      buyZone: { low: "10.5", high: "12" },
    });
    expect(item?.buyZoneHigh).toBe("12");
    const update = double.operations[0]!;
    expect(update.set).toEqual({
      note: "base",
      buyZoneLow: "10.5",
      buyZoneHigh: "12",
      updatedAt: FIXED_NOW,
    });
    const query = whereSql(update);
    expect(query.sql).toContain('"watchlist_items"."id" = $');
    expect(query.sql).toContain('"watchlist_items"."user_id" = $');
    return expect(query.params).toEqual(["id-AAA", "user-a"]);
  });

  it("returns null when another user's row is targeted", async () => {
    const double = createDouble([[]]);
    await expect(
      repositoryFor(double).update({
        id: "id-AAA",
        userId: "user-b",
        note: null,
      })
    ).resolves.toBeNull();
    return expect(whereSql(double.operations[0]!).params).toEqual([
      "id-AAA",
      "user-b",
    ]);
  });

  it("enforces 0 < low <= high and decimal shape", async () => {
    const double = createDouble([]);
    const repository = repositoryFor(double);
    for (const zone of [
      { low: "12", high: "10" },
      { low: "0", high: "10" },
      { low: null, high: "-1" },
      { low: "1.123456789", high: null },
      { low: "abc", high: null },
    ]) {
      await expect(
        repository.update({ id: "x", userId: "user-a", buyZone: zone })
      ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    }
    await expect(
      repository.update({ id: "x", userId: "user-a" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.update({ id: "x", userId: "user-a", note: "n".repeat(501) })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return expect(double.operations).toEqual([]);
  });

  it("accepts equal bounds and one-sided zones", async () => {
    const double = createDouble([[row("AAA")], [row("AAA")]]);
    const repository = repositoryFor(double);
    await repository.update({
      id: "id-AAA",
      userId: "user-a",
      buyZone: { low: "5", high: "5" },
    });
    await repository.update({
      id: "id-AAA",
      userId: "user-a",
      buyZone: { low: null, high: "5.25" },
    });
    return expect(double.operations).toHaveLength(2);
  });

  it("removes only owned rows and reports misses", async () => {
    const double = createDouble([[{ id: "id-AAA" }], []]);
    const repository = repositoryFor(double);
    await expect(repository.remove("id-AAA", "user-a")).resolves.toBe(true);
    await expect(repository.remove("id-AAA", "user-b")).resolves.toBe(false);
    return expect(whereSql(double.operations[1]!).params).toEqual([
      "id-AAA",
      "user-b",
    ]);
  });

  return it("maps storage failures without leaking provider detail", async () => {
    const wrapped = (code: string) => {
      return new DrizzleQueryError(
        "insert",
        [],
        Object.assign(new Error("provider detail"), { code })
      );
    };
    const check = repositoryFor(createDouble([wrapped("23514")]));
    await expect(check.addMany("user-a", ["AAA"])).rejects.toBeInstanceOf(
      InvalidRepositoryInputError
    );
    const conflict = repositoryFor(createDouble([wrapped("23505")]));
    await expect(conflict.addMany("user-a", ["AAA"])).rejects.toBeInstanceOf(
      DatabaseConflictError
    );
    const outage = repositoryFor(
      createDouble([wrapped("08006"), wrapped("08006")])
    );
    await expect(outage.listByUser("user-a")).rejects.toThrow();
    return await expect(outage.remove("id", "user-a")).rejects.toBeInstanceOf(
      DatabasePersistenceError
    );
  });
});

describe("watchlist migration source", () =>
  it("creates an idempotent owner-cascading table with the schema checks", () => {
    const migration = readFileSync(
      new URL("../../migrations/0014_watchlist_items.sql", import.meta.url),
      "utf8"
    );
    const rollback = readFileSync(
      new URL("../../rollback/0014_watchlist_items.down.sql", import.meta.url),
      "utf8"
    );
    const schema = readFileSync(
      new URL("../schema/index.ts", import.meta.url),
      "utf8"
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "watchlist_items"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_items_user_symbol_unique_idx"'
    );
    expect(migration).toContain(
      'REFERENCES "public"."user"("id") ON DELETE cascade'
    );
    for (const name of ["symbol", "note", "buy_zone"]) {
      expect(migration).toContain(`"watchlist_items_${name}_check" CHECK (`);
      expect(schema).toContain(`"watchlist_items_${name}_check"`);
    }
    expect(migration).toContain("'^[A-Z][A-Z0-9.\\-]{0,9}$'");
    expect(migration).not.toMatch(/^\s*(GRANT|TRUNCATE|UPDATE|DELETE)\s/im);
    expect(rollback).toContain('DROP TABLE "public"."watchlist_items"');
    expect(rollback).toContain("refusing rollback");
    return expect(rollback).not.toMatch(
      /\b(CASCADE|TRUNCATE)\b|DROP TABLE IF EXISTS/
    );
  }));
