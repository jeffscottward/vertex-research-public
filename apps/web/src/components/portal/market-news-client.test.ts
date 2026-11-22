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
  marketNewsFailureLine,
} from "./market-news-client.ts";

afterEach(() => {
  vi.useRealTimers();
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
  it("maps the window and the include choice to the marketNews.watchlist input", async () => {
    const fake = fakeClient();
    const gateway = createMarketNewsGateway(fake.client);
    const news = await gateway.watchlist(24);
    expect(news.tickers).toEqual([]);
    expect(fake.watchlist).toHaveBeenCalledWith({ hours: 24, include: "all" });
    await gateway.watchlist(720, "filings");
    return expect(fake.watchlist).toHaveBeenLastCalledWith({
      hours: 720,
      include: "filings",
    });
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const fake = fakeClient();
    runtime.client = fake.client;
    const gateway = createBrowserMarketNewsGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.watchlist(72);
    await gateway.watchlist(168, "filings");
    expect(fake.watchlist).toHaveBeenLastCalledWith({
      hours: 168,
      include: "filings",
    });
    expect(runtime.origins).toEqual([window.location.origin]);
    return expect(Object.isFrozen(gateway)).toBe(true);
  });

  it("names a failure that a retry cannot fix, without a retry step", () => {
    expect(describeMarketNewsFailure({ code: "UNAUTHORIZED" })).toEqual({
      message: "Session expired. Sign in again.",
      retryable: false,
    });
    expect(
      describeMarketNewsFailure({ code: "FORBIDDEN", message: "Forbidden" })
    ).toEqual({ message: "Not permitted for this session.", retryable: false });
    // Storage that is not configured needs the operator; the server message says so.
    expect(
      describeMarketNewsFailure({
        code: "STORAGE_ERROR",
        message:
          "Watchlist storage is not configured on this server; ask the operator",
      })
    ).toEqual({
      message:
        "Watchlist storage is not configured on this server; ask the operator",
      retryable: false,
    });
  });

  it("names a failure that a retry can fix and cuts the server's retry step", () => {
    // One prefix: the server message already names the subsystem.
    expect(
      describeMarketNewsFailure({
        code: "STORAGE_ERROR",
        message: "Watchlist storage: database request failed; retry",
      })
    ).toEqual({
      message: "Watchlist storage: database request failed",
      retryable: true,
    });
    for (const message of [undefined, "", "   ", 503])
      expect(
        describeMarketNewsFailure({ code: "STORAGE_ERROR", message })
      ).toEqual({
        message: "Watchlist storage request failed",
        retryable: true,
      });
    expect(
      describeMarketNewsFailure({
        code: "UPSTREAM_ERROR",
        message: " Feed returned HTTP 502 ",
      })
    ).toEqual({
      message: "UPSTREAM_ERROR: Feed returned HTTP 502",
      retryable: true,
    });
    expect(
      describeMarketNewsFailure({
        code: "UNAVAILABLE",
        message: "Feed request failed; retry",
      })
    ).toEqual({ message: "UNAVAILABLE: Feed request failed", retryable: true });
    expect(describeMarketNewsFailure({ code: "TIMEOUT" })).toEqual({
      message: "TIMEOUT: Request failed",
      retryable: true,
    });
    expect(describeMarketNewsFailure(new Error("boom"))).toEqual({
      message: "ERROR: boom",
      retryable: true,
    });
    for (const error of [{ code: 503, message: "" }, null, "offline"])
      expect(describeMarketNewsFailure(error)).toEqual({
        message: "ERROR: Request failed",
        retryable: true,
      });
  });

  return it("adds the retry step to the status line of a retryable failure only", () => {
    const failedAt = Date.UTC(2026, 10, 18, 14, 5, 30);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T14:10:00.000Z"));
    const line = (subject: string, error: unknown) =>
      marketNewsFailureLine(subject, {
        ...describeMarketNewsFailure(error),
        failedAt,
      });
    expect(line("News", { code: "UNAUTHORIZED" })).toBe(
      "News not loaded: Session expired. Sign in again. · 14:05 UTC"
    );
    expect(line("Earnings filings", { code: "FORBIDDEN" })).toBe(
      "Earnings filings not loaded: Not permitted for this session. · 14:05 UTC"
    );
    expect(
      line("News", {
        code: "STORAGE_ERROR",
        message:
          "Watchlist storage is not configured on this server; ask the operator",
      })
    ).toBe(
      "News not loaded: Watchlist storage is not configured on this server; ask the operator · 14:05 UTC"
    );
    expect(
      line("News", {
        code: "STORAGE_ERROR",
        message: "Watchlist storage: database request failed; retry",
      })
    ).toBe(
      "News not loaded: Watchlist storage: database request failed · 14:05 UTC · press Try again"
    );
    expect(line("Earnings filings", new Error("offline"))).toBe(
      "Earnings filings not loaded: ERROR: offline · 14:05 UTC · press Try again"
    );
    // A failure of another UTC day shows its date.
    vi.setSystemTime(new Date("2026-11-19T00:10:00.000Z"));
    return expect(line("News", { code: "TIMEOUT" })).toBe(
      "News not loaded: TIMEOUT: Request failed · 2026-11-18 14:05 UTC · press Try again"
    );
  });
});
