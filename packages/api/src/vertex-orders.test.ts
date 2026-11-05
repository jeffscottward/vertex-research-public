import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  OrderIntent,
  OrderIntentRepository,
  Repositories,
} from "@darkfactory/db/server";
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
import type { VertexComboInput } from "./contracts/vertex-orders.ts";
import {
  type VertexOrdersConfig,
  setVertexOrdersDependenciesForTesting as setOrdersDependencies,
} from "./server/vertex-orders.ts";
import type { JevVerdictOutput } from "./contracts/jev-verdict.ts";

// The final JEV order gate runs on the mock gateway. These tests cover the order rules, so they
// see a fresh NEUTRAL verdict (never opposes); final-order-gate tests cover the JEV rules.
const neutralJev = (symbol: string): JevVerdictOutput => ({
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: [],
  refreshed: false,
  staleAfterSeconds: 3600,
  state: "fresh",
  symbol,
  throttled: false,
  verdict: {
    choice: "NEUTRAL",
    dataAsOf: "2026-10-21",
    decidedAt: "2026-10-22T14:50:00.000Z",
    factors: [],
    model: "test",
    probabilities: { BEARISH: 0.2, BULLISH: 0.2, NEUTRAL: 0.6 },
    reason: "test",
    sentFields: [],
    stance: "NEUTRAL",
  },
});
const setVertexOrdersDependenciesForTesting = (
  next: Parameters<typeof setOrdersDependencies>[0]
): void =>
  setOrdersDependencies(
    next === undefined ? undefined : { jevVerdict: neutralJev, ...next }
  );

// Fictional values only. No test here can reach IBKR: the bridge fetch is a spy.
const at = new Date("2026-10-22T15:00:00.000Z");
const SECRET = "t".repeat(40);
const OFF: VertexOrdersConfig = {
  enabled: false,
  submission: "disabled",
  bridgeUrl: "http://127.0.0.1:3470",
  bridgeToken: "b".repeat(40),
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
  intents?: OrderIntentRepository;
}>;

const clientFor = ({
  user = "operator",
  config = OFF,
  events = [],
  emitFails = false,
  sinkFailed = false,
  span,
  intents,
}: Options = {}) => {
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories: (intents === undefined
        ? {}
        : { orderIntents: intents }) as unknown as Repositories,
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

// In-memory order intent store with the repository's "last outcome" rule.
const intentStore = () => {
  const intents: OrderIntent[] = [];
  const outcomes = new Map<string, string>();
  const rows: string[] = [];
  const store: OrderIntentRepository = {
    recordIntent: async ({ intent }) => {
      intents.push({ ...intent, createdAt: clock });
      rows.push(`intent ${intent.orderRef}`);
    },
    recordOutcome: async ({ action, orderRef, outcome }) => {
      outcomes.set(orderRef, outcome);
      rows.push(`${action} ${outcome}`);
    },
    unresolved: async () =>
      intents.filter((i) => {
        const outcome = outcomes.get(i.orderRef);
        return outcome === undefined || outcome === "unknown";
      }),
  };
  return { store, intents, rows };
};

// A promise the test settles by hand (the tsconfig lib has no Promise.withResolvers).
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
};

