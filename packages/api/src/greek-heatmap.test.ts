import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { GreekHeatmapOutputSchema } from "./contracts/options-analytics.ts";
import { createApiContext } from "./server/context.ts";
import { FLOW_QUANTDATA_CALLER_RESERVE } from "./server/flow-collect.ts";
import { callGreeks } from "./server/gex-context.ts";
import {
  buildGreekHeatmap,
  computeMarks,
  MAX_HEATMAP_EXPIRIES,
  MAX_HEATMAP_STRIKES,
  parseHeatMapCounts,
  perExpiryGexFlip,
} from "./server/greek-heatmap-engine.ts";
import { handleApiRequest } from "./server/handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import {
  buildOptionsGreekHeatmap,
  setOptionsAnalyticsForTesting,
} from "./server/options-analytics.ts";
import { parseChain } from "./server/options-analytics-engine.ts";
import type {
  QuantDataClient,
  QuantDataConfig,
  QuantDataEndpoint,
  QuantDataResult,
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

const chainData = {
  "2026-10-22": {
    "100.0": { CALL: { delta: 0.5, iv: 30 }, PUT: { delta: -0.5, iv: 32 } },
  },
  "2026-10-23": {
    "95.0": { CALL: { delta: 0.85, iv: 30 }, PUT: { delta: -0.2, iv: 35 } },
    "100.0": { CALL: { delta: 0.52, iv: 25 }, PUT: { delta: -0.48, iv: 27 } },
    "105.0": { CALL: { delta: 0.2, iv: 24 }, PUT: { delta: -0.8, iv: 28 } },
    // Null IV row exercises skipping null IVs in buildExpiryIvMap.
    "120.0": { CALL: { delta: 0.05 } },
  },
  "2026-11-20": {
    "95.0": { CALL: { delta: 0.8, iv: 28 }, PUT: { delta: -0.22, iv: 32 } },
    "100.0": { CALL: { delta: 0.53, iv: 26 }, PUT: { delta: -0.47, iv: 28 } },
    "105.0": { CALL: { delta: 0.25, iv: 24 }, PUT: { delta: -0.75, iv: 27 } },
  },
};

const oiHeatMapData = {
  "2026-10-01": { "100.0": { callValue: 500, putValue: 500 } },
  "2026-10-23": {
    "95.0": { callValue: 20, putValue: -1200 },
    "100.0": { callValue: 300, putValue: 290 },
    "105.0": { callValue: 1800 },
  },
  "2026-11-20": {
    "95.0": { putValue: 900 },
    "100.0": { callValue: 400, putValue: 390 },
    "105.0": { callValue: 1500, putValue: 100 },
  },
};

const volumeHeatMapData = {
  "2026-10-23": {
    "95.0": { callValue: 10, putValue: 700 },
    "100.0": { callValue: 300, putValue: 290 },
    "105.0": { callValue: 1400, putValue: 50 },
  },
};

const ok = (body: Record<string, unknown>): QuantDataResult => ({
  body,
  data: body["data"],
  ok: true,
});

const fakeClient = (
  answers: Readonly<{
    termStructure: QuantDataResult;
    oi: QuantDataResult;
    volume: QuantDataResult;
  }>,
  cooldown = 0
): QuantDataClient => ({
  cooldownSeconds: () => cooldown,
  freeStarts: () => 30,
  request: async (endpoint: QuantDataEndpoint, payload) => {
    if (endpoint === "termStructure") return answers.termStructure;
    return payload["dataMode"] === "NET_VOLUME" ? answers.volume : answers.oi;
  },
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

// A QuantData double for the real client: every endpoint of one /charts symbol answers.
const quantDataFetchMock = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/term-structure"))
      return json({ data: chainData, stockPrice: 100 });
    if (url.endsWith("/open-interest-by-strike"))
      return json({
        data: { "100.0": { callOpenInterest: 300, putOpenInterest: 300 } },
      });
    if (url.endsWith("/order-flow/consolidated")) return json({ data: [] });
    if (url.endsWith("/heat-map")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        dataMode?: string;
      };
      return json({
        data:
          body.dataMode === "NET_VOLUME" ? volumeHeatMapData : oiHeatMapData,
        type: "contract",
      });
    }
    return json({ data: {} });
  });

