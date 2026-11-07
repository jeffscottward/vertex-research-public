import { describe, expect, it } from "vitest";

import {
  createDesktopApi,
  DesktopApiError,
  dailyBarsInput,
} from "./desktop-api.ts";

const ORIGIN = "https://vertex.example";

type Reply = Readonly<{ status: number; body: unknown }>;

const fakeSite = (routes: Record<string, Reply>) => {
  const requests: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    const reply = routes[path];
    if (reply === undefined) throw new TypeError("network down");
    return Response.json(reply.body, { status: reply.status });
  };
  return { api: createDesktopApi({ fetch, siteOrigin: ORIGIN }), requests };
};

const unauthorized: Reply = {
  body: {
    json: {
      code: "UNAUTHORIZED",
      defined: false,
      message: "Sign in",
      status: 401,
    },
  },
  status: 401,
};

const bar = (c: number) => ({ c, h: c, l: c, o: c, t: 1, v: 1 });

describe("createDesktopApi", () => {
  it("lists the watchlist with a GET on the site origin", async () => {
    const { api, requests } = fakeSite({
      "/api/orpc/watchlist/list": {
        body: {
          json: {
            items: [
              {
                buyZoneHigh: "510",
                buyZoneLow: "500",
                createdAt: "2026-11-01T00:00:00.000Z",
                id: "w1",
                note: "secret note",
                symbol: "SPY",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
            ],
          },
        },
        status: 200,
      },
    });
    await expect(api.watchlist()).resolves.toEqual([
      { buyZoneHigh: "510", buyZoneLow: "500", symbol: "SPY" },
    ]);
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]?.url ?? "").origin).toBe(ORIGIN);
  });

  it("reads the last two daily closes", async () => {
    const { api, requests } = fakeSite({
      "/api/orpc/marketData/bars": {
        body: { json: { bars: [bar(98), bar(100), bar(101)] } },
        status: 200,
      },
    });
    await expect(api.dailyQuote("BF-B")).resolves.toEqual({
      last: 101,
      previousClose: 100,
    });
    const data = new URL(requests[0]?.url ?? "").searchParams.get("data");
    expect(JSON.parse(data ?? "{}").json).toEqual(dailyBarsInput("BF-B"));
    expect(dailyBarsInput("BF-B").symbol).toBe("BF.B");
  });

  it("returns a single close without a previous one, and null without bars", async () => {
    const one = fakeSite({
      "/api/orpc/marketData/bars": {
        body: { json: { bars: [bar(7)] } },
        status: 200,
      },
    });
    await expect(one.api.dailyQuote("SPY")).resolves.toEqual({
      last: 7,
      previousClose: null,
    });
    const none = fakeSite({
      "/api/orpc/marketData/bars": {
        body: { json: { bars: [] } },
        status: 200,
      },
    });
    await expect(none.api.dailyQuote("SPY")).resolves.toBeNull();
  });

  it("reads alert fires since a time, keeping only id and fire time", async () => {
    const { api, requests } = fakeSite({
      "/api/orpc/priceAlerts/signals/events": {
        body: {
          json: {
            events: [
              {
                firedAt: "2026-11-06T15:00:00.000Z",
                id: "e1",
                name: "SPY cross",
                price: "500",
              },
            ],
          },
          meta: [[1, "events", 0, "firedAt"]],
        },
        status: 200,
      },
    });
    const since = new Date("2026-11-06T14:00:00.000Z");
    await expect(api.alertFires(since)).resolves.toEqual([
      { firedAt: new Date("2026-11-06T15:00:00.000Z"), id: "e1" },
    ]);
    const data = new URL(requests[0]?.url ?? "").searchParams.get("data");
    expect(JSON.parse(data ?? "{}").json).toEqual({
      since: since.toISOString(),
    });
  });

  it("maps 401 to signed-out and everything else to unavailable", async () => {
    const { api } = fakeSite({
      "/api/orpc/marketData/bars": {
        body: {
          json: {
            code: "FORBIDDEN",
            defined: false,
            message: "x",
            status: 403,
          },
        },
        status: 403,
      },
      "/api/orpc/watchlist/list": unauthorized,
    });
    await expect(api.watchlist()).rejects.toMatchObject({
      failure: "signed-out",
      name: "DesktopApiError",
    });
    await expect(api.dailyQuote("SPY")).rejects.toMatchObject({
      failure: "unavailable",
    });
    await expect(api.alertFires(new Date())).rejects.toBeInstanceOf(
      DesktopApiError
    );
  });

  it("names the failure in the error message", () => {
    expect(new DesktopApiError("signed-out").message).toBe("Not signed in");
    expect(new DesktopApiError("unavailable").message).toBe(
      "Vertex is unavailable"
    );
  });
});
