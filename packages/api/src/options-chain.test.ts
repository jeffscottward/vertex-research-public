import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { OptionsChainOutput } from "./contracts/options-chain.ts";
import { OPTIONS_CHAIN_PRIORITY } from "./options-chain-merge.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import { setOptionsAnalyticsForTesting } from "./server/options-analytics.ts";
import { setOptionsChainForTesting } from "./server/options-chain.ts";
import {
  type OptionsAnalyticsSnapshot,
  type OptionsAnalyticsSource,
  type OptionsChainSnapshot,
  type OptionsChainSource,
  OptionsChainSourceError,
  OptionsChainSourceOff,
  type OptionsQuoteSnapshot,
  type OptionsQuoteSource,
} from "./server/options-chain-source.ts";
import {
  createYahooOptionsSource,
  parseYahooOptions,
  type YahooFetch,
} from "./server/options-chain-yahoo.ts";
import fixture from "./server/options-chain-yahoo.fixture.json" with {
  type: "json",
};
import type {
  QuantDataConfig,
  QuantDataFetch,
} from "./server/quantdata-client.ts";

const NOW = new Date("2026-11-04T20:00:00.000Z");

afterEach(() => {
  setOptionsChainForTesting();
  setOptionsAnalyticsForTesting({});
  vi.restoreAllMocks();
});

// Recorded-shape Yahoo document with fictional values (symbol DEMO, spot 100).
const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });

const sessionResponse = (): Response =>
  new Response("", {
    headers: [
      ["set-cookie", "A3=d=dummy-cookie; Expires=Thu, 01 Jan 2027; Secure"],
      ["set-cookie", "flag; Secure"],
    ],
    status: 404,
  });

// Routes Yahoo URLs to canned responses; `options` answers the v7 options requests.
const yahooFetch = (
  options: (url: string, call: number) => Response | Promise<Response>,
  crumb = "dummyCrumb1"
) => {
  let optionCalls = 0;
  return vi.fn<YahooFetch>(async (url) => {
    if (url.startsWith("https://fc.yahoo.com")) return sessionResponse();
    if (url.includes("/getcrumb")) return new Response(crumb, { status: 200 });
    optionCalls += 1;
    return options(url, optionCalls);
  });
};

describe("parseYahooOptions", () => {
  it("normalizes the quote, expiries and contracts", () => {
    const snapshot = parseYahooOptions(fixture, "DEMO");
    expect(snapshot).toMatchObject({
      currency: "USD",
      dividendYield: 0.01,
      expiries: ["2026-11-06", "2026-11-20", "2026-12-18", "2027-01-15"],
      expiry: "2026-11-06",
      quoteTime: "2026-11-04T20:00:00.000Z",
      spot: 100,
      symbol: "DEMO",
    });
    expect(snapshot.calls.map((row) => row.strike)).toEqual([90, 100, 110]);
    expect(snapshot.calls[0]).toEqual({
      ask: 10.4,
      bid: 10.1,
      change: 0.4,
      contractSymbol: "DEMO261106C00090000",
      inTheMoney: true,
      iv: 0.41,
      last: 10.2,
      lastTradeAt: "2026-11-04T18:03:05.000Z",
      openInterest: 340,
      strike: 90,
      volume: 12,
    });
    // Placeholder IV, missing change and trade time.
    expect(snapshot.calls[2]).toMatchObject({
      change: null,
      iv: null,
      lastTradeAt: null,
    });
    // Negative and non-numeric values become null; counts are whole numbers.
    expect(snapshot.puts[1]).toMatchObject({
      bid: null,
      openInterest: 1500,
      volume: null,
    });
    expect(snapshot.puts[2]).toMatchObject({ inTheMoney: false, volume: null });
  });

  it("handles sparse documents and reports bad ones", () => {
    expect(
      parseYahooOptions(
        { optionChain: { result: [{ quote: { regularMarketPrice: 0 } }] } },
        "EMPTY"
      )
    ).toEqual({
      calls: [],
      currency: null,
      dividendYield: null,
      expiries: [],
      expiry: null,
      puts: [],
      quoteTime: null,
      spot: null,
      symbol: "EMPTY",
    });
    expect(
      parseYahooOptions(
        {
          optionChain: {
            result: [
              {
                options: [{ expirationDate: 1_793_923_200 }],
                quote: { trailingAnnualDividendYield: -1 },
              },
            ],
          },
        },
        "X"
      )
    ).toMatchObject({ dividendYield: null, expiry: "2026-11-06" });
    expect(() =>
      parseYahooOptions({ optionChain: { result: [] } }, "NONE")
    ).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }) as unknown as Error
    );
    expect(() => parseYahooOptions({ finance: {} }, "X")).toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );
  });
});

describe("createYahooOptionsSource", () => {
  it("opens one session, sends the crumb and cookie, and selects an expiry", async () => {
    const doFetch = yahooFetch(() => json(fixture));
    const source = createYahooOptionsSource({ fetch: doFetch });
    const nearest = await source.read("DEMO");
    expect(nearest.expiry).toBe("2026-11-06");
    await source.read("BRK.B", "2026-11-20");
    const urls = doFetch.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      "https://fc.yahoo.com/",
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      "https://query2.finance.yahoo.com/v7/finance/options/DEMO?formatted=false&crumb=dummyCrumb1",
      "https://query2.finance.yahoo.com/v7/finance/options/BRK.B?formatted=false&date=1795132800&crumb=dummyCrumb1",
    ]);
    const headers = doFetch.mock.calls[2]?.[1].headers as Record<
      string,
      string
    >;
    expect(headers["cookie"]).toBe("A3=d=dummy-cookie");
    expect(doFetch.mock.calls[2]?.[1].redirect).toBe("manual");
  });

  it("renews the session once after HTTP 401", async () => {
    const doFetch = yahooFetch((_url, call) =>
      call === 1 ? json({}, { status: 401 }) : json(fixture)
    );
    const source = createYahooOptionsSource({ fetch: doFetch });
    await expect(source.read("DEMO")).resolves.toMatchObject({ spot: 100 });
    expect(
      doFetch.mock.calls.filter(([url]) => url.includes("getcrumb"))
    ).toHaveLength(2);
  });

  it("maps HTTP and body failures to typed errors without secrets", async () => {
    const cases: readonly [Response, string][] = [
      [json({}, { status: 404 }), "NOT_FOUND"],
      [json({}, { status: 429 }), "UNAVAILABLE"],
      [json({}, { status: 503 }), "UNAVAILABLE"],
      [json({}, { status: 403 }), "UPSTREAM_ERROR"],
      [new Response("not json", { status: 200 }), "UPSTREAM_ERROR"],
      [
        new Response("x", {
          headers: { "content-length": String(7 * 1024 * 1024) },
          status: 200,
        }),
        "UPSTREAM_ERROR",
      ],
    ];
    for (const [response, code] of cases) {
      const source = createYahooOptionsSource({
        fetch: yahooFetch(() => response.clone()),
      });
      const error = await source.read("DEMO").catch((failure) => failure);
      expect(error).toBeInstanceOf(OptionsChainSourceError);
      expect(error).toMatchObject({ code });
      expect(String(error.message)).not.toContain("dummy");
    }
  });

  it("fails when the session cannot start, and retries it next time", async () => {
    let cookie = false;
    const doFetch = vi.fn<YahooFetch>(async (url) => {
      if (url.startsWith("https://fc.yahoo.com"))
        return cookie ? sessionResponse() : new Response("", { status: 404 });
      if (url.includes("/getcrumb"))
        return new Response("<html>", { status: 200 });
      return json(fixture);
    });
    const source = createYahooOptionsSource({ fetch: doFetch });
    await expect(source.read("DEMO")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Yahoo did not start a session",
    });
    cookie = true;
    await expect(source.read("DEMO")).rejects.toMatchObject({
      message: "Yahoo did not issue a session token",
    });
    const denied = createYahooOptionsSource({
      fetch: async (url) =>
        url.startsWith("https://fc.yahoo.com")
          ? sessionResponse()
          : new Response("", { status: 401 }),
    });
    await expect(denied.read("DEMO")).rejects.toMatchObject({
      message: "Yahoo did not issue a session token",
    });
  });

  it("reports network failures and timeouts as unavailable", async () => {
    const source = createYahooOptionsSource({
      fetch: async () => {
        throw new TypeError("network down");
      },
      timeoutMs: 5,
    });
    await expect(source.read("DEMO")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Yahoo options request failed or timed out",
    });
  });

  it("uses global fetch by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).startsWith("https://fc.yahoo.com")
          ? sessionResponse()
          : String(input).includes("getcrumb")
            ? new Response("c", { status: 200 })
            : json(fixture)
      );
    await expect(
      createYahooOptionsSource().read("DEMO")
    ).resolves.toMatchObject({ symbol: "DEMO" });
    spy.mockRestore();
  });
});

