import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import type {
  SemanticEvent,
  SpanHandle,
} from "@darkfactory/observability/port";
import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { IbkrRecoveryRequestInputSchema } from "./contracts/ibkr-recovery.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import {
  setIbkrRecoveryDependenciesForTesting,
  toActorId,
} from "./server/ibkr-recovery.ts";
import { MCP_TOOLS } from "./server/mcp.ts";

// Fake QuantVPS recovery service only. No test here can start the real 2FA script.
const at = new Date("2026-10-28T15:00:00.000Z");
const TOKEN = "r".repeat(48);
const CONFIG: DeployStatusConfig = {
  token: TOKEN,
  url: "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1/",
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-29T12:00:00.000Z"),
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

type Upstream = Record<string, unknown>;

const upstreamRequest = (overrides: Upstream = {}): Upstream => ({
  actorId: "operator",
  detail: "",
  finishedAt: null,
  requestedAt: "2026-10-28T14:58:00Z",
  requestId: "req-00000001",
  scriptRunning: true,
  state: "waiting-for-approval",
  updatedAt: "2026-10-28T14:58:30Z",
  ...overrides,
});

const upstreamStatus = (overrides: Upstream = {}): Upstream => ({
  cooldown: { seconds: 900, until: null },
  gateway: {
    loginState: "logged-out",
    needsLogin: true,
    reason: "2fa-timeout",
    since: "2026-10-28T14:50:00Z",
  },
  generatedAt: "2026-10-28T14:59:59Z",
  history: [],
  request: null,
  schema: "vertex-ibkr-recovery-status-v1",
  version: "1.0.0",
  ...overrides,
});

type Route = (init: RequestInit) => Response | Promise<Response>;
type Calls = { url: string; init: RequestInit }[];

let routes: { status: Route; request: Route };
let calls: Calls;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ init, url });
  if (url.endsWith("/status")) return routes.status(init);
  if (url.endsWith("/request")) return routes.request(init);
  return json({ error: "not_found" }, 404);
};

const postCalls = () => calls.filter((call) => call.url.endsWith("/request"));

type Options = Readonly<{
  user?: string | null;
  config?: DeployStatusConfig | null;
  events?: SemanticEvent[] | null;
  emitFails?: boolean;
  sinkFailedFor?: string;
  span?: SpanHandle;
  apiKey?: boolean;
}>;

const clientFor = ({
  user = "operator",
  config = CONFIG,
  events = [],
  emitFails = false,
  sinkFailedFor,
  span,
  apiKey = false,
}: Options = {}) => {
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const headers = new Headers(request.headers);
    if (apiKey) headers.set("x-api-key", "k".repeat(40));
    const sent = new Request(request, { headers });
    const context = createApiContext(sent, {
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      ibkrRecovery: config,
      operatorEmails: ["operator@domain.test", "second@domain.test"],
      repositories: {} as unknown as Repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (user === null) throw denied();
        return session(user);
      },
      ...(span === undefined ? {} : { span }),
      ...(events === null
        ? {}
        : {
            semanticEvents: {
              emit: async (event: SemanticEvent) => {
                events.push(event);
                if (emitFails) throw new Error("sink down");
                return {
                  analytics: "skipped" as const,
                  span: "skipped" as const,
                  structuredEvent:
                    sinkFailedFor === event.name
                      ? ("failed" as const)
                      : ("emitted" as const),
                };
              },
            },
          }),
    });
    return handleApiRequest(sent, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
    return error;
  }
  throw new Error("Expected the oRPC call to fail");
};

const send = (options: Options = {}) =>
  clientFor(options).ibkrRecovery.request({
    confirmation: RECOVERY_CONFIRMATION,
  });

let nowMs: number;

beforeEach(() => {
  nowMs = at.getTime();
  calls = [];
  routes = {
    request: (init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json(
        {
          outcome: "started",
          request: upstreamRequest({
            actorId: body["actorId"],
            requestId: body["requestId"],
            state: "requested",
          }),
          schema: "vertex-ibkr-recovery-request-v1",
        },
        202
      );
    },
    status: () => json(upstreamStatus()),
  };
  setIbkrRecoveryDependenciesForTesting({
    fetch: fakeFetch,
    newRequestId: () => "req-new-0001",
    now: () => new Date(nowMs),
  });
});

afterEach(() => setIbkrRecoveryDependenciesForTesting({}));

