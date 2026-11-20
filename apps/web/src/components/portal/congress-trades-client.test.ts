// @vitest-environment jsdom
import type { ApiClient, CongressTradesFeedOutput } from "@darkfactory/api";
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
  createBrowserCongressTradesGateway,
  createCongressTradesGateway,
} from "./congress-trades-client.ts";
import type { CongressTradesSettings } from "./congress-trades-params.ts";

const output: CongressTradesFeedOutput = {
  coverage: [],
  filings: [],
  members: [],
  receivedAt: new Date("2026-10-13T15:00:00.000Z"),
  source: "Congress disclosure ledger",
  trades: [],
  unparsed: {
    byReason: { layout_unknown: 0, no_transactions: 0, scanned_image: 0 },
    total: 0,
  },
};

const settings = (
  overrides: Partial<CongressTradesSettings> = {}
): CongressTradesSettings => ({
  chamber: "",
  days: 30,
  member: "",
  ticker: "",
  ...overrides,
});

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  return;
});

const fakeClient = () => {
  const feed = vi.fn(async () => output);
  return {
    client: { congressTrades: { feed } } as unknown as ApiClient,
    feed,
  };
};

describe("congress trades gateway", () => {
  it("sends only the window when no other filter is set", async () => {
    const fake = fakeClient();
    expect(
      await createCongressTradesGateway(fake.client).feed(
        settings({ days: 90 })
      )
    ).toBe(output);
    return expect(fake.feed).toHaveBeenCalledWith({ days: 90 });
  });

  it("passes chamber, member and ticker filters to the server", async () => {
    const fake = fakeClient();
    await createCongressTradesGateway(fake.client).feed(
      settings({
        chamber: "senate",
        days: 7,
        member: "Avery",
        ticker: "ACME",
      })
    );
    return expect(fake.feed).toHaveBeenCalledWith({
      chamber: "senate",
      days: 7,
      member: "Avery",
      ticker: "ACME",
    });
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserCongressTradesGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.feed(settings({ days: 7 }));
    await gateway.feed(settings());
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(fake.feed).toHaveBeenCalledTimes(2);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});
