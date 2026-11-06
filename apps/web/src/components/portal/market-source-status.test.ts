import type {
  MarketContextOutput,
  MarketVolatilityOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  feedsSourceStatus,
  type MarketSourceStatus,
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
