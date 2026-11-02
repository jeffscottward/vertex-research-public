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
  createBrowserMarketNewsGateway,
  createMarketNewsGateway,
  describeMarketNewsFailure,
} from "./market-news-client.ts";

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
});

const fakeClient = () => {
  const watchlist = vi.fn(async () => ({
    receivedAt: new Date("2026-10-14T00:00:00Z"),
    tickers: [],
  }));
  return {
    client: { marketNews: { watchlist } } as unknown as ApiClient,
    watchlist,
  };
};

describe("market news gateway", () => {
  it("maps the window to the marketNews.watchlist input", async () => {
    const fake = fakeClient();
    const news = await createMarketNewsGateway(fake.client).watchlist(24);
    expect(news.tickers).toEqual([]);
    return expect(fake.watchlist).toHaveBeenCalledWith({ hours: 24 });
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserMarketNewsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.watchlist(72);
    await gateway.watchlist(168);
    expect(runtime.origins).toEqual([window.location.origin]);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });

  return it("describes failures in one line", () => {
    expect(describeMarketNewsFailure({ code: "UNAUTHORIZED" })).toBe(
      "Session expired. Sign in again."
    );
    expect(describeMarketNewsFailure({ code: "FORBIDDEN" })).toBe(
      "Not permitted for this session."
    );
    expect(describeMarketNewsFailure({ code: "STORAGE_ERROR" })).toBe(
      "Watchlist storage unavailable."
    );
    expect(describeMarketNewsFailure(new Error("boom"))).toBe(
      "Request failed. Retry."
    );
    return expect(describeMarketNewsFailure(null)).toBe(
      "Request failed. Retry."
    );
  });
});
