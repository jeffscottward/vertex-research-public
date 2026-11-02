import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  MarketBarsInputSchema,
  marketDurationAllowed,
} from "./contracts/market-data.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import {
  MARKET_HISTORY_MAX_BYTES,
  MARKET_HISTORY_TIMEOUT_MS,
  MarketDataError,
  buildMarketBarsUrl,
  fetchMarketBars,
  resolveMarketHistoryConfig,
  setMarketDataFetchOptionsForTesting,
} from "./server/market-data.ts";
import { MCP_TOOLS, callMcpTool, presentMarketBars } from "./server/mcp.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";

const at = new Date("2026-10-04T02:20:00.000Z");
const TOKEN = "h".repeat(43);
const BASE = "https://quantvps.tailnet.test:8443/vertex-history/v1";
const config: DeployStatusConfig = { url: BASE, token: TOKEN };

const upstream = (overrides: Record<string, unknown> = {}) => ({
  schema: "vertex-history-bars-v1",
  source: "ibkr-gateway",
  client_id: 77,
  request: {
    symbol: "SPY",
    secType: "STK",
    exchange: "SMART",
    currency: "USD",
    barSize: "1 day",
    duration: "1 Y",
    whatToShow: "TRADES",
    useRTH: true,
    contractMonth: null,
  },
  contract: {
    conId: 756_733,
    secType: "STK",
    localSymbol: "SPY",
    exchange: "SMART",
    currency: "USD",
    lastTradeDateOrContractMonth: null,
    multiplier: null,
    longName: "SS SPDR S&P 500 ETF TRUST-US",
    timeZoneId: "US/Eastern",
    matches: 1,
  },
  bars: [
    { t: 1_790_812_800, o: 765.1, h: 771, l: 764, c: 770.55, v: 1_200_000 },
    {
      t: 1_790_899_200,
      o: 770.55,
      h: 772.65,
      l: 767.14,
      c: 769.64,
      v: 1_215_266,
    },
  ],
  count: 2,
  fetched_at: "2026-10-04T02:16:59Z",
  as_of: "2026-10-02T00:00:00Z",
  cache: { hit: true, age_seconds: 181, ttl_seconds: 3600, stale: false },
  ...overrides,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
};

const input = (overrides: Record<string, unknown> = {}) =>
  MarketBarsInputSchema.parse({ symbol: "spy", ...overrides });

afterEach(() => setMarketDataFetchOptionsForTesting({}));

describe("marketData input", () =>
  it("applies defaults and enforces duration caps per bar size", () => {
    expect(input()).toMatchObject({
      symbol: "spy",
      secType: "STK",
      currency: "USD",
      barSize: "1 day",
      duration: "1 Y",
      whatToShow: "TRADES",
      useRTH: true,
    });
    expect(marketDurationAllowed("1 day", "1 Y")).toBe(true);
    expect(marketDurationAllowed("1 day", "2 Y")).toBe(false);
    expect(marketDurationAllowed("5 mins", "1 M")).toBe(true);
    expect(marketDurationAllowed("5 mins", "2 M")).toBe(false);
    expect(marketDurationAllowed("1 min", "2 D")).toBe(true);
    expect(marketDurationAllowed("1 min", "1 W")).toBe(false);
    expect(
      MarketBarsInputSchema.safeParse({ symbol: "ES", secType: "CONTFUT" })
        .success
    ).toBe(false);
    expect(
      MarketBarsInputSchema.safeParse({
        symbol: "ES",
        secType: "CONTFUT",
        exchange: "CME",
      }).success
    ).toBe(true);
    expect(
      MarketBarsInputSchema.safeParse({
        symbol: "SPY",
        contractMonth: "202612",
      }).success
    ).toBe(false);
    expect(
      MarketBarsInputSchema.safeParse({ symbol: "SPY", account: "x" }).success
    ).toBe(false);
    return expect(
      MarketBarsInputSchema.safeParse({ symbol: "SPY;rm" }).success
    ).toBe(false);
  }));

describe("marketData config and URL", () => {
  it("requires an https base URL without credentials and a 32+ character token", () => {
    expect(resolveMarketHistoryConfig(BASE, TOKEN)).toEqual({
      url: BASE,
      token: TOKEN,
    });
    expect(resolveMarketHistoryConfig(undefined, TOKEN)).toBeNull();
    expect(
      resolveMarketHistoryConfig(
        "http://127.0.0.1:8791/vertex-history/v1",
        TOKEN
      )
    ).not.toBeNull();
    expect(
      resolveMarketHistoryConfig(
        "http://quantvps.tailnet.test/vertex-history/v1",
        TOKEN
      )
    ).toBeNull();
    return expect(resolveMarketHistoryConfig(BASE, "short")).toBeNull();
  });

  it("builds the bars URL with normalized parameters", () => {
    expect(buildMarketBarsUrl(`${BASE}/`, input())).toBe(
      `${BASE}/bars?symbol=SPY&secType=STK&exchange=SMART&currency=USD&barSize=1+day&duration=1+Y&whatToShow=TRADES&useRTH=1`
    );
    return expect(
      buildMarketBarsUrl(
        BASE,
        input({
          symbol: "es",
          secType: "FUT",
          exchange: "cme",
          contractMonth: "202612",
          useRTH: false,
          barSize: "5 mins",
          duration: "1 M",
        })
      )
    ).toBe(
      `${BASE}/bars?symbol=ES&secType=FUT&exchange=CME&currency=USD&barSize=5+mins&duration=1+M&whatToShow=TRADES&useRTH=0&contractMonth=202612`
    );
  });
});

describe("marketData fetch", () => {
  it("sends a bearer GET with manual redirects and maps the document", async () => {
    const doFetch = vi.fn(async () => jsonResponse(upstream()));
    const output = await fetchMarketBars(config, input(), {
      fetch: doFetch,
      now: () => at,
    });
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(buildMarketBarsUrl(BASE, input()));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`
    );
    expect(output).toMatchObject({
      source: "ibkr-gateway",
      count: 2,
      fetchedAt: "2026-10-04T02:16:59Z",
      asOf: "2026-10-02T00:00:00Z",
      cache: { hit: true, ageSeconds: 181, ttlSeconds: 3600, stale: false },
      receivedAt: at.toISOString(),
      contract: { conId: 756_733, localSymbol: "SPY" },
    });
    expect(output.bars[1]).toEqual({
      t: 1_790_899_200,
      o: 770.55,
      h: 772.65,
      l: 767.14,
      c: 769.64,
      v: 1_215_266,
    });
    expect(MARKET_HISTORY_TIMEOUT_MS).toBe(30_000);
    return expect(MARKET_HISTORY_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("refuses redirects, non-JSON, oversize bodies and schema drift without leaking the token", async () => {
    const cases: Array<() => Response> = [
      () => Response.redirect("https://elsewhere.test/", 302),
      () =>
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      () =>
        new Response("x".repeat(MARKET_HISTORY_MAX_BYTES + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => jsonResponse(upstream({ client_id: 78 })),
      () => jsonResponse(upstream({ extra: true })),
      () => jsonResponse(upstream({ count: 3 })),
      () =>
        jsonResponse(
          upstream({
            bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, account: "U1" }],
            count: 1,
          })
        ),
    ];

    for (const make of cases) {
      const failure = await fetchMarketBars(config, input(), {
        fetch: async () => make(),
        now: () => at,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MarketDataError);
      expect((failure as MarketDataError).code).toBe("UPSTREAM_ERROR");
      expect(String((failure as Error).message)).not.toContain(TOKEN);
    }
  });

  it("maps service errors to typed codes with honest messages", async () => {
    const run = async (response: Response) => {
      return (await fetchMarketBars(config, input(), {
        fetch: async () => response,
        now: () => at,
      }).catch((error: unknown) => error)) as MarketDataError;
    };
    let failure = await run(
      jsonResponse({ error: "paced", retry_after_seconds: 61 }, { status: 429 })
    );
    expect([failure.code, failure.message]).toEqual([
      "PACED",
      "IBKR history pacing: retry in 61 s",
    ]);
    failure = await run(
      jsonResponse(
        {
          error: "entitlement",
          message: "No market data permissions for CME FUT U1234567",
          ibkr_code: 162,
        },
        { status: 502 }
      )
    );
    expect([failure.code, failure.message]).toEqual([
      "ENTITLEMENT",
      "IBKR 162: No market data permissions for CME FUT [account]",
    ]);
    failure = await run(
      jsonResponse(
        {
          error: "no_contract",
          message: "No security definition",
          ibkr_code: 200,
        },
        { status: 422 }
      )
    );
    expect(failure.code).toBe("NOT_FOUND");
    failure = await run(
      jsonResponse(
        { error: "unavailable", message: "gateway API not reachable" },
        { status: 503 }
      )
    );
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "gateway API not reachable",
    ]);
    failure = await run(new Response("unauthorized", { status: 401 }));
    return expect([failure.code, failure.message]).toEqual([
      "UPSTREAM_ERROR",
      "History endpoint returned HTTP 401",
    ]);
  });

  it("times out and refuses to run unconfigured", async () => {
    const hang = (_input: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        return init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    };
    const failure = (await fetchMarketBars(config, input(), {
      fetch: hang,
      timeoutMs: 5,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "History request timed out",
    ]);
    const doFetch = vi.fn();
    const missing = (await fetchMarketBars(null, input(), {
      fetch: doFetch,
    }).catch((error: unknown) => error)) as MarketDataError;
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
    expiresAt: new Date("2026-10-05T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  marketHistory: DeployStatusConfig | null
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
      marketHistory,
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

describe("marketData.bars procedure", () => {
  it("is operator-only and never calls upstream for denied callers or invalid input", async () => {
    const doFetch = vi.fn(async () => jsonResponse(upstream()));
    setMarketDataFetchOptionsForTesting({ fetch: doFetch, now: () => at });
    await expectCode(
      clientFor(null, config).marketData.bars({ symbol: "SPY" }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), config).marketData.bars({ symbol: "SPY" }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(session("operator"), config).marketData.bars({
        symbol: "SPY",
        duration: "2 Y",
      }),
      "BAD_REQUEST",
      400
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns bars to operators and typed errors otherwise", async () => {
    setMarketDataFetchOptionsForTesting({
      fetch: async () => jsonResponse(upstream()),
      now: () => at,
    });
    const output = await clientFor(session("operator"), config).marketData.bars(
      { symbol: "SPY" }
    );
    expect(output.count).toBe(2);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
    await expectCode(
      clientFor(session("operator"), null).marketData.bars({ symbol: "SPY" }),
      "NOT_CONFIGURED",
      503
    );
    setMarketDataFetchOptionsForTesting({
      fetch: async () =>
        jsonResponse(
          { error: "paced", retry_after_seconds: 9 },
          { status: 429 }
        ),
      now: () => at,
    });
    await expectCode(
      clientFor(session("operator"), config).marketData.bars({ symbol: "SPY" }),
      "PACED",
      429
    );
    setMarketDataFetchOptionsForTesting({
      fetch: async () =>
        jsonResponse(
          {
            error: "entitlement",
            message: "No market data permissions",
            ibkr_code: 354,
          },
          { status: 502 }
        ),
      now: () => at,
    });
    return await expectCode(
      clientFor(session("operator"), config).marketData.bars({
        symbol: "ES",
        secType: "CONTFUT",
        exchange: "CME",
      }),
      "ENTITLEMENT",
      502
    );
  });

  it("is readable with read-access agent keys", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).toContain("marketData");
    return expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.bars")).toBe(
      true
    );
  });
});

describe("market_bars MCP tool", () =>
  it("is read-only, forwards to marketData/bars and keeps only the last bars", async () => {
    const tool = MCP_TOOLS.find((entry) => entry.name === "market_bars");
    expect(tool?.readOnly).toBe(true);
    const call = vi.fn(async () => ({
      ok: true as const,
      value: { ...upstream(), bars: upstream().bars },
    }));
    const result = await callMcpTool(
      "market_bars",
      { symbol: "SPY", lastBars: 1 },
      call
    );
    expect(call).toHaveBeenCalledWith("marketData/bars", { symbol: "SPY" });
    expect(result["isError"]).toBe(false);
    const presented = presentMarketBars(
      { count: 2, bars: [{ t: 1 }, { t: 2 }] },
      1
    );
    return expect(presented).toEqual({
      count: 2,
      bars: [{ t: 2 }],
      barsOmitted: 1,
    });
  }));
