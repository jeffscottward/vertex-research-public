import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  FlowOptionGapRecord,
  FlowOptionStrikeTotalRecord,
  Repositories,
} from "@darkfactory/db/server";
import type { SemanticEventPort } from "@darkfactory/observability/port";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  type FlowEvent,
  OptionsAnalyticsInputSchema,
  OptionsAnalyticsOutputSchema,
} from "./contracts/options-analytics.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  buildOptionsAnalytics,
  buildOptionsGreekHeatmap,
  flowWindow,
  setOptionsAnalyticsForTesting,
  storedPrintsSymbol,
  storedProfileFlow,
} from "./server/options-analytics.ts";
import {
  blackScholesGamma,
  type ChainRow,
  daysUntil,
  displayStrikes,
  exposure,
  gammaModel,
  holderPayout,
  inRangeStrikes,
  isCountedPrint,
  ivDecimal,
  ivSurface,
  maxPain,
  pageProfileFlow,
  parseChain,
  parseFlow,
  parseOpenInterest,
  profileStrikes,
  skew,
  strikeProfiles,
  summarizeFlow,
  termStructure,
  withProfileFlow,
} from "./server/options-analytics-engine.ts";
import { createQuantDataOptionsSource } from "./server/options-chain-quantdata.ts";
import {
  createQuantDataClient,
  parseRetryAfter,
  type QuantDataClient,
  type QuantDataConfig,
  type QuantDataEndpoint,
  type QuantDataFetch,
  type QuantDataResult,
  resolveQuantDataConfig,
  withCallerReserve,
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
    "80.0": { CALL: { delta: 0.97, iv: 2160 }, PUT: { delta: -0.1, iv: 45 } },
    "90.0": { CALL: { delta: 0.85, iv: 30 }, PUT: { delta: -0.25, iv: 38 } },
    "95.0": { PUT: { delta: -0.4, iv: 33 } },
    "100.0": { CALL: { delta: 0.52, iv: 28 }, PUT: { delta: -0.48, iv: 30 } },
    "105.0": { CALL: { delta: 0.4, iv: 26 } },
    "110.0": { CALL: { delta: 0.25, iv: 25 }, PUT: { delta: -0.9 } },
    "120.0": { CALL: { delta: 0.1, iv: "24" } },
    "130.0": { CALL: null },
    bad: { CALL: { delta: 0.5, iv: 30 } },
  },
  "2026-11-20": {
    "100.0": { CALL: { delta: 3, iv: 0.27 }, PUT: { delta: -0.5, iv: 0.29 } },
  },
  "2026-12-18": { "140.0": 5, "150.0": { CALL: { delta: 0.2 } } },
  "not-a-date": {},
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
    expect(first).toMatchObject({ data: { ok: 1 }, fetchedAt: 1000, ok: true });
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
    // A cache hit keeps the time QuantData answered, not the time of the hit.
    expect(clock).toBe(2000);
    expect(await client.request("termStructure", { a: 1 }, 5000)).toMatchObject(
      { fetchedAt: 1000, ok: true }
    );
    clock += 10_000;
    await client.request("termStructure", { a: 1 }, 5000);
    expect(doFetch).toHaveBeenCalledTimes(3);
    return expect(client.cooldownSeconds()).toBe(0);
  });

  it("evicts the oldest cache entries past 200", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      maxRequestsPerMinute: 1000,
      minIntervalMs: 0,
    });
    for (let index = 0; index < 201; index += 1)
      await client.request("orderFlow", { index }, 60_000);
    await client.request("orderFlow", { index: 0 }, 60_000);
    await client.request("orderFlow", { index: 200 }, 60_000);
    return expect(doFetch).toHaveBeenCalledTimes(202);
  });

  it("caches by an explicit key when the payload changes every minute", async () => {
    let clock = 0;
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
    });
    await client.request("orderFlow", { t: 1 }, 60_000, "SPY 24h");
    clock = 59_000;
    await client.request("orderFlow", { t: 2 }, 60_000, "SPY 24h");
    expect(doFetch).toHaveBeenCalledTimes(1);
    await client.request("orderFlow", { t: 2 }, 60_000, "QQQ 24h");
    expect(doFetch).toHaveBeenCalledTimes(2);
    clock = 60_000;
    await client.request("orderFlow", { t: 3 }, 60_000, "SPY 24h");
    return expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("stops at its per-minute request budget until the window moves", async () => {
    let clock = 0;
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      maxRequestsPerMinute: 2,
      minIntervalMs: 0,
      now: () => clock,
    });
    await client.request("orderFlow", { n: 1 }, 1);
    clock = 10_000;
    await client.request("orderFlow", { n: 2 }, 1);
    clock = 20_000;
    expect(await client.request("orderFlow", { n: 3 }, 1)).toEqual({
      message:
        "QuantData orderFlow: the vertex-web budget of 2 requests per minute is used.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 40,
    });
    expect(doFetch).toHaveBeenCalledTimes(2);
    clock = 60_000;
    expect(await client.request("orderFlow", { n: 3 }, 1)).toMatchObject({
      ok: true,
    });
    return expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps free the starts that the caller reserve asks for and answers reserved", async () => {
    let clock = 0;
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
    });
    for (let index = 0; index < 48; index += 1) {
      clock = index * 100;
      expect(
        await client.request("orderFlow", { index }, 1, undefined, 6)
      ).toMatchObject({ ok: true });
    }
    clock = 5000;
    expect(
      await client.request("netDrift", { index: 48 }, 1, undefined, 6)
    ).toEqual({
      message:
        "QuantData netDrift: 6 request starts per minute are kept free for other callers.",
      ok: false,
      reason: "reserved",
      retryAfterSeconds: 55,
    });
    expect(await client.request("orderFlow", { index: 48 }, 1)).toMatchObject({
      ok: true,
    });
    expect(doFetch).toHaveBeenCalledTimes(49);
    return expect(client.freeStarts()).toBe(5);
  });

  it("answers rate_limited, not reserved, when the window is full", async () => {
    let clock = 0;
    const client = createQuantDataClient(config, {
      fetch: async () => json({ data: 1 }),
      maxRequestsPerMinute: 2,
      minIntervalMs: 0,
      now: () => clock,
    });
    await client.request("orderFlow", { n: 1 }, 1);
    await client.request("orderFlow", { n: 2 }, 1);
    clock = 1000;
    return expect(
      await client.request("orderFlow", { n: 3 }, 1, undefined, 1)
    ).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("serves a cached body to a reserving caller without a start", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 7 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      maxRequestsPerMinute: 2,
      minIntervalMs: 0,
      now: () => 0,
    });
    await client.request("orderFlow", { n: 1 }, 60_000);
    expect(
      await client.request("orderFlow", { n: 1 }, 60_000, undefined, 1)
    ).toMatchObject({ data: 7, ok: true });
    return expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("counts free starts over the sliding 60 s", async () => {
    let clock = 0;
    const client = createQuantDataClient(config, {
      fetch: async () => json({ data: 1 }),
      maxRequestsPerMinute: 5,
      minIntervalMs: 0,
      now: () => clock,
    });
    expect(client.freeStarts()).toBe(5);
    await client.request("orderFlow", { n: 1 }, 1);
    clock = 30_000;
    await client.request("orderFlow", { n: 2 }, 1);
    expect(client.freeStarts()).toBe(3);
    clock = 60_000;
    expect(client.freeStarts()).toBe(4);
    clock = 90_000;
    return expect(client.freeStarts()).toBe(5);
  });

  it("withCallerReserve forwards the reserve, shares the window and lowers freeStarts by the reserve", async () => {
    let clock = 0;
    const shared = createQuantDataClient(config, {
      fetch: async () => json({ data: 1 }),
      maxRequestsPerMinute: 4,
      minIntervalMs: 0,
      now: () => clock,
    });
    const view = withCallerReserve(shared, 2);
    expect(view.freeStarts()).toBe(2);
    expect(view.cooldownSeconds()).toBe(0);
    await view.request("netDrift", { n: 1 }, 1);
    clock = 1;
    await shared.request("orderFlow", { n: 2 }, 1);
    expect(shared.freeStarts()).toBe(2);
    expect(view.freeStarts()).toBe(0);
    clock = 2;
    expect(await view.request("netDrift", { n: 3 }, 1)).toMatchObject({
      reason: "reserved",
    });
    clock = 3;
    expect(await shared.request("orderFlow", { n: 4 }, 1)).toMatchObject({
      ok: true,
    });
    expect(view.freeStarts()).toBe(0);
    const spy = vi.fn<QuantDataClient["request"]>(async () => ({
      body: {},
      data: null,
      ok: true,
    }));
    await withCallerReserve(
      { cooldownSeconds: () => 0, freeStarts: () => 30, request: spy },
      6
    ).request("netDrift", { n: 5 }, 30_000, "key");
    return expect(spy).toHaveBeenCalledWith(
      "netDrift",
      { n: 5 },
      30_000,
      "key",
      6
    );
  });

  it("holds keepFree to 0 and the window minus 1", async () => {
    let clock = 0;
    const client = createQuantDataClient(config, {
      fetch: async () => json({ data: 1 }),
      maxRequestsPerMinute: 2,
      minIntervalMs: 0,
      now: () => clock,
    });
    expect(
      await client.request("orderFlow", { n: 1 }, 1, undefined, 99)
    ).toMatchObject({ ok: true });
    clock = 1;
    expect(
      await client.request("orderFlow", { n: 2 }, 1, undefined, 99)
    ).toMatchObject({ reason: "reserved" });
    expect(
      await client.request("orderFlow", { n: 3 }, 1, undefined, -5)
    ).toMatchObject({ ok: true });
    return expect(client.freeStarts()).toBe(0);
  });

  it("waits while the shared provider quota is below its reserve", async () => {
    let clock = 0;
    let headers: Record<string, string> = {
      "x-ratelimit-remaining": "200",
      "x-ratelimit-reset": "45",
    };
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({ data: 1 }, { headers })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
      quotaReserve: 100,
    });
    expect(await client.request("termStructure", { a: 1 }, 1)).toMatchObject({
      ok: true,
    });
    expect(client.cooldownSeconds()).toBe(0);
    headers = { "x-ratelimit-remaining": "99", "x-ratelimit-reset": "45" };
    // The low-quota answer still returns; the queued request behind it waits.
    const [low, queued] = await Promise.all([
      client.request("termStructure", { a: 2 }, 1),
      client.request("termStructure", { a: 3 }, 1),
    ]);
    expect(low).toMatchObject({ ok: true });
    const waiting = {
      message:
        "QuantData termStructure: the shared QuantData quota is low; vertex-web waits so trading jobs keep headroom.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 45,
    };
    expect(queued).toEqual(waiting);
    expect(client.cooldownSeconds()).toBe(45);
    expect(await client.request("termStructure", { a: 4 }, 1)).toEqual(waiting);
    expect(doFetch).toHaveBeenCalledTimes(2);
    // Unreadable headers never pause; a falling counter waits until its reset, held to 1..60 s,
    // and a missing reset waits 60 s.
    const pauseAfter = async (
      next: Record<string, string>,
      label: number
    ): Promise<number> => {
      clock += 100_000;
      headers = next;
      await client.request("openInterest", { label }, 1);
      return client.cooldownSeconds();
    };
    expect(await pauseAfter({ "x-ratelimit-remaining": "abc" }, 1)).toBe(0);
    expect(await pauseAfter({ "x-ratelimit-remaining": "-1" }, 2)).toBe(0);
    expect(await pauseAfter({}, 3)).toBe(0);
    expect(
      await pauseAfter(
        { "x-ratelimit-remaining": "50", "x-ratelimit-reset": "999" },
        4
      )
    ).toBe(60);
    expect(
      await pauseAfter(
        { "x-ratelimit-remaining": "40", "x-ratelimit-reset": "0" },
        5
      )
    ).toBe(1);
    expect(await pauseAfter({ "x-ratelimit-remaining": "0" }, 6)).toBe(60);
    return expect(doFetch).toHaveBeenCalledTimes(8);
  });

  it("ignores a low remaining count that does not fall", async () => {
    // QuantData sent "remaining 19, reset 55" on every response on 2026-11-03.
    let clock = 0;
    let headers: Record<string, string> = {
      "x-ratelimit-remaining": "19",
      "x-ratelimit-reset": "55",
    };
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({ data: 1 }, { headers })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
    });
    for (const label of [1, 2, 3]) {
      clock += 1000;
      expect(await client.request("openInterest", { label }, 1)).toMatchObject({
        ok: true,
      });
      expect(client.cooldownSeconds()).toBe(0);
    }
    // A higher count (a new window) does not wait either; the next fall does.
    headers = { "x-ratelimit-remaining": "30", "x-ratelimit-reset": "55" };
    await client.request("openInterest", { label: 4 }, 1);
    expect(client.cooldownSeconds()).toBe(0);
    headers = { "x-ratelimit-remaining": "29", "x-ratelimit-reset": "55" };
    await client.request("openInterest", { label: 5 }, 1);
    expect(client.cooldownSeconds()).toBe(55);
    expect(doFetch).toHaveBeenCalledTimes(5);
    // A 429 that carries the same constant headers still waits for the reset (55 s, past
    // its 5 s Retry-After).
    clock += 100_000;
    doFetch.mockResolvedValueOnce(
      json({}, { headers: { ...headers, "retry-after": "5" }, status: 429 })
    );
    await client.request("openInterest", { label: 6 }, 1);
    return expect(client.cooldownSeconds()).toBe(55);
  });

  it("defaults to 54 requests per minute and a reserve of 60", async () => {
    let clock = 0;
    let remaining = "60";
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({ data: 1 }, { headers: { "x-ratelimit-remaining": remaining } })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
    });
    for (let index = 0; index < 55; index += 1)
      await client.request("orderFlow", { index }, 1);
    expect(doFetch).toHaveBeenCalledTimes(54);
    clock = 60_000;
    remaining = "59";
    await client.request("orderFlow", { index: 99 }, 1);
    return expect(client.cooldownSeconds()).toBe(60);
  });

  it("counts failed requests against the budget", async () => {
    let clock = 0;
    const doFetch = vi.fn<QuantDataFetch>(async () =>
      json({}, { status: 500 })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      maxRequestsPerMinute: 1,
      now: () => clock,
    });
    expect(await client.request("orderFlow", { n: 1 }, 1)).toMatchObject({
      reason: "http",
    });
    clock = 30_000;
    expect(await client.request("orderFlow", { n: 2 }, 1)).toMatchObject({
      reason: "rate_limited",
      retryAfterSeconds: 30,
    });
    return expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("reports the later of a 429 cooldown and a quota wait", async () => {
    const client = createQuantDataClient(config, {
      fetch: async () =>
        json(
          {},
          {
            headers: {
              "retry-after": "5",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "30",
            },
            status: 429,
          }
        ),
      now: () => 0,
    });
    await client.request("orderFlow", {}, 1);
    return expect(client.request("openInterest", {}, 1)).resolves.toEqual({
      message:
        "QuantData openInterest: the shared QuantData quota is low; vertex-web waits so trading jobs keep headroom.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 30,
    });
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

  it("classifies HTTP 401/403 as auth_failed, enters auth cooldown without setting rate-limit cooldown, and recovers on 200", async () => {
    let clock = 10_000;
    const responses = [
      new Response("unauthorized", { status: 401 }),
      json({ data: { ok: 1 } }),
      new Response("forbidden", { status: 403 }),
    ];
    const doFetch = vi.fn(
      async () => responses.shift() ?? json({ data: { ok: 2 } })
    );
    const client = createQuantDataClient(config, {
      authCooldownSeconds: 300,
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => clock,
    });
    const first = await client.request("orderFlow", { a: 1 }, 60_000);
    expect(first).toMatchObject({
      httpStatus: 401,
      message:
        "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
      ok: false,
      reason: "auth_failed",
      retryAfterSeconds: 300,
    });
    // Rate-limit cooldown stays 0 so UI never mislabels 401 as rate-limited.
    expect(client.cooldownSeconds()).toBe(0);
    expect(JSON.stringify(first)).not.toContain(KEY);

    // Subsequent call during auth cooldown fails fast without touching fetch.
    clock = 70_000;
    const cooling = await client.request("termStructure", { a: 1 }, 60_000);
    expect(cooling).toMatchObject({
      httpStatus: 401,
      message:
        "QuantData termStructure: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
      ok: false,
      reason: "auth_failed",
      retryAfterSeconds: 240,
    });
    expect(doFetch).toHaveBeenCalledTimes(1);

    // After auth cooldown expires, a 200 response clears auth failure state.
    clock = 320_000;
    const recovered = await client.request("orderFlow", { a: 2 }, 60_000);
    expect(recovered).toMatchObject({ data: { ok: 1 }, ok: true });
    expect(doFetch).toHaveBeenCalledTimes(2);

    // HTTP 403 also classifies as auth_failed.
    const forbidden = await client.request("netDrift", { a: 3 }, 60_000);
    expect(forbidden).toMatchObject({
      httpStatus: 403,
      message:
        "QuantData netDrift: HTTP 403 (access forbidden — check QUANTDATA_API_KEY or subscription).",
      ok: false,
      reason: "auth_failed",
      retryAfterSeconds: 300,
    });

    // authCooldownSeconds: 0 disables cooldown and returns retryAfterSeconds: null.
    const noCooldown = createQuantDataClient(config, {
      authCooldownSeconds: 0,
      fetch: async () => new Response("no", { status: 401 }),
      minIntervalMs: 0,
      now: () => clock,
    });
    expect(await noCooldown.request("orderFlow", {}, 1)).toMatchObject({
      httpStatus: 401,
      ok: false,
      reason: "auth_failed",
      retryAfterSeconds: null,
    });
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

  it("makes one request start for two identical reads that overlap", async () => {
    let clock = 1000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const doFetch = vi.fn<QuantDataFetch>(async (url) =>
      json({ data: url.endsWith("term-structure") ? "chain" : "oi" })
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      now: () => clock,
      sleep,
    });
    // The second termStructure read waits behind openInterest (1 s) and then finds the answer of
    // the first one in the cache.
    const [first, other, second] = await Promise.all([
      client.request("termStructure", { a: 1 }, 5000),
      client.request("openInterest", { a: 1 }, 5000),
      client.request("termStructure", { a: 1 }, 5000),
    ]);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ data: "chain", fetchedAt: 1000, ok: true });
    expect(other).toMatchObject({ data: "oi", fetchedAt: 2000, ok: true });
    expect(second).toEqual(first);
    expect(clock).toBe(2000);
    // The cache hit at the head of the queue is not a request start.
    expect(client.freeStarts()).toBe(52);
    // The hit does not extend the entry: it still expires 5 s after the first answer.
    clock = 6000;
    await client.request("termStructure", { a: 1 }, 5000);
    return expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("makes a request start for each of two different reads that overlap", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
    });
    const results = await Promise.all([
      client.request("orderFlow", { t: 1 }, 60_000, "SPY 24h"),
      client.request("orderFlow", { t: 1 }, 60_000, "SPY 6h"),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    return expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("does not feed a failed read to an identical read that overlaps it", async () => {
    // A regression guard: the client before the queue-head cache check passed this test, too.
    const doFetch = vi
      .fn<QuantDataFetch>()
      .mockResolvedValueOnce(json({ error: "busy" }, { status: 500 }))
      .mockResolvedValue(json({ data: 2 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
    });
    const [first, second] = await Promise.all([
      client.request("termStructure", { a: 1 }, 60_000),
      client.request("termStructure", { a: 1 }, 60_000),
    ]);
    expect(first).toMatchObject({ httpStatus: 500, ok: false, reason: "http" });
    expect(second).toMatchObject({ data: 2, ok: true });
    return expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("does not de-duplicate overlapping reads with ttlMs 0", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async () => json({ data: 1 }));
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => 0,
    });
    await Promise.all([
      client.request("termStructure", { a: 1 }, 0),
      client.request("termStructure", { a: 1 }, 0),
    ]);
    return expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("spends at most 5 starts on one uncached symbol when the snapshot, the options chain and the heatmap read at the same time", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async (url) =>
      json(
        url.endsWith("term-structure")
          ? { data: chainData, stockPrice: 100 }
          : url.endsWith("open-interest-by-strike")
            ? { data: oiData }
            : url.endsWith("heat-map")
              ? { data: {}, type: "contract" }
              : { data: flowRows }
      )
    );
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
      now: () => NOW.getTime(),
    });
    const deps = { client, now: () => NOW };
    const [snapshot, chain, heatmap] = await Promise.all([
      buildOptionsAnalytics(
        OptionsAnalyticsInputSchema.parse({ symbol: "SPY" }),
        deps
      ),
      createQuantDataOptionsSource(client, () => NOW).read("SPY"),
      buildOptionsGreekHeatmap({ symbol: "SPY" }, deps),
    ]);
    expect(snapshot.rateLimited).toBe(false);
    expect(chain.spot).toBe(100);
    expect(heatmap.rateLimited).toBe(false);
    const paths = doFetch.mock.calls.map(([url]) =>
      url.replace("https://quantdata.domain.test/v1/options/tool/", "")
    );
    expect(paths.sort()).toEqual([
      "heat-map",
      "heat-map",
      "open-interest-by-strike",
      "order-flow/consolidated",
      "term-structure",
    ]);
    return expect(client.freeStarts()).toBe(54 - 5);
  });

  it("lets later requests run when a step never settles (its request context ended)", async () => {
    // In workerd a step whose request context ended stays pending, and its own 10 s abort timer
    // never fires. The first fetch below ignores its abort signal to model that step.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let finishStuck: (response: Response) => void = () => undefined;
      let finishNewer: (response: Response) => void = () => undefined;
      const doFetch = vi
        .fn<QuantDataFetch>()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishStuck = resolve;
            })
        )
        .mockImplementationOnce(async () => json({ data: 2 }))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishNewer = resolve;
            })
        )
        .mockImplementation(async () => json({ data: 2 }));
      const client = createQuantDataClient(config, {
        fetch: doFetch,
        minIntervalMs: 0,
      });
      void client.request("orderFlow", { stuck: 1 }, 1000);
      const later = client.request("orderFlow", { later: 1 }, 1000);
      let settled = false;
      void later.then(() => {
        settled = true;
      });
      // The step deadline: minIntervalMs 0 + timeoutMs 10 000 + 2000 margin.
      await vi.advanceTimersByTimeAsync(11_999);
      expect(settled).toBe(false);
      expect(doFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(later).resolves.toMatchObject({ data: 2, ok: true });
      // A newer step runs; the stuck step ends late and must not end the newer turn.
      const newer = client.request("orderFlow", { newer: 1 }, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(doFetch).toHaveBeenCalledTimes(3);
      finishStuck(json({ data: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      const behind = client.request("orderFlow", { behind: 1 }, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(doFetch).toHaveBeenCalledTimes(3);
      finishNewer(json({ data: 2 }));
      await expect(newer).resolves.toMatchObject({ data: 2, ok: true });
      await expect(behind).resolves.toMatchObject({ data: 2, ok: true });
      return expect(doFetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a waiter that claims a handed-over turn a full turn, not the 2 s claim", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const finish: Array<(response: Response) => void> = [];
      const doFetch = vi.fn<QuantDataFetch>(
        () =>
          new Promise<Response>((resolve) => {
            finish.push(resolve);
          })
      );
      const client = createQuantDataClient(config, {
        fetch: doFetch,
        minIntervalMs: 0,
      });
      const first = client.request("orderFlow", { id: "a" }, 0);
      const second = client.request("orderFlow", { id: "b" }, 0);
      const third = client.request("orderFlow", { id: "c" }, 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(doFetch).toHaveBeenCalledTimes(1);
      // The first step ends: the second caller claims the turn, and its step runs on.
      finish[0]?.(json({ data: 1 }));
      await expect(first).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(doFetch).toHaveBeenCalledTimes(2);
      // Past the 2 s claim the third caller still waits: the claimed turn is a full one.
      await vi.advanceTimersByTimeAsync(11_999);
      expect(doFetch).toHaveBeenCalledTimes(2);
      // At the step deadline (0 + 10 000 + 2000) the third caller takes over.
      await vi.advanceTimersByTimeAsync(1);
      expect(doFetch).toHaveBeenCalledTimes(3);
      finish[1]?.(json({ data: 1 }));
      finish[2]?.(json({ data: 1 }));
      await expect(second).resolves.toMatchObject({ ok: true });
      return expect(third).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves waiting callers in order, also when the caller before them calls again at once", async () => {
    const order: string[] = [];
    const doFetch = vi.fn<QuantDataFetch>(async (_url, init) => {
      order.push(String((JSON.parse(String(init.body)) as { id: string }).id));
      return json({ data: 1 });
    });
    const client = createQuantDataClient(config, {
      fetch: doFetch,
      minIntervalMs: 0,
    });
    const steady = (async () => {
      for (const id of ["x0", "x1", "x2"])
        await client.request("orderFlow", { id }, 0);
    })();
    const waiter = client.request("orderFlow", { id: "w" }, 0);
    await Promise.all([steady, waiter]);
    return expect(order).toEqual(["x0", "w", "x1", "x2"]);
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
    const result = exposure(oi, chain.rows, 100, TODAY).section;
    expect(result.gexExpiry).toBe("2026-10-23");
    expect(result.maxPain).toBe(100);
    expect(result.strikes).toHaveLength(3);
    expect(result.strikes.every((row) => row.gex !== null)).toBe(true);
    expect(result.totalGex).not.toBeNull();
    expect(exposure(oi, chain.rows, null, TODAY)).toMatchObject({
      section: { gexExpiry: null, totalGex: null },
      strikes: oi.map((row) => ({ ...row, gex: null })),
    });
    expect(exposure(oi, [], 100, TODAY).section.strikes[0]?.gex).toBeNull();
    const sameDay: ChainRow[] = [
      { delta: 0.5, expiry: TODAY, iv: 0.2, right: "call", strike: 100 },
    ];
    expect(exposure(oi, sameDay, 100, TODAY).section.gexExpiry).toBe(TODAY);
    const noIv: ChainRow[] = [
      {
        delta: 0.5,
        expiry: "2026-10-23",
        iv: null,
        right: "call",
        strike: 100,
      },
    ];
    return expect(exposure(oi, noIv, 100, TODAY).section).toMatchObject({
      totalGex: null,
    });
  });

  it("totals GEX over every strike within 50-150% of spot, not only the ones shown", () => {
    // 200 strikes 1..200 around spot 100: 101 are in range, 78 are displayed (55 nearest
    // plus the 25 largest OI, two of them in both sets).
    const wide = Array.from({ length: 200 }, (_, index) => ({
      callOpenInterest: 1000 + index,
      putOpenInterest: 900,
      strike: index + 1,
    }));
    const front: ChainRow[] = wide.flatMap(({ strike }) => [
      { delta: 0.5, expiry: "2027-10-22", iv: 0.4, right: "call", strike },
      { delta: -0.5, expiry: "2027-10-22", iv: 0.45, right: "put", strike },
    ]);
    const { section, strikes } = exposure(wide, front, 100, TODAY);
    expect(strikes).toHaveLength(101);
    expect(strikes[0]?.strike).toBe(50);
    expect(section.strikes).toHaveLength(78);
    const sum = (rows: readonly { gex: number | null }[]): number =>
      rows.reduce((total, row) => total + (row.gex ?? 0), 0);
    expect(section.totalGex).toBeCloseTo(sum(strikes), 6);
    expect(Math.abs(sum(strikes) - sum(section.strikes))).toBeGreaterThan(0);
    // Displayed rows keep the GEX of the same strike in the full set.
    const byStrike = new Map(strikes.map((row) => [row.strike, row.gex]));
    expect(
      section.strikes.every((row) => byStrike.get(row.strike) === row.gex)
    ).toBe(true);
    // No strike in range: every strike counts.
    return expect(inRangeStrikes(wide, 1000)).toHaveLength(200);
  });

  it("reads the first front-expiry IV of a duplicated strike, like a linear find", () => {
    const front: ChainRow[] = [
      { delta: 0.5, expiry: "2026-10-23", iv: 0.3, right: "call", strike: 100 },
      { delta: 0.5, expiry: "2026-10-23", iv: 0.9, right: "call", strike: 100 },
      {
        delta: -0.5,
        expiry: "2026-10-23",
        iv: 0.35,
        right: "put",
        strike: 100,
      },
    ];
    const model = gammaModel(front, 100, TODAY);
    expect(model?.ivAt(100, "call")).toBe(0.3);
    expect(model?.ivAt(100, "put")).toBe(0.35);
    // A strike without its own IV falls back to the front ATM IV.
    return expect(model?.ivAt(105, "call")).toBe(model?.atmIv);
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

const print = (over: Partial<FlowEvent> = {}): FlowEvent => ({
  contract: "SPY 2026-10-23 100C",
  expiry: "2026-10-23",
  flowType: null,
  premium: 100,
  right: "call",
  sentiment: "bullish",
  size: 1,
  strike: 100,
  time: "2026-10-22T14:00:00.000Z",
  unusual: false,
  ...over,
});

describe("strike profiles", () => {
  it("computes the holder payout at each strike, lowest at max pain", () => {
    const oi = parseOpenInterest(oiData);
    // 80: puts at 100 pay 20 x 300 x 100. 100: calls at 80 pay 20 x 10 x 100.
    // 120: calls at 80 and 100 pay 40 x 10 x 100 + 20 x 300 x 100.
    expect(holderPayout(oi, 80)).toBe(600_000);
    expect(holderPayout(oi, 100)).toBe(20_000);
    expect(holderPayout(oi, 120)).toBe(640_000);
    expect(holderPayout([], 100)).toBe(0);
    expect(maxPain(oi)).toBe(100);
    // A tie keeps the first strike in input order.
    return expect(
      maxPain([
        { callOpenInterest: 1, putOpenInterest: 1, strike: 10 },
        { callOpenInterest: 1, putOpenInterest: 1, strike: 20 },
      ])
    ).toBe(10);
  });

  it("counts the prints the options chain counts", () => {
    expect(isCountedPrint(print(), TODAY)).toBe(true);
    expect(isCountedPrint(print({ expiry: TODAY }), TODAY)).toBe(true);
    expect(isCountedPrint(print({ premium: 0 }), TODAY)).toBe(true);
    expect(isCountedPrint(print({ strike: 0 }), TODAY)).toBe(false);
    expect(isCountedPrint(print({ premium: -1 }), TODAY)).toBe(false);
    return expect(isCountedPrint(print({ expiry: "2026-10-21" }), TODAY)).toBe(
      false
    );
  });

  it("uses the GEX display strikes plus the max-pain strike as the ladder", () => {
    const oi = parseOpenInterest(oiData);
    expect(profileStrikes(oi, 100, 100)).toEqual([80, 100, 120]);
    expect(profileStrikes(oi, 100, 300)).toEqual([80, 100, 120, 300]);
    expect(profileStrikes(oi, 100, null)).toEqual([80, 100, 120]);
    expect(profileStrikes([], 100, null)).toEqual([]);
    const wide = Array.from({ length: 200 }, (_, index) => ({
      callOpenInterest: 1000 + index,
      putOpenInterest: 900,
      strike: index + 1,
    }));
    const shown = displayStrikes(inRangeStrikes(wide, 100), 100);
    const ladder = profileStrikes(wide, 100, 1);
    expect(ladder).toHaveLength(shown.length + 1);
    return expect(ladder[0]).toBe(1);
  });

  it("reads the counted prints of the order-flow page with their time span", () => {
    const events = [
      print({ premium: 300, size: 2, time: "2026-10-22T14:05:00.000Z" }),
      print({
        premium: 500,
        right: "put",
        sentiment: "bearish",
        size: 5,
        time: "2026-10-22T13:00:00.000Z",
      }),
      print({ strike: 0, time: "2026-10-22T09:00:00.000Z" }),
      print({ expiry: "2026-10-21", time: "2026-10-22T15:30:00.000Z" }),
    ];
    const flow = pageProfileFlow(events, TODAY, true);
    expect(flow).toMatchObject({
      complete: false,
      newestTradeAt: "2026-10-22T14:05:00.000Z",
      oldestTradeAt: "2026-10-22T13:00:00.000Z",
      source: "quantdata_page",
    });
    expect(flow.groups).toEqual([
      {
        contracts: 2,
        premium: 300,
        right: "call",
        sentiment: "bullish",
        strike: 100,
        trades: 1,
      },
      {
        contracts: 5,
        premium: 500,
        right: "put",
        sentiment: "bearish",
        strike: 100,
        trades: 1,
      },
    ]);
    return expect(pageProfileFlow([], TODAY, false)).toEqual({
      complete: true,
      groups: [],
      newestTradeAt: null,
      oldestTradeAt: null,
      source: "quantdata_page",
    });
  });

  it("joins OI, payout and flow on one ladder and counts prints off it", () => {
    const oi = parseOpenInterest(oiData);
    const events = [
      print({ premium: 300, size: 2 }),
      print({ premium: 500, right: "put", sentiment: "bearish", size: 5 }),
      print({ premium: 70, sentiment: "neutral", size: 7, strike: 120 }),
      print({ premium: 9, size: 9, strike: 95 }),
    ];
    const profiles = strikeProfiles({
      flow: pageProfileFlow(events, TODAY, false),
      maxPainStrike: 100,
      oiRows: oi,
      spot: 100,
    });
    expect(profiles.strikes).toEqual([
      {
        bearishPremium: 0,
        bullishPremium: 0,
        callOpenInterest: 10,
        callVolume: 0,
        holderPayout: 600_000,
        putOpenInterest: 500,
        putVolume: 0,
        strike: 80,
        trades: 0,
      },
      {
        bearishPremium: 500,
        bullishPremium: 300,
        callOpenInterest: 300,
        callVolume: 2,
        holderPayout: 20_000,
        putOpenInterest: 300,
        putVolume: 5,
        strike: 100,
        trades: 2,
      },
      {
        bearishPremium: 0,
        bullishPremium: 0,
        callOpenInterest: 800,
        callVolume: 7,
        holderPayout: 640_000,
        putOpenInterest: 0,
        putVolume: 0,
        strike: 120,
        trades: 1,
      },
    ]);
    expect(profiles.flow).toEqual({
      complete: true,
      newestTradeAt: "2026-10-22T14:00:00.000Z",
      offLadderTrades: 1,
      oldestTradeAt: "2026-10-22T14:00:00.000Z",
      source: "quantdata_page",
      trades: 4,
    });
    // A strike outside the OI rows (the pinned max pain) has zero OI.
    expect(
      strikeProfiles({
        flow: pageProfileFlow([], TODAY, false),
        maxPainStrike: 300,
        oiRows: oi,
        spot: 100,
      }).strikes.at(-1)
    ).toMatchObject({ callOpenInterest: 0, putOpenInterest: 0, strike: 300 });
    // Every print counts, not only the 100 newest events of the flow section.
    const many = Array.from({ length: 150 }, () => print());
    const busy = strikeProfiles({
      flow: pageProfileFlow(many, TODAY, false),
      maxPainStrike: 100,
      oiRows: oi,
      spot: 100,
    });
    expect(busy.strikes[1]?.trades).toBe(150);
    // Stored totals replace the page flow on the same rows.
    const stored = withProfileFlow(profiles.strikes, {
      complete: false,
      groups: [
        {
          contracts: 40,
          premium: 900,
          right: "put",
          sentiment: "bearish",
          strike: 80,
          trades: 4,
        },
      ],
      newestTradeAt: "2026-10-22T14:59:00.000Z",
      oldestTradeAt: "2026-10-21T15:00:00.000Z",
      source: "stored_prints",
    });
    expect(stored.strikes.map((row) => [row.strike, row.putVolume])).toEqual([
      [80, 40],
      [100, 0],
      [120, 0],
    ]);
    expect(stored.strikes[0]?.holderPayout).toBe(600_000);
    return expect(stored.flow).toMatchObject({
      complete: false,
      offLadderTrades: 0,
      source: "stored_prints",
      trades: 4,
    });
  });
});

const storedRepository = (
  over: Partial<{
    totals: FlowOptionStrikeTotalRecord[];
    gaps: FlowOptionGapRecord[];
    okAt: Date | null;
  }> = {}
) => {
  const okAt = over.okAt === undefined ? NOW : over.okAt;
  const samples = (at: Date | null) =>
    at === null
      ? []
      : [
          {
            at,
            items: 10,
            message: null,
            source: "options" as const,
            status: "ok" as const,
            symbol: "SPY" as const,
          },
        ];
  return {
    latestSamples: vi.fn(async () => ({
      latest: samples(okAt),
      latestOk: samples(okAt),
    })),
    optionGaps: vi.fn(async () => over.gaps ?? []),
    readOptionStrikeTotals: vi.fn(async () => over.totals ?? []),
  };
};

describe("stored prints for the strike profiles", () => {
  const window = flowWindow(24, NOW);
  const query = { ...window, now: NOW, symbol: "SPY" as const, today: TODAY };
  const totals: FlowOptionStrikeTotalRecord[] = [
    {
      contracts: 12,
      newestAt: new Date("2026-10-22T14:58:00.000Z"),
      oldestAt: new Date("2026-10-21T16:00:00.000Z"),
      premium: 4000,
      right: "call",
      sentiment: "bullish",
      strike: 100,
      trades: 3,
    },
    {
      contracts: 8,
      newestAt: new Date("2026-10-22T13:00:00.000Z"),
      oldestAt: new Date("2026-10-21T15:30:00.000Z"),
      premium: 2000,
      right: "put",
      sentiment: "neutral",
      strike: 95,
      trades: 2,
    },
  ];

  it("maps an options ticker to the flow symbol that stores its prints", () => {
    expect(storedPrintsSymbol("SPY")).toBe("SPY");
    expect(storedPrintsSymbol("SPX")).toBe("ES");
    expect(storedPrintsSymbol("QQQ")).toBe("QQQ");
    expect(storedPrintsSymbol("NDX")).toBe("NQ");
    return expect(storedPrintsSymbol("AAPL")).toBeNull();
  });

  it("reads every stored print of the window with the page's print filter", async () => {
    expect(window).toEqual({
      end: new Date("2026-10-22T15:00:00.000Z"),
      start: new Date("2026-10-21T15:00:00.000Z"),
    });
    const repository = storedRepository({ totals });
    const flow = await storedProfileFlow(repository, query);
    expect(repository.readOptionStrikeTotals).toHaveBeenCalledWith({
      from: window.start,
      minExpiry: TODAY,
      symbol: "SPY",
      to: window.end,
    });
    expect(repository.optionGaps).toHaveBeenCalledWith("SPY");
    expect(repository.latestSamples).toHaveBeenCalledWith("SPY", ["options"]);
    expect(flow).toEqual({
      complete: true,
      groups: [
        {
          contracts: 12,
          premium: 4000,
          right: "call",
          sentiment: "bullish",
          strike: 100,
          trades: 3,
        },
        {
          contracts: 8,
          premium: 2000,
          right: "put",
          sentiment: "neutral",
          strike: 95,
          trades: 2,
        },
      ],
      newestTradeAt: "2026-10-22T14:58:00.000Z",
      oldestTradeAt: "2026-10-21T15:30:00.000Z",
      source: "stored_prints",
    });
    const empty = await storedProfileFlow(storedRepository(), query);
    return expect(empty).toMatchObject({
      complete: true,
      groups: [],
      newestTradeAt: null,
      oldestTradeAt: null,
    });
  });

  it("is incomplete with a collector gap in the window or a stale collector", async () => {
    const gap: FlowOptionGapRecord = {
      createdAt: NOW,
      endTime: new Date("2026-10-22T10:00:00.000Z"),
      startTime: new Date("2026-10-22T09:00:00.000Z"),
      symbol: "SPY",
    };
    expect(
      (await storedProfileFlow(storedRepository({ gaps: [gap] }), query))
        .complete
    ).toBe(false);
    const before: FlowOptionGapRecord = {
      ...gap,
      endTime: new Date("2026-10-20T10:00:00.000Z"),
      startTime: new Date("2026-10-20T09:00:00.000Z"),
    };
    expect(
      (await storedProfileFlow(storedRepository({ gaps: [before] }), query))
        .complete
    ).toBe(true);
    expect(
      (
        await storedProfileFlow(
          storedRepository({ okAt: new Date("2026-10-22T09:00:00.000Z") }),
          query
        )
      ).complete
    ).toBe(false);
    return expect(
      (await storedProfileFlow(storedRepository({ okAt: null }), query))
        .complete
    ).toBe(false);
  });

  it("outside the session needs a collector run that reached the last close in the window", async () => {
    // Saturday 2026-10-24 11:00 New York: the newest options session closed Friday 16:15 ET (20:15Z).
    const saturday = new Date("2026-10-24T15:00:00.000Z");
    const day = {
      ...flowWindow(24, saturday),
      now: saturday,
      symbol: "SPY" as const,
      today: "2026-10-24",
    };
    const after = new Date("2026-10-23T20:16:00.000Z");
    const early = new Date("2026-10-23T18:00:00.000Z");
    expect(
      (await storedProfileFlow(storedRepository({ okAt: after }), day)).complete
    ).toBe(true);
    // The collector stopped at 14:00 ET Friday: no gap row, but the window is not complete.
    expect(
      (await storedProfileFlow(storedRepository({ okAt: early }), day)).complete
    ).toBe(false);
    // A one-hour window on Saturday holds no session, so it needs no run.
    return expect(
      (
        await storedProfileFlow(storedRepository({ okAt: early }), {
          ...day,
          ...flowWindow(1, saturday),
        })
      ).complete
    ).toBe(true);
  });

  it("on an NYSE holiday and after an early close needs a run that reached that session's close", async () => {
    // Thanksgiving 2026-11-26 12:00 New York: the newest session closed 2026-11-25 16:15 ET (21:15Z),
    // inside the 24-hour window.
    const holiday = new Date("2026-11-26T17:00:00.000Z");
    const holidayQuery = {
      ...flowWindow(24, holiday),
      now: holiday,
      symbol: "SPY" as const,
      today: "2026-11-26",
    };
    expect(
      (
        await storedProfileFlow(
          storedRepository({ okAt: new Date("2026-11-25T21:14:00.000Z") }),
          holidayQuery
        )
      ).complete
    ).toBe(true);
    // A collector that stopped at 14:00 ET on 2026-11-25 did not reach that close.
    expect(
      (
        await storedProfileFlow(
          storedRepository({ okAt: new Date("2026-11-25T19:00:00.000Z") }),
          holidayQuery
        )
      ).complete
    ).toBe(false);
    // 2026-11-27 14:00 New York: the options session closed early at 13:15 ET (18:15Z).
    const afterEarly = new Date("2026-11-27T19:00:00.000Z");
    return expect(
      (
        await storedProfileFlow(
          storedRepository({ okAt: new Date("2026-11-27T18:14:00.000Z") }),
          {
            ...flowWindow(6, afterEarly),
            now: afterEarly,
            symbol: "SPY",
            today: "2026-11-27",
          }
        )
      ).complete
    ).toBe(true);
  });
});

const fakeClient = (
  responses: Partial<Record<QuantDataEndpoint, QuantDataResult>>,
  cooldown = 0
): QuantDataClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    cooldownSeconds: () => cooldown,
    freeStarts: () => 30,
    request: async (endpoint, payload, _ttlMs, cacheKey) => {
      calls.push(
        cacheKey === undefined
          ? [endpoint, payload]
          : [endpoint, payload, cacheKey]
      );
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
    // The GEX context is part of the strict output and comes from the same payloads.
    expect(OptionsAnalyticsOutputSchema.parse(output)).toEqual(output);
    expect(output.context).toMatchObject({
      dealerSignAssumption: "dealers long calls, short puts",
      session: "morning",
    });
    expect(output.context.factors).toHaveLength(11);
    // The paged flow response marks the flow chip; a fake client gives no fetch times.
    const contextFactor = (key: string) =>
      output.context.factors.find((item) => item.key === key);
    expect(contextFactor("flow")?.value).toContain(
      "· first page only, 3 trades"
    );
    expect(contextFactor("freshness")?.detail).toContain(
      "Chain and OI are cached up to 5 min."
    );
    expect(client.calls[2]).toEqual([
      "orderFlow",
      {
        filter: { ticker: "NVDA" },
        timeRange: {
          endTime: "2026-10-22T15:00:00.000Z",
          startTime: "2026-10-22T09:00:00.000Z",
        },
      },
      "NVDA 6h",
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
    expect(empty.context.regime).toBe("no_data");
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
    expect(down.flow).toMatchObject({
      message: "QuantData orderFlow: HTTP 429.",
      status: "unavailable",
    });
    // A local budget refusal has no provider cooldown; its own wait time is reported.
    const budget = await buildOptionsAnalytics(input, {
      client: fakeClient({
        openInterest: { ...limited, retryAfterSeconds: null },
        orderFlow: { ...limited, retryAfterSeconds: 39.5 },
      }),
      now: () => NOW,
    });
    return expect(budget).toMatchObject({
      rateLimited: true,
      retryAfterSeconds: 40,
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
  quantData: QuantDataConfig | null,
  flow?: unknown,
  semanticEvents?: SemanticEventPort
) => {
  const repositories = (flow === undefined
    ? {}
    : { flow }) as unknown as Repositories;
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
      ...(semanticEvents === undefined ? {} : { semanticEvents }),
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
    // The real client stamps each answer, so the context states the fetch age.
    expect(
      output.context.factors.find((item) => item.key === "freshness")?.detail
    ).toContain("Chain and OI fetched 0 min ago");
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

  it("fills the strike profile flow from stored prints for SPY and SPX only", async () => {
    const doFetch = vi.fn<QuantDataFetch>(async (url) =>
      json(
        url.endsWith("term-structure")
          ? { data: chainData, stockPrice: 100 }
          : url.endsWith("open-interest-by-strike")
            ? { data: oiData }
            : { data: flowRows }
      )
    );
    setOptionsAnalyticsForTesting(
      { fetch: doFetch, minIntervalMs: 0 },
      () => NOW
    );
    const stored: FlowOptionStrikeTotalRecord = {
      contracts: 25,
      newestAt: new Date("2026-10-22T14:58:00.000Z"),
      oldestAt: new Date("2026-10-21T16:00:00.000Z"),
      premium: 9000,
      right: "call",
      sentiment: "bullish",
      strike: 120,
      trades: 5,
    };
    const repository = storedRepository({ totals: [stored] });
    const spy = await apiFor(
      session("operator"),
      config,
      repository
    ).optionsAnalytics.snapshot({ flowHours: 6, symbol: "SPY" });
    expect(spy.strikeProfiles.flow).toMatchObject({
      complete: true,
      source: "stored_prints",
      trades: 5,
    });
    expect(
      spy.strikeProfiles.strikes.map((row) => [row.strike, row.callVolume])
    ).toEqual([
      [80, 0],
      [100, 0],
      [120, 25],
    ]);
    expect(repository.readOptionStrikeTotals).toHaveBeenCalledWith({
      from: new Date("2026-10-22T09:00:00.000Z"),
      minExpiry: TODAY,
      symbol: "SPY",
      to: NOW,
    });
    // AAPL prints are not stored: the page prints stay.
    const aapl = await apiFor(
      session("operator"),
      config,
      repository
    ).optionsAnalytics.snapshot({ symbol: "AAPL" });
    expect(aapl.strikeProfiles.flow.source).toBe("quantdata_page");
    expect(repository.readOptionStrikeTotals).toHaveBeenCalledTimes(1);
    // A failed read keeps the page prints.
    const failing = {
      ...storedRepository(),
      readOptionStrikeTotals: vi.fn(async () => {
        throw new Error("database down");
      }),
    };
    const emit = vi.fn<SemanticEventPort["emit"]>(async () => ({
      analytics: "skipped",
      span: "skipped",
      structuredEvent: "emitted",
    }));
    const spx = await apiFor(session("operator"), config, failing, {
      emit,
    }).optionsAnalytics.snapshot({ symbol: "SPX" });
    expect(spx.strikeProfiles.flow.source).toBe("quantdata_page");
    expect(failing.readOptionStrikeTotals).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "ES" })
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: { step: "strike_profiles_stored_read", symbol: "SPX" },
        errorCategory: "storage-error",
        name: "vertex.optionsAnalytics.strikeProfilesStoredRead",
        outcome: "failure",
      })
    );
    // A failed report does not fail the request either.
    const loud = await apiFor(session("operator"), config, failing, {
      emit: vi.fn(async () => {
        throw new Error("sink down");
      }),
    }).optionsAnalytics.snapshot({ symbol: "SPY" });
    expect(loud.strikeProfiles.flow.source).toBe("quantdata_page");
    // Without an event sink the page prints stay, too.
    const quiet = await apiFor(
      session("operator"),
      config,
      failing
    ).optionsAnalytics.snapshot({ symbol: "SPY" });
    expect(quiet.strikeProfiles.flow.source).toBe("quantdata_page");
    setOptionsAnalyticsForTesting({});
  });
});
