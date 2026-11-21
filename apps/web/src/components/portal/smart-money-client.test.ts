// @vitest-environment jsdom
import type { ApiClient, SmartMoneyRankingOutput } from "@darkfactory/api";
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
  return {
    client: { smartMoney: { ranking } } as unknown as ApiClient,
    ranking,
  };
};

describe("smart money gateway", () => {
  it("leaves an empty ticker out of the request", async () => {
    const fake = fakeClient();
    expect(
      await createSmartMoneyGateway(fake.client).ranking(
        settings({ sessions: 5, sort: "total" })
      )
    ).toBe(output);
    return expect(fake.ranking).toHaveBeenCalledWith({
      sessions: 5,
      sort: "total",
    });
  });

  it("passes the ticker filter to the server", async () => {
    const fake = fakeClient();
    await createSmartMoneyGateway(fake.client).ranking(
      settings({ sessions: 20, sort: "net_bearish", ticker: "EXWD" })
    );
    return expect(fake.ranking).toHaveBeenCalledWith({
      sessions: 20,
      sort: "net_bearish",
      ticker: "EXWD",
    });
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserSmartMoneyGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.ranking(settings({ sessions: 5 }));
    await gateway.ranking(settings());
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(fake.ranking).toHaveBeenCalledTimes(2);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});
