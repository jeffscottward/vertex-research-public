import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  NautilusArmAuditInput,
  Repositories,
} from "@darkfactory/db/server";
import type {
  SemanticEvent,
  SpanHandle,
} from "@darkfactory/observability/port";
import { ORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  NAUTILUS_ARM_STATEMENT,
  NautilusArmInputSchema,
} from "./contracts/nautilus-arm.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { AGENT_API_KEY_PROCEDURE_ROOTS } from "./server/handler.ts";
import { handleApiRequest } from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import {
  nautilusArmRouter,
  nodeBadge,
  setNautilusArmDependenciesForTesting,
  toArmActorId,
} from "./server/nautilus-arm.ts";

// Fake QuantVPS bridge only. No test here can reach the real node.
const at = new Date("2026-10-30T15:00:00.000Z");
const TOKEN = "r".repeat(48);
const PASSWORD = "correct horse battery";
const CONFIG: DeployStatusConfig = {
  token: TOKEN,
  url: "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1/",
};
const REASON = "Owner review done; arm for the open";

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-31T12:00:00.000Z"),
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

const armState = (armed: boolean) => ({
  armed,
  armedAt: armed ? "2026-10-30T14:59:00Z" : null,
  armedBy: armed ? "operator" : null,
  detail: armed ? "armed" : "no_arm_record",
  imageVersion: "1.4.2",
  killSwitchActive: false,
  reason: armed ? REASON : null,
  state: armed ? "armed" : "disarmed",
});

const upstreamStatus = (overrides: Record<string, unknown> = {}) => ({
  arm: armState(false),
  armError: null,
  container: { health: "healthy", state: "running" },
  generatedAt: "2026-10-30T14:59:59Z",
  schema: "vertex-nautilus-arm-status-v1",
  version: "1.0.0",
  ...overrides,
});

type Route = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<"status" | "arm" | "disarm", Route>;
let calls: { url: string; init: RequestInit }[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const result = (action: "arm" | "disarm", init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  return json({
    action,
    arm: armState(action === "arm"),
    auditId: "node-audit-1",
    requestId: body["requestId"],
    schema: "vertex-nautilus-arm-result-v1",
  });
};

const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ init, url });
  if (url.endsWith("/nautilus/status")) return routes.status(init);
  if (url.endsWith("/nautilus/arm")) return routes.arm(init);
  if (url.endsWith("/nautilus/disarm")) return routes.disarm(init);
  return json({ error: "not_found" }, 404);
};

const posts = () => calls.filter((call) => call.init.method === "POST");

type AuditRow = NautilusArmAuditInput & { at: Date };

const auditStore = () => {
  const rows: AuditRow[] = [];
  const failOn = new Set<string>();
  return {
    failOn,
    repository: {
      countSince: vi.fn(
        async (input: { action: string; actorUserId: string; since: Date }) =>
          rows.filter(
            (row) =>
              row.action === input.action &&
              row.actorUserId === input.actorUserId &&
              row.at >= input.since
          ).length
      ),
      record: vi.fn(async (input: NautilusArmAuditInput) => {
        if (failOn.has(input.action)) throw new Error("audit down");
        rows.push({ ...input, at: new Date(nowMs) });
        return { id: `audit-${rows.length}` };
      }),
    },
    rows,
  };
};

type Options = Readonly<{
  user?: string | null;
  config?: DeployStatusConfig | null;
  events?: SemanticEvent[] | null;
  emitFails?: boolean;
  span?: SpanHandle;
  apiKey?: boolean;
  audit?: ReturnType<typeof auditStore>["repository"] | null;
  verify?: ((password: string) => Promise<boolean>) | null;
}>;

let store: ReturnType<typeof auditStore>;