const snapshot: OptionsChainSnapshot = parseYahooOptions(fixture, "DEMO");

// Quant Data and IBKR values that differ from the Yahoo fixture (call 100: bid 1.3, ask 1.4,
// IV 0.28, open interest 2210; spot 100). Quant Data is the first source: spot 100.5.
const ibkrSnapshot: OptionsQuoteSnapshot = {
  asOf: "2026-11-04T19:59:58Z",
  expiries: ["2026-11-06", "2026-11-13", "2026-11-20"],
  expiry: "2026-11-06",
  quotes: [{ ask: 1.42, bid: 1.38, right: "call", strike: 100 }],
  spot: 100.2,
  warning: null,
};
const quantDataRow = {
  delta: 0.55,
  expiry: "2026-11-06",
  flow: { premium: 125_000, trades: 3, volume: 410 },
  iv: 0.31,
  openInterest: 2500,
  right: "call",
  strike: 100,
} as const;
const quantDataSnapshot: OptionsAnalyticsSnapshot = {
  expiries: ["2026-11-06", "2026-11-27"],
  flowFirstPageOnly: false,
  rows: [
    quantDataRow,
    // Another expiry, which only Quant Data lists.
    { ...quantDataRow, expiry: "2026-11-27", flow: null, iv: 0.4 },
  ],
  spot: 100.5,
  warning: null,
};
const HISTORY: DeployStatusConfig = {
  token: "h".repeat(43),
  url: "https://history.domain.test",
};
const QUANTDATA: QuantDataConfig = {
  apiKey: "not-a-real-key",
  baseUrl: "https://quantdata.domain.test",
};

