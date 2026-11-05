import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { LoopbackStatusError } from "./server/loopback-status.ts";
import {
  fetchMarketContext,
  setMarketContextOptionsForTesting,
  toMarketContext,
} from "./server/market-context.ts";
import { MCP_TOOLS } from "./server/mcp.ts";

const BASE = "http://127.0.0.1:3462";
const NOW = new Date("2026-11-03T15:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;

const gexRow = (symbol: "SPY" | "QQQ") => ({
  symbol,
  status: "ok",
  spot: 752.69,
  netGex: -12_500_453_319,
  regime: "amplified",
  flip: 768.49,
  spotVsFlip: "below",
  callWall: 752,
  putWall: 750,
  netVex: 1_676_461_251,
  netChex: 6_646_600_574,
  netDex: -63_596_378,
  fadeNote: "levels may fade after 2026-11-04",
  zeroDte: {
    expiry: "2026-11-03",
    netGex: -2_637_344_280,
    flip: 756.77,
    callWall: 752,
    putWall: 753,
  },
  notes: ["GEX negative: dealer hedging amplifies moves"],
});

const document = (overrides: Record<string, unknown> = {}) => ({
  schema: "vertex-market-context-v1",
  generatedAt: NOW_S - 60,
  host: "dev-rig",
  missing: [],
  gex: {
    asOf: NOW_S - 600,
    oiSession: "2026-10-30",
    label: "estimate from QuantData OI+IV",
    index: [gexRow("SPY"), gexRow("QQQ")],
  },
  macro: {
    asOf: NOW_S - 1200,
    series: [
      {
        id: "DGS10",
        label: "10-year Treasury yield",
        group: "rates",
        units: "%",
        status: "ok",
        stale: false,
        value: 4.94,
        date: "2026-10-30",
        change1d: -0.04,
        change1w: -0.06,
        change1m: -0.35,
        change1y: 0.83,
        pct1y: 86.4,
        source: "FRED",
        sourceUrl: "https://fred.stlouisfed.org/series/DGS10",
      },
    ],
    regimes: [{ id: "curve", label: "normal", rule: "10y-2y < 0 inverted" }],
    events: [
      { date: "2026-11-06", time: "08:30", name: "Employment Situation" },
    ],
  },
  news: {
    asOf: NOW_S - 300,
    themes: [
      {
        id: "fed_rates",
        label: "Fed / rates",
        count24h: 5,
        count72h: 11,
        sentiment24h: -0.09,
        shock: false,
      },
    ],
    headlines: [
      {
        title: "Fed holds rates",
        publisher: "Reuters",
        url: "https://example.test/fed",
        publishedAt: NOW_S - 3600,
        theme: "Fed / rates",
        sentiment: -0.2,
        materiality: "high",
      },
    ],
  },
  ...overrides,
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => setMarketContextOptionsForTesting({}));

describe("market context mapping", () => {
  it("maps unix times to ISO and keeps the public sections", () => {
    const output = toMarketContext(document(), NOW);
    expect(output.generatedAt).toBe("2026-11-03T14:59:00.000Z");
    expect(output.stale).toBe(false);
    expect(output.gex?.asOf).toBe("2026-11-03T14:50:00.000Z");
    expect(output.gex?.index.map((row) => row.symbol)).toEqual(["SPY", "QQQ"]);
    expect(output.macro?.asOf).toBe("2026-11-03T14:40:00.000Z");
    expect(output.macro?.series[0]?.value).toBe(4.94);
    expect(output.news?.asOf).toBe("2026-11-03T14:55:00.000Z");
    expect(output.news?.headlines[0]?.publishedAt).toBe(
      "2026-11-03T14:00:00.000Z"
    );
  });

  it("flags an old push as stale and keeps missing sections null", () => {
    const output = toMarketContext(
      document({
        generatedAt: NOW_S - 901,
        missing: ["gex", "news"],
        gex: null,
        news: null,
        macro: { ...document().macro, asOf: null },
      }),
      NOW
    );
    expect(output).toMatchObject({
      stale: true,
      missing: ["gex", "news"],
      gex: null,
      news: null,
      macro: { asOf: null },
    });
    const nullTimes = toMarketContext(
      document({
        gex: { ...document().gex, asOf: null },
        news: { ...document().news, asOf: null },
      }),
      NOW
    );
    expect(nullTimes.gex?.asOf).toBeNull();
    expect(nullTimes.news?.asOf).toBeNull();
    expect(toMarketContext(document({ macro: null }), NOW).macro).toBeNull();
  });

  it("rejects other schemas and bad sections", () => {
    for (const raw of [
      null,
      document({ schema: "vertex-engine-status-v1" }),
      document({ gex: { ...document().gex, index: "SPY" } }),
      document({ missing: ["positions"] }),
      document({
        news: {
          ...document().news,
          headlines: Array.from({ length: 101 }, () => ({})),
        },
      }),
    ])
      expect(() => toMarketContext(raw, NOW)).toThrow(/unexpected shape/u);
  });

  it("drops bad rows one at a time and keeps the rest", () => {
    const news = document().news;
    const [good] = news.headlines;
    const output = toMarketContext(
      document({
        gex: { ...document().gex, index: [{ symbol: "NVDA" }, gexRow("QQQ")] },
        news: {
          ...news,
          headlines: [
            { ...good, url: "javascript:alert(1)" },
            { ...good, url: "http://example.test:99999/a" },
            { ...good, position: -435 },
            ...Array.from({ length: 30 }, (_, index) => ({
              ...good,
              url: `https://example.test/${index}`,
            })),
          ],
        },
      }),
      NOW
    );
    expect(output.gex?.index.map((row) => row.symbol)).toEqual(["QQQ"]);
    expect(output.news?.headlines).toHaveLength(25);
    expect(output.news?.headlines[0]?.url).toBe("https://example.test/0");
  });

  it("parses the collector fixture (Python and TypeScript share it)", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../infra/rig/engine-status/fixtures/market-context.v1.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    const output = toMarketContext(fixture, NOW);
    // Every row of the fixture survives the row-by-row check: nothing is dropped silently.
    const counts = {
      gex: output.gex?.index.length,
      series: output.macro?.series.length,
      regimes: output.macro?.regimes.length,
      events: output.macro?.events.length,
      themes: output.news?.themes.length,
      headlines: output.news?.headlines.length,
    };
    expect(counts).toEqual({
      gex: 2,
      series: 1,
      regimes: 1,
      events: 1,
      themes: 1,
      headlines: 2,
    });
    expect(output.news?.headlines.map((row) => row.title)).toEqual([
      "Oil jumps",
      "Fed holds",
    ]);
  });
});

describe("market context reader", () => {
  it("reads /markets.json from the loopback base and maps failures", async () => {
    const doFetch = vi.fn(async () => jsonResponse(document()));
    const output = await fetchMarketContext(BASE, {
      fetch: doFetch,
      now: () => NOW,
    });
    expect(output.missing).toEqual([]);
    expect(doFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3462/markets.json",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
    await expect(fetchMarketContext("http://quantvps:3462")).rejects.toThrow(
      LoopbackStatusError
    );
    await expect(
      fetchMarketContext(BASE, {
        fetch: async () => new Response("", { status: 404 }),
      })
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "No market context pushed yet",
    });
  });

  it("uses the global fetch and clock by default", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          document({ generatedAt: Math.floor(Date.now() / 1000) - 1 })
        )
      );
    try {
      const output = await fetchMarketContext(BASE, { timeoutMs: 1000 });
      expect(output.stale).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

const at = new Date("2026-11-01T12:00:00.000Z");
const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-11-03T12:00:00.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  engineStatus: string | null
) => {
  const repositories = {} as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      requireRole: async () => {
        throw denied();
      },
      operatorEmails: ["operator@domain.test"],
      engineStatus,
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code });
  }
};

describe("marketContext.get procedure", () => {
  it("is operator-only and maps reader errors", async () => {
    const doFetch = vi.fn(async () => jsonResponse(document()));
    setMarketContextOptionsForTesting({ fetch: doFetch, now: () => NOW });
    await expectCode(
      clientFor(null, BASE).marketContext.get({}),
      "UNAUTHORIZED"
    );
    await expectCode(
      clientFor(session("outsider"), BASE).marketContext.get({}),
      "FORBIDDEN"
    );
    expect(doFetch).not.toHaveBeenCalled();
    const output = await clientFor(session("operator"), BASE).marketContext.get(
      {}
    );
    expect(output.gex?.index[0]?.symbol).toBe("SPY");
    await expectCode(
      clientFor(session("operator"), null).marketContext.get({}),
      "NOT_CONFIGURED"
    );
    setMarketContextOptionsForTesting({
      fetch: async () => jsonResponse(document()),
      now: () => {
        throw new Error("clock failed");
      },
    });
    await expectCode(
      clientFor(session("operator"), BASE).marketContext.get({}),
      "UPSTREAM_ERROR"
    );
  });

  it("is not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("marketContext");
    expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("marketContext"))
    ).toBe(false);
  });
});
