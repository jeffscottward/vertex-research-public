import {
  AUTHORIZATION_ERROR_CODES,
  AgentApiKeyRateLimitedError,
  AuthAuthorizationError,
  type AgentApiKeyRecord,
  type AgentApiKeyService,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  AgentOpsRepository,
  Repositories,
  ResearchPapersRepository,
} from "@darkfactory/db/server";
import type { AgentTask, ResearchPaper } from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { appContract } from "./contract.ts";
import { AgentApiKeyCreateInputSchema } from "./contracts/agent-api-keys.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_PATHS,
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
  isAgentApiKeyProcedurePath,
} from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const PLAINTEXT = `vrk_${"A".repeat(64)}`;

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

const paper = (): ResearchPaper => ({
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
});

const agentOpsRepository = (): AgentOpsRepository => {
  return {
    summary: vi.fn(),
    listTasks: vi.fn(async () => [task()]),
    getTask: vi.fn(async () => null),
    createTask: vi.fn(async (input) =>
      task({
        id: "task-9",
        title: input.title,
        agent: input.agent,
        kind: input.kind,
      })
    ),
    updateTask: vi.fn(async (input) =>
      task({ id: input.id, status: input.status ?? "queued" })
    ),
    appendEvent: vi.fn(async (input) => ({
      id: "event-1",
      taskId: input.taskId,
      at,
      level: input.level ?? "info",
      message: input.message,
    })),
  } as unknown as AgentOpsRepository;
};

const papersRepository = (): ResearchPapersRepository => {
  return {
    list: vi.fn(async () => [paper()]),
    add: vi.fn(),
    update: vi.fn(),
  } as unknown as ResearchPapersRepository;
};

const session = (
  userId = "user-a",
  overrides: Partial<SafeAuthSession["user"]> = {}
): SafeAuthSession => ({
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
    ...overrides,
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

const record = (
  overrides: Partial<AgentApiKeyRecord> = {}
): AgentApiKeyRecord => ({
  id: "key-1",
  name: "omp-rig",
  prefix: "vrk_",
  start: "vrk_AA",
  enabled: true,
  createdAt: at,
  lastUsedAt: null,
  expiresAt: null,
  access: "read",
  ...overrides,
});

type Harness = Readonly<{
  service: { [K in keyof AgentApiKeyService]: ReturnType<typeof vi.fn> };
  requireSession: ReturnType<typeof vi.fn>;
  agentOps: AgentOpsRepository;
  // Live allow-list, read on every request (mutate to add/remove operators).
  operators: string[];
  client: (
    options?: Readonly<{ apiKey?: string; wireKeys?: boolean }>
  ) => ReturnType<typeof createApiClient>;
}>;

// Key owner facts returned by the fake key verifier (the real one reads the user row).
interface KeyOwner {
  email: string;
  emailVerified: boolean;
  access?: "read" | "write";
}

const harness = (
  requestSession: SafeAuthSession | null = session(),
  operators: string[] = ["user-a@domain.test"],
  keyOwner: KeyOwner = { email: "user-a@domain.test", emailVerified: true }
): Harness => {
  const denied = () =>
    new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
  const service = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        userId: "user-a",
        role: "member" as const,
        status: "active" as const,
        apiKeyId: "key-1",
        access: "write" as const,
        ...keyOwner,
      };
    }),
    list: vi.fn(async () => [record()]),
    create: vi.fn(async (_headers: Headers, input: { name: string }) => ({
      record: record({ name: input.name }),
      key: PLAINTEXT,
    })),
    revoke: vi.fn(async (_headers: Headers, id: string) => id === "key-1"),
  };
  const requireSession = vi.fn(async () => {
    if (requestSession === null) throw denied();
    return requestSession;
  });
  const agentOps = agentOpsRepository();
  const repositories: Repositories = {
    profiles: {} as Repositories["profiles"],
    addresses: {} as Repositories["addresses"],
    userPreferences: {} as Repositories["userPreferences"],
    featureItems: {} as Repositories["featureItems"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    watchlist: {
      list: vi.fn(async () => []),
    } as unknown as NonNullable<Repositories["watchlist"]>,
    agentOps,
    researchPapers: papersRepository(),
  };
  const client = (
    options: Readonly<{ apiKey?: string; wireKeys?: boolean }> = {}
  ) => {
    return createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch: async (request) => {
        if (options.apiKey !== undefined)
          request.headers.set("x-api-key", options.apiKey);
        const context = createApiContext(request, {
          repositories,
          requestId: "request-1",
          capabilities: {
            ai: false,
            emailDelivery: false,
            analytics: false,
            telemetryExport: false,
          },
          requireSession,
          requireRole: async () => {
            throw denied();
          },
          operatorEmails: [...operators],
          ...(options.wireKeys === false
            ? {}
            : { agentApiKeys: service as unknown as AgentApiKeyService }),
        });
        return handleApiRequest(request, context);
      },
    });
  };
  return { service, requireSession, agentOps, operators, client };
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

