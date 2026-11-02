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

const output: CongressTradesFeedOutput = {
  filings: [],
  members: [],
  receivedAt: new Date("2026-10-13T15:00:00.000Z"),
  source: "House Clerk",
};

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
  it("maps the window to the congressTrades.feed input", async () => {
    const fake = fakeClient();
    expect(await createCongressTradesGateway(fake.client).feed(90)).toBe(
      output
    );
    return expect(fake.feed).toHaveBeenCalledWith({ days: 90 });
  });

  return it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserCongressTradesGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.feed(7);
    await gateway.feed(30);
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(fake.feed).toHaveBeenCalledTimes(2);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });
});