const clientFor = ({
  user = "operator",
  config = CONFIG,
  events = [],
  emitFails = false,
  span,
  apiKey = false,
  audit,
  verify = async (password) => password === PASSWORD,
}: Options = {}) => {
  const repository = audit === undefined ? store.repository : audit;
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
      operatorEmails: ["operator@domain.test"],
      repositories: (repository === null
        ? {}
        : { nautilusArmAudit: repository }) as unknown as Repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (user === null) throw denied();
        return session(user);
      },
      ...(span === undefined ? {} : { span }),
      ...(verify === null
        ? {}
        : { verifyPassword: async (_headers, password) => verify(password) }),
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
                  structuredEvent: "emitted" as const,
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

const armInput = {
  imageVersion: "1.4.2",
  password: PASSWORD,
  reason: REASON,
  statement: NAUTILUS_ARM_STATEMENT,
};

const arm = (options: Options = {}, input = armInput) =>
  clientFor(options).nautilusArm.arm(input);
const disarm = (options: Options = {}) =>
  clientFor(options).nautilusArm.disarm({});

let nowMs: number;

beforeEach(() => {
  nowMs = at.getTime();
  calls = [];
  store = auditStore();
  routes = {
    arm: (init) => result("arm", init),
    disarm: (init) => result("disarm", init),
    status: () => json(upstreamStatus()),
  };
  setNautilusArmDependenciesForTesting({
    fetch: fakeFetch,
    newRequestId: () => "arm-req-0001",
    now: () => new Date(nowMs),
  });
});

afterEach(() => setNautilusArmDependenciesForTesting({}));

describe("nautilusArm access", () => {
  it("is operator-only and refuses agent API keys on every procedure", async () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("nautilusArm");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("nautilusArm"))
    ).toBe(false);
    await expectCode(
      clientFor({ user: "member" }).nautilusArm.status({}),
      "FORBIDDEN",
      403
    );
    await expectCode(arm({ user: "member" }), "FORBIDDEN", 403);
    await expectCode(disarm({ user: "member" }), "FORBIDDEN", 403);
    await expectCode(arm({ user: null }), "UNAUTHORIZED", 401);
    // The handler refuses API keys for this namespace before any procedure runs.
    await expectCode(
      clientFor({ apiKey: true }).nautilusArm.status({}),
      "FORBIDDEN",
      403
    );
    await expectCode(arm({ apiKey: true }), "FORBIDDEN", 403);
    await expectCode(disarm({ apiKey: true }), "FORBIDDEN", 403);
    // The procedures refuse them again on their own (defense in depth).
    for (const [procedure, input] of [
      [nautilusArmRouter.status, {}],
      [nautilusArmRouter.arm, armInput],
      [nautilusArmRouter.disarm, {}],
    ] as const) {
      await expect(
        call(procedure as never, input as never, {
          context: { agentApiKeyPresented: true } as never,
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Agent API keys cannot use the Nautilus arm switch",
      });
    }
    expect(store.rows).toHaveLength(0);
    return expect(calls).toHaveLength(0);
  });

  it("accepts only the exact statement and a one-line reason of 10..280 characters", () => {
    const ok = (input: Record<string, unknown>) =>
      NautilusArmInputSchema.safeParse(input).success;
    expect(ok(armInput)).toBe(true);
    expect(ok({ ...armInput, statement: "yes" })).toBe(false);
    expect(ok({ ...armInput, reason: "too short" })).toBe(false);
    expect(ok({ ...armInput, reason: "x".repeat(281) })).toBe(false);
    expect(ok({ ...armInput, reason: `${REASON}\nsecond` })).toBe(false);
    expect(ok({ ...armInput, reason: ` ${REASON}` })).toBe(false);
    expect(ok({ ...armInput, reason: `-${REASON}` })).toBe(false);
    expect(ok({ ...armInput, imageVersion: "-1" })).toBe(false);
    expect(ok({ ...armInput, password: "" })).toBe(false);
    return expect(ok({ ...armInput, extra: true })).toBe(false);
  });

  it("cleans actor ids to the node pattern", () => {
    expect(toArmActorId("user_AB-12.x@y")).toBe("user_AB-12.x@y");
    expect(toArmActorId("a b/c")).toBe("a_b_c");
    expect(toArmActorId("-lead")).toBe("_lead");
    expect(toArmActorId("x".repeat(80))).toHaveLength(64);
    return expect(toArmActorId("")).toBe("unknown");
  });

  it("derives the Mission control badge", () => {
    const running = { health: null, state: "running" } as const;
    expect(nodeBadge(running, armState(false) as never)).toBe(
      "running-disarmed"
    );
    expect(nodeBadge(running, armState(true) as never)).toBe("running-armed");
    expect(nodeBadge(running, null)).toBe("unknown");
    expect(nodeBadge({ health: null, state: "exited" }, null)).toBe("down");
    expect(nodeBadge({ health: null, state: "missing" }, null)).toBe("down");
    return expect(nodeBadge({ health: null, state: "unknown" }, null)).toBe(
      "unknown"
    );
  });
});

