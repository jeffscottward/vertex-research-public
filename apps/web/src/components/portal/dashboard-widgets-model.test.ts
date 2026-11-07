import type { MarketContextOutput, NewsHeadline } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WIDGET_LAYOUT,
  localIsoDate,
  marketHeadline,
  moveWidget,
  normalizeWidgetLayout,
  toggleWidget,
  upcomingEvents,
} from "./dashboard-widgets-model.ts";

describe("normalizeWidgetLayout", () => {
  it("defaults to every widget shown, in order", () => {
    expect(normalizeWidgetLayout(undefined)).toBe(DEFAULT_WIDGET_LAYOUT);
    expect(normalizeWidgetLayout("x")).toBe(DEFAULT_WIDGET_LAYOUT);
    expect(DEFAULT_WIDGET_LAYOUT).toEqual({
      hidden: [],
      order: ["watchlist", "events", "journal", "market"],
    });
  });

  it("drops unknown ids and duplicates and appends missing widgets", () => {
    expect(
      normalizeWidgetLayout({
        hidden: ["events", 4, "events"],
        order: ["market", "nope", "market", "journal"],
      })
    ).toEqual({
      hidden: ["events"],
      order: ["market", "journal", "watchlist", "events"],
    });
    expect(normalizeWidgetLayout({})).toEqual({
      hidden: [],
      order: ["watchlist", "events", "journal", "market"],
    });
  });
});

describe("moveWidget", () => {
  it("swaps with a neighbour and ignores moves past either end", () => {
    const layout = DEFAULT_WIDGET_LAYOUT;
    expect(moveWidget(layout, "events", -1).order).toEqual([
      "events",
      "watchlist",
      "journal",
      "market",
    ]);
    expect(moveWidget(layout, "events", 1).order).toEqual([
      "watchlist",
      "journal",
      "events",
      "market",
    ]);
    expect(moveWidget(layout, "watchlist", -1)).toBe(layout);
    expect(moveWidget(layout, "market", 1)).toBe(layout);
  });

  it("moves among a subset, skipping widgets outside it", () => {
    expect(
      moveWidget(DEFAULT_WIDGET_LAYOUT, "market", -1, ["watchlist", "market"])
        .order
    ).toEqual(["market", "events", "journal", "watchlist"]);
    expect(moveWidget(DEFAULT_WIDGET_LAYOUT, "events", 1, ["watchlist"])).toBe(
      DEFAULT_WIDGET_LAYOUT
    );
  });
});

describe("toggleWidget", () => {
  it("hides and shows a widget", () => {
    const hidden = toggleWidget(DEFAULT_WIDGET_LAYOUT, "journal");
    expect(hidden.hidden).toEqual(["journal"]);
    expect(toggleWidget(hidden, "journal").hidden).toEqual([]);
  });
});

describe("upcomingEvents", () => {
  it("keeps today and later, soonest first, untimed first within a day", () => {
    expect(
      upcomingEvents(
        [
          { date: "2026-11-07", name: "NFP", time: "08:30 ET" },
          { date: "2026-11-05", name: "Old", time: null },
          { date: "2026-11-06", name: "FOMC", time: "14:00" },
          { date: "2026-11-06", name: "Holiday", time: null },
          { date: "2026-11-09", name: "Later", time: null },
        ],
        "2026-11-06"
      ).map((event) => event.name)
    ).toEqual(["Holiday", "FOMC", "NFP"]);
  });
});

describe("localIsoDate", () => {
  it("formats the local calendar date", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("marketHeadline", () => {
  const headline = (title: string, publishedAt: string): NewsHeadline => ({
    materiality: null,
    publishedAt,
    publisher: null,
    sentiment: null,
    theme: null,
    title,
    url: "https://example.com/a",
  });
  const context = (
    news: MarketContextOutput["news"],
    gex: MarketContextOutput["gex"]
  ): MarketContextOutput => ({
    generatedAt: "2026-11-06T12:00:00.000Z",
    gex,
    macro: null,
    missing: [],
    news,
    stale: false,
  });

  it("picks the newest headline", () => {
    expect(
      marketHeadline(
        context(
          {
            asOf: null,
            headlines: [
              headline("older", "2026-11-06T09:00:00.000Z"),
              headline("newer", "2026-11-06T11:00:00.000Z"),
            ],
            themes: [],
          },
          null
        )
      )
    ).toMatchObject({ headline: { title: "newer" }, type: "news" });
  });

  it("falls back to the GEX label, then null", () => {
    const gex = (label: string | null) => ({
      asOf: null,
      index: [],
      label,
      oiSession: null,
    });
    expect(marketHeadline(context(null, gex("Dampened")))).toEqual({
      label: "Dampened",
      type: "gex",
    });
    expect(
      marketHeadline(
        context({ asOf: null, headlines: [], themes: [] }, gex(null))
      )
    ).toBeNull();
    expect(marketHeadline(context(null, null))).toBeNull();
  });
});