describe("parseHeatMapCounts", () => {
  it("keeps unexpired positive strikes, takes absolute counts, and drops malformed entries", () => {
    const parsed = parseHeatMapCounts(
      {
        "2026-10-21": { "100": { callValue: 50 } },
        "2026-10-22": {
          "100": { putValue: 80 },
        },
        "2026-10-23": {
          "-10": { callValue: 5 },
          "0": { callValue: 5 },
          "95": "not-an-object",
          "96": [1, 2],
          "97": { callValue: 0, putValue: 0 },
          "98": { callValue: Number.NaN, putValue: " " },
          "100": { callValue: 50, putValue: 10 },
          "100.0": { callValue: "250.9", putValue: -120.7 },
          "105": { callValue: 40 },
          bad: { callValue: 5 },
        },
        "not-a-date": { "100": { callValue: 5 } },
      },
      TODAY
    );
    expect(parsed).toEqual([
      { callCount: 0, expiry: "2026-10-22", putCount: 80, strike: 100 },
      { callCount: 300, expiry: "2026-10-23", putCount: 130, strike: 100 },
      { callCount: 40, expiry: "2026-10-23", putCount: 0, strike: 105 },
    ]);
    expect(parseHeatMapCounts(null, TODAY)).toEqual([]);
    expect(parseHeatMapCounts([1, 2], TODAY)).toEqual([]);
  });
});

