import { readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  type AgentApiKeyService,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type ClickLogInsert,
  type ClickLogRepository,
  DatabasePersistenceError,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { redactClickRoute, redactClickText } from "./click-log-redaction.ts";
import { createApiClient, observeApiCalls } from "./client.ts";
import {
  CLICK_LOG_KINDS,
  CLICK_LOG_ROLES,
  type ClickLogEventInput,
  type ClickLogRecordInput,
} from "./contracts/click-log.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import {
  CLICK_LOG_MAX_CLOCK_SKEW_MS,
  toClickLogInsert,
} from "./server/click-log.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";

const PLAINTEXT = `vrk_${"D".repeat(64)}`;
const TAB = "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11";
const at = new Date("2026-11-01T12:00:00.000Z");

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-04T12:00:00.000Z"),
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
  },
});

type ClientOptions = Readonly<{
  session?: SafeAuthSession | Error | null;
  repository?: ClickLogRepository;
  apiKeyAccess?: "read" | "write";
}>;

const clientFor = (options: ClientOptions = {}) => {
  const repositories = (options.repository === undefined
    ? {}
    : { clickLog: options.repository }) as unknown as Repositories;
  const keys = {
    authenticate: vi.fn(async () => ({
      access: options.apiKeyAccess ?? "read",
      apiKeyId: "key-1",
      email: "operator@domain.test",
      emailVerified: true,
      role: "member" as const,
      status: "active" as const,
      userId: "operator",
    })),
  } as unknown as AgentApiKeyService;
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKeyAccess !== undefined)
        request.headers.set("x-api-key", PLAINTEXT);
      const context = createApiContext(request, {
        agentApiKeys: keys,
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw new AuthAuthorizationError(
            AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
            401
          );
        },
        requireSession: async () => {
          const value = options.session ?? null;
          if (value === null) {
            throw new AuthAuthorizationError(
              AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
              401
            );
          }
          if (value instanceof Error) throw value;
          return value;
        },
      });
      const response = await handleApiRequest(request, context);
      response.headers.set("x-request-id", "request-1");
      return response;
    },
  });
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
};

const repository = (
  overrides: Partial<ClickLogRepository> = {}
): ClickLogRepository => ({
  query: vi.fn(async () => ({ events: [], truncated: false })),
  record: vi.fn(async (events: readonly ClickLogInsert[]) => events.length),
  ...overrides,
});

const clickEvent = (
  overrides: Partial<ClickLogEventInput> = {}
): ClickLogEventInput => ({
  at: new Date().toISOString(),
  important: false,
  kind: "click",
  label: "Open dashboard",
  requestIds: [],
  role: "link",
  route: "/assistant",
  targetRoute: "/dashboard",
  testId: null,
  ...overrides,
});

const batch = (
  events: ClickLogEventInput[] = [clickEvent()]
): ClickLogRecordInput => ({ buildSha: "abc1234", events, tabId: TAB });

// CodeQL js/polynomial-redos (alert 21): a long run with no "@" or no digit made the old EMAIL and
// TOKEN patterns scan it again from every position (more than 2 seconds at this size).
describe("click-log redaction in linear time", () => {
  const timed = (text: string): number => {
    const started = performance.now();
    redactClickText(text);
    redactClickRoute(text);
    return performance.now() - started;
  };

  it.each([
    ["no @", "!".repeat(100_000)],
    ["no digit", "a".repeat(100_000)],
    ["digits and separators", "1,".repeat(50_000)],
  ])("redacts a hostile label (%s) within the time limit", (_name, text) => {
    expect(timed(text)).toBeLessThan(1000);
  });

  // Not slow before; these guard the anchored patterns against a later change.
  it.each([
    ["many @", "a@".repeat(200_000)],
    ["email with a long domain", `a@${"b.".repeat(200_000)}`],
  ])("stays fast on a long label (%s)", (_name, text) => {
    expect(timed(text)).toBeLessThan(1000);
  });

  it("matches emails and tokens from the start of their run, as before", () => {
    expect(redactClickText("mail a@b@c.de now")).toBe("mail a@[email] now");
    expect(redactClickText("x@y.z,w@v.u")).toBe("[email]@v.u");
    expect(redactClickText(`id ${"a".repeat(23)}7 ok`)).toBe(
      "id [redacted] ok"
    );
    expect(redactClickText(`id ${"a".repeat(30)} ok`)).toBe(
      `id ${"a".repeat(30)} ok`
    );
    expect(redactClickText(`k.${"b".repeat(23)}9`)).toBe("k.[redacted]");
  });
});

