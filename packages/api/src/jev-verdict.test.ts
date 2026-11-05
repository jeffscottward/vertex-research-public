import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, type Mock, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  type JevVerdict,
  JevVerdictInputSchema,
  JevVerdictOutputSchema,
} from "./contracts/jev-verdict.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  callJev,
  JEV_DECISIONS_URL,
  JEV_DEFAULT_MODEL,
  type JevConfig,
  type JevFetch,
  resolveJevConfig,
} from "./server/jev-client.ts";
import {
  refreshJevVerdict,
  setJevVerdictForTesting,
} from "./server/jev-verdict.ts";
import {
  buildJevRequestBody,
  buildPublicFeatures,
  createJevVerdictStore,
  JEV_PUBLIC_FIELDS,
  type JevBar,
  parseJevReply,
  publicState,
  toJevVerdictOutput,
  verdictState,
} from "./server/jev-verdict-engine.ts";

const KEY = `fictional-jev-${"k".repeat(20)}`;
const jevConfig: JevConfig = { apiKey: KEY, model: JEV_DEFAULT_MODEL };
const TOKEN = "h".repeat(43);
const history: DeployStatusConfig = {
  token: TOKEN,
  url: "https://quantvps.tailnet.test:8443/vertex-history/v1",
};
const NOW = new Date("2026-11-05T15:00:00.000Z");
const MINUTE = 60_000;

// A fetch that never answers until the request is aborted (timeout tests). The
// project lib (below ES2024) has no Promise.withResolvers, so the executor form stays.
const hangUntilAbort = (
  signal: AbortSignal | null | undefined
): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("abort")));
  });

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });

// 260 rising daily closes 100..359 with volume 1000, last bar volume 2000.
const risingBars = (count = 260): JevBar[] =>
  Array.from({ length: count }, (_, index) => ({
    c: 100 + index,
    t: 1_770_000_000 + index * 86_400,
    v: index === count - 1 ? 2000 : 1000,
  }));

const historyDoc = (bars: readonly JevBar[]) => ({
  as_of: "2026-11-04T00:00:00Z",
  bars: bars.map((bar) => ({ ...bar, h: bar.c, l: bar.c, o: bar.c })),
  cache: { age_seconds: 1, hit: true, stale: false, ttl_seconds: 3600 },
  client_id: 77,
  contract: {
    conId: 1,
    currency: "USD",
    exchange: "SMART",
    lastTradeDateOrContractMonth: null,
    localSymbol: "SPY",
    longName: null,
    matches: 1,
    multiplier: null,
    secType: "STK",
    timeZoneId: "US/Eastern",
  },
  count: bars.length,
  fetched_at: "2026-11-05T14:59:00Z",
  request: {
    barSize: "1 day",
    contractMonth: null,
    currency: "USD",
    duration: "1 Y",
    exchange: "SMART",
    secType: "STK",
    symbol: "SPY",
    useRTH: true,
    whatToShow: "TRADES",
  },
  schema: "vertex-history-bars-v1",
  source: "ibkr-gateway",
});

const jevReply = (
  choice = "BULLISH",
  probabilities: Record<string, unknown> = {
    BEARISH: 0.1,
    BULLISH: 0.75,
    NEUTRAL: 0.15,
  }
) => ({
  answers: {
    decision: { choice, probabilities },
    momentum_healthy: { noul: 0.612_34 },
    reversal_risk_low: { noul: "high" },
    trend_up: { noul: 0.8 },
  },
  model: "typesafe/jev-test",
});

const SENSITIVE_KEYS = [
  "account",
  "account_id",
  "accountId",
  "positions",
  "position",
  "nlv",
  "net_liquidation",
  "balance",
  "cash",
  "orders",
  "open_orders",
  "qty",
  "quantity",
  "cost_basis",
  "pnl",
  "margin",
  "email",
  "owner",
];

