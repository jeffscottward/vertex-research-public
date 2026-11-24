import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Breadth90Repository,
  MarketDailyColumns,
  MarketDailyLatestPoint,
  MarketDailySeriesRepository,
  OpenbbRepository,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  REGIME_DAILY_STALE_SECONDS,
  REGIME_INDEX_SYMBOLS,
} from "./contracts/market-regime.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { setMarketRegimeOptionsForTesting } from "./server/market-regime.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");

const makeSession = (email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId: email },
  session: {
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    id: `sess-${email}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId: email,
  },
  user: {
    createdAt: NOW,
    email,
    emailVerified: true,
    id: email,
    image: null,
    name: email,
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

const dailyColumns = (
  length: number,
  lastDate: string,
  base: number,
  step = 0.5
): MarketDailyColumns => {
  const close = Array.from({ length }, (_, index) => base + index * step);
  const dates = Array.from({ length }, (_, index) =>
    index === length - 1
      ? lastDate
      : `2026-01-${String((index % 28) + 1).padStart(2, "0")}`
  );
  return {
    adjClose: close,
    close,
    dates,
    high: close,
    low: close,
    open: close,
  };
};

type FakeRepos = Readonly<{
  breadth90?: Breadth90Repository;
  marketDailySeries?: MarketDailySeriesRepository;
  openbb?: OpenbbRepository;
}>;

const buildRepositories = (overrides: FakeRepos = {}): Repositories =>
  overrides as unknown as Repositories;

const makeClient = (options: {
  agentApiKeyAccess?: "read" | "write";
  engineStatus?: string | null;
  ibkrMonitor?: string | null;
  marketHistory?: { token: string; url: string } | null;
  repositories?: Repositories;
  session?: SafeAuthSession | null;
}) => {
  const fetch = async (request: Request): Promise<Response> => {
    const req =
      options.agentApiKeyAccess === undefined
        ? request
        : new Request(request, {
            headers: {
              ...Object.fromEntries(request.headers.entries()),
              "x-api-key": "test-read-key",
            },
          });
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(req, {
      ...(options.agentApiKeyAccess === undefined
        ? {}
        : {
            agentApiKeys: {
              authenticate: async () => ({
                access: options.agentApiKeyAccess as "read" | "write",
                apiKeyId: "key-1",
                email: "operator@domain.test",
                emailVerified: true,
                role: "member",
                status: "active",
                userId: "operator-1",
              }),
              create: vi.fn(),
              list: vi.fn(),
              revoke: vi.fn(),
            },
          }),
      agentViewerEmails: ["viewer@domain.test"],
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      engineStatus: options.engineStatus ?? null,
      ibkrMonitor: options.ibkrMonitor ?? null,
      marketHistory: options.marketHistory ?? null,
      operatorEmails: ["operator@domain.test"],
      repositories: options.repositories ?? buildRepositories(),
      requestId: "req-regime-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (!options.session) throw denied();
        return options.session;
      },
    });
    return handleApiRequest(req, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const makeFullRepos = (options?: {
  lastDate?: string;
  latestVolPoints?: MarketDailyLatestPoint[];
  missingVolInWindow?: boolean;
}) => {
  const lastDate = options?.lastDate ?? "2026-11-20";
  const seriesMap = new Map<string, MarketDailyColumns>([
    ["QQQ", dailyColumns(220, lastDate, 400, 0.5)],
    ["SPY", dailyColumns(220, lastDate, 500, 0.4)],
    ["IWM", dailyColumns(220, lastDate, 200, 0.2)],
    ["DIA", dailyColumns(220, lastDate, 380, 0.3)],
  ]);
  const volMap = new Map<string, MarketDailyColumns>(
    options?.missingVolInWindow
      ? []
      : [
          ["VIX", dailyColumns(5, lastDate, 15.2, 0)],
          ["VIX3M", dailyColumns(5, lastDate, 17.5, 0)],
          ["VIX9D", dailyColumns(5, lastDate, 14.0, 0)],
          ["VIX6M", dailyColumns(5, lastDate, 18.2, 0)],
          ["VXN", dailyColumns(5, lastDate, 19.4, 0)],
          ["RVX", dailyColumns(5, lastDate, 21.1, 0)],
          ["VXD", dailyColumns(5, lastDate, 13.8, 0)],
        ]
  );

  const marketDailySeries = {
    latestPoints: vi.fn(async () => options?.latestVolPoints ?? []),
    loadSeries: vi.fn(async (ids: readonly string[]) => {
      const out = new Map<string, MarketDailyColumns>();
      for (const id of ids) {
        const hit = seriesMap.get(id) ?? volMap.get(id);
        if (hit !== undefined) out.set(id, hit);
      }
      return out;
    }),
  } as unknown as MarketDailySeriesRepository;

  const breadth90 = {
    getStatus: vi.fn(async () => ({
      armedOn: null,
      asOf: new Date(`${lastDate}T21:15:00.000Z`),
      basket: {
        asOf: lastDate,
        reportPath: "/private/local/rig/path",
        rulesNote: null,
        summary: null,
        tiers: [],
      },
      sessionsLeft: null,
      state: "IDLE" as const,
      strict: false,
    })),
    listRecentDays: vi.fn(async () => [
      {
        adv: 1800,
        advPct: 60,
        date: lastDate,
        decl: 1200,
        dvol: 400,
        final: true,
        kind: "NEUTRAL" as const,
        source: "tradingview",
        sourceAsOf: `${lastDate}T21:00:00Z`,
        updatedAt: new Date(`${lastDate}T21:15:00.000Z`),
        upPct: 60,
        uvol: 600,
      },
    ]),
    listRecentEvents: vi.fn(async () => []),
  } as unknown as Breadth90Repository;

  const openbb = {
    macroPoints: vi.fn(async () => [
      { date: lastDate, seriesId: "HY_OAS", value: 3.15 },
      { date: lastDate, seriesId: "IG_OAS", value: 0.92 },
    ]),
    macroSeries: vi.fn(async () => [
      {
        firstDate: lastDate,
        frequency: "daily",
        id: "HY_OAS",
        lastDate,
        name: "HY OAS",
        pointCount: 1,
        source: "fred",
        unit: "percent",
      },
      {
        firstDate: lastDate,
        frequency: "daily",
        id: "IG_OAS",
        lastDate,
        name: "IG OAS",
        pointCount: 1,
        source: "fred",
        unit: "percent",
      },
    ]),
    optionIvDaily: vi.fn(async () => [
      { asOf: lastDate, atmIv30d: 0.17, underlying: "SPY" },
      { asOf: lastDate, atmIv30d: 0.21, underlying: "QQQ" },
    ]),
    optionIvTermLatest: vi.fn(async () => []),
    vxCurve: vi.fn(async () => []),
    vxCurveDates: vi.fn(async () => []),
  } as unknown as OpenbbRepository;

  return { breadth90, marketDailySeries, openbb };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const marketContextPayload = (overrides?: { generatedAt?: number }) => ({
  generatedAt: overrides?.generatedAt ?? Math.floor(NOW.getTime() / 1000) - 120,
  gex: {
    asOf: Math.floor(Date.parse("2026-11-20T21:00:00.000Z") / 1000),
    index: [
      {
        callWall: 605,
        fadeNote: null,
        flip: 580,
        netChex: null,
        netDex: null,
        netGex: 1_200_000_000,
        netVex: null,
        notes: [],
        putWall: 560,
        regime: "dampened",
        spot: 590,
        spotVsFlip: "above",
        status: "ok",
        symbol: "SPY",
        zeroDte: null,
      },
      {
        callWall: 530,
        fadeNote: null,
        flip: 500,
        netChex: null,
        netDex: null,
        netGex: 800_000_000,
        netVex: null,
        notes: [],
        putWall: 490,
        regime: "dampened",
        spot: 510,
        spotVsFlip: "above",
        status: "ok",
        symbol: "QQQ",
        zeroDte: null,
      },
    ],
    label: null,
    oiSession: "2026-11-20",
  },
  macro: {
    asOf: Math.floor(Date.parse("2026-11-20T21:00:00.000Z") / 1000),
    events: [],
    regimes: [],
    series: [
      {
        change1d: 0.02,
        change1m: 0.4,
        change1w: 0.1,
        change1y: 0.2,
        date: "2026-11-20",
        group: "credit",
        id: "HY_OAS",
        label: "HY OAS",
        pct1y: 55,
        source: "FRED",
        sourceUrl: null,
        stale: false,
        status: "ok",
        units: "%",
        value: 4.2,
      },
    ],
  },
  missing: [],
  news: null,
  schema: "vertex-market-context-v1",
  sections: { gex: null, macro: null, news: null },
});

const ibkrVolPayload = () => ({
  implied: null,
  sources: { cboe: { error: "https://internal.secret.host/boom" } },
  spread: null,
  spx: null,
  vix: {
    asOf: "2026-11-22T17:58:00.000Z",
    change1d: -0.4,
    pct1y: 30,
    stale: false,
    value: 14.8,
  },
  vixeq: null,
  vvix: null,
});

afterEach(() => {
  setMarketRegimeOptionsForTesting(null);
});

describe("marketRegime.get server", () => {
  it("denies unauthenticated and non-operator callers, and allows operator, agent viewer, and read API key", async () => {
    setMarketRegimeOptionsForTesting({ now: () => NOW });

    const anon = makeClient({ session: null });
    await expect(anon.marketRegime.get({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const stranger = makeClient({
      session: makeSession("stranger@domain.test"),
    });
    await expect(stranger.marketRegime.get({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const repos = buildRepositories(makeFullRepos());
    setMarketRegimeOptionsForTesting({
      ibkrMonitor: {
        fetch: async () => jsonResponse(ibkrVolPayload()),
      },
      marketContext: {
        fetch: async () => jsonResponse(marketContextPayload()),
      },
      now: () => NOW,
    });

    const readKeyClient = makeClient({
      agentApiKeyAccess: "read",
      engineStatus: "http://127.0.0.1:3462",
      ibkrMonitor: "http://127.0.0.1:3461",
      repositories: repos,
    });
    const res = await readKeyClient.marketRegime.get({});
    expect(res.etfs.map((row) => row.symbol)).toEqual(REGIME_INDEX_SYMBOLS);
    expect(res.overall).toMatchObject({
      missingPillarCount: 0,
      staleEtfs: [],
      stalePillarCount: 0,
      summary: "risk_on",
    });
    // Never leaks breadth90.basket local path or ibkrMonitor.sourceErrors URL
    expect(JSON.stringify(res)).not.toContain("/private/local/rig/path");
    expect(JSON.stringify(res)).not.toContain("internal.secret.host");

    // Read-only agent viewer session also succeeds (GET route)
    const viewerClient = makeClient({
      engineStatus: "http://127.0.0.1:3462",
      repositories: repos,
      session: makeSession("viewer@domain.test"),
    });
    const viewerRes = await viewerClient.marketRegime.get({});
    expect(viewerRes.overall.summary).toBe("risk_on");
  });

  it("uses IBKR fetchMarketBars fallback when stored daily series is stale, normalizes 00:00 UTC dates, and propagates cache.stale", async () => {
    const staleRepos = makeFullRepos({ lastDate: "2026-11-10" });
    const barsFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const symbol = new URL(url).searchParams.get("symbol") ?? "QQQ";
      const count = symbol === "DIA" ? 50 : 210; // DIA too short => retains stale Postgres SMA!
      const bars = Array.from({ length: count }, (_, index) => ({
        c: 400 + index,
        h: 401 + index,
        l: 399 + index,
        o: 400 + index,
        t:
          index === count - 1
            ? Math.floor(Date.parse("2026-11-20T00:00:00.000Z") / 1000)
            : Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000) +
              index * 86_400,
        v: 1_000_000,
      }));
      return jsonResponse({
        as_of: "2026-11-20T00:00:00Z",
        bars,
        cache: {
          age_seconds: 10,
          hit: true,
          stale: symbol === "IWM",
          ttl_seconds: 300,
        },
        client_id: 77,
        contract: {
          conId: 1,
          currency: "USD",
          exchange: "SMART",
          lastTradeDateOrContractMonth: null,
          localSymbol: symbol,
          longName: `${symbol} ETF`,
          matches: 1,
          multiplier: null,
          secType: "STK",
          timeZoneId: "US/Eastern",
        },
        count: bars.length,
        fetched_at: "2026-11-22T17:50:00Z",
        request: {
          barSize: "1 day",
          contractMonth: null,
          currency: "USD",
          duration: "1 Y",
          exchange: "SMART",
          secType: "STK",
          symbol,
          useRTH: true,
          whatToShow: "TRADES",
        },
        schema: "vertex-history-bars-v2",
        source: "ibkr-gateway",
        volume_unit: "shares",
      });
    });

    setMarketRegimeOptionsForTesting({
      marketBars: { fetch: barsFetch },
      now: () => NOW,
    });

    const client = makeClient({
      marketHistory: { token: "tok", url: "http://127.0.0.1:9999" },
      repositories: buildRepositories(staleRepos),
      session: makeSession("operator@domain.test"),
    });

    const res = await client.marketRegime.get({});
    const qqq = res.etfs.find((row) => row.symbol === "QQQ");
    const iwm = res.etfs.find((row) => row.symbol === "IWM");
    const dia = res.etfs.find((row) => row.symbol === "DIA");

    expect(qqq?.trend).toMatchObject({
      asOf: "2026-11-20",
      source: "ibkr_bars",
      stale: false,
      state: "uptrend",
    });
    expect(iwm?.trend).toMatchObject({
      source: "ibkr_bars",
      stale: true,
      state: "uptrend",
    });
    // DIA fallback returned < 200 bars, so it retained stale Postgres SMAs instead of unavailable
    expect(dia?.trend).toMatchObject({
      asOf: "2026-11-10",
      source: "market_daily_series",
      stale: true,
      state: "uptrend",
    });
    expect(barsFetch).toHaveBeenCalledTimes(4);
  });

  it("triggers IBKR fallback cooldown on failure and handles empty bars with asOf fallback", async () => {
    const staleRepos = makeFullRepos({ lastDate: "2026-11-10" });
    const failingFetch = vi.fn(
      async () => new Response("paced", { status: 429 })
    );
    setMarketRegimeOptionsForTesting({
      marketBars: { fetch: failingFetch },
      now: () => NOW,
    });

    const client = makeClient({
      marketHistory: { token: "tok", url: "http://127.0.0.1:9999" },
      repositories: buildRepositories(staleRepos),
      session: makeSession("operator@domain.test"),
    });

    const res = await client.marketRegime.get({});
    // First symbol failed -> cooldown activated -> remaining 3 symbols did NOT call IBKR!
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(res.etfs[0]?.trend.source).toBe("market_daily_series");
    expect(res.etfs[0]?.trend.stale).toBe(true);

    // Also test empty bars output (asOf present and asOf null)
    setMarketRegimeOptionsForTesting({
      marketBars: {
        fetch: async (input) => {
          const symbol =
            new URL(String(input)).searchParams.get("symbol") ?? "QQQ";
          return jsonResponse({
            as_of: symbol === "QQQ" ? "2026-11-20T00:00:00Z" : null,
            bars: [],
            cache: {
              age_seconds: 0,
              hit: false,
              stale: false,
              ttl_seconds: 60,
            },
            client_id: 77,
            contract: {
              conId: 1,
              currency: "USD",
              exchange: "SMART",
              lastTradeDateOrContractMonth: null,
              localSymbol: symbol,
              longName: `${symbol} ETF`,
              matches: 1,
              multiplier: null,
              secType: "STK",
              timeZoneId: "US/Eastern",
            },
            count: 0,
            fetched_at: "2026-11-22T17:50:00Z",
            request: {
              barSize: "1 day",
              contractMonth: null,
              currency: "USD",
              duration: "1 Y",
              exchange: "SMART",
              secType: "STK",
              symbol,
              useRTH: true,
              whatToShow: "TRADES",
            },
            schema: "vertex-history-bars-v2",
            source: "ibkr-gateway",
            volume_unit: "shares",
          });
        },
      },
      now: () => NOW,
    });
    const emptyRes = await client.marketRegime.get({});
    expect(emptyRes.etfs[0]?.trend.source).toBe("market_daily_series");
  });

  it("surfaces vol indices older than 30 days via latestPoints as stale, and isolates repository/upstream failures", async () => {
    const staleVolRepos = makeFullRepos({
      latestVolPoints: [
        { adjClose: null, close: 19.5, id: "VIX", lastDate: "2026-10-01" },
      ],
      missingVolInWindow: true,
    });
    setMarketRegimeOptionsForTesting({
      ibkrMonitor: {
        fetch: async () => {
          throw new Error("ibkr-monitor timeout");
        },
      },
      marketContext: {
        fetch: async () => jsonResponse(marketContextPayload()),
      },
      now: () => NOW,
    });

    const staleVolClient = makeClient({
      engineStatus: "http://127.0.0.1:3462",
      ibkrMonitor: "http://127.0.0.1:3461",
      repositories: buildRepositories(staleVolRepos),
      session: makeSession("operator@domain.test"),
    });
    const staleVolRes = await staleVolClient.marketRegime.get({});
    expect(staleVolRes.etfs[0]?.volatility).toMatchObject({
      asOf: "2026-10-01",
      source: "openbb_vol_context",
      stale: true,
      staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
      state: "calm",
      vix: 19.5,
    });
    expect(staleVolRes.etfs[0]?.summary).toBe("mixed");

    // Fault isolation: every repository throws & upstreams fail -> returns incomplete, never 500/503!
    const throwingRepos = buildRepositories({
      breadth90: {
        getStatus: vi.fn(async () => {
          throw new Error("secret postgres connection string");
        }),
        listRecentDays: vi.fn(async () => []),
        listRecentEvents: vi.fn(async () => []),
      } as unknown as Breadth90Repository,
      marketDailySeries: {
        latestPoints: vi.fn(async () => {
          throw new Error("boom");
        }),
        loadSeries: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as unknown as MarketDailySeriesRepository,
      openbb: {
        macroPoints: vi.fn(async () => {
          throw new Error("boom");
        }),
        macroSeries: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as unknown as OpenbbRepository,
    });

    setMarketRegimeOptionsForTesting({
      marketContext: {
        fetch: async () => {
          throw new Error("secret loopback url");
        },
      },
      now: () => NOW,
    });

    const brokenClient = makeClient({
      engineStatus: "http://127.0.0.1:3462",
      repositories: throwingRepos,
      session: makeSession("operator@domain.test"),
    });
    const brokenRes = await brokenClient.marketRegime.get({});
    expect(brokenRes.overall.summary).toBe("incomplete");
    expect(brokenRes.etfs[0]?.trend.detail).toBe(
      "Missing: daily price series read failed."
    );
    expect(JSON.stringify(brokenRes)).not.toContain("secret postgres");
    expect(JSON.stringify(brokenRes)).not.toContain("secret loopback");

    // Unconfigured repositories + credit fallback from market-context macro
    setMarketRegimeOptionsForTesting({
      marketContext: {
        fetch: async () => jsonResponse(marketContextPayload()),
      },
      now: () => NOW,
    });
    const unconfiguredClient = makeClient({
      engineStatus: "http://127.0.0.1:3462",
      repositories: buildRepositories({}),
      session: makeSession("operator@domain.test"),
    });
    const unconfiguredRes = await unconfiguredClient.marketRegime.get({});
    expect(unconfiguredRes.etfs[0]?.credit).toMatchObject({
      hyOas: 4.2,
      source: "market_context_macro:HY_OAS",
      state: "widening",
    });
    expect(unconfiguredRes.etfs[0]?.breadth90.state).toBe("missing");
    expect(unconfiguredRes.etfs[0]?.trend.detail).toBe(
      "Missing: daily price series storage is not configured."
    );

    // Retain newer stale Postgres SMAs when IBKR fallback returns an older stale cached series
    const olderStaleBars = Array.from({ length: 210 }, (_, idx) => ({
      c: 100 + idx * 0.4,
      h: 101 + idx * 0.4,
      l: 99 + idx * 0.4,
      o: 100 + idx * 0.4,
      t:
        Math.floor(Date.parse("2026-11-10T00:00:00.000Z") / 1000) -
        (209 - idx) * 86_400,
      v: 1_000_000,
    }));
    const olderBarsFetch = vi.fn(async (input: RequestInfo | URL) => {
      const symbol = new URL(String(input)).searchParams.get("symbol") ?? "QQQ";
      return jsonResponse({
        as_of: "2026-11-10T00:00:00Z",
        bars: olderStaleBars,
        cache: {
          age_seconds: 10,
          hit: true,
          stale: true,
          ttl_seconds: 300,
        },
        client_id: 77,
        contract: {
          conId: 1,
          currency: "USD",
          exchange: "SMART",
          lastTradeDateOrContractMonth: null,
          localSymbol: symbol,
          longName: `${symbol} ETF`,
          matches: 1,
          multiplier: null,
          secType: "STK",
          timeZoneId: "US/Eastern",
        },
        count: olderStaleBars.length,
        fetched_at: "2026-11-10T21:00:00Z",
        request: {
          barSize: "1 day",
          contractMonth: null,
          currency: "USD",
          duration: "1 Y",
          exchange: "SMART",
          secType: "STK",
          symbol,
          useRTH: true,
          whatToShow: "TRADES",
        },
        schema: "vertex-history-bars-v2",
        source: "ibkr-gateway",
        volume_unit: "shares",
      });
    });
    setMarketRegimeOptionsForTesting({
      marketBars: { fetch: olderBarsFetch },
      now: () => NOW,
    });
    const stalePostgresRepos = buildRepositories({
      marketDailySeries: {
        latestPoints: vi.fn(async () => new Map()),
        loadSeries: vi.fn(
          async () =>
            new Map([
              [
                "QQQ",
                {
                  close: Array.from(
                    { length: 210 },
                    (_, idx) => 200 + idx * 0.5
                  ),
                  dates: Array.from({ length: 210 }, (_, idx) =>
                    idx === 209 ? "2026-11-15" : "2026-10-01"
                  ),
                },
              ],
            ])
        ),
      } as unknown as MarketDailySeriesRepository,
    });
    const retainNewerRes = await makeClient({
      marketHistory: {
        token: "test-token",
        url: "http://127.0.0.1:4199",
      },
      repositories: stalePostgresRepos,
      session: makeSession("operator@domain.test"),
    }).marketRegime.get({});
    expect(olderBarsFetch).toHaveBeenCalled();
    expect(retainNewerRes.etfs[0]?.trend).toMatchObject({
      asOf: "2026-11-15",
      source: "market_daily_series",
      stale: true,
      state: "uptrend",
    });

    // Exercise default system clock path when now option is not provided
    setMarketRegimeOptionsForTesting(null);
    const defaultClockRes = await makeClient({
      repositories: buildRepositories({}),
      session: makeSession("operator@domain.test"),
    }).marketRegime.get({});
    expect(defaultClockRes.overall.summary).toBe("incomplete");
    expect(ORPCError).toBeDefined();
  });
});
