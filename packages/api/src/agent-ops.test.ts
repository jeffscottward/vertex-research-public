import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  AgentOpsRepository,
  CreateAgentTaskInput,
  Repositories,
  ResearchPapersRepository,
  UpdateAgentTaskInput,
  UpdateResearchPaperInput,
} from "@darkfactory/db/server";
import type {
  AgentTask,
  AgentTaskEvent,
  ResearchPaper,
} from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  AgentTaskCreateInputSchema,
  AgentTaskUpdateInputSchema,
  PapersAddInputSchema,
  PapersUpdateInputSchema,
} from "./contracts/agent-ops.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  id: "task-1",
  kind: "backtest",
  agent: "omp",
  title: "Backtest",
  summary: null,
  status: "queued",
  metrics: {},
  links: [],
  paperId: null,
  createdAt: at,
  updatedAt: at,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const paper = (overrides: Partial<ResearchPaper> = {}): ResearchPaper => ({
  id: "paper-1",
  title: "Paper",
  authors: null,
  year: null,
  sourceUrl: null,
  identifier: null,
  kind: "paper",
  stage: "queued",
  verdict: "pending",
  blockers: null,
  notes: null,
  reportedMetrics: {},
  reproducedMetrics: {},
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

// In-memory workspace repositories standing in for Postgres.
const memoryAgentOps = (): AgentOpsRepository & {
  tasks: AgentTask[];
  events: AgentTaskEvent[];
} => {
  const tasks: AgentTask[] = [];
  const events: AgentTaskEvent[] = [];
  return {
    tasks,
    events,
    summary: vi.fn(async () => ({
      statusCounts: {
        queued: tasks.filter((row) => row.status === "queued").length,
        running: 0,
        needs_review: 0,
        blocked: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      },
      failedLast24h: 0,
      paperStageCounts: {
        queued: 4,
        ingested: 0,
        spec_extracted: 0,
        implemented: 0,
        backtested: 0,
        forward_tested: 0,
        verdict: 0,
      },
      latestEvents: events.map((event) => ({
        ...event,
        taskTitle: "Backtest",
        taskKind: "backtest" as const,
      })),
    })),
    listTasks: vi.fn(async (filters = {}) => {
      return tasks.filter(
        (row) =>
          (filters.status === undefined || row.status === filters.status) &&
          (filters.kind === undefined || row.kind === filters.kind)
      );
    }),
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((row) => row.id === id);
      return found === undefined
        ? null
        : {
            task: found,
            events: events.filter((event) => event.taskId === id),
          };
    }),
    createTask: vi.fn(async (input: CreateAgentTaskInput) => {
      const created = task({
        id: `task-${tasks.length + 1}`,
        kind: input.kind,
        agent: input.agent,
        title: input.title,
        status: input.status ?? "queued",
      });
      tasks.push(created);
      return created;
    }),
    updateTask: vi.fn(async (input: UpdateAgentTaskInput) => {
      const index = tasks.findIndex((row) => row.id === input.id);
      if (index < 0) return null;
      const next = {
        ...tasks[index]!,
        ...(input.status === undefined
          ? {}
          : {
              status: input.status,
              startedAt:
                input.status === "running" ? at : tasks[index]!.startedAt,
            }),
      };
      tasks[index] = next;
      return next;
    }),
    appendEvent: vi.fn(async (input) => {
      if (!tasks.some((row) => row.id === input.taskId)) return null;
      const event: AgentTaskEvent = {
        id: `event-${events.length + 1}`,
        taskId: input.taskId,
        at,
        level: input.level ?? "info",
        message: input.message,
      };
      events.push(event);
      return event;
    }),
  };
};

