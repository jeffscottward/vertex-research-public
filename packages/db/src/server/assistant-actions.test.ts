import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ACTION_ERROR_MAX_LENGTH,
  ASSISTANT_ACTION_RESULT_MAX_LENGTH,
  ASSISTANT_ACTION_SUMMARY_MAX_LENGTH,
  ASSISTANT_ACTIONS_LIST_MAX,
  boundAssistantActionText,
  createAssistantActionsRepository,
} from "./assistant-actions.ts";
import type { Database } from "./client.ts";

const FIXED_NOW = new Date("2026-10-23T12:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: string;
  values?: unknown;
  set?: unknown;
  where?: SQL | undefined;
  limit?: number;
}

const createDouble = (outcomes: Array<readonly unknown[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: (condition: SQL | undefined) => {
        operation.where = condition;
        return chain;
      },
      orderBy: () => chain,
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      set: (values: unknown) => {
        operation.set = values;
        return chain;
      },
      returning: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: () => builder({ kind: "select" }),
    insert: () => builder({ kind: "insert" }),
    update: () => builder({ kind: "update" }),
  } as unknown as Database;
  return { database, operations };
};

const sqlText = (condition: SQL | undefined) =>
  condition === undefined ? "" : dialect.sqlToQuery(condition).sql;

let counter = 0;
const dependencies = {
  now: () => FIXED_NOW,
  generateId: () => {
    counter += 1;
    return `action-${counter}`;
  },
};

describe("boundAssistantActionText", () => {
  it("trims, falls back when blank and cuts at the maximum", () => {
    expect(boundAssistantActionText("  x  ", 10, "f")).toBe("x");
    expect(boundAssistantActionText("   ", 10, "f")).toBe("f");
    expect(boundAssistantActionText("abcdef", 3, "f")).toBe("abc");
  });
});

describe("createAssistantActionsRepository", () => {
  it("creates pending actions in one insert and skips an empty list", async () => {
    counter = 0;
    const { database, operations } = createDouble([[{ id: "action-1" }]]);
    const repository = createAssistantActionsRepository(database, dependencies);
    await expect(repository.createMany([])).resolves.toEqual([]);
    expect(operations).toHaveLength(0);
    await expect(
      repository.createMany([
        {
          threadId: "t-1",
          messageId: "m-1",
          userId: "u-1",
          tool: "backtest_runs_submit",
          args: { symbol: "TEST" },
          summary: "x".repeat(ASSISTANT_ACTION_SUMMARY_MAX_LENGTH + 10),
        },
      ])
    ).resolves.toEqual([{ id: "action-1" }]);
    const values = operations[0]?.values as Record<string, unknown>[];
    expect(values[0]).toMatchObject({
      id: "action-1",
      status: "pending",
      createdAt: FIXED_NOW,
      tool: "backtest_runs_submit",
    });
    expect(values[0]?.["summary"]).toHaveLength(
      ASSISTANT_ACTION_SUMMARY_MAX_LENGTH
    );
  });

  it("lists the actions of the given messages with a bounded limit", async () => {
    const { database, operations } = createDouble([[{ id: "a" }]]);
    const repository = createAssistantActionsRepository(database, dependencies);
    await expect(repository.listForMessages("t-1", [])).resolves.toEqual([]);
    expect(operations).toHaveLength(0);
    await expect(
      repository.listForMessages("t-1", ["m-1", "m-2"])
    ).resolves.toEqual([{ id: "a" }]);
    expect(operations[0]?.limit).toBe(ASSISTANT_ACTIONS_LIST_MAX);
    const where = sqlText(operations[0]?.where);
    expect(where).toContain('"assistant_actions"."thread_id"');
    expect(where).toContain('"assistant_actions"."message_id" in');
  });

  it("decides only the owner's pending action", async () => {
    const { database, operations } = createDouble([[{ id: "a" }], [], []]);
    const repository = createAssistantActionsRepository(database, dependencies);
    await expect(
      repository.decide({ id: "a", userId: "u-1", decision: "approve" })
    ).resolves.toEqual({ id: "a" });
    await expect(
      repository.decide({ id: "a", userId: "u-1", decision: "reject" })
    ).resolves.toBeNull();
    expect(operations[0]?.set).toEqual({
      status: "running",
      decidedAt: FIXED_NOW,
    });
    expect(operations[1]?.set).toEqual({
      status: "rejected",
      decidedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
    });
    const where = sqlText(operations[0]?.where);
    expect(where).toContain('"assistant_actions"."user_id"');
    expect(where).toContain('"assistant_actions"."status"');
  });

  it("finishes only running actions with bounded text", async () => {
    const { database, operations } = createDouble([[{ id: "a" }], [], []]);
    const repository = createAssistantActionsRepository(database, dependencies);
    await expect(
      repository.finish("a", {
        status: "executed",
        result: "r".repeat(ASSISTANT_ACTION_RESULT_MAX_LENGTH + 5),
      })
    ).resolves.toEqual({ id: "a" });
    await expect(
      repository.finish("a", {
        status: "failed",
        error: "e".repeat(ASSISTANT_ACTION_ERROR_MAX_LENGTH + 5),
      })
    ).resolves.toBeNull();
    await repository.finish("a", { status: "failed", error: " " });
    const executed = operations[0]?.set as Record<string, unknown>;
    expect(executed["status"]).toBe("executed");
    expect(executed["result"]).toHaveLength(ASSISTANT_ACTION_RESULT_MAX_LENGTH);
    const failed = operations[1]?.set as Record<string, unknown>;
    expect(failed["error"]).toHaveLength(ASSISTANT_ACTION_ERROR_MAX_LENGTH);
    const blank = operations[2]?.set as Record<string, unknown>;
    expect(blank["error"]).toBe("Action failed");
    expect(sqlText(operations[0]?.where)).toContain(
      '"assistant_actions"."status"'
    );
  });
});
