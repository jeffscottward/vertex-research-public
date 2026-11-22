import {
  AgentApiKeyRateLimitedError,
  type AgentApiKeyRecord,
  type AgentApiKeyService,
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { AgentTask, ResearchPaper } from "@darkfactory/db/schema";
import type {
  AgentOpsRepository,
  Repositories,
  ResearchPapersRepository,
} from "@darkfactory/db/server";
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
  agent: "omp",
  createdAt: at,
  finishedAt: null,
  id: "task-1",
  kind: "backtest",
  links: [],
  metrics: {},
  paperId: null,
  startedAt: null,
  status: "queued",
  summary: null,
  title: "Backtest",
  updatedAt: at,
  ...overrides,
});

const paper = (): ResearchPaper => ({
  authors: null,
  blockers: null,
  createdAt: at,
  id: "paper-1",
  identifier: null,
  kind: "paper",
  notes: null,
  reportedMetrics: {},
  reproducedMetrics: {},
  sourceUrl: null,
  stage: "queued",
  title: "Paper",
  updatedAt: at,
  verdict: "pending",
  year: null,
});

const agentOpsRepository = (): AgentOpsRepository => {
  return {
    appendEvent: vi.fn(async (input) => ({
      at,
      id: "event-1",
      level: input.level ?? "info",
      message: input.message,
      taskId: input.taskId,
    })),
    createTask: vi.fn(async (input) =>
      task({
        agent: input.agent,
        id: "task-9",
        kind: input.kind,
        title: input.title,
      })
    ),
    getTask: vi.fn(async () => null),
    listTasks: vi.fn(async () => [task()]),
    summary: vi.fn(),
    updateTask: vi.fn(async (input) =>
      task({ id: input.id, status: input.status ?? "queued" })
    ),
  } as unknown as AgentOpsRepository;
};

const papersRepository = (): ResearchPapersRepository => {
  return {
    add: vi.fn(),
    list: vi.fn(async () => [paper()]),
    update: vi.fn(),
  } as unknown as ResearchPapersRepository;
};

const session = (
  userId = "user-a",
  overrides: Partial<SafeAuthSession["user"]> = {}
): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
    ...overrides,
  },
});

