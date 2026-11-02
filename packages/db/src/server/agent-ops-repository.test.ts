import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  agentTaskEvents,
  agentTasks,
  researchPapers,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  agentTaskLifecycle,
  createAgentOpsRepository,
  createResearchPapersRepository,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  validateAgentLinks,
  validateAgentMetrics,
} from "./repositories.ts";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const dialect = new PgDialect();

interface Operation {
  grouped?: boolean;
  joined?: boolean;
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
      where: (condition: SQL | undefined) => {
        if (!(condition === undefined)) operation.where = condition;
        return chain;
      },
      groupBy: () => {
        operation.grouped = true;
        return chain;
      },
      innerJoin: () => {
        operation.joined = true;
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

const whereSql = (operation: Operation) => dialect.sqlToQuery(operation.where!);

const taskRow = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  kind: "backtest",
  agent: "omp",
  title: "Backtest jump model",
  summary: null,
  status: "queued",
  metrics: {},
  links: [],
  paperId: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const pgError = (code: string) => {
  return new DrizzleQueryError(
    "query",
    [],
    Object.assign(new Error("pg"), { code })
  );
};

const agentOpsFor = (double: ReturnType<typeof createDouble>) => {
  let counter = 0;
  return createAgentOpsRepository(double.database, {
    now: () => FIXED_NOW,
    generateId: () => `gen-${++counter}`,
  });
};

const papersFor = (double: ReturnType<typeof createDouble>) => {
  return createResearchPapersRepository(double.database, {
    now: () => FIXED_NOW,
    generateId: () => "paper-gen",
  });
};

describe("agent task lifecycle", () =>
  it("sets started once, finished on terminal statuses and clears both on queued", () => {
    const blank = { startedAt: null, finishedAt: null };
    expect(agentTaskLifecycle(blank, "running", FIXED_NOW)).toEqual({
      startedAt: FIXED_NOW,
      finishedAt: null,
    });
    expect(
      agentTaskLifecycle(
        { startedAt: EARLIER, finishedAt: null },
        "running",
        FIXED_NOW
      )
    ).toEqual({ startedAt: EARLIER, finishedAt: null });
    expect(
      agentTaskLifecycle(
        { startedAt: EARLIER, finishedAt: null },
        "succeeded",
        FIXED_NOW
      )
    ).toEqual({ startedAt: EARLIER, finishedAt: FIXED_NOW });
    expect(agentTaskLifecycle(blank, "failed", FIXED_NOW)).toEqual({
      startedAt: null,
      finishedAt: FIXED_NOW,
    });
    expect(
      agentTaskLifecycle(
        { startedAt: EARLIER, finishedAt: FIXED_NOW },
        "needs_review",
        FIXED_NOW
      )
    ).toEqual({ startedAt: EARLIER, finishedAt: null });
    return expect(
      agentTaskLifecycle(
        { startedAt: EARLIER, finishedAt: FIXED_NOW },
        "queued",
        FIXED_NOW
      )
    ).toEqual(blank);
  }));

describe("agent metrics and links validation", () => {
  it("accepts flat bounded maps and rejects nesting, non-finite and oversized input", () => {
    expect(validateAgentMetrics({ sharpe: 1.1, note: "ok" })).toEqual({
      sharpe: 1.1,
      note: "ok",
    });
    expect(() => validateAgentMetrics({ nested: { a: 1 } })).toThrow(
      InvalidRepositoryInputError
    );
    expect(() => validateAgentMetrics({ bad: Number.NaN })).toThrow(
      InvalidRepositoryInputError
    );
    expect(() => validateAgentMetrics({ "1bad": 1 })).toThrow(
      InvalidRepositoryInputError
    );
    expect(() => validateAgentMetrics([1])).toThrow(
      InvalidRepositoryInputError
    );
    const many = Object.fromEntries(
      Array.from({ length: 41 }, (_, index) => [`k${index}`, index])
    );
    return expect(() => validateAgentMetrics(many)).toThrow(
      InvalidRepositoryInputError
    );
  });

  return it("accepts http(s) and portal-path links only", () => {
    expect(
      validateAgentLinks([
        { label: " Report ", url: "https://domain.test/r" },
        { label: "Run", url: "/agents?task=1" },
      ])
    ).toEqual([
      { label: "Report", url: "https://domain.test/r" },
      { label: "Run", url: "/agents?task=1" },
    ]);
    for (const bad of [
      "javascript:alert(1)",
      "//domain.test/x",
      "ftp://domain.test/x",
      "not a url",
    ]) {
      expect(() => validateAgentLinks([{ label: "x", url: bad }])).toThrow(
        InvalidRepositoryInputError
      );
    }
    return expect(() =>
      validateAgentLinks(
        Array.from({ length: 21 }, () => ({ label: "x", url: "/a" }))
      )
    ).toThrow(InvalidRepositoryInputError);
  });
});

describe("agent ops repository", () => {
  it("builds a summary with zero-filled counts, 24 h failures, paper stages and joined events", async () => {
    const double = createDouble([
      [
        { status: "running", count: 2 },
        { status: "failed", count: 1 },
      ],
      [{ count: 1 }],
      [
        { stage: "spec_extracted", count: 1 },
        { stage: "queued", count: 3 },
      ],
      [
        {
          id: "e1",
          taskId: "task-1",
          at: FIXED_NOW,
          level: "info",
          message: "started",
          taskTitle: "T",
          taskKind: "backtest",
        },
      ],
    ]);
    const summary = await agentOpsFor(double).summary();
    expect(summary.statusCounts).toEqual({
      queued: 0,
      running: 2,
      needs_review: 0,
      blocked: 0,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
    });
    expect(summary.failedLast24h).toBe(1);
    expect(summary.paperStageCounts.queued).toBe(3);
    expect(summary.paperStageCounts.verdict).toBe(0);
    expect(summary.latestEvents).toHaveLength(1);
    expect(double.operations[0]!.grouped).toBe(true);
    const failed = whereSql(double.operations[1]!);
    expect(failed.sql).toContain('"agent_tasks"."status" = $1');
    expect(failed.params).toContain("failed");
    expect(failed.params).toContain("2026-01-01T03:04:05.000Z");
    expect(double.operations[3]!.joined).toBe(true);
    return expect(double.operations[3]!.table).toBe(agentTaskEvents);
  });

  it("filters the task list by status and kind and validates filters", async () => {
    const double = createDouble([[taskRow()]]);
    await agentOpsFor(double).listTasks({
      status: "running",
      kind: "backtest",
      limit: 10,
    });
    const query = whereSql(double.operations[0]!);
    expect(query.sql).toContain('"agent_tasks"."status" = $1');
    expect(query.sql).toContain('"agent_tasks"."kind" = $2');
    await expect(
      agentOpsFor(createDouble([])).listTasks({ status: "done" as never })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return await expect(
      agentOpsFor(createDouble([])).listTasks({ limit: 0 })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  it("returns null for a missing task and events for a present one", async () => {
    expect(await agentOpsFor(createDouble([[]])).getTask("missing")).toBeNull();
    const found = await agentOpsFor(
      createDouble([[taskRow()], [{ id: "e1" }]])
    ).getTask("task-1");
    return expect(found?.events).toEqual([{ id: "e1" }]);
  });

  it("creates a task with trimmed fields and lifecycle timestamps for a running start", async () => {
    const double = createDouble([[taskRow({ status: "running" })]]);
    await agentOpsFor(double).createTask({
      kind: "backtest",
      agent: " omp ",
      title: " Backtest ",
      status: "running",
      metrics: { sharpe: 1 },
    });
    const values = double.operations[0]!.values as Record<string, unknown>;
    expect(double.operations[0]!.table).toBe(agentTasks);
    return expect(values).toMatchObject({
      id: "gen-1",
      agent: "omp",
      title: "Backtest",
      status: "running",
      startedAt: FIXED_NOW,
      finishedAt: null,
      metrics: { sharpe: 1 },
      links: [],
    });
  });

  it("rejects blank titles and unknown kinds before touching the database", async () => {
    const double = createDouble([]);
    await expect(
      agentOpsFor(double).createTask({
        kind: "backtest",
        agent: "a",
        title: "  ",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      agentOpsFor(double).createTask({
        kind: "trade" as never,
        agent: "a",
        title: "t",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return expect(double.operations).toHaveLength(0);
  });

  it("sets finished time when a running task succeeds and leaves timestamps on same-status updates", async () => {
    const double = createDouble([
      [{ startedAt: EARLIER, finishedAt: null, status: "running" }],
      [taskRow({ status: "succeeded" })],
    ]);
    await agentOpsFor(double).updateTask({ id: "task-1", status: "succeeded" });
    expect(double.operations[1]!.set).toMatchObject({
      status: "succeeded",
      startedAt: EARLIER,
      finishedAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    const same = createDouble([
      [{ startedAt: EARLIER, finishedAt: null, status: "running" }],
      [taskRow()],
    ]);
    await agentOpsFor(same).updateTask({
      id: "task-1",
      status: "running",
      summary: "x",
    });
    return expect(same.operations[1]!.set).not.toHaveProperty("startedAt");
  });

  it("returns null when updating or appending to a missing task", async () => {
    expect(
      await agentOpsFor(createDouble([[]])).updateTask({
        id: "nope",
        status: "running",
      })
    ).toBeNull();
    const double = createDouble([[]]);
    expect(
      await agentOpsFor(double).appendEvent({ taskId: "nope", message: "hi" })
    ).toBeNull();
    return expect(
      double.operations.filter((operation) => operation.kind === "insert")
    ).toHaveLength(0);
  });

  it("appends an event, touches the task and bounds the message", async () => {
    const double = createDouble([
      [{ id: "task-1" }],
      [{ id: "gen-1", taskId: "task-1", level: "warn", message: "slow" }],
    ]);
    const event = await agentOpsFor(double).appendEvent({
      taskId: "task-1",
      level: "warn",
      message: " slow ",
    });
    expect(event?.level).toBe("warn");
    expect(double.operations[0]!.set).toEqual({ updatedAt: FIXED_NOW });
    expect(double.operations[1]!.values).toMatchObject({
      taskId: "task-1",
      level: "warn",
      message: "slow",
      at: FIXED_NOW,
    });
    return await expect(
      agentOpsFor(createDouble([])).appendEvent({
        taskId: "task-1",
        message: "x".repeat(2001),
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  return it("maps constraint, foreign-key and storage failures", async () => {
    await expect(
      agentOpsFor(createDouble([pgError("23514")])).createTask({
        kind: "ops",
        agent: "a",
        title: "t",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      agentOpsFor(createDouble([pgError("23503")])).createTask({
        kind: "ops",
        agent: "a",
        title: "t",
        paperId: "missing",
      })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return await expect(
      agentOpsFor(createDouble([pgError("08006")])).listTasks()
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
  });
});

describe("research papers repository", () => {
  it("adds a paper with title and optional URL and rejects unsafe URLs", async () => {
    const double = createDouble([[{ id: "paper-gen", title: "T" }]]);
    await papersFor(double).add({
      title: " T ",
      sourceUrl: "https://domain.test/p",
    });
    expect(double.operations[0]!.table).toBe(researchPapers);
    expect(double.operations[0]!.values).toMatchObject({
      id: "paper-gen",
      title: "T",
      sourceUrl: "https://domain.test/p",
      kind: "paper",
    });
    await expect(
      papersFor(createDouble([])).add({ title: "T", sourceUrl: "javascript:x" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return await expect(
      papersFor(createDouble([])).add({ title: "" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
  });

  return it("updates stage, verdict and metrics; blank text clears; empty update is rejected", async () => {
    const double = createDouble([[{ id: "p1" }]]);
    await papersFor(double).update({
      id: "p1",
      stage: "implemented",
      verdict: "promising",
      blockers: " ",
      reproducedMetrics: { sharpe: 0.5 },
    });
    expect(double.operations[0]!.set).toMatchObject({
      stage: "implemented",
      verdict: "promising",
      blockers: null,
      reproducedMetrics: { sharpe: 0.5 },
      updatedAt: FIXED_NOW,
    });
    await expect(
      papersFor(createDouble([])).update({ id: "p1" })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    await expect(
      papersFor(createDouble([])).update({ id: "p1", stage: "done" as never })
    ).rejects.toBeInstanceOf(InvalidRepositoryInputError);
    return expect(
      await papersFor(createDouble([[]])).update({ id: "gone", notes: "n" })
    ).toBeNull();
  });
});

describe("0015 migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0015_agent_ops_ledger.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0015_agent_ops_ledger.down.sql", import.meta.url),
    "utf8"
  );

  it("is idempotent and seeds the four references without overwriting", () => {
    for (const table of [
      "research_papers",
      "agent_tasks",
      "agent_task_events",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    for (const identifier of [
      "arXiv:2604.17251v1",
      "arXiv:2605.27848v1",
      "arXiv:2402.05272v3",
      "x:ruujss/2074503360208884204",
    ]) {
      expect(migration).toContain(`'${identifier}'`);
    }
    expect(migration).toContain("ON CONFLICT DO NOTHING");
    expect(migration).toMatch(
      /'article-ruuj-hmm-regimes-20260707'[^\n]*'article', 'queued', 'pending'/
    );
    expect(migration).toMatch(
      /'paper-jump-model-2402-05272'[^\n]*'spec_extracted', 'pending'/
    );
    return expect(migration).not.toMatch(
      /^\s*(GRANT|TRUNCATE|UPDATE|DELETE)\s/im
    );
  });

  return it("rollback refuses operator data", () => {
    expect(rollback).toContain("refusing rollback");
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
