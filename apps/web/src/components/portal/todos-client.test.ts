// @vitest-environment jsdom
import type { TodoItemOutput } from "@darkfactory/api";
import { describe, expect, it, vi } from "vitest";

import {
  allTags,
  createBrowserTodosGateway,
  describeTodoFailure,
  localToday,
  sortTodos,
  upsertTodo,
} from "./todos-client.ts";

const { calls, createApiClient } = vi.hoisted(() => {
  const calls: Readonly<{ name: string; input: unknown }>[] = [];
  const record =
    (name: string, result: unknown) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ name, input });
      return result;
    };
  const createApiClient = vi.fn((_options: unknown) => ({
    todos: {
      list: record("list", { items: [{ id: "a" }] }),
      create: record("create", { id: "new" }),
      update: record("update", { id: "a", status: "done" }),
      remove: record("remove", { id: "a", removed: true }),
    },
  }));
  return { calls, createApiClient };
});

vi.mock("@darkfactory/api", () => ({ createApiClient }));

const at = new Date("2026-10-23T10:00:00.000Z");
const todo = (
  id: string,
  overrides: Partial<TodoItemOutput> = {}
): TodoItemOutput => ({
  id,
  title: id,
  note: null,
  status: "open",
  dueDate: null,
  tags: [],
  sourceUrl: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

describe("browser todos gateway", () => {
  it("creates one client lazily on the page origin and maps each call", async () => {
    const gateway = createBrowserTodosGateway();
    expect(createApiClient).not.toHaveBeenCalled();
    expect(await gateway.list()).toEqual([{ id: "a" }]);
    await gateway.create({
      title: "t",
      note: null,
      dueDate: null,
      tags: [],
      sourceUrl: null,
    });
    await gateway.update("a", { status: "done" });
    expect(await gateway.remove("a")).toBeUndefined();
    expect(createApiClient).toHaveBeenCalledTimes(1);
    expect(createApiClient).toHaveBeenCalledWith({
      baseUrl: window.location.origin,
    });
    return expect(calls).toEqual([
      { name: "list", input: {} },
      {
        name: "create",
        input: {
          title: "t",
          note: null,
          dueDate: null,
          tags: [],
          sourceUrl: null,
        },
      },
      { name: "update", input: { id: "a", status: "done" } },
      { name: "remove", input: { id: "a" } },
    ]);
  });
});

describe("todo failure text", () => {
  it.each([
    [{ code: "UNAUTHORIZED" }, "Session expired. Sign in again."],
    [{ code: "FORBIDDEN" }, "Not permitted for this session."],
    [{ code: "NOT_FOUND" }, "To-do no longer exists. Reload the list."],
    [
      { code: "VALIDATION_ERROR", message: "due date must be YYYY-MM-DD" },
      "Rejected: due date must be YYYY-MM-DD",
    ],
    [{ code: "BAD_REQUEST", message: "" }, "Rejected: invalid input"],
    [{ code: "STORAGE_ERROR" }, "To-do storage unavailable (503)."],
    [{ code: 7 }, "Request failed. Retry."],
    [null, "Request failed. Retry."],
    ["boom", "Request failed. Retry."],
  ])("maps %j", (error, text) => {
    expect(describeTodoFailure(error)).toBe(text);
  });
});

describe("todo list helpers", () => {
  it("sorts dated rows before undated ones in either position", () => {
    expect(
      sortTodos([todo("none"), todo("dated", { dueDate: "2026-10-30" })]).map(
        (row) => row.id
      )
    ).toEqual(["dated", "none"]);
    return expect(
      sortTodos([todo("dated", { dueDate: "2026-10-30" }), todo("none")]).map(
        (row) => row.id
      )
    ).toEqual(["dated", "none"]);
  });

  it("puts open rows before done rows whatever the input order", () => {
    const open = todo("open");
    const done = todo("done", { status: "done" });
    expect(sortTodos([done, open]).map((row) => row.id)).toEqual([
      "open",
      "done",
    ]);
    return expect(sortTodos([open, done]).map((row) => row.id)).toEqual([
      "open",
      "done",
    ]);
  });

  it("orders two dated rows by date whatever the input order", () => {
    const soon = todo("soon", { dueDate: "2026-10-24" });
    const late = todo("late", { dueDate: "2026-11-01" });
    expect(sortTodos([late, soon]).map((row) => row.id)).toEqual([
      "soon",
      "late",
    ]);
    return expect(sortTodos([soon, late]).map((row) => row.id)).toEqual([
      "soon",
      "late",
    ]);
  });

  it("inserts a new row and replaces an existing one in sorted order", () => {
    const rows = upsertTodo([todo("a")], todo("b", { dueDate: "2026-10-30" }));
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
    const replaced = upsertTodo(rows, todo("a", { title: "renamed" }));
    return expect(replaced.find((row) => row.id === "a")?.title).toBe(
      "renamed"
    );
  });

  it("lists distinct tags and formats the local date", () => {
    expect(
      allTags([todo("a", { tags: ["z", "b"] }), todo("b", { tags: ["b"] })])
    ).toEqual(["b", "z"]);
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    return expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
