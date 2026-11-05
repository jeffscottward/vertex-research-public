// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@darkfactory/api")>();
  return {
    ...actual,
    createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
      runtime.origins.push(options.baseUrl);
      return runtime.client as ApiClient;
    }),
  };
});

import {
  createBrowserSectorRotationGateway,
  createSectorRotationGateway,
  describeSectorRotationFailure,
  parseTickerList,
  SECTOR_ROTATION_NOT_COLLECTED_TEXT,
  SECTORS_PRESET,
  usableSymbols,
} from "./sector-rotation-client.ts";
import { mapFixture } from "./sector-rotation-test-fixtures.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  return;
});

const fakeClient = ({
  watchlist = async () => ({
    items: [{ symbol: "AAPL" }, { symbol: "MSFT" }, { symbol: "AAPL" }],
  }),
  baskets = async () => ({
    items: [
      {
        id: "b1",
        members: [{ symbol: "XOM" }, { symbol: "cvx" }, { symbol: "bad sym" }],
        name: "Energy",
      },
      { id: "b2", members: [], name: "Empty" },
    ],
  }),
}: {
  watchlist?: () => Promise<unknown>;
  baskets?: () => Promise<unknown>;
} = {}) => {
  const map = vi.fn(async () => mapFixture());
  const watchlistList = vi.fn(watchlist);
  const basketsList = vi.fn(baskets);
  return {
    basketsList,
    client: {
      baskets: { list: basketsList },
      sectorRotation: { map },
      watchlist: { list: watchlistList },
    } as unknown as ApiClient,
    map,
    watchlistList,
  };
};

describe("sector rotation helpers", () => {
  it("keeps valid unique upper-case symbols up to 30", () => {
    expect(usableSymbols([" aapl", "AAPL", "bad sym", "msft"])).toEqual([
      "AAPL",
      "MSFT",
    ]);
    const many = Array.from({ length: 40 }, (_, index) => `S${index}`);
    return expect(usableSymbols(many)).toHaveLength(30);
  });

  it("parses a typed ticker list", () => {
    expect(parseTickerList(" aapl, msft  xom;AAPL ")).toEqual({
      ok: true,
      symbols: ["AAPL", "MSFT", "XOM"],
    });
    expect(parseTickerList(" , ")).toEqual({
      message: "Type at least one ticker.",
      ok: false,
    });
    expect(parseTickerList("AAPL, 1BAD, $X")).toEqual({
      message: "Not a ticker: 1BAD, $X.",
      ok: false,
    });
    const many = Array.from({ length: 31 }, (_, index) => `S${index}`).join(
      " "
    );
    return expect(parseTickerList(many)).toEqual({
      message: "Use at most 30 tickers (you typed 31).",
      ok: false,
    });
  });

  return it("describes failures in one line", () => {
    expect(describeSectorRotationFailure({ code: "FORBIDDEN" })).toBe(
      "Operator access required."
    );
    expect(describeSectorRotationFailure({ code: "NOT_FOUND" })).toBe(
      SECTOR_ROTATION_NOT_COLLECTED_TEXT
    );
    expect(
      describeSectorRotationFailure(
        new Error(" Market data source unavailable ")
      )
    ).toBe("Market data source unavailable");
    expect(describeSectorRotationFailure({ message: "  " })).toBe(
      "Request failed."
    );
    return expect(describeSectorRotationFailure("boom")).toBe(
      "Request failed."
    );
  });
});

describe("sector rotation gateway", () => {
  it("maps the map call to sectorRotation.map", async () => {
    const fake = fakeClient();
    const gateway = createSectorRotationGateway(fake.client);
    const input = {
      timeframe: "daily",
      universe: { kind: "sectors" },
    } as const;
    expect((await gateway.map(input)).asOf).toBe("2026-10-30");
    return expect(fake.map).toHaveBeenCalledWith(input);
  });

  it("lists the sector ETFs, the watchlist and each non-empty basket", async () => {
    const fake = fakeClient();
    const presets = await createSectorRotationGateway(fake.client).universes();
    expect(fake.watchlistList).toHaveBeenCalledWith({});
    expect(fake.basketsList).toHaveBeenCalledWith({});
    return expect(presets).toEqual([
      SECTORS_PRESET,
      {
        id: "watchlist",
        label: "Watchlist (2)",
        universe: { kind: "custom", symbols: ["AAPL", "MSFT"] },
      },
      {
        id: "basket:b1",
        label: "Basket Energy (2)",
        universe: { kind: "custom", symbols: ["XOM", "CVX"] },
      },
    ]);
  });

  it("leaves out lists that fail to load or are empty", async () => {
    const failing = fakeClient({
      baskets: async () => {
        throw new Error("Forbidden");
      },
      watchlist: async () => {
        throw new Error("offline");
      },
    });
    expect(
      await createSectorRotationGateway(failing.client).universes()
    ).toEqual([SECTORS_PRESET]);
    const empty = fakeClient({ watchlist: async () => ({ items: [] }) });
    const presets = await createSectorRotationGateway(empty.client).universes();
    return expect(presets.map((preset) => preset.id)).toEqual([
      "sectors",
      "basket:b1",
    ]);
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserSectorRotationGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.map({});
    await gateway.universes();
    expect(runtime.origins).toEqual([window.location.origin]);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});
