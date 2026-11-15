import { describe, expect, it } from "vitest";

import {
  cotSummary,
  formatCompact,
  formatMacroValue,
  formatNumber,
  formatPercent,
  formatSignedCompact,
  ivTableRows,
  MISSING,
  macroRows,
  newestDate,
  nyDate,
  otcWeeks,
  recentShortVolume,
  upcomingEvents,
  vxCurveRows,
} from "./view-model.ts";

const cot = (
  market: string,
  reportDate: string,
  net: number,
  category = "leveraged_funds",
  reportType: "tff" | "disaggregated" = "tff"
) => ({
  category: category as "leveraged_funds",
  long: 0,
  market,
  marketCode: "X",
  net,
  openInterest: 0,
  reportDate,
  reportType,
  short: 0,
});

describe("openbb view model", () => {
  it("formats values and New York dates", () => {
    expect(formatNumber(null)).toBe(MISSING);
    expect(formatNumber(1.234, 1)).toBe("1.2");
    expect(formatPercent(null)).toBe(MISSING);
    expect(formatPercent(0.1532)).toBe("15.3%");
    expect(formatCompact(null)).toBe(MISSING);
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatSignedCompact(null)).toBe(MISSING);
    expect(formatSignedCompact(2000)).toBe("+2K");
    expect(formatSignedCompact(-2000)).toBe("-2K");
    // 03:00 UTC on Nov 7 is still Nov 6 in New York.
    expect(nyDate(new Date("2026-11-07T03:00:00Z"))).toBe("2026-11-06");
    expect(nyDate(new Date("2026-11-07T03:00:00Z"), 14)).toBe("2026-11-20");
    expect(formatMacroValue(null, "usd")).toBe(MISSING);
    expect(formatMacroValue(812_000_000_000, "usd")).toBe("$812B");
    expect(formatMacroValue(3.874, "percent")).toBe("3.87 percent");
    expect(newestDate([])).toBeNull();
    expect(newestDate(["2026-11-05", "2026-11-06", "2026-11-01"])).toBe(
      "2026-11-06"
    );
  });

  it("joins the VX curve by contract month", () => {
    expect(vxCurveRows({ earlier: null, latest: null })).toEqual([]);
    expect(
      vxCurveRows({
        earlier: {
          asOf: "2026-10-30",
          points: [
            { contractMonth: "2026-11", price: 17 },
            { contractMonth: "2026-10", price: 16 },
          ],
        },
        latest: {
          asOf: "2026-11-06",
          points: [
            { contractMonth: "2026-11", price: 19 },
            { contractMonth: "2026-12", price: 20 },
          ],
        },
      })
    ).toEqual([
      { change: null, contractMonth: "2026-10", earlier: 16, latest: null },
      { change: 2, contractMonth: "2026-11", earlier: 17, latest: 19 },
      { change: null, contractMonth: "2026-12", earlier: null, latest: 20 },
    ]);
  });

  it("derives the 25-delta skew", () => {
    const row = {
      asOf: "2026-11-06",
      atmIv30d: 0.15,
      callIv25d30d: 0.12,
      callOi: 0,
      callVolume: 0,
      callWall: 600,
      contracts: 0,
      gammaFlip: 580,
      ivPercentile: 40,
      netGex: null,
      putIv25d30d: 0.2,
      putOi: 0,
      putVolume: 0,
      putWall: 550,
      sessions: 30,
      underlying: "SPY",
      underlyingPrice: 590,
    };
    const [full, partial] = ivTableRows([
      row,
      { ...row, callIv25d30d: null, underlying: "QQQ" },
    ]);
    expect(full?.skew25d).toBeCloseTo(0.08);
    expect(full).toMatchObject({
      callWall: 600,
      ivPercentile: 40,
      sessions: 30,
    });
    expect(partial?.skew25d).toBeNull();
  });

  it("summarizes the main COT category per market with a 4-week change", () => {
    const weeks = ["10-06", "10-13", "10-20", "10-27", "11-03"].map(
      (day) => `2026-${day}`
    );
    const rows = [
      ...weeks.map((day, index) => cot("ES", day, index * 100)),
      cot("ES", "2026-11-03", 999, "dealer"),
      cot("CL", "2026-11-03", 50, "managed_money", "disaggregated"),
      cot("CL", "2026-11-03", 7, "swap_dealer", "disaggregated"),
    ];
    // A holiday moves one report to Monday: 27 days still counts; a missing week (35 days) does not.
    const shifted = cotSummary([
      ...["10-07", "10-14", "10-21", "10-28", "11-03"].map((day, index) =>
        cot("NQ", `2026-${day}`, index)
      ),
      ...["09-29", "10-13", "10-20", "10-27", "11-03"].map((day, index) =>
        cot("YM", `2026-${day}`, index)
      ),
    ]);
    expect(shifted.map((row) => [row.market, row.change])).toEqual([
      ["NQ", 4],
      ["YM", null],
    ]);
    expect(cotSummary(rows)).toEqual([
      {
        category: "managed_money",
        change: null,
        market: "CL",
        net: 50,
        reportDate: "2026-11-03",
      },
      {
        category: "leveraged_funds",
        change: 400,
        market: "ES",
        net: 400,
        reportDate: "2026-11-03",
      },
    ]);
  });

  it("takes the newest macro point and filters events to 14 days", () => {
    const series = {
      firstDate: "2026-11-05",
      frequency: "daily",
      id: "EFFR",
      lastDate: "2026-11-06",
      name: "EFFR",
      pointCount: 2,
      points: [
        { date: "2026-11-05", value: 3.88 },
        { date: "2026-11-06", value: 3.87 },
      ],
      source: "federal_reserve",
      unit: "percent",
      updatedAt: new Date(),
    };
    expect(macroRows([series, { ...series, id: "SOFR", points: [] }])).toEqual([
      {
        asOf: "2026-11-06",
        id: "EFFR",
        name: "EFFR",
        unit: "percent",
        value: 3.87,
      },
      { asOf: null, id: "SOFR", name: "EFFR", unit: "percent", value: null },
    ]);
    const event = (date: string) => ({
      date,
      detail: null,
      eventKey: date,
      kind: "fomc",
      source: "fed",
      time: null,
      title: "x",
    });
    expect(
      upcomingEvents(
        [
          event("2026-11-05"),
          event("2026-11-06"),
          event("2026-11-20"),
          event("2026-11-21"),
        ],
        "2026-11-06"
      ).map((row) => row.date)
    ).toEqual(["2026-11-06", "2026-11-20"]);
  });

  it("sums weekly off-exchange shares and keeps the newest 20 short volume sessions", () => {
    const otc = (
      weekStart: string,
      venue: "ats" | "non_ats",
      shares: number
    ) => ({
      lastUpdated: null,
      shares,
      symbol: "SPY",
      tier: "T1",
      trades: 1,
      venue,
      weekStart,
    });
    expect(
      otcWeeks([
        otc("2026-10-19", "ats", 5),
        otc("2026-10-19", "non_ats", 7),
        otc("2026-10-19", "ats", 1),
        otc("2026-10-26", "ats", 2),
      ])
    ).toEqual([
      { ats: 2, nonAts: 0, weekStart: "2026-10-26" },
      { ats: 6, nonAts: 7, weekStart: "2026-10-19" },
    ]);
    const rows = Array.from({ length: 25 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      shortExemptVolume: 0,
      shortRatio: 0.5,
      shortVolume: 1,
      symbol: "SPY",
      totalVolume: 2,
    }));
    const recent = recentShortVolume(rows);
    expect(recent).toHaveLength(20);
    expect(recent[0]?.date).toBe("2026-10-25");
  });
});
