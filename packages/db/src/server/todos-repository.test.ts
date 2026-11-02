import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { todos, users } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createTodoRepository,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  normalizeTodoDueDate,
  normalizeTodoTags,
} from "./repositories.ts";

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
      limit: () => chain,
      onConflictDoNothing: (config: unknown) => {
        operation.conflict = config;
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
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const whereSql = (operation: Operation) => {
  return dialect.sqlToQuery(operation.where!);
};

const row = (overrides: Record<string, unknown> = {}) => ({
  createdAt: FIXED_NOW,
  dueDate: null,
  id: "todo-1",
  note: null,
  sourceUrl: null,
  status: "open",
  tags: [],
  title: "Keys",
  updatedAt: FIXED_NOW,
  userId: "user-a",
  ...overrides,
});

const repositoryFor = (double: ReturnType<typeof createDouble>) =>
  createTodoRepository(double.database, {
    generateId: () => "gen-1",
    now: () => FIXED_NOW,
  });

describe("todo field normalization", () => {
  it("validates calendar dates", () => {
    expect(normalizeTodoDueDate("2026-10-30")).toBe("2026-10-30");
    expect(normalizeTodoDueDate(" ")).toBeNull();
    for (const bad of ["2026-02-30", "30/10/2026", "2026-1-1"]) {
      expect(() => normalizeTodoDueDate(bad)).toThrow(
        InvalidRepositoryInputError
      );
    }
  });

  it("lowercases, dedupes and bounds tags", () => {
    expect(
      normalizeTodoTags([" Research", "research", "", "api-keys"])
    ).toEqual(["research", "api-keys"]);
    expect(() => normalizeTodoTags(["bad tag!"])).toThrow(
      InvalidRepositoryInputError
    );
    return expect(() =>
      normalizeTodoTags(Array.from({ length: 11 }, (_, i) => `t${i}`))
    ).toThrow(InvalidRepositoryInputError);
  });
});

describe("todo repository", () => {
  it("lists the owner's rows open first, by due date, with an optional tag filter", async () => {
    const double = createDouble([[row()]]);
    await repositoryFor(double).listByUser("user-a", "Research");
    const query = whereSql(double.operations[0]!);
    expect(query.sql).toContain('"todos"."user_id" = $1');
    expect(query.sql).toContain('= any("todos"."tags")');
    return expect(query.params).toEqual(["user-a", "research"]);
  });

  it("does not filter for a missing or blank tag", async () => {
    const double = createDouble([[], []]);
    const repository = repositoryFor(double);
    await repository.listByUser("user-a");
    await repository.listByUser("user-a", "  ");
    expect(whereSql(double.operations[0]!).params).toEqual(["user-a"]);
    return expect(whereSql(double.operations[1]!).params).toEqual(["user-a"]);
  });

  it("creates a normalized open row for the owner", async () => {
    const double = createDouble([[row()]]);
    await repositoryFor(double).create("user-a", {
      dueDate: "2026-10-30",
      note: "  ",
      sourceUrl: "https://example.test/a",
      tags: ["Research"],
      title: "  Keys  ",
    });
    const insert = double.operations[0]!;
    expect(insert.table).toBe(todos);
    return expect(insert.values).toEqual({
      createdAt: FIXED_NOW,
      dueDate: "2026-10-30",
      id: "gen-1",
      note: null,
      sourceUrl: "https://example.test/a",
      status: "open",
      tags: ["research"],
      title: "Keys",
      updatedAt: FIXED_NOW,
      userId: "user-a",
    });
  });

  it("refuses bad input before touching storage", async () => {
    const double = createDouble([]);
    const repository = repositoryFor(double);
    await expect(
      repository.create("user-a", { title: " " })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.create("user-a", { sourceUrl: "javascript:1", title: "x" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.update({ id: "todo-1", userId: "user-a" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return expect(double.operations).toEqual([]);
  });

  it("rejects long notes, malformed URLs and unknown statuses", async () => {
    const double = createDouble([]);
    const repository = repositoryFor(double);
    await expect(
      repository.create("user-a", { title: "x", note: "n".repeat(2001) })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.create("user-a", { title: "x", sourceUrl: "not a url" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.create("user-a", {
        title: "x",
        sourceUrl: `https://example.test/${"a".repeat(2000)}`,
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.update({
        id: "todo-1",
        userId: "user-a",
        status: "archived" as never,
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return expect(double.operations).toEqual([]);
  });

  it("maps storage errors on create, update and remove", async () => {
    const pgError = (code: string) =>
      Object.assign(new Error("db"), { cause: { code } });
    const plain = new Error("driver");
    const double = createDouble([
      pgError("57P01"),
      pgError("23514"),
      pgError("08006"),
      plain,
      [],
    ]);
    const repository = repositoryFor(double);
    await expect(repository.listByUser("user-a")).rejects.toBeInstanceOf(
      DatabasePersistenceError
    );
    await expect(
      repository.create("user-a", { title: "x" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      repository.update({ id: "todo-1", userId: "user-a", title: "y" })
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
    await expect(repository.remove("todo-1", "user-a")).rejects.toBe(plain);
    return expect(
      repository.update({ id: "todo-9", userId: "user-a", note: null })
    ).resolves.toBeNull();
  });

  it("updates every editable field after normalizing it", async () => {
    const double = createDouble([[row()]]);
    await repositoryFor(double).update({
      id: "todo-1",
      userId: "user-a",
      title: " T ",
      note: " N ",
      dueDate: "2026-10-30",
      tags: ["A"],
      sourceUrl: "https://example.test",
      status: "open",
    });
    return expect(double.operations[0]!.set).toEqual({
      title: "T",
      note: "N",
      dueDate: "2026-10-30",
      tags: ["a"],
      sourceUrl: "https://example.test",
      status: "open",
      updatedAt: FIXED_NOW,
    });
  });

  it("updates and deletes scoped to id and owner", async () => {
    const double = createDouble([[row({ status: "done" })], []]);
    const repository = repositoryFor(double);
    const item = await repository.update({
      id: "todo-1",
      status: "done",
      userId: "user-a",
    });
    expect(item?.status).toBe("done");
    expect(double.operations[0]!.set).toEqual({
      status: "done",
      updatedAt: FIXED_NOW,
    });
    expect(whereSql(double.operations[0]!).params).toEqual([
      "todo-1",
      "user-a",
    ]);
    expect(await repository.remove("todo-1", "user-b")).toBe(false);
    return expect(whereSql(double.operations[1]!).params).toEqual([
      "todo-1",
      "user-b",
    ]);
  });
});

describe("todos schema", () =>
  it("references the owner with a cascading foreign key and bounds every field", () => {
    const config = getTableConfig(todos);
    const [ownerKey] = config.foreignKeys;
    const reference = ownerKey!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(["user_id"]);
    expect(reference.foreignTable).toBe(users);
    expect(ownerKey!.onDelete).toBe("cascade");
    expect(config.checks.map((entry) => entry.name)).toEqual([
      "todos_text_check",
    ]);
    return expect(config.indexes.map((entry) => entry.config.name)).toEqual([
      "todos_user_status_due_idx",
    ]);
  }));

describe("0030_todos migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0030_todos.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0030_todos.down.sql", import.meta.url),
    "utf8"
  );
  it("creates an owner-scoped table with cascade and bounded fields", () => {
    expect(migration).toContain('CREATE TABLE "todos"');
    expect(migration).toContain("ON DELETE cascade");
    return expect(migration).toContain(
      'char_length(trim("todos"."title")) between 1 and 200'
    );
  });
  it("rollback refuses while rows exist", () =>
    expect(rollback).toContain("todos is not empty; refusing rollback"));
});