// The vertex-history /option-chain body of the IBKR snapshot above.
const historyDocument = (overrides: Record<string, unknown> = {}) => ({
  cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 5 },
  count: 1,
  expirations: ["20261106", "20261113", "20261120"],
  expiry: "20261106",
  fetchedAt: "2026-11-04T19:59:58Z",
  quotes: [
    {
      ask: 1.42,
      bid: 1.38,
      dataType: "live",
      error: null,
      right: "C",
      strike: 100,
    },
  ],
  schema: "vertex-history-option-chain-v1",
  underlying: { dataType: "live", price: 100.2 },
  ...overrides,
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-05T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

const apiFor = (
  requestSession: SafeAuthSession | null,
  configured: Readonly<{
    marketHistory?: DeployStatusConfig;
    quantData?: QuantDataConfig;
  }> = {}
) => {
  const repositories = {} as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: ["operator@domain.test"],
      repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      ...configured,
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string
): Promise<void> => {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({ code });
};

const yahooFake = (
  read: OptionsChainSource["read"]
): { read: Mock<OptionsChainSource["read"]> } => ({ read: vi.fn(read) });
const ibkrFake = (
  read: OptionsQuoteSource["read"]
): { read: Mock<OptionsQuoteSource["read"]> } => ({ read: vi.fn(read) });
const quantDataFake = (
  read: OptionsAnalyticsSource["read"]
): { read: Mock<OptionsAnalyticsSource["read"]> } => ({ read: vi.fn(read) });

const operator = () => apiFor(session("operator"));
const atmCall = (chain: OptionsChainOutput) =>
  chain.rows.find((row) => row.strike === 100)?.call;

describe("optionsChain procedures", () => {
  it("are operator-only and validate input", async () => {
    const source = yahooFake(async () => snapshot);
    setOptionsChainForTesting({ now: () => NOW, yahoo: source });
    await expectCode(
      apiFor(null).optionsChain.expiries({ symbol: "DEMO" }),
      "UNAUTHORIZED"
    );
    await expectCode(
      apiFor(session("outsider")).optionsChain.chain({ symbol: "DEMO" }),
      "FORBIDDEN"
    );
    await expectCode(
      operator().optionsChain.chain({ expiry: "2026-13-40", symbol: "DEMO" }),
      "BAD_REQUEST"
    );
    await expectCode(
      operator().optionsChain.expiries({ symbol: "1BAD" }),
      "BAD_REQUEST"
    );
    expect(source.read).not.toHaveBeenCalled();
  });

  it("lists expiries and returns the nearest chain from one cached read", async () => {
    const source = yahooFake(async () => snapshot);
    let now = NOW;
    setOptionsChainForTesting({ now: () => now, yahoo: source });
    const api = operator();
    const listed = await api.optionsChain.expiries({ symbol: "demo" });
    expect(listed.expiries[0]).toEqual({ date: "2026-11-06", dte: 2 });
    expect(listed).not.toHaveProperty("rows");
    expect(listed).toMatchObject({
      expiriesSources: ["yahoo"],
      sources: [
        { source: "quantdata", status: "off" },
        { source: "ibkr", status: "off" },
        { message: null, source: "yahoo", status: "used" },
      ],
      spot: 100,
      spotSource: "yahoo",
    });
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiry).toBe("2026-11-06");
    expect(chain.rows).toHaveLength(5);
    expect(chain.sources).toEqual(listed.sources);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledWith("DEMO", undefined);
    now = new Date(NOW.getTime() + 61_000);
    await api.optionsChain.chain({ symbol: "DEMO" });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("returns a selected expiry and refuses one that is not listed", async () => {
    const source = yahooFake(async (_symbol, expiry) => ({
      ...snapshot,
      expiry: expiry === "2026-11-20" ? "2026-11-20" : "2026-11-06",
    }));
    setOptionsChainForTesting({ now: () => NOW, yahoo: source });
    const api = operator();
    await expect(
      api.optionsChain.chain({ expiry: "2026-11-20", symbol: "DEMO" })
    ).resolves.toMatchObject({ dte: 16, expiry: "2026-11-20" });
    await expectCode(
      api.optionsChain.chain({ expiry: "2026-11-27", symbol: "DEMO" }),
      "NOT_FOUND"
    );
    // The answer for the unlisted expiry is cached like any other.
    await expectCode(
      api.optionsChain.chain({ expiry: "2026-11-27", symbol: "DEMO" }),
      "NOT_FOUND"
    );
    expect(source.read).toHaveBeenCalledTimes(2);
    setOptionsChainForTesting({
      now: () => NOW,
      yahoo: yahooFake(async () => ({ ...snapshot, expiry: null })),
    });
    await expectCode(
      operator().optionsChain.chain({ symbol: "NOOPT" }),
      "NOT_FOUND"
    );
    // The quote fields of a symbol without options are still served.
    await expect(
      operator().optionsChain.expiries({ symbol: "NOOPT" })
    ).resolves.toMatchObject({ spot: 100, spotSource: "yahoo" });
  });

  it("moves past an expiry that closed today and explains a closed expiry", async () => {
    const afterClose = new Date("2026-11-06T22:00:00.000Z");
    const source = yahooFake(async (_symbol, expiry) => ({
      ...snapshot,
      expiry: expiry ?? "2026-11-06",
    }));
    setOptionsChainForTesting({ now: () => afterClose, yahoo: source });
    const api = operator();
    const nearest = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(source.read).toHaveBeenLastCalledWith("DEMO", "2026-11-20");
    expect(nearest.expiry).toBe("2026-11-20");
    expect(nearest.expiries.map((item) => item.date)).not.toContain(
      "2026-11-06"
    );
    const closed = await api.optionsChain.chain({
      expiry: "2026-11-06",
      symbol: "DEMO",
    });
    expect(closed.expiries[0]?.date).toBe("2026-11-06");
    expect(closed.notes.join(" ")).toContain("This expiry has closed");
    expect(
      closed.rows.every((row) => (row.call?.greeks ?? null) === null)
    ).toBe(true);
    // Nothing later is listed: the closed expiry stays.
    setOptionsChainForTesting({
      now: () => afterClose,
      yahoo: yahooFake(async () => ({
        ...snapshot,
        expiries: ["2026-11-06"],
        expiry: "2026-11-06",
      })),
    });
    const only = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(only.expiry).toBe("2026-11-06");
  });

  it("maps adapter failures and does not cache them", async () => {
    const source = yahooFake(async (symbol) => {
      if (symbol === "BAD")
        throw new OptionsChainSourceError(
          "UPSTREAM_ERROR",
          "Yahoo options returned HTTP 403"
        );
      if (symbol === "ODD") throw new Error("unexpected");
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo options returned HTTP 503"
      );
    });
    setOptionsChainForTesting({ now: () => NOW, yahoo: source });
    const api = operator();
    await expectCode(
      api.optionsChain.chain({ symbol: "BAD" }),
      "UPSTREAM_ERROR"
    );
    await expectCode(
      api.optionsChain.expiries({ symbol: "ODD" }),
      "UNAVAILABLE"
    );
    await expectCode(
      api.optionsChain.expiries({ symbol: "DOWN" }),
      "UNAVAILABLE"
    );
    await expectCode(
      api.optionsChain.expiries({ symbol: "DOWN" }),
      "UNAVAILABLE"
    );
    expect(source.read).toHaveBeenCalledTimes(4);
  });

  it("evicts the oldest cache entries past 200 and defaults to Yahoo", async () => {
    const source = yahooFake(async () => snapshot);
    setOptionsChainForTesting({ now: () => NOW, yahoo: source });
    const api = operator();
    for (let index = 0; index < 202; index += 1)
      await api.optionsChain.expiries({ symbol: `S${index}` });
    await api.optionsChain.expiries({ symbol: "S0" });
    expect(source.read).toHaveBeenCalledTimes(203);
    setOptionsChainForTesting();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("offline");
    });
    await expectCode(
      api.optionsChain.expiries({ symbol: "DEMO" }),
      "UNAVAILABLE"
    );
    expect(spy).toHaveBeenCalled();
  });
});