describe("click log redaction", () => {
  it("replaces numbers, money, percents, emails and tokens, and never keeps typed values", () => {
    expect(redactClickText("Buy 1,250 AAPL @ $187.42")).toBe("Buy # AAPL @ #");
    expect(redactClickText("Close -12.5% position (€3 400)")).toBe(
      "Close # position (# #)"
    );
    expect(redactClickText("Invite owner@example.test now")).toBe(
      "Invite [email] now"
    );
    expect(redactClickText("Key vrk_abcdefABCDEF0123456789xyz")).toBe(
      "Key [redacted]"
    );
    expect(redactClickText("research-strategy-library-overview")).toBe(
      "research-strategy-library-overview"
    );
    expect(redactClickText("  Stop \n\t generating  ")).toBe("Stop generating");
    expect(redactClickText("x".repeat(200))).toHaveLength(80);
  });

  it("keeps route ids readable and redacts token-length segments", () => {
    expect(
      redactClickRoute("/assistant/0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11")
    ).toBe("/assistant/0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11");
    expect(redactClickRoute(`/reset/${"a1".repeat(30)}`)).toBe(
      "/reset/[redacted]"
    );
    expect(redactClickRoute(`/${"a/".repeat(400)}`)).toHaveLength(300);
    expect(redactClickRoute("/x?token=abc#email=a@b.test")).toBe("/x");
    expect(redactClickRoute("https://example.test")).toBe(
      "https://example.test"
    );
  });
});

describe("click log database checks", () => {
  it("allow exactly the contract kinds and roles", () => {
    const migration = readFileSync(
      new URL("../../db/migrations/0046_click_log.sql", import.meta.url),
      "utf8"
    );
    const list = (values: readonly string[]) =>
      values.map((value) => `'${value}'`).join(", ");
    expect(migration).toContain(`"kind" in (${list(CLICK_LOG_KINDS)})`);
    expect(migration).toContain(`"role" in (${list(CLICK_LOG_ROLES)})`);
  });
});

describe("toClickLogInsert", () => {
  const base = {
    buildSha: "abc1234",
    now: new Date("2026-11-03T20:00:00.000Z"),
    recordRequestId: "request-1",
    tabId: TAB,
    userId: "user-1",
  };

  it("redacts text again and keeps a plausible browser time", () => {
    const row = toClickLogInsert(
      clickEvent({
        at: "2026-11-03T19:59:30.000Z",
        label: "Sell 10 @ $5",
        route: `/x/${"b2".repeat(25)}`,
        targetRoute: `/y/${"c3".repeat(25)}`,
        testId: "order-123",
      }),
      base
    );
    expect(row).toMatchObject({
      label: "Sell # @ #",
      occurredAt: new Date("2026-11-03T19:59:30.000Z"),
      route: "/x/[redacted]",
      targetRoute: "/y/[redacted]",
      testId: "order-#",
      userId: "user-1",
    });
  });

  it("replaces a skewed browser time with the server time and keeps null fields", () => {
    const row = toClickLogInsert(
      clickEvent({
        at: new Date(
          base.now.getTime() - CLICK_LOG_MAX_CLOCK_SKEW_MS - 1
        ).toISOString(),
        targetRoute: null,
      }),
      base
    );
    expect(row).toMatchObject({
      occurredAt: base.now,
      targetRoute: null,
      testId: null,
    });
  });
});