describe("agent API key scope", () => {
  it("admits only agentOps.*, papers.*, strategyLibrary.*, marketData.*, backtestRuns.*, todos.*, priceAlerts.* and agentModelRuns.* procedure paths, the autopilot tick and the sector rotation collect and snapshot", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).toEqual([
      "agentOps",
      "papers",
      "strategyLibrary",
      "marketData",
      "backtestRuns",
      "todos",
      "priceAlerts",
      "agentModelRuns",
    ]);
    expect(AGENT_API_KEY_PROCEDURE_PATHS).toEqual([
      "autopilot.campaigns.tick",
      "sectorRotation.collect",
      "sectorRotation.snapshot",
      "clickLog.query",
    ]);
    expect(isAgentApiKeyProcedurePath(["autopilot", "campaigns", "tick"])).toBe(
      true
    );
    expect(isAgentApiKeyProcedurePath(["sectorRotation", "snapshot"])).toBe(
      true
    );
    expect(isAgentApiKeyProcedurePath(["sectorRotation", "map"])).toBe(false);
    expect(
      isAgentApiKeyProcedurePath(["autopilot", "campaigns", "create"])
    ).toBe(false);
    expect(isAgentApiKeyProcedurePath(["agentOps", "tasks", "create"])).toBe(
      true
    );
    expect(isAgentApiKeyProcedurePath(["agentOps", "summary"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["papers", "update"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["agentOps"])).toBe(false);
    expect(isAgentApiKeyProcedurePath(["agentApiKeys", "create"])).toBe(false);
    expect(isAgentApiKeyProcedurePath(["papersAdmin", "list"])).toBe(false);
    const allowedRoots = Object.keys(appContract).filter((root) =>
      isAgentApiKeyProcedurePath([root, "any"])
    );
    return expect(allowedRoots.sort()).toEqual([
      "agentModelRuns",
      "agentOps",
      "backtestRuns",
      "marketData",
      "papers",
      "priceAlerts",
      "strategyLibrary",
      "todos",
    ]);
  });

  it("lets a valid key create/update a task, append an event and list papers without consulting the session", async () => {
    const { client, service, requireSession, agentOps } = harness();
    const keyed = client({ apiKey: PLAINTEXT });
    const created = await keyed.agentOps.tasks.create({
      kind: "backtest",
      agent: "omp",
      title: "Backtest jump model",
    });
    expect(created).toMatchObject({
      id: "task-9",
      title: "Backtest jump model",
    });
    await keyed.agentOps.tasks.update({ id: created.id, status: "running" });
    const event = await keyed.agentOps.tasks.appendEvent({
      taskId: created.id,
      message: "fold 1/5",
    });
    expect(event).toMatchObject({ taskId: "task-9", message: "fold 1/5" });
    expect((await keyed.papers.list({})).papers).toHaveLength(1);
    expect(service["authenticate"]).toHaveBeenCalledTimes(4);
    expect(requireSession).not.toHaveBeenCalled();
    return expect(agentOps.createTask).toHaveBeenCalledTimes(1);
  });

  it("lets a read key list and get but refuses every ledger write with 403", async () => {
    const { client, agentOps } = harness(session(), ["user-a@domain.test"], {
      email: "user-a@domain.test",
      emailVerified: true,
      access: "read",
    });
    const reader = client({ apiKey: PLAINTEXT });
    expect((await reader.papers.list({})).papers).toHaveLength(1);
    await reader.agentOps.tasks.list({});
    await expectCode(
      reader.agentOps.tasks.create({ kind: "ops", agent: "a", title: "t" }),
      "FORBIDDEN",
      403
    );
    await expectCode(reader.papers.add({ title: "x" }), "FORBIDDEN", 403);
    return expect(agentOps.createTask).not.toHaveBeenCalled();
  });

  it("rejects key requests on every other procedure even when a session is also valid", async () => {
    const { client, service, requireSession } = harness(session());
    const keyed = client({ apiKey: PLAINTEXT });
    await expectCode(keyed.watchlist.list({}), "FORBIDDEN", 403);
    await expectCode(keyed.agentApiKeys.list({}), "FORBIDDEN", 403);
    await expectCode(
      keyed.agentApiKeys.create({ name: "escalate" }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      keyed.agentApiKeys.revoke({ id: "key-1" }),
      "FORBIDDEN",
      403
    );
    expect(service["authenticate"]).not.toHaveBeenCalled();
    expect(service["create"]).not.toHaveBeenCalled();
    expect(service["revoke"]).not.toHaveBeenCalled();
    return expect(requireSession).not.toHaveBeenCalled();
  });

  it("rejects unknown, blank and unwired keys with UNAUTHORIZED and never falls back to the cookie session", async () => {
    const { client, requireSession, agentOps } = harness(session());
    await expectCode(
      client({ apiKey: "vrk_wrong" }).agentOps.tasks.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      client({ apiKey: "" }).agentOps.tasks.create({
        kind: "ops",
        agent: "a",
        title: "t",
      }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      client({ apiKey: PLAINTEXT, wireKeys: false }).papers.list({}),
      "UNAUTHORIZED",
      401
    );
    expect(requireSession).not.toHaveBeenCalled();
    return expect(agentOps.createTask).not.toHaveBeenCalled();
  });

  it("maps an inactive key owner to FORBIDDEN and a rate-limited key to 429", async () => {
    const suspended = harness();
    suspended.service["authenticate"].mockRejectedValueOnce(
      new AuthAuthorizationError(
        AUTHORIZATION_ERROR_CODES.ACCOUNT_SUSPENDED,
        403
      )
    );
    await expectCode(
      suspended.client({ apiKey: PLAINTEXT }).agentOps.summary({}),
      "FORBIDDEN",
      403
    );
    const limited = harness();
    limited.service["authenticate"].mockRejectedValueOnce(
      new AgentApiKeyRateLimitedError()
    );
    return await expectCode(
      limited.client({ apiKey: PLAINTEXT }).agentOps.tasks.list({}),
      "TOO_MANY_REQUESTS",
      429
    );
  });

  it("operator sessions without a key use the session and never the key verifier", async () => {
    const { client, service, requireSession } = harness(session());
    const browser = client();
    expect((await browser.agentOps.tasks.list({})).tasks).toHaveLength(1);
    expect((await browser.papers.list({})).papers).toHaveLength(1);
    expect(requireSession).toHaveBeenCalledTimes(2);
    expect(service["authenticate"]).not.toHaveBeenCalled();
    return await expectCode(
      harness(null).client().agentOps.tasks.list({}),
      "UNAUTHORIZED",
      401
    );
  });
});

describe("agentApiKeys session-only management", () => {
  it("creates a key once, lists display-safe fields and revokes by id", async () => {
    const { client, service } = harness(session());
    const browser = client();
    const created = await browser.agentApiKeys.create({ name: "  omp-rig  " });
    expect(created.key).toBe(PLAINTEXT);
    expect(created.apiKey).toMatchObject({
      id: "key-1",
      name: "omp-rig",
      start: "vrk_AA",
      lastUsedAt: null,
    });
    expect(service["create"].mock.calls[0]?.[1]).toEqual({
      name: "omp-rig",
      access: "read",
    });
    const listed = await browser.agentApiKeys.list({});
    expect(listed.keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(PLAINTEXT);
    expect(Object.keys(listed.keys[0]!).sort()).toEqual([
      "access",
      "createdAt",
      "enabled",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
      "start",
    ]);
    expect(await browser.agentApiKeys.revoke({ id: "key-1" })).toEqual({
      revoked: true,
    });
    return await expectCode(
      browser.agentApiKeys.revoke({ id: "key-other" }),
      "NOT_FOUND",
      404
    );
  });

  it("requires a session and a wired service", async () => {
    await expectCode(
      harness(null).client().agentApiKeys.list({}),
      "UNAUTHORIZED",
      401
    );
    return await expectCode(
      harness(session()).client({ wireKeys: false }).agentApiKeys.list({}),
      "UNAVAILABLE",
      503
    );
  });

  it("bounds key names", () => {
    expect(AgentApiKeyCreateInputSchema.safeParse({ name: "" }).success).toBe(
      false
    );
    expect(
      AgentApiKeyCreateInputSchema.safeParse({ name: "x".repeat(65) }).success
    ).toBe(false);
    expect(
      AgentApiKeyCreateInputSchema.safeParse({ name: "omp", userId: "u" })
        .success
    ).toBe(false);
    return expect(
      AgentApiKeyCreateInputSchema.parse({ name: " omp " }).name
    ).toBe("omp");
  });
});

describe("operator allow-list (requireOperator)", () => {
  it("admits an active, verified session on the list and denies everyone else with 403 Operator access required", async () => {
    const operator = harness(session("user-a"), ["USER-A@domain.test"]);
    expect(
      (await operator.client().agentOps.tasks.list({})).tasks
    ).toHaveLength(1);
    expect((await operator.client().agentApiKeys.list({})).keys).toHaveLength(
      1
    );

    const outsider = harness(session("user-b"), ["user-a@domain.test"]);
    await expectCode(
      outsider.client().agentOps.tasks.list({}),
      "FORBIDDEN",
      403
    );
    await expectCode(outsider.client().papers.list({}), "FORBIDDEN", 403);
    await expectCode(
      outsider.client().agentApiKeys.create({ name: "mint" }),
      "FORBIDDEN",
      403
    );
    expect(outsider.service["create"]).not.toHaveBeenCalled();
    await expect(outsider.client().agentOps.summary({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operator access required",
    });

    const unverified = harness(session("user-a", { emailVerified: false }), [
      "user-a@domain.test",
    ]);
    await expectCode(
      unverified.client().agentOps.tasks.list({}),
      "FORBIDDEN",
      403
    );
    return await expectCode(
      unverified.client().agentApiKeys.list({}),
      "FORBIDDEN",
      403
    );
  });

  it("denies every session and key when the list is empty (fail closed)", async () => {
    const closed = harness(session("user-a"), []);
    await expectCode(closed.client().agentOps.tasks.list({}), "FORBIDDEN", 403);
    await expectCode(closed.client().papers.list({}), "FORBIDDEN", 403);
    await expectCode(closed.client().agentApiKeys.list({}), "FORBIDDEN", 403);
    await expectCode(
      closed
        .client({ apiKey: PLAINTEXT })
        .agentOps.tasks.create({ kind: "ops", agent: "a", title: "t" }),
      "FORBIDDEN",
      403
    );
    return expect(closed.agentOps.createTask).not.toHaveBeenCalled();
  });

  it("admits a key whose owner is an operator and denies it as soon as the owner leaves the list", async () => {
    const h = harness(session("user-a"), ["user-a@domain.test"]);
    const keyed = h.client({ apiKey: PLAINTEXT });
    expect((await keyed.agentOps.tasks.list({})).tasks).toHaveLength(1);
    h.operators.splice(0, h.operators.length);
    await expectCode(keyed.agentOps.tasks.list({}), "FORBIDDEN", 403);
    await expectCode(keyed.papers.list({}), "FORBIDDEN", 403);
    return expect(h.service["authenticate"]).toHaveBeenCalledTimes(3);
  });

  it("denies a key whose owner is unverified or not on the list, regardless of the session cookie", async () => {
    const unverifiedOwner = harness(session("user-a"), ["user-a@domain.test"], {
      email: "user-a@domain.test",
      emailVerified: false,
    });
    await expectCode(
      unverifiedOwner.client({ apiKey: PLAINTEXT }).agentOps.tasks.list({}),
      "FORBIDDEN",
      403
    );
    const foreignOwner = harness(session("user-a"), ["user-a@domain.test"], {
      email: "intruder@domain.test",
      emailVerified: true,
    });
    await expectCode(
      foreignOwner.client({ apiKey: PLAINTEXT }).agentOps.tasks.list({}),
      "FORBIDDEN",
      403
    );
    return expect(foreignOwner.requireSession).not.toHaveBeenCalled();
  });
});