describe("JEV public state (privacy allow-list)", () => {
  it("keeps only allow-listed public fields with valid types", () => {
    const raw: Record<string, unknown> = {
      as_of: "2026-11-04",
      last: 101.5,
      recent_closes_1m: [1, 2, 3],
      sma20: Number.NaN,
      sma50: "100",
      ticker: "SPY",
    };
    for (const key of SENSITIVE_KEYS) raw[key] = "U1234567";
    const state = publicState(raw);
    expect(state).toEqual({
      as_of: "2026-11-04",
      last: 101.5,
      recent_closes_1m: [1, 2, 3],
      ticker: "SPY",
    });
    expect(
      publicState({
        as_of: "2026-11-04T00:00:00Z",
        recent_closes_1m: Array.from({ length: 22 }, () => 1),
        ticker: "U1234567 acct",
      })
    ).toEqual({});
    expect(publicState({ recent_closes_1m: [1, "2"] })).toEqual({});
    expect(publicState({ recent_closes_1m: 5 })).toEqual({});
  });

  it("derives price features from daily bars", () => {
    const shuffled = [...risingBars()].reverse();
    const state = buildPublicFeatures(
      "SPY",
      [...shuffled, { c: Number.NaN, t: 1, v: null }, { c: 0, t: 2, v: 5 }],
      "2026-11-04T00:00:00Z"
    );
    expect(state).not.toBeNull();
    expect(Object.keys(state ?? {}).sort()).toEqual(
      [...JEV_PUBLIC_FIELDS].sort()
    );
    expect(state).toMatchObject({
      as_of: "2026-11-04",
      change_5d_pct: 1.41,
      day_change_pct: 0.28,
      high_52w: 359,
      last: 359,
      low_52w: 108,
      sma20: 349.5,
      ticker: "SPY",
      volume_vs_avg20: 2,
    });
    expect(state?.recent_closes_1m).toHaveLength(21);
  });

  it("omits fields it cannot compute and refuses fewer than two bars", () => {
    const state = buildPublicFeatures(
      "QQQ",
      [
        { c: 10, t: 2, v: null },
        { c: 11, t: 1, v: 3 },
      ],
      null
    );
    expect(state).toEqual({
      day_change_pct: -9.09,
      from_high_52w_pct: -9.09,
      from_low_52w_pct: 0,
      high_52w: 11,
      last: 10,
      low_52w: 10,
      recent_closes_1m: [11, 10],
      ticker: "QQQ",
    });
    expect(
      buildPublicFeatures("QQQ", [{ c: 10, t: 1, v: 1 }], null)
    ).toBeNull();
    expect(buildPublicFeatures("QQQ", [], null)).toBeNull();
    // A zero average volume gives no ratio.
    const flat = Array.from({ length: 21 }, (_, index) => ({
      c: 5,
      t: index,
      v: index === 20 ? 10 : 0,
    }));
    expect(buildPublicFeatures("DIA", flat, null)).not.toHaveProperty(
      "volume_vs_avg20"
    );
  });

  it("builds a request body with model, questions and the public state only", () => {
    const state = buildPublicFeatures("SPY", risingBars(), null);
    const body = buildJevRequestBody("model-x", state ?? {});
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body["model"]).toBe("model-x");
    const sent = JSON.stringify(body).toLowerCase();
    for (const key of SENSITIVE_KEYS)
      expect(sent).not.toContain(`"${key.toLowerCase()}"`);
    expect(Object.keys(body["questions"] as object)).toEqual([
      "decision",
      "trend_up",
      "momentum_healthy",
      "reversal_risk_low",
    ]);
  });
});

