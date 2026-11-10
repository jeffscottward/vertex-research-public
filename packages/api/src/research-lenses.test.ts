import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type {
  DeepValueDocument,
  RotationMatrixDocument,
} from "./contracts/research-lenses.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { AGENT_API_KEY_PROCEDURE_ROOTS } from "./server/handler.ts";
import { handleApiRequest } from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { resetIbkrPacing } from "./server/merged-bars.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
} from "./server/merged-bars.test-support.ts";
import {
  clearResearchLensCacheForTesting,
  fetchBoundedJson,
  fetchDeepValue,
  fetchRotationMatrix,
  gatherDeepValueFacts,
  ResearchLensError,
  type ResearchLensOptions,
  scoreDeepValueSymbol,
  setResearchLensOptionsForTesting,
} from "./server/research-lenses.ts";

// Synthetic lens documents and market data only.

const at = new Date("2026-10-21T20:30:00.000Z");
const TOKEN = "r".repeat(43);
const BASE = "https://quantvps.tailnet.test:8443/vertex-research-lenses/v1/";
const config: DeployStatusConfig = { url: BASE, token: TOKEN };

const brief = (symbol: string, ret: number) => ({
  symbol,
  ret,
  marketCap: 5e9,
});

const cell = {
  n: 2,
  retMedian: 4.2,
  retCapWeighted: 4,
  breadth: 100,
  leaders: [brief("AAA", 6)],
  laggards: [brief("BBB", 2.4)],
  symbols: [brief("AAA", 6), brief("BBB", 2.4)],
};

const period = (bars: number) => ({
  bars,
  n: 2,
  sectors: [
    {
      ...cell,
      sector: "Energy",
      industries: ["Oil & Gas Production"],
      ignoredField: true,
    },
  ],
  industries: [
    {
      ...cell,
      sector: "Energy",
      industry: "Oil & Gas Production",
      rank: 1,
      quintile: 1,
      cells: { mid: cell },
      standouts: [],
    },
  ],
  top: [
    {
      sector: "Energy",
      industry: "Oil & Gas Production",
      retMedian: 4.2,
      n: 2,
    },
  ],
  bottom: [],
  standouts: [
    {
      ...brief("AAA", 6),
      z: 2.5,
      sector: "Energy",
      industry: "Oil & Gas Production",
      cap: "mid" as const,
    },
  ],
});

const rotationDocument = (
  overrides: Partial<RotationMatrixDocument> = {}
): RotationMatrixDocument => ({
  asOf: "2026-10-21",
  generatedAt: "2026-10-21T17:10:32.981Z",
  universeSize: 2,
  periods: {
    "1D": period(1),
    "1M": period(21),
    "3M": period(63),
    "6M": period(126),
  },
  ours: [
    {
      symbol: "AAA",
      roles: ["wish"],
      covered: true,
      sector: "Energy",
      industry: "Oil & Gas Production",
      cap: "mid",
      cell1M: "leading",
      cell3M: "leading",
      opportunity: true,
    },
    { symbol: "ZZZ", roles: ["reentry"], covered: false },
  ],
  capLabels: { large: "Large", mid: "Mid", small: "Small" },
  source: {
    metadata: "Nasdaq screener",
    bars: "Yahoo daily closes",
    finvizMap: "https://finviz.com/map.ashx?t=sec_all",
    failed: 0,
    staleDropped: 0,
  },
  ...overrides,
});

const row = {
  symbol: "AAA",
  name: "Alpha",
  industry: "Oil & Gas Production",
  roles: ["wish"],
  price: 8,
  marketCap: 80e6,
  metrics: { evSales: 0.3, cashFlowPositive: true, runwayMonths: null },
  criteria: { risk: { score: 2, evidence: "Debt ÷ equity 0.10." } },
  total: 12,
  coverage: 7,
  normalized: 13.7,
  reasons: ["Risk: Debt ÷ equity 0.10."],
  flags: [],
  asOf: "2026-10-21",
  rank: 1,
  errors: [],
};

