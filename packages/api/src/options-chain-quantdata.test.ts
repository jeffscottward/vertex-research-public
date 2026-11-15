import { describe, expect, it, vi } from "vitest";

import { OptionsAnalyticsInputSchema } from "./contracts/options-analytics.ts";
import { buildOptionsAnalytics } from "./server/options-analytics.ts";
import { createQuantDataOptionsSource } from "./server/options-chain-quantdata.ts";
import { parseFlow } from "./server/options-analytics-engine.ts";
import {
  type OptionsAnalyticsSnapshot,
  OptionsChainSourceError,
} from "./server/options-chain-source.ts";
import {
  createQuantDataClient,
  type QuantDataClient,
  type QuantDataFetch,
  type QuantDataResult,
} from "./server/quantdata-client.ts";

const NOW = new Date("2026-11-04T20:00:30.000Z");
const EXPIRY = "2026-11-06";

// Fictional values in the provider's shapes.
const chainData = {
  "2026-11-06": {
    "100.0": { CALL: { delta: 0.55, iv: 31 }, PUT: { delta: -0.45, iv: 29 } },
    "105": { CALL: { delta: 0.2 } },
  },
  "2026-11-20": { "100.0": { CALL: { delta: 0.5, iv: 33 } } },
  // Listed without any value: not a row, so the expiry is not listed.
  "2026-12-18": { "100.0": { CALL: {}, PUT: { iv: 0 } } },
  // Before the New York day of NOW: left out.
  "2026-11-03": { "100.0": { CALL: { delta: 0.5, iv: 30 } } },
};

const print = (overrides: Record<string, unknown> = {}) => ({
  contractType: "CALL",
  expirationDate: EXPIRY,
  openInterest: 2400,
  premium: 100_000,
  size: 300,
  strikePrice: 100,
  tradeTime: Date.parse("2026-11-04T15:00:00Z"),
  ...overrides,
});

const flowRows = [
  print(),
  // The newest print that carries an open interest.
  print({
    openInterest: 2500.4,
    premium: 25_000,
    size: 110.9,
    tradeTime: "2026-11-04T18:00:00Z",
  }),
  // Newer still, but without an open interest.
  print({
    openInterest: null,
    premium: 500,
    size: 1,
    tradeTime: "2026-11-04T19:00:00Z",
  }),
  // An older print arriving later in the page does not replace the open interest.
  print({
    openInterest: 9,
    premium: 100,
    size: 5,
    tradeTime: Date.parse("2026-11-04T14:00:00Z"),
  }),
  // A contract the term structure does not list.
  print({
    contractType: "put",
    expirationDate: "2026-11-06T00:00:00Z",
    openInterest: undefined,
    premium: 900,
    size: 2,
    strikePrice: 95,
  }),
  print({ expirationDate: "2026-11-20", premium: 7_000_000 }),
  // An expiry before the New York day of NOW is left out.
  print({ expirationDate: "2026-11-03", premium: 3 }),
  // Rows that do not parse are skipped.
  print({ premium: undefined }),
  print({ contractType: "STOCK" }),
  print({ strikePrice: 0 }),
  // The chain contract has no negative premium.
  print({ premium: -5 }),
  print({ tradeTime: "not a time" }),
  "not a row",
  null,
];

const ok = (body: Record<string, unknown>): QuantDataResult => ({
  body,
  data: body["data"],
  ok: true,
});
const failed = (endpoint: string): QuantDataResult => ({
  message: `QuantData ${endpoint}: HTTP 500.`,
  ok: false,
  reason: "http",
  retryAfterSeconds: null,
});

const fakeClient = (
  responses: Readonly<Record<"termStructure" | "orderFlow", QuantDataResult>>
) => {
  const request = vi.fn<QuantDataClient["request"]>(async (endpoint) =>
    endpoint === "openInterest" ? ok({ data: {} }) : responses[endpoint]
  );
  return { cooldownSeconds: () => 0, request };
};

// The rows of EXPIRY.
const at = (rows: OptionsAnalyticsSnapshot["rows"]) =>
  rows.filter((row) => row.expiry === EXPIRY);