describe("JEV reply parsing", () => {
  it("returns the stance, probabilities and readable factors", () => {
    expect(parseJevReply(jevReply())).toEqual({
      choice: "BULLISH",
      factors: [
        { key: "trend_up", label: "Uptrend", probability: 0.8 },
        {
          key: "momentum_healthy",
          label: "Healthy momentum",
          probability: 0.6123,
        },
      ],
      model: "typesafe/jev-test",
      probabilities: { BEARISH: 0.1, BULLISH: 0.75, NEUTRAL: 0.15 },
      reason: "P(BULLISH)=0.75; uptrend 0.80, healthy momentum 0.61",
      stance: "BULLISH",
    });
  });

  it("falls back to NEUTRAL below the threshold or without a clear choice", () => {
    const weak = parseJevReply(
      jevReply("BEARISH", { BEARISH: 0.5, BULLISH: "x", NEUTRAL: 2 })
    );
    expect(weak).toMatchObject({
      choice: "BEARISH",
      probabilities: { BEARISH: 0.5, BULLISH: 0, NEUTRAL: 0 },
      stance: "NEUTRAL",
    });
    expect(weak?.reason).toContain("P(BEARISH)=0.50 (below 0.60)");
    expect(parseJevReply(jevReply("NEUTRAL"))).toMatchObject({
      stance: "NEUTRAL",
    });
    const unclear = parseJevReply({
      answers: { decision: { choice: "BUY", probabilities: {} } },
    });
    expect(unclear).toMatchObject({
      choice: null,
      factors: [],
      model: null,
      reason: "no clear choice",
      stance: "NEUTRAL",
    });
  });

  it("rejects replies without a decision or probabilities", () => {
    expect(parseJevReply(null)).toBeNull();
    expect(parseJevReply({ answers: {} })).toBeNull();
    expect(
      parseJevReply({ answers: { decision: { choice: "BULLISH" } } })
    ).toBeNull();
  });
});

const verdict = (decidedAt: string): JevVerdict => ({
  choice: "BULLISH",
  dataAsOf: "2026-11-04",
  decidedAt,
  factors: [],
  model: "m",
  probabilities: { BEARISH: 0.1, BULLISH: 0.8, NEUTRAL: 0.1 },
  reason: "r",
  sentFields: ["ticker"],
  stance: "BULLISH",
});

