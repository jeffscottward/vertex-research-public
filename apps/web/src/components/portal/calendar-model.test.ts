import type { MarketNewsFiling, MarketNewsTicker } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_FILTER_LABELS,
  CALENDAR_FILTERS,
  CALENDAR_NEWS_HOURS,
  type CalendarEntry,
  earningsEntries,
  easternDate,
  easternTime,
  economicEntries,
  filterCalendarEntries,
  formatCalendarDay,
  groupCalendarDays,
  isEarningsFiling,
  latestEarningsFilings,
} from "./calendar-model.ts";

const filing = (
  filedAt: string,
  codes: readonly string[],
  url: string
): MarketNewsFiling => ({
  filedAt: new Date(filedAt),
  form: "8-K",
  important: codes.includes("2.02"),
  items: codes.map((code) => ({ code, label: `item ${code}` })),
  title: `Filed ${codes.join(", ")}`,
  url,
});

const older = filing(
  "2026-07-30T20:05:00.000Z",
  ["2.02", "9.01"],
  "https://www.sec.gov/a"
);
const newer = filing(
  "2026-10-30T20:05:00.000Z",
  ["2.02"],
  "https://www.sec.gov/b"
);
const other = filing(
  "2026-10-31T12:00:00.000Z",
  ["5.02"],
  "https://www.sec.gov/c"
);

const ticker = (
  symbol: string,
  filings: MarketNewsFiling[],
  errors: string[] = []
): MarketNewsTicker => ({ errors, filings, headlines: [], symbol });

