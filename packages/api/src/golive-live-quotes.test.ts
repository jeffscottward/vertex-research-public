import { describe, expect, it, vi } from "vitest";

import {
  createBridgeQuotesReader,
  GOLIVE_QUOTES_CACHE_MS,
} from "./server/golive-live-quotes.ts";

const TOKEN = "t".repeat(40);
const URL_ = "http://127.0.0.1:3470";
const AS_OF = "2026-11-12T16:00:00.000Z";
const SPREAD = {
  long: { expiry: "20261218", right: "C", strike: 600, symbol: "SPY" },
  short: { expiry: "20261218", right: "C", strike: 610, symbol: "SPY" },
} as const;

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
    async () =>
      new Response(JSON.stringify({ asOf: AS_OF, legs, state: "complete" }), {
        status,
      })
  );

describe("createBridgeQuotesReader", () => {
  it("labels the spread ibkr_live when both legs are live", async () => {
    const fetch = reply([leg(600), leg(610, { ask: 1.15, bid: 1.05 })]);
    const read = createBridgeQuotesReader(URL_, TOKEN, { fetch });
    expect(await read(SPREAD)).toEqual({
      asOf: new Date(AS_OF),
      longAsk: 2.4,
      longBid: 2.3,
      shortAsk: 1.15,
      shortBid: 1.05,
      source: "ibkr_live",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
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
    ["one leg only", [leg(600)]],
  ])("gives no quote for %s", async (_name, legs) => {
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch: reply(legs),
    });
    expect(await read(SPREAD)).toBeNull();
  });

  it("gives no quote on an error status, a throw or bad configuration", async () => {
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: reply([leg(600), leg(610)], 503),
      })(SPREAD)
    ).toBeNull();
    expect(
      await createBridgeQuotesReader(URL_, TOKEN, {
        fetch: async () => {
          throw new Error("down");
        },
      })(SPREAD)
    ).toBeNull();
    const fetch = reply([leg(600), leg(610)]);
    for (const [base, token] of [
      [null, TOKEN],
      ["https://bridge.example", TOKEN],
      [URL_, "short"],
      [URL_, null],
    ] as const)
      expect(
        await createBridgeQuotesReader(base, token, { fetch })(SPREAD)
      ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses a spread quote for the cache window, then reads again", async () => {
    let time = Date.parse(AS_OF);
    const fetch = reply([leg(600), leg(610)]);
    const read = createBridgeQuotesReader(URL_, TOKEN, {
      fetch,
      now: () => new Date(time),
    });
    await read(SPREAD);
    time += GOLIVE_QUOTES_CACHE_MS - 1;
    await read(SPREAD);
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 1;
    await read(SPREAD);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