describe("JEV verdict store and throttle", () => {
  const limits = {
    failureCooldownMs: MINUTE,
    maxCallsPerHour: 3,
    maxEntries: 2,
    minIntervalMs: 30 * MINUTE,
  };

  it("allows one call per symbol per interval, also while a call is in flight", () => {
    const store = createJevVerdictStore(limits);
    const t0 = NOW.getTime();
    expect(store.read("SPY")).toBeNull();
    expect(store.nextAllowedMs("SPY", t0)).toBeNull();
    expect(store.tryStart("SPY", t0)).toEqual({ ok: true });
    expect(store.read("SPY")).toMatchObject({
      inFlight: true,
      lastAttemptMs: t0,
    });
    expect(store.tryStart("SPY", t0 + MINUTE)).toEqual({
      nextAtMs: t0 + 30 * MINUTE,
      ok: false,
    });
    // An in-flight call past its interval still blocks a second call.
    expect(store.nextAllowedMs("SPY", t0 + 40 * MINUTE)).toBe(
      t0 + 40 * MINUTE + 1
    );
    store.succeed("SPY", verdict(NOW.toISOString()));
    expect(store.nextAllowedMs("SPY", t0 + 29 * MINUTE)).toBe(t0 + 30 * MINUTE);
    expect(store.nextAllowedMs("SPY", t0 + 30 * MINUTE)).toBeNull();
    store.fail("SPY", {
      at: NOW.toISOString(),
      code: "JEV_HTTP",
      message: "x",
    });
    expect(store.read("SPY")).toMatchObject({
      inFlight: false,
      lastFailure: { code: "JEV_HTTP" },
      verdict: { stance: "BULLISH" },
    });
  });

  it("caps calls per rolling hour across symbols and evicts the oldest idle entry", () => {
    const store = createJevVerdictStore(limits);
    const t0 = NOW.getTime();
    for (const [index, symbol] of ["A", "B", "C"].entries()) {
      expect(store.tryStart(symbol, t0 + index * MINUTE).ok).toBe(true);
      store.succeed(symbol, verdict(NOW.toISOString()));
    }
    expect(store.tryStart("D", t0 + 5 * MINUTE)).toEqual({
      nextAtMs: t0 + 60 * MINUTE,
      ok: false,
    });
    expect(store.nextAllowedMs("D", t0 + 60 * MINUTE)).toBeNull();
    // maxEntries 2: A was evicted when C was written.
    expect(store.read("A")).toBeNull();
    expect(store.read("C")).not.toBeNull();
    // A failure for a new symbol creates its entry.
    store.fail("E", {
      at: NOW.toISOString(),
      code: "MARKET_DATA",
      message: "x",
    });
    expect(store.read("E")?.lastAttemptMs).toBeNull();
    // A verdict for an unknown symbol (no reservation) still stores.
    store.succeed("F", verdict(NOW.toISOString()));
    expect(store.read("F")?.verdict?.stance).toBe("BULLISH");
  });

  it("never evicts an in-flight entry", () => {
    const store = createJevVerdictStore({ ...limits, maxEntries: 1 });
    expect(store.tryStart("A", 0).ok).toBe(true);
    store.fail("B", {
      at: NOW.toISOString(),
      code: "MARKET_DATA",
      message: "x",
    });
    expect(store.read("A")).not.toBeNull();
    expect(store.read("B")).not.toBeNull();
  });

  it("gives back a reservation that never reached JEV and waits the cooldown", () => {
    const store = createJevVerdictStore(limits);
    const t0 = NOW.getTime();
    const failure = {
      at: NOW.toISOString(),
      code: "MARKET_DATA" as const,
      message: "x",
    };
    // A finished call at t0, then a reservation at t0 + 40 min that fails before JEV.
    expect(store.tryStart("SPY", t0).ok).toBe(true);
    store.succeed("SPY", verdict(NOW.toISOString()));
    expect(store.tryStart("SPY", t0 + 40 * MINUTE).ok).toBe(true);
    store.cancel("SPY", failure, t0 + 41 * MINUTE);
    expect(store.read("SPY")).toMatchObject({
      cooldownUntilMs: t0 + 42 * MINUTE,
      inFlight: false,
      lastAttemptMs: t0,
      lastFailure: { code: "MARKET_DATA" },
      verdict: { stance: "BULLISH" },
    });
    expect(store.nextAllowedMs("SPY", t0 + 41 * MINUTE)).toBe(t0 + 42 * MINUTE);
    expect(store.nextAllowedMs("SPY", t0 + 42 * MINUTE)).toBeNull();
    // The refunded reservation does not count against the hourly cap (3).
    expect(store.tryStart("B", t0 + 42 * MINUTE).ok).toBe(true);
    expect(store.tryStart("C", t0 + 42 * MINUTE).ok).toBe(true);
    expect(store.tryStart("D", t0 + 42 * MINUTE).ok).toBe(false);
    // cancel without a reservation only records the failure and the cooldown.
    store.cancel("E", failure, t0);
    expect(store.read("E")).toMatchObject({
      cooldownUntilMs: t0 + MINUTE,
      lastAttemptMs: null,
    });
  });

  it("marks verdicts stale after the stale window", () => {
    expect(verdictState(null, 0, 1000)).toBe("none");
    const decided = verdict("2026-11-05T15:00:00.000Z");
    expect(verdictState(decided, NOW.getTime() + 1000, 1000)).toBe("fresh");
    expect(verdictState(decided, NOW.getTime() + 1001, 1000)).toBe("stale");
  });

  it("builds the output, with no next refresh when not configured", () => {
    const store = createJevVerdictStore(limits);
    store.tryStart("SPY", NOW.getTime());
    const flags = { configured: false, refreshed: false, throttled: false };
    const timing = { minIntervalMs: 30 * MINUTE, staleAfterMs: 60 * MINUTE };
    const output = toJevVerdictOutput(
      "SPY",
      store,
      NOW.getTime(),
      timing,
      flags
    );
    expect(JevVerdictOutputSchema.parse(output)).toEqual(output);
    expect(output).toMatchObject({
      minIntervalSeconds: 1800,
      nextRefreshAt: null,
      staleAfterSeconds: 3600,
      state: "none",
    });
    expect(
      toJevVerdictOutput("SPY", store, NOW.getTime(), timing, {
        ...flags,
        configured: true,
      }).nextRefreshAt
    ).toBe("2026-11-05T15:30:00.000Z");
  });
});

