import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { OptionsChainOutputSchema } from "./contracts/options-chain.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  buildOptionsChain,
  OPTIONS_CHAIN_RISK_FREE_RATE,
  setOptionsChainForTesting,
} from "./server/options-chain.ts";
import {
  type OptionsChainSnapshot,
  type OptionsChainSource,
  OptionsChainSourceError,
} from "./server/options-chain-source.ts";
import {
  createYahooOptionsSource,
  parseYahooOptions,
  type YahooFetch,
} from "./server/options-chain-yahoo.ts";
import fixture from "./server/options-chain-yahoo.fixture.json" with {
  type: "json",
};

const NOW = new Date("2026-11-04T20:00:00.000Z");

afterEach(() => setOptionsChainForTesting());

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

describe("buildOptionsChain", () => {
  it("joins calls and puts by strike with Black-Scholes Greeks", () => {
    const output = OptionsChainOutputSchema.parse(
      buildOptionsChain(snapshot, "2026-11-06", NOW)
    );
    expect(output.rows.map((row) => row.strike)).toEqual([
      90, 95, 100, 105, 110,
    ]);
    expect(output.expiries.map((expiry) => expiry.dte)).toEqual([
      2, 16, 44, 72,
    ]);
    expect(output).toMatchObject({
      assumptions: {
        dayCount: "act/365",
        dividendYield: 0.01,
        model: "black-scholes-european",
        riskFreeRate: OPTIONS_CHAIN_RISK_FREE_RATE,
      },
      dte: 2,
      expiry: "2026-11-06",
      source: "yahoo",
      spot: 100,
    });
    const atm = output.rows[2];
    expect(atm?.call?.greeks?.delta).toBeGreaterThan(0.45);
    expect(atm?.call?.greeks?.delta).toBeLessThan(0.6);
    expect(atm?.put?.greeks?.delta).toBeLessThan(0);
    expect(atm?.call?.greeks?.theta).toBeLessThan(0);
    expect(atm?.call?.greeks?.gamma).toBeGreaterThan(0.1);
    expect(atm?.put?.greeks?.gamma).toBeGreaterThan(0.1);
    expect(output.rows[1]?.call).toBeNull();
    expect(output.rows[4]?.call?.greeks).toBeNull();
    expect(output.notes.join(" ")).toContain("1 contracts have no usable IV");
    expect(output.notes.join(" ")).toContain("4.00 %");
  });

  it("shows no Greeks without a spot price and drops past expiries", () => {
    const output = buildOptionsChain(
      { ...snapshot, dividendYield: null, spot: null },
      "2026-11-06",
      new Date("2026-11-21T12:00:00Z")
    );
    expect(output.rows.every((row) => (row.put?.greeks ?? null) === null)).toBe(
      true
    );
    // Past expiries drop out; the expiry being shown stays so the selector can show it.
    expect(output.expiries.map((expiry) => expiry.date)).toEqual([
      "2026-11-06",
      "2026-12-18",
      "2027-01-15",
    ]);
    expect(output.notes.join(" ")).toContain("This expiry has closed");
    expect(output.assumptions.dividendYield).toBe(0);
    expect(output.notes.join(" ")).toContain("No spot price");
    expect(output.dte).toBe(0);
    const complete = buildOptionsChain(
      { ...snapshot, calls: snapshot.calls.slice(0, 2) },
      "2026-11-06",
      NOW
    );
    expect(complete.notes.join(" ")).not.toContain("no usable IV");
  });
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

const apiFor = (requestSession: SafeAuthSession | null) => {
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

const fakeSource = (
  read: OptionsChainSource["read"]
): { read: Mock<OptionsChainSource["read"]> } => ({ read: vi.fn(read) });

describe("optionsChain procedures", () => {
  it("are operator-only and validate input", async () => {
    const source = fakeSource(async () => snapshot);
    setOptionsChainForTesting({ now: () => NOW, source });
    await expectCode(
      apiFor(null).optionsChain.expiries({ symbol: "DEMO" }),
      "UNAUTHORIZED"
    );
    await expectCode(
      apiFor(session("outsider")).optionsChain.chain({ symbol: "DEMO" }),
      "FORBIDDEN"
    );
    await expectCode(
      apiFor(session("operator")).optionsChain.chain({
        expiry: "2026-13-40",
        symbol: "DEMO",
      }),
      "BAD_REQUEST"
    );
    await expectCode(
      apiFor(session("operator")).optionsChain.expiries({ symbol: "1BAD" }),
      "BAD_REQUEST"
    );
    expect(source.read).not.toHaveBeenCalled();
  });

  it("lists expiries and returns the nearest chain from one cached read", async () => {
    const source = fakeSource(async () => snapshot);
    let now = NOW;
    setOptionsChainForTesting({ now: () => now, source });
    const api = apiFor(session("operator"));
    const listed = await api.optionsChain.expiries({ symbol: "demo" });
    expect(listed.expiries[0]).toEqual({ date: "2026-11-06", dte: 2 });
    expect(listed).not.toHaveProperty("rows");
    const chain = await api.optionsChain.chain({ symbol: "DEMO" });
    expect(chain.expiry).toBe("2026-11-06");
    expect(chain.rows).toHaveLength(5);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledWith("DEMO", undefined);
    now = new Date(NOW.getTime() + 61_000);
    await api.optionsChain.chain({ symbol: "DEMO" });
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("returns a selected expiry and refuses one that is not listed", async () => {
    const source = fakeSource(async (_symbol, expiry) => ({
      ...snapshot,
      expiry: expiry === "2026-11-20" ? "2026-11-20" : "2026-11-06",
    }));
    setOptionsChainForTesting({ now: () => NOW, source });
    const api = apiFor(session("operator"));
    await expect(
      api.optionsChain.chain({ expiry: "2026-11-20", symbol: "DEMO" })
    ).resolves.toMatchObject({ dte: 16, expiry: "2026-11-20" });
    await expectCode(
      api.optionsChain.chain({ expiry: "2026-11-27", symbol: "DEMO" }),
      "NOT_FOUND"
    );
    setOptionsChainForTesting({
      now: () => NOW,
      source: fakeSource(async () => ({ ...snapshot, expiry: null })),
    });
    await expectCode(
      apiFor(session("operator")).optionsChain.chain({ symbol: "NOOPT" }),
      "NOT_FOUND"
    );
  });

  it("moves past an expiry that closed today and explains a closed expiry", async () => {
    const afterClose = new Date("2026-11-06T22:00:00.000Z");
    const source = fakeSource(async (_symbol, expiry) => ({
      ...snapshot,
      expiry: expiry ?? "2026-11-06",
    }));
    setOptionsChainForTesting({ now: () => afterClose, source });
    const api = apiFor(session("operator"));
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
      source: fakeSource(async () => ({
        ...snapshot,
        expiries: ["2026-11-06"],
        expiry: "2026-11-06",
      })),
    });
    const only = await apiFor(session("operator")).optionsChain.chain({
      symbol: "DEMO",
    });
    expect(only.expiry).toBe("2026-11-06");
  });

  it("maps adapter failures and does not cache them", async () => {
    const source = fakeSource(async (symbol) => {
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
    setOptionsChainForTesting({ now: () => NOW, source });
    const api = apiFor(session("operator"));
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
    const source = fakeSource(async () => snapshot);
    setOptionsChainForTesting({ now: () => NOW, source });
    const api = apiFor(session("operator"));
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
    spy.mockRestore();
  });
});