let clock = new Date("2026-10-22T15:00:00.000Z");

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
    expect(status.openOrders.map((o) => o.cancellable)).toEqual([
      true,
      false,
      true,
    ]);
    const preview = await client.vertexOrders.preview(order());
    expect(preview.review.accepted).toBe(true);
    const result = await client.vertexOrders.submit({
      order: order(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(result).toMatchObject({ mode: "simulated", state: "submitted" });
    expect(result.orderRef).toMatch(/^vertex-/);
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

  it("places one order at a time, refuses a parallel submit, and keeps the per-name cap", async () => {
    // Each order is $3,500 (below the 2% max loss); the MOCKD LEAPS cap is
    // 6% of $200,000 = $12,000, so only three of four may be placed.
    const base = createMockOrderGateway(() => at);
    const entered = deferred();
    const release = deferred();
    let placeCalls = 0;
    setVertexOrdersDependenciesForTesting({
      mock: {
        ...base,
        place: async (candidate, orderRef) => {
          placeCalls += 1;
          if (placeCalls === 1) {
            entered.resolve();
            await release.promise;
          }
          return await base.place(candidate, orderRef);
        },
      },
      now: () => at,
    });
    const client = clientFor();
    const orders = [100, 105, 110, 115].map((strike) =>
      order({ strike, quantity: 1, limitPrice: 35 })
    );
    const tokens: string[] = [];
    for (const candidate of orders) {
      const preview = await client.vertexOrders.preview(candidate);
      expect(preview.review.accepted).toBe(true);
      tokens.push(preview.confirmToken ?? "");
    }
    const submitAt = (index: number) =>
      client.vertexOrders.submit({
        order: orders[index] ?? order(),
        confirmToken: tokens[index] ?? "",
        confirm: true,
      });

    const first = submitAt(0);
    await entered.promise;
    const parallel = await Promise.allSettled([1, 2, 3].map(submitAt));
    release.resolve();
    await first;

    for (const refused of parallel)
      expect(refused).toMatchObject({
        status: "rejected",
        reason: { code: "RATE_LIMITED" },
      });
    // A refused submit did not use its confirm token: one at a time, the
    // per-name cap admits two more and refuses the fourth.
    await submitAt(1);
    await submitAt(2);
    return await expectCode(submitAt(3), "ORDER_REJECTED", 422);
  });

  it("lets a placement that never finishes block new placements only until its lease ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = createMockOrderGateway(() => at);
      const entered = deferred();
      let placeCalls = 0;
      setVertexOrdersDependenciesForTesting({
        mock: {
          ...base,
          place: (candidate, orderRef) => {
            placeCalls += 1;
            if (placeCalls > 1) return base.place(candidate, orderRef);
            // The first call never settles, like a request whose client went away.
            entered.resolve();
            return new Promise<never>(() => undefined);
          },
        },
        now: () => at,
      });
      const client = clientFor();
      const first = order({ strike: 100 });
      const second = order({ strike: 105 });
      const firstToken =
        (await client.vertexOrders.preview(first)).confirmToken ?? "";
      const secondToken =
        (await client.vertexOrders.preview(second)).confirmToken ?? "";
      const submitSecond = () =>
        client.vertexOrders.submit({
          order: second,
          confirmToken: secondToken,
          confirm: true,
        });

      void client.vertexOrders
        .submit({ order: first, confirmToken: firstToken, confirm: true })
        .catch(() => undefined);
      await entered.promise;

      await expectCode(submitSecond(), "RATE_LIMITED", 429);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      return await expect(submitSecond()).resolves.toMatchObject({
        state: "submitted",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer lease when an expired placement finishes late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = createMockOrderGateway(() => at);
      const holds = [deferred(), deferred()];
      const entered = [deferred(), deferred()];
      let placeCalls = 0;
      setVertexOrdersDependenciesForTesting({
        mock: {
          ...base,
          place: async (candidate, orderRef) => {
            const call = placeCalls;
            placeCalls += 1;
            const hold = holds[call];
            if (hold !== undefined) {
              entered[call]?.resolve();
              await hold.promise;
            }
            return await base.place(candidate, orderRef);
          },
        },
        now: () => at,
      });
      const client = clientFor();
      const orders = [100, 105, 110].map((strike) => order({ strike }));
      const tokens: string[] = [];
      for (const candidate of orders)
        tokens.push(
          (await client.vertexOrders.preview(candidate)).confirmToken ?? ""
        );
      const submitAt = (index: number) =>
        client.vertexOrders.submit({
          order: orders[index] ?? order(),
          confirmToken: tokens[index] ?? "",
          confirm: true,
        });

      const first = submitAt(0);
      await entered[0]?.promise;
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const second = submitAt(1);
      await entered[1]?.promise;
      holds[0]?.resolve();
      await first;

      // The first placement ended after its lease expired; the second still holds the newer lease.
      await expectCode(submitAt(2), "RATE_LIMITED", 429);
      holds[1]?.resolve();
      await second;
      return await expect(submitAt(2)).resolves.toMatchObject({
        state: "submitted",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects share orders and over-cap orders without a token", async () => {
    const client = clientFor();
    const shares = await client.vertexOrders.preview(order({ secType: "STK" }));
    expect(shares).toMatchObject({ confirmToken: null, expiresAt: null });
    expect(shares.review.reasons[0]).toContain(
      "options only for new positions"
    );
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
    const { store, rows } = intentStore();
    const client = clientFor({ config: on, intents: store });
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
    expect(rows).toEqual([
      expect.stringMatching(/^intent vertex-/u),
      "vertex.order.result placed",
    ]);
    await expectCode(
      clientFor({ config: on }).vertexOrders.preview(order()),
      "AUDIT_UNAVAILABLE",
      503
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

  it("closes a spread as one combo: preview, confirm, submit, refusals and unknown outcome", async () => {
    clock = new Date(at);
    const spreadAccount = async (): Promise<OrderAccount> => ({
      ...(await mock.account()),
      positions: [
        {
          symbol: "MOCKS",
          secType: "OPT",
          expiry: "20280121",
          strike: 100,
          right: "C",
          quantity: 2,
          premium: 2000,
        },
        {
          symbol: "MOCKS",
          secType: "OPT",
          expiry: "20280121",
          strike: 120,
          right: "C",
          quantity: -2,
          premium: 0,
        },
      ],
      openOrders: [],
    });
    const combo = (over: Partial<VertexComboInput> = {}): VertexComboInput => ({
      symbol: "MOCKS",
      quantity: 2,
      limitPrice: -3.5,
      legs: [
        { expiry: "20280121", strike: 100, right: "C", side: "SELL", ratio: 1 },
        { expiry: "20280121", strike: 120, right: "C", side: "BUY", ratio: 1 },
      ],
      ...over,
    });
    let placeCombo: OrderGatewayPort["placeCombo"] = async () => ({
      state: "submitted",
      permId: 77,
      message: "ok",
    });
    setVertexOrdersDependenciesForTesting({
      mock: {
        ...mock,
        account: spreadAccount,
        placeCombo: (o, ref) => placeCombo(o, ref),
      },
      now: () => clock,
    });
    const { store, rows } = intentStore();
    const events: SemanticEvent[] = [];
    const client = clientFor({ intents: store, events });
    const send = async (input = combo()) => {
      const preview = await client.vertexOrders.comboPreview(input);
      return await client.vertexOrders.comboSubmit({
        order: input,
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      });
    };

    const preview = await client.vertexOrders.comboPreview(combo());
    expect(preview.review).toMatchObject({
      accepted: true,
      netAmount: -700,
      label: "MOCKS combo x2: SELL 20280121 100C / BUY 20280121 120C",
    });
    expect(await send()).toMatchObject({ state: "submitted", permId: 77 });
    expect(rows.slice(-2)).toEqual([
      expect.stringMatching(/^intent vertex-/u),
      "vertex.order.result placed",
    ]);
    // A partial close (legging out) gets no confirm token.
    const partial = await client.vertexOrders.comboPreview(
      combo({ quantity: 1 })
    );
    expect(partial.confirmToken).toBeNull();
    // A token for another combo is refused.
    await expectCode(
      client.vertexOrders.comboSubmit({
        order: combo({ limitPrice: -1 }),
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      }),
      "CONFIRM_INVALID",
      409
    );
    // Unconfirmed by IBKR: kept as unknown.
    placeCombo = async () => ({
      state: "unconfirmed",
      permId: null,
      message: "pending",
    });
    await send(combo({ limitPrice: -3.4 }));
    expect(rows.at(-1)).toBe("vertex.order.result unknown");
    clock = new Date(at.getTime() + 10 * 60_000);
    // Gateway failure: outcome unknown, typed error.
    placeCombo = () =>
      Promise.reject(new OrderGatewayError("UPSTREAM_ERROR", "down"));
    await expectCode(send(combo({ limitPrice: -3.3 })), "UPSTREAM_ERROR", 502);
    expect(rows.at(-1)).toBe("vertex.order.result unknown");
    clock = new Date(at.getTime() + 20 * 60_000);
    placeCombo = () => Promise.reject(new Error("bug"));
    await expectCode(
      send(combo({ limitPrice: -3.2 })),
      "INTERNAL_SERVER_ERROR",
      500
    );
    expect(
      events.some(
        (e) => e.name === "vertex.orders.comboSubmit" && e.outcome === "failure"
      )
    ).toBe(true);
  });

  it("refuses a combo submit when the account changed or the intent store fails", async () => {
    clock = new Date(at);
    let held = 2;
    const account = async (): Promise<OrderAccount> => ({
      ...(await mock.account()),
      positions: [
        {
          symbol: "MOCKS",
          secType: "OPT",
          expiry: "20280121",
          strike: 100,
          right: "C",
          quantity: held,
          premium: 2000,
        },
        {
          symbol: "MOCKS",
          secType: "OPT",
          expiry: "20280121",
          strike: 120,
          right: "C",
          quantity: -held,
          premium: 0,
        },
      ],
      openOrders: [],
    });
    setVertexOrdersDependenciesForTesting({
      mock: { ...mock, account },
      now: () => clock,
    });
    const order = {
      symbol: "MOCKS",
      quantity: 2,
      limitPrice: 1.25,
      legs: [
        {
          expiry: "20280121",
          strike: 100,
          right: "C" as const,
          side: "SELL" as const,
          ratio: 1,
        },
        {
          expiry: "20280121",
          strike: 120,
          right: "C" as const,
          side: "BUY" as const,
          ratio: 1,
        },
      ],
    };
    const client = clientFor({
      intents: {
        ...intentStore().store,
        recordIntent: () => Promise.reject(new Error("db down")),
      },
    });
    const first = await client.vertexOrders.comboPreview(order);
    await expectCode(
      client.vertexOrders.comboSubmit({
        order,
        confirmToken: first.confirmToken ?? "",
        confirm: true,
      }),
      "AUDIT_UNAVAILABLE",
      503
    );
    const second = await client.vertexOrders.comboPreview(order);
    held = 1;
    await expectCode(
      client.vertexOrders.comboSubmit({
        order,
        confirmToken: second.confirmToken ?? "",
        confirm: true,
      }),
      "ORDER_REJECTED",
      422
    );
    // Simulated default mock: the combo is accepted only with a matching spread.
    const fresh = createMockOrderGateway(() => at);
    expect((await fresh.placeCombo(order, "vertex-c")).state).toBe("submitted");
    expect((await fresh.placeCombo(order, "vertex-c")).state).toBe("aborted");
  });

  it("live: no bridge token fails closed; an unconfirmed single order stays unknown", async () => {
    clock = new Date(at);
    const on = { ...OFF, enabled: true, submission: "enabled" };
    const { bridgeToken: _unused, ...noToken } = on;
    await expectCode(
      clientFor({ config: noToken }).vertexOrders.status({}),
      "NOT_CONFIGURED",
      503
    );
    bridgeFetch.mockImplementation(async (input: string) =>
      Response.json(
        input.endsWith("/account")
          ? {
              netLiquidation: 200_000,
              positions: [],
              openOrders: [],
              gates: { killSwitch: false, optionsOnly: true },
              caps: { leapsMinDays: 365, leapsPct: 6, shortPct: 2 },
            }
          : { state: "unconfirmed", permId: null, message: "pending" }
      )
    );
    const { store, rows } = intentStore();
    const client = clientFor({ config: on, intents: store });
    const preview = await client.vertexOrders.preview(order({ quantity: 1 }));
    await client.vertexOrders.submit({
      order: order({ quantity: 1 }),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(rows.at(-1)).toBe("vertex.order.result unknown");
  });

  it("live combo goes to the bridge /combos route", async () => {
    clock = new Date(at);
    bridgeFetch.mockImplementation(async (input: string) =>
      Response.json(
        input.endsWith("/account")
          ? {
              netLiquidation: 200_000,
              positions: [
                {
                  symbol: "MOCKS",
                  secType: "OPT",
                  expiry: "20280121",
                  strike: 100,
                  right: "P",
                  quantity: -1,
                  premium: 0,
                },
                {
                  symbol: "MOCKS",
                  secType: "OPT",
                  expiry: "20280121",
                  strike: 90,
                  right: "P",
                  quantity: 1,
                  premium: 500,
                },
              ],
              openOrders: [],
              gates: { killSwitch: false, optionsOnly: true },
              caps: { leapsMinDays: 365, leapsPct: 2, shortPct: 2 },
            }
          : { state: "submitted", permId: 44, message: "bridge" }
      )
    );
    const on = { ...OFF, enabled: true, submission: "enabled" };
    const client = clientFor({ config: on, intents: intentStore().store });
    const order = {
      symbol: "MOCKS",
      quantity: 1,
      limitPrice: 0.8,
      legs: [
        {
          expiry: "20280121",
          strike: 100,
          right: "P" as const,
          side: "BUY" as const,
          ratio: 1,
        },
        {
          expiry: "20280121",
          strike: 90,
          right: "P" as const,
          side: "SELL" as const,
          ratio: 1,
        },
      ],
    };
    const preview = await client.vertexOrders.comboPreview(order);
    expect(preview.gates.mode).toBe("live");
    expect(
      await client.vertexOrders.comboSubmit({
        order,
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      })
    ).toMatchObject({ mode: "live", permId: 44 });
    expect(bridgeFetch.mock.calls.map(([url]) => url)).toContain(
      "http://127.0.0.1:3470/combos"
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
    expect((await client.vertexOrders.status({})).openOrders).toHaveLength(2);
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
      ["vertex.orders.submit", "outcome unknown: bridge down"],
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

  it("keeps a timed-out order as unknown and reconciles it before a new preview", async () => {
    clock = new Date(at);
    const now = () => clock;
    const late: OrderGatewayPort = {
      ...mock,
      // The bridge timed out, but the order reached IBKR.
      place: async (o, ref) => {
        await mock.place(o, ref);
        throw new OrderGatewayError(
          "UPSTREAM_ERROR",
          "Order bridge did not answer"
        );
      },
    };
    const lost: OrderGatewayPort = {
      ...mock,
      place: () =>
        Promise.reject(
          new OrderGatewayError("UPSTREAM_ERROR", "Order bridge did not answer")
        ),
    };
    const { store, rows } = intentStore();
    const events: SemanticEvent[] = [];
    const client = clientFor({ intents: store, events });
    const submit = async (input = order()) => {
      const preview = await client.vertexOrders.preview(input);
      return await client.vertexOrders.submit({
        order: input,
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      });
    };

    setVertexOrdersDependenciesForTesting({ mock: late, now });
    const error = await submit().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", status: 502 });
    expect((error as Error).message).toMatch(/^Outcome unknown/u);
    expect(rows.at(-1)).toBe("vertex.order.result unknown");
    // The order shows in open orders: reconciled, and the next preview is accepted.
    const next = await client.vertexOrders.preview(order({ strike: 120 }));
    expect(next.review.accepted).toBe(true);
    expect(rows.at(-1)).toBe("vertex.order.reconciled open");
    expect(events.some((e) => e.name === "vertex.orders.reconcile")).toBe(true);

    // The order never arrived: every preview is refused until the settle time passes.
    setVertexOrdersDependenciesForTesting({ mock: lost, now });
    await expectCode(submit(order({ strike: 110 })), "UPSTREAM_ERROR", 502);
    const blocked = await client.vertexOrders.preview(order({ strike: 130 }));
    expect(blocked.review.accepted).toBe(false);
    expect(blocked.confirmToken).toBeNull();
    expect(blocked.review.reasons.at(-1)).toMatch(/unknown outcome/u);
    clock = new Date(at.getTime() + 10 * 60_000);
    const settled = await client.vertexOrders.preview(order({ strike: 130 }));
    expect(settled.review.accepted).toBe(true);
    return expect(rows.at(-1)).toBe("vertex.order.reconciled not-found");
  });

  it("reconciles an unknown order by a position change", async () => {
    clock = new Date(at);
    const { store, intents, rows } = intentStore();
    const [held] = (await mock.account()).positions;
    intents.push({
      orderRef: "leaps-vertex-x",
      contract: "MOCKA call",
      symbol: held?.symbol ?? "",
      expiry: held?.expiry ?? "",
      strike: held?.strike ?? 0,
      right: "C",
      heldBefore: 0,
      createdAt: new Date(at.getTime() - 10 * 60_000),
    });
    const preview = await clientFor({ intents: store }).vertexOrders.preview(
      order()
    );
    expect(preview.review.accepted).toBe(true);
    return expect(rows).toEqual(["vertex.order.reconciled position-changed"]);
  });

  it("rethrows an unexpected place error and survives a failed result row", async () => {
    clock = new Date(at);
    const { store, intents } = intentStore();
    setVertexOrdersDependenciesForTesting({
      mock: { ...mock, place: () => Promise.reject(new Error("bug")) },
      now: () => clock,
    });
    const client = clientFor({
      intents: {
        ...store,
        recordOutcome: () => Promise.reject(new Error("db down")),
      },
    });
    const preview = await client.vertexOrders.preview(order());
    await expectCode(
      client.vertexOrders.submit({
        order: order(),
        confirmToken: preview.confirmToken ?? "",
        confirm: true,
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    expect(intents).toHaveLength(1);
    // The account read fails at submit: audited with the gateway message, nothing placed.
    let reads = 0;
    const events: SemanticEvent[] = [];
    setVertexOrdersDependenciesForTesting({
      mock: {
        ...mock,
        account: () => {
          reads += 1;
          return reads > 1
            ? Promise.reject(new OrderGatewayError("UPSTREAM_ERROR", "down"))
            : mock.account();
        },
      },
      now: () => clock,
    });
    const second = clientFor({ intents: intentStore().store, events });
    const again = await second.vertexOrders.preview(order({ strike: 140 }));
    await expectCode(
      second.vertexOrders.submit({
        order: order({ strike: 140 }),
        confirmToken: again.confirmToken ?? "",
        confirm: true,
      }),
      "UPSTREAM_ERROR",
      502
    );
    return expect(events.at(-1)?.attributes?.["result"]).toBe("down");
  });

  it("fails closed when the intent store fails", async () => {
    clock = new Date(at);
    const place = vi.spyOn(mock, "place");
    const { store, intents } = intentStore();
    const client = clientFor({
      intents: {
        ...store,
        recordIntent: () => Promise.reject(new Error("db down")),
      },
    });
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
    expect(place).not.toHaveBeenCalled();
    const unreadable = await clientFor({
      intents: { ...store, unresolved: () => Promise.reject(new Error("x")) },
    }).vertexOrders.preview(order());
    expect(unreadable.review.reasons.at(-1)).toMatch(
      /intent store unavailable/u
    );
    intents.push({
      orderRef: "leaps-vertex-y",
      contract: "OTHER",
      symbol: "OTHER",
      expiry: "20280121",
      strike: 5,
      right: "C",
      heldBefore: 0,
      createdAt: new Date(at.getTime() - 60 * 60_000),
    });
    const stuck = await clientFor({
      intents: {
        ...store,
        recordOutcome: () => Promise.reject(new Error("db down")),
      },
    }).vertexOrders.preview(order());
    expect(stuck.review.accepted).toBe(false);
    return expect(stuck.review.reasons.at(-1)).toMatch(/leaps-vertex-y/u);
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

describe("final JEV order gate on the simulated gateway (merge plan P6)", () => {
  const vertical = (
    over: Partial<VertexComboInput> = {}
  ): VertexComboInput => ({
    symbol: "MOCKV",
    quantity: 2,
    limitPrice: 4,
    legs: [
      { expiry: "20280121", strike: 100, right: "C", side: "BUY", ratio: 1 },
      { expiry: "20280121", strike: 110, right: "C", side: "SELL", ratio: 1 },
    ],
    ...over,
  });

  it("shows the gate verdict and denies an order without a fresh JEV verdict", async () => {
    setOrdersDependencies({ mock, now: () => at });
    const preview = await clientFor().vertexOrders.preview(order());
    expect(preview.review.accepted).toBe(false);
    expect(preview.review.finalGate).toMatchObject({
      decision: "deny",
      jevState: "none",
      structure: "long-option",
    });
    expect(preview.review.reasons.join(" ")).toMatch(/Final gate: JEV/);
    expect(preview.confirmToken).toBeNull();
  });

  it("denies a long option that opposes the JEV stance", async () => {
    setOrdersDependencies({
      mock,
      now: () => at,
      jevVerdict: (symbol) => {
        const base = neutralJev(symbol);
        return base.verdict === null
          ? base
          : { ...base, verdict: { ...base.verdict, stance: "BEARISH" } };
      },
    });
    const preview = await clientFor().vertexOrders.preview(order());
    expect(preview.review.finalGate?.reasons.join(" ")).toMatch(/opposes/);
    expect(preview.review.accepted).toBe(false);
  });

  it("opens a debit vertical as one combo and places it on the mock", async () => {
    const client = clientFor();
    const preview = await client.vertexOrders.comboPreview(vertical());
    expect(preview.review.accepted).toBe(true);
    expect(preview.review.finalGate).toMatchObject({
      decision: "allow",
      maxLoss: 800,
      structure: "debit-vertical",
    });
    const result = await client.vertexOrders.comboSubmit({
      order: vertical(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(result).toMatchObject({ mode: "simulated", state: "submitted" });
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("denies a vertical whose max loss is above 2% of account value, and a naked ratio leg", async () => {
    const client = clientFor();
    const big = await client.vertexOrders.comboPreview(
      vertical({ quantity: 20 })
    );
    expect(big.review.accepted).toBe(false);
    expect(big.review.reasons.join(" ")).toMatch(/2% of account value/);
    const ratio = await client.vertexOrders.comboPreview(
      vertical({
        legs: [
          {
            expiry: "20280121",
            strike: 100,
            right: "C",
            side: "BUY",
            ratio: 1,
          },
          {
            expiry: "20280121",
            strike: 110,
            right: "C",
            side: "SELL",
            ratio: 2,
          },
        ],
      })
    );
    expect(ratio.review.finalGate?.structure).toBe("rejected");
    expect(ratio.review.accepted).toBe(false);
  });

  it("refuses opening combos that break the account gates", async () => {
    const gated = {
      ...mock,
      account: async () => ({
        ...(await mock.account()),
        gates: { killSwitch: true, optionsOnly: false },
        openOrders: [
          {
            permId: 5,
            symbol: "MOCKV",
            secType: "OPT",
            expiry: "20280121",
            strike: 100,
            right: "C",
            side: "BUY",
            quantity: 1,
            orderType: "LMT",
            limitPrice: 1,
            status: "Submitted",
            orderRef: "x",
          },
          {
            permId: 6,
            symbol: "MOCKV",
            secType: "BAG",
            expiry: null,
            strike: null,
            right: null,
            side: "BUY",
            quantity: 1,
            orderType: "LMT",
            limitPrice: 1,
            status: "Submitted",
            orderRef: "y",
          },
        ],
      }),
    };
    setVertexOrdersDependenciesForTesting({ mock: gated, now: () => at });
    const preview = await clientFor().vertexOrders.comboPreview(
      vertical({
        legs: [
          {
            expiry: "20221021",
            strike: 100,
            right: "C",
            side: "BUY",
            ratio: 1,
          },
          {
            expiry: "20221021",
            strike: 110,
            right: "C",
            side: "SELL",
            ratio: 1,
          },
        ],
      })
    );
    const text = preview.review.reasons.join(" ");
    expect(text).toMatch(/Kill switch/);
    expect(text).toMatch(/OPTIONS_ONLY/);
    expect(text).toMatch(/combo order on MOCKV/);
    expect(text).toMatch(/expiry must be after today/);
    const resting = await clientFor().vertexOrders.comboPreview(vertical());
    expect(resting.review.reasons.join(" ")).toMatch(/open order rests/);
  });

  it("live mode runs the final gate, accepts an opening vertical and keeps the env gates", async () => {
    const on = { ...OFF, enabled: true, submission: "enabled" };
    const { store } = intentStore();
    const client = clientFor({ config: on, intents: store });
    const preview = await client.vertexOrders.preview(order({ right: "P" }));
    expect(preview.gates.mode).toBe("live");
    expect(preview.review.finalGate).toMatchObject({
      decision: "allow",
      structure: "long-option",
    });
    // The live order tail accepts defined-risk opening verticals (market-watch-bot PR #36).
    const combo = await client.vertexOrders.comboPreview(vertical());
    expect(combo.review.reasons.join(" ")).not.toMatch(/close-only/);
    expect(combo.review.finalGate).toMatchObject({
      decision: "allow",
      structure: "debit-vertical",
    });
    expect(combo.review.accepted).toBe(true);
    expect(combo.confirmToken).not.toBeNull();
    // VERTEX_ORDER_SUBMISSION disabled: the mock is used, never the bridge.
    bridgeFetch.mockClear();
    const off = clientFor({ config: { ...on, submission: "disabled" } });
    expect((await off.vertexOrders.comboPreview(vertical())).gates.mode).toBe(
      "simulated"
    );
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("on live, denies a new position without a JEV verdict or with the kill switch on, but lets a close through", async () => {
    const on = { ...OFF, enabled: true, submission: "enabled" };
    const { store } = intentStore();
    setOrdersDependencies({ mock, bridgeFetch, now: () => at });
    const client = clientFor({ config: on, intents: store });
    const nojev = await client.vertexOrders.preview(order());
    expect(nojev.review.finalGate).toMatchObject({
      decision: "deny",
      jevState: "none",
    });
    expect(nojev.confirmToken).toBeNull();
    bridgeFetch.mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith("/account")
          ? {
              netLiquidation: 100_000,
              positions: [
                {
                  symbol: "MOCKD",
                  secType: "OPT",
                  expiry: "20280121",
                  strike: 100,
                  right: "C",
                  quantity: 2,
                  premium: 2000,
                },
              ],
              openOrders: [],
              gates: { killSwitch: true, optionsOnly: true },
              caps: { leapsMinDays: 365, leapsPct: 6, shortPct: 2 },
            }
          : { state: "submitted", permId: 42, message: "bridge" }
      )
    );
    const open = await client.vertexOrders.preview(order({ quantity: 1 }));
    expect(open.review.accepted).toBe(false);
    const close = await client.vertexOrders.preview(order({ side: "SELL" }));
    expect(close.review.finalGate).toMatchObject({
      decision: "allow",
      structure: "risk-reducing",
      jevState: "none",
    });
    expect(close.confirmToken).not.toBeNull();
  });

  it("audits a refused (aborted) placement as a failure", async () => {
    const events: SemanticEvent[] = [];
    setOrdersDependencies({
      jevVerdict: neutralJev,
      mock: {
        ...mock,
        place: async () => ({
          state: "aborted",
          permId: null,
          message: "refused",
        }),
      },
      now: () => at,
    });
    const client = clientFor({ events });
    const preview = await client.vertexOrders.preview(order());
    const result = await client.vertexOrders.submit({
      order: order(),
      confirmToken: preview.confirmToken ?? "",
      confirm: true,
    });
    expect(result.state).toBe("aborted");
    const last = events.at(-1);
    expect(JSON.stringify(last)).toContain("failure");
    setOrdersDependencies({
      jevVerdict: neutralJev,
      mock: {
        ...mock,
        placeCombo: async () => ({
          state: "aborted",
          permId: null,
          message: "refused",
        }),
      },
      now: () => at,
    });
    const combo = await client.vertexOrders.comboPreview(vertical());
    const comboResult = await client.vertexOrders.comboSubmit({
      order: vertical(),
      confirmToken: combo.confirmToken ?? "",
      confirm: true,
    });
    expect(comboResult.state).toBe("aborted");
    expect(JSON.stringify(events.at(-1))).toContain("failure");
  });

  it("lets a share close through as risk-reducing and logs the gate in the audit", async () => {
    const events: SemanticEvent[] = [];
    const client = clientFor({ events });
    const close = order({
      symbol: "MOCKA",
      secType: "STK",
      expiry: "",
      strike: 0,
      right: "",
      side: "SELL",
      quantity: 100,
      limitPrice: 90,
    });
    const preview = await client.vertexOrders.preview(close);
    expect(preview.review.accepted).toBe(true);
    expect(preview.review.finalGate).toMatchObject({
      decision: "allow",
      jevState: "fresh",
      structure: "risk-reducing",
    });
    expect(JSON.stringify(events)).toContain("allow risk-reducing jev=fresh");
  });

  it("counts premium already open in the name for an opening debit vertical", async () => {
    const heavy = {
      ...mock,
      account: async () => ({
        ...(await mock.account()),
        positions: [
          {
            symbol: "MOCKV",
            secType: "OPT",
            expiry: "20280121",
            strike: 90,
            right: "C",
            quantity: 1,
            premium: 11_000,
          },
          {
            symbol: "MOCKS",
            secType: "OPT",
            expiry: "20261218",
            strike: 90,
            right: "C",
            quantity: 1,
            premium: 3000,
          },
        ],
      }),
    };
    setVertexOrdersDependenciesForTesting({ mock: heavy, now: () => at });
    const client = clientFor();
    const leaps = await client.vertexOrders.comboPreview(
      vertical({ limitPrice: 8 })
    );
    expect(leaps.review.reasons.join(" ")).toMatch(/per-name maximum is 6%/);
    const short = await client.vertexOrders.comboPreview(
      vertical({
        symbol: "MOCKS",
        limitPrice: 8,
        legs: [
          {
            expiry: "20261218",
            strike: 100,
            right: "C",
            side: "BUY",
            ratio: 1,
          },
          {
            expiry: "20261218",
            strike: 110,
            right: "C",
            side: "SELL",
            ratio: 1,
          },
        ],
      })
    );
    expect(short.review.reasons.join(" ")).toMatch(
      /short-dated premium; the cap is 2%/
    );
    const credit = await client.vertexOrders.comboPreview(
      vertical({
        limitPrice: -3,
        legs: [
          {
            expiry: "20280121",
            strike: 100,
            right: "C",
            side: "SELL",
            ratio: 1,
          },
          {
            expiry: "20280121",
            strike: 110,
            right: "C",
            side: "BUY",
            ratio: 1,
          },
        ],
      })
    );
    expect(credit.review.reasons.join(" ")).not.toMatch(/Premium cap/);
    const badDate = await client.vertexOrders.comboPreview(
      vertical({
        legs: [
          {
            expiry: "20281399",
            strike: 100,
            right: "C",
            side: "BUY",
            ratio: 1,
          },
          {
            expiry: "20281399",
            strike: 110,
            right: "C",
            side: "SELL",
            ratio: 1,
          },
        ],
      })
    );
    expect(badDate.review.reasons.join(" ")).toMatch(
      /expiry must be after today/
    );
  });
});