describe("JEV client", () => {
  it("resolves configuration only for a plausible key", () => {
    expect(resolveJevConfig(undefined)).toBeNull();
    expect(resolveJevConfig(null)).toBeNull();
    expect(resolveJevConfig("short")).toBeNull();
    expect(resolveJevConfig("has a space in the key value")).toBeNull();
    expect(resolveJevConfig(KEY)).toEqual(jevConfig);
    expect(resolveJevConfig(KEY, "other")).toEqual({
      apiKey: KEY,
      model: "other",
    });
  });

  it("posts JSON with the bearer key and never follows redirects", async () => {
    const doFetch = vi.fn<JevFetch>(async () => json({ answers: {} }));
    const result = await callJev(jevConfig, { model: "m" }, { fetch: doFetch });
    expect(result).toEqual({ document: { answers: {} }, ok: true });
    const [url, init] = doFetch.mock.calls[0] ?? [];
    expect(url).toBe(JEV_DECISIONS_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${KEY}`
    );
    expect(init?.body).toBe('{"model":"m"}');
  });

  it("reports failures by category and status only", async () => {
    const call = (
      doFetch: JevFetch,
      options: { timeoutMs?: number; maxBytes?: number } = {}
    ) => callJev(jevConfig, {}, { fetch: doFetch, ...options });
    expect(await call(async () => json({}, { status: 402 }))).toEqual({
      ok: false,
      reason: "http",
      status: 402,
    });
    expect(
      await call(async () => {
        throw new Error(KEY);
      })
    ).toEqual({ ok: false, reason: "http", status: null });
    expect(
      await call((_url, init) => hangUntilAbort(init.signal), {
        timeoutMs: 5,
      })
    ).toEqual({ ok: false, reason: "timeout", status: null });
    expect(await call(async () => new Response("not json"))).toEqual({
      ok: false,
      reason: "invalid",
      status: 200,
    });
    expect(await call(async () => new Response(null))).toEqual({
      ok: false,
      reason: "invalid",
      status: 200,
    });
    expect(
      await call(async () => new Response("x".repeat(64)), { maxBytes: 16 })
    ).toEqual({
      ok: false,
      reason: "invalid",
      status: 200,
    });
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    expect(await call(async () => new Response(broken))).toEqual({
      ok: false,
      reason: "invalid",
      status: 200,
    });
    const stalled = (signal: AbortSignal | null | undefined) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () =>
            controller.error(new Error("abort"))
          );
        },
      });
    expect(
      await call(async (_url, init) => new Response(stalled(init.signal)), {
        timeoutMs: 5,
      })
    ).toEqual({ ok: false, reason: "timeout", status: 200 });
  });

  it("uses the global fetch by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ answers: {} }));
    expect((await callJev(jevConfig, {})).ok).toBe(true);
    spy.mockRestore();
  });
});

type Fetchers = Readonly<{
  bars: Mock<() => Promise<Response>>;
  jev: Mock<JevFetch>;
}>;

const fetchers = (reply: () => Promise<Response>): Fetchers => ({
  bars: vi.fn(async () => json(historyDoc(risingBars()))),
  jev: vi.fn<JevFetch>(reply),
});

describe("refreshJevVerdict", () => {
  const deps = (fetched: Fetchers, now: () => Date = () => NOW) => ({
    barsOptions: { fetch: fetched.bars, now },
    history,
    jev: jevConfig,
    jevOptions: { fetch: fetched.jev },
    now,
    store: createJevVerdictStore({
      failureCooldownMs: MINUTE,
      maxCallsPerHour: 12,
      maxEntries: 10,
      minIntervalMs: 30 * MINUTE,
    }),
  });

  it("stores a verdict and sends only the public state to JEV", async () => {
    const fetched = fetchers(async () => json(jevReply()));
    const output = await refreshJevVerdict("SPY", deps(fetched));
    expect(output).toMatchObject({
      configured: true,
      lastFailure: null,
      refreshed: true,
      state: "fresh",
      throttled: false,
      verdict: {
        dataAsOf: "2026-11-04",
        decidedAt: NOW.toISOString(),
        model: "typesafe/jev-test",
        stance: "BULLISH",
      },
    });
    expect(output.verdict?.sentFields).toEqual([...JEV_PUBLIC_FIELDS]);
    const sent = JSON.parse(String(fetched.jev.mock.calls[0]?.[1].body)) as {
      state: Record<string, unknown>;
    };
    expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
    expect(Object.keys(sent.state).sort()).toEqual(
      [...JEV_PUBLIC_FIELDS].sort()
    );
    expect(JSON.stringify(output)).not.toContain(KEY);
  });

  it("throttles before loading bars and records failures without a verdict", async () => {
    const fetched = fetchers(async () => json({}, { status: 500 }));
    const shared = deps(fetched);
    const failed = await refreshJevVerdict("SPY", shared);
    expect(failed).toMatchObject({
      lastFailure: {
        code: "JEV_HTTP",
        message: "JEV request failed (HTTP 500)",
      },
      refreshed: false,
      state: "none",
    });
    const again = await refreshJevVerdict("SPY", shared);
    expect(again).toMatchObject({
      nextRefreshAt: "2026-11-05T15:30:00.000Z",
      throttled: true,
    });
    expect(fetched.bars).toHaveBeenCalledTimes(1);
    expect(fetched.jev).toHaveBeenCalledTimes(1);
  });

  it("maps every failure kind", async () => {
    const run = async (reply: () => Promise<Response>) =>
      (await refreshJevVerdict("SPY", deps(fetchers(reply)))).lastFailure?.code;
    expect(await run(async () => new Response("nope"))).toBe("JEV_INVALID");
    expect(await run(async () => json({ answers: {} }))).toBe("JEV_INVALID");
    expect(
      await run(async () => {
        throw new Error("down");
      })
    ).toBe("JEV_HTTP");
    const slow = fetchers((async () => json({})) as () => Promise<Response>);
    const slowDeps = {
      ...deps(slow),
      jevOptions: {
        fetch: ((_url: string, init: RequestInit) =>
          hangUntilAbort(init.signal)) satisfies JevFetch,
        timeoutMs: 5,
      },
    };
    expect((await refreshJevVerdict("SPY", slowDeps)).lastFailure?.code).toBe(
      "JEV_TIMEOUT"
    );
    const noBars = fetchers(async () => json(jevReply()));
    noBars.bars.mockImplementation(async () => json({}, { status: 503 }));
    const noBarsOutput = await refreshJevVerdict("SPY", deps(noBars));
    expect(noBarsOutput).toMatchObject({
      lastFailure: { code: "MARKET_DATA" },
      nextRefreshAt: "2026-11-05T15:01:00.000Z",
      throttled: false,
    });
    const oneBar = fetchers(async () => json(jevReply()));
    oneBar.bars.mockImplementation(async () => json(historyDoc(risingBars(1))));
    expect(
      (await refreshJevVerdict("SPY", deps(oneBar))).lastFailure?.code
    ).toBe("INSUFFICIENT_DATA");
    expect(noBars.jev).not.toHaveBeenCalled();
    expect(oneBar.jev).not.toHaveBeenCalled();
  });

  it("lets only one refresh per symbol load bars and call JEV at a time", async () => {
    const fetched = fetchers(async () => json(jevReply()));
    const shared = deps(fetched);
    const [first, second] = await Promise.all([
      refreshJevVerdict("SPY", shared),
      refreshJevVerdict("SPY", shared),
    ]);
    expect([first.refreshed, second.refreshed].sort()).toEqual([false, true]);
    expect([first.throttled, second.throttled].sort()).toEqual([false, true]);
    expect(fetched.bars).toHaveBeenCalledTimes(1);
    expect(fetched.jev).toHaveBeenCalledTimes(1);
  });

  it("keeps the old verdict when a dataless bar set has no as-of date", async () => {
    const fetched = fetchers(async () => json(jevReply()));
    fetched.bars.mockImplementation(async () =>
      json({ ...historyDoc(risingBars(3)), as_of: null })
    );
    const output = await refreshJevVerdict("SPY", deps(fetched));
    expect(output.verdict?.dataAsOf).toBeNull();
  });
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
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
  jev: JevConfig | null,
  marketHistory: DeployStatusConfig | null = history
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
      jev,
      marketHistory,
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

describe("jevVerdict procedures", () => {
  it("validates and upper-cases the symbol", () => {
    expect(JevVerdictInputSchema.parse({ symbol: " brk.b " })).toEqual({
      symbol: "BRK.B",
    });
    expect(JevVerdictInputSchema.safeParse({ symbol: "1X" }).success).toBe(
      false
    );
  });

  it("is operator-only and needs configuration to refresh", async () => {
    const fetched = fetchers(async () => json(jevReply()));
    setJevVerdictForTesting({
      bars: { fetch: fetched.bars },
      jev: { fetch: fetched.jev },
      now: () => NOW,
    });
    await expectCode(
      apiFor(null, jevConfig).jevVerdict.get({ symbol: "SPY" }),
      "UNAUTHORIZED"
    );
    await expectCode(
      apiFor(session("outsider"), jevConfig).jevVerdict.refresh({
        symbol: "SPY",
      }),
      "FORBIDDEN"
    );
    await expectCode(
      apiFor(session("operator"), jevConfig).jevVerdict.get({ symbol: "1X" }),
      "BAD_REQUEST"
    );
    await expectCode(
      apiFor(session("operator"), null).jevVerdict.refresh({ symbol: "SPY" }),
      "NOT_CONFIGURED"
    );
    await expectCode(
      apiFor(session("operator"), jevConfig, null).jevVerdict.refresh({
        symbol: "SPY",
      }),
      "NOT_CONFIGURED"
    );
    expect(
      await apiFor(session("operator"), null).jevVerdict.get({ symbol: "SPY" })
    ).toMatchObject({ configured: false, state: "none" });
    expect(
      await apiFor(session("operator"), jevConfig, null).jevVerdict.get({
        symbol: "SPY",
      })
    ).toMatchObject({ configured: false });
    expect(fetched.bars).not.toHaveBeenCalled();
    expect(fetched.jev).not.toHaveBeenCalled();
  });

  it("refreshes once, then serves the cached verdict without calling JEV", async () => {
    const fetched = fetchers(async () => json(jevReply()));
    let now = NOW;
    setJevVerdictForTesting({
      bars: { fetch: fetched.bars },
      jev: { fetch: fetched.jev },
      now: () => now,
    });
    const api = apiFor(session("operator"), jevConfig);
    expect(await api.jevVerdict.get({ symbol: "spy" })).toMatchObject({
      configured: true,
      state: "none",
      symbol: "SPY",
    });
    expect(await api.jevVerdict.refresh({ symbol: "SPY" })).toMatchObject({
      refreshed: true,
      state: "fresh",
    });
    now = new Date(NOW.getTime() + 61 * MINUTE);
    expect(await api.jevVerdict.get({ symbol: "SPY" })).toMatchObject({
      state: "stale",
      verdict: { stance: "BULLISH" },
    });
    expect(fetched.jev).toHaveBeenCalledTimes(1);
    setJevVerdictForTesting();
    expect(await api.jevVerdict.get({ symbol: "SPY" })).toMatchObject({
      state: "none",
    });
  });
});