const deepValueDocument = (): DeepValueDocument => ({
  generatedAt: "2026-10-21T20:28:25.921Z",
  method: "TRUE SLAP (IG reel Dew5OAejyOH, @willbchou)",
  criteria: [
    { id: "risk", lens: "TRUE", label: "Risk", proxy: "Debt ÷ equity" },
  ],
  cutoffs: {
    scoring: { runwayMonths: [12, 24], rangeLowerPct: 40 },
    flags: { penny: 1 },
    universe: {
      maxPrice: 10,
      minMarketCap: 50e6,
      maxMarketCap: 1e9,
      minDollarVolume: 100e3,
    },
    note: "All numeric cutoffs and proxies are ours",
  },
  sources: { prices: "Yahoo", fundamentals: "SEC" },
  counts: { scored: 1, ours: 1, universe: 0, withErrors: 0 },
  industryMedians: { "Metal Fabrications": { evSales: 1, n: 9 } },
  industryBySymbol: { AAA: "Metal Fabrications" },
  rows: [row],
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// Yahoo chart: 60 rising closes ending at 8; SEC: a simple profitable filer.
const yahooChart = (name: string | null = "Alpha Industries") => ({
  chart: {
    result: [
      {
        meta: name === null ? {} : { longName: name },
        timestamp: Array.from(
          { length: 60 },
          (_, index) => 1_760_000_000 + index * 86_400
        ),
        indicators: {
          quote: [
            {
              close: Array.from({ length: 60 }, (_, index) => 6 + index / 29.5),
              volume: Array.from({ length: 60 }, () => 500_000),
            },
          ],
        },
      },
    ],
  },
});

const fy = (end: string, val: number) => ({
  val,
  end,
  start: `${String(Number(end.slice(0, 4)) - 1)}${end.slice(4)}`,
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form: "10-K",
});

const companyFacts = {
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [fy("2025-12-31", 200e6)] } },
      StockholdersEquity: {
        units: { USD: [{ val: 100e6, end: "2025-12-31" }] },
      },
      LongTermDebt: { units: { USD: [{ val: 10e6, end: "2025-12-31" }] } },
      Assets: { units: { USD: [fy("2010-12-31", 1)] } },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: { shares: [{ val: 10e6, end: "2026-02-01", accn: "1" }] },
      },
    },
  },
};

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers by URL prefix and records each call. */
const router = (routes: Record<string, Route>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const match = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix)
    );
    if (match === undefined) return new Response("missing", { status: 404 });
    return await match[1](url, init);
  };
  return { calls, fetch };
};

const lensRoutes = (): Record<string, Route> => ({
  [`${BASE}rotation-matrix.json`]: () => jsonResponse(rotationDocument()),
  [`${BASE}deep-value.json`]: () => jsonResponse(deepValueDocument()),
});

const marketRoutes = (): Record<string, Route> => ({
  "https://query1.finance.yahoo.com/v8/finance/chart/": () =>
    jsonResponse(yahooChart()),
  "https://www.sec.gov/files/company_tickers.json": () =>
    jsonResponse({
      "0": { cik_str: 1234, ticker: "aaa", title: "ALPHA INDUSTRIES INC" },
      "1": { cik_str: 77, ticker: "BRK-B", title: "BERKSHIRE" },
      "2": { cik_str: "bad", ticker: "BAD", title: "Bad row" },
    }),
  "https://data.sec.gov/api/xbrl/companyfacts/": () =>
    jsonResponse(companyFacts),
});

const options = (
  fetch: NonNullable<ResearchLensOptions["fetch"]>
): ResearchLensOptions => ({
  fetch,
  now: () => at,
});

afterEach(() => {
  clearResearchLensCacheForTesting();
  setResearchLensOptionsForTesting({});
  vi.unstubAllGlobals();
});

