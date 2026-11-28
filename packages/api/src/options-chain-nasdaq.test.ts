import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNasdaqOptionsOpenInterestSource,
  type NasdaqFetch,
  parseNasdaqOpenInterest,
} from "./server/options-chain-nasdaq.ts";
import {
  OptionsChainSourceError,
  OptionsChainSourceOff,
} from "./server/options-chain-source.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const nasdaqDoc = (
  rows: readonly unknown[] | null,
  rCode = 200
): Readonly<{
  data: { table: { rows: readonly unknown[] | null } } | null;
  status: {
    rCode: number;
    bCodeMessage?: readonly { message: string }[] | undefined;
  };
}> => ({
  data: rCode === 200 ? { table: { rows } } : null,
  status: {
    bCodeMessage:
      rCode === 400
        ? [{ message: "Internal vendor message that must never leak" }]
        : undefined,
    rCode,
  },
});

describe("parseNasdaqOpenInterest", () => {
  it("parses positive call and put open interest, skips headers, dashes, zeros, bad numbers and wrong expiries", () => {
    const snapshot = parseNasdaqOpenInterest(
      nasdaqDoc([
        // Header row: skipped.
        {
          c_Openinterest: null,
          drillDownURL: null,
          expirygroup: "December 4, 2026",
          p_Openinterest: null,
          strike: null,
        },
        // Non-object entry: skipped.
        "garbage",
        // Valid SPY 700 row (comma-formatted strike + OI tested too).
        {
          c_Openinterest: "1,023",
          drillDownURL:
            "/market-activity/etf/spy/option-chain/call-put-options/spy---261204c00700000",
          expirygroup: "",
          p_Openinterest: "21685",
          strike: "700.00",
        },
        // Missing drillDownURL still accepted; comma strike accepted; "--" and "0" skipped.
        {
          c_Openinterest: "--",
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: "79198",
          strike: "1,250.50",
        },
        // Non-matching drillDownURL format (no OCC tail) still accepted; strict digit check drops "12abc", "1.5", "0", "-5".
        {
          c_Openinterest: "12abc",
          drillDownURL: "/market-activity/stocks/nvda/option-chain",
          expirygroup: "",
          p_Openinterest: "0",
          strike: "160.00",
        },
        {
          c_Openinterest: "1.5",
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: "-5",
          strike: "165.00",
        },
        // Null OI field on a valid strike row: skipped cleanly.
        {
          c_Openinterest: null,
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: null,
          strike: "170.00",
        },
        // Wrong expiry in drillDownURL (261218 instead of 261204): skipped.
        {
          c_Openinterest: "99999",
          drillDownURL:
            "/market-activity/etf/spy/option-chain/call-put-options/spy---261218C00705000",
          expirygroup: "",
          p_Openinterest: "88888",
          strike: "705.00",
        },
        // Bad strikes ("--", "0", null): skipped.
        {
          c_Openinterest: "500",
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: "500",
          strike: "--",
        },
        {
          c_Openinterest: "500",
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: "500",
          strike: "0",
        },
        {
          c_Openinterest: "500",
          drillDownURL: null,
          expirygroup: "",
          p_Openinterest: "500",
          strike: null,
        },
      ]),
      "2026-12-04"
    );

    expect(snapshot).toEqual({
      expiry: "2026-12-04",
      rows: [
        { openInterest: 1023, right: "call", strike: 700 },
        { openInterest: 21_685, right: "put", strike: 700 },
        { openInterest: 79_198, right: "put", strike: 1250.5 },
      ],
    });
  });

  it("returns empty rows when data or table.rows is null, and maps error rCodes safely", () => {
    expect(parseNasdaqOpenInterest(nasdaqDoc(null), "2026-12-05")).toEqual({
      expiry: "2026-12-05",
      rows: [],
    });
    expect(
      parseNasdaqOpenInterest(
        { data: null, status: { rCode: 200 } },
        "2026-12-05"
      )
    ).toEqual({ expiry: "2026-12-05", rows: [] });

    expect(() => parseNasdaqOpenInterest(nasdaqDoc([]), "bad-date")).toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );
    expect(() => parseNasdaqOpenInterest({ bad: true }, "2026-12-04")).toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );
    expect(() =>
      parseNasdaqOpenInterest(nasdaqDoc(null, 404), "2026-12-04")
    ).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }) as unknown as Error
    );
    expect(() =>
      parseNasdaqOpenInterest(nasdaqDoc(null, 503), "2026-12-04")
    ).toThrow(
      expect.objectContaining({ code: "UNAVAILABLE" }) as unknown as Error
    );
    expect(() =>
      parseNasdaqOpenInterest(nasdaqDoc(null, 401), "2026-12-04")
    ).toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );
  });
});