describe("clickLog.record", () => {
  it("stores the session user's clicks with the record request id", async () => {
    const store = repository();
    const client = clientFor({ repository: store, session: session("user-1") });

    await expect(
      client.clickLog.record(
        batch([
          clickEvent({ label: "Pay $1,000 now" }),
          clickEvent({
            important: true,
            kind: "submit",
            requestIds: ["request-9"],
            role: "form",
            targetRoute: null,
          }),
        ])
      )
    ).resolves.toEqual({ accepted: 2 });

    const rows = vi.mocked(store.record).mock.calls[0]?.[0] ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      buildSha: "abc1234",
      label: "Pay # now",
      recordRequestId: "request-1",
      tabId: TAB,
      userId: "user-1",
    });
    expect(rows[1]).toMatchObject({
      important: true,
      kind: "submit",
      requestIds: ["request-9"],
    });
  });

  it("rejects anonymous callers, forbidden sessions, agent API keys and bad input", async () => {
    const store = repository();
    await expectCode(
      clientFor({ repository: store }).clickLog.record(batch()),
      "UNAUTHORIZED"
    );
    await expectCode(
      clientFor({
        repository: store,
        session: new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.FORBIDDEN,
          403
        ),
      }).clickLog.record(batch()),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({
        apiKeyAccess: "write",
        repository: store,
        session: session("operator"),
      }).clickLog.record(batch()),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({
        repository: store,
        session: session("user-1"),
      }).clickLog.record({
        ...batch(),
        events: [{ ...clickEvent(), value: "typed text" } as never],
      }),
      "BAD_REQUEST"
    );
    expect(store.record).not.toHaveBeenCalled();
  });

  it("maps storage failures and keeps other errors internal", async () => {
    await expectCode(
      clientFor({ session: session("user-1") }).clickLog.record(batch()),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor({
        repository: repository({
          record: () => Promise.reject(new DatabasePersistenceError("insert")),
        }),
        session: session("user-1"),
      }).clickLog.record(batch()),
      "STORAGE_ERROR"
    );
    await expectCode(
      clientFor({
        repository: repository({
          record: () => Promise.reject(new Error("bug")),
        }),
        session: session("user-1"),
      }).clickLog.record(batch()),
      "INTERNAL_SERVER_ERROR"
    );
    await expectCode(
      clientFor({
        repository: repository(),
        session: new Error("auth backend down"),
      }).clickLog.record(batch()),
      "INTERNAL_SERVER_ERROR"
    );
  });
});

describe("clickLog.query", () => {
  const stored = {
    buildSha: "abc1234",
    id: "row-1",
    important: true,
    kind: "click",
    label: "Stop",
    occurredAt: at,
    receivedAt: at,
    recordRequestId: "request-1",
    requestIds: ["request-2"],
    role: "button",
    route: "/assistant",
    tabId: TAB,
    targetRoute: null,
    testId: null,
    userEmail: "user-1@domain.test",
    userId: "user-1",
  };
  const range = {
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-02T00:00:00.000Z",
  };

  it("lets an operator read one user's clicks in a time range", async () => {
    const store = repository({
      query: vi.fn(async () => ({ events: [stored], truncated: true })),
    });
    const client = clientFor({
      repository: store,
      session: session("operator"),
    });

    await expect(
      client.clickLog.query({ ...range, limit: 10, user: "user-1" })
    ).resolves.toEqual({ events: [stored], truncated: true });
    expect(store.query).toHaveBeenCalledWith({
      from: new Date(range.from),
      limit: 10,
      to: new Date(range.to),
      user: "user-1",
    });

    await client.clickLog.query(range);
    expect(store.query).toHaveBeenLastCalledWith({
      from: new Date(range.from),
      limit: 500,
      to: new Date(range.to),
    });
  });

  it("accepts a read-access operator API key", async () => {
    const store = repository();
    await expect(
      clientFor({ apiKeyAccess: "read", repository: store }).clickLog.query(
        range
      )
    ).resolves.toEqual({ events: [], truncated: false });
  });

  it("refuses non-operators, reversed ranges and missing storage", async () => {
    await expectCode(
      clientFor({
        repository: repository(),
        session: session("user-1"),
      }).clickLog.query(range),
      "FORBIDDEN"
    );
    await expectCode(
      clientFor({
        repository: repository(),
        session: session("operator"),
      }).clickLog.query({ from: range.to, to: range.from }),
      "BAD_REQUEST"
    );
    await expectCode(
      clientFor({ session: session("operator") }).clickLog.query(range),
      "STORAGE_ERROR"
    );
  });

  it("is published under /click-log/events and is not an MCP tool", async () => {
    const document = await buildOpenApiDocument();
    expect(document.paths?.["/click-log/events"]?.get?.operationId).toBe(
      "clickLog.query"
    );
    expect(document.paths?.["/click-log/events"]?.post?.operationId).toBe(
      "clickLog.record"
    );
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("clickLog"))
    ).toBe(false);
  });
});

describe("observeApiCalls", () => {
  it("reports each oRPC exchange with its request id and isolates failing observers", async () => {
    const seen: unknown[] = [];
    const stopFailing = observeApiCalls(() => {
      throw new Error("observer bug");
    });
    const stop = observeApiCalls((observation) => seen.push(observation));
    const client = clientFor({
      repository: repository(),
      session: session("user-1"),
    });

    await client.clickLog.record(batch());
    stop();
    stopFailing();
    await client.clickLog.record(batch());

    const call = {
      path: "clickLog.record",
      requestId: "request-1",
      startedAt: expect.any(Number),
      status: 200,
    };
    expect(seen).toEqual([
      { ...call, phase: "open" },
      { ...call, phase: "closed" },
    ]);
  });
});
