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
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { VertexOrderInput } from "./contracts/vertex-orders.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import {
  OrderGatewayError,
  type OrderGatewayPort,
  createMockOrderGateway,
} from "./server/vertex-orders-gateway.ts";
import type { OrderAccount } from "./server/vertex-orders-rules.ts";
import {
  type VertexOrdersConfig,
  setVertexOrdersDependenciesForTesting,
} from "./server/vertex-orders.ts";

// Fictional values only. No test here can reach IBKR: the bridge fetch is a spy.
const at = new Date("2026-10-22T15:00:00.000Z");
const SECRET = "t".repeat(40);
const OFF: VertexOrdersConfig = {
  enabled: false,
  submission: "disabled",
  bridgeUrl: "http://127.0.0.1:3470",
  confirmSecret: SECRET,
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
    expiresAt: new Date("2026-10-23T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

type Options = Readonly<{
  user?: string | null;
  config?: VertexOrdersConfig;
  // null => no event port (audit unavailable).
  events?: SemanticEvent[] | null;
  emitFails?: boolean;
  sinkFailed?: boolean;
  span?: SpanHandle;
}>;

const clientFor = ({
  user = "operator",
  config = OFF,
  events = [],
  emitFails = false,
  sinkFailed = false,
  span,
}: Options = {}) => {
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories: {} as unknown as Repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (user === null) throw denied();
        return session(user);
      },
      // Owner = operator allow-list AND admin role; "member-op" is an operator without admin.
      requireRole: async () => {
        if (user !== "operator") throw denied();
        return session(user);
      },
      operatorEmails: ["operator@domain.test", "member-op@domain.test"],
      vertexOrders: config,
      ...(span === undefined ? {} : { span }),
      ...(events === null
        ? {}
        : {
            semanticEvents: {
              emit: async (event: SemanticEvent) => {
                events.push(event);
                if (emitFails) throw new Error("sink down");
                return {
                  structuredEvent: sinkFailed
                    ? ("failed" as const)
                    : ("emitted" as const),
                  span: "skipped" as const,
                  analytics: "skipped" as const,
                };
              },
            },
          }),
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const order = (
  overrides: Partial<VertexOrderInput> = {}
): VertexOrderInput => ({
  symbol: "MOCKD",
  secType: "OPT",
  expiry: "20280121",
  strike: 100,
  right: "C",
  side: "BUY",
  quantity: 2,
  orderType: "LMT",
  limitPrice: 10,
  ...overrides,
});

let bridgeFetch: ReturnType<
  typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>
>;
let mock: OrderGatewayPort;

beforeEach(() => {
  bridgeFetch = vi.fn(async (input: string) =>
    Response.json(
      input.endsWith("/account")
        ? {
            netLiquidation: 200_000,
            positions: [],
            openOrders: [],
            gates: { killSwitch: false, optionsOnly: true },
            caps: { leapsMinDays: 365, leapsPct: 2, shortPct: 2 },
          }
        : { state: "submitted", permId: 42, message: "bridge" }
    )
  );
  mock = createMockOrderGateway(() => at);
  setVertexOrdersDependenciesForTesting({ mock, bridgeFetch, now: () => at });
});

afterEach(() => setVertexOrdersDependenciesForTesting(undefined));

describe("vertexOrders procedures", () => {
  it("are operator-only and unreachable with agent keys or MCP", async () => {
    await expectCode(
      clientFor({ user: null }).vertexOrders.status({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({ user: "outsider" }).vertexOrders.preview(order()),
      "FORBIDDEN",
      403
    );
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("vertexOrders");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("vertexOrders"))
    ).toBe(false);
  });

  it("flag off: uses the mock gateway only and never calls the bridge", async () => {
    const client = clientFor();
    const status = await client.vertexOrders.status({});
    expect(status.gates).toEqual({
      ordersEnabled: false,
      mode: "simulated",
      killSwitch: false,
      optionsOnly: true,
    });
    expect(status.openOrders.map((o) => o.cancellable)).toEqual([true, false]);
    const preview = await client.vertexOrders.preview(order());
    expect(preview.review.accepted).toBe(true);
    const result = await client.vertexOrders.submit({
      order: order(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(result).toMatchObject({ mode: "simulated", state: "submitted" });
    expect(result.orderRef).toMatch(/^leaps-vertex-/);
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("requires the preview confirm token for every submit and refuses replays", async () => {
    const events: SemanticEvent[] = [];
    const client = clientFor({ events });
    await expectCode(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: "x".repeat(20),
        confirm: true,
      }),
      "CONFIRM_INVALID",
      409
    );
    const preview = await client.vertexOrders.preview(order());
    const token = preview.confirmToken ?? "";
    await expectCode(
      client.vertexOrders.submit({
        order: order({ quantity: 3 }),
        confirmToken: token,
        confirm: true,
      }),
      "CONFIRM_INVALID",
      409
    );
    // The mismatched attempt above did not consume the token.
    await client.vertexOrders.submit({
      order: order(),
      confirmToken: token,
      confirm: true,
    });
    await expectCode(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: token,
        confirm: true,
      }),
      "CONFIRM_INVALID",
      409
    );
    await expect(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: token,
        confirm: false as true,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(events.map((e) => `${e.name}:${e.outcome}`)).toEqual([
      "vertex.orders.submit:failure",
      "vertex.orders.preview:success",
      "vertex.orders.submit:failure",
      "vertex.orders.submitIntent:success",
      "vertex.orders.submit:success",
      "vertex.orders.submit:failure",
    ]);
    expect(events[4]?.attributes).toMatchObject({
      userId: "operator",
      contract: "MOCKD 20280121 100 call",
    });
  });

  it("rejects share orders and over-cap orders without a token", async () => {
    const client = clientFor();
    const shares = await client.vertexOrders.preview(order({ secType: "STK" }));
    expect(shares).toMatchObject({ confirmToken: null, expiresAt: null });
    expect(shares.review.reasons[0]).toContain("Options only");
    const big = await client.vertexOrders.preview(order({ quantity: 20 }));
    expect(big.review.accepted).toBe(false);
  });

  it("re-checks the rules at submit time (kill switch turned on after preview)", async () => {
    let killSwitch = false;
    const gated: OrderGatewayPort = {
      ...mock,
      account: async (): Promise<OrderAccount> => ({
        ...(await mock.account()),
        gates: { killSwitch, optionsOnly: true },
      }),
    };
    setVertexOrdersDependenciesForTesting({ mock: gated, now: () => at });
    const client = clientFor({ events: [] });
    const preview = await client.vertexOrders.preview(order());
    killSwitch = true;
    await expectCode(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      }),
      "ORDER_REJECTED",
      422
    );
  });

  it("VERTEX_ORDERS_ENABLED alone stays simulated while VERTEX_ORDER_SUBMISSION is disabled", async () => {
    const client = clientFor({ config: { ...OFF, enabled: true } });
    const status = await client.vertexOrders.status({});
    expect(status.gates).toMatchObject({
      ordersEnabled: false,
      mode: "simulated",
    });
    const preview = await client.vertexOrders.preview(order());
    await client.vertexOrders.submit({
      order: order(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("both gates open: uses the loopback bridge, and fails closed without config", async () => {
    const on = { ...OFF, enabled: true, submission: "enabled" };
    const client = clientFor({ config: on });
    expect((await client.vertexOrders.status({})).gates.mode).toBe("live");
    const preview = await client.vertexOrders.preview(order());
    const result = await client.vertexOrders.submit({
      order: order(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(result).toMatchObject({ mode: "live", permId: 42 });
    expect(bridgeFetch.mock.calls.map(([url]) => url)).toContain(
      "http://127.0.0.1:3470/orders"
    );
    await expectCode(
      clientFor({ config: { ...on, bridgeUrl: null } }).vertexOrders.status({}),
      "NOT_CONFIGURED",
      503
    );
    await expectCode(
      clientFor({
        config: { ...OFF, confirmSecret: "short" },
      }).vertexOrders.preview(order()),
      "NOT_CONFIGURED",
      503
    );
  });

  it("uses a disabled default config and the default mock when nothing is injected", async () => {
    setVertexOrdersDependenciesForTesting(undefined);
    const fetch = async (request: Request) =>
      handleApiRequest(
        request,
        createApiContext(request, {
          repositories: {} as unknown as Repositories,
          capabilities: {
            ai: false,
            emailDelivery: false,
            analytics: false,
            telemetryExport: false,
          },
          requireSession: async () => session("operator"),
          requireRole: async () => session("operator"),
          operatorEmails: ["operator@domain.test"],
        })
      );
    const client = createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch,
    });
    expect((await client.vertexOrders.status({})).gates.ordersEnabled).toBe(
      false
    );
    await expectCode(
      client.vertexOrders.preview(order()),
      "NOT_CONFIGURED",
      503
    );
  });

  it("rate-limits mutating calls per user", async () => {
    const client = clientFor();
    for (let index = 0; index < 20; index++)
      await client.vertexOrders.preview(order({ secType: "STK" }));
    await expectCode(client.vertexOrders.preview(order()), "RATE_LIMITED", 429);
    for (let index = 0; index < 5; index++)
      await expectCode(
        client.vertexOrders.cancelSubmit({
          permId: 1,
          confirmToken: "x".repeat(20),
          confirm: true,
        }),
        "CONFIRM_INVALID",
        409
      );
    await expectCode(
      client.vertexOrders.cancelSubmit({
        permId: 1,
        confirmToken: "x".repeat(20),
        confirm: true,
      }),
      "RATE_LIMITED",
      429
    );
  });

  it("cancels one option order at a time after a confirm, never share stops", async () => {
    const events: SemanticEvent[] = [];
    const span = {
      correlation: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    } as unknown as SpanHandle;
    const client = clientFor({ events, span });
    const { openOrders } = await client.vertexOrders.status({});
    const [option, stop] = openOrders;
    await expectCode(
      client.vertexOrders.cancelPreview({ permId: stop?.permId ?? 0 }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.vertexOrders.cancelPreview({ permId: 123 }),
      "NOT_FOUND",
      404
    );
    const preview = await client.vertexOrders.cancelPreview({
      permId: option?.permId ?? 0,
    });
    expect(preview.order.symbol).toBe("MOCKB");
    await expectCode(
      client.vertexOrders.cancelSubmit({
        permId: (option?.permId ?? 0) + 1,
        confirmToken: preview.confirmToken,
        confirm: true,
      }),
      "CONFIRM_INVALID",
      409
    );
    const done = await client.vertexOrders.cancelSubmit({
      permId: option?.permId ?? 0,
      confirmToken: preview.confirmToken,
      confirm: true,
    });
    expect(done).toMatchObject({
      state: "cancelled",
      orderRef: "mock-seed",
      mode: "simulated",
    });
    expect((await client.vertexOrders.status({})).openOrders).toHaveLength(1);
    expect(events.at(-1)?.correlation).toMatchObject({
      traceId: "a".repeat(32),
    });
  });

  it("maps gateway failures to typed errors and rethrows unknown ones", async () => {
    const failing = (error: Error): OrderGatewayPort => ({
      ...mock,
      account: async () => {
        throw error;
      },
    });
    setVertexOrdersDependenciesForTesting({
      mock: failing(new OrderGatewayError("UPSTREAM_ERROR", "down")),
      now: () => at,
    });
    await expectCode(
      clientFor().vertexOrders.status({}),
      "UPSTREAM_ERROR",
      502
    );
    setVertexOrdersDependenciesForTesting({
      mock: failing(new Error("bug")),
      now: () => at,
    });
    await expectCode(
      clientFor().vertexOrders.status({}),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("audits submit and cancel failures from the gateway and refuses a reused orderRef", async () => {
    const events: SemanticEvent[] = [];
    const broken: OrderGatewayPort = {
      ...mock,
      place: () =>
        Promise.reject(new OrderGatewayError("UPSTREAM_ERROR", "bridge down")),
      cancel: () => Promise.reject(new Error("bug")),
    };
    setVertexOrdersDependenciesForTesting({ mock: broken, now: () => at });
    const client = clientFor({ events });
    const preview = await client.vertexOrders.preview(order());
    await expectCode(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      }),
      "UPSTREAM_ERROR",
      502
    );
    const [option] = (await client.vertexOrders.status({})).openOrders;
    const cancel = await client.vertexOrders.cancelPreview({
      permId: option?.permId ?? 0,
    });
    await expectCode(
      client.vertexOrders.cancelSubmit({
        permId: option?.permId ?? 0,
        confirmToken: cancel.confirmToken,
        confirm: true,
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    const failures = events
      .filter((e) => e.outcome === "failure")
      .map((e) => [e.name, e.attributes?.["result"]]);
    expect(failures).toEqual([
      ["vertex.orders.submit", "bridge down"],
      ["vertex.orders.cancel", "gateway error"],
    ]);
    const fresh = createMockOrderGateway(() => at);
    expect((await fresh.place(order(), "vertex-same")).state).toBe("submitted");
    await fresh.cancel((await fresh.account()).openOrders.at(-1)?.permId ?? 0);
    expect(await fresh.place(order(), "vertex-same")).toMatchObject({
      state: "aborted",
      permId: null,
    });
  });

  it("audits a cancel for an order that is gone", async () => {
    const events: SemanticEvent[] = [];
    const client = clientFor({ events });
    const [option] = (await client.vertexOrders.status({})).openOrders;
    const cancel = await client.vertexOrders.cancelPreview({
      permId: option?.permId ?? 0,
    });
    await mock.cancel(option?.permId ?? 0);
    await expectCode(
      client.vertexOrders.cancelSubmit({
        permId: option?.permId ?? 0,
        confirmToken: cancel.confirmToken,
        confirm: true,
      }),
      "NOT_FOUND",
      404
    );
    expect(events.at(-1)).toMatchObject({
      name: "vertex.orders.cancel",
      outcome: "failure",
    });
  });

  it("is owner-only: an operator without the admin role is refused", async () => {
    await expectCode(
      clientFor({ user: "member-op" }).vertexOrders.status({}),
      "FORBIDDEN",
      403
    );
  });

  it("refuses submit and cancel when the audit record cannot be written", async () => {
    const place = vi.spyOn(mock, "place");
    const cancelSpy = vi.spyOn(mock, "cancel");
    for (const options of [
      { events: null },
      { emitFails: true },
      { sinkFailed: true },
    ]) {
      setVertexOrdersDependenciesForTesting({ mock, now: () => at });
      const client = clientFor(options);
      const preview = await client.vertexOrders.preview(order());
      await expectCode(
        client.vertexOrders.submit({
          order: order(),
          confirmToken: preview.confirmToken ?? "",
          confirm: true,
        }),
        "AUDIT_UNAVAILABLE",
        503
      );
      const [option] = (await client.vertexOrders.status({})).openOrders;
      const cancel = await client.vertexOrders.cancelPreview({
        permId: option?.permId ?? 0,
      });
      await expectCode(
        client.vertexOrders.cancelSubmit({
          permId: option?.permId ?? 0,
          confirmToken: cancel.confirmToken,
          confirm: true,
        }),
        "AUDIT_UNAVAILABLE",
        503
      );
    }
    expect(place).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
