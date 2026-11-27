import { describe, expect, it, vi } from "vitest";

import {
  bridgeQuotesReaderFor,
  createBridgeQuotesReader,
  GOLIVE_QUOTES_CACHE_MS,
  GOLIVE_QUOTES_TIMEOUT_MS,
} from "./server/golive-live-quotes.ts";

const TOKEN = "t".repeat(40);
const URL_ = "http://127.0.0.1:3470";
const AS_OF = "2026-11-12T16:00:00.000Z";
const spreadAt = (strike: number) =>
  ({
    long: { expiry: "20261218", right: "C", strike, symbol: "SPY" },
    short: {
      expiry: "20261218",
      right: "C",
      strike: strike + 10,
      symbol: "SPY",
    },
  }) as const;
const SPREAD = spreadAt(600);

const leg = (strike: number, overrides: Record<string, unknown> = {}) => ({
  ask: 2.4,
  bid: 2.3,
  dataType: "live",
  expiry: "20261218",
  right: "C",
  strike,
  ...overrides,
});

const reply = (legs: unknown[], status = 200) =>
  vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ asOf: AS_OF, legs, state: "complete" }), {
        status,
      })
  );

// Simulates a cancelled workerd request whose fetch and AbortSignal never settle.
const neverSettlingResponse = (): Promise<Response> =>
  new Promise<Response>(() => {
    // Intentionally unsettled.
  });