const memoryPapers = (): ResearchPapersRepository & {
  rows: ResearchPaper[];
} => {
  const rows: ResearchPaper[] = [paper()];
  return {
    rows,
    list: vi.fn(async () => rows),
    add: vi.fn(async (input) => {
      const created = paper({
        id: `paper-${rows.length + 1}`,
        title: input.title,
        sourceUrl: input.sourceUrl ?? null,
      });
      rows.push(created);
      return created;
    }),
    update: vi.fn(async (input: UpdateResearchPaperInput) => {
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) return null;
      const next = {
        ...rows[index]!,
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
      };
      rows[index] = next;
      return next;
    }),
    findByArxivId: vi.fn(async () => []),
  };
};

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  agentOps?: AgentOpsRepository,
  researchPapers?: ResearchPapersRepository
) => {
  const repositories: Repositories = {
    profiles: {} as Repositories["profiles"],
    addresses: {} as Repositories["addresses"],
    userPreferences: {} as Repositories["userPreferences"],
    featureItems: {} as Repositories["featureItems"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    ...(agentOps === undefined ? {} : { agentOps }),
    ...(researchPapers === undefined ? {} : { researchPapers }),
  };
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      requireRole: async () => {
        throw denied();
      },
      // Ledger procedures are operator-only (requireOperator); both fixture users are operators.
      operatorEmails: ["user-a@domain.test", "User-B@Domain.test"],
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

describe("agent ops contract schemas", () => {
  it("accepts bounded task input and rejects unknown kinds, nested metrics and unsafe links", () => {
    expect(
      AgentTaskCreateInputSchema.safeParse({
        kind: "backtest",
        agent: "omp",
        title: "t",
        metrics: { sharpe: 1, note: "x" },
        links: [{ label: "r", url: "https://domain.test" }],
      }).success
    ).toBe(true);
    expect(
      AgentTaskCreateInputSchema.safeParse({
        kind: "trade",
        agent: "omp",
        title: "t",
      }).success
    ).toBe(false);
    expect(
      AgentTaskCreateInputSchema.safeParse({
        kind: "ops",
        agent: "omp",
        title: "t",
        metrics: { a: { b: 1 } },
      }).success
    ).toBe(false);
    expect(
      AgentTaskCreateInputSchema.safeParse({
        kind: "ops",
        agent: "omp",
        title: "t",
        links: [{ label: "x", url: "javascript:alert(1)" }],
      }).success
    ).toBe(false);
    return expect(
      AgentTaskCreateInputSchema.safeParse({
        kind: "ops",
        agent: "omp",
        title: "t",
        userId: "u",
      }).success
    ).toBe(false);
  });

  it("requires at least one change on updates and clears blank text", () => {
    expect(AgentTaskUpdateInputSchema.safeParse({ id: "task-1" }).success).toBe(
      false
    );
    expect(PapersUpdateInputSchema.safeParse({ id: "p" }).success).toBe(false);
    return expect(
      PapersUpdateInputSchema.parse({ id: "p", notes: "  " }).notes
    ).toBeNull();
  });

  it("requires a paper title and accepts only http(s) URLs", () => {
    expect(PapersAddInputSchema.safeParse({ title: "Paper" }).success).toBe(
      true
    );
    expect(
      PapersAddInputSchema.parse({ title: "Paper", sourceUrl: "" }).sourceUrl
    ).toBeNull();
    expect(PapersAddInputSchema.safeParse({ title: "" }).success).toBe(false);
    expect(
      PapersAddInputSchema.safeParse({
        title: "P",
        sourceUrl: "ftp://domain.test",
      }).success
    ).toBe(false);
    return expect(
      PapersAddInputSchema.safeParse({ title: "P", sourceUrl: "/local" })
        .success
    ).toBe(false);
  });
});

describe("agent ops oRPC procedures", () => {
  it("rejects anonymous callers", async () => {
    const client = clientFor(null, memoryAgentOps(), memoryPapers());
    await expectCode(client.agentOps.summary({}), "UNAUTHORIZED", 401);
    await expectCode(
      client.agentOps.tasks.create({ kind: "ops", agent: "a", title: "t" }),
      "UNAUTHORIZED",
      401
    );
    return await expectCode(client.papers.list({}), "UNAUTHORIZED", 401);
  });

  it("returns STORAGE_ERROR when the repositories are not wired", async () => {
    const client = clientFor(session("user-a"));
    await expectCode(client.agentOps.tasks.list({}), "STORAGE_ERROR", 503);
    return await expectCode(client.papers.list({}), "STORAGE_ERROR", 503);
  });

  it("shares workspace tasks across sessions: create, list, update, append event, get", async () => {
    const agentOps = memoryAgentOps();
    const a = clientFor(session("user-a"), agentOps, memoryPapers());
    const b = clientFor(session("user-b"), agentOps, memoryPapers());
    const created = await a.agentOps.tasks.create({
      kind: "backtest",
      agent: "omp",
      title: "Backtest jump model",
    });
    expect(created.status).toBe("queued");
    expect(
      (await b.agentOps.tasks.list({ status: "queued" })).tasks.map(
        (row) => row.id
      )
    ).toEqual([created.id]);
    const updated = await b.agentOps.tasks.update({
      id: created.id,
      status: "running",
    });
    expect(updated.startedAt).toEqual(at);
    await a.agentOps.tasks.appendEvent({
      taskId: created.id,
      level: "warn",
      message: "slow data",
    });
    const detail = await a.agentOps.tasks.get({ id: created.id });
    expect(detail.events.map((event) => [event.level, event.message])).toEqual([
      ["warn", "slow data"],
    ]);
    const summary = await a.agentOps.summary({});
    return expect(summary.latestEvents[0]).toMatchObject({
      taskTitle: "Backtest",
      message: "slow data",
    });
  });

  it("maps missing tasks to NOT_FOUND", async () => {
    const client = clientFor(
      session("user-a"),
      memoryAgentOps(),
      memoryPapers()
    );
    await expectCode(
      client.agentOps.tasks.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.agentOps.tasks.update({ id: "missing", status: "failed" }),
      "NOT_FOUND",
      404
    );
    return await expectCode(
      client.agentOps.tasks.appendEvent({ taskId: "missing", message: "x" }),
      "NOT_FOUND",
      404
    );
  });

  it("lists, adds and updates papers", async () => {
    const papers = memoryPapers();
    const client = clientFor(session("user-a"), memoryAgentOps(), papers);
    const added = await client.papers.add({
      title: "New paper",
      sourceUrl: "https://domain.test/p",
    });
    expect(added).toMatchObject({
      title: "New paper",
      sourceUrl: "https://domain.test/p",
      stage: "queued",
      verdict: "pending",
    });
    const updated = await client.papers.update({
      id: added.id,
      stage: "ingested",
      verdict: "inconclusive",
    });
    expect(updated).toMatchObject({
      stage: "ingested",
      verdict: "inconclusive",
    });
    expect((await client.papers.list({})).papers).toHaveLength(2);
    return await expectCode(
      client.papers.update({ id: "missing", notes: "n" }),
      "NOT_FOUND",
      404
    );
  });
});