describe("bounded JSON fetch", () => {
  const request = {
    url: "https://example.test/doc.json",
    label: "Doc",
    headers: { "x-test": "1" },
    maxBytes: 64,
  };
  const run = (
    fetch: NonNullable<ResearchLensOptions["fetch"]>,
    extra: Partial<typeof request> = {},
    timeoutMs = 1000
  ) =>
    fetchBoundedJson({ ...request, ...extra }, { fetch, timeoutMs }).catch(
      (error: unknown) => error
    );

  it("sends a GET with manual redirects and returns parsed JSON", async () => {
    const { calls, fetch } = router({
      "https://example.test/": () => jsonResponse({ ok: true }),
    });
    expect(await run(fetch)).toEqual({ ok: true });
    return expect(calls[0]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "x-test": "1" },
    });
  });

  it("maps HTTP, content type, size, body and JSON failures to typed codes", async () => {
    const status = (code: number) => async () =>
      jsonResponse({}, { status: code });
    expect(await run(status(404))).toMatchObject({
      code: "NOT_FOUND",
      message: "Doc returned HTTP 404",
    });
    for (const code of [502, 503, 504])
      expect(await run(status(code))).toMatchObject({ code: "UNAVAILABLE" });
    expect(await run(status(500))).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Doc returned HTTP 500",
    });
    expect(
      await run(async () => new Response(null, { status: 200 }))
    ).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(
      await run(async () => new Response("{}", { status: 200 }))
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Doc returned an unexpected content type",
    });
    expect(
      await run(async () => jsonResponse({ big: "x".repeat(100) }))
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Doc response exceeds the size cap",
    });
    expect(
      await run(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (controller) => controller.error(new Error("reset")),
            }),
            { headers: { "content-type": "application/json" } }
          )
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Doc response could not be read",
    });
    return expect(
      await run(
        async () =>
          new Response("{", { headers: { "content-type": "application/json" } })
      )
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Doc response is not valid JSON",
    });
  });

  it("reports transport failures and timeouts as unavailable", async () => {
    expect(
      await run(async () => {
        throw new Error("socket closed");
      })
    ).toMatchObject({ code: "UNAVAILABLE", message: "Doc request failed" });
    // The ES2023 lib in this package has no Promise.withResolvers.
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("abort")))
      );
    expect(await run(hang, {}, 5)).toMatchObject({
      code: "UNAVAILABLE",
      message: "Doc request timed out",
    });
    const slowBody = async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) =>
            init.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted"))
            ),
        }),
        { headers: { "content-type": "application/json" } }
      );
    return expect(await run(slowBody, {}, 5)).toMatchObject({
      code: "UNAVAILABLE",
      message: "Doc request timed out",
    });
  });

  return it("uses the global fetch and the default timeout", async () => {
    const globalFetch = vi.fn(async () => jsonResponse([1]));
    vi.stubGlobal("fetch", globalFetch);
    expect(await fetchBoundedJson(request)).toEqual([1]);
    return expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("lens documents", () => {
  it("returns one rotation period with our names, labels and source", async () => {
    const { calls, fetch } = router(lensRoutes());
    const output = await fetchRotationMatrix(config, "3M", options(fetch));
    expect(output).toMatchObject({
      period: "3M",
      bars: 63,
      asOf: "2026-10-21",
      universeSize: 2,
      capLabels: { mid: "Mid" },
      source: { metadata: "Nasdaq screener" },
      receivedAt: at.toISOString(),
    });
    expect(output.sectors[0]).not.toHaveProperty("ignoredField");
    expect(output.ours.map((name) => name.symbol)).toEqual(["AAA", "ZZZ"]);
    expect(calls[0]?.url).toBe(`${BASE}rotation-matrix.json`);
    return expect(calls[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("caches each document for 60 seconds", async () => {
    let clock = at.getTime();
    const { calls, fetch } = router(lensRoutes());
    const timed: ResearchLensOptions = { fetch, now: () => new Date(clock) };
    await fetchRotationMatrix(config, "1M", timed);
    clock += 59_000;
    const cached = await fetchRotationMatrix(config, "6M", timed);
    expect(cached.receivedAt).toBe(at.toISOString());
    expect(calls).toHaveLength(1);
    clock += 2000;
    await fetchRotationMatrix(config, "1D", timed);
    return expect(calls).toHaveLength(2);
  });

  it("reports a missing source block as null", async () => {
    const { source: _source, ...noSource } = rotationDocument();
    const { fetch } = router({
      [`${BASE}rotation-matrix.json`]: () => jsonResponse(noSource),
    });
    return expect(
      (await fetchRotationMatrix(config, "1M", options(fetch))).source
    ).toBeNull();
  });

  it("returns the deep value ranking without the peer tables", async () => {
    const { fetch } = router(lensRoutes());
    const output = await fetchDeepValue(config, options(fetch));
    expect(output.rows).toEqual([row]);
    expect(output.receivedAt).toBe(at.toISOString());
    expect(output).not.toHaveProperty("industryMedians");
    return expect(output).not.toHaveProperty("industryBySymbol");
  });

  return it("maps missing, invalid and unconfigured documents", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    expect(
      await fetchDeepValue(config, options(fetch)).catch((error) => error)
    ).toMatchObject({
      code: "NOT_FOUND",
      message: "Deep value scorecard not yet collected",
    });
    expect(
      await fetchRotationMatrix(config, "1M", {
        fetch: async () => jsonResponse({ periods: {} }),
      }).catch((error) => error)
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Rotation matrix failed schema validation",
    });
    expect(
      await fetchRotationMatrix(config, "1M", {
        fetch: async () => jsonResponse({}, { status: 503 }),
      }).catch((error) => error)
    ).toMatchObject({ code: "UNAVAILABLE" });
    const unused = vi.fn();
    const missing = await fetchDeepValue(null, { fetch: unused }).catch(
      (error: unknown) => error
    );
    expect(missing).toBeInstanceOf(ResearchLensError);
    expect(missing).toMatchObject({ code: "NOT_CONFIGURED" });
    return expect(unused).not.toHaveBeenCalled();
  });
});

describe("on-demand TRUE SLAP score", () => {
  it("gathers Yahoo and SEC facts and scores with the stored peer median", async () => {
    const { calls, fetch } = router({ ...lensRoutes(), ...marketRoutes() });
    const output = await scoreDeepValueSymbol(config, "AAA", options(fetch));
    expect(output).toMatchObject({
      symbol: "AAA",
      name: "Alpha Industries",
      industry: "Metal Fabrications",
      roles: ["requested"],
      price: 8,
      marketCap: 80e6,
      errors: [],
      peerMedian: { evSales: 1, n: 9 },
      asOf: "2025-12-07",
    });
    expect(output.criteria["upside"]?.evidence).toContain("(n=9)");
    expect(output.criteria["longevity"]?.evidence).toBe(
      "16 years of SEC financial data (since 2010)."
    );
    const sec = calls.find((call) => call.url.includes("companyfacts"));
    expect(sec?.url).toBe(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000001234.json"
    );
    return expect(sec?.init.headers).toMatchObject({
      "user-agent": expect.stringContaining("vertex-research"),
    });
  });

  it("scores without peers when no stored ranking is reachable", async () => {
    const { fetch } = router(marketRoutes());
    const output = await scoreDeepValueSymbol(null, "AAA", options(fetch));
    expect(output.peerMedian).toBeNull();
    expect(output.industry).toBeNull();
    return expect(output.criteria["upside"]?.evidence).toContain("Fallback");
  });

  it("maps class-share tickers for Yahoo and SEC and reuses the SEC ticker list", async () => {
    const { calls, fetch } = router(marketRoutes());
    const first = await gatherDeepValueFacts(
      "BRK.B",
      undefined,
      options(fetch)
    );
    expect(first.facts.cik).toBe(77);
    await gatherDeepValueFacts("AAA", "Banks", options(fetch));
    expect(
      calls.filter((call) => call.url.endsWith("company_tickers.json"))
    ).toHaveLength(1);
    return expect(
      calls.some((call) => call.url.includes("/chart/BRK-B?"))
    ).toBe(true);
  });

  it("records per-source failures and keeps SEC data when Yahoo has no bars", async () => {
    const { fetch } = router({
      ...marketRoutes(),
      "https://query1.finance.yahoo.com/v8/finance/chart/": () =>
        jsonResponse({ chart: { result: null } }),
    });
    const result = await gatherDeepValueFacts("AAA", undefined, options(fetch));
    expect(result.errors).toEqual(["prices: Yahoo chart has no daily bars"]);
    return expect(result.facts).toMatchObject({
      name: "ALPHA INDUSTRIES INC",
      revenue: 200e6,
    });
  });

  it("uses the SEC title when Yahoo has no name and skips a 404 companyfacts document", async () => {
    const { fetch } = router({
      ...marketRoutes(),
      "https://query1.finance.yahoo.com/v8/finance/chart/": () =>
        jsonResponse(yahooChart(null)),
      "https://data.sec.gov/api/xbrl/companyfacts/": () =>
        new Response("", { status: 404 }),
    });
    const result = await gatherDeepValueFacts("AAA", undefined, options(fetch));
    expect(result.errors).toEqual([]);
    expect(result.facts.name).toBe("ALPHA INDUSTRIES INC");
    return expect(result.facts).not.toHaveProperty("debtTagMissing");
  });

  it("records schema, HTTP and unknown failures and a ticker missing from SEC", async () => {
    const { fetch } = router({
      ...marketRoutes(),
      "https://query1.finance.yahoo.com/v8/finance/chart/": () =>
        jsonResponse({ chart: {} }),
      "https://data.sec.gov/api/xbrl/companyfacts/": () =>
        jsonResponse({}, { status: 500 }),
    });
    expect(
      (await gatherDeepValueFacts("AAA", undefined, options(fetch))).errors
    ).toEqual([
      "prices: Yahoo chart failed schema validation",
      "sec: SEC companyfacts returned HTTP 500",
    ]);
    const missing = await gatherDeepValueFacts(
      "NOPE",
      undefined,
      options(fetch)
    );
    expect(missing.errors).toHaveLength(1);
    expect(missing.facts).not.toHaveProperty("cik");
    clearResearchLensCacheForTesting();
    const empty = await gatherDeepValueFacts("AAA", undefined, {
      now: () => at,
      fetch: async (url) => {
        if (url.includes("company_tickers")) return jsonResponse(null);
        throw new Error("socket closed");
      },
    });
    expect(empty.errors).toEqual(["prices: Yahoo chart request failed"]);
    clearResearchLensCacheForTesting();
    const odd = await gatherDeepValueFacts("AAA", undefined, {
      fetch,
      now: () => {
        // A thrown non-Error value is reported generically.
        throw "clock failed";
      },
    });
    return expect(odd.errors).toEqual([
      "prices: Yahoo chart failed schema validation",
      "sec: request failed",
    ]);
  });

  it("uses the real clock by default", async () => {
    const { fetch } = router(marketRoutes());
    const result = await gatherDeepValueFacts("AAA", undefined, { fetch });
    expect(result.errors).toEqual([]);
    return expect(result.facts.yearsReporting).toBe(
      new Date().getUTCFullYear() - 2010
    );
  });

  return it("fails with NOT_FOUND when neither source answers", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const failure = await scoreDeepValueSymbol(
      config,
      "ZZZZ",
      options(fetch)
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResearchLensError);
    return expect(failure).toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("No price or SEC data for ZZZZ"),
    });
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
  researchLenses: DeployStatusConfig | null,
  marketHistory: DeployStatusConfig | null = null
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
      researchLenses,
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
  const error = await promise.then(
    () => new Error("Expected the oRPC call to fail"),
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ORPCError);
  return expect(error).toMatchObject({ code, status });
};

describe("researchLenses procedures", () => {
  it("are operator-only and never call upstream for denied callers", async () => {
    const doFetch = vi.fn(async () => jsonResponse(rotationDocument()));
    setResearchLensOptionsForTesting({ fetch: doFetch, now: () => at });
    await expectCode(
      clientFor(null, config).researchLenses.rotationMatrix({ period: "1M" }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), config).researchLenses.deepValue({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor(session("outsider"), config).researchLenses.deepValueScore({
        symbol: "AAA",
      }),
      "FORBIDDEN",
      403
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("return lens data to operators", async () => {
    const { fetch } = router({ ...lensRoutes(), ...marketRoutes() });
    setResearchLensOptionsForTesting(options(fetch));
    const client = clientFor(session("operator"), config);
    const matrix = await client.researchLenses.rotationMatrix({});
    expect(matrix.period).toBe("1M");
    expect(JSON.stringify(matrix)).not.toContain(TOKEN);
    expect((await client.researchLenses.deepValue({})).rows).toHaveLength(1);
    const score = await client.researchLenses.deepValueScore({
      symbol: " aaa ",
    });
    return expect(score.symbol).toBe("AAA");
  });

  it("map typed and unexpected failures", async () => {
    const client = clientFor(session("operator"), null);
    await expectCode(
      client.researchLenses.rotationMatrix({ period: "1D" }),
      "NOT_CONFIGURED",
      503
    );
    await expectCode(
      client.researchLenses.deepValue({}),
      "NOT_CONFIGURED",
      503
    );
    setResearchLensOptionsForTesting({
      fetch: async () => new Response("", { status: 404 }),
      now: () => at,
    });
    await expectCode(
      client.researchLenses.deepValueScore({ symbol: "ZZZZ" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.researchLenses.deepValueScore({ symbol: "not a ticker" }),
      "BAD_REQUEST",
      400
    );
    setResearchLensOptionsForTesting({
      fetch: async () => new Response("", { status: 404 }),
      now: () => {
        throw new Error("clock failed");
      },
    });
    const configured = clientFor(session("operator"), config);
    await expectCode(
      configured.researchLenses.rotationMatrix({ period: "1M" }),
      "UPSTREAM_ERROR",
      502
    );
    return await expectCode(
      configured.researchLenses.deepValue({}),
      "UPSTREAM_ERROR",
      502
    );
  });

  return it("are not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("researchLenses");
    return expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("researchLenses"))
    ).toBe(false);
  });
});

describe("deep value prices from IBKR history", () => {
  const DAY_MS = 86_400_000;
  const days = (from: number, count: number, close: number, lots = 10) =>
    Array.from({ length: count }, (_, index) =>
      historyBar((from + index * DAY_MS) / 1000, close + index / 100, lots)
    );
  const historyRoute =
    (answer: (url: string) => Response): Route =>
    (url) =>
      answer(url);
  const yahooCalls = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.includes("finance.yahoo.com"));

  afterEach(() => {
    resetIbkrPacing();
  });

  it("reads one year of IBKR ADJUSTED_LAST bars without a Yahoo request", async () => {
    const { calls, fetch } = router({
      ...marketRoutes(),
      ...lensRoutes(),
      [HISTORY_CONFIG.url]: historyRoute((url) =>
        historyResponse(url, days(Date.UTC(2025, 9, 21), 366, 8), {
          longName: "Alpha Industries Inc",
        })
      ),
    });
    const result = await gatherDeepValueFacts("AAA", undefined, {
      ...options(fetch),
      marketHistory: HISTORY_CONFIG,
    });
    expect(result.errors).toEqual([]);
    expect(yahooCalls(calls)).toEqual([]);
    const history = calls.find((call) =>
      call.url.startsWith(HISTORY_CONFIG.url)
    );
    expect(history?.url).toContain("whatToShow=ADJUSTED_LAST");
    expect(history?.url).toContain("duration=1+Y");
    expect(result.facts).toMatchObject({
      asOf: "2026-10-21",
      // 10 lots of 100 shares.
      avgVolume: 1000,
      // Never IBKR's contract name: with no Yahoo name for the symbol yet, the SEC title.
      name: "ALPHA INDUSTRIES INC",
      price: 11.65,
    });
    // After a Yahoo read, IBKR reads keep that Yahoo name.
    await gatherDeepValueFacts("AAA", undefined, options(fetch));
    resetIbkrPacing();
    const again = await gatherDeepValueFacts("AAA", undefined, {
      ...options(fetch),
      marketHistory: HISTORY_CONFIG,
    });
    expect(again.facts.name).toBe("Alpha Industries");
    // The procedure passes context.marketHistory.
    setResearchLensOptionsForTesting(options(fetch));
    const score = await clientFor(
      session("operator"),
      config,
      HISTORY_CONFIG
    ).researchLenses.deepValueScore({ symbol: "AAA" });
    expect(score.symbol).toBe("AAA");
    expect(yahooCalls(calls)).toHaveLength(1);
  });

  it("uses the real clock and global fetch by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    const result = await gatherDeepValueFacts("AAA", undefined, {
      marketHistory: HISTORY_CONFIG,
    });
    expect(result.errors).toHaveLength(2);
  });

  it("reads Yahoo when IBKR fails", async () => {
    const { calls, fetch } = router({
      ...marketRoutes(),
      [HISTORY_CONFIG.url]: historyRoute(() =>
        jsonResponse({ error: "down" }, { status: 503 })
      ),
    });
    const result = await gatherDeepValueFacts("AAA", undefined, {
      ...options(fetch),
      marketHistory: HISTORY_CONFIG,
    });
    expect(yahooCalls(calls)).toHaveLength(1);
    expect(result.facts).toMatchObject({
      avgVolume: 500_000,
      name: "Alpha Industries",
    });
  });

  it("fills the days before IBKR's late first bar from Yahoo with continuous volume", async () => {
    // Yahoo: 39 days at 10 through 2026-10-11, 1000 shares a day.
    const first = Date.UTC(2026, 8, 2) / 1000;
    const { calls, fetch } = router({
      ...marketRoutes(),
      "https://query1.finance.yahoo.com/v8/finance/chart/": () =>
        jsonResponse({
          chart: {
            result: [
              {
                meta: { longName: "Alpha Industries" },
                timestamp: Array.from(
                  { length: 40 },
                  (_, index) => first + 52_200 + index * 86_400
                ),
                indicators: {
                  quote: [
                    {
                      // The first row has no close and is dropped.
                      close: Array.from({ length: 40 }, (_, index) =>
                        index === 0 ? null : 10
                      ),
                      volume: Array.from({ length: 40 }, () => 1000),
                    },
                  ],
                },
              },
            ],
          },
        }),
      // IBKR: 10 days at 20 from 2026-10-12, 10 lots of 100 shares a day, no long name.
      [HISTORY_CONFIG.url]: historyRoute((url) =>
        historyResponse(url, days(Date.UTC(2026, 9, 12), 10, 20))
      ),
    });
    const result = await gatherDeepValueFacts("AAA", undefined, {
      ...options(fetch),
      marketHistory: HISTORY_CONFIG,
    });
    expect(yahooCalls(calls)).toHaveLength(1);
    expect(result.facts).toMatchObject({
      asOf: "2026-10-21",
      avgVolume: 1000,
      high52: 20.09,
      low52: 10,
      name: "Alpha Industries",
      price: 20.09,
    });
  });
});