const record = (
  overrides: Partial<AgentApiKeyRecord> = {}
): AgentApiKeyRecord => ({
  access: "read",
  createdAt: at,
  enabled: true,
  expiresAt: null,
  id: "key-1",
  lastUsedAt: null,
  name: "omp-rig",
  prefix: "vrk_",
  start: "vrk_AA",
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
  access?: "read" | "write";
  email: string;
  emailVerified: boolean;
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
        access: "write" as const,
        apiKeyId: "key-1",
        role: "member" as const,
        status: "active" as const,
        userId: "user-a",
        ...keyOwner,
      };
    }),
    create: vi.fn(async (_headers: Headers, input: { name: string }) => ({
      key: PLAINTEXT,
      record: record({ name: input.name }),
    })),
    list: vi.fn(async () => [record()]),
    revoke: vi.fn(async (_headers: Headers, id: string) => id === "key-1"),
  };
  const requireSession = vi.fn(async () => {
    if (requestSession === null) throw denied();
    return requestSession;
  });
  const agentOps = agentOpsRepository();
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    agentOps,
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    researchPapers: papersRepository(),
    userPreferences: {} as Repositories["userPreferences"],
    watchlist: {
      list: vi.fn(async () => []),
    } as unknown as NonNullable<Repositories["watchlist"]>,
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
          capabilities: {
            ai: false,
            analytics: false,
            emailDelivery: false,
            telemetryExport: false,
          },
          operatorEmails: [...operators],
          repositories,
          requestId: "request-1",
          requireRole: async () => {
            throw denied();
          },
          requireSession,
          ...(options.wireKeys === false
            ? {}
            : { agentApiKeys: service as unknown as AgentApiKeyService }),
        });
        return handleApiRequest(request, context);
      },
    });
  };
  return { agentOps, client, operators, requireSession, service };
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
  it("admits only agentOps.*, papers.*, strategyLibrary.*, marketData.*, backtestRuns.*, todos.*, priceAlerts.*, agentModelRuns.* and openbb.* procedure paths, the autopilot tick and the sector rotation collect and snapshot", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).toEqual([
      "agentOps",
      "papers",
      "strategyLibrary",
      "marketData",
      "backtestRuns",
      "todos",
      "priceAlerts",
      "agentModelRuns",
      "openbb",
    ]);
    expect(AGENT_API_KEY_PROCEDURE_PATHS).toEqual([
      "autopilot.campaigns.tick",
      "sectorRotation.collect",
      "sectorRotation.recordChatDelivery",
      "sectorRotation.snapshot",
      "clickLog.query",
      "pickLists.import",
      "pickLists.list",
      "pickLists.proposal",
      "pickLists.screen",
      "flow.collect",
      "flow.snapshot",
      "flow.control",
      "flow.events",
      "breadth90.collect",
      "breadth90.get",
      "goLiveDrafts.collect",
      "goLiveDrafts.queue",
      "instantBacktest.run",
      "marketNotes.add",
      "marketNotes.get",
      "marketNotes.list",
      "marketNotes.recordChecks",
      "marketNotes.review",
      "researchScreen.tick",
      "congressTrades.feed",
      "smartMoney.ranking",
      "marketRegime.get",
    ]);
    expect(isAgentApiKeyProcedurePath(["flow", "snapshot"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["flow", "control"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["flow", "events"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["autopilot", "campaigns", "tick"])).toBe(
      true
    );
    expect(isAgentApiKeyProcedurePath(["sectorRotation", "snapshot"])).toBe(
      true
    );
    expect(isAgentApiKeyProcedurePath(["sectorRotation", "map"])).toBe(false);
    expect(isAgentApiKeyProcedurePath(["instantBacktest", "run"])).toBe(true);
    expect(isAgentApiKeyProcedurePath(["instantBacktest", "series"])).toBe(
      false
    );
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
      "openbb",
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
      agent: "omp",
      kind: "backtest",
      title: "Backtest jump model",
    });
    expect(created).toMatchObject({
      id: "task-9",
      title: "Backtest jump model",
    });
    await keyed.agentOps.tasks.update({ id: created.id, status: "running" });
    const event = await keyed.agentOps.tasks.appendEvent({
      message: "fold 1/5",
      taskId: created.id,
    });
    expect(event).toMatchObject({ message: "fold 1/5", taskId: "task-9" });
    expect((await keyed.papers.list({})).papers).toHaveLength(1);
    expect(service["authenticate"]).toHaveBeenCalledTimes(4);
    expect(requireSession).not.toHaveBeenCalled();
    return expect(agentOps.createTask).toHaveBeenCalledTimes(1);
  });

  it("lets a read key list and get but refuses every ledger write with 403", async () => {
    const { client, agentOps } = harness(session(), ["user-a@domain.test"], {
      access: "read",
      email: "user-a@domain.test",
      emailVerified: true,
    });
    const reader = client({ apiKey: PLAINTEXT });
    expect((await reader.papers.list({})).papers).toHaveLength(1);
    await reader.agentOps.tasks.list({});
    await expectCode(
      reader.agentOps.tasks.create({ agent: "a", kind: "ops", title: "t" }),
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
        agent: "a",
        kind: "ops",
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
      lastUsedAt: null,
      name: "omp-rig",
      start: "vrk_AA",
    });
    expect(service["create"].mock.calls[0]?.[1]).toEqual({
      access: "read",
      name: "omp-rig",
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
    await expectCode(
      harness(session()).client({ wireKeys: false }).agentApiKeys.list({}),
      "UNAVAILABLE",
      503
    );
    return await expect(
      harness(session()).client({ wireKeys: false }).agentApiKeys.list({})
    ).rejects.toMatchObject({
      message:
        "Agent API keys are not configured on this server; no key was read or changed",
    });
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
        .agentOps.tasks.create({ agent: "a", kind: "ops", title: "t" }),
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
