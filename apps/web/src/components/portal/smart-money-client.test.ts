// @vitest-environment jsdom
import type {
  ApiClient,
  CongressTradesFeedOutput,
  OpenbbChanges13fOutput,
  OpenbbInsiderClustersOutput,
  OpenbbStatusOutput,
  SmartMoneyRankingOutput,
} from "@darkfactory/api";
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
  createBrowserSmartMoneyGateway,
  createSmartMoneyGateway,
} from "./smart-money-client.ts";
import type { SmartMoneySettings } from "./smart-money-params.ts";

const output: SmartMoneyRankingOutput = {
  capturedAt: null,
  coverage: {
    capturedAt: null,
    lastAttemptAt: null,
    lastMessage: null,
    overdueSince: null,
    sessionDate: "2026-10-30",
    state: "never",
    status: null,
  },
  delay: "Intraday, about 15 minutes",
  history: {
    from: "2025-09-25",
    noData: 0,
    pending: 0,
    stored: 0,
    weekdays: 0,
  },
  receivedAt: new Date("2026-10-30T15:00:00.000Z"),
  rows: [],
  sessions: [],
  source: "QuantData gainers-losers",
  totals: {
    bearishPremium: 0,
    bullishPremium: 0,
    netPremium: 0,
    premium: 0,
    tickers: 0,
  },
};

const clustersOutput = {
  clusters: [],
} as unknown as OpenbbInsiderClustersOutput;
const congressOutput = { trades: [] } as unknown as CongressTradesFeedOutput;
const changes13fOutput = { changes: [] } as unknown as OpenbbChanges13fOutput;
const statusOutput = { sources: [] } as unknown as OpenbbStatusOutput;

const settings = (
  overrides: Partial<SmartMoneySettings> = {}
): SmartMoneySettings => ({
  sessions: 1,
  sort: "net_bullish",
  ticker: "",
  ...overrides,
});

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  return;
});

const fakeClient = () => {
  const ranking = vi.fn(async () => output);
  const insiderClusters = vi.fn(async () => clustersOutput);
  const feed = vi.fn(async () => congressOutput);
  const changes13f = vi.fn(async () => changes13fOutput);
  const status = vi.fn(async () => statusOutput);
  return {
    changes13f,
    client: {
      congressTrades: { feed },
      openbb: { changes13f, insiderClusters, status },
      smartMoney: { ranking },
    } as unknown as ApiClient,
    feed,
    insiderClusters,
    ranking,
    status,
  };
};

describe("smart money gateway", () => {
  it("leaves an empty ticker out of every source request", async () => {
    const fake = fakeClient();
    const gw = createSmartMoneyGateway(fake.client);
    expect(await gw.ranking(settings({ sessions: 5, sort: "total" }))).toBe(
      output
    );
    expect(await gw.insiderClusters("")).toBe(clustersOutput);
    expect(await gw.congressFeed("")).toBe(congressOutput);
    expect(await gw.changes13f("")).toBe(changes13fOutput);
    expect(await gw.status()).toBe(statusOutput);
    expect(fake.ranking).toHaveBeenCalledWith({ sessions: 5, sort: "total" });
    expect(fake.insiderClusters).toHaveBeenCalledWith({ days: 7 });
    expect(fake.feed).toHaveBeenCalledWith({ days: 30 });
    expect(fake.changes13f).toHaveBeenCalledWith({ change: "all", limit: 50 });
    expect(fake.status).toHaveBeenCalledWith({});
  });

  it("passes the ticker filter to every source procedure", async () => {
    const fake = fakeClient();
    const gw = createSmartMoneyGateway(fake.client);
    await gw.ranking(
      settings({ sessions: 20, sort: "net_bearish", ticker: "EXWD" })
    );
    await gw.insiderClusters("EXWD");
    await gw.congressFeed("EXWD");
    await gw.changes13f("EXWD");
    expect(fake.ranking).toHaveBeenCalledWith({
      sessions: 20,
      sort: "net_bearish",
      ticker: "EXWD",
    });
    expect(fake.insiderClusters).toHaveBeenCalledWith({
      days: 7,
      symbol: "EXWD",
    });
    expect(fake.feed).toHaveBeenCalledWith({ days: 30, ticker: "EXWD" });
    expect(fake.changes13f).toHaveBeenCalledWith({
      change: "all",
      limit: 50,
      ticker: "EXWD",
    });
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserSmartMoneyGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.ranking(settings({ sessions: 5 }));
    await gateway.insiderClusters("EXWD");
    await gateway.congressFeed("EXWD");
    await gateway.changes13f("EXWD");
    await gateway.status();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(fake.ranking).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(gateway)).toBe(true);
  });
});
