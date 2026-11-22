import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApiClient } from "./client.ts";
import {
  MARKET_DATA_ERRORS,
  MarketBarsInputSchema,
  MarketDepthInputSchema,
  MarketTicksInputSchema,
  marketDurationAllowed,
} from "./contracts/market-data.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import {
  buildMarketBarsUrl,
  buildMarketDepthUrl,
  buildMarketTapeUrl,
  buildMarketTicksUrl,
  fetchMarketBars,
  fetchMarketDepth,
  fetchMarketHistoryPacing,
  fetchMarketTape,
  fetchMarketTicks,
  MARKET_DEPTH_TIMEOUT_MS,
  MARKET_HISTORY_HEALTH_TIMEOUT_MS,
  MARKET_HISTORY_MAX_BYTES,
  MARKET_HISTORY_TIMEOUT_MS,
  MARKET_TAPE_ERROR_MAX,
  MARKET_TAPE_TIMEOUT_MS,
  MARKET_TICKS_TIMEOUT_MS,
  MarketDataError,
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
  schema: "vertex-history-bars-v2",
  volume_unit: "shares",
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

  it("rejects forex (CASH) bars; the web/API side does not expose it", () =>
    expect(
      MarketBarsInputSchema.safeParse({
        symbol: "EUR",
        secType: "CASH",
        exchange: "IDEALPRO",
      }).success
    ).toBe(false));
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

  it("reads bars v1: stock volume null (no fixed unit under ibapi 9.81), futures volume as sent", async () => {
    const { volume_unit: _unit, ...v1 } = upstream({
      schema: "vertex-history-bars-v1",
    });
    const stock = await fetchMarketBars(config, input(), {
      fetch: async () => jsonResponse(v1),
      now: () => at,
    });
    expect(stock.bars.map((bar) => bar.v)).toEqual([null, null]);
    expect(stock.bars[1]).toMatchObject({ t: 1_790_899_200, c: 769.64 });
    const futures = await fetchMarketBars(config, input(), {
      fetch: async () =>
        jsonResponse({
          ...v1,
          request: { ...v1.request, secType: "CONTFUT", exchange: "CME" },
        }),
      now: () => at,
    });
    expect(futures.bars.map((bar) => bar.v)).toEqual([1_200_000, 1_215_266]);
  });

  it("reads bars v2: volume as sent for shares and contracts, null for an unqualified unit", async () => {
    const shares = await fetchMarketBars(config, input(), {
      fetch: async () => jsonResponse(upstream()),
      now: () => at,
    });
    expect(shares.bars.map((bar) => bar.v)).toEqual([1_200_000, 1_215_266]);
    const unqualified = await fetchMarketBars(config, input(), {
      fetch: async () => jsonResponse(upstream({ volume_unit: "unqualified" })),
      now: () => at,
    });
    expect(unqualified.bars.map((bar) => bar.v)).toEqual([null, null]);
    const missingUnit = await fetchMarketBars(config, input(), {
      fetch: async () => {
        const { volume_unit: _unit, ...body } = upstream();
        return jsonResponse(body);
      },
      now: () => at,
    }).catch((error: unknown) => error);
    expect(missingUnit).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("reads the shared sample answers as expected.json says for charts", async () => {
    const fixtures = new URL("./fixtures/history-answers/", import.meta.url);
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
    const expected = z
      .object({
        cases: z.record(
          z.string(),
          z.object({
            charts: z.object({
              accepted: z.boolean(),
              volumes: z.array(z.number().nullable()).optional(),
            }),
          })
        ),
      })
      .parse(read("expected.json"));
    // /charts can only ask for STK, FUT and CONTFUT (its request echo refuses IND and CASH); the parser
    // itself is checked against every sample in server/history-answer.test.ts.
    const charts = readdirSync(fixtures).filter(
      (name) => name.startsWith("bars-") && !/-(ind|cash)\.json$/.test(name)
    );
    expect(charts.length).toBe(Object.keys(expected.cases).length - 2);
    for (const file of charts) {
      const want = expected.cases[file.replace(/\.json$/, "")]?.charts;
      expect(want?.accepted, file).toBe(true);
      const output = await fetchMarketBars(config, input(), {
        fetch: async () => jsonResponse(read(file)),
        now: () => at,
      });
      expect(
        output.bars.map((bar) => bar.v),
        file
      ).toEqual(want?.volumes);
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
    // The same account codes as every other IBKR reader: DF codes and four digits too.
    failure = await run(
      jsonResponse(
        {
          error: "entitlement",
          message: "No market data permissions for DF0000003 and U0001",
          ibkr_code: 162,
        },
        { status: 502 }
      )
    );
    expect(failure.message).toBe(
      "IBKR 162: No market data permissions for [account] and [account]"
    );
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
    expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.bars")).toBe(true);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.ticks")).toBe(true);
    // a depth snapshot holds the one IBKR depth slot; read keys may not take it
    return expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.depth")).toBe(
      false
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

// ---------------------------------------------------------------------------
// Order flow: historical ticks and one-shot depth (vertex-history-ticks-v1 / -depth-v1).

const contractFixture = upstream().contract;

const ticksUpstream = (overrides: Record<string, unknown> = {}) => ({
  asOf: "2026-10-02T00:00:01Z",
  cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 15 },
  client_id: 77,
  contract: contractFixture,
  fetchedAt: "2026-10-04T02:16:59Z",
  minTick: 0.01,
  quotes: [{ ap: 769.61, as: 4, bp: 769.59, bs: 3, t: 1_790_899_200 }],
  request: {
    contractMonth: null,
    count: 500,
    currency: "USD",
    exchange: "SMART",
    quotes: true,
    secType: "STK",
    symbol: "SPY",
    useRTH: false,
  },
  schema: "vertex-history-ticks-v1",
  source: "ibkr-gateway",
  trades: [
    { c: null, p: 769.6, s: 100, t: 1_790_899_200, x: "ARCA" },
    { c: "T I", p: 769.62, s: 25, t: 1_790_899_201, x: null },
  ],
  ...overrides,
});

const depthUpstream = (overrides: Record<string, unknown> = {}) => ({
  asks: [{ price: 769.61, size: 4, venue: "NSDQ" }],
  bids: [{ price: 769.59, size: 3, venue: "ARCA" }],
  cache: { ageSeconds: 2, hit: true, stale: false, ttlSeconds: 5 },
  client_id: 77,
  contract: contractFixture,
  fetchedAt: "2026-10-04T02:16:59Z",
  minTick: 0.01,
  request: {
    contractMonth: null,
    currency: "USD",
    exchange: "SMART",
    rows: 10,
    secType: "STK",
    smartDepth: true,
    symbol: "SPY",
  },
  schema: "vertex-history-depth-v1",
  sizeMultiplier: 100,
  source: "ibkr-gateway",
  updates: 42,
  venues: { depth: ["ARCA", "NSDQ"], missing: ["ISLAND"], top: ["BYX"] },
  ...overrides,
});

const ticksInput = (overrides: Record<string, unknown> = {}) =>
  MarketTicksInputSchema.parse({ symbol: "spy", ...overrides });
const depthInput = (overrides: Record<string, unknown> = {}) =>
  MarketDepthInputSchema.parse({ symbol: "spy", ...overrides });

describe("marketData ticks and depth input", () => {
  it("applies tick defaults and bounds the count", () => {
    expect(ticksInput()).toMatchObject({
      count: 500,
      currency: "USD",
      quotes: true,
      secType: "STK",
      symbol: "spy",
      useRTH: false,
    });
    for (const count of [50, 1000])
      expect(ticksInput({ count }).count).toBe(count);
    for (const count of [49, 1001, 0, 50.5, "500"])
      expect(
        MarketTicksInputSchema.safeParse({ count, symbol: "SPY" }).success
      ).toBe(false);
    return expect(
      MarketTicksInputSchema.safeParse({ rows: 5, symbol: "SPY" }).success
    ).toBe(false);
  });

  it("rejects forex (CASH) for ticks and depth", () => {
    for (const schema of [MarketTicksInputSchema, MarketDepthInputSchema])
      expect(
        schema.safeParse({
          secType: "CASH",
          exchange: "IDEALPRO",
          symbol: "EUR",
        }).success
      ).toBe(false);
  });

  it("needs an exchange for futures and allows a contract month for FUT only", () => {
    for (const schema of [MarketTicksInputSchema, MarketDepthInputSchema]) {
      expect(schema.safeParse({ secType: "FUT", symbol: "ES" }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ secType: "CONTFUT", symbol: "ES" }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          contractMonth: "202612",
          exchange: "CME",
          secType: "FUT",
          symbol: "ES",
        }).success
      ).toBe(true);
      expect(
        schema.safeParse({ contractMonth: "202612", symbol: "SPY" }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          contractMonth: "202612",
          exchange: "CME",
          secType: "CONTFUT",
          symbol: "ES",
        }).success
      ).toBe(false);
    }
    return expect(
      MarketTicksInputSchema.safeParse({ symbol: "SPY;rm" }).success
    ).toBe(false);
  });

  it("bounds the depth rows", () => {
    expect(depthInput().rows).toBe(10);
    for (const rows of [1, 20]) expect(depthInput({ rows }).rows).toBe(rows);
    for (const rows of [0, 21, 2.5])
      expect(
        MarketDepthInputSchema.safeParse({ rows, symbol: "SPY" }).success
      ).toBe(false);
    return expect(
      MarketDepthInputSchema.safeParse({ count: 50, symbol: "SPY" }).success
    ).toBe(false);
  });
});

