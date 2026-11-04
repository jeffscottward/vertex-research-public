import { beforeEach, describe, expect, it } from "vitest";

import {
  BASKET_HISTORY_DEFERRED_REASON,
  BASKET_HISTORY_LIMITS,
  type BasketHistoryLoader,
  loadBasketCloses,
  resetBasketHistoryCache,
  type SymbolCloses,
} from "./server/basket-history.ts";

const ok = (symbol: string, close = 10): SymbolCloses => ({
  symbol,
  closes: [{ date: "2026-10-22", close }],
  fetchedAt: new Date("2026-10-23T00:00:00Z"),
  reason: null,
});

const failed = (symbol: string): SymbolCloses => ({
  symbol,
  closes: null,
  fetchedAt: null,
  reason: "IBKR history pacing: retry in 30 s",
});

// Lets other pending valuations run; time itself is the fake clock below.
const yieldTurn = async () => {
  for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
};

// A fake history service: each request takes `latencyMs` of fake time, and the test records
// the request order and the highest number of requests in flight.
const fakeHistory = (
  respond: (symbol: string, call: number) => SymbolCloses = (symbol) =>
    ok(symbol),
  latencyMs = 10_000
) => {
  let time = 1_000_000;
  let inFlight = 0;
  const state = { requests: [] as string[], maxInFlight: 0 };
  const loader: BasketHistoryLoader = {
    clock: () => time,
    sleep: async (ms) => {
      time += ms;
      await yieldTurn();
    },
    fetchCloses: async (symbol) => {
      state.requests.push(symbol);
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      await yieldTurn();
      time += latencyMs;
      inFlight -= 1;
      return respond(symbol, state.requests.length);
    },
  };
  return {
    loader,
    state,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

beforeEach(() => {
  resetBasketHistoryCache();
});

describe("loadBasketCloses", () => {
  it("sends one request at a time across valuations and reuses fresh results", async () => {
    const history = fakeHistory(undefined, 1000);
    const [first, second] = await Promise.all([
      loadBasketCloses("h", ["AAA", "BBB", "SPY"], history.loader),
      loadBasketCloses("h", ["BBB", "SPY", "CCC", "SPY"], history.loader),
    ]);
    expect(history.state.maxInFlight).toBe(1);
    expect([...history.state.requests].sort()).toEqual([
      "AAA",
      "BBB",
      "CCC",
      "SPY",
    ]);
    expect(first?.map((entry) => entry.symbol)).toEqual(["AAA", "BBB", "SPY"]);
    expect(second?.map((entry) => entry.symbol)).toEqual([
      "BBB",
      "SPY",
      "CCC",
      "SPY",
    ]);

    // Inside the fresh window nothing is requested again; another endpoint has its own cache.
    history.advance(BASKET_HISTORY_LIMITS.freshMs - 10_000);
    await loadBasketCloses("h", ["AAA", "SPY"], history.loader);
    expect(history.state.requests).toHaveLength(4);
    await loadBasketCloses("other", ["AAA"], history.loader);
    expect(history.state.requests).toHaveLength(5);
  });

  it("defers symbols past the time budget and loads never-loaded symbols first", async () => {
    const history = fakeHistory();
    const cold = await loadBasketCloses(
      "h",
      ["AAA", "BBB", "CCC"],
      history.loader
    );
    // 10 s per request: AAA at 0 s, BBB at 10 s, then the 15 s budget is spent.
    expect(history.state.requests).toEqual(["AAA", "BBB"]);
    expect(cold[2]).toEqual({
      symbol: "CCC",
      closes: null,
      fetchedAt: null,
      reason: BASKET_HISTORY_DEFERRED_REASON,
    });

    // After the fresh window, CCC (never loaded) goes first; the expired AAA and BBB then
    // use their last good closes instead of waiting.
    history.advance(BASKET_HISTORY_LIMITS.freshMs);
    const next = await loadBasketCloses(
      "h",
      ["AAA", "BBB", "CCC"],
      history.loader
    );
    expect(history.state.requests).toEqual(["AAA", "BBB", "CCC", "AAA"]);
    expect(next.map((entry) => entry.reason)).toEqual([null, null, null]);
    expect(next[1]?.closes).toEqual(ok("BBB").closes);
  });

  it("keeps a failure for the retry window and falls back to the last good closes", async () => {
    let fail = false;
    const history = fakeHistory((symbol) =>
      fail ? failed(symbol) : ok(symbol)
    );
    await loadBasketCloses("h", ["AAA"], history.loader);

    // The refresh fails: the last good closes are returned and reused until the retry time.
    fail = true;
    history.advance(BASKET_HISTORY_LIMITS.freshMs);
    expect((await loadBasketCloses("h", ["AAA"], history.loader))[0]).toEqual(
      ok("AAA")
    );
    expect((await loadBasketCloses("h", ["AAA"], history.loader))[0]).toEqual(
      ok("AAA")
    );
    expect(history.state.requests).toEqual(["AAA", "AAA"]);

    // A symbol that never loaded reports its failure, and is not asked again within the retry window.
    expect(
      (await loadBasketCloses("h", ["ZZZ"], history.loader))[0]?.reason
    ).toBe("IBKR history pacing: retry in 30 s");
    expect(
      (await loadBasketCloses("h", ["ZZZ"], history.loader))[0]?.reason
    ).toBe("IBKR history pacing: retry in 30 s");
    expect(history.state.requests).toEqual(["AAA", "AAA", "ZZZ"]);
    history.advance(BASKET_HISTORY_LIMITS.retryMs);
    fail = false;
    expect(
      (await loadBasketCloses("h", ["ZZZ"], history.loader))[0]?.reason
    ).toBeNull();
  });

  it("drops last good closes older than the keep window", async () => {
    let fail = false;
    const history = fakeHistory((symbol) =>
      fail ? failed(symbol) : ok(symbol)
    );
    await loadBasketCloses("h", ["AAA"], history.loader);
    fail = true;
    history.advance(BASKET_HISTORY_LIMITS.keepMs);
    expect(
      (await loadBasketCloses("h", ["AAA"], history.loader))[0]?.reason
    ).toBe("IBKR history pacing: retry in 30 s");

    // Budget spent before the request: a stale-beyond-keep symbol is deferred, not reused.
    history.advance(BASKET_HISTORY_LIMITS.retryMs);
    const spent = await loadBasketCloses("h", ["AAA"], {
      ...history.loader,
      limits: { budgetMs: 0 },
    });
    expect(spent[0]?.reason).toBe(BASKET_HISTORY_DEFERRED_REASON);
  });

  it("takes over a claim abandoned by a cancelled request", async () => {
    const history = fakeHistory(undefined, 0);
    // Claims the single request slot at once and never answers until released.
    // (The project's TypeScript lib predates Promise.withResolvers.)
    let release: (value: SymbolCloses) => void = () => undefined;
    const answer = new Promise<SymbolCloses>((resolve) => {
      release = resolve;
    });
    const stuck = loadBasketCloses("h", ["AAA"], {
      ...history.loader,
      fetchCloses: () => answer,
    });
    // The waiting request polls until the claim is older than claimMs, then sends its own.
    const waiting = await loadBasketCloses("h", ["BBB"], {
      ...history.loader,
      limits: { budgetMs: BASKET_HISTORY_LIMITS.claimMs * 2 },
    });
    expect(waiting[0]?.reason).toBeNull();
    expect(history.state.requests).toEqual(["BBB"]);
    release(ok("AAA", 12));
    expect((await stuck)[0]?.closes).toEqual(ok("AAA", 12).closes);

    // The late finisher did not clear the claim of a newer request.
    await loadBasketCloses("h", ["CCC"], history.loader);
    expect(history.state.requests).toEqual(["BBB", "CCC"]);
  });

  it("drops the oldest symbols beyond the size cap", async () => {
    const history = fakeHistory(undefined, 0);
    const loader = { ...history.loader, limits: { maxEntries: 1 } };
    await loadBasketCloses("h", ["AAA"], loader);
    await loadBasketCloses("h", ["BBB"], loader);
    await loadBasketCloses("h", ["BBB"], loader);
    expect(history.state.requests).toEqual(["AAA", "BBB"]);
    await loadBasketCloses("h", ["AAA"], loader);
    expect(history.state.requests).toEqual(["AAA", "BBB", "AAA"]);
  });
});