describe("ibkrRecovery access", () => {
  it("is operator-only and unreachable by agent API keys and MCP tools", async () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("ibkrRecovery");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("ibkrRecovery"))
    ).toBe(false);
    await expectCode(
      clientFor({ user: "member" }).ibkrRecovery.status({}),
      "FORBIDDEN",
      403
    );
    await expectCode(send({ user: "member" }), "FORBIDDEN", 403);
    await expectCode(send({ user: null }), "UNAUTHORIZED", 401);
    await expectCode(send({ apiKey: true }), "FORBIDDEN", 403);
    return expect(calls).toHaveLength(0);
  });

  it("accepts only the exact recovery statement", () => {
    expect(
      IbkrRecoveryRequestInputSchema.safeParse({
        confirmation: RECOVERY_CONFIRMATION,
      }).success
    ).toBe(true);
    expect(
      IbkrRecoveryRequestInputSchema.safeParse({ confirmation: "yes" }).success
    ).toBe(false);
    return expect(
      IbkrRecoveryRequestInputSchema.safeParse({
        confirmation: RECOVERY_CONFIRMATION,
        dryRun: true,
      }).success
    ).toBe(false);
  });

  it("reports not configured without calling the VPS", async () => {
    await expectCode(
      clientFor({ config: null }).ibkrRecovery.status({}),
      "NOT_CONFIGURED",
      503
    );
    await expectCode(send({ config: null }), "NOT_CONFIGURED", 503);
    return expect(calls).toHaveLength(0);
  });

  it("cleans actor ids to the VPS pattern", () => {
    expect(toActorId("user_AB-12")).toBe("user_AB-12");
    expect(toActorId("a.b@c")).toBe("a_b_c");
    expect(toActorId("x".repeat(80))).toHaveLength(64);
    return expect(toActorId("")).toBe("unknown");
  });
});