describe("marketData ticks and depth URLs", () => {
  it("builds the ticks URL with normalized parameters", () => {
    expect(buildMarketTicksUrl(`${BASE}/`, ticksInput())).toBe(
      `${BASE}/ticks?symbol=SPY&secType=STK&exchange=SMART&currency=USD&count=500&useRTH=0&quotes=1`
    );
    return expect(
      buildMarketTicksUrl(
        BASE,
        ticksInput({
          contractMonth: "202612",
          count: 1000,
          exchange: "cme",
          quotes: false,
          secType: "FUT",
          symbol: "es",
          useRTH: true,
        })
      )
    ).toBe(
      `${BASE}/ticks?symbol=ES&secType=FUT&exchange=CME&currency=USD&count=1000&useRTH=1&quotes=0&contractMonth=202612`
    );
  });

  it("builds the depth URL: SMART for stocks, the given exchange for futures", () => {
    expect(buildMarketDepthUrl(BASE, depthInput({ exchange: "arca" }))).toBe(
      `${BASE}/depth?symbol=SPY&secType=STK&exchange=SMART&currency=USD&rows=10`
    );
    return expect(
      buildMarketDepthUrl(
        BASE,
        depthInput({
          exchange: "cme",
          rows: 20,
          secType: "CONTFUT",
          symbol: "nq",
        })
      )
    ).toBe(
      `${BASE}/depth?symbol=NQ&secType=CONTFUT&exchange=CME&currency=USD&rows=20`
    );
  });
});

