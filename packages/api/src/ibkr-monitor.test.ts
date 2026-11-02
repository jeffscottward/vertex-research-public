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
  IBKR_MONITOR_ALLOWED_PATHS,
  IbkrMonitorError,
  buildIbkrMonitorUrl,
  fetchIbkrMonitorJson,
  fetchIbkrMonitorRoundHandles,
  fetchIbkrMonitorVolatility,
  fetchIbkrMonitorSnapshot,
  ibkrBridgeGateway,
  setIbkrMonitorFetchOptionsForTesting,
  toIbkrMonitorOutput,
  toMarketVolatility,
  toRoundHandleCheck,
} from "./server/ibkr-monitor.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";

// Fictional account data only. The account-code-shaped string is a synthetic test value.
const at = new Date("2026-10-21T14:00:05.000Z");
const SERVER_MS = Date.parse("2026-10-21T14:00:00.000Z");
const BASE = "http://127.0.0.1:3461";
const FAKE_ACCOUNT = "U0000001";

const order = (overrides: Record<string, unknown> = {}) => ({
  key: "p:9001",
  permId: 9001,
  clientId: 0,
  orderId: 0,
  parentId: 0,
  ocaGroup: "",
  orderRef: "",
  conId: "1001",
  symbol: "AAA",
  secType: "STK",
  action: "SELL",
  orderType: "STP",
  qty: 100,
  filledQty: 0,
  remaining: 100,
  avgFill: null,
  lmt: null,
  stop: 48.5,
  trailPct: null,
  tif: "GTC",
  outsideRth: false,
  status: "PreSubmitted",
  completedTime: "",
  completedStatus: "",
  parentKey: null,
  ...overrides,
});