describe("buildGreekHeatmap math and marks", () => {
  it("computes exact GEX, VEX, Charm, DEX, Volume-GEX, walls, king and per-expiry flip", () => {
    const chain = parseChain(chainData, TODAY).rows;
    const oi = parseHeatMapCounts(oiHeatMapData, TODAY);
    const vol = parseHeatMapCounts(volumeHeatMapData, TODAY);
    const out = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: vol,
      volumeFailure: null,
    });

    expect(GreekHeatmapOutputSchema.parse(out)).toEqual(out);
    expect(out.status).toBe("ok");
    expect(out.expiries).toEqual([
      { dte: 1, expiry: "2026-10-23" },
      { dte: 29, expiry: "2026-11-20" },
    ]);

    // Check strike 100 on 2026-10-23 (DTE=1, T=1/365) against callGreeks directly.
    const years1 = 1 / 365;
    const c = callGreeks(100, 100, 0.25, years1);
    const p = callGreeks(100, 100, 0.27, years1);
    const expectedGex =
      (300 * 100 * c.gamma - 290 * 100 * p.gamma) * 100 * 100 * 0.01;
    const expectedVex =
      (300 * 100 * c.vanna - 290 * 100 * p.vanna) * 100 * 0.01;
    const expectedCharm =
      ((300 * 100 * c.charm - 290 * 100 * p.charm) * 100) / 365;
    const expectedDex = (300 * 100 * c.delta + 290 * 100 * (p.delta - 1)) * 100;

    // Rows are ordered descending by strike (105, 100, 95).
    expect(out.metrics.gex.rows.map((r) => r.strike)).toEqual([105, 100, 95]);
    expect(out.metrics.gex.rows[1]?.values[0]).toBeCloseTo(expectedGex, 6);
    expect(out.metrics.vex.rows[1]?.values[0]).toBeCloseTo(expectedVex, 6);
    expect(out.metrics.charm.rows[1]?.values[0]).toBeCloseTo(expectedCharm, 6);
    expect(out.metrics.dex.rows[1]?.values[0]).toBeCloseTo(expectedDex, 6);

    // Marks: 105 is largest +GEX (call wall), 95 is most negative (put wall).
    expect(out.metrics.gex.marks.callWall).toBe(105);
    expect(out.metrics.gex.marks.putWall).toBe(95);
    expect(out.metrics.gex.marks.kingStrike).not.toBeNull();
    // Per-expiry gamma flip exists between 95 and 105.
    expect(out.metrics.gex.marks.flip).not.toBeNull();
    expect(out.metrics.gex.marks.flip!).toBeGreaterThan(95);
    expect(out.metrics.gex.marks.flip!).toBeLessThan(105);
    // VEX, Charm, DEX have flip: null.
    expect(out.metrics.vex.marks.flip).toBeNull();
    expect(out.metrics.charm.marks.flip).toBeNull();
    expect(out.metrics.dex.marks.flip).toBeNull();
    // Volume-GEX has data for 2026-10-23 and null for 2026-11-20.
    expect(out.metrics.volumeGex.status).toBe("ok");
    expect(out.metrics.volumeGex.expiryTotals[0]).not.toBeNull();
    expect(out.metrics.volumeGex.expiryTotals[1]).toBeNull();
    expect(out.metrics.volumeGex.rows[0]?.values[1]).toBeNull();
    expect(out.metrics.volumeGex.marks.flip).not.toBeNull();
  });

  it("handles 0 DTE (floored to 0.5 days), ATM IV fallback, out-of-range strikes, and missing expiry IV", () => {
    const chain = parseChain(chainData, TODAY).rows;
    const oi = parseHeatMapCounts(
      {
        "2026-10-22": {
          "40": { callValue: 9999 },
          "102": { callValue: 100 },
          "160": { putValue: 9999 },
        },
        "2026-12-18": { "100": { callValue: 500 } },
      },
      TODAY
    );
    const out = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(out.status).toBe("ok");
    expect(out.metrics.gex.rows.map((r) => r.strike)).toEqual([102]);
    expect(out.metrics.gex.marks.callWall).toBe(102);
    expect(out.metrics.gex.marks.putWall).toBeNull();
    expect(out.metrics.gex.marks.flip).toBeNull();
    expect(out.metrics.volumeGex.status).toBe("empty");
    expect(perExpiryGexFlip([], 100)).toBeNull();
  });

  it("caps expiries at MAX_HEATMAP_EXPIRIES, caps strikes at MAX_HEATMAP_STRIKES, and pins marks", () => {
    const manyExpiries: Record<
      string,
      Record<
        string,
        {
          CALL: { delta: number; iv: number };
          PUT: { delta: number; iv: number };
        }
      >
    > = {};
    const manyOi: Record<
      string,
      Record<string, { callValue?: number; putValue?: number }>
    > = {};
    for (let i = 1; i <= 12; i += 1) {
      const exp = `2026-11-${String(i).padStart(2, "0")}`;
      manyExpiries[exp] = {
        "100": { CALL: { delta: 0.5, iv: 25 }, PUT: { delta: -0.5, iv: 25 } },
      };
      manyOi[exp] = {};
      for (let s = 70; s <= 130; s += 2) {
        manyOi[exp][String(s)] = { callValue: 10, putValue: 10 };
      }
    }
    manyOi["2026-11-01"]!["148"] = { callValue: 500_000 };
    manyOi["2026-11-01"]!["52"] = { putValue: 400_000 };
    const chain = parseChain(manyExpiries, TODAY).rows;
    const oi = parseHeatMapCounts(manyOi, TODAY);

    const out = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(out.expiries).toHaveLength(MAX_HEATMAP_EXPIRIES);
    expect(out.metrics.gex.rows).toHaveLength(MAX_HEATMAP_STRIKES);
    const displayed = new Set(out.metrics.gex.rows.map((r) => r.strike));
    expect(displayed.has(out.metrics.gex.marks.callWall!)).toBe(true);
    expect(displayed.has(out.metrics.gex.marks.putWall!)).toBe(true);
    expect(displayed.has(out.metrics.gex.marks.kingStrike!)).toBe(true);
  });

  it("gives no column to an expiry whose strikes are all outside 50-150% of spot", () => {
    const chain = parseChain(chainData, TODAY).rows;
    const oi = parseHeatMapCounts(
      {
        "2026-10-23": { "40": { callValue: 9999 }, "160": { putValue: 9999 } },
        "2026-11-20": { "100": { callValue: 400, putValue: 390 } },
      },
      TODAY
    );
    const out = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(out.expiries).toEqual([{ dte: 29, expiry: "2026-11-20" }]);
    expect(out.metrics.gex.expiryTotals).toHaveLength(1);
    expect(out.metrics.gex.rows.map((row) => row.strike)).toEqual([100]);
  });

  it("breaks exact ties by proximity to spot, then higher strike for king/callWall and lower for putWall", () => {
    // Zero-only map yields null marks.
    expect(computeMarks(new Map([[100, 0]]), 100, null)).toEqual({
      callWall: null,
      flip: null,
      kingStrike: null,
      putWall: null,
    });

    // Equal distance from spot=100 (95 vs 105): higher wins king/callWall, lower wins putWall.
    expect(
      computeMarks(
        new Map([
          [95, 500],
          [105, 500],
        ]),
        100,
        100.5
      )
    ).toEqual({
      callWall: 105,
      flip: 100.5,
      kingStrike: 105,
      putWall: null,
    });
    expect(
      computeMarks(
        new Map([
          [105, -500],
          [95, -500],
        ]),
        100,
        null
      )
    ).toEqual({
      callWall: null,
      flip: null,
      kingStrike: 105,
      putWall: 95,
    });

    // Different distance from spot=100 (90 vs 105): closer strike (105) wins all ties.
    expect(
      computeMarks(
        new Map([
          [90, 500],
          [105, 500],
        ]),
        100,
        null
      )
    ).toEqual({
      callWall: 105,
      flip: null,
      kingStrike: 105,
      putWall: null,
    });
    expect(
      computeMarks(
        new Map([
          [90, -500],
          [105, -500],
        ]),
        100,
        null
      )
    ).toEqual({
      callWall: null,
      flip: null,
      kingStrike: 105,
      putWall: 105,
    });
  });

  it("handles chain failure, missing spot, empty counts, and partial OI/volume failures", () => {
    const chain = parseChain(chainData, TODAY).rows;
    const oi = parseHeatMapCounts(oiHeatMapData, TODAY);
    const vol = parseHeatMapCounts(volumeHeatMapData, TODAY);

    const chainFailed = buildGreekHeatmap({
      chainFailure: "QuantData termStructure: HTTP 502.",
      chainRows: [],
      oiCounts: [],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: null,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(chainFailed.status).toBe("failed");
    expect(chainFailed.metrics.gex.status).toBe("failed");

    const noSpot = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: null,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: vol,
      volumeFailure: null,
    });
    expect(noSpot.status).toBe("empty");

    const volFailedOnly = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: oi,
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: "QuantData heatMap: HTTP 422.",
    });
    expect(volFailedOnly.status).toBe("ok");
    expect(volFailedOnly.metrics.gex.status).toBe("ok");
    expect(volFailedOnly.metrics.volumeGex.status).toBe("failed");

    const oiFailedOnly = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: [],
      oiFailure: "QuantData heatMap: HTTP 500.",
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: vol,
      volumeFailure: null,
    });
    expect(oiFailedOnly.status).toBe("ok");
    expect(oiFailedOnly.metrics.gex.status).toBe("failed");
    expect(oiFailedOnly.metrics.volumeGex.status).toBe("ok");

    const bothEmpty = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: [],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(bothEmpty.status).toBe("empty");
    expect(bothEmpty.expiries).toEqual([]);

    const volFailedOiEmpty = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: [],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: "QuantData heatMap: HTTP 503.",
    });
    expect(volFailedOiEmpty.status).toBe("failed");
    expect(volFailedOiEmpty.message).toBe("QuantData heatMap: HTTP 503.");

    const bothFailed = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: [],
      oiFailure: "OI failed",
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: "Vol failed",
    });
    expect(bothFailed.status).toBe("failed");
    expect(bothFailed.message).toBe("OI failed");
  });

  it("picks the gamma flip crossing nearest spot when multiple crossings exist", () => {
    const chain = parseChain(
      {
        "2026-10-23": {
          "80": { CALL: { delta: 0.9, iv: 20 }, PUT: { delta: -0.1, iv: 20 } },
          "100": { CALL: { delta: 0.5, iv: 20 }, PUT: { delta: -0.5, iv: 20 } },
          "120": { CALL: { delta: 0.1, iv: 20 }, PUT: { delta: -0.9, iv: 20 } },
        },
      },
      TODAY
    ).rows;
    const out = buildGreekHeatmap({
      chainFailure: null,
      chainRows: chain,
      oiCounts: [
        { callCount: 500, expiry: "2026-10-23", putCount: 0, strike: 80 },
        { callCount: 0, expiry: "2026-10-23", putCount: 800, strike: 100 },
        { callCount: 500, expiry: "2026-10-23", putCount: 0, strike: 120 },
      ],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 102,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(out.metrics.gex.marks.flip).not.toBeNull();
    expect(out.metrics.gex.marks.flip!).toBeGreaterThan(100);
  });

  it("never reports a phantom flip on 0 DTE low-IV single-sided books, and handles exact-zero gaps", () => {
    // 0 DTE (0.5d floor) @ 15% IV call-only: normalPdf underflows to 0 on the wings; flip must stay null.
    const lowIvChain = parseChain(
      {
        "2026-10-22": {
          "100": { CALL: { delta: 0.5, iv: 15 }, PUT: { delta: -0.5, iv: 15 } },
        },
      },
      TODAY
    ).rows;
    const callOnly = buildGreekHeatmap({
      chainFailure: null,
      chainRows: lowIvChain,
      oiCounts: [
        { callCount: 1000, expiry: "2026-10-22", putCount: 0, strike: 100 },
      ],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(callOnly.metrics.gex.marks.flip).toBeNull();

    // Two-sided 0 DTE @ 12% IV with puts at 75 and calls at 125: exact-zero underflow gap in between!
    const gapChain = parseChain(
      {
        "2026-10-22": {
          "75": {
            CALL: { delta: 0.99, iv: 12 },
            PUT: { delta: -0.01, iv: 12 },
          },
          "125": {
            CALL: { delta: 0.01, iv: 12 },
            PUT: { delta: -0.99, iv: 12 },
          },
        },
      },
      TODAY
    ).rows;
    const gapBook = buildGreekHeatmap({
      chainFailure: null,
      chainRows: gapChain,
      oiCounts: [
        { callCount: 0, expiry: "2026-10-22", putCount: 1000, strike: 75 },
        { callCount: 1000, expiry: "2026-10-22", putCount: 0, strike: 125 },
      ],
      oiFailure: null,
      rateLimited: false,
      receivedAt: NOW.toISOString(),
      retryAfterSeconds: null,
      spot: 100,
      symbol: "SPY",
      today: TODAY,
      volumeCounts: [],
      volumeFailure: null,
    });
    expect(gapBook.metrics.gex.marks.flip).not.toBeNull();
    expect(gapBook.metrics.gex.marks.flip!).toBeGreaterThan(75);
    expect(gapBook.metrics.gex.marks.flip!).toBeLessThan(125);
  });
});

describe("buildOptionsGreekHeatmap & optionsAnalytics.greekHeatmap procedure", () => {
  it("builds from QuantData responses, rejects non-contract heatMap type, and reports rate limits", async () => {
    const output = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: fakeClient({
          oi: ok({ data: oiHeatMapData, type: "contract" }),
          termStructure: ok({ data: chainData, stockPrice: 100 }),
          volume: ok({ data: volumeHeatMapData, type: "contract" }),
        }),
        now: () => NOW,
      }
    );
    expect(output.status).toBe("ok");
    expect(output.rateLimited).toBe(false);
    expect(output.retryAfterSeconds).toBeNull();

    const wrongType = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: fakeClient({
          oi: ok({ data: oiHeatMapData, type: "single" }),
          termStructure: ok({ data: chainData, stockPrice: 100 }),
          volume: ok({ data: volumeHeatMapData, type: "contract" }),
        }),
        now: () => NOW,
      }
    );
    expect(wrongType.metrics.gex.status).toBe("failed");
    expect(wrongType.metrics.gex.message).toContain("unexpected response type");
    expect(wrongType.metrics.volumeGex.status).toBe("ok");

    // When termStructure fails, heatMap is short-circuited (0 extra calls) and rateLimit still propagates.
    const requestSpy = vi.fn<QuantDataClient["request"]>(async () => ({
      message: "QuantData termStructure: HTTP 429.",
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 41.2,
    }));
    const limitedChain = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: {
          cooldownSeconds: () => 30,
          freeStarts: () => 0,
          request: requestSpy,
        },
        now: () => NOW,
      }
    );
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(limitedChain.rateLimited).toBe(true);
    expect(limitedChain.retryAfterSeconds).toBe(42);
    expect(limitedChain.status).toBe("failed");

    // When termStructure succeeds with empty spot/chain, heatMap is also short-circuited.
    const emptySpy = vi.fn<QuantDataClient["request"]>(async () =>
      ok({ data: {}, stockPrice: 100 })
    );
    const emptyChain = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: {
          cooldownSeconds: () => 0,
          freeStarts: () => 30,
          request: emptySpy,
        },
        now: () => NOW,
      }
    );
    expect(emptySpy).toHaveBeenCalledTimes(1);
    expect(emptyChain.status).toBe("empty");

    // When termStructure succeeds and heatMap is rate-limited, rateLimit + retryAfterSeconds propagate.
    const limitedHeatMap = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: fakeClient(
          {
            oi: {
              message: "QuantData heatMap: HTTP 429.",
              ok: false,
              reason: "rate_limited",
              retryAfterSeconds: null,
            },
            termStructure: ok({ data: chainData, stockPrice: 100 }),
            volume: {
              message: "QuantData heatMap: HTTP 429.",
              ok: false,
              reason: "rate_limited",
              retryAfterSeconds: 50.1,
            },
          },
          30
        ),
        now: () => NOW,
      }
    );
    expect(limitedHeatMap.rateLimited).toBe(true);
    expect(limitedHeatMap.retryAfterSeconds).toBe(51);
    expect(limitedHeatMap.status).toBe("failed");

    // HTTP 422 is QuantData's "data-unavailable": the metric is empty, and the other book is unchanged.
    const noVolume = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: fakeClient({
          oi: ok({ data: oiHeatMapData, type: "contract" }),
          termStructure: ok({ data: chainData, stockPrice: 100 }),
          volume: {
            httpStatus: 422,
            message: "QuantData heatMap: HTTP 422.",
            ok: false,
            reason: "http",
            retryAfterSeconds: null,
          },
        }),
        now: () => NOW,
      }
    );
    expect(noVolume.metrics.volumeGex.status).toBe("empty");
    expect(noVolume.metrics.volumeGex.message).toBe(
      "QuantData returned no per-expiry option volume with IV for this symbol."
    );
    expect(noVolume.metrics.gex.status).toBe("ok");
    expect(noVolume.status).toBe("ok");

    // A rejected key is a failure with the client's message (the panel adds the owner action), not a rate limit.
    const rejected: QuantDataResult = {
      httpStatus: 403,
      message:
        "QuantData heatMap: HTTP 403 (access forbidden — check QUANTDATA_API_KEY or subscription).",
      ok: false,
      reason: "auth_failed",
      retryAfterSeconds: null,
    };
    const rejectedKey = await buildOptionsGreekHeatmap(
      { symbol: "SPY" },
      {
        client: fakeClient({
          oi: rejected,
          termStructure: ok({ data: chainData, stockPrice: 100 }),
          volume: rejected,
        }),
        now: () => NOW,
      }
    );
    expect(rejectedKey.status).toBe("failed");
    expect(rejectedKey.metrics.gex.status).toBe("failed");
    expect(rejectedKey.metrics.gex.message).toContain("HTTP 403");
    expect(rejectedKey.metrics.volumeGex.message).toContain("HTTP 403");
    expect(rejectedKey.rateLimited).toBe(false);
    expect(rejectedKey.retryAfterSeconds).toBeNull();
  });

  it("enforces operator access, NOT_CONFIGURED, and shares the termStructure cache with snapshot", async () => {
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("optionsAnalytics.greekHeatmap")
    ).toBe(false);

    await expect(
      apiFor(null, config).optionsAnalytics.greekHeatmap({ symbol: "SPY" })
    ).rejects.toThrow(ORPCError);
    await expect(
      apiFor(session("outsider"), config).optionsAnalytics.greekHeatmap({
        symbol: "SPY",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      apiFor(session("operator"), null).optionsAnalytics.greekHeatmap({
        symbol: "SPY",
      })
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

    const fetchMock = quantDataFetchMock();

    setOptionsAnalyticsForTesting(
      { fetch: fetchMock, minIntervalMs: 0, now: () => NOW.getTime() },
      () => NOW
    );
    const api = apiFor(session("operator"), config);
    await api.optionsAnalytics.snapshot({ symbol: "SPY" });
    const heatmap = await api.optionsAnalytics.greekHeatmap({ symbol: "SPY" });
    expect(heatmap.status).toBe("ok");
    expect(heatmap.symbol).toBe("SPY");
    const termCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/term-structure")
    );
    expect(termCalls).toHaveLength(1);
    const heatMapCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/heat-map")
    );
    expect(heatMapCalls).toHaveLength(2);
    setOptionsAnalyticsForTesting({});
  });

  it("spends 5 request starts on one uncached symbol, inside the reserve the collector leaves free", async () => {
    const fetchMock = quantDataFetchMock();
    // The cap is the reserve: the worst case, in which the collector used every other start.
    setOptionsAnalyticsForTesting(
      {
        fetch: fetchMock,
        maxRequestsPerMinute: FLOW_QUANTDATA_CALLER_RESERVE,
        minIntervalMs: 0,
        now: () => NOW.getTime(),
      },
      () => NOW
    );
    const api = apiFor(session("operator"), config);
    const snapshot = await api.optionsAnalytics.snapshot({ symbol: "SPY" });
    const heatmap = await api.optionsAnalytics.greekHeatmap({ symbol: "SPY" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(snapshot.rateLimited).toBe(false);
    expect(heatmap.rateLimited).toBe(false);
    expect(heatmap.status).toBe("ok");

    // A second uncached symbol in the same 60 s finds one start: it gets answers that name the
    // rate limit and a retry time, and the client sends nothing more to QuantData.
    const second = await api.optionsAnalytics.snapshot({ symbol: "QQQ" });
    const secondHeatmap = await api.optionsAnalytics.greekHeatmap({
      symbol: "QQQ",
    });
    expect(fetchMock).toHaveBeenCalledTimes(FLOW_QUANTDATA_CALLER_RESERVE);
    expect(second.rateLimited).toBe(true);
    expect(second.retryAfterSeconds).toBe(60);
    expect(secondHeatmap.rateLimited).toBe(true);
    expect(secondHeatmap.retryAfterSeconds).toBe(60);
    expect(secondHeatmap.status).toBe("failed");
    expect(secondHeatmap.metrics.gex.message).toContain(
      "requests per minute is used"
    );
    setOptionsAnalyticsForTesting({});
  });
});