describe("createBridgeQuotesReader", () => {
  it("labels a spread ibkr_live when both legs are live", async () => {
    const fetch = reply([leg(600), leg(610, { ask: 1.15, bid: 1.05 })]);
    const read = createBridgeQuotesReader(URL_, TOKEN, { fetch });
    expect(await read([SPREAD])).toEqual([
      {
        asOf: new Date(AS_OF),
        longAsk: 2.4,
        longBid: 2.3,
        shortAsk: 1.15,
        shortBid: 1.05,
        source: "ibkr_live",
      },
    ]);
    const [url, init = {}] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${URL_}/quotes`);
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["x-vertex-bridge-token"]
    ).toBe(TOKEN);
    expect(JSON.parse(String(init.body))).toEqual({
      legs: [SPREAD.long, SPREAD.short],
    });
  });

  it.each([
    ["a delayed leg", [leg(600), leg(610, { dataType: "delayed" })]],
    ["a frozen leg", [leg(600, { dataType: "frozen" }), leg(610)]],
    ["a missing bid", [leg(600, { bid: null }), leg(610)]],
    ["a crossed leg", [leg(600, { ask: 2.2 }), leg(610)]],
    ["another strike", [leg(601), leg(610)]],
    ["a leg count that does not match", [leg(600), leg(610), leg(620)]],
  ])("gives no quote for %s", async (_name, legs) => {
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch: reply(legs),
    });
    expect(await read([SPREAD])).toEqual([null]);
  });

  it("asks once for up to 4 spreads and again for the rest, in order", async () => {
    const spreads = [600, 620, 640, 660, 680].map(spreadAt);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { legs } = JSON.parse(String(init?.body)) as {
        legs: { strike: number }[];
      };
      return Response.json({
        asOf: AS_OF,
        legs: legs.map((x) => leg(x.strike)),
        state: "complete",
      });
    });
    const quotes = await createBridgeQuotesReader(URL_, TOKEN, { fetch })(
      spreads
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(quotes.map((quote) => quote?.source)).toEqual([
      "ibkr_live",
      "ibkr_live",
      "ibkr_live",
      "ibkr_live",
      "ibkr_live",
    ]);
  });

  it("gives no quote on an error status, a throw or bad configuration", async () => {
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: reply([leg(600), leg(610)], 503),
      })([SPREAD])
    ).toEqual([null]);
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: async () => {
          throw new Error("down");
        },
      })([SPREAD])
    ).toEqual([null]);
    const fetch = reply([leg(600), leg(610)]);
    for (const [base, token] of [
      [null, TOKEN],
      ["https://bridge.example", TOKEN],
      [URL_, "short"],
      [URL_, null],
    ] as const)
      expect(
        await createBridgeQuotesReader(base, token, { fetch })([SPREAD])
      ).toEqual([null]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses a spread quote for the cache window, then reads again", async () => {
    let time = Date.parse(AS_OF);
    const fetch = reply([leg(600), leg(610)]);
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch,
      now: () => new Date(time),
    });
    await read([SPREAD]);
    time += GOLIVE_QUOTES_CACHE_MS - 1;
    await read([SPREAD]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 1;
    await read([SPREAD]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one bridge run between callers and asks again soon after a miss", async () => {
    let time = Date.parse(AS_OF);
    const fetch = reply([leg(600), leg(610, { dataType: "delayed" })]);
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch,
      now: () => new Date(time),
    });
    const [a, b] = await Promise.all([read([SPREAD]), read([SPREAD])]);
    expect([a, b]).toEqual([[null], [null]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 9999;
    expect(await read([SPREAD])).toEqual([null]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 1;
    await read([SPREAD]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives no quote for a body that is not JSON or a time that does not parse", async () => {
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: async () => new Response("not json"),
      })([SPREAD])
    ).toEqual([null]);
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: async () =>
          Response.json({
            asOf: "yesterday",
            legs: [leg(600), leg(610)],
            state: "complete",
          }),
      })([SPREAD])
    ).toEqual([null]);
  });

  it("uses the global fetch by default and keeps one reader per bridge configuration", async () => {
    const fetch = reply([leg(600), leg(610)]);
    vi.stubGlobal("fetch", fetch);
    try {
      const reader = bridgeQuotesReaderFor(URL_, TOKEN);
      expect(bridgeQuotesReaderFor(URL_, TOKEN)).toBe(reader);
      expect(bridgeQuotesReaderFor(null, null)).not.toBe(reader);
      expect((await reader([SPREAD]))[0]?.source).toBe("ibkr_live");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("bounds cross-request waits on an orphaned in-flight read and evicts it on timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let time = Date.parse(AS_OF);
      let calls = 0;
      const fetch = vi.fn((_url: string, _init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return neverSettlingResponse();
        return Promise.resolve(
          new Response(
            JSON.stringify({
              asOf: AS_OF,
              legs: [leg(600), leg(610)],
              state: "complete",
            }),
            { status: 200 }
          )
        );
      });
      const read = createBridgeQuotesReader(URL_, TOKEN, {
        fetch,
        now: () => new Date(time),
      });

      const first = read([SPREAD]);
      time += 10_000;
      const second = read([SPREAD]);
      const third = read([SPREAD]);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Joined 10 s after the first caller: remaining window is GOLIVE_QUOTES_TIMEOUT_MS - 10 s.
      await vi.advanceTimersByTimeAsync(GOLIVE_QUOTES_TIMEOUT_MS - 10_001);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(await second).toEqual([null]);
      expect(await third).toEqual([null]);

      // The orphaned entry was evicted, so a new caller starts a fresh bridge read immediately.
      const fourth = await read([SPREAD]);
      expect(fourth[0]?.source).toBe("ibkr_live");
      expect(fetch).toHaveBeenCalledTimes(2);

      // When the original caller's own timer later expires, it must not evict the newer live entry.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toEqual([null]);
      expect(vi.getTimerCount()).toBe(0);

      const fifth = await read([SPREAD]);
      expect(fifth[0]?.source).toBe("ibkr_live");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts an unsettled in-flight entry once its timeout window has elapsed", async () => {
    let time = Date.parse(AS_OF);
    let calls = 0;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return neverSettlingResponse();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            asOf: AS_OF,
            legs: [leg(600), leg(610)],
            state: "complete",
          }),
          { status: 200 }
        )
      );
    });
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch,
      now: () => new Date(time),
      timeoutMs: 200,
    });

    const orphaned = read([SPREAD]);
    // Past timeoutMs (well inside GOLIVE_QUOTES_CACHE_MS): sweep evicts the hung entry immediately.
    time += 200;
    const recovered = await read([SPREAD]);
    expect(recovered[0]?.source).toBe("ibkr_live");
    expect(fetch).toHaveBeenCalledTimes(2);
    // Original hung call settles via its own waitAtMost timer without evicting the recovered hit.
    expect(await orphaned).toEqual([null]);
    expect((await read([SPREAD]))[0]?.source).toBe("ibkr_live");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns fresh quotes alongside a timed-out shared read and clears timers on settlement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let time = Date.parse(AS_OF);
      const other = spreadAt(620);
      let resolveSecond!: (response: Response) => void;
      const fetch = vi.fn((_url: string, init?: RequestInit) => {
        const { legs } = JSON.parse(String(init?.body)) as {
          legs: { strike: number }[];
        };
        if (legs[0]?.strike === 600) return neverSettlingResponse();
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      });
      const read = createBridgeQuotesReader(URL_, TOKEN, {
        fetch,
        now: () => new Date(time),
        timeoutMs: 500,
      });

      const hung = read([SPREAD]);
      // Simulate slight backward clock skew: wait stays clamped to timeoutMs.
      time -= 5000;
      const mixed = read([SPREAD, other]);
      const sharedOther = read([other]);

      resolveSecond(
        new Response(
          JSON.stringify({
            asOf: AS_OF,
            legs: [leg(620), leg(630)],
            state: "complete",
          }),
          { status: 200 }
        )
      );
      expect((await sharedOther)[0]?.source).toBe("ibkr_live");

      await vi.advanceTimersByTimeAsync(500);
      const [firstQuote, secondQuote] = await mixed;
      expect(firstQuote).toBeNull();
      expect(secondQuote?.source).toBe("ibkr_live");
      expect(await hung).toEqual([null]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
