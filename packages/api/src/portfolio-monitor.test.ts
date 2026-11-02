import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import {
  PortfolioMonitorError,
  buildPortfolioSnapshotUrl,
  fetchPortfolioMonitor,
  readCappedText,
  scrubPortfolioText,
  setPortfolioMonitorFetchOptionsForTesting,
  toPortfolioMonitorOutput,
} from "./server/portfolio-monitor.ts";

// Fictional account data only. Account-code-shaped strings below are synthetic test values.
const at = new Date("2026-10-10T14:00:05.000Z");
const GENERATED = Date.parse("2026-10-10T14:00:00.000Z") / 1000;
const TOKEN = "p".repeat(43);
const BASE = "https://quantvps.tailnet.test:8443/vertex-portfolio/v1";
const config: DeployStatusConfig = { url: BASE, token: TOKEN };
const FAKE_ACCOUNT = "U0000001";

const position = (overrides: Record<string, unknown> = {}) => ({
  conId: 1001,
  symbol: "AAA",
  secType: "STK",
  currency: "USD",
  right: "",
  strike: 0,
  expiry: "",
  multiplier: "",
  localSymbol: "AAA",
  position: 100,
  avgCost: 50,
  acctMarketPrice: 54,
  acctMarketValue: 5400,
  acctUnrealized: 400,
  realized: 0,
  pnlValue: 5500,
  dailyPnl: 25,
  pnlUnrealized: 500,
  pnlT: GENERATED - 5,
  ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  key: "7:11:9011",
  orderId: 11,
  permId: 9011,
  clientId: 7,
  parentId: 0,
  ocaGroup: "",
  orderRef: "",
  conId: 1001,
  symbol: "AAA",
  secType: "STK",
  localSymbol: "AAA",
  action: "BUY",
  orderType: "LMT",
  qty: 100,
  filledQty: 0,
  remaining: 100,
  avgFill: null,
  lmt: 49.5,
  aux: null,
  trailPct: null,
  trailStop: null,
  tif: "GTC",
  outsideRth: false,
  status: "Submitted",
  transmit: true,
  completedTime: "",
  completedStatus: "",
  ...overrides,
});

const execution = (overrides: Record<string, unknown> = {}) => ({
  execId: "0000e1.01",
  time: "20261010 09:31:00 US/Eastern",
  symbol: "AAA",
  secType: "STK",
  localSymbol: "AAA",
  side: "BOT",
  shares: 10,
  price: 50.1,
  avgPrice: 50.1,
  cumQty: 10,
  orderId: 3,
  permId: 9003,
  clientId: 7,
  exchange: "NYSE",
  orderRef: "",
  commission: 1,
  realized: null,
  ...overrides,
});