describe("marketData ticks and depth fetch", () => {
  it("sends a bearer GET for ticks and passes the document through", async () => {
    const doFetch = vi.fn(async () => jsonResponse(ticksUpstream()));
    const output = await fetchMarketTicks(config, ticksInput(), {
      fetch: doFetch,
      now: () => at,
    });
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(buildMarketTicksUrl(BASE, ticksInput()));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`
    );
    const {
      schema: _schema,
      client_id: _clientId,
      ...passThrough
    } = ticksUpstream();
    expect(output).toEqual({ ...passThrough, receivedAt: at.toISOString() });
    // the service budget is 35 s; the tailnet Caddy gives up at 45 s
    expect(MARKET_TICKS_TIMEOUT_MS).toBe(40_000);
    return expect(MARKET_TICKS_TIMEOUT_MS).toBeGreaterThan(
      MARKET_HISTORY_TIMEOUT_MS
    );
  });

  it("sends a bearer GET for depth and passes the document through", async () => {
    const doFetch = vi.fn(async () => jsonResponse(depthUpstream()));
    const output = await fetchMarketDepth(config, depthInput(), {
      fetch: doFetch,
      now: () => at,
    });
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `${BASE}/depth?symbol=SPY&secType=STK&exchange=SMART&currency=USD&rows=10`
    );
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`
    );
    expect(output).toMatchObject({
      bids: [{ price: 769.59, size: 3, venue: "ARCA" }],
      cache: { ageSeconds: 2, hit: true, stale: false, ttlSeconds: 5 },
      minTick: 0.01,
      receivedAt: at.toISOString(),
      sizeMultiplier: 100,
      updates: 42,
      venues: { missing: ["ISLAND"] },
    });
    expect(output).not.toHaveProperty("schema");
    expect(output).not.toHaveProperty("client_id");
    const nullVenues = await fetchMarketDepth(config, depthInput(), {
      fetch: async () => jsonResponse(depthUpstream({ venues: null })),
      now: () => at,
    });
    expect(nullVenues.venues).toBeNull();
    const noTick = await fetchMarketDepth(config, depthInput(), {
      fetch: async () => jsonResponse(depthUpstream({ minTick: null })),
      now: () => at,
    });
    expect(noTick.minTick).toBeNull();
    // the service budget is 25 s; the tailnet Caddy gives up at 45 s
    return expect(MARKET_DEPTH_TIMEOUT_MS).toBe(35_000);
  });

  it("refuses schema drift in tick and depth documents", async () => {
    const tickCases = [
      ticksUpstream({ schema: "vertex-history-bars-v1" }),
      ticksUpstream({ client_id: 78 }),
      ticksUpstream({ extra: true }),
      ticksUpstream({ fetched_at: "2026-10-04T02:16:59Z" }),
      ticksUpstream({
        cache: { age_seconds: 1, hit: true, stale: false, ttl_seconds: 15 },
      }),
      ticksUpstream({
        trades: [{ account: "U1", c: null, p: 1, s: 1, t: 1, x: null }],
      }),
      ticksUpstream({
        trades: Array.from({ length: 1001 }, (_, t) => ({
          c: null,
          p: 1,
          s: 1,
          t,
          x: null,
        })),
      }),
      ticksUpstream({ fetchedAt: "yesterday" }),
      ticksUpstream({ minTick: 0 }),
      ticksUpstream({ minTick: undefined }),
    ];
    for (const body of tickCases) {
      const failure = (await fetchMarketTicks(config, ticksInput(), {
        fetch: async () => jsonResponse(body),
        now: () => at,
      }).catch((error: unknown) => error)) as MarketDataError;
      expect(failure).toBeInstanceOf(MarketDataError);
      expect(failure.code).toBe("UPSTREAM_ERROR");
    }
    const depthCases = [
      depthUpstream({ schema: "vertex-history-ticks-v1" }),
      depthUpstream({ sizeMultiplier: 0 }),
      depthUpstream({ minTick: -0.01 }),
      depthUpstream({
        bids: Array.from({ length: 21 }, () => ({
          price: 1,
          size: 1,
          venue: null,
        })),
      }),
      depthUpstream({ venues: { depth: [], top: [] } }),
      depthUpstream({ asOf: null }),
    ];
    for (const body of depthCases) {
      const failure = (await fetchMarketDepth(config, depthInput(), {
        fetch: async () => jsonResponse(body),
        now: () => at,
      }).catch((error: unknown) => error)) as MarketDataError;
      expect(failure).toBeInstanceOf(MarketDataError);
      expect(failure.code).toBe("UPSTREAM_ERROR");
      expect(failure.message).not.toContain(TOKEN);
    }
  });

  it("maps service errors like bars, including entitlement", async () => {
    const ticks = async (response: Response) =>
      (await fetchMarketTicks(config, ticksInput(), {
        fetch: async () => response,
        now: () => at,
      }).catch((error: unknown) => error)) as MarketDataError;
    const depth = async (response: Response) =>
      (await fetchMarketDepth(config, depthInput(), {
        fetch: async () => response,
        now: () => at,
      }).catch((error: unknown) => error)) as MarketDataError;
    let failure = await ticks(
      jsonResponse(
        {
          error: "entitlement",
          ibkr_code: 10_089,
          message: "Requested market data requires additional subscription",
        },
        { status: 502 }
      )
    );
    expect([failure.code, failure.message]).toEqual([
      "ENTITLEMENT",
      "IBKR 10089: Requested market data requires additional subscription",
    ]);
    failure = await depth(
      jsonResponse(
        {
          error: "entitlement",
          ibkr_code: 10_092,
          message: "Deep market data is not supported U1234567",
        },
        { status: 502 }
      )
    );
    expect([failure.code, failure.message]).toEqual([
      "ENTITLEMENT",
      "IBKR 10092: Deep market data is not supported [account]",
    ]);
    failure = await depth(
      jsonResponse({ error: "paced", retry_after_seconds: 3 }, { status: 429 })
    );
    expect([failure.code, failure.message]).toEqual([
      "PACED",
      "IBKR history pacing: retry in 3 s",
    ]);
    failure = await ticks(
      jsonResponse(
        { error: "no_contract", message: "No security definition" },
        { status: 422 }
      )
    );
    expect(failure.code).toBe("NOT_FOUND");
    failure = await depth(
      jsonResponse({ error: "timeout", message: "slow" }, { status: 504 })
    );
    expect([failure.code, failure.message]).toEqual(["UNAVAILABLE", "slow"]);
    // A 503 or 504 body without a message names the HTTP status, for bars, ticks and depth.
    failure = await depth(jsonResponse({ error: "timeout" }, { status: 504 }));
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "IBKR history service returned HTTP 504 with no message; retry",
    ]);
    failure = await ticks(jsonResponse({ error: "down" }, { status: 503 }));
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "IBKR history service returned HTTP 503 with no message; retry",
    ]);
    failure = (await fetchMarketBars(config, input(), {
      fetch: async () => jsonResponse({ error: "down" }, { status: 503 }),
      now: () => at,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "IBKR history service returned HTTP 503 with no message; retry",
    ]);
    expect(MARKET_DATA_ERRORS.UNAVAILABLE).toEqual({
      message: "IBKR history service request failed; retry",
      status: 503,
    });
    failure = await ticks(
      jsonResponse(
        { error: "bad_request", message: "count must be an integer" },
        { status: 400 }
      )
    );
    expect(failure.code).toBe("BAD_REQUEST");
    failure = await depth(
      jsonResponse(
        {
          error: "ibkr_error",
          ibkr_code: 309,
          message: "Max number of depth requests",
        },
        { status: 502 }
      )
    );
    expect([failure.code, failure.message]).toEqual([
      "UPSTREAM_ERROR",
      "IBKR 309: Max number of depth requests",
    ]);
    const hang = (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        )
      );
    failure = (await fetchMarketDepth(config, depthInput(), {
      fetch: hang,
      timeoutMs: 5,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "History request timed out",
    ]);
    const doFetch = vi.fn();
    failure = (await fetchMarketTicks(null, ticksInput(), {
      fetch: doFetch,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect(failure.code).toBe("NOT_CONFIGURED");
    return expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("marketData streamed tape", () => {
  const SINCE = 1_790_899_200;
  const tapeInput = { since: SINCE, symbol: "ES" };
  const tapeUpstream = (overrides: Record<string, unknown> = {}) => ({
    client_id: 77,
    contract: { ...contractFixture, localSymbol: "ESZ6", secType: "FUT" },
    covered: [[SINCE, SINCE + 57]],
    fetchedAt: "2026-10-04T02:16:59Z",
    minTick: 0.25,
    more: false,
    previousDifferentPrice: 6870,
    previousPrice: 6870.25,
    schema: "vertex-history-tape-v1",
    since: SINCE,
    source: "ibkr-gateway",
    stream: { error: null, state: "live" },
    symbol: "ES",
    trades: [
      [SINCE, 6870.5, 3, 6870.25, 6870.5],
      [SINCE + 1, 6870.25, 41, null, null],
    ],
    until: SINCE + 57,
    ...overrides,
  });
  const fetchTape = (body: unknown, init: ResponseInit = {}) =>
    fetchMarketTape(config, tapeInput, {
      fetch: async () => jsonResponse(body, init),
      now: () => at,
    });
  const failureOf = async (body: unknown, init: ResponseInit = {}) =>
    (await fetchTape(body, init).catch(
      (error: unknown) => error
    )) as MarketDataError;

  it("builds the tape URL with the symbol and the first exchange second", () => {
    expect(buildMarketTapeUrl(BASE, tapeInput)).toBe(
      `${BASE}/tape?symbol=ES&since=${SINCE}`
    );
    expect(buildMarketTapeUrl(`${BASE}//`, { since: 0, symbol: "nq" })).toBe(
      `${BASE}/tape?symbol=NQ&since=0`
    );
  });

  it("sends a bearer GET and passes the document through without the envelope keys", async () => {
    const doFetch = vi.fn(async () => jsonResponse(tapeUpstream()));
    const timers = vi.spyOn(globalThis, "setTimeout");
    const output = await fetchMarketTape(config, tapeInput, {
      fetch: doFetch,
      now: () => at,
    });
    // The default timeout of a tape read.
    expect(MARKET_TAPE_TIMEOUT_MS).toBe(10_000);
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 10_000);
    timers.mockRestore();
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(buildMarketTapeUrl(BASE, tapeInput));
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`
    );
    const {
      schema: _schema,
      client_id: _clientId,
      ...passThrough
    } = tapeUpstream();
    expect(output).toEqual({ ...passThrough, receivedAt: at.toISOString() });
  });

  it("accepts a feed before its first subscription and a feed that is down or off", async () => {
    const idle = await fetchTape(
      tapeUpstream({
        contract: null,
        covered: [],
        minTick: null,
        previousDifferentPrice: null,
        previousPrice: null,
        stream: { error: "connection closed", state: "down" },
        trades: [],
        until: SINCE - 1,
      })
    );
    expect(idle).toMatchObject({
      contract: null,
      minTick: null,
      previousDifferentPrice: null,
      previousPrice: null,
      stream: { error: "connection closed", state: "down" },
      trades: [],
    });
    const off = await fetchTape(
      tapeUpstream({
        stream: { error: "switched off", state: "off" },
        symbol: "NQ",
      })
    );
    expect([off.symbol, off.stream.state]).toEqual(["NQ", "off"]);
  });

  it("refuses schema drift: an extra key, a wrong tuple length, a wrong literal", async () => {
    const print = [SINCE, 6870.5, 3, 6870.25, 6870.5];
    const cases = [
      tapeUpstream({ extra: true }),
      tapeUpstream({ stream: { error: null, extra: 1, state: "live" } }),
      tapeUpstream({ contract: { ...contractFixture, account: "U1" } }),
      tapeUpstream({ trades: [print.slice(0, 4)] }),
      tapeUpstream({ trades: [[...print, 1]] }),
      tapeUpstream({ trades: [[SINCE + 0.5, 6870.5, 3, null, null]] }),
      tapeUpstream({ trades: [[SINCE, 6870.5, 3, "6870.25", null]] }),
      tapeUpstream({ covered: [[SINCE, SINCE + 5, SINCE + 9]] }),
      tapeUpstream({ covered: [[SINCE]] }),
      tapeUpstream({ schema: "vertex-history-ticks-v1" }),
      tapeUpstream({ client_id: 78 }),
      tapeUpstream({ source: "other" }),
      tapeUpstream({ symbol: "SPY" }),
      tapeUpstream({ stream: { error: null, state: "paused" } }),
      tapeUpstream({ more: "no" }),
      tapeUpstream({ until: null }),
      tapeUpstream({ fetchedAt: "2026-10-04 02:16:59" }),
      tapeUpstream({ minTick: 0 }),
      tapeUpstream({ previousDifferentPrice: 0 }),
      tapeUpstream({ previousDifferentPrice: "6870" }),
      tapeUpstream({
        stream: { error: "x".repeat(2001), state: "down" },
      }),
    ];
    for (const body of cases) {
      const failure = await failureOf(body);
      expect([failure.code, failure.message]).toEqual([
        "UPSTREAM_ERROR",
        "History response failed schema validation",
      ]);
    }
    const { previousPrice: _previousPrice, ...missingKey } = tapeUpstream();
    expect((await failureOf(missingKey)).code).toBe("UPSTREAM_ERROR");
    // An answer of a service version without previousDifferentPrice.
    const { previousDifferentPrice: _different, ...withoutDifferent } =
      tapeUpstream();
    expect((await failureOf(withoutDifferent)).code).toBe("UPSTREAM_ERROR");
  });

  it("redacts and cuts the cause text of the feed", async () => {
    expect(MARKET_TAPE_ERROR_MAX).toBe(200);
    const long = `IBKR 10190 for account U1234567:\n${"max tick-by-tick requests ".repeat(70)}`;
    expect(long.length).toBeGreaterThan(1500);
    expect(long.length).toBeLessThanOrEqual(2000);
    const output = await fetchTape(
      tapeUpstream({ stream: { error: long, state: "down" } })
    );
    const error = String(output.stream.error);
    expect(error).toHaveLength(200);
    expect(
      error.startsWith("IBKR 10190 for account [account]: max tick-by-tick")
    ).toBe(true);
    expect(error).not.toContain("U1234567");
    // A short text stays; no text stays null.
    const short = await fetchTape(
      tapeUpstream({ stream: { error: "switched off", state: "off" } })
    );
    expect(short.stream).toEqual({ error: "switched off", state: "off" });
    expect((await fetchTape(tapeUpstream())).stream.error).toBeNull();
  });

  it("maps an answer that is not 200 to the upstream errors of the other endpoints", async () => {
    let failure = await failureOf(
      { error: "bad_request", message: "symbol must be ES or NQ" },
      { status: 400 }
    );
    expect([failure.code, failure.message]).toEqual([
      "BAD_REQUEST",
      "symbol must be ES or NQ",
    ]);
    failure = await failureOf(
      { error: "unavailable", message: "starting" },
      { status: 503 }
    );
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "starting",
    ]);
    // A service version without the tape endpoint answers 404.
    failure = await failureOf({ error: "not_found" }, { status: 404 });
    expect(failure).toBeInstanceOf(MarketDataError);
    expect(failure.code).toBe("UPSTREAM_ERROR");
    const hang = (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        )
      );
    failure = (await fetchMarketTape(config, tapeInput, {
      fetch: hang,
      timeoutMs: 5,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect([failure.code, failure.message]).toEqual([
      "UNAVAILABLE",
      "History request timed out",
    ]);
    const doFetch = vi.fn();
    failure = (await fetchMarketTape(null, tapeInput, {
      fetch: doFetch,
    }).catch((error: unknown) => error)) as MarketDataError;
    expect(failure.code).toBe("NOT_CONFIGURED");
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("marketData.ticks and marketData.depth procedures", () => {
  it("are operator-only and never call upstream for denied callers or invalid input", async () => {
    const doFetch = vi.fn(async () => jsonResponse(ticksUpstream()));
    setMarketDataFetchOptionsForTesting({ fetch: doFetch, now: () => at });
    const operator = clientFor(session("operator"), config);
    await expectCode(
      clientFor(null, config).marketData.ticks({ symbol: "SPY" }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(null, config).marketData.depth({ symbol: "SPY" }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), config).marketData.ticks({
        symbol: "SPY",
      }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(session("outsider"), config).marketData.depth({
        symbol: "SPY",
      }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      operator.marketData.ticks({ count: 10, symbol: "SPY" }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      operator.marketData.ticks({ secType: "FUT", symbol: "ES" }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      operator.marketData.depth({ rows: 21, symbol: "SPY" }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      operator.marketData.depth({ contractMonth: "202612", symbol: "SPY" }),
      "BAD_REQUEST",
      400
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("return documents to operators and typed errors otherwise", async () => {
    const operator = clientFor(session("operator"), config);
    setMarketDataFetchOptionsForTesting({
      fetch: async (url) =>
        jsonResponse(
          String(url).includes("/ticks?") ? ticksUpstream() : depthUpstream()
        ),
      now: () => at,
    });
    const ticks = await operator.marketData.ticks({ symbol: "SPY" });
    expect(ticks.trades).toHaveLength(2);
    expect(ticks.receivedAt).toBe(at.toISOString());
    const depth = await operator.marketData.depth({ symbol: "SPY" });
    expect(depth.sizeMultiplier).toBe(100);
    expect(JSON.stringify([ticks, depth])).not.toContain(TOKEN);
    await expectCode(
      clientFor(session("operator"), null).marketData.depth({ symbol: "SPY" }),
      "NOT_CONFIGURED",
      503
    );
    setMarketDataFetchOptionsForTesting({
      fetch: async () =>
        jsonResponse(
          {
            error: "entitlement",
            ibkr_code: 10_092,
            message: "Deep market data is not supported",
          },
          { status: 502 }
        ),
      now: () => at,
    });
    await expectCode(
      operator.marketData.depth({
        exchange: "CME",
        secType: "FUT",
        symbol: "ES",
      }),
      "ENTITLEMENT",
      502
    );
    await expectCode(
      operator.marketData.ticks({ symbol: "SPY" }),
      "ENTITLEMENT",
      502
    );
    setMarketDataFetchOptionsForTesting({
      fetch: async () =>
        jsonResponse(
          { error: "busy", retry_after_seconds: 3 },
          { status: 429 }
        ),
      now: () => at,
    });
    return await expectCode(
      operator.marketData.depth({ symbol: "SPY" }),
      "PACED",
      429
    );
  });

  it("ticks are readable with read-access agent keys; depth is operator-only", () => {
    expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.ticks")).toBe(true);
    return expect(AGENT_API_KEY_READ_PROCEDURES.has("marketData.depth")).toBe(
      false
    );
  });
});

describe("marketData history pacing", () => {
  const health = { pacing: { backoff_seconds: 7, recent_requests: 3 } };

  it("reads the pacing block from /health", async () => {
    const doFetch = vi.fn(async () => jsonResponse({ ...health, ok: true }));
    const pacing = await fetchMarketHistoryPacing(
      { token: TOKEN, url: `${BASE}//` },
      { fetch: doFetch }
    );
    expect(pacing).toEqual({ backoffSeconds: 7, recentRequests: 3 });
    const [url, init] = doFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/health`);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${TOKEN}`
    );
    return expect(MARKET_HISTORY_HEALTH_TIMEOUT_MS).toBe(5000);
  });

  it("rejects a health document without a valid pacing block", async () => {
    const failure = (await fetchMarketHistoryPacing(config, {
      fetch: async () =>
        jsonResponse({ pacing: { backoff_seconds: -1, recent_requests: 0 } }),
    }).catch((error: unknown) => error)) as MarketDataError;
    return expect([failure.code, failure.message]).toEqual([
      "UPSTREAM_ERROR",
      "History response failed schema validation",
    ]);
  });

  it("fails as NOT_CONFIGURED without a history config", async () => {
    const failure = (await fetchMarketHistoryPacing(null).catch(
      (error: unknown) => error
    )) as MarketDataError;
    return expect(failure.code).toBe("NOT_CONFIGURED");
  });
});
