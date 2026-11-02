import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { OptionsAnalyticsInputSchema } from "./contracts/options-analytics.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  blackScholesGamma,
  daysUntil,
  displayStrikes,
  exposure,
  ivDecimal,
  ivSurface,
  maxPain,
  parseChain,
  parseFlow,
  parseOpenInterest,
  skew,
  summarizeFlow,
  termStructure,
  type ChainRow,
} from "./server/options-analytics-engine.ts";
import {
  buildOptionsAnalytics,
  setOptionsAnalyticsForTesting,
} from "./server/options-analytics.ts";
import {
  createQuantDataClient,
  parseRetryAfter,
  resolveQuantDataConfig,
  type QuantDataClient,
  type QuantDataConfig,
  type QuantDataFetch,
  type QuantDataResult,
} from "./server/quantdata-client.ts";

const KEY = "qd-test-key-0123456789";
const config: QuantDataConfig = {
  apiKey: KEY,
  baseUrl: "https://quantdata.domain.test",
};
const NOW = new Date("2026-10-22T15:00:00.000Z");
const TODAY = "2026-10-22";

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });

// Fixture shaped like QuantData term-structure (IV in percent), spot 100.
const chainData = {
  "2026-10-01": { "100.0": { CALL: { delta: 0.5, iv: 30 } } },
  "2026-10-23": {
    "80.0": { PUT: { delta: -0.1, iv: 45 }, CALL: { delta: 0.97, iv: 2160 } },
    "90.0": { PUT: { delta: -0.25, iv: 38 }, CALL: { delta: 0.85, iv: 30 } },
    "95.0": { PUT: { delta: -0.4, iv: 33 } },
    "100.0": { CALL: { delta: 0.52, iv: 28 }, PUT: { delta: -0.48, iv: 30 } },
    "105.0": { CALL: { delta: 0.4, iv: 26 } },
    "110.0": { CALL: { delta: 0.25, iv: 25 }, PUT: { delta: -0.9 } },
    "120.0": { CALL: { delta: 0.1, iv: "24" } },
    bad: { CALL: { delta: 0.5, iv: 30 } },
    "130.0": { CALL: null },
  },
  "2026-11-20": {
    "100.0": { CALL: { delta: 3, iv: 0.27 }, PUT: { delta: -0.5, iv: 0.29 } },
  },
  "not-a-date": {},
  "2026-12-18": { "140.0": 5, "150.0": { CALL: { delta: 0.2 } } },
};
const oiData = {
  "80.0": { callOpenInterest: 10, putOpenInterest: 500 },
  "100.0": { callOpenInterest: "300", putOpenInterest: 300 },
  "120.0": { callOpenInterest: 800, putOpenInterest: 0 },
  "140.0": { callOpenInterest: 0, putOpenInterest: 0 },
  x: { callOpenInterest: 5 },
};
const flowRows = [
  {
    contractType: "CALL",
    expirationDate: "2026-11-20",
    isUnusual: true,
    premium: 1_000_000,
    sentimentType: "BULLISH",
    size: 200,
    strikePrice: 110,
    tradeConsolidationType: "SWEEP",
    tradeTime: Date.parse("2026-10-22T14:10:00Z"),
  },
  {
    contractType: "PUT",
    expirationDate: "2026-10-23",
    premium: "250000",
    sentimentType: "odd",
    strikePrice: 95,
    tradeConsolidationType: "Block trade",
    tradeTime: "2026-10-22T13:05:00Z",
    volume: 50,
  },
  {
    contractType: "PUT",
    expirationDate: "2026-10-23",
    premium: 10,
    strikePrice: 90,
    tradeConsolidationType: "SPLIT",
    tradeTime: "2026-10-22T14:30:00Z",
  },
  {
    contractType: "CALL",
    expirationDate: "2026-10-23",
    premium: 1,
    strikePrice: 100,
    tradeTime: "x",
  },
  { contractType: "OTHER" },
  {},
];