describe("optionsChain source fallback", () => {
  const yahoo = () => yahooFake(async () => snapshot);
  const yahooDown = () =>
    yahooFake(async () => {
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo options returned HTTP 503"
      );
    });

  it("IBKR live quote present: bid and ask are the IBKR values", async () => {
    const ibkr = ibkrFake(async () => ibkrSnapshot);
    setOptionsChainForTesting({ ibkr, now: () => NOW, yahoo: yahoo() });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      ask: 1.42,
      bid: 1.38,
      sources: { quote: "ibkr" },
    });
    expect(chain.sources[1]).toEqual({
      message: null,
      source: "ibkr",
      status: "used",
    });
    // A contract without an IBKR quote keeps the Yahoo pair.
    expect(chain.rows[0]?.call).toMatchObject({
      ask: 10.4,
      bid: 10.1,
      sources: { quote: "yahoo" },
    });
    expect(ibkr.read).toHaveBeenCalledWith("DEMO", undefined);
    expect(chain.notes.join(" ")).toContain("IBKR live quotes for 1");
  });

  it("IBKR failed: bid and ask are the Yahoo values and the status says failed", async () => {
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => {
        throw new OptionsChainSourceError(
          "UNAVAILABLE",
          "IBKR option quotes request failed or timed out"
        );
      }),
      now: () => NOW,
      yahoo: yahoo(),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { quote: "yahoo" },
    });
    expect(chain.sources[1]).toEqual({
      message: "IBKR option quotes request failed or timed out",
      source: "ibkr",
      status: "failed",
    });
  });

  it("IBKR off (not configured): bid and ask are the Yahoo values and the status says off", async () => {
    setOptionsChainForTesting({ now: () => NOW, yahoo: yahoo() });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { quote: "yahoo" },
    });
    expect(chain.sources[1]).toEqual({
      message: "IBKR history service is not configured",
      source: "ibkr",
      status: "off",
    });
  });

  it("IBKR outside the session: no IBKR request, Yahoo bid and ask, status off", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // 17:00 New York: the regular session has closed.
    const evening = new Date("2026-11-04T22:00:00.000Z");
    setOptionsChainForTesting({ now: () => evening, yahoo: yahoo() });
    const chain = await apiFor(session("operator"), {
      marketHistory: HISTORY,
    }).optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { quote: "yahoo" },
    });
    expect(chain.sources[1]).toEqual({
      message:
        "IBKR is asked only during the US regular session (09:30 to 16:00 New York)",
      source: "ibkr",
      status: "off",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("IBKR quote not live: bid and ask are the Yahoo values and the status says empty", async () => {
    const frozen = historyDocument({
      quotes: [{ ...historyDocument().quotes[0], dataType: "frozen" }],
      underlying: { dataType: "frozen", price: 100.2 },
    });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json(frozen));
    setOptionsChainForTesting({ now: () => NOW, yahoo: yahoo() });
    const chain = await apiFor(session("operator"), {
      marketHistory: HISTORY,
    }).optionsChain.chain({ symbol: "DEMO" });
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      "https://history.domain.test/option-chain?strikes=12&symbol=DEMO"
    );
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { quote: "yahoo" },
    });
    expect(chain.sources[1]).toEqual({
      message: "IBKR answered without a live quote",
      source: "ibkr",
      status: "empty",
    });
    // Nothing of that answer is used: Yahoo also gives the spot and the expiry list.
    expect(chain).toMatchObject({
      expiriesSources: ["yahoo"],
      spot: 100,
      spotSource: "yahoo",
    });
  });

  it("IBKR stale copy: bid and ask are the Yahoo values and the status says empty with the reason", async () => {
    const stale = historyDocument({
      cache: { ageSeconds: 120, hit: true, stale: true, ttlSeconds: 5 },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(stale));
    setOptionsChainForTesting({ now: () => NOW, yahoo: yahoo() });
    const chain = await apiFor(session("operator"), {
      marketHistory: HISTORY,
    }).optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)?.sources.quote).toBe("yahoo");
    expect(chain.sources[1]).toEqual({
      message: "IBKR sent an old copy, not live quotes",
      source: "ibkr",
      status: "empty",
    });
    expect(chain.spotSource).toBe("yahoo");
  });

  it("Quant Data present: IV, delta and open interest are tagged quantdata and flow is set", async () => {
    const quantData = quantDataFake(async () => quantDataSnapshot);
    setOptionsChainForTesting({ now: () => NOW, quantData, yahoo: yahoo() });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    const call = atmCall(chain);
    expect(call).toMatchObject({
      flow: { premium: 125_000, trades: 3, volume: 410 },
      iv: 0.31,
      openInterest: 2500,
      sources: {
        delta: "quantdata",
        iv: "quantdata",
        openInterest: "quantdata",
        quote: "yahoo",
      },
    });
    expect(call?.greeks?.delta).toBe(0.55);
    expect(chain.sources[0]).toEqual({
      message: null,
      source: "quantdata",
      status: "used",
    });
    expect(quantData.read).toHaveBeenCalledWith("DEMO");
  });

  it("Quant Data off: IV and open interest are tagged yahoo and delta model", async () => {
    setOptionsChainForTesting({ now: () => NOW, yahoo: yahoo() });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    const call = atmCall(chain);
    expect(call).toMatchObject({
      flow: null,
      iv: 0.28,
      openInterest: 2210,
      sources: { delta: "model", iv: "yahoo", openInterest: "yahoo" },
    });
    expect(call?.greeks?.delta).not.toBe(0.55);
    expect(chain.sources[0]).toEqual({
      message: "Quant Data is not configured",
      source: "quantdata",
      status: "off",
    });
  });

  it("Quant Data failed: IV and open interest are tagged yahoo and delta model", async () => {
    setOptionsChainForTesting({
      now: () => NOW,
      quantData: quantDataFake(async () => {
        throw new OptionsChainSourceError(
          "UNAVAILABLE",
          "QuantData termStructure: HTTP 500."
        );
      }),
      yahoo: yahoo(),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      flow: null,
      iv: 0.28,
      openInterest: 2210,
      sources: { delta: "model", iv: "yahoo", openInterest: "yahoo" },
    });
    expect(chain.sources[0]).toEqual({
      message: "QuantData termStructure: HTTP 500.",
      source: "quantdata",
      status: "failed",
    });
  });

  it("bid and ask: Quant Data has none, so IBKR live quotes come first and Yahoo fills", async () => {
    const quantData = quantDataFake(async () => ({
      ...quantDataSnapshot,
      rows: [
        quantDataRow,
        // A contract only Quant Data knows.
        { ...quantDataRow, right: "put", strike: 120 },
      ],
    }));
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ibkrSnapshot),
      now: () => NOW,
      quantData,
      yahoo: yahoo(),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    // Call 100: Quant Data has the row, the quote is the IBKR live pair.
    expect(atmCall(chain)).toMatchObject({
      ask: 1.42,
      bid: 1.38,
      sources: { iv: "quantdata", quote: "ibkr" },
    });
    // Call 90: no IBKR quote, Yahoo fills.
    expect(chain.rows[0]?.call).toMatchObject({
      ask: 10.4,
      bid: 10.1,
      sources: { quote: "yahoo" },
    });
    // Put 120: only Quant Data knows it, so it has no bid and ask.
    expect(chain.rows.at(-1)).toMatchObject({
      put: { ask: null, bid: null, iv: 0.31, sources: { quote: null } },
      strike: 120,
    });
    expect(chain.notes[0]).toContain(
      "Bid and ask: IBKR live quotes for 1, Yahoo Finance for 5 (of 7 contracts)."
    );
  });

  it("spot price: Quant Data, then IBKR, then Yahoo, with spotSource", async () => {
    const read = async (
      quantData: OptionsAnalyticsSnapshot | null,
      ibkr: OptionsQuoteSnapshot
    ) => {
      setOptionsChainForTesting({
        ibkr: ibkrFake(async () => ibkr),
        now: () => NOW,
        yahoo: yahoo(),
        ...(quantData === null
          ? {}
          : { quantData: quantDataFake(async () => quantData) }),
      });
      return await operator().optionsChain.chain({ symbol: "DEMO" });
    };
    // Quant Data sends no quote time.
    await expect(read(quantDataSnapshot, ibkrSnapshot)).resolves.toMatchObject({
      quoteTime: null,
      spot: 100.5,
      spotSource: "quantdata",
    });
    const noQuantDataSpot = { ...quantDataSnapshot, spot: null };
    await expect(read(noQuantDataSpot, ibkrSnapshot)).resolves.toMatchObject({
      quoteTime: "2026-11-04T19:59:58Z",
      spot: 100.2,
      spotSource: "ibkr",
    });
    // Quant Data off: IBKR is next.
    await expect(read(null, ibkrSnapshot)).resolves.toMatchObject({
      spot: 100.2,
      spotSource: "ibkr",
    });
    const noLiveSpot = { ...ibkrSnapshot, spot: null };
    await expect(read(noQuantDataSpot, noLiveSpot)).resolves.toMatchObject({
      quoteTime: "2026-11-04T20:00:00.000Z",
      spot: 100,
      spotSource: "yahoo",
    });
  });

  it("expiries: the union of the lists with expiriesSources in priority order", async () => {
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ibkrSnapshot),
      now: () => NOW,
      quantData: quantDataFake(async () => quantDataSnapshot),
      yahoo: yahoo(),
    });
    const api = operator();
    const listed = await api.optionsChain.expiries({ symbol: "DEMO" });
    expect(listed.expiriesSources).toEqual(["quantdata", "ibkr", "yahoo"]);
    // Quant Data: 11-06, 11-27. IBKR: 11-06, 11-13, 11-20. Yahoo: 11-06, 11-20, 12-18, 01-15.
    expect(listed.expiries.map((item) => item.date)).toEqual([
      "2026-11-06",
      "2026-11-13",
      "2026-11-20",
      "2026-11-27",
      "2026-12-18",
      "2027-01-15",
    ]);
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiriesSources).toEqual(listed.expiriesSources);
    expect(chain.expiries).toEqual(listed.expiries);
    expect(chain.notes[0]).toContain(
      "Expiry list: Quant Data, IBKR, Yahoo Finance."
    );
  });

  it("expiries: each source alone lists its own expiries", async () => {
    const down = <Read extends (...args: never[]) => Promise<unknown>>() =>
      (async () => {
        throw new OptionsChainSourceError("UNAVAILABLE", "Source is down");
      }) as unknown as Read;
    const listed = async (sources: {
      quantData?: OptionsAnalyticsSource["read"];
      ibkr?: OptionsQuoteSource["read"];
      yahoo?: OptionsChainSource["read"];
    }) => {
      setOptionsChainForTesting({
        ibkr: ibkrFake(sources.ibkr ?? down()),
        now: () => NOW,
        quantData: quantDataFake(sources.quantData ?? down()),
        yahoo: yahooFake(sources.yahoo ?? down()),
      });
      const output = await operator().optionsChain.chain({ symbol: "DEMO" });
      return [output.expiriesSources, output.expiries.map((item) => item.date)];
    };
    await expect(
      listed({ quantData: async () => quantDataSnapshot })
    ).resolves.toEqual([["quantdata"], quantDataSnapshot.expiries]);
    await expect(listed({ ibkr: async () => ibkrSnapshot })).resolves.toEqual([
      ["ibkr"],
      ibkrSnapshot.expiries,
    ]);
    await expect(listed({ yahoo: async () => snapshot })).resolves.toEqual([
      ["yahoo"],
      snapshot.expiries,
    ]);
  });

  it("target expiry: Quant Data's first open expiry, then IBKR's, then Yahoo's", async () => {
    // Each source has a chain for another expiry: Quant Data 11-13, IBKR 11-20, Yahoo 11-06.
    const quantData = {
      ...quantDataSnapshot,
      // 11-03 has closed: the first open expiry with a row is 11-13.
      expiries: ["2026-11-03", "2026-11-13", "2026-11-27"],
      rows: [
        { ...quantDataRow, expiry: "2026-11-03" },
        { ...quantDataRow, expiry: "2026-11-13" },
        { ...quantDataRow, expiry: "2026-11-27" },
      ],
    };
    const shown = async (
      with_: Readonly<{ quantData: boolean; ibkr: boolean }>
    ) => {
      const source = yahooFake(async (_symbol, expiry) => ({
        ...snapshot,
        expiry: expiry ?? "2026-11-06",
      }));
      setOptionsChainForTesting({
        now: () => NOW,
        yahoo: source,
        ...(with_.ibkr
          ? {
              ibkr: ibkrFake(async () => ({
                ...ibkrSnapshot,
                expiry: "2026-11-20",
              })),
            }
          : {}),
        ...(with_.quantData
          ? { quantData: quantDataFake(async () => quantData) }
          : {}),
      });
      const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
      return [chain.expiry, source.read.mock.calls.length];
    };
    // Quant Data's expiry wins. Yahoo does not list 11-13, so it is not read again.
    await expect(shown({ ibkr: true, quantData: true })).resolves.toEqual([
      "2026-11-13",
      1,
    ]);
    // Without Quant Data: IBKR's expiry, and Yahoo is read again for it.
    await expect(shown({ ibkr: true, quantData: false })).resolves.toEqual([
      "2026-11-20",
      2,
    ]);
    // Without both: Yahoo's own nearest expiry.
    await expect(shown({ ibkr: false, quantData: false })).resolves.toEqual([
      "2026-11-06",
      1,
    ]);
    // A Quant Data answer without an open expiry gives no candidate: IBKR is next.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({ ...ibkrSnapshot, expiry: "2026-11-20" })),
      now: () => NOW,
      quantData: quantDataFake(async () => ({
        ...quantData,
        expiries: ["2026-11-03"],
        rows: [{ ...quantDataRow, expiry: "2026-11-03" }],
      })),
      yahoo: yahoo(),
    });
    await expect(
      operator().optionsChain.chain({ symbol: "DEMO" })
    ).resolves.toMatchObject({ expiry: "2026-11-20" });
  });

  it("IBKR is read once: its quotes of another expiry than the target are ignored", async () => {
    const ibkr = ibkrFake(async () => ({
      ...ibkrSnapshot,
      expiry: "2026-11-20",
    }));
    setOptionsChainForTesting({
      ibkr,
      now: () => NOW,
      quantData: quantDataFake(async () => quantDataSnapshot),
      yahoo: yahoo(),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    // The target is Quant Data's 11-06; the IBKR quote is for 11-20.
    expect(chain.expiry).toBe("2026-11-06");
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { iv: "quantdata", quote: "yahoo" },
    });
    expect(ibkr.read.mock.calls).toEqual([["DEMO", undefined]]);
    // Its expiry list is still part of the union.
    expect(chain.expiriesSources).toEqual(["quantdata", "ibkr", "yahoo"]);
  });

  it("Yahoo failing with IBKR up: the chain is still served", async () => {
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ibkrSnapshot),
      now: () => NOW,
      quantData: quantDataFake(async () => quantDataSnapshot),
      yahoo: yahooDown(),
    });
    const api = operator();
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({
      currency: null,
      expiriesSources: ["quantdata", "ibkr"],
      expiry: "2026-11-06",
      sources: [
        { source: "quantdata", status: "used" },
        { source: "ibkr", status: "used" },
        {
          message: "Yahoo options returned HTTP 503",
          source: "yahoo",
          status: "failed",
        },
      ],
      spotSource: "quantdata",
    });
    expect(chain.rows).toEqual([
      {
        call: expect.objectContaining({
          ask: 1.42,
          bid: 1.38,
          contractSymbol: "DEMO261106C00100000",
          inTheMoney: true,
          last: null,
          openInterest: 2500,
          sources: {
            delta: "quantdata",
            iv: "quantdata",
            openInterest: "quantdata",
            quote: "ibkr",
          },
          volume: null,
        }) as unknown,
        put: null,
        strike: 100,
      },
    ]);
    await expect(
      api.optionsChain.expiries({ symbol: "DEMO" })
    ).resolves.toMatchObject({
      expiriesSources: ["quantdata", "ibkr"],
      spot: 100.5,
    });
    // An unexpected Yahoo error gets a fixed text, never the error's own.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ibkrSnapshot),
      now: () => NOW,
      yahoo: yahooFake(async () => {
        throw new Error("https://internal.example/?crumb=secret");
      }),
    });
    const odd = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(odd.sources[2]).toEqual({
      message: "Yahoo Finance request failed",
      source: "yahoo",
      status: "failed",
    });
    expect(JSON.stringify(odd)).not.toContain("secret");
  });

  it("Quant Data alone serves the chain when IBKR and Yahoo both fail", async () => {
    const source = yahooDown();
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => {
        throw new OptionsChainSourceError(
          "UNAVAILABLE",
          "IBKR option quotes request failed or timed out"
        );
      }),
      now: () => NOW,
      quantData: quantDataFake(async () => quantDataSnapshot),
      yahoo: source,
    });
    const api = operator();
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({
      currency: null,
      expiriesSources: ["quantdata"],
      expiry: "2026-11-06",
      sources: [
        { message: null, source: "quantdata", status: "used" },
        {
          message: "IBKR option quotes request failed or timed out",
          source: "ibkr",
          status: "failed",
        },
        {
          message: "Yahoo options returned HTTP 503",
          source: "yahoo",
          status: "failed",
        },
      ],
      spot: 100.5,
      spotSource: "quantdata",
    });
    expect(chain.expiries.map((item) => item.date)).toEqual(
      quantDataSnapshot.expiries
    );
    // IV, delta, open interest and flow from Quant Data; no quote, so the tags are null.
    expect(chain.rows).toHaveLength(1);
    const call = atmCall(chain);
    expect(call).toMatchObject({
      ask: null,
      bid: null,
      change: null,
      contractSymbol: "DEMO261106C00100000",
      flow: { premium: 125_000, trades: 3, volume: 410 },
      inTheMoney: true,
      iv: 0.31,
      last: null,
      lastTradeAt: null,
      openInterest: 2500,
      sources: {
        delta: "quantdata",
        iv: "quantdata",
        openInterest: "quantdata",
        quote: null,
      },
      volume: null,
    });
    expect(call?.greeks?.delta).toBe(0.55);
    expect(chain.notes[0]).toContain(
      "Bid and ask: no source (of 1 contracts)."
    );
    // A requested expiry that only Quant Data has is served the same way.
    const later = await api.optionsChain.chain({
      expiry: "2026-11-27",
      symbol: "DEMO",
    });
    expect(later).toMatchObject({ expiry: "2026-11-27" });
    expect(atmCall(later)).toMatchObject({
      iv: 0.4,
      sources: { iv: "quantdata", quote: null },
    });
    // The expiry list comes from the same cached read.
    await expect(
      api.optionsChain.expiries({ symbol: "DEMO" })
    ).resolves.toMatchObject({ expiriesSources: ["quantdata"], spot: 100.5 });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("Yahoo failing with Quant Data up and IBKR off: the chain is still served", async () => {
    setOptionsChainForTesting({
      now: () => NOW,
      quantData: quantDataFake(async () => quantDataSnapshot),
      yahoo: yahooDown(),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiry).toBe("2026-11-06");
    expect(chain.sources.map((item) => item.status)).toEqual([
      "used",
      "off",
      "failed",
    ]);
    expect(atmCall(chain)?.sources).toEqual({
      delta: "quantdata",
      iv: "quantdata",
      openInterest: "quantdata",
      quote: null,
    });
  });

  it("all three sources failing: the call fails with the typed error", async () => {
    const quantData = quantDataFake(async () => {
      throw new OptionsChainSourceError(
        "UNAVAILABLE",
        "QuantData termStructure: HTTP 500."
      );
    });
    const source = yahooFake(async () => {
      throw new OptionsChainSourceError(
        "UPSTREAM_ERROR",
        "Yahoo options returned HTTP 403"
      );
    });
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => {
        throw new OptionsChainSourceError(
          "NOT_FOUND",
          "IBKR lists no options for this symbol and expiry"
        );
      }),
      now: () => NOW,
      quantData,
      yahoo: source,
    });
    const api = operator();
    // Yahoo's code wins.
    await expectCode(
      api.optionsChain.chain({ symbol: "DEMO" }),
      "UPSTREAM_ERROR"
    );
    await expectCode(
      api.optionsChain.expiries({ symbol: "DEMO" }),
      "UPSTREAM_ERROR"
    );
    // Not cached: every source is read again.
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(quantData.read).toHaveBeenCalledTimes(2);
    // Quant Data answering without a row does not change that.
    setOptionsChainForTesting({
      now: () => NOW,
      quantData: quantDataFake(async () => ({
        ...quantDataSnapshot,
        expiries: [],
        rows: [],
      })),
      yahoo: yahooDown(),
    });
    await expectCode(
      operator().optionsChain.chain({ symbol: "DEMO" }),
      "UNAVAILABLE"
    );
  });

  it("both quote sources failing: the call fails with the typed error", async () => {
    const ibkrDown = (code: "NOT_FOUND" | "UPSTREAM_ERROR") =>
      ibkrFake(async () => {
        throw new OptionsChainSourceError(code, "IBKR option quotes failed");
      });
    // Yahoo's code wins when it has one.
    const source = yahooDown();
    setOptionsChainForTesting({
      ibkr: ibkrDown("NOT_FOUND"),
      now: () => NOW,
      yahoo: source,
    });
    const api = operator();
    await expectCode(api.optionsChain.chain({ symbol: "DEMO" }), "UNAVAILABLE");
    await expectCode(
      api.optionsChain.expiries({ symbol: "DEMO" }),
      "UNAVAILABLE"
    );
    // Not cached: both calls read Yahoo.
    expect(source.read).toHaveBeenCalledTimes(2);
    // Yahoo failed without a code: IBKR's code is used.
    setOptionsChainForTesting({
      ibkr: ibkrDown("UPSTREAM_ERROR"),
      now: () => NOW,
      yahoo: yahooFake(async () => {
        throw new Error("unexpected");
      }),
    });
    await expectCode(
      operator().optionsChain.chain({ symbol: "DEMO" }),
      "UPSTREAM_ERROR"
    );
    // IBKR answered without a live quote and Yahoo is not asked: nothing to serve.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({ ...ibkrSnapshot, quotes: [], spot: null })),
      now: () => NOW,
      yahoo: yahooFake(async () => {
        throw new OptionsChainSourceOff("Not asked");
      }),
    });
    await expectCode(
      operator().optionsChain.chain({ symbol: "DEMO" }),
      "UNAVAILABLE"
    );
  });

  it("shows the IBKR expiry and reads Yahoo again for it", async () => {
    const later = { ...ibkrSnapshot, expiry: "2026-11-20", quotes: [] };
    const source = yahooFake(async (_symbol, expiry) => ({
      ...snapshot,
      expiry: expiry ?? "2026-11-06",
    }));
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => later),
      now: () => NOW,
      yahoo: source,
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({ dte: 16, expiry: "2026-11-20" });
    expect(source.read.mock.calls).toEqual([
      ["DEMO", undefined],
      ["DEMO", "2026-11-20"],
    ]);
    expect(atmCall(chain)?.sources.quote).toBe("yahoo");
    // Yahoo does not list the IBKR expiry: no second read, the chain comes from IBKR.
    const unlisted = yahooFake(async () => snapshot);
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({ ...ibkrSnapshot, expiry: "2026-11-13" })),
      now: () => NOW,
      yahoo: unlisted,
    });
    const ibkrOnly = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(ibkrOnly.expiry).toBe("2026-11-13");
    expect(ibkrOnly.rows.map((row) => row.strike)).toEqual([100]);
    expect(unlisted.read).toHaveBeenCalledTimes(1);
    // The second Yahoo read fails: IBKR still serves the chain.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({ ...ibkrSnapshot, expiry: "2026-11-20" })),
      now: () => NOW,
      yahoo: yahooFake(async (_symbol, expiry) => {
        if (expiry !== undefined)
          throw new OptionsChainSourceError(
            "UNAVAILABLE",
            "Yahoo options returned HTTP 503"
          );
        return snapshot;
      }),
    });
    const served = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(served.expiry).toBe("2026-11-20");
    expect(served.sources[2].status).toBe("failed");
    // An IBKR answer for another expiry than the requested one gives no quotes.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ibkrSnapshot),
      now: () => NOW,
      yahoo: yahooFake(async () => ({ ...snapshot, expiry: "2026-11-20" })),
    });
    const requested = await operator().optionsChain.chain({
      expiry: "2026-11-20",
      symbol: "DEMO",
    });
    expect(atmCall(requested)?.sources.quote).toBe("yahoo");
  });

  it("IBKR live spot but no live option quote, for an expiry Yahoo does not list: the Yahoo chain is served", async () => {
    const source = yahoo();
    setOptionsChainForTesting({
      // Yahoo lists 2026-11-06 and 2026-11-20, not 2026-11-13.
      ibkr: ibkrFake(async () => ({
        ...ibkrSnapshot,
        expiry: "2026-11-13",
        quotes: [],
      })),
      now: () => NOW,
      yahoo: source,
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({
      expiriesSources: ["ibkr", "yahoo"],
      expiry: "2026-11-06",
      spot: 100.2,
      spotSource: "ibkr",
    });
    expect(chain.rows).toHaveLength(5);
    expect(atmCall(chain)).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      sources: { quote: "yahoo" },
    });
    // Quant Data off, IBKR used (spot and expiry list), Yahoo used.
    expect(chain.sources.map((item) => item.status)).toEqual([
      "off",
      "used",
      "used",
    ]);
    expect(source.read.mock.calls).toEqual([["DEMO", undefined]]);
  });

  it("the second Yahoo read fails and IBKR has no live quote: the first Yahoo chain is served", async () => {
    const source = yahooFake(async (_symbol, expiry) => {
      if (expiry !== undefined)
        throw new OptionsChainSourceError(
          "UNAVAILABLE",
          "Yahoo options returned HTTP 503"
        );
      return snapshot;
    });
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({
        ...ibkrSnapshot,
        expiry: "2026-11-20",
        quotes: [],
      })),
      now: () => NOW,
      yahoo: source,
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiry).toBe("2026-11-06");
    expect(chain.rows).toHaveLength(5);
    expect(chain.sources[2]).toEqual({
      message: null,
      source: "yahoo",
      status: "used",
    });
    expect(chain.spotSource).toBe("ibkr");
    expect(source.read.mock.calls).toEqual([
      ["DEMO", undefined],
      ["DEMO", "2026-11-20"],
    ]);
  });

  it("an empty second Yahoo answer for the IBKR expiry: the first Yahoo chain is served", async () => {
    const source = yahooFake(async (_symbol, expiry) =>
      expiry === undefined
        ? snapshot
        : { ...snapshot, calls: [], expiry, puts: [] }
    );
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({
        ...ibkrSnapshot,
        expiry: "2026-11-20",
        quotes: [],
      })),
      now: () => NOW,
      yahoo: source,
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiry).toBe("2026-11-06");
    expect(chain.rows).toHaveLength(5);
    expect(source.read.mock.calls).toEqual([
      ["DEMO", undefined],
      ["DEMO", "2026-11-20"],
    ]);
    // A requested expiry that lists no contracts is still served, empty.
    const requested = await operator().optionsChain.chain({
      expiry: "2026-11-20",
      symbol: "DEMO",
    });
    expect(requested).toMatchObject({ expiry: "2026-11-20", rows: [] });
  });

  it("no expiry requested and no candidate has a contract: Yahoo's empty chain is served with the expiry list", async () => {
    const empty = { ...snapshot, calls: [], puts: [] };
    setOptionsChainForTesting({
      now: () => NOW,
      yahoo: yahooFake(async () => empty),
    });
    const chain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({ expiry: "2026-11-06", rows: [] });
    expect(chain.expiries.map((item) => item.date)).toEqual(snapshot.expiries);
    // The same last resort after the IBKR expiry had no contract either; each expiry is read
    // from Yahoo once.
    const source = yahooFake(async (_symbol, expiry) => ({
      ...empty,
      expiry: expiry ?? "2026-11-06",
    }));
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => ({
        ...ibkrSnapshot,
        expiry: "2026-11-20",
        quotes: [],
      })),
      now: () => NOW,
      yahoo: source,
    });
    const afterIbkr = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(afterIbkr).toMatchObject({
      expiry: "2026-11-06",
      rows: [],
      spotSource: "ibkr",
    });
    expect(source.read.mock.calls).toEqual([
      ["DEMO", undefined],
      ["DEMO", "2026-11-20"],
    ]);
    // NOT_FOUND only when no source lists an expiry.
    setOptionsChainForTesting({
      now: () => NOW,
      yahoo: yahooFake(async () => ({ ...empty, expiries: [], expiry: null })),
    });
    await expectCode(
      operator().optionsChain.chain({ symbol: "DEMO" }),
      "NOT_FOUND"
    );
  });

  it("after the close, a failed read of the next open expiry fails the call with its typed error and is not cached", async () => {
    const afterClose = new Date("2026-11-06T22:00:00.000Z");
    let down = true;
    // Yahoo still lists today's closed expiry first; the read of the next open one fails.
    const source = yahooFake(async (_symbol, expiry) => {
      if (expiry !== undefined && down)
        throw new OptionsChainSourceError(
          "UPSTREAM_ERROR",
          "Yahoo options returned HTTP 403"
        );
      return { ...snapshot, expiry: expiry ?? "2026-11-06" };
    });
    setOptionsChainForTesting({ now: () => afterClose, yahoo: source });
    const api = operator();
    await expectCode(
      api.optionsChain.chain({ symbol: "DEMO" }),
      "UPSTREAM_ERROR"
    );
    expect(source.read.mock.calls).toEqual([
      ["DEMO", undefined],
      ["DEMO", "2026-11-20"],
    ]);
    // The expiry list does not disagree with the chain: the same read, the same error.
    await expectCode(
      api.optionsChain.expiries({ symbol: "DEMO" }),
      "UPSTREAM_ERROR"
    );
    // Nothing was cached: each call read Yahoo again.
    expect(source.read).toHaveBeenCalledTimes(4);
    down = false;
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain).toMatchObject({ expiry: "2026-11-20" });
    expect(chain.rows).toHaveLength(5);
    expect(source.read).toHaveBeenCalledTimes(6);
    const listed = await api.optionsChain.expiries({ symbol: "DEMO" });
    expect(listed.expiries[0]?.date).toBe("2026-11-20");
    expect(source.read).toHaveBeenCalledTimes(6);
  });

  it("a failure that arrives late does not remove a newer cached answer", async () => {
    let now = NOW;
    // The first Yahoo read stays open until `fail` is called.
    let fail: (error: Error) => void = () => undefined;
    const pending = new Promise<OptionsChainSnapshot>((_resolve, reject) => {
      fail = reject;
    });
    let calls = 0;
    const source = yahooFake(async () => {
      calls += 1;
      return calls === 1 ? await pending : snapshot;
    });
    setOptionsChainForTesting({ now: () => now, yahoo: source });
    const api = operator();
    const slow = expectCode(
      api.optionsChain.chain({ symbol: "DEMO" }),
      "UNAVAILABLE"
    );
    await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
    // The entry of the slow read expires; a second read answers and is cached.
    now = new Date(NOW.getTime() + 61_000);
    await expect(
      api.optionsChain.chain({ symbol: "DEMO" })
    ).resolves.toMatchObject({ expiry: "2026-11-06" });
    expect(source.read).toHaveBeenCalledTimes(2);
    fail(
      new OptionsChainSourceError(
        "UNAVAILABLE",
        "Yahoo options request failed or timed out"
      )
    );
    await slow;
    // The newer answer is still cached.
    await api.optionsChain.chain({ symbol: "DEMO" });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("tries the expiry of each source in the order of OPTIONS_CHAIN_PRIORITY.expiries", async () => {
    // Quant Data has rows for 2026-11-27, IBKR has quotes for 2026-11-20 and the Yahoo
    // snapshot is for 2026-11-06: all three are chains. Only Quant Data lists expiries here,
    // so the response stays valid while the table is reversed below.
    const shown = async (): Promise<string> => {
      setOptionsChainForTesting({
        ibkr: ibkrFake(async () => ({
          ...ibkrSnapshot,
          expiries: [],
          expiry: "2026-11-20",
        })),
        now: () => NOW,
        quantData: quantDataFake(async () => ({
          ...quantDataSnapshot,
          expiries: ["2026-11-27"],
          rows: [{ ...quantDataRow, expiry: "2026-11-27" }],
        })),
        yahoo: yahooFake(async () => ({ ...snapshot, expiries: [] })),
      });
      return (await operator().optionsChain.chain({ symbol: "DEMO" })).expiry;
    };
    expect(OPTIONS_CHAIN_PRIORITY.expiries).toEqual([
      "quantdata",
      "ibkr",
      "yahoo",
    ]);
    await expect(shown()).resolves.toBe("2026-11-27");
    // The table is the only place that sets the order: with it reversed, Yahoo's expiry wins.
    const order = OPTIONS_CHAIN_PRIORITY.expiries as unknown as string[];
    order.reverse();
    try {
      await expect(shown()).resolves.toBe("2026-11-06");
    } finally {
      order.reverse();
    }
    expect(OPTIONS_CHAIN_PRIORITY.expiries).toEqual([
      "quantdata",
      "ibkr",
      "yahoo",
    ]);
  });

  it("the cache key includes the configured sources", async () => {
    const source = yahoo();
    setOptionsChainForTesting({ now: () => NOW, yahoo: source });
    const plain = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(plain.sources[1]).toMatchObject({
      message: "IBKR history service is not configured",
      status: "off",
    });
    // The same symbol with IBKR configured is a new read, not the cached answer without it.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(historyDocument())
    );
    const withIbkr = apiFor(session("operator"), { marketHistory: HISTORY });
    const live = await withIbkr.optionsChain.chain({ symbol: "DEMO" });
    expect(live.sources[1]).toEqual({
      message: null,
      source: "ibkr",
      status: "used",
    });
    expect(atmCall(live)?.sources.quote).toBe("ibkr");
    expect(source.read).toHaveBeenCalledTimes(2);
    // Each configuration keeps its own cached answer.
    await withIbkr.optionsChain.chain({ symbol: "DEMO" });
    const again = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(again.sources[1].status).toBe("off");
    expect(source.read).toHaveBeenCalledTimes(2);
    // Quant Data configured is a third key.
    setOptionsAnalyticsForTesting({
      fetch: async () => json({ data: {} }),
      minIntervalMs: 0,
    });
    const withQuantData = await apiFor(session("operator"), {
      quantData: QUANTDATA,
    }).optionsChain.chain({ symbol: "DEMO" });
    expect(withQuantData.sources[0].message).not.toBe(
      "Quant Data is not configured"
    );
    expect(source.read).toHaveBeenCalledTimes(3);
  });

  it("reads Quant Data first through the configured client, also when Yahoo lists no options", async () => {
    const doFetch = vi.fn<QuantDataFetch>(
      async (url) =>
        new Response(
          JSON.stringify(
            url.endsWith("term-structure")
              ? {
                  data: {
                    "2026-11-06": {
                      "100": { CALL: { delta: 0.55, iv: 31 } },
                    },
                  },
                  stockPrice: 100.5,
                }
              : { data: [] }
          ),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
    );
    setOptionsAnalyticsForTesting({ fetch: doFetch, minIntervalMs: 0 });
    setOptionsChainForTesting({ now: () => NOW, yahoo: yahoo() });
    const api = apiFor(session("operator"), { quantData: QUANTDATA });
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(atmCall(chain)).toMatchObject({
      iv: 0.31,
      sources: { delta: "quantdata", iv: "quantdata", openInterest: "yahoo" },
    });
    expect(chain).toMatchObject({ spot: 100.5, spotSource: "quantdata" });
    expect(chain.sources[0].status).toBe("used");
    // The two shared requests: term-structure and order-flow.
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chain)).not.toContain(QUANTDATA.apiKey);
    // Yahoo lists no options: Quant Data is still asked, and its chain is served.
    setOptionsChainForTesting({
      now: () => NOW,
      yahoo: yahooFake(async () => ({
        ...snapshot,
        calls: [],
        expiries: [],
        expiry: null,
        puts: [],
      })),
    });
    const listed = await api.optionsChain.expiries({ symbol: "NOOPT" });
    expect(listed.sources[0]).toEqual({
      message: null,
      source: "quantdata",
      status: "used",
    });
    expect(listed.expiriesSources).toEqual(["quantdata"]);
    expect(doFetch).toHaveBeenCalledTimes(4);
    const served = await api.optionsChain.chain({ symbol: "NOOPT" });
    expect(served).toMatchObject({ expiry: "2026-11-06" });
    expect(served.rows.map((row) => row.strike)).toEqual([100]);
    expect(doFetch).toHaveBeenCalledTimes(4);
    // An unexpected error of a source gets a fixed text.
    setOptionsChainForTesting({
      ibkr: ibkrFake(async () => {
        throw new Error("https://internal.example/?token=secret");
      }),
      now: () => NOW,
      quantData: quantDataFake(async () => {
        throw new Error("https://internal.example/?token=secret");
      }),
      yahoo: yahoo(),
    });
    const odd = await operator().optionsChain.chain({ symbol: "DEMO" });
    expect(odd.sources.map((item) => item.message)).toEqual([
      "Quant Data request failed",
      "IBKR request failed",
      null,
    ]);
  });
});
