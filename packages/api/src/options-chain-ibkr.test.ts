import { describe, expect, it, vi } from "vitest";

import type {
  DeployStatusConfig,
  DeployStatusFetch,
} from "./server/deploy-status.ts";
import { createIbkrOptionsQuoteSource } from "./server/options-chain-ibkr.ts";
import {
  OptionsChainSourceError,
  OptionsChainSourceOff,
} from "./server/options-chain-source.ts";

const TOKEN = "h".repeat(43);
const config: DeployStatusConfig = {
  token: TOKEN,
  url: "https://history.domain.test/",
};
// Wednesday 2026-11-04, 15:00 New York: the US regular session is open.
const OPEN = new Date("2026-11-04T20:00:00.000Z");

const quote = (overrides: Record<string, unknown> = {}) => ({
  ask: 1.42,
  bid: 1.38,
  dataType: "live",
  error: null,
  last: 1.4,
  right: "C",
  strike: 100,
  ...overrides,
});

// The vertex-history-option-chain-v1 body with fictional values.
const document = (overrides: Record<string, unknown> = {}) => {
  const quotes = (overrides["quotes"] as unknown[] | undefined) ?? [
    quote(),
    quote({ ask: 1.25, bid: 1.2, right: "P" }),
  ];
  return {
    cache: { ageSeconds: 0, hit: false, stale: false, ttlSeconds: 5 },
    client_id: 77,
    count: quotes.length,
    expirations: ["20261113", "20261106", "20261106"],
    expiry: "20261106",
    fetchedAt: "2026-11-04T19:59:58Z",
    multiplier: "100",
    request: { expiry: "20261106", strikes: 12, symbol: "DEMO" },
    schema: "vertex-history-option-chain-v1",
    source: "ibkr-gateway",
    tradingClass: "DEMO",
    underlying: {
      ask: 100.6,
      bid: 100.4,
      close: 99,
      dataType: "live",
      last: 100.5,
      price: 100.5,
    },
    ...overrides,
    quotes,
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const sourceFor = (
  respond: () => Response | Promise<Response>,
  now: Date = OPEN
) => {
  const doFetch = vi.fn<DeployStatusFetch>(async () => respond());
  return {
    doFetch,
    source: createIbkrOptionsQuoteSource(config, {
      fetch: doFetch,
      now: () => now,
    }),
  };
};

const failure = async (promise: Promise<unknown>): Promise<Error> =>
  (await promise.then(
    () => null,
    (error: unknown) => error
  )) as Error;

describe("createIbkrOptionsQuoteSource", () => {
  it("reads live quotes, the live underlying price and the expiry list", async () => {
    const { doFetch, source } = sourceFor(() => json(document()));
    await expect(source.read("demo", "2026-11-06")).resolves.toEqual({
      asOf: "2026-11-04T19:59:58Z",
      expiries: ["2026-11-06", "2026-11-13"],
      expiry: "2026-11-06",
      quotes: [
        { ask: 1.42, bid: 1.38, right: "call", strike: 100 },
        { ask: 1.25, bid: 1.2, right: "put", strike: 100 },
      ],
      spot: 100.5,
      warning: null,
    });
    await source.read("DEMO");
    expect(doFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://history.domain.test/option-chain?strikes=12&symbol=DEMO&expiry=20261106",
      "https://history.domain.test/option-chain?strikes=12&symbol=DEMO",
    ]);
    const init = doFetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "GET",
      redirect: "manual",
    });
  });

  it("keeps only usable live quotes", async () => {
    const { source } = sourceFor(() =>
      json(
        document({
          quotes: [
            quote({ strike: 90 }),
            // A zero bid with a positive ask is a real quote.
            quote({ bid: 0, strike: 91 }),
            quote({ dataType: "frozen", strike: 92 }),
            quote({ dataType: "delayed", strike: 93 }),
            quote({ dataType: null, strike: 94 }),
            quote({ error: "timeout", strike: 95 }),
            quote({ bid: null, strike: 96 }),
            quote({ ask: null, strike: 97 }),
            quote({ bid: -0.01, strike: 98 }),
            quote({ ask: 0, bid: 0, strike: 99 }),
            // Crossed: the ask is below the bid.
            quote({ ask: 1.3, bid: 1.38, strike: 101 }),
            quote({ ask: 2, bid: 2, right: "P", strike: 102 }),
          ],
        })
      )
    );
    const snapshot = await source.read("DEMO");
    expect(snapshot.quotes).toEqual([
      { ask: 1.42, bid: 1.38, right: "call", strike: 90 },
      { ask: 1.42, bid: 0, right: "call", strike: 91 },
      { ask: 2, bid: 2, right: "put", strike: 102 },
    ]);
  });

  it("accepts more than 400 expirations: the merge cuts the list, the read does not fail", async () => {
    const expirations = Array.from({ length: 401 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 6 + index))
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "")
    );
    const { source } = sourceFor(() => json(document({ expirations })));
    const snapshot = await source.read("DEMO");
    expect(snapshot.expiries).toHaveLength(401);
    expect([snapshot.expiries[0], snapshot.expiries.at(-1)]).toEqual([
      "2026-11-06",
      "2027-12-11",
    ]);
    expect(snapshot.quotes).toHaveLength(2);
  });

  it("counts the underlying price only when it is live and positive", async () => {
    for (const underlying of [
      { dataType: "frozen", price: 100.5 },
      { dataType: null, price: 100.5 },
      { dataType: "live", price: null },
      { dataType: "live", price: 0 },
    ]) {
      const { source } = sourceFor(() => json(document({ underlying })));
      const snapshot = await source.read("DEMO");
      expect(snapshot.spot).toBeNull();
      expect(snapshot.quotes).toHaveLength(2);
    }
  });

  it("a stale copy carries no live quotes and no spot, only the expiry list", async () => {
    const { source } = sourceFor(() =>
      json(
        document({
          cache: { ageSeconds: 120, hit: true, stale: true, ttlSeconds: 5 },
        })
      )
    );
    await expect(source.read("DEMO")).resolves.toEqual({
      asOf: "2026-11-04T19:59:58Z",
      expiries: ["2026-11-06", "2026-11-13"],
      expiry: "2026-11-06",
      quotes: [],
      spot: null,
      warning: "IBKR sent an old copy, not live quotes",
    });
  });

  it("is off, without a request, outside the US regular session", async () => {
    const closed: readonly (readonly [string, string])[] = [
      ["before the open", "2026-11-04T14:29:00.000Z"],
      ["at the close", "2026-11-04T21:00:00.000Z"],
      ["in the evening", "2026-11-05T01:30:00.000Z"],
      ["on a Saturday", "2026-11-07T17:00:00.000Z"],
      ["on a Sunday", "2026-11-08T17:00:00.000Z"],
      ["on Thanksgiving", "2026-11-26T17:00:00.000Z"],
    ];
    for (const [label, time] of closed) {
      const { doFetch, source } = sourceFor(
        () => json(document()),
        new Date(time)
      );
      const error = await failure(source.read("DEMO"));
      expect(error, label).toBeInstanceOf(OptionsChainSourceOff);
      expect(error.message, label).toBe(
        "IBKR is asked only during the US regular session (09:30 to 16:00 New York)"
      );
      expect(doFetch, label).not.toHaveBeenCalled();
    }
    // The first and the last minute of the session are asked.
    for (const time of [
      "2026-11-04T14:30:00.000Z",
      "2026-11-04T20:59:00.000Z",
    ]) {
      const { doFetch, source } = sourceFor(
        () => json(document()),
        new Date(time)
      );
      await source.read("DEMO");
      expect(doFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("is off when not configured and for symbols that are not plain stock tickers", async () => {
    const doFetch = vi.fn<DeployStatusFetch>(async () => json(document()));
    const unconfigured = await failure(
      createIbkrOptionsQuoteSource(null, {
        fetch: doFetch,
        now: () => OPEN,
      }).read("DEMO")
    );
    expect(unconfigured).toBeInstanceOf(OptionsChainSourceOff);
    expect(unconfigured.message).toBe("IBKR history service is not configured");
    const classShare = await failure(
      createIbkrOptionsQuoteSource(config, {
        fetch: doFetch,
        now: () => OPEN,
      }).read("BRK.B")
    );
    expect(classShare).toBeInstanceOf(OptionsChainSourceOff);
    expect(classShare.message).toBe(
      "IBKR option quotes cover plain US stock tickers only"
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("maps upstream answers to typed failures with fixed messages", async () => {
    const leak = "secret upstream text https://internal.example";
    const cases: readonly (readonly [Response, string, string])[] = [
      [
        json({ error: "bad_request", message: leak }, 400),
        "UPSTREAM_ERROR",
        "IBKR option quotes request was refused",
      ],
      [
        json({ error: "no_option_chain", message: leak }, 404),
        "NOT_FOUND",
        "IBKR lists no options for this symbol and expiry",
      ],
      [
        json({ error: "expiry_not_listed", message: leak }, 404),
        "NOT_FOUND",
        "IBKR lists no options for this symbol and expiry",
      ],
      [
        json({ error: "no_contract", message: leak }, 422),
        "NOT_FOUND",
        "IBKR lists no options for this symbol and expiry",
      ],
      [
        json({ error: "busy", retry_after_seconds: 2 }, 429),
        "UNAVAILABLE",
        "IBKR option quotes are busy; retry later",
      ],
      [
        json({ error: "entitlement", message: leak }, 502),
        "UNAVAILABLE",
        "IBKR market data permissions are missing",
      ],
      [
        json({ error: "ibkr_error", message: leak }, 502),
        "UPSTREAM_ERROR",
        "IBKR option quotes request failed",
      ],
      [
        json({ error: "internal", message: leak }, 500),
        "UPSTREAM_ERROR",
        "IBKR option quotes request failed",
      ],
      [
        json({ error: "timeout", message: leak }, 504),
        "UNAVAILABLE",
        "IBKR option quotes request failed or timed out",
      ],
      [
        new Response("<html>", { status: 200 }),
        "UPSTREAM_ERROR",
        "IBKR option quotes request failed",
      ],
    ];
    for (const [response, code, message] of cases) {
      const { source } = sourceFor(() => response);
      const error = await failure(source.read("DEMO"));
      expect(error).toBeInstanceOf(OptionsChainSourceError);
      expect(error).toMatchObject({ code, message });
      expect(error.message).not.toContain("secret");
    }
  });

  it("is off when the service's option quotes switch is off (HTTP 403)", async () => {
    const { source } = sourceFor(() =>
      json({ error: "disabled", message: "option quotes are off" }, 403)
    );
    const error = await failure(source.read("DEMO"));
    expect(error).toBeInstanceOf(OptionsChainSourceOff);
    expect(error.message).toBe(
      "IBKR option quotes are switched off on the history service"
    );
  });

  it("takes the status from the response, never from upstream body text", async () => {
    // Body messages that repeat the transport's own text for a 403 or a 404.
    const cases: readonly (readonly [number, string, string])[] = [
      [502, "gateway said HTTP 403", "UPSTREAM_ERROR"],
      [502, "History endpoint returned HTTP 403", "UPSTREAM_ERROR"],
      [400, "History endpoint returned HTTP 403", "UPSTREAM_ERROR"],
      [503, "History endpoint returned HTTP 404", "UNAVAILABLE"],
      [504, "upstream HTTP 404", "UNAVAILABLE"],
    ];
    for (const [status, message, code] of cases) {
      const { source } = sourceFor(() =>
        json({ error: "ibkr_error", message }, status)
      );
      const error = await failure(source.read("DEMO"));
      expect(error, `${status} ${message}`).toBeInstanceOf(
        OptionsChainSourceError
      );
      expect(error).toMatchObject({ code });
      expect(error.message).not.toContain("HTTP");
    }
    // A 403 and a 404 keep their meaning whatever the body says.
    const disabled = sourceFor(() =>
      json({ error: "disabled", message: "upstream HTTP 502" }, 403)
    );
    expect(await failure(disabled.source.read("DEMO"))).toBeInstanceOf(
      OptionsChainSourceOff
    );
    const missing = sourceFor(() => new Response("", { status: 404 }));
    expect(await failure(missing.source.read("DEMO"))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("uses global fetch by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json(document()));
    const snapshot = await createIbkrOptionsQuoteSource(config, {
      now: () => OPEN,
    }).read("DEMO");
    expect(snapshot.quotes).toHaveLength(2);
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      "https://history.domain.test/option-chain?strikes=12&symbol=DEMO"
    );
    spy.mockRestore();
  });

  it("reports network failures, timeouts and unexpected errors as unavailable", async () => {
    const down = sourceFor(() => {
      throw new TypeError(`network down ${TOKEN}`);
    });
    const slow = createIbkrOptionsQuoteSource(config, {
      // Promise.withResolvers is not in this package's TypeScript lib.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        }),
      now: () => OPEN,
      timeoutMs: 5,
    });
    // Not a Response: the transport itself breaks.
    const broken = sourceFor(() => ({ status: 200 }) as unknown as Response);
    for (const source of [down.source, slow, broken.source]) {
      const error = await failure(source.read("DEMO"));
      expect(error).toBeInstanceOf(OptionsChainSourceError);
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        message: "IBKR option quotes request failed or timed out",
      });
    }
  });

  it("refuses a body that does not match the wire contract", async () => {
    const broken: readonly Record<string, unknown>[] = [
      { schema: "vertex-history-option-chain-v2" },
      { expiry: "2026-11-06" },
      { expiry: "20261340" },
      { expirations: ["20260230"] },
      // Past the sanity bound.
      { expirations: Array.from({ length: 2001 }, () => "20261106") },
      { count: 5 },
      { fetchedAt: "yesterday" },
      { cache: { stale: "no" } },
      { underlying: { dataType: "live" } },
      { quotes: [quote({ right: "X" })] },
      { quotes: [quote({ strike: 0 })] },
      { quotes: [quote({ bid: "1.2" })] },
      { quotes: [quote({ error: 7 })] },
    ];
    for (const overrides of broken) {
      const { source } = sourceFor(() => json(document(overrides)));
      const error = await failure(source.read("DEMO"));
      expect(error, JSON.stringify(overrides)).toBeInstanceOf(
        OptionsChainSourceError
      );
      expect(error).toMatchObject({
        code: "UPSTREAM_ERROR",
        message: "IBKR option quotes failed schema validation",
      });
    }
    const { source } = sourceFor(() => json([]));
    await expect(source.read("DEMO")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});