describe("nautilusArm.status", () => {
  it("maps the bridge status and sends the bearer token with a GET", async () => {
    const status = await clientFor().nautilusArm.status({});
    expect(status).toEqual({
      arm: armState(false),
      armError: null,
      badge: "running-disarmed",
      checkedAt: at.toISOString(),
      container: { health: "healthy", state: "running" },
    });
    expect(calls[0]?.url).toBe(
      "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1/nautilus/status"
    );
    expect(calls[0]?.init).toMatchObject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "GET",
      redirect: "manual",
    });
    routes.status = () =>
      json(
        upstreamStatus({
          arm: null,
          armError: "not-running",
          container: { health: null, state: "exited" },
        })
      );
    const down = await clientFor().nautilusArm.status({});
    return expect(down.badge).toBe("down");
  });

  it("reports configuration, transport and schema failures", async () => {
    await expectCode(
      clientFor({ config: null }).nautilusArm.status({}),
      "NOT_CONFIGURED",
      503
    );
    const cases: [Route, string, number][] = [
      [() => json({ error: "internal" }, 500), "UPSTREAM_ERROR", 502],
      [() => json({ error: "down" }, 503), "UNAVAILABLE", 503],
      [() => new Response("<html>", { status: 502 }), "UNAVAILABLE", 503],
      [() => new Response("<html>", { status: 200 }), "UPSTREAM_ERROR", 502],
      [() => new Response(null, { status: 200 }), "UPSTREAM_ERROR", 502],
      [
        () =>
          new Response("{bad", {
            headers: { "content-type": "application/json" },
          }),
        "UPSTREAM_ERROR",
        502,
      ],
      [() => json({ schema: "other" }), "UPSTREAM_ERROR", 502],
      [() => json("x".repeat(70_000)), "UPSTREAM_ERROR", 502],
      [
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("reset"));
              },
            }),
            { headers: { "content-type": "application/json" } }
          ),
        "UNAVAILABLE",
        503,
      ],
      [
        () => {
          throw new Error("refused");
        },
        "UNAVAILABLE",
        503,
      ],
    ];
    for (const [route, code, status] of cases) {
      routes.status = route;
      const error = await expectCode(
        clientFor().nautilusArm.status({}),
        code,
        status
      );
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });

  it("reports a timeout as unavailable", async () => {
    setNautilusArmDependenciesForTesting({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        }),
      timeoutMs: 5,
    });
    const error = await expectCode(
      clientFor().nautilusArm.status({}),
      "UNAVAILABLE",
      503
    );
    return expect(error).toMatchObject({
      message: "Nautilus arm request timed out",
    });
  });

  it("uses the global fetch and clock when no test dependency is set", async () => {
    setNautilusArmDependenciesForTesting({});
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(upstreamStatus()));
    try {
      const status = await clientFor().nautilusArm.status({});
      expect(status.badge).toBe("running-disarmed");
      return expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("nautilusArm.arm", () => {
  it("checks the password, audits the intent, arms once and audits the result", async () => {
    const events: SemanticEvent[] = [];
    const output = await arm({ events });
    expect(output).toEqual({
      action: "arm",
      arm: armState(true),
      auditId: "node-audit-1",
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.url).toMatch(/\/nautilus\/arm$/u);
    expect(JSON.parse(String(posts()[0]?.init.body))).toEqual({
      actorId: "operator",
      imageVersion: "1.4.2",
      reason: REASON,
      requestId: "arm-req-0001",
      statement: NAUTILUS_ARM_STATEMENT,
    });
    expect(store.rows.map((row) => row.action)).toEqual([
      "nautilus.arm.password-attempt",
      "nautilus.arm.password-verified",
      "nautilus.arm.intent",
      "nautilus.arm.result",
    ]);
    expect(store.rows[2]).toMatchObject({
      armRequestId: "arm-req-0001",
      metadata: { imageVersion: "1.4.2", reason: REASON },
    });
    expect(store.rows[3]?.metadata).toMatchObject({
      armed: true,
      nodeAuditId: "node-audit-1",
      outcome: "ok",
    });
    expect(JSON.stringify(store.rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    return expect(events.map((event) => event.name)).toEqual([
      "vertex.nautilusArm.armIntent",
      "vertex.nautilusArm.arm",
    ]);
  });

  it("refuses a wrong password and locks out after five failures", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const error = await expectCode(
        arm({}, { ...armInput, password: "wrong" }),
        "FORBIDDEN",
        403
      );
      expect(error).toMatchObject({
        message: `Password check failed; the node was not armed (${attempt} of 5 attempts)`,
      });
    }
    const locked = await expectCode(arm(), "FORBIDDEN", 403);
    expect(locked).toMatchObject({
      message: "Too many failed password attempts; try again in 15 minutes",
    });
    expect(posts()).toHaveLength(0);
    nowMs += 16 * 60_000;
    await arm();
    return expect(posts()).toHaveLength(1);
  });

  it("refuses when the password cannot be checked or step-up is missing", async () => {
    await expectCode(
      arm({
        verify: async () => {
          throw new Error("auth down");
        },
      }),
      "UNAVAILABLE",
      503
    );
    expect(store.rows.at(-1)?.action).toBe("nautilus.arm.password-error");
    await expectCode(arm({ verify: null }), "FORBIDDEN", 403);
    return expect(posts()).toHaveLength(0);
  });

  it("refuses without audit storage and never calls the bridge", async () => {
    await expectCode(arm({ audit: null }), "AUDIT_UNAVAILABLE", 503);
    store.failOn.add("nautilus.arm.password-attempt");
    await expectCode(arm(), "AUDIT_UNAVAILABLE", 503);
    store.failOn.clear();
    store.failOn.add("nautilus.arm.intent");
    await expectCode(arm(), "AUDIT_UNAVAILABLE", 503);
    await expectCode(arm({ config: null }), "NOT_CONFIGURED", 503);
    return expect(posts()).toHaveLength(0);
  });

  it("maps node refusals to conflicts and audits them", async () => {
    const texts: Record<string, string> = {
      busy: "Another arm or disarm is running; try again in a few seconds",
      invalid_actor: "The node refused the operator id",
      invalid_reason: "The node refused the reason",
      kill_switch_active: "The kill switch is active; the node cannot be armed",
      not_running: "The Nautilus node is not running",
      version_mismatch:
        "The running image version changed; reload the status and try again",
      write_failed: "The node could not write the arm record",
    };
    for (const [code, message] of Object.entries(texts)) {
      routes.arm = () => json({ detail: "x", error: code }, 409);
      const error = await expectCode(arm(), "CONFLICT", 409);
      expect(error).toMatchObject({ message });
      expect(store.rows.at(-1)).toMatchObject({
        action: "nautilus.arm.result",
        metadata: { outcome: "CONFLICT" },
      });
    }
    routes.arm = () => json({ error: "other" }, 409);
    await expectCode(arm(), "UPSTREAM_ERROR", 502);
    routes.arm = () => json(["not", "an", "object"], 409);
    await expectCode(arm(), "UPSTREAM_ERROR", 502);
    routes.arm = () => json(null, 409);
    await expectCode(arm(), "UPSTREAM_ERROR", 502);
    routes.arm = () => json({ error: "cli_timeout" }, 504);
    await expectCode(arm(), "UNAVAILABLE", 503);
    routes.arm = () => json({ schema: "wrong" });
    await expectCode(arm(), "UPSTREAM_ERROR", 502);
    routes.arm = () => {
      throw new Error("refused");
    };
    return expectCode(arm(), "UNAVAILABLE", 503);
  });

  it("still reports a failed call when the result audit and event sink fail", async () => {
    routes.arm = () => json({ error: "busy" }, 409);
    store.failOn.add("nautilus.arm.result");
    await expectCode(arm({ emitFails: true }), "CONFLICT", 409);
    routes.arm = (init) => result("arm", init);
    const output = await arm({ emitFails: true, events: null });
    return expect(output.arm.armed).toBe(true);
  });

  it("records a missing node audit id as none", async () => {
    routes.arm = (init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({
        action: "arm",
        arm: armState(true),
        auditId: null,
        requestId: body["requestId"],
        schema: "vertex-nautilus-arm-result-v1",
      });
    };
    const span = {
      correlation: { traceId: "t-1" },
    } as unknown as SpanHandle;
    const events: SemanticEvent[] = [];
    const output = await arm({ events, span });
    expect(output.auditId).toBeNull();
    expect(events[0]?.correlation).toMatchObject({ traceId: "t-1" });
    return expect(store.rows.at(-1)?.metadata).toMatchObject({
      nodeAuditId: "none",
    });
  });

  it("maps an unexpected handler error to an upstream error", async () => {
    setNautilusArmDependenciesForTesting({
      fetch: fakeFetch,
      newRequestId: () => {
        throw new Error("no randomness");
      },
      now: () => new Date(nowMs),
    });
    await expectCode(arm(), "UPSTREAM_ERROR", 502);
    return expect(posts()).toHaveLength(0);
  });

  it("uses a random request id by default", async () => {
    setNautilusArmDependenciesForTesting({ fetch: fakeFetch });
    await arm();
    return expect(JSON.parse(String(posts()[0]?.init.body)).requestId).toMatch(
      /^[0-9a-f-]{36}$/u
    );
  });
});

describe("nautilusArm.disarm", () => {
  it("disarms in one call without a password and audits before and after", async () => {
    const output = await disarm({ verify: null });
    expect(output).toEqual({
      action: "disarm",
      arm: armState(false),
      auditId: "node-audit-1",
    });
    expect(JSON.parse(String(posts()[0]?.init.body))).toEqual({
      actorId: "operator",
      reason: "Disarmed from Vertex Mission control",
      requestId: "arm-req-0001",
    });
    return expect(store.rows.map((row) => row.action)).toEqual([
      "nautilus.disarm.intent",
      "nautilus.disarm.result",
    ]);
  });

  // Disarm is the safety action: an audit outage must not block it (state-machine audit 2026-11-03).
  it("still disarms when audit storage is missing or the intent row fails", async () => {
    const events: SemanticEvent[] = [];
    const missing = await disarm({ audit: null, events });
    expect(missing.arm.armed).toBe(false);
    store.failOn.add("nautilus.disarm.intent");
    const failed = await disarm();
    expect(failed.arm.armed).toBe(false);
    expect(posts()).toHaveLength(2);
    expect(store.rows.map((row) => row.action)).toEqual([
      "nautilus.disarm.result",
    ]);
    return expect(
      events.some((event) => event.attributes?.["auditDegraded"] === true)
    ).toBe(true);
  });

  it("refuses without configuration", async () => {
    await expectCode(disarm({ config: null }), "NOT_CONFIGURED", 503);
    return expect(posts()).toHaveLength(0);
  });
});