describe("quantdata client", () => {
  it("resolves only https config with a key", () => {
    expect(resolveQuantDataConfig(undefined, undefined)).toBeNull();
    expect(resolveQuantDataConfig(undefined, " ")).toBeNull();
    expect(resolveQuantDataConfig("not a url", KEY)).toBeNull();
    expect(
      resolveQuantDataConfig("http://quantdata.domain.test", KEY)
    ).toBeNull();
    expect(
      resolveQuantDataConfig("https://u:p@quantdata.domain.test", KEY)
    ).toBeNull();
    expect(resolveQuantDataConfig(undefined, KEY)).toEqual({
      apiKey: KEY,
      baseUrl: "https://api.quantdata.us",
    });
    return expect(
      resolveQuantDataConfig("https://quantdata.domain.test/x", KEY)
    ).toEqual(config);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter(null, 0)).toBe(60);
    expect(parseRetryAfter(" ", 0)).toBe(60);
    expect(parseRetryAfter("7", 0)).toBe(7);
    expect(parseRetryAfter("999999", 0)).toBe(3600);
    expect(parseRetryAfter("garbage", 0)).toBe(60);
    expect(parseRetryAfter(new Date(30_000).toUTCString(), 0)).toBe(30);
    return expect(parseRetryAfter(new Date(0).toUTCString(), 60_000)).toBe(0);
  });

  it("posts with the bearer key, spaces requests and caches successes", async () => {
    let clock = 1000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({ data: { ok: 1 } })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      now: () => clock,
      sleep,
    });
    const first = await client.request("termStructure", { a: 1 }, 5000);
    expect(first).toMatchObject({ data: { ok: 1 }, ok: true });
    const [url, init] = doFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://quantdata.domain.test/v1/options/tool/term-structure"
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${KEY}`
    );
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
    await client.request("termStructure", { a: 1 }, 5000);
    expect(doFetch).toHaveBeenCalledTimes(1);
    await client.request("openInterest", { a: 1 }, 5000);
    expect(sleep).toHaveBeenCalledWith(1000);
    clock += 10_000;
    await client.request("termStructure", { a: 1 }, 5000);
    expect(doFetch).toHaveBeenCalledTimes(3);
    return expect(client.cooldownSeconds()).toBe(0);
  });

  it("evicts the oldest cache entries past 200", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
    });
    for (let index = 0; index < 201; index += 1)
      await client.request("orderFlow", { index }, 60_000);
    await client.request("orderFlow", { index: 0 }, 60_000);
    await client.request("orderFlow", { index: 200 }, 60_000);
    return expect(doFetch).toHaveBeenCalledTimes(202);
  });

  it("enters a cooldown on HTTP 429 and fails fast during it", async () => {
    let clock = 0;
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({}, { headers: { "retry-after": "30" }, status: 429 })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      now: () => clock,
    });
    const limited = await client.request("orderFlow", {}, 1);
    expect(limited).toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(client.cooldownSeconds()).toBe(30);
    clock = 40_000;
    const [queuedFirst, queuedSecond] = await Promise.all([
      client.request("orderFlow", { q: 1 }, 1),
      client.request("orderFlow", { q: 2 }, 1),
    ]);
    expect(queuedFirst).toMatchObject({ retryAfterSeconds: 30 });
    expect(queuedSecond).toMatchObject({
      message: "QuantData orderFlow: provider cooldown is active.",
    });
    clock = 0;
    const cooling = await client.request("openInterest", {}, 1);
    expect(cooling).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(doFetch).toHaveBeenCalledTimes(2);
    clock = 71_000;
    expect(client.cooldownSeconds()).toBe(0);
    return expect(JSON.stringify(limited)).not.toContain(KEY);
  });

  it("returns typed failures without the key", async () => {
    const run = async (
      doFetch: QuantDataFetch,
      maxBytes?: number
    ): Promise<QuantDataResult> =>
      createQuantDataClient(config, {
        fetch: doFetch,
        minIntervalMs: 0,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }).request("termStructure", {}, 1);
    expect(await run(async () => json({}, { status: 500 }))).toMatchObject({
      message: "QuantData termStructure: HTTP 500.",
      reason: "http",
    });
    expect(
      await run(async () => {
        throw new Error("down");
      })
    ).toMatchObject({ reason: "http" });
    expect(await run(async () => new Response("nope"))).toMatchObject({
      reason: "invalid",
    });
    expect(await run(async () => json([1]))).toMatchObject({
      reason: "invalid",
    });
    expect(await run(async () => json({ other: 1 }))).toMatchObject({
      reason: "invalid",
    });
    expect(
      await run(async () => json({ data: "x".repeat(50) }), 10)
    ).toMatchObject({
      message: "QuantData termStructure: response too large.",
    });
    expect(await run(async () => new Response(null))).toMatchObject({
      reason: "invalid",
    });
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("broken"));
        },
      })
    );
    return expect(await run(async () => broken)).toMatchObject({
      message: "QuantData termStructure: response could not be read.",
    });
  });

  it("reports timeouts during the request and while reading", async () => {
    const hang: QuantDataFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    const timed = await createQuantDataClient(config, {
      fetch: hang,
      timeoutMs: 5,
    }).request("orderFlow", {}, 1);
    expect(timed).toMatchObject({ reason: "timeout" });
    const slowBody: QuantDataFetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted"))
            );
          },
        })
      );
    const slow = await createQuantDataClient(config, {
      fetch: slowBody,
      timeoutMs: 5,
    }).request("orderFlow", {}, 1);
    return expect(slow).toMatchObject({ reason: "timeout" });
  });

  it("keeps serving requests after an unexpected throw", async () => {
    let calls = 0;
    const client = createQuantDataClient(config, {
      fetch: async () => json({ data: 1 }),
      minIntervalMs: 0,
      now: () => {
        calls += 1;
        if (calls === 2) throw new Error("clock");
        return 0;
      },
    });
    await expect(client.request("orderFlow", {}, 0)).rejects.toThrow("clock");
    return expect(
      client.request("orderFlow", { b: 1 }, 0)
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses global fetch and real timers by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ data: 1 }));
    const client = createQuantDataClient(config, { minIntervalMs: 50 });
    await client.request("termStructure", { a: 1 }, 1);
    await client.request("termStructure", { a: 2 }, 1);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("options analytics engine", () => {
  const chain = parseChain(chainData, TODAY);

  it("normalizes IV and dates", () => {
    expect(ivDecimal(42.5)).toBeCloseTo(0.425);
    expect(ivDecimal(0.3)).toBe(0.3);
    expect(ivDecimal(2160)).toBeNull();
    expect(ivDecimal(0)).toBeNull();
    expect(ivDecimal("")).toBeNull();
    expect(ivDecimal(true)).toBeNull();
    return expect(daysUntil("2026-11-20", TODAY)).toBe(29);
  });

  it("parses the chain, drops expired expiries and bad rows", () => {
    expect(chain.expired).toBe(1);
    expect(chain.rows.some((row) => row.expiry === "2026-10-01")).toBe(false);
    expect(
      chain.rows.find((row) => row.strike === 80 && row.right === "call")?.iv
    ).toBeNull();
    expect(
      chain.rows.find(
        (row) => row.expiry === "2026-11-20" && row.right === "call"
      )?.delta
    ).toBeNull();
    expect(parseChain(null, TODAY).rows).toEqual([]);
    return expect(parseChain([1], TODAY).rows).toEqual([]);
  });

  it("builds term structure, skew and the IV surface", () => {
    const term = termStructure(chain.rows, 100, TODAY);
    expect(term).toEqual([
      { atmIv: 0.28, dte: 1, expiry: "2026-10-23" },
      { atmIv: 0.29, dte: 29, expiry: "2026-11-20" },
    ]);
    expect(termStructure(chain.rows, null, TODAY)[0]?.expiry).toBe(
      "2026-10-23"
    );
    expect(
      termStructure(
        [{ delta: 0.5, expiry: TODAY, iv: null, right: "call", strike: 1 }],
        1,
        TODAY
      )
    ).toEqual([]);
    const points = skew(chain.rows).filter(
      (point) => point.expiry === "2026-10-23"
    );
    expect(points.map((point) => point.delta)).toEqual([
      -40, -25, -10, 10, 25, 40,
    ]);
    expect(points.map((point) => point.target)).toEqual([
      -40, -25, -10, 10, 25, 40,
    ]);
    const dupes: ChainRow[] = [
      { delta: -0.3, expiry: TODAY, iv: 0.3, right: "put", strike: 1 },
      { delta: 0.9, expiry: TODAY, iv: 0.3, right: "call", strike: 2 },
    ];
    expect(skew(dupes).map((point) => point.delta)).toEqual([-30]);
    // Each point keeps the target column it was chosen for, even when its own
    // delta is nearer another column (-17 is nearer -10 than -25).
    const wide: ChainRow[] = [
      { delta: -0.17, expiry: TODAY, iv: 0.31, right: "put", strike: 1 },
      { delta: -0.1, expiry: TODAY, iv: 0.36, right: "put", strike: 2 },
    ];
    expect(skew(wide)).toEqual([
      { delta: -17, expiry: TODAY, iv: 0.31, target: -25 },
      { delta: -10, expiry: TODAY, iv: 0.36, target: -10 },
    ]);
    // No deep puts: -40 and -25 both pick the -25 put; the nearer target keeps it.
    const shallow: ChainRow[] = [
      { delta: -0.25, expiry: TODAY, iv: 0.3, right: "put", strike: 1 },
      { delta: -0.1, expiry: TODAY, iv: 0.35, right: "put", strike: 2 },
    ];
    expect(skew(shallow)).toEqual([
      { delta: -25, expiry: TODAY, iv: 0.3, target: -25 },
      { delta: -10, expiry: TODAY, iv: 0.35, target: -10 },
    ]);
    // No deep calls: 10 and 25 both pick the 12 call; the earlier, nearer target keeps it.
    const nearCalls: ChainRow[] = [
      { delta: 0.12, expiry: TODAY, iv: 0.28, right: "call", strike: 3 },
    ];
    expect(skew(nearCalls)).toEqual([
      { delta: 12, expiry: TODAY, iv: 0.28, target: 10 },
    ]);
    const surface = ivSurface(chain.rows, 100, TODAY);
    expect(surface.moneyness).toHaveLength(7);
    expect(
      surface.rows[0]?.ivs.map((iv) =>
        iv === null ? null : Math.round(iv * 100)
      )
    ).toEqual([45, 38, 33, 29, 26, 25, 24]);
    expect(surface.rows[1]?.ivs[0]).toBeNull();
    expect(ivSurface(chain.rows, null, TODAY).rows).toEqual([]);
    const callsOnly: ChainRow[] = [
      { delta: 0.5, expiry: TODAY, iv: 0.2, right: "call", strike: 50 },
    ];
    expect(ivSurface(callsOnly, 10, TODAY).rows).toEqual([]);
    const many: ChainRow[] = Array.from({ length: 14 }, (_, index) => ({
      delta: 0.5,
      expiry: `2027-01-${String(index + 1).padStart(2, "0")}`,
      iv: 0.2,
      right: "call" as const,
      strike: 100,
    }));
    return expect(ivSurface(many, 100, TODAY).rows).toHaveLength(12);
  });

  it("parses open interest, max pain and the display strikes", () => {
    const oi = parseOpenInterest(oiData);
    expect(oi.map((row) => row.strike)).toEqual([80, 100, 120]);
    expect(parseOpenInterest("x")).toEqual([]);
    expect(
      parseOpenInterest({
        "1": { putOpenInterest: 3 },
        "2": { callOpenInterest: 4 },
      })
    ).toEqual([
      { callOpenInterest: 0, putOpenInterest: 3, strike: 1 },
      { callOpenInterest: 4, putOpenInterest: 0, strike: 2 },
    ]);
    expect(maxPain(oi)).toBe(100);
    expect(maxPain([])).toBeNull();
    expect(displayStrikes([], 100)).toEqual([]);
    expect(displayStrikes(oi, null)).toHaveLength(3);
    expect(displayStrikes(oi, 1000).map((row) => row.strike)).toEqual([
      80, 100, 120,
    ]);
    const wide = Array.from({ length: 200 }, (_, index) => ({
      callOpenInterest: Math.abs(index + 1 - 100) > 37 ? 1000 : 1,
      putOpenInterest: 1,
      strike: index + 1,
    }));
    return expect(displayStrikes(wide, 100)).toHaveLength(80);
  });

  it("estimates GEX from front-expiry IV with an ATM fallback", () => {
    expect(blackScholesGamma(100, 100, 0.2, 1)).toBeCloseTo(0.0198, 3);
    const oi = parseOpenInterest(oiData);
    const result = exposure(oi, chain.rows, 100, TODAY);
    expect(result.gexExpiry).toBe("2026-10-23");
    expect(result.maxPain).toBe(100);
    expect(result.strikes).toHaveLength(3);
    expect(result.strikes.every((row) => row.gex !== null)).toBe(true);
    expect(result.totalGex).not.toBeNull();
    expect(exposure(oi, chain.rows, null, TODAY)).toMatchObject({
      gexExpiry: null,
      totalGex: null,
    });
    expect(exposure(oi, [], 100, TODAY).strikes[0]?.gex).toBeNull();
    const sameDay: ChainRow[] = [
      { delta: 0.5, expiry: TODAY, iv: 0.2, right: "call", strike: 100 },
    ];
    expect(exposure(oi, sameDay, 100, TODAY).gexExpiry).toBe(TODAY);
    const noIv: ChainRow[] = [
      {
        delta: 0.5,
        expiry: "2026-10-23",
        iv: null,
        right: "call",
        strike: 100,
      },
    ];
    return expect(exposure(oi, noIv, 100, TODAY)).toMatchObject({
      totalGex: null,
    });
  });

  it("parses and summarizes option flow", () => {
    const events = parseFlow(flowRows, "NVDA");
    expect(events.map((event) => event.contract)).toEqual([
      "NVDA 2026-10-23 90P",
      "NVDA 2026-11-20 110C",
      "NVDA 2026-10-23 95P",
    ]);
    expect(events[1]).toMatchObject({
      flowType: "sweep",
      sentiment: "bullish",
      size: 200,
      unusual: true,
    });
    expect(events[2]).toMatchObject({
      flowType: "block",
      sentiment: "neutral",
      size: 50,
      unusual: false,
    });
    expect(events[0]).toMatchObject({ flowType: "split", size: 0 });
    expect(parseFlow({}, "X")).toEqual([]);
    expect(
      parseFlow([{ ...flowRows[0], tradeConsolidationType: " " }], "X")[0]
        ?.flowType
    ).toBeNull();
    const summary = summarizeFlow(events);
    expect(summary.callPremium).toBe(1_000_000);
    expect(summary.putPremium).toBe(250_010);
    expect(summary.buckets).toEqual([
      {
        callPremium: 0,
        netPremium: -250_000,
        putPremium: 250_000,
        start: "2026-10-22T13:00:00.000Z",
        trades: 1,
      },
      {
        callPremium: 1_000_000,
        netPremium: 999_990,
        putPremium: 10,
        start: "2026-10-22T14:00:00.000Z",
        trades: 2,
      },
    ]);
    const lots = Array.from({ length: 120 }, () => events[0]).filter(
      (event): event is NonNullable<typeof event> => event !== undefined
    );
    return expect(summarizeFlow(lots).events).toHaveLength(100);
  });
});

const fakeClient = (
  responses: Partial<
    Record<"termStructure" | "openInterest" | "orderFlow", QuantDataResult>
  >,
  cooldown = 0
): QuantDataClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    cooldownSeconds: () => cooldown,
    request: async (endpoint, payload) => {
      calls.push([endpoint, payload]);
      return (
        responses[endpoint] ?? {
          message: `QuantData ${endpoint}: HTTP 500.`,
          ok: false,
          reason: "http",
          retryAfterSeconds: null,
        }
      );
    },
  };
};

const ok = (body: Record<string, unknown>): QuantDataResult => ({
  body,
  data: body["data"],
  ok: true,
});

describe("buildOptionsAnalytics", () => {
  const input = OptionsAnalyticsInputSchema.parse({
    flowHours: "6",
    symbol: "nvda",
  });

  it("assembles all sections from provider data", async () => {
    const client = fakeClient({
      openInterest: ok({ data: oiData }),
      orderFlow: ok({ data: flowRows, nextSearchAfter: ["1"] }),
      termStructure: ok({ data: chainData, stockPrice: 100 }),
    });
    const output = await buildOptionsAnalytics(input, {
      client,
      now: () => NOW,
    });
    expect(output).toMatchObject({
      rateLimited: false,
      retryAfterSeconds: null,
      spot: 100,
      symbol: "NVDA",
    });
    expect(output.volatility.status).toBe("ok");
    expect(output.exposure).toMatchObject({ message: null, status: "ok" });
    expect(output.flow).toMatchObject({
      hours: 6,
      message: "First provider page only (3 trades).",
      status: "ok",
    });
    expect(
      output.notes.some((note) => note.includes("Excluded 1 expired"))
    ).toBe(true);
    expect(client.calls[2]).toEqual([
      "orderFlow",
      {
        filter: { ticker: "NVDA" },
        timeRange: {
          endTime: "2026-10-22T15:00:00.000Z",
          startTime: "2026-10-22T09:00:00.000Z",
        },
      },
    ]);
  });

  it("reports empty and unavailable sections separately", async () => {
    const empty = await buildOptionsAnalytics(input, {
      client: fakeClient({
        openInterest: ok({ data: {} }),
        orderFlow: ok({ data: [] }),
        termStructure: ok({ data: {}, stockPrice: "x" }),
      }),
      now: () => NOW,
    });
    expect(empty.spot).toBeNull();
    expect([
      empty.volatility.status,
      empty.exposure.status,
      empty.flow.status,
    ]).toEqual(["empty", "empty", "empty"]);
    const noGex = await buildOptionsAnalytics(input, {
      client: fakeClient({
        openInterest: ok({ data: oiData }),
        orderFlow: ok({ data: flowRows }),
      }),
      now: () => NOW,
    });
    expect(noGex.volatility).toMatchObject({
      message: "QuantData termStructure: HTTP 500.",
      status: "unavailable",
    });
    expect(noGex.exposure.message).toContain("GEX needs");
    expect(noGex.flow.message).toBeNull();
    const limited: QuantDataResult = {
      message: "QuantData orderFlow: HTTP 429.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 12,
    };
    const down = await buildOptionsAnalytics(input, {
      client: fakeClient({ orderFlow: limited }, 11.2),
      now: () => NOW,
    });
    expect(down).toMatchObject({ rateLimited: true, retryAfterSeconds: 12 });
    expect(down.exposure.status).toBe("unavailable");
    return expect(down.flow).toMatchObject({
      message: "QuantData orderFlow: HTTP 429.",
      status: "unavailable",
    });
  });
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-10-23T12:00:00.000Z"),
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
  quantData: QuantDataConfig | null
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
      quantData,
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

describe("optionsAnalytics.snapshot procedure", () => {
  it("is operator-only, validates input and needs configuration", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: {} }));
    setOptionsAnalyticsForTesting(
      { fetch: doFetch, minIntervalMs: 0 },
      () => NOW
    );
    await expectCode(
      apiFor(null, config).optionsAnalytics.snapshot({ symbol: "SPY" }),
      "UNAUTHORIZED"
    );
    await expectCode(
      apiFor(session("outsider"), config).optionsAnalytics.snapshot({
        symbol: "SPY",
      }),
      "FORBIDDEN"
    );
    await expectCode(
      apiFor(session("operator"), config).optionsAnalytics.snapshot({
        flowHours: 5,
        symbol: "SPY",
      }),
      "BAD_REQUEST"
    );
    await expectCode(
      apiFor(session("operator"), null).optionsAnalytics.snapshot({
        symbol: "SPY",
      }),
      "NOT_CONFIGURED"
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns a snapshot and reuses one client per configuration", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async (url) =>
      json(
        url.endsWith("term-structure")
          ? { data: chainData, stockPrice: 100 }
          : { data: {} }
      )
    );
    setOptionsAnalyticsForTesting(
      { fetch: doFetch, minIntervalMs: 0 },
      () => NOW
    );
    const api = apiFor(session("operator"), config);
    const output = await api.optionsAnalytics.snapshot({ symbol: "SPY" });
    expect(output.volatility.status).toBe("ok");
    expect(output.flow.hours).toBe(24);
    expect(JSON.stringify(output)).not.toContain(KEY);
    await api.optionsAnalytics.snapshot({ symbol: "SPY" });
    expect(doFetch).toHaveBeenCalledTimes(3);
    await apiFor(session("operator"), {
      ...config,
      apiKey: "other-key-0123456789",
    }).optionsAnalytics.snapshot({
      symbol: "SPY",
    });
    expect(doFetch).toHaveBeenCalledTimes(6);
    setOptionsAnalyticsForTesting({ fetch: doFetch, minIntervalMs: 0 });
    const live = await api.optionsAnalytics.snapshot({ symbol: "QQQ" });
    expect(Date.parse(live.receivedAt)).toBeGreaterThan(NOW.getTime());
    setOptionsAnalyticsForTesting({});
  });
});