const upstream = (overrides: Record<string, unknown> = {}) => ({
  schema: "vertex-portfolio-snapshot-v1",
  source: "ibkr-gateway",
  clientId: 78,
  version: "1.0.0",
  generatedAt: GENERATED,
  state: "live",
  connected: true,
  lastError: null,
  accountMode: "live",
  accountCount: 1,
  dataAsOf: GENERATED - 1,
  ordersAsOf: GENERATED - 10,
  summary: {
    NetLiquidation: 20_000,
    TotalCashValue: 9000,
    MaintMarginReq: 2000,
    EquityWithLoanValue: 19_000,
    Cushion: 0.4,
  },
  pnl: { daily: 25, unrealized: 500, realized: 0 },
  positions: [
    position(),
    position({
      conId: 2002,
      symbol: "BBB",
      localSymbol: "BBB",
      position: 2,
      avgCost: 300,
      multiplier: "100",
      pnlValue: null,
      pnlT: null,
      acctMarketValue: 700,
      acctUnrealized: 100,
      dailyPnl: null,
      secType: "OPT",
      expiry: "20261120",
      strike: 40,
      right: "C",
    }),
  ],
  orders: [
    order({
      key: "7:20:9020",
      orderId: 20,
      permId: 9020,
      action: "SELL",
      orderType: "STP",
      aux: 45,
      lmt: null,
      status: "PreSubmitted",
    }),
    order({
      key: "7:21:9021",
      orderId: 21,
      permId: 9021,
      parentId: 20,
      action: "SELL",
      orderType: "STP LMT",
      aux: 44,
      lmt: 43.5,
      ocaGroup: `oca ${FAKE_ACCOUNT}`,
    }),
    order({
      key: "7:22:9022",
      orderId: 22,
      permId: 9022,
      action: "SELL",
      orderType: "TRAIL",
      aux: 2,
      trailStop: 47.25,
      trailPct: 5,
      orderRef: `ref ${FAKE_ACCOUNT}`,
    }),
  ],
  completed: [
    order({
      key: "7:5:9005",
      orderId: 5,
      permId: 9005,
      status: "Cancelled",
      completedTime: "20261010 09:40:00",
      completedStatus: "Cancelled by user",
    }),
  ],
  executions: [
    execution({ execId: "b", time: "20261010 10:00:00 US/Eastern" }),
    execution({ execId: "a" }),
  ],
  errors: [
    {
      t: GENERATED - 30,
      code: 2100,
      msg: `API client has been unsubscribed from account data for ${FAKE_ACCOUNT}`,
    },
  ],
  ...overrides,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
};

afterEach(() => setPortfolioMonitorFetchOptionsForTesting({}));

describe("portfolioMonitor derivation", () => {
  it("derives per-share prices, P&L %, weights and labels like the IBKR monitor reference", () => {
    const output = toPortfolioMonitorOutput(upstream(), at);
    expect(output.readOnly).toBe(true);
    expect(output.status).toMatchObject({
      gateway: "live",
      connected: true,
      dataAsOf: "2026-10-10T14:00:00.000Z",
      generatedAt: "2026-10-10T14:00:00.000Z",
      receivedAt: at.toISOString(),
      clientId: 78,
    });
    expect(output.account).toEqual({ mode: "live", count: 1 });
    expect(output.summary).toMatchObject({
      netLiquidation: 20_000,
      totalCashValue: 9000,
      buyingPower: null,
      cushion: 0.4,
    });
    const [stock, option] = output.positions;
    // Fresh per-position P&L (pnlT 5 s old) wins over account-update values.
    expect(stock).toMatchObject({
      id: "1001",
      description: "AAA",
      marketValue: 5500,
      last: 55,
      avgPrice: 50,
      costBasis: 5000,
      unrealized: 500,
      unrealizedPct: 10,
      dailyPnl: 25,
    });
    expect(stock?.weightPct).toBeCloseTo(27.5);
    // Options: price per share divides by the multiplier; no fresh P&L so account values are used.
    expect(option).toMatchObject({
      id: "2002",
      description: "BBB 20261120 40 C",
      marketValue: 700,
      last: 3.5,
      avgPrice: 3,
      costBasis: 600,
      unrealized: 100,
      dailyPnl: null,
    });
    return expect(option?.weightPct).toBeCloseTo(3.5);
  });

  it("ignores stale per-position P&L", () => {
    const output = toPortfolioMonitorOutput(
      upstream({ positions: [position({ pnlT: GENERATED - 601 })] }),
      at
    );
    return expect(output.positions[0]).toMatchObject({
      marketValue: 5400,
      unrealized: 400,
      last: 54,
    });
  });

  it("derives limit and stop prices and links children to parents by client and order id", () => {
    const output = toPortfolioMonitorOutput(upstream(), at);
    const byKey = Object.fromEntries(
      output.orders.map((entry) => [entry.key, entry])
    );
    expect(byKey["7:20:9020"]).toMatchObject({
      stopPrice: 45,
      limitPrice: null,
      parentKey: null,
      status: "PreSubmitted",
    });
    expect(byKey["7:21:9021"]).toMatchObject({
      stopPrice: 44,
      limitPrice: 43.5,
      parentKey: "7:20:9020",
    });
    expect(byKey["7:22:9022"]).toMatchObject({ stopPrice: 47.25, trailPct: 5 });
    expect(output.completed[0]).toMatchObject({
      status: "Cancelled",
      completedStatus: "Cancelled by user",
    });
    return expect(output.executions.map((entry) => entry.execId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("removes account codes from every text field", () => {
    const output = toPortfolioMonitorOutput(
      upstream({ lastError: `lost ${FAKE_ACCOUNT}` }),
      at
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(FAKE_ACCOUNT);
    expect(serialized).toContain("[account]");
    return expect(
      scrubPortfolioText(`DU${"1234567"} and F${"9876543"}`, 80)
    ).toBe("[account] and [account]");
  });

  it("reports an unknown position state honestly while the gateway is down", () => {
    const output = toPortfolioMonitorOutput(
      upstream({
        state: "disconnected",
        connected: false,
        positions: [],
        dataAsOf: null,
        lastError: "gateway connection closed",
      }),
      at
    );
    expect(output.status).toMatchObject({
      gateway: "disconnected",
      connected: false,
      dataAsOf: null,
      lastError: "gateway connection closed",
    });
    return expect(output.positions).toEqual([]);
  });

  it("rejects schema drift, other client ids and unknown summary tags", () => {
    for (const drift of [
      { clientId: 77 },
      { schema: "vertex-portfolio-snapshot-v2" },
      { summary: { AccountCode: 1 } },
      { positions: [{ ...position(), account: FAKE_ACCOUNT }] },
    ]) {
      expect(() => toPortfolioMonitorOutput(upstream(drift), at)).toThrow(
        PortfolioMonitorError
      );
    }
  });

  return it("accepts the snapshot produced by the VPS service test fixtures (cross-language contract)", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../infra/quant-vps/portfolio/fixtures/sample-snapshot.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as unknown;
    const output = toPortfolioMonitorOutput(fixture, at);
    expect(output.status.clientId).toBe(78);
    expect(output.positions.length).toBeGreaterThan(0);
    expect(output.orders.length).toBeGreaterThan(0);
    return expect(JSON.stringify(output)).not.toMatch(
      /\b(?:D?U|DF|F|I)\d{4,}\b/
    );
  });
});

describe("portfolioMonitor fetch", () => {
  it("sends a bearer GET with manual redirects to the snapshot path", async () => {
    const doFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(upstream())
    );
    const output = await fetchPortfolioMonitor(config, {
      fetch: doFetch,
      now: () => at,
    });
    expect(buildPortfolioSnapshotUrl(`${BASE}/`)).toBe(`${BASE}/snapshot`);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBe(`${BASE}/snapshot`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    return expect(output.positions).toHaveLength(2);
  });

  it("maps failures to typed codes without leaking the token or URL", async () => {
    const cases: [Response, string][] = [
      [jsonResponse({ error: "unavailable" }, { status: 503 }), "UNAVAILABLE"],
      [Response.redirect("https://elsewhere.test", 302), "UPSTREAM_ERROR"],
      [
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        "UPSTREAM_ERROR",
      ],
      [jsonResponse({ schema: "other" }), "UPSTREAM_ERROR"],
      [
        new Response("x".repeat(64), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "UPSTREAM_ERROR",
      ],
    ];
    for (const [response, code] of cases) {
      const failure = (await fetchPortfolioMonitor(config, {
        fetch: async () => response,
        maxBytes: 32,
      }).catch((error: unknown) => error)) as PortfolioMonitorError;
      expect(failure).toBeInstanceOf(PortfolioMonitorError);
      expect(failure.code).toBe(code);
      expect(failure.message).not.toContain(TOKEN);
      expect(failure.message).not.toContain("tailnet.test");
    }
  });

  return it("times out and refuses to run unconfigured", async () => {
    const hang = (_input: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        return init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    };
    const failure = (await fetchPortfolioMonitor(config, {
      fetch: hang,
      timeoutMs: 5,
    }).catch((error: unknown) => error)) as PortfolioMonitorError;
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "Portfolio request timed out",
    ]);
    const doFetch = vi.fn();
    const missing = (await fetchPortfolioMonitor(null, {
      fetch: doFetch,
    }).catch((error: unknown) => error)) as PortfolioMonitorError;
    expect(missing.code).toBe("NOT_CONFIGURED");
    return expect(doFetch).not.toHaveBeenCalled();
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
    expiresAt: new Date("2026-10-11T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  portfolioMonitor: DeployStatusConfig | null
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
      portfolioMonitor,
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

describe("portfolioMonitor.snapshot procedure", () => {
  it("is operator-only and never calls upstream for denied callers", async () => {
    const doFetch = vi.fn(async () => jsonResponse(upstream()));
    setPortfolioMonitorFetchOptionsForTesting({
      fetch: doFetch,
      now: () => at,
    });
    await expectCode(
      clientFor(null, config).portfolioMonitor.snapshot({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), config).portfolioMonitor.snapshot({}),
      "FORBIDDEN",
      403
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns the derived snapshot to operators and typed errors otherwise", async () => {
    setPortfolioMonitorFetchOptionsForTesting({
      fetch: async () => jsonResponse(upstream()),
      now: () => at,
    });
    const output = await clientFor(
      session("operator"),
      config
    ).portfolioMonitor.snapshot({});
    expect(output.positions).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
    await expectCode(
      clientFor(session("operator"), null).portfolioMonitor.snapshot({}),
      "NOT_CONFIGURED",
      503
    );
    setPortfolioMonitorFetchOptionsForTesting({
      fetch: async () =>
        jsonResponse({ error: "unavailable" }, { status: 503 }),
      now: () => at,
    });
    return await expectCode(
      clientFor(session("operator"), config).portfolioMonitor.snapshot({}),
      "UNAVAILABLE",
      503
    );
  });

  return it("is not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("portfolioMonitor");
    expect(AGENT_API_KEY_READ_PROCEDURES.has("portfolioMonitor.snapshot")).toBe(
      false
    );
    return expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("portfolioMonitor"))
    ).toBe(false);
  });
});

describe("portfolioMonitor edge cases", () => {
  it("falls back to account values and symbols when fresh data is missing", () => {
    const output = toPortfolioMonitorOutput(
      upstream({
        summary: { TotalCashValue: 1 },
        orders: [
          order({ orderId: 0, parentId: 0 }),
          order({ key: "7:12:9012", orderId: 12, parentId: 99 }),
          order({
            key: "7:13:9013",
            orderId: 13,
            orderType: "TRAIL",
            trailStop: null,
            aux: 3,
          }),
        ],
        positions: [
          position({
            conId: 3003,
            localSymbol: "",
            symbol: "CCC",
            position: 0,
            avgCost: null,
            pnlValue: null,
            acctMarketValue: null,
            acctMarketPrice: 12,
            pnlUnrealized: null,
            acctUnrealized: null,
          }),
          position({ conId: 4004, avgCost: 0, pnlValue: 10 }),
        ],
      }),
      at
    );
    const flat = output.positions.find((row) => row.id === "3003");
    expect(flat).toMatchObject({
      description: "CCC",
      last: 12,
      avgPrice: null,
      marketValue: null,
      costBasis: null,
      unrealizedPct: null,
      weightPct: null,
    });
    expect(output.positions.find((row) => row.id === "4004")).toMatchObject({
      costBasis: 0,
      unrealizedPct: null,
      weightPct: null,
    });
    expect(output.orders.map((row) => row.parentKey)).toEqual([
      null,
      null,
      null,
    ]);
    expect(output.orders[2]?.stopPrice).toBe(3);
  });

  it("caps, rejects and decodes response bodies", async () => {
    const fail = (message: string) => new Error(message);
    await expect(
      readCappedText(
        new Response("abc", { headers: { "content-length": "99" } }),
        8,
        fail
      )
    ).rejects.toThrow("size cap");
    expect(await readCappedText(new Response(null), 8, fail)).toBe("");
    await expect(
      readCappedText(new Response(new Uint8Array([0xff, 0xfe])), 8, fail)
    ).rejects.toThrow("UTF-8");
    const stubborn = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(16)),
      cancel: () => {
        throw new Error("cancel failed");
      },
    });
    await expect(
      readCappedText(new Response(stubborn), 8, fail)
    ).rejects.toThrow("size cap");
  });

  it("maps transport, content type, body and JSON failures", async () => {
    const run = (
      fetch: (input: string, init: RequestInit) => Promise<Response>,
      timeoutMs = 1000
    ) =>
      fetchPortfolioMonitor(config, { fetch, timeoutMs, now: () => at }).catch(
        (error: unknown) => error
      );
    expect(
      await run(async () => {
        throw new Error("socket closed");
      })
    ).toMatchObject({
      code: "UNAVAILABLE",
      message: "Portfolio request failed",
    });
    expect(
      await run(async () => new Response(null, { status: 200 }))
    ).toMatchObject({ code: "UPSTREAM_ERROR" });
    const broken = () =>
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.error(new Error("reset")),
      });
    expect(
      await run(
        async () =>
          new Response(broken(), {
            headers: { "content-type": "application/json" },
          })
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Portfolio response could not be read",
    });
    expect(
      await run(
        async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) =>
                init.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted"))
                ),
            }),
            { headers: { "content-type": "application/json" } }
          ),
        5
      )
    ).toMatchObject({
      code: "UNAVAILABLE",
      message: "Portfolio request timed out",
    });
    expect(
      await run(
        async () =>
          new Response("{", { headers: { "content-type": "application/json" } })
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Portfolio response is not valid JSON",
    });
  });

  it("uses the global fetch by default", async () => {
    const globalFetch = vi.fn(async () => jsonResponse(upstream()));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const output = await fetchPortfolioMonitor(config, { now: () => at });
      expect(output.positions).toHaveLength(2);
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps unexpected procedure failures to UPSTREAM_ERROR", async () => {
    setPortfolioMonitorFetchOptionsForTesting({
      fetch: async () => jsonResponse(upstream()),
      now: () => {
        throw new Error("clock failed");
      },
    });
    await expectCode(
      clientFor(session("operator"), config).portfolioMonitor.snapshot({}),
      "UPSTREAM_ERROR",
      502
    );
  });
});