describe("calendar model", () => {
  it("names the filters and asks for the widest news window", () => {
    expect(CALENDAR_FILTERS.map((key) => CALENDAR_FILTER_LABELS[key])).toEqual([
      "All",
      "Economic",
      "Earnings",
    ]);
    expect(CALENDAR_NEWS_HOURS).toBe(720);
  });

  it("recognises 8-K item 2.02 as an earnings filing", () => {
    expect(isEarningsFiling(older)).toBe(true);
    expect(isEarningsFiling(other)).toBe(false);
  });

  it("picks the newest earnings filing per ticker and keeps the filings error", () => {
    expect(
      latestEarningsFilings([
        // Out of order on purpose: the newest wins regardless of position.
        ticker("AAPL", [other, older, newer]),
        ticker("MSFT", [newer, older]),
        ticker(
          "SPY",
          [],
          [
            "headlines: Yahoo headlines returned HTTP 429",
            "filings: no SEC filer matches this symbol",
          ]
        ),
        ticker("QQQ", [other], ["headlines: timeout"]),
      ])
    ).toEqual([
      { error: null, filing: newer, symbol: "AAPL" },
      { error: null, filing: newer, symbol: "MSFT" },
      {
        error: "no SEC filer matches this symbol",
        filing: null,
        symbol: "SPY",
      },
      { error: null, filing: null, symbol: "QQQ" },
    ]);
  });

  it("reads instants on the New York clock across daylight saving and midnight", () => {
    // EDT (UTC-4): 20:05 UTC is 16:05 the same day.
    expect(easternDate(new Date("2026-10-30T20:05:00.000Z"))).toBe(
      "2026-10-30"
    );
    expect(easternTime(new Date("2026-10-30T20:05:00.000Z"))).toBe("16:05 ET");
    // EST (UTC-5): 02:30 UTC is still the previous evening in New York.
    expect(easternDate(new Date("2026-12-02T02:30:00.000Z"))).toBe(
      "2026-12-01"
    );
    expect(easternTime(new Date("2026-12-02T02:30:00.000Z"))).toBe("21:30 ET");
    expect(easternTime(new Date("2026-12-01T05:00:00.000Z"))).toBe("00:00 ET");
  });

  it("labels a day without shifting it to another zone", () => {
    expect(formatCalendarDay("2026-11-06")).toBe("Fri, Nov 6, 2026");
  });

  it("maps macro events, or nothing when the macro section is missing", () => {
    expect(economicEntries(null)).toEqual([]);
    expect(
      economicEntries({
        asOf: null,
        events: [
          { date: "2026-11-06", name: "Nonfarm payrolls", time: "08:30 ET" },
          { date: "2026-11-07", name: "Consumer sentiment", time: null },
        ],
        regimes: [],
        series: [],
      })
    ).toEqual([
      {
        date: "2026-11-06",
        key: "economic:2026-11-06:08:30 ET:Nonfarm payrolls",
        kind: "economic",
        name: "Nonfarm payrolls",
        time: "08:30 ET",
      },
      {
        date: "2026-11-07",
        key: "economic:2026-11-07::Consumer sentiment",
        kind: "economic",
        name: "Consumer sentiment",
        time: null,
      },
    ]);
  });

  it("turns every earnings filing into an entry dated in New York", () => {
    expect(earningsEntries([ticker("AAPL", [newer, other, older])])).toEqual([
      {
        date: "2026-10-30",
        key: "earnings:AAPL:https://www.sec.gov/b",
        kind: "earnings",
        symbol: "AAPL",
        time: "16:05 ET",
        title: "Filed 2.02",
        url: "https://www.sec.gov/b",
      },
      {
        date: "2026-07-30",
        key: "earnings:AAPL:https://www.sec.gov/a",
        kind: "earnings",
        symbol: "AAPL",
        time: "16:05 ET",
        title: "Filed 2.02, 9.01",
        url: "https://www.sec.gov/a",
      },
    ]);
  });

  const economic = (
    date: string,
    time: string | null,
    name: string
  ): CalendarEntry => ({
    date,
    key: `economic:${date}:${time ?? ""}:${name}`,
    kind: "economic",
    name,
    time,
  });
  const earnings = (
    date: string,
    time: string,
    symbol: string
  ): CalendarEntry => ({
    date,
    key: `earnings:${symbol}:${date}`,
    kind: "earnings",
    symbol,
    time,
    title: `${symbol} filed`,
    url: `https://www.sec.gov/${symbol}`,
  });

  it("dedupes, sorts by day, time, kind and name, and groups by day", () => {
    const cpi = economic("2026-11-10", "08:30 ET", "CPI");
    const days = groupCalendarDays([
      earnings("2026-11-10", "16:05 ET", "MSFT"),
      economic("2026-11-10", "08:30", "Core CPI"),
      earnings("2026-11-10", "16:05 ET", "AAPL"),
      cpi,
      cpi,
      economic("2026-11-10", null, "Treasury refunding"),
      earnings("2026-11-10", "08:30 ET", "JPM"),
      economic("2026-11-03", "10:00 ET", "ISM services"),
    ]);
    expect(
      days.map((day) => [
        day.date,
        day.entries.map((entry) =>
          entry.kind === "economic" ? entry.name : entry.symbol
        ),
      ])
    ).toEqual([
      ["2026-11-03", ["ISM services"]],
      [
        "2026-11-10",
        ["Treasury refunding", "Core CPI", "CPI", "JPM", "AAPL", "MSFT"],
      ],
    ]);
    expect(groupCalendarDays([])).toEqual([]);
  });

  it("orders untimed entries of one day by name", () => {
    const [day] = groupCalendarDays([
      economic("2026-11-10", null, "Treasury refunding"),
      economic("2026-11-10", null, "Fed minutes"),
    ]);
    expect(day?.entries.map((entry) => entry.key)).toEqual([
      "economic:2026-11-10::Fed minutes",
      "economic:2026-11-10::Treasury refunding",
    ]);
  });

  it("filters by kind, and All keeps everything", () => {
    const entries = [
      economic("2026-11-10", "08:30 ET", "CPI"),
      earnings("2026-11-10", "16:05 ET", "AAPL"),
    ];
    expect(filterCalendarEntries(entries, "all")).toEqual(entries);
    expect(filterCalendarEntries(entries, "economic")).toEqual([entries[0]]);
    expect(filterCalendarEntries(entries, "earnings")).toEqual([entries[1]]);
  });
});
