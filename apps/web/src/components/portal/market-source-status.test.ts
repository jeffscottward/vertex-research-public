import type {
  MarketContextOutput,
  MarketVolatilityOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  feedsSourceStatus,
  isSpxQuoteStale,
  type MarketSourceStatus,
  SPX_CLOSED_STALE_MS,
  SPX_OPEN_STALE_MS,
  summarizeMarketStatus,
  volatilitySourceStatus,
} from "./market-source-status.ts";

const series = (stale: boolean) => ({
  asOf: "2026-10-20",
  change1d: 0.4,
  pct1y: 62,
  stale,
  value: 17.2,
});

const volatility = (
  overrides: Partial<MarketVolatilityOutput> = {}
): MarketVolatilityOutput => ({
  implied: null,
  sourceErrors: [],
  spread: series(false),
  spx: null,
  vix: series(false),
  vixeq: series(false),
  vvix: null,
  ...overrides,
});

const feeds = (
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-03T14:59:00.000Z",
  gex: null,
  macro: null,
  missing: [],
  news: null,
  stale: false,
  ...overrides,
});

describe("summarizeMarketStatus", () => {
  it.each<[MarketSourceStatus[], string, string]>([
    [["loading", "loading"], "Loading", "info"],
    [["ready", "loading"], "Loading", "info"],
    [["forbidden", "loading"], "Loading", "info"],
    [["partial", "loading"], "Loading", "info"],
    [["forbidden", "forbidden"], "Operator only", "neutral"],
    [["error", "forbidden"], "Unavailable", "destructive"],
    [["error", "error"], "Unavailable", "destructive"],
    [["ready", "error"], "Partial", "warning"],
    [["forbidden", "stale"], "Partial", "warning"],
    [["ready", "partial"], "Partial", "warning"],
    [["partial", "stale"], "Partial", "warning"],
    [["partial", "partial"], "Partial", "warning"],
    [["ready", "stale"], "Stale", "warning"],
    [["ready", "ready"], "Live", "success"],
  ])("%j → %s", (sources, label, tone) => {
    expect(summarizeMarketStatus(sources)).toEqual({ label, tone });
  });
});

describe("volatilitySourceStatus", () => {
  it("is ready when every series is fresh, unknown series included", () => {
    expect(volatilitySourceStatus(volatility())).toBe("ready");
  });

  it.each(["vix", "vixeq", "vvix", "spread"] as const)(
    "is stale when %s is stale",
    (key) => {
      expect(volatilitySourceStatus(volatility({ [key]: series(true) }))).toBe(
        "stale"
      );
    }
  );

  it("is partial when a source failed, even with a stale series", () => {
    expect(
      volatilitySourceStatus(volatility({ sourceErrors: ["Cboe: HTTP 503"] }))
    ).toBe("partial");
    expect(
      volatilitySourceStatus(
        volatility({ sourceErrors: ["Yahoo: timeout"], vix: series(true) })
      )
    ).toBe("partial");
  });

  it("marks stale S&P 500 quotes after 15 min open or 96 h closed, with sourceErrors taking precedence", () => {
    const nowMs = Date.parse("2026-11-19T20:00:00.000Z");
    const spxAt = (ageMs: number, sessionOpen: boolean) => ({
      movePct: -0.2,
      price: 5800,
      quoteTime: new Date(nowMs - ageMs).toISOString(),
      sessionDate: "2026-11-19",
      sessionOpen,
    });
    expect(isSpxQuoteStale(null, nowMs)).toBe(false);
    expect(
      isSpxQuoteStale(
        {
          movePct: null,
          price: 5800,
          quoteTime: null,
          sessionDate: null,
          sessionOpen: true,
        },
        nowMs
      )
    ).toBe(false);
    expect(
      isSpxQuoteStale(
        {
          movePct: null,
          price: 5800,
          quoteTime: "not-a-date",
          sessionDate: null,
          sessionOpen: true,
        },
        nowMs
      )
    ).toBe(false);
    expect(isSpxQuoteStale(spxAt(SPX_OPEN_STALE_MS, true), nowMs)).toBe(false);
    expect(isSpxQuoteStale(spxAt(SPX_OPEN_STALE_MS + 1, true), nowMs)).toBe(
      true
    );
    expect(isSpxQuoteStale(spxAt(SPX_CLOSED_STALE_MS, false), nowMs)).toBe(
      false
    );
    expect(isSpxQuoteStale(spxAt(SPX_CLOSED_STALE_MS + 1, false), nowMs)).toBe(
      true
    );
    // Default clock argument works when omitted.
    expect(
      isSpxQuoteStale({
        movePct: 0,
        price: 5800,
        quoteTime: new Date(
          Date.now() - SPX_OPEN_STALE_MS - 60_000
        ).toISOString(),
        sessionDate: "2026-11-19",
        sessionOpen: true,
      })
    ).toBe(true);
    expect(
      volatilitySourceStatus(
        volatility({ spx: spxAt(SPX_OPEN_STALE_MS + 1000, true) }),
        nowMs
      )
    ).toBe("stale");
    expect(
      volatilitySourceStatus(
        volatility({
          sourceErrors: ["S&P 500: HTTP 503"],
          spx: spxAt(SPX_OPEN_STALE_MS + 1000, true),
        }),
        nowMs
      )
    ).toBe("partial");
  });
});

describe("feedsSourceStatus", () => {
  it("is ready when the rig pushed recently and read every section", () => {
    expect(feedsSourceStatus(feeds())).toBe("ready");
  });

  it("is stale when the rig stopped pushing", () => {
    expect(feedsSourceStatus(feeds({ stale: true }))).toBe("stale");
  });

  it("is partial when the rig could not read a section, stale or not", () => {
    expect(feedsSourceStatus(feeds({ missing: ["gex"] }))).toBe("partial");
    expect(
      feedsSourceStatus(feeds({ missing: ["macro", "news"], stale: true }))
    ).toBe("partial");
  });
});