describe("ibkrRecovery.status", () => {
  it("maps the VPS status and sends the bearer token with a GET", async () => {
    const status = await clientFor().ibkrRecovery.status({});
    expect(status).toEqual({
      canRequest: true,
      checkedAt: at.toISOString(),
      cooldownUntil: null,
      gateway: {
        feedsMissing: false,
        loginState: "logged-out",
        needsLogin: true,
        reason: "2fa-timeout",
        since: "2026-10-28T14:50:00Z",
      },
      request: null,
    });
    expect(calls[0]?.url).toBe(
      "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1/status"
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.redirect).toBe("manual");
    return expect(
      new Headers(calls[0]?.init.headers).get("authorization")
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("marks requests by the caller and blocks a new request while one runs", async () => {
    routes.status = () =>
      json(
        upstreamStatus({
          cooldown: { seconds: 900, until: "2026-10-28T15:13:00Z" },
          request: upstreamRequest(),
        })
      );
    const mine = await clientFor().ibkrRecovery.status({});
    expect(mine.request).toMatchObject({
      requestedByYou: true,
      requestId: "req-00000001",
      state: "waiting-for-approval",
    });
    expect(mine.canRequest).toBe(false);
    expect(mine.cooldownUntil).toBe("2026-10-28T15:13:00Z");
    const theirs = await clientFor({ user: "second" }).ibkrRecovery.status({});
    return expect(theirs.request?.requestedByYou).toBe(false);
  });

  it("ignores a cooldown time in the past and keeps the button off when not needed", async () => {
    routes.status = () =>
      json(
        upstreamStatus({
          cooldown: { seconds: 900, until: "2026-10-28T14:00:00Z" },
          gateway: {
            loginState: "logged-in",
            needsLogin: false,
            reason: "logged-in",
            since: null,
          },
        })
      );
    const status = await clientFor().ibkrRecovery.status({});
    expect(status.cooldownUntil).toBeNull();
    return expect(status.canRequest).toBe(false);
  });

  it("allows a request for a logged-in gateway with missing account feeds and maps the re-check", async () => {
    const recheck = {
      at: "2026-10-28T15:13:00Z",
      detail: "not authenticated (login logged-in, account feeds missing)",
      ok: false,
    };
    routes.status = () =>
      json(
        upstreamStatus({
          gateway: {
            feedsMissing: true,
            loginState: "logged-in",
            needsLogin: false,
            reason: "logged-in",
            since: null,
          },
          request: upstreamRequest({
            finishedAt: "2026-10-28T14:59:00Z",
            recheck,
            recheckAt: "2026-10-28T15:13:00Z",
            scriptRunning: false,
            state: "timed-out",
          }),
          version: "1.1.0",
        })
      );
    const status = await clientFor().ibkrRecovery.status({});
    expect(status.canRequest).toBe(true);
    expect(status.gateway.feedsMissing).toBe(true);
    expect(status.request).toMatchObject({
      recheck,
      recheckAt: "2026-10-28T15:13:00Z",
    });
    const result = await send();
    expect(result.outcome).toBe("started");
    return expect(postCalls()).toHaveLength(1);
  });

  it("audits a finished request once per process", async () => {
    const events: SemanticEvent[] = [];
    routes.status = () =>
      json(
        upstreamStatus({
          request: upstreamRequest({
            detail: "account snapshot OK",
            finishedAt: "2026-10-28T14:59:00Z",
            scriptRunning: false,
            state: "logged-in",
          }),
        })
      );
    await clientFor({ events }).ibkrRecovery.status({});
    await clientFor({ events }).ibkrRecovery.status({});
    const results = events.filter(
      (event) => event.name === "vertex.ibkrRecovery.result"
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      attributes: {
        recoveryRequestId: "req-00000001",
        requestedBy: "operator",
        state: "logged-in",
        userId: "operator",
      },
      entityType: "ibkr-gateway-recovery",
      outcome: "success",
    });
    routes.status = () =>
      json(
        upstreamStatus({
          request: upstreamRequest({
            finishedAt: "2026-10-28T14:59:00Z",
            requestId: "req-00000002",
            scriptRunning: false,
            state: "timed-out",
          }),
        })
      );
    await clientFor({ events }).ibkrRecovery.status({});
    return expect(
      events.filter((event) => event.name === "vertex.ibkrRecovery.result")[1]
    ).toMatchObject({ outcome: "failure" });
  });

  it.each([
    [() => json({ error: "x" }, 503), "UNAVAILABLE", 503],
    [() => json({ error: "unauthorized" }, 401), "UPSTREAM_ERROR", 502],
    [
      () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
      "UPSTREAM_ERROR",
      502,
    ],
    [
      () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
      "UPSTREAM_ERROR",
      502,
    ],
    [() => json({ schema: "other" }), "UPSTREAM_ERROR", 502],
    [() => new Response(new TextEncoder().encode("{}")), "UPSTREAM_ERROR", 502],
    [
      () =>
        new Response("x".repeat(70_000), {
          headers: { "content-type": "application/json" },
        }),
      "UPSTREAM_ERROR",
      502,
    ],
    [
      () => {
        throw new TypeError("network down");
      },
      "UNAVAILABLE",
      503,
    ],
  ] as const)("maps upstream failure %# to %s", async (route, code, status) => {
    routes.status = route;
    const error = await expectCode(
      clientFor().ibkrRecovery.status({}),
      code,
      status
    );
    return expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("reports a timeout as unavailable", async () => {
    setIbkrRecoveryDependenciesForTesting({
      // The ES2023 lib in this package has no Promise.withResolvers.
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        }),
      timeoutMs: 5,
    });
    const error = await expectCode(
      clientFor().ibkrRecovery.status({}),
      "UNAVAILABLE",
      503
    );
    return expect(error).toMatchObject({
      message: "IBKR recovery request timed out",
    });
  });

  it("reports an unreadable body as unavailable", async () => {
    routes.status = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("reset"));
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    return expectCode(clientFor().ibkrRecovery.status({}), "UNAVAILABLE", 503);
  });

  it("uses the global fetch when no test fetch is set", async () => {
    setIbkrRecoveryDependenciesForTesting({});
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(upstreamStatus()));
    try {
      const status = await clientFor().ibkrRecovery.status({});
      expect(status.canRequest).toBe(true);
      return expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ibkrRecovery.request", () => {
  it("writes the intent audit, then asks the VPS to start the script once", async () => {
    const events: SemanticEvent[] = [];
    const span = {
      correlation: { spanId: "s".repeat(16), traceId: "t".repeat(32) },
    } as unknown as SpanHandle;
    const result = await send({ events, span });
    expect(result).toEqual({
      outcome: "started",
      request: {
        detail: "",
        finishedAt: null,
        recheck: null,
        recheckAt: null,
        requestedAt: "2026-10-28T14:58:00Z",
        requestedByYou: true,
        requestId: "req-new-0001",
        scriptRunning: true,
        state: "requested",
        updatedAt: "2026-10-28T14:58:30Z",
      },
    });
    const posts = postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(posts[0]?.init.body))).toEqual({
      actorId: "operator",
      dryRun: false,
      requestId: "req-new-0001",
      statement: RECOVERY_CONFIRMATION,
    });
    expect(events.map((event) => [event.name, event.outcome])).toEqual([
      ["vertex.ibkrRecovery.requestIntent", "success"],
      ["vertex.ibkrRecovery.request", "success"],
    ]);
    expect(events[0]).toMatchObject({
      attributes: { recoveryRequestId: "req-new-0001", userId: "operator" },
      correlation: { requestId: "request-1", traceId: "t".repeat(32) },
    });
    return expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("refuses without an audit record and never calls the VPS", async () => {
    await expectCode(send({ events: null }), "AUDIT_UNAVAILABLE", 503);
    await expectCode(send({ emitFails: true }), "AUDIT_UNAVAILABLE", 503);
    await expectCode(
      send({ sinkFailedFor: "vertex.ibkrRecovery.requestIntent" }),
      "AUDIT_UNAVAILABLE",
      503
    );
    return expect(postCalls()).toHaveLength(0);
  });

  it.each([
    [upstreamStatus({ request: upstreamRequest() }), "IN_FLIGHT", 409],
    [
      upstreamStatus({
        request: upstreamRequest({
          finishedAt: "2026-10-28T14:59:00Z",
          scriptRunning: true,
          state: "logged-in",
        }),
      }),
      "IN_FLIGHT",
      409,
    ],
    [
      upstreamStatus({
        cooldown: { seconds: 900, until: "2026-10-28T15:05:00Z" },
      }),
      "RATE_LIMITED",
      429,
    ],
    [
      upstreamStatus({
        gateway: {
          loginState: "starting",
          needsLogin: false,
          reason: "login-started",
          since: null,
        },
      }),
      "NOT_NEEDED",
      409,
    ],
    [
      upstreamStatus({
        gateway: {
          feedsMissing: true,
          loginState: "awaiting-2fa",
          needsLogin: false,
          reason: "2fa-started",
          since: null,
        },
      }),
      "NOT_NEEDED",
      409,
    ],
  ])("refuses before the VPS call (%#: %s)", async (status, code, http) => {
    const events: SemanticEvent[] = [];
    routes.status = () => json(status);
    await expectCode(send({ events }), code, http);
    expect(postCalls()).toHaveLength(0);
    return expect(events).toMatchObject([
      {
        attributes: { outcome: code },
        name: "vertex.ibkrRecovery.request",
        outcome: "failure",
      },
    ]);
  });

  it.each([
    [409, "in_flight", "IN_FLIGHT", 409],
    [409, "not_needed", "NOT_NEEDED", 409],
    [429, "cooldown", "RATE_LIMITED", 429],
    [400, "bad_request", "UPSTREAM_ERROR", 502],
    [409, "other", "UPSTREAM_ERROR", 502],
  ])("maps a VPS refusal %i %s to %s", async (http, error, code, status) => {
    const events: SemanticEvent[] = [];
    routes.request = () => json({ error }, http);
    await expectCode(send({ events }), code, status);
    return expect(events.at(-1)).toMatchObject({
      attributes: { outcome: code, recoveryRequestId: "req-new-0001" },
      name: "vertex.ibkrRecovery.request",
      outcome: "failure",
    });
  });

  it("maps a refusal body that is not an object", async () => {
    routes.request = () => json(["no"], 409);
    await expectCode(send(), "UPSTREAM_ERROR", 502);
    routes.request = () => json(null, 409);
    return expectCode(send(), "UPSTREAM_ERROR", 502);
  });

  it("audits a failed VPS call", async () => {
    const events: SemanticEvent[] = [];
    routes.request = () => {
      throw new TypeError("network down");
    };
    await expectCode(send({ events }), "UNAVAILABLE", 503);
    return expect(events.at(-1)).toMatchObject({
      attributes: { outcome: "UNAVAILABLE" },
      name: "vertex.ibkrRecovery.request",
      outcome: "failure",
    });
  });

  it("rejects a malformed start reply", async () => {
    routes.request = () =>
      json({ schema: "vertex-ibkr-recovery-request-v1" }, 202);
    return expectCode(send(), "UPSTREAM_ERROR", 502);
  });

  it("returns an existing request", async () => {
    routes.request = () =>
      json({
        outcome: "existing",
        request: upstreamRequest({ actorId: "second" }),
        schema: "vertex-ibkr-recovery-request-v1",
      });
    const result = await send();
    expect(result.outcome).toBe("existing");
    return expect(result.request.requestedByYou).toBe(false);
  });

  it("allows one send at a time per server process", async () => {
    let release: ((response: Response) => void) | undefined;
    let waiting = false;
    routes.status = () => {
      waiting = true;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const first = send();
    await vi.waitFor(() => expect(waiting).toBe(true));
    await expectCode(send(), "IN_FLIGHT", 409);
    release?.(json(upstreamStatus()));
    await first;
    return expect(postCalls()).toHaveLength(1);
  });

  it("uses a random request id by default", async () => {
    setIbkrRecoveryDependenciesForTesting({
      fetch: fakeFetch,
      now: () => new Date(nowMs),
    });
    const result = await send();
    return expect(result.request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps an unexpected handler error to an upstream error", async () => {
    setIbkrRecoveryDependenciesForTesting({
      fetch: fakeFetch,
      newRequestId: () => {
        throw new Error("no randomness");
      },
      now: () => new Date(nowMs),
    });
    return expectCode(send(), "UPSTREAM_ERROR", 502);
  });
});