// The rows of EXPIRY by contract.
const byContract = (
  rows: OptionsAnalyticsSnapshot["rows"]
): Record<string, unknown> =>
  Object.fromEntries(at(rows).map((row) => [`${row.strike}${row.right}`, row]));

// Expected rows of EXPIRY by contract.
const ofExpiry = (
  rows: Readonly<Record<string, object>>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [key, { ...row, expiry: EXPIRY }])
  );

describe("createQuantDataOptionsSource", () => {
  it("joins IV and delta with the flow and open interest of each expiry", async () => {
    const client = fakeClient({
      orderFlow: ok({ data: flowRows }),
      termStructure: ok({ data: chainData, stockPrice: 100.2 }),
    });
    const snapshot = await createQuantDataOptionsSource(client, () => NOW).read(
      "DEMO"
    );
    expect(snapshot.spot).toBe(100.2);
    expect(snapshot.warning).toBeNull();
    // Every expiry that has a row, ascending; the rows of every expiry.
    expect(snapshot.expiries).toEqual(["2026-11-06", "2026-11-20"]);
    expect(snapshot.rows).toHaveLength(5);
    expect(snapshot.rows.filter((row) => row.expiry === "2026-11-20")).toEqual([
      {
        delta: 0.5,
        expiry: "2026-11-20",
        flow: { premium: 7_000_000, trades: 1, volume: 300 },
        iv: 0.33,
        openInterest: 2400,
        right: "call",
        strike: 100,
      },
    ]);
    expect(at(snapshot.rows)).toHaveLength(4);
    expect(byContract(snapshot.rows)).toEqual(
      ofExpiry({
        "100call": {
          delta: 0.55,
          flow: { premium: 125_600, trades: 4, volume: 416 },
          iv: 0.31,
          openInterest: 2500,
          right: "call",
          strike: 100,
        },
        "100put": {
          delta: -0.45,
          flow: null,
          iv: 0.29,
          openInterest: null,
          right: "put",
          strike: 100,
        },
        "105call": {
          delta: 0.2,
          flow: null,
          iv: null,
          openInterest: null,
          right: "call",
          strike: 105,
        },
        "95put": {
          delta: null,
          flow: { premium: 900, trades: 1, volume: 2 },
          iv: null,
          openInterest: null,
          right: "put",
          strike: 95,
        },
      })
    );
  });

  it("sends the same requests as the /charts analytics, so both share the cache", async () => {
    const responses = {
      orderFlow: ok({ data: flowRows }),
      termStructure: ok({ data: chainData, stockPrice: 100.2 }),
    };
    const chainClient = fakeClient(responses);
    await createQuantDataOptionsSource(chainClient, () => NOW).read("DEMO");
    const analyticsClient = fakeClient(responses);
    await buildOptionsAnalytics(
      OptionsAnalyticsInputSchema.parse({ symbol: "DEMO" }),
      { client: analyticsClient, now: () => NOW }
    );
    expect(chainClient.request.mock.calls).toEqual([
      ["termStructure", { filter: { ticker: "DEMO" } }, 300_000],
      [
        "orderFlow",
        {
          filter: { ticker: "DEMO" },
          timeRange: {
            endTime: "2026-11-04T20:00:00.000Z",
            startTime: "2026-11-03T20:00:00.000Z",
          },
        },
        60_000,
        "DEMO 24h",
      ],
    ]);
    expect(
      analyticsClient.request.mock.calls.filter(
        ([endpoint]) => endpoint !== "openInterest"
      )
    ).toEqual(chainClient.request.mock.calls);

    // Through the real client: the chain read after an analytics read sends nothing.
    const doFetch = vi.fn<QuantDataFetch>(
      async (url) =>
        new Response(
          JSON.stringify(
            url.endsWith("term-structure")
              ? { data: chainData, stockPrice: 100.2 }
              : { data: url.endsWith("consolidated") ? flowRows : {} }
          ),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
    );
    const client = createQuantDataClient(
      {
        apiKey: "not-a-real-key",
        baseUrl: "https://quantdata.domain.test",
      },
      { fetch: doFetch, minIntervalMs: 0, now: () => NOW.getTime() }
    );
    await buildOptionsAnalytics(
      OptionsAnalyticsInputSchema.parse({ symbol: "DEMO" }),
      { client, now: () => NOW }
    );
    expect(doFetch).toHaveBeenCalledTimes(3);
    const snapshot = await createQuantDataOptionsSource(client, () => NOW).read(
      "DEMO"
    );
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(at(snapshot.rows)).toHaveLength(4);
  });

  it("reports a flow answer with more pages as the first provider page only", async () => {
    const warning =
      "Quant Data order flow: first provider page only, so flow totals can be too low";
    const paged = ok({ data: flowRows, nextSearchAfter: ["1"] });
    const snapshot = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: paged,
        termStructure: ok({ data: chainData, stockPrice: 100.2 }),
      }),
      () => NOW
    ).read("DEMO");
    expect(snapshot).toMatchObject({ flowFirstPageOnly: true, warning });
    // Only the first page is read: no further request.
    expect(at(snapshot.rows)).toHaveLength(4);
    // A failed request is the more important message; the flag stays.
    const noChain = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: paged,
        termStructure: failed("termStructure"),
      }),
      () => NOW
    ).read("DEMO");
    expect(noChain).toMatchObject({
      flowFirstPageOnly: true,
      warning: "QuantData termStructure: HTTP 500.",
    });
    // A page marker that is not a list is not one.
    const single = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: ok({ data: flowRows, nextSearchAfter: null }),
        termStructure: ok({ data: chainData }),
      }),
      () => NOW
    ).read("DEMO");
    expect(single).toMatchObject({ flowFirstPageOnly: false, warning: null });
  });

  it("counts the same prints as the /charts flow parser, numeric strings included", async () => {
    const rows = [
      ...flowRows,
      // Numbers as strings, and `volume` in place of `size`.
      {
        contractType: "CALL",
        expirationDate: EXPIRY,
        openInterest: "2600",
        premium: "250000",
        strikePrice: "100",
        tradeTime: String(Date.parse("2026-11-04T19:30:00Z")),
        volume: "12",
      },
      // No size at all, and an open interest that is not a number.
      print({ openInterest: "n/a", premium: 40, size: undefined }),
      // A negative size counts as a print of size 0, as in /charts.
      print({ openInterest: " ", premium: 60, size: -1 }),
    ];
    const snapshot = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: ok({ data: rows }),
        termStructure: failed("termStructure"),
      }),
      () => NOW
    ).read("DEMO");
    const call = at(snapshot.rows).find(
      (row) => row.right === "call" && row.strike === 100
    );
    expect(call).toMatchObject({
      flow: { premium: 375_700, trades: 7, volume: 428 },
      // The newest print with a usable open interest is the string one.
      openInterest: 2600,
    });
    const charts = parseFlow(rows, "DEMO").filter(
      (event) =>
        event.expiry === EXPIRY && event.premium >= 0 && event.strike > 0
    );
    expect(
      at(snapshot.rows).reduce((sum, row) => sum + (row.flow?.trades ?? 0), 0)
    ).toBe(charts.length);
    expect(
      at(snapshot.rows).reduce((sum, row) => sum + (row.flow?.premium ?? 0), 0)
    ).toBe(charts.reduce((sum, event) => sum + event.premium, 0));
    expect(
      at(snapshot.rows).reduce((sum, row) => sum + (row.flow?.volume ?? 0), 0)
    ).toBe(charts.reduce((sum, event) => sum + event.size, 0));
  });

  it("one failed request does not hide the other", async () => {
    const noFlow = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: failed("orderFlow"),
        termStructure: ok({ data: chainData, stockPrice: 100.2 }),
      }),
      () => NOW
    ).read("DEMO");
    expect(noFlow.warning).toBe("QuantData orderFlow: HTTP 500.");
    expect(noFlow.spot).toBe(100.2);
    expect(noFlow.expiries).toEqual(["2026-11-06", "2026-11-20"]);
    expect(at(noFlow.rows).map((row) => [row.iv, row.flow])).toEqual([
      [0.31, null],
      [0.29, null],
      [null, null],
    ]);
    const noChain = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: ok({ data: flowRows }),
        termStructure: failed("termStructure"),
      }),
      () => NOW
    ).read("DEMO");
    expect(noChain.warning).toBe("QuantData termStructure: HTTP 500.");
    expect(noChain.spot).toBeNull();
    // The expiries of the prints alone.
    expect(noChain.expiries).toEqual(["2026-11-06", "2026-11-20"]);
    expect(byContract(noChain.rows)).toEqual(
      ofExpiry({
        "100call": {
          delta: null,
          flow: { premium: 125_600, trades: 4, volume: 416 },
          iv: null,
          openInterest: 2500,
          right: "call",
          strike: 100,
        },
        "95put": {
          delta: null,
          flow: { premium: 900, trades: 1, volume: 2 },
          iv: null,
          openInterest: null,
          right: "put",
          strike: 95,
        },
      })
    );
  });

  it("failure messages of the real client are fixed texts: no upstream body, URL or header value", async () => {
    const config = {
      apiKey: "not-a-real-key",
      baseUrl: "https://quantdata.domain.test",
    };
    // What each failure reason gives the chain's source message.
    const cases: readonly (readonly [QuantDataFetch, string])[] = [
      [
        async () =>
          new Response("leak https://internal.example/?token=secret", {
            headers: { "x-request-id": "leak-header" },
            status: 500,
          }),
        "QuantData termStructure: HTTP 500.",
      ],
      [
        async () =>
          new Response("leak", {
            headers: { "retry-after": "7" },
            status: 429,
          }),
        "QuantData termStructure: HTTP 429.",
      ],
      [
        async () => new Response("leak, not JSON", { status: 200 }),
        "QuantData termStructure: response is not JSON.",
      ],
      [
        async () =>
          new Response(JSON.stringify({ leak: "x" }), { status: 200 }),
        "QuantData termStructure: unsupported response format.",
      ],
      [
        async () => {
          throw new TypeError("leak https://internal.example");
        },
        "QuantData termStructure: request failed.",
      ],
    ];
    for (const [doFetch, message] of cases) {
      const client = createQuantDataClient(config, {
        fetch: doFetch,
        minIntervalMs: 0,
        now: () => NOW.getTime(),
      });
      const error = await createQuantDataOptionsSource(client, () => NOW)
        .read("DEMO")
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(OptionsChainSourceError);
      expect(error).toMatchObject({ message });
      expect(String(error)).not.toMatch(/leak|secret|internal|not-a-real-key/u);
    }
  });

  it("fails with a typed error when both requests fail", async () => {
    const error = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: failed("orderFlow"),
        termStructure: failed("termStructure"),
      }),
      () => NOW
    )
      .read("DEMO")
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OptionsChainSourceError);
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "QuantData termStructure: HTTP 500.",
    });
  });

  it("answers with no rows and no expiry when the provider lists no usable contract", async () => {
    const snapshot = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: ok({ data: [] }),
        termStructure: ok({
          data: { "2026-12-18": chainData["2026-12-18"] },
        }),
      }),
      () => NOW
    ).read("DEMO");
    expect(snapshot).toEqual({
      expiries: [],
      flowFirstPageOnly: false,
      rows: [],
      spot: null,
      warning: null,
    });
    // Flow data that is not a list of prints gives no flow.
    const odd = await createQuantDataOptionsSource(
      fakeClient({
        orderFlow: ok({ data: { rows: flowRows } }),
        termStructure: ok({ data: chainData }),
      }),
      () => NOW
    ).read("DEMO");
    expect(odd.rows.every((row) => row.flow === null)).toBe(true);
    expect(at(odd.rows)).toHaveLength(3);
    expect(odd.rows).toHaveLength(4);
  });
});