// Shape of ibkr-monitor GET /api/snapshot (server/index.mjs derive()), including fields the tab ignores.
const upstream = (overrides: Record<string, unknown> = {}) => ({
  status: {
    bridge: "live",
    stale: false,
    dataAsOf: SERVER_MS - 2000,
    ageS: 2,
    lastError: "",
    serverTime: SERVER_MS,
  },
  accountCount: 1,
  summary: {
    NetLiquidation: 100_000,
    TotalCashValue: 20_000,
    BuyingPower: 150_000,
    AvailableFunds: 40_000,
    ExcessLiquidity: 45_000,
    InitMarginReq: 30_000,
    MaintMarginReq: 25_000,
    Cushion: 0.45,
  },
  pnl: { daily: 120.5, unrealized: 900, realized: 0 },
  positions: [
    {
      id: "2002",
      symbol: "BBB",
      secType: "OPT",
      currency: "USD",
      desc: "BBB 20270115 100 C",
      right: "C",
      strike: 100,
      expiry: "20270115",
      multiplier: 100,
      position: 2,
      avgPrice: 5,
      last: 6,
      marketValue: 1200,
      costBasis: 1000,
      dailyPnl: 20,
      unrealized: 200,
      unrealizedPct: 20,
      realized: 0,
      weightPct: 1.2,
    },
    {
      id: "1001",
      symbol: "AAA",
      secType: "STK",
      currency: "USD",
      desc: "AAA",
      right: "",
      strike: 0,
      expiry: "",
      multiplier: 1,
      position: 100,
      avgPrice: 50,
      last: 55,
      marketValue: 5500,
      costBasis: 5000,
      dailyPnl: 25,
      unrealized: 500,
      unrealizedPct: 10,
      realized: 0,
      weightPct: 5.5,
    },
  ],
  options: { today: "2026-10-21", rows: [], names: [], totals: {} },
  orders: [
    order({
      key: "c0:1",
      orderId: 1,
      orderType: "LMT",
      action: "BUY",
      lmt: 49,
      stop: null,
      status: "Submitted",
    }),
    order({ key: "c0:2", orderId: 2, parentId: 1, parentKey: "c0:1" }),
    order({
      key: "c0:3",
      orderId: 3,
      parentId: 77,
      parentKey: "c0:77",
      orderRef: `ref ${FAKE_ACCOUNT}`,
    }),
  ],
  ordersAsOf: SERVER_MS - 5000,
  completed: [
    order({
      key: "p:9100",
      permId: 9100,
      status: "Filled",
      filledQty: 100,
      remaining: null,
      completedTime: "20261021 13:59:00",
      completedStatus: "Filled",
    }),
  ],
  executions: [
    {
      execId: "e2",
      time: "20261021 13:59:00",
      symbol: "AAA",
      secType: "STK",
      localSymbol: "AAA",
      side: "SLD",
      shares: 100,
      price: 48.5,
      avgPrice: 48.5,
      cumQty: 100,
      orderId: 0,
      permId: 9100,
      clientId: 0,
      exchange: "NYSE",
      orderRef: "",
      commission: 1,
      realized: null,
    },
    {
      execId: "e1",
      time: "20261021 13:00:00",
      symbol: "AAA",
      secType: "STK",
      localSymbol: "AAA",
      side: "BOT",
      shares: 100,
      price: 47,
      avgPrice: 47,
      cumQty: 100,
      orderId: 0,
      permId: 9099,
      clientId: 0,
      exchange: "NYSE",
      orderRef: "",
      commission: 1,
      realized: null,
    },
  ],
  errors: [
    {
      t: SERVER_MS / 1000,
      code: 2104,
      msg: `Market data farm OK ${FAKE_ACCOUNT}`,
    },
  ],
  ...overrides,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => {
  setIbkrMonitorFetchOptionsForTesting({});
});

describe("ibkrMonitor mapping", () => {
  it("maps the ibkr-monitor snapshot to the Portfolio tab view without changing its values", () => {
    const output = toIbkrMonitorOutput(upstream(), at);
    expect(output.readOnly).toBe(true);
    expect(output.status).toMatchObject({
      gateway: "live",
      connected: true,
      clientId: 195,
      lastError: null,
      dataAsOf: "2026-10-21T13:59:58.000Z",
      ordersAsOf: "2026-10-21T13:59:55.000Z",
      generatedAt: "2026-10-21T14:00:00.000Z",
      receivedAt: at.toISOString(),
    });
    expect(output.summary).toMatchObject({
      netLiquidation: 100_000,
      availableFunds: 40_000,
      maintMarginReq: 25_000,
      cushion: 0.45,
      settledCash: null,
      leverage: null,
    });
    expect(output.pnl).toEqual({ daily: 120.5, unrealized: 900, realized: 0 });
    // Sorted by absolute market value; per-share prices and percentages come from ibkr-monitor unchanged.
    expect(output.positions.map((row) => row.symbol)).toEqual(["AAA", "BBB"]);
    expect(output.positions[1]).toMatchObject({
      description: "BBB 20270115 100 C",
      avgPrice: 5,
      last: 6,
      unrealizedPct: 20,
      weightPct: 1.2,
    });
    expect(output.account).toEqual({ mode: "unknown", count: 1 });
  });

  it("keeps parent/child nesting and drops parent keys that point at no listed order", () => {
    const output = toIbkrMonitorOutput(upstream(), at);
    expect(
      output.orders.map((row) => [
        row.key,
        row.parentKey,
        row.limitPrice,
        row.stopPrice,
      ])
    ).toEqual([
      ["c0:1", null, 49, null],
      ["c0:2", "c0:1", null, 48.5],
      ["c0:3", null, null, 48.5],
    ]);
    expect(output.completed[0]).toMatchObject({
      status: "Filled",
      remaining: null,
      completedStatus: "Filled",
    });
    expect(output.executions.map((row) => row.execId)).toEqual(["e1", "e2"]);
  });

  it("falls back to the symbol and ranks positions without a market value last", () => {
    const base = upstream().positions[1];
    const output = toIbkrMonitorOutput(
      upstream({
        positions: [
          { ...base, id: "3003", symbol: "CCC", desc: "", marketValue: null },
          base,
          { ...base, id: "4004", symbol: "DDD", marketValue: null },
        ],
      }),
      at
    );
    expect(output.positions.map((row) => row.symbol)).toEqual([
      "AAA",
      "CCC",
      "DDD",
    ]);
    expect(output.positions[1]).toMatchObject({
      description: "CCC",
      marketValue: null,
    });
  });

  it("removes account codes from text fields", () => {
    const text = JSON.stringify(toIbkrMonitorOutput(upstream(), at));
    expect(text).not.toContain(FAKE_ACCOUNT);
    expect(text).toContain("[account]");
  });

  it("maps bridge states and an empty pre-connection snapshot honestly", () => {
    expect(
      ["live", "connecting", "restarting", "disconnected", "other"].map(
        ibkrBridgeGateway
      )
    ).toEqual(["live", "starting", "starting", "disconnected", "disconnected"]);
    const empty = toIbkrMonitorOutput(
      {
        status: {
          bridge: "connecting",
          stale: true,
          dataAsOf: null,
          ageS: null,
          lastError: "bridge exited",
          serverTime: SERVER_MS,
        },
        summary: {},
        pnl: {},
        positions: [],
        options: {},
        orders: [],
        completed: [],
        executions: [],
        errors: [],
      },
      at
    );
    expect(empty.status).toMatchObject({
      gateway: "starting",
      connected: false,
      dataAsOf: null,
      lastError: "bridge exited",
    });
    expect(empty.summary.netLiquidation).toBeNull();
  });

  it("rejects schema drift", () => {
    expect(() => toIbkrMonitorOutput({ status: {} }, at)).toThrow(
      IbkrMonitorError
    );
    expect(() =>
      toIbkrMonitorOutput(upstream({ positions: [{ id: "1" }] }), at)
    ).toThrow(IbkrMonitorError);
  });
});

describe("ibkrMonitor proxy (read-only allow-list)", () => {
  it("allows only the GET snapshot, health and volatility paths on a loopback http base", () => {
    expect(IBKR_MONITOR_ALLOWED_PATHS).toEqual([
      "/api/snapshot",
      "/api/health",
      "/api/volatility",
    ]);
    expect(buildIbkrMonitorUrl(BASE, "/api/snapshot")).toBe(
      "http://127.0.0.1:3461/api/snapshot"
    );
    expect(buildIbkrMonitorUrl("http://localhost:3461/", "/api/health")).toBe(
      "http://localhost:3461/api/health"
    );
    for (const path of [
      "/api/ibkr-2fa",
      "/api/ibkr-2fa?action=cooldown",
      "/api/volatility?x=1",
      "/api/snapshot/../ibkr-2fa",
      "/",
      "/ws/reentry",
    ])
      expect(() => buildIbkrMonitorUrl(BASE, path)).toThrow(/allow-list/);
    for (const base of [
      "https://127.0.0.1:3461",
      "http://quant-vps-host:3461",
      "http://100.64.0.10:3461",
      "http://user:pw@127.0.0.1:3461",
      "http://127.0.0.1:3461?x=1",
      "not a url",
    ])
      expect(() => buildIbkrMonitorUrl(base, "/api/snapshot")).toThrow(
        IbkrMonitorError
      );
  });

  it("sends one GET with manual redirects and no credentials", async () => {
    const doFetch = vi.fn(async () => jsonResponse(upstream()));
    const output = await fetchIbkrMonitorSnapshot(BASE, {
      fetch: doFetch,
      now: () => at,
    });
    expect(output.positions).toHaveLength(2);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:3461/api/snapshot");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([
      "accept",
    ]);
  });

  it("uses the global fetch and the current time by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(upstream()));
    try {
      const output = await fetchIbkrMonitorSnapshot(BASE);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(Date.parse(output.status.receivedAt)).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a path outside the allow-list before any network call", async () => {
    const doFetch = vi.fn();
    const failure = (await fetchIbkrMonitorJson(
      BASE,
      "/api/ibkr-2fa" as unknown as "/api/health",
      { fetch: doFetch }
    ).catch((error: unknown) => error)) as IbkrMonitorError;
    expect(failure).toBeInstanceOf(IbkrMonitorError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("maps upstream failures to typed codes", async () => {
    const unreadable = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("socket closed"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const cases: [Response | Error, string][] = [
      [jsonResponse({}, { status: 503 }), "UNAVAILABLE"],
      [jsonResponse({}, { status: 421 }), "UPSTREAM_ERROR"],
      [
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        "UPSTREAM_ERROR",
      ],
      [new Response("{}"), "UPSTREAM_ERROR"],
      [new Response(new TextEncoder().encode("{}")), "UPSTREAM_ERROR"],
      [Response.redirect("http://evil.test/", 302), "UPSTREAM_ERROR"],
      [
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "UPSTREAM_ERROR",
      ],
      [unreadable, "UPSTREAM_ERROR"],
      [new Error("ECONNREFUSED"), "UNAVAILABLE"],
    ];
    for (const [result, code] of cases) {
      const doFetch = async () => {
        if (result instanceof Error) throw result;
        return result;
      };
      const failure = (await fetchIbkrMonitorSnapshot(BASE, {
        fetch: doFetch,
      }).catch((error: unknown) => error)) as IbkrMonitorError;
      expect(failure.code).toBe(code);
    }
    const oversized = (await fetchIbkrMonitorSnapshot(BASE, {
      fetch: async () => jsonResponse(upstream()),
      maxBytes: 10,
    }).catch((error: unknown) => error)) as IbkrMonitorError;
    expect(oversized).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(oversized.message).toMatch(/size cap/);
    const missing = vi.fn();
    const notConfigured = (await fetchIbkrMonitorSnapshot(null, {
      fetch: missing,
    }).catch((error: unknown) => error)) as IbkrMonitorError;
    expect(notConfigured.code).toBe("NOT_CONFIGURED");
    expect(missing).not.toHaveBeenCalled();
  });

  it("reports a timeout as unavailable", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    const failure = (await fetchIbkrMonitorSnapshot(BASE, {
      fetch: hang,
      timeoutMs: 1,
    }).catch((error: unknown) => error)) as IbkrMonitorError;
    expect(failure).toMatchObject({
      code: "UNAVAILABLE",
      message: "ibkr-monitor request timed out",
    });
    const stalled = async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted"))
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const bodyTimeout = (await fetchIbkrMonitorSnapshot(BASE, {
      fetch: stalled,
      timeoutMs: 1,
    }).catch((error: unknown) => error)) as IbkrMonitorError;
    expect(bodyTimeout).toMatchObject({
      code: "UNAVAILABLE",
      message: "ibkr-monitor request timed out",
    });
  });

  it("accepts only loopback http in IBKR_MONITOR_URL", () => {
    const url = serverEnvSchema.shape.IBKR_MONITOR_URL;
    expect(url.safeParse("http://127.0.0.1:3461").success).toBe(true);
    expect(url.safeParse("").data).toBeUndefined();
    for (const value of [
      "http://quant-vps-host:3461",
      "https://example.test",
      "http://u:p@127.0.0.1:3461",
      "http://127.0.0.1:3461/?a=1",
    ])
      expect(url.safeParse(value).success).toBe(false);
  });
});

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
    expiresAt: new Date("2026-10-22T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  ibkrMonitor: string | null
) => {
  const repositories = {
    profiles: {},
    addresses: {},
    userPreferences: {},
    featureItems: {},
    adminUsers: {},
    dashboard: {},
  } as unknown as Repositories;
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
      ibkrMonitor,
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

describe("ibkrMonitor.snapshot procedure", () => {
  it("is operator-only and never calls upstream for denied callers", async () => {
    const doFetch = vi.fn(async () => jsonResponse(upstream()));
    setIbkrMonitorFetchOptionsForTesting({ fetch: doFetch, now: () => at });
    await expectCode(
      clientFor(null, BASE).ibkrMonitor.snapshot({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), BASE).ibkrMonitor.snapshot({}),
      "FORBIDDEN",
      403
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns the mapped snapshot to operators and typed errors otherwise", async () => {
    setIbkrMonitorFetchOptionsForTesting({
      fetch: async () => jsonResponse(upstream()),
      now: () => at,
    });
    const output = await clientFor(
      session("operator"),
      BASE
    ).ibkrMonitor.snapshot({});
    expect(output.status.clientId).toBe(195);
    await expectCode(
      clientFor(session("operator"), null).ibkrMonitor.snapshot({}),
      "NOT_CONFIGURED",
      503
    );
    setIbkrMonitorFetchOptionsForTesting({
      fetch: async () => jsonResponse({}, { status: 503 }),
      now: () => at,
    });
    await expectCode(
      clientFor(session("operator"), BASE).ibkrMonitor.snapshot({}),
      "UNAVAILABLE",
      503
    );
    setIbkrMonitorFetchOptionsForTesting({
      fetch: async () => jsonResponse(upstream()),
      now: () => {
        throw new Error("clock failed");
      },
    });
    await expectCode(
      clientFor(session("operator"), BASE).ibkrMonitor.snapshot({}),
      "UPSTREAM_ERROR",
      502
    );
  });

  it("is not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("ibkrMonitor");
    expect(AGENT_API_KEY_READ_PROCEDURES.has("ibkrMonitor.snapshot")).toBe(
      false
    );
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("ibkrMonitor"))
    ).toBe(false);
  });
});

// Shape of ibkr-monitor GET /api/volatility (server/volatility.mjs); only orderCheck is read.
const volatility = (flagged: unknown[] = [handleFlag()]) => ({
  serverTime: SERVER_MS,
  vix: { value: 17.2 },
  orderCheck: { checked: 7, skippedTrailing: 2, flagged },
  ordersAvailable: true,
});
function handleFlag(overrides: Record<string, unknown> = {}) {
  return {
    key: "p:9001",
    symbol: "AAA",
    secType: "STK",
    action: "SELL",
    orderType: "STP",
    qty: 100,
    kind: "stop",
    price: 48.5,
    handle: "48.50 handle",
    side: "below",
    offset: 0.13,
    suggested: 48.37,
    atr: 1.3,
    atrAsOf: "2026-10-20",
    atrError: null,
    ...overrides,
  };
}

describe("ibkrMonitor round-handle check", () => {
  it("keeps only the order-check flags and drops market and ATR fields", () => {
    expect(toRoundHandleCheck(volatility())).toEqual({
      checked: 7,
      skippedTrailing: 2,
      flags: [
        {
          key: "p:9001",
          kind: "stop",
          price: 48.5,
          handle: "48.50 handle",
          side: "below",
          offset: 0.13,
          suggested: 48.37,
        },
      ],
    });
    expect(
      toRoundHandleCheck(
        volatility([handleFlag({ handle: `near ${FAKE_ACCOUNT}` })])
      ).flags[0]?.handle
    ).not.toContain(FAKE_ACCOUNT);
  });

  it("rejects schema drift as an upstream error", () => {
    for (const raw of [
      {},
      volatility([handleFlag({ kind: "trail" })]),
      volatility([handleFlag({ suggested: "48.37" })]),
    ])
      expect(() => toRoundHandleCheck(raw)).toThrow(/unexpected shape/);
  });

  it("reads GET /api/volatility through the allow-listed proxy", async () => {
    const doFetch = vi.fn(async () => jsonResponse(volatility([])));
    const output = await fetchIbkrMonitorRoundHandles(BASE, { fetch: doFetch });
    expect(output).toEqual({ checked: 7, skippedTrailing: 2, flags: [] });
    expect(doFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3461/api/volatility",
      expect.objectContaining({ method: "GET" })
    );
  });
});

describe("ibkrMonitor.roundHandles procedure", () => {
  it("is operator-only and maps proxy failures to typed errors", async () => {
    const doFetch = vi.fn(async () => jsonResponse(volatility()));
    setIbkrMonitorFetchOptionsForTesting({ fetch: doFetch });
    await expectCode(
      clientFor(session("outsider"), BASE).ibkrMonitor.roundHandles({}),
      "FORBIDDEN",
      403
    );
    expect(doFetch).not.toHaveBeenCalled();
    const output = await clientFor(
      session("operator"),
      BASE
    ).ibkrMonitor.roundHandles({});
    expect(output.flags).toHaveLength(1);
    await expectCode(
      clientFor(session("operator"), null).ibkrMonitor.roundHandles({}),
      "NOT_CONFIGURED",
      503
    );
    setIbkrMonitorFetchOptionsForTesting({
      fetch: async () => {
        throw new Error("socket closed");
      },
    });
    await expectCode(
      clientFor(session("operator"), BASE).ibkrMonitor.roundHandles({}),
      "UNAVAILABLE",
      503
    );
  });

  it("is not reachable with agent API keys", () => {
    expect(AGENT_API_KEY_READ_PROCEDURES.has("ibkrMonitor.roundHandles")).toBe(
      false
    );
  });
});

const volSeries = (value: number, overrides: Record<string, unknown> = {}) => ({
  value,
  asOf: "2026-10-20",
  change1d: 0.4,
  prevDate: "2026-10-17",
  change5d: null,
  pct1y: 62,
  min1y: 11,
  max1y: 45,
  tradingDaysBehind: 0,
  stale: false,
  ...overrides,
});

const marketVolatility = (overrides: Record<string, unknown> = {}) => ({
  ...volatility([]),
  sources: {
    cboe: { fetchedAt: SERVER_MS, error: null },
    spx: { fetchedAt: SERVER_MS, error: null, source: "yahoo" },
    atr: { source: "yahoo" },
  },
  vix: volSeries(17.2),
  vixeq: volSeries(24.1, { change1d: null, pct1y: undefined }),
  vvix: volSeries(95, { stale: true }),
  spread: null,
  spx: {
    price: 5800,
    quoteTime: SERVER_MS,
    sessionDate: "2026-10-21",
    prevClose: 5780,
    prevDate: "2026-10-20",
    sessionOpen: true,
    movePct: 0.35,
    movePts: 20,
  },
  implied: {
    sessionDate: "2026-10-21",
    vixRef: 17.2,
    vixRefDate: "2026-10-20",
    impliedPct: 1.08,
    impliedPts: 62,
    multiple: 0.32,
    band: "normal",
    next: null,
  },
  ...overrides,
});

describe("ibkrMonitor market volatility", () => {
  it("keeps the market series and drops orders, ATR and history fields", () => {
    expect(toMarketVolatility(marketVolatility())).toEqual({
      vix: {
        value: 17.2,
        asOf: "2026-10-20",
        change1d: 0.4,
        pct1y: 62,
        stale: false,
      },
      vixeq: {
        value: 24.1,
        asOf: "2026-10-20",
        change1d: null,
        pct1y: null,
        stale: false,
      },
      vvix: {
        value: 95,
        asOf: "2026-10-20",
        change1d: 0.4,
        pct1y: 62,
        stale: true,
      },
      spread: null,
      spx: { price: 5800, movePct: 0.35, sessionOpen: true },
      implied: { impliedPct: 1.08, multiple: 0.32, band: "normal" },
      sourceErrors: [],
    });
  });

  it("reports source errors and missing sections honestly", () => {
    const output = toMarketVolatility({
      sources: {
        cboe: { error: `fetch failed for ${FAKE_ACCOUNT}` },
        spx: { error: "HTTP 429" },
      },
      spx: null,
      implied: { impliedPct: null, multiple: null },
    });
    expect(output.vix).toBeNull();
    expect(output.spx).toBeNull();
    expect(output.implied).toEqual({
      impliedPct: null,
      multiple: null,
      band: null,
    });
    expect(output.sourceErrors).toHaveLength(2);
    expect(output.sourceErrors[0]).toMatch(/^Cboe: fetch failed/u);
    expect(output.sourceErrors.join(" ")).not.toContain(FAKE_ACCOUNT);
    expect(output.sourceErrors[1]).toBe("S&P 500: HTTP 429");
    expect(toMarketVolatility({}).implied).toBeNull();
    expect(() => toMarketVolatility({ vix: { value: "17" } })).toThrow(
      /unexpected shape/u
    );
  });

  it("reads GET /api/volatility and is operator-only", async () => {
    const doFetch = vi.fn(async () => jsonResponse(marketVolatility()));
    expect(
      (await fetchIbkrMonitorVolatility(BASE, { fetch: doFetch })).vix?.value
    ).toBe(17.2);
    setIbkrMonitorFetchOptionsForTesting({ fetch: doFetch });
    await expectCode(
      clientFor(session("outsider"), BASE).ibkrMonitor.volatility({}),
      "FORBIDDEN",
      403
    );
    const output = await clientFor(
      session("operator"),
      BASE
    ).ibkrMonitor.volatility({});
    expect(output.implied?.band).toBe("normal");
    await expectCode(
      clientFor(session("operator"), null).ibkrMonitor.volatility({}),
      "NOT_CONFIGURED",
      503
    );
    expect(AGENT_API_KEY_READ_PROCEDURES.has("ibkrMonitor.volatility")).toBe(
      false
    );
  });
});
