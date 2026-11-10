import { describe, expect, it, vi } from "vitest";

import { basketPathOf, readBasket } from "./basket.ts";
import { closeMinutes, isTradingDay, nyTime } from "./calendar.ts";
import { emptyState, parseState, trimState } from "./state.ts";
import { fetchWsj, parseWsjDiary, parseWsjTimestamp, WSJ_URL } from "./wsj.ts";

describe("calendar", () => {
  it("reads New York date, minutes and weekday across DST", () => {
    expect(nyTime(new Date("2026-11-06T20:45:00Z"))).toEqual({
      date: "2026-11-06",
      minutes: 15 * 60 + 45,
      weekday: "Fri",
    });
    expect(nyTime(new Date("2026-07-01T13:30:00Z"))).toEqual({
      date: "2026-07-01",
      minutes: 9 * 60 + 30,
      weekday: "Wed",
    });
    expect(nyTime(new Date("2026-11-07T03:00:00Z")).date).toBe("2026-11-06");
  });

  it("skips weekends and NYSE holidays and knows early closes", () => {
    expect(isTradingDay("2026-11-06")).toBe(true);
    expect(isTradingDay("2026-11-07")).toBe(false);
    expect(isTradingDay("2026-11-08")).toBe(false);
    expect(isTradingDay("2026-11-26")).toBe(false);
    expect(isTradingDay("2025-04-18")).toBe(false);
    expect(closeMinutes("2026-11-27")).toBe(13 * 60);
    expect(closeMinutes("2026-11-06")).toBe(16 * 60);
  });
});

describe("basket", () => {
  const file = {
    as_of: "2026-11-06T15:30:00-05:00",
    reportPath: "/r/report.html",
    rulesNote: "Options-only.",
    schema: "dip-basket.v1",
    summary: "🧺 AI dip basket ARMED",
    tiers: [
      {
        id: "core",
        label: "Core ETFs",
        tickers: ["SMH", "QQQ"],
        weight_pct_nlv: 13,
      },
      { tickers: ["NVDA"] },
      {},
    ],
  };

  it("reads the dip-basket summary, report path, rules and tiers", () => {
    const basket = readBasket(JSON.stringify(file));
    expect(basket.available).toBe(true);
    expect(basket.lines).toEqual([
      "🧺 AI dip basket ARMED",
      "📄 Report: /r/report.html",
      "📏 Options-only.",
    ]);
    expect(basket.asOf).toBe("2026-11-06T15:30:00-05:00");
    expect(basket.tiers).toEqual([
      {
        id: "core",
        label: "Core ETFs",
        tickers: ["SMH", "QQQ"],
        weightPctNlv: 13,
      },
      { id: "tier-2", label: "Tier 2", tickers: ["NVDA"], weightPctNlv: null },
      { id: "tier-3", label: "Tier 3", tickers: [], weightPctNlv: null },
    ]);
  });

  it("falls back to a tier line and prefixes a bare summary", () => {
    const noSummary = readBasket(
      JSON.stringify({ generatedAt: "g", tiers: file.tiers.slice(0, 2) })
    );
    expect(noSummary.lines).toEqual([
      "🧺 Tiers: Core ETFs 13% NLV (SMH QQQ) · Tier 2 (NVDA)",
    ]);
    expect(noSummary.asOf).toBe("g");
    expect(
      readBasket(JSON.stringify({ asOf: "a", summary: "plain" })).lines
    ).toEqual(["🧺 plain"]);
    expect(readBasket(JSON.stringify({ summary: "  " })).lines).toEqual([]);
    expect(readBasket("{}").asOf).toBeNull();
  });

  it("clamps fields to the collect contract limits", () => {
    const long = readBasket(
      JSON.stringify({
        asOf: "a".repeat(100),
        reportPath: "p".repeat(900),
        rulesNote: "r".repeat(2000),
        summary: "x".repeat(2000),
        tiers: Array.from({ length: 30 }, () => ({
          id: "i".repeat(100),
          label: "l".repeat(200),
          tickers: Array.from({ length: 120 }, () => "T".repeat(20)),
        })),
      })
    );
    expect(long.summary).toHaveLength(1000);
    expect(long.rulesNote).toHaveLength(1000);
    expect(long.reportPath).toHaveLength(500);
    expect(long.asOf).toHaveLength(64);
    expect(long.tiers).toHaveLength(20);
    expect(long.tiers[0]?.id).toHaveLength(80);
    expect(long.tiers[0]?.label).toHaveLength(120);
    expect(long.tiers[0]?.tickers).toHaveLength(100);
    expect(long.tiers[0]?.tickers[0]).toHaveLength(16);
  });

  it("tolerates a missing or unreadable file", () => {
    expect(readBasket(null).available).toBe(false);
    expect(readBasket("not json").available).toBe(false);
    expect(readBasket(JSON.stringify({ tiers: "x" })).lines).toEqual([]);
  });

  it("defaults to the dip-basket path, overridable by env", () => {
    expect(basketPathOf({}, "/h")).toBe(
      "/h/Documents/reports/trading/dip-basket/basket.json"
    );
    expect(basketPathOf({ BREADTH90_BASKET: "/b.json" }, "/h")).toBe("/b.json");
  });
});