describe("createNasdaqOptionsOpenInterestSource", () => {
  it("normalizes symbols, falls back from stocks to etf with one shared signal, and caches the working asset class", async () => {
    const signals: AbortSignal[] = [];
    const doFetch = vi.fn<NasdaqFetch>(async (url, init) => {
      if (init.signal) signals.push(init.signal);
      if (url.includes("/SPY/") && url.includes("assetclass=stocks"))
        return jsonResponse(nasdaqDoc(null, 400));
      if (url.includes("/SPY/") && url.includes("assetclass=etf"))
        return jsonResponse(
          nasdaqDoc([
            {
              c_Openinterest: "1023",
              drillDownURL:
                "/market-activity/etf/spy/option-chain/call-put-options/spy---261204c00700000",
              expirygroup: "",
              p_Openinterest: "21685",
              strike: "700.00",
            },
          ])
        );
      if (url.includes("/BRK.B/") && url.includes("assetclass=stocks"))
        return jsonResponse(
          nasdaqDoc([
            {
              c_Openinterest: "410",
              drillDownURL: null,
              expirygroup: "",
              p_Openinterest: "--",
              strike: "450.00",
            },
          ])
        );
      return jsonResponse(nasdaqDoc(null, 400));
    });

    const source = createNasdaqOptionsOpenInterestSource({
      fetch: doFetch,
      maxAssetClassCache: 2,
    });

    const firstSpy = await source.read(" spy ", "2026-12-04");
    expect(firstSpy.rows).toEqual([
      { openInterest: 1023, right: "call", strike: 700 },
      { openInterest: 21_685, right: "put", strike: 700 },
    ]);
    // Both fallback attempts share the exact same AbortSignal.
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);

    // Second SPY call uses cached assetclass=etf directly (1 call).
    await source.read("SPY", "2026-12-04");
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(doFetch.mock.calls[2]?.[0]).toContain("assetclass=etf");

    // Hyphenated symbol normalized to dot form for Nasdaq.
    const brk = await source.read("brk-b", "2026-12-04");
    expect(brk.rows).toEqual([
      { openInterest: 410, right: "call", strike: 450 },
    ]);
    expect(doFetch.mock.calls[3]?.[0]).toContain("/BRK.B/option-chain");

    // Third distinct symbol evicts oldest cached asset class (SPY) when maxAssetClassCache = 2.
    doFetch.mockImplementationOnce(async () =>
      jsonResponse(nasdaqDoc([], 200))
    );
    await source.read("NVDA", "2026-12-04");
    // SPY was evicted so it tries stocks again first.
    await source.read("SPY", "2026-12-04");
    expect(doFetch.mock.calls[5]?.[0]).toContain("assetclass=stocks");
  });

  it("evicts a stale cached asset class if Nasdaq later returns rCode 400 and falls back to the alternate class", async () => {
    let flip = false;
    const doFetch = vi.fn<NasdaqFetch>(async (url) => {
      if (url.includes("assetclass=stocks"))
        return jsonResponse(
          flip
            ? nasdaqDoc(null, 400)
            : nasdaqDoc([
                {
                  c_Openinterest: "100",
                  drillDownURL: null,
                  expirygroup: "",
                  p_Openinterest: "--",
                  strike: "50.00",
                },
              ])
        );
      return jsonResponse(
        nasdaqDoc([
          {
            c_Openinterest: "200",
            drillDownURL: null,
            expirygroup: "",
            p_Openinterest: "--",
            strike: "50.00",
          },
        ])
      );
    });
    const source = createNasdaqOptionsOpenInterestSource({ fetch: doFetch });
    expect(
      (await source.read("DEMO", "2026-12-04")).rows[0]?.openInterest
    ).toBe(100);
    flip = true;
    expect(
      (await source.read("DEMO", "2026-12-04")).rows[0]?.openInterest
    ).toBe(200);
    // Re-cached as etf.
    expect(
      (await source.read("DEMO", "2026-12-04")).rows[0]?.openInterest
    ).toBe(200);
    expect(doFetch.mock.calls.at(-1)?.[0]).toContain("assetclass=etf");
  });

  it("rejects bad inputs, maps HTTP and parse errors safely without leaking vendor messages, and uses global fetch by default", async () => {
    const source = createNasdaqOptionsOpenInterestSource();
    await expect(source.read("   ", "2026-12-04")).rejects.toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );
    await expect(source.read("SPY", "not-a-date")).rejects.toThrow(
      expect.objectContaining({ code: "UPSTREAM_ERROR" }) as unknown as Error
    );

    // Default fetch path via globalThis.fetch spy.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(nasdaqDoc([], 200))
    );
    expect(await source.read("SPY", "2026-12-04")).toEqual({
      expiry: "2026-12-04",
      rows: [],
    });

    // Both stocks & etf rCode 400 -> NOT_FOUND without leaking bCodeMessage.
    const both400 = createNasdaqOptionsOpenInterestSource({
      fetch: vi.fn<NasdaqFetch>(async () => jsonResponse(nasdaqDoc(null, 400))),
    });
    await expect(both400.read("SPX", "2026-12-04")).rejects.toThrow(
      expect.objectContaining({
        code: "NOT_FOUND",
        message: "Nasdaq has no options data for SPX",
      }) as unknown as Error
    );

    const cases: readonly (readonly [
      NasdaqFetch,
      OptionsChainSourceError["code"],
    ])[] = [
      [
        async () => {
          throw new Error("https://api.nasdaq.com/secret-token");
        },
        "UNAVAILABLE",
      ],
      [async () => new Response("nope", { status: 404 }), "NOT_FOUND"],
      [async () => new Response("blocked", { status: 403 }), "UNAVAILABLE"],
      [async () => new Response("slow down", { status: 429 }), "UNAVAILABLE"],
      [async () => new Response("down", { status: 502 }), "UNAVAILABLE"],
      [async () => new Response("teapot", { status: 418 }), "UPSTREAM_ERROR"],
      [
        async () =>
          new Response("{not-json", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        "UPSTREAM_ERROR",
      ],
      [async () => jsonResponse({ unexpected: true }, 200), "UPSTREAM_ERROR"],
      [
        async () =>
          new Response("x".repeat(4 * 1024 * 1024 + 16), { status: 200 }),
        "UPSTREAM_ERROR",
      ],
    ];
    for (const [fn, code] of cases) {
      const s = createNasdaqOptionsOpenInterestSource({ fetch: fn });
      await expect(s.read("SPY", "2026-12-04")).rejects.toThrow(
        expect.objectContaining({ code }) as unknown as Error
      );
    }
  });

  it("pauses after repeated UNAVAILABLE failures and recovers after cooldown or on non-UNAVAILABLE answers", async () => {
    let clockMs = Date.parse("2026-11-27T22:00:00Z");
    let mode: "fail" | "not_found" | "ok" = "fail";
    const doFetch = vi.fn<NasdaqFetch>(async () => {
      if (mode === "fail") return new Response("blocked", { status: 403 });
      if (mode === "not_found") return jsonResponse(nasdaqDoc(null, 400));
      return jsonResponse({ data: null, status: { rCode: 200 } });
    });
    const source = createNasdaqOptionsOpenInterestSource({
      cooldownMs: 300_000,
      fetch: doFetch,
      maxFailuresBeforeCooldown: 2,
      now: () => new Date(clockMs),
    });

    // 1st failure then NOT_FOUND resets streak.
    await expect(source.read("SPY", "2026-12-04")).rejects.toBeInstanceOf(
      OptionsChainSourceError
    );
    mode = "not_found";
    await expect(source.read("SPX", "2026-12-04")).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }) as unknown as Error
    );

    // Now 2 consecutive UNAVAILABLE failures trip cooldown.
    mode = "fail";
    await expect(source.read("SPY", "2026-12-04")).rejects.toBeInstanceOf(
      OptionsChainSourceError
    );
    await expect(source.read("SPY", "2026-12-04")).rejects.toBeInstanceOf(
      OptionsChainSourceError
    );

    const callsBeforeCooldown = doFetch.mock.calls.length;
    await expect(source.read("SPY", "2026-12-04")).rejects.toBeInstanceOf(
      OptionsChainSourceOff
    );
    // No HTTP call during cooldown.
    expect(doFetch).toHaveBeenCalledTimes(callsBeforeCooldown);

    // After cooldown elapses, traffic resumes and success resets failures.
    clockMs += 300_000;
    mode = "ok";
    expect(await source.read("SPY", "2026-12-04")).toEqual({
      expiry: "2026-12-04",
      rows: [],
    });
  });
});
