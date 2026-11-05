import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import { serverEnvSchema } from "@darkfactory/config/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import {
  engineStatusUrl,
  fetchEnginesStatus,
  setEngineStatusOptionsForTesting,
  toEnginesStatus,
} from "./server/engines.ts";
import { LoopbackStatusError } from "./server/loopback-status.ts";
import { MCP_TOOLS } from "./server/mcp.ts";

const BASE = "http://127.0.0.1:3462";
const NOW = new Date("2026-11-02T15:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;

const engine = (overrides: Record<string, unknown> = {}) => ({
  unit: "market-watch-gex",
  timerActive: true,
  serviceState: "inactive",
  result: "success",
  exitStatus: 0,
  lastRunAt: NOW_S - 60,
  lastExitAt: NOW_S - 55,
  nextRunAt: NOW_S + 840,
  ...overrides,
});

const document = (overrides: Record<string, unknown> = {}) => ({
  schema: "vertex-engine-status-v1",
  generatedAt: NOW_S - 30,
  host: "dev-rig",
  engines: [engine()],
  ...overrides,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => setEngineStatusOptionsForTesting({}));

describe("engine status mapping", () => {
  it("maps unit state to ISO times and flags an old push as stale", () => {
    expect(toEnginesStatus(document(), NOW)).toEqual({
      generatedAt: "2026-11-02T14:59:30.000Z",
      stale: false,
      engines: [
        {
          unit: "market-watch-gex",
          timerActive: true,
          serviceState: "inactive",
          result: "success",
          exitStatus: 0,
          lastRunAt: "2026-11-02T14:59:00.000Z",
          lastExitAt: "2026-11-02T14:59:05.000Z",
          nextRunAt: "2026-11-02T15:14:00.000Z",
        },
      ],
    });
    const old = toEnginesStatus(
      document({
        generatedAt: NOW_S - 600,
        engines: [engine({ lastRunAt: null, nextRunAt: null })],
      }),
      NOW
    );
    expect(old.stale).toBe(true);
    expect(old.engines[0]?.lastRunAt).toBeNull();
  });

  it("rejects other schemas and unsafe unit names", () => {
    for (const raw of [
      {},
      document({ schema: "other" }),
      document({ engines: [engine({ unit: "a b" })] }),
    ])
      expect(() => toEnginesStatus(raw, NOW)).toThrow(/unexpected shape/u);
  });
});

describe("engine status reader", () => {
  it("accepts only a plain loopback http base and reads /status.json", async () => {
    expect(engineStatusUrl(`${BASE}/ignored`)).toBe(
      "http://127.0.0.1:3462/status.json"
    );
    for (const base of [
      null,
      "",
      "not a url",
      "https://127.0.0.1:3462",
      "http://quantvps:3462",
      "http://u:p@127.0.0.1:3462",
      "http://127.0.0.1:3462?x=1",
    ])
      expect(() => engineStatusUrl(base)).toThrow(LoopbackStatusError);
    const doFetch = vi.fn(async () => jsonResponse(document()));
    const output = await fetchEnginesStatus(BASE, {
      fetch: doFetch,
      now: () => NOW,
    });
    expect(output.engines).toHaveLength(1);
    expect(doFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3462/status.json",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
    const url = serverEnvSchema.shape.ENGINE_STATUS_URL;
    expect(url.safeParse("http://127.0.0.1:3462").success).toBe(true);
    expect(url.safeParse("http://quantvps:3462").success).toBe(false);
  });

  it("maps failures to typed codes", async () => {
    const cases: [() => Promise<Response>, string][] = [
      [
        async () => {
          throw new Error("refused");
        },
        "UNAVAILABLE",
      ],
      [async () => new Response("", { status: 404 }), "UNAVAILABLE"],
      [async () => new Response("", { status: 500 }), "UPSTREAM_ERROR"],
      [async () => new Response("{", { status: 200 }), "UPSTREAM_ERROR"],
      [
        async () => new Response("x".repeat(300 * 1024), { status: 200 }),
        "UPSTREAM_ERROR",
      ],
    ];
    for (const [fetch, code] of cases)
      await expect(fetchEnginesStatus(BASE, { fetch })).rejects.toMatchObject({
        code,
      });
  });

  it("aborts a request that runs past the timeout", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    await expect(
      fetchEnginesStatus(BASE, { fetch: hang, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("uses the global fetch and clock by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          document({ generatedAt: Math.floor(Date.now() / 1000) - 1 })
        )
      );
    try {
      const output = await fetchEnginesStatus(BASE, { timeoutMs: 1000 });
      expect(output.stale).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

const at = new Date("2026-11-01T12:00:00.000Z");
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
    expiresAt: new Date("2026-11-03T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  engineStatus: string | null
) => {
  const repositories = {} as unknown as Repositories;
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
      operatorEmails: ["operator@domain.test"],
      engineStatus,
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code });
  }
};

describe("engines.status procedure", () => {
  it("is operator-only and maps reader errors", async () => {
    const doFetch = vi.fn(async () => jsonResponse(document()));
    setEngineStatusOptionsForTesting({ fetch: doFetch, now: () => NOW });
    await expectCode(clientFor(null, BASE).engines.status({}), "UNAUTHORIZED");
    await expectCode(
      clientFor(session("outsider"), BASE).engines.status({}),
      "FORBIDDEN"
    );
    expect(doFetch).not.toHaveBeenCalled();
    const output = await clientFor(session("operator"), BASE).engines.status(
      {}
    );
    expect(output.engines[0]?.unit).toBe("market-watch-gex");
    await expectCode(
      clientFor(session("operator"), null).engines.status({}),
      "NOT_CONFIGURED"
    );
    setEngineStatusOptionsForTesting({
      fetch: async () => jsonResponse(document()),
      now: () => {
        throw new Error("clock failed");
      },
    });
    await expectCode(
      clientFor(session("operator"), BASE).engines.status({}),
      "UPSTREAM_ERROR"
    );
  });

  it("is not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("engines");
    expect(MCP_TOOLS.some((tool) => tool.procedure.startsWith("engines"))).toBe(
      false
    );
  });
});