describe("state", () => {
  it("starts empty and round-trips with defaults", () => {
    expect(parseState(null)).toEqual(emptyState());
    const parsed = parseState(
      JSON.stringify({
        days: {},
        sent: { k: { at: "a", channels: {} } },
        version: 1,
      })
    );
    expect(parsed.sent["k"]?.seeded).toBe(false);
    expect(parsed.lastTick).toBeNull();
    expect(() => parseState(JSON.stringify({ version: 2 }))).toThrow();
  });

  it("trims cross-checks and test sends", () => {
    const state = {
      ...emptyState(),
      crossChecks: Array.from({ length: 250 }, (_, i) => ({
        at: `${i}`,
        date: "d",
        diff: 0,
        disagree: false,
        tvUpPct: 1,
        wsjUpPct: 1,
      })),
      testAlerts: Array.from({ length: 25 }, (_, i) => ({
        at: `${i}`,
        channels: {},
      })),
    };
    const trimmed = trimState(state);
    expect(trimmed.crossChecks).toHaveLength(200);
    expect(trimmed.crossChecks[0]?.at).toBe("50");
    expect(trimmed.testAlerts).toHaveLength(20);
  });
});

const WSJ_BODY = {
  data: {
    instrumentSets: [
      {
        headerFields: [{ label: "Issues", value: "name" }],
        instruments: [
          { NASDAQ: "2,919", NYSE: "1,553", name: "Advancing" },
          { NASDAQ: "1,818", NYSE: "1,169", name: "Declining" },
        ],
      },
      {
        headerFields: [{ label: "Issues At" }],
        instruments: [{ NYSE: "20", name: "New Highs" }],
      },
      {
        headerFields: [{ label: "Share Volume", value: "name" }],
        instruments: [
          { NYSE: "3,651,242,112", name: "Total" },
          { NYSE: "2,138,799,039", name: "Advancing" },
          { NYSE: "1,553,296,233", name: "Declining" },
        ],
      },
    ],
    timestamp: "3:14 PM EST 11/06/26",
  },
};

describe("wsj", () => {
  it("parses NYSE issues and share volume with the session date", () => {
    expect(parseWsjDiary(WSJ_BODY)).toEqual({
      asOf: "3:14 PM EST 11/06/26",
      date: "2026-11-06",
      source: "wsj",
      values: {
        adv: 1553,
        decl: 1169,
        dvol: 1_553_296_233,
        uvol: 2_138_799_039,
      },
    });
    expect(parseWsjTimestamp("4:00 PM EDT 7/2/26")).toBe("2026-07-02");
  });

  it("rejects an unreadable timestamp, table or number", () => {
    expect(() => parseWsjTimestamp("today")).toThrow("unreadable timestamp");
    const noVolume = {
      data: {
        ...WSJ_BODY.data,
        instrumentSets: WSJ_BODY.data.instrumentSets.slice(0, 1),
      },
    };
    expect(() => parseWsjDiary(noVolume)).toThrow("no issues or volume table");
    const sets = structuredClone(WSJ_BODY.data.instrumentSets);
    sets[0]!.instruments[0]!.NYSE = "n/a";
    expect(() =>
      parseWsjDiary({ data: { ...WSJ_BODY.data, instrumentSets: sets } })
    ).toThrow("unreadable number");
    const missing = structuredClone(WSJ_BODY.data.instrumentSets);
    missing[2]!.instruments = [];
    expect(() =>
      parseWsjDiary({ data: { ...WSJ_BODY.data, instrumentSets: missing } })
    ).toThrow("unreadable number");
    expect(() =>
      parseWsjDiary({
        data: {
          instrumentSets: [{ headerFields: [{}], instruments: [] }],
          timestamp: "1/1/26",
        },
      })
    ).toThrow();
  });

  it("fetches the diary and reports HTTP failures", async () => {
    const ok = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(WSJ_BODY), { status: 200 })
    );
    expect((await fetchWsj(ok)).date).toBe("2026-11-06");
    expect(ok.mock.calls[0]?.[0]).toBe(WSJ_URL);
    await expect(
      fetchWsj(async () => new Response("", { status: 403 }))
    ).rejects.toThrow("wsj: HTTP 403");
  });
});
