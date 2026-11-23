import { describe, expect, it } from "vitest";

import {
  blockedNotice,
  cotSummary,
  formatCompact,
  formatMacroValue,
  formatNumber,
  formatPercent,
  formatSignedCompact,
  ivBasisText,
  ivPanelDate,
  ivSourceNotice,
  ivStandingText,
  ivTableRows,
  MISSING,
  macroRows,
  NOT_COLLECTED,
  newestDate,
  nyDate,
  nyDateTime,
  type OpenbbRuns,
  optionTypeText,
  otcWeeks,
  recentShortVolume,
  upcomingEvents,
  volRatioText,
  vxCurveRows,
  vxSourceNotice,
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
  it("names why a vol ratio, an IV percentile or an option type has no value", () => {
    const indices = [
      { close: 19, date: "2026-11-06", id: "VIX" },
      { close: 21, date: "2026-11-05", id: "VIX3M" },
      { close: 0, date: "2026-11-06", id: "VIX9D" },
    ] as const;
    expect(volRatioText(0.9, ["VIX", "VIX3M"], [...indices])).toBe("0.900");
    expect(volRatioText(null, ["VIX3M", "VIX6M"], [...indices])).toBe(
      "Not yet collected (VIX6M)"
    );
    expect(volRatioText(null, ["VIX6M", "VIX"], [...indices])).toBe(
      "Not yet collected (VIX6M)"
    );
    expect(volRatioText(null, ["VIX1D", "VIX6M"], [])).toBe(
      "Not yet collected (VIX1D, VIX6M)"
    );
    expect(volRatioText(null, ["VIX", "VIX3M"], [...indices])).toBe(
      "Not computable (VIX 2026-11-06, VIX3M 2026-11-05)"
    );
    expect(volRatioText(null, ["VIX", "VIX9D"], [...indices])).toBe(
      "Not computable (VIX9D close is 0)"
    );
    expect(ivStandingText({ ivPercentile: 78.4, ivRank: 64.2 })).toBe(
      "78 / 64"
    );
    expect(ivStandingText({ ivPercentile: 0, ivRank: null })).toBe(
      "0 / Flat range"
    );
    expect(ivStandingText({ ivPercentile: null, ivRank: null })).toBe(
      "Not computable"
    );
    expect(
      ivBasisText({
        basis: "own_atm_iv",
        basisAsOf: "2027-11-06",
        basisReason: null,
        basisSessions: 252,
        proxyIndex: null,
      })
    ).toBe("Own ATM IV (252d, 2027-11-06)");
    expect(
      ivBasisText({
        basis: "vol_index_proxy",
        basisAsOf: "2026-11-06",
        basisReason: null,
        basisSessions: 252,
        proxyIndex: "VXN",
      })
    ).toBe("VXN proxy (252d, 2026-11-06)");
    expect(
      ivBasisText({
        basis: "vol_index_proxy",
        basisAsOf: "2026-11-06",
        basisReason:
          "Flat 1-year range (min equals max); IV rank not computable",
        basisSessions: 252,
        proxyIndex: "VIX",
      })
    ).toBe(
      "VIX proxy (252d, 2026-11-06) · Flat 1-year range (min equals max); IV rank not computable"
    );
    expect(
      ivBasisText({
        basis: null,
        basisAsOf: null,
        basisReason: "Own ATM IV: Needs 252 sessions with ATM IV (9 stored)",
        basisSessions: 0,
        proxyIndex: null,
      })
    ).toBe("Own ATM IV: Needs 252 sessions with ATM IV (9 stored)");
    expect(
      ivBasisText({
        basis: null,
        basisAsOf: null,
        basisReason: null,
        basisSessions: 0,
        proxyIndex: null,
      })
    ).toBe(NOT_COLLECTED);
    expect(optionTypeText("")).toBe("Shares (no option)");
    expect(optionTypeText("call")).toBe("call");
  });

  it("formats values and New York dates", () => {
    expect(MISSING).toBe("Not reported by source");
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
    expect(formatMacroValue(2_127_055, "contracts")).toBe(
      "2,127,055 contracts"
    );
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

  it("combines option-chain snapshots with 1-year IV standing in canonical order", () => {
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
      sessions: 252,
      underlying: "SPY",
      underlyingPrice: 590,
    };
    const emptyBasis = {
      asOf: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: 252 as const,
      reason: "No ATM IV sessions stored",
      sessions: 0,
      windowSessions: 252 as const,
    };
    const oneYear = [
      {
        asOf: "2026-11-06",
        basis: "own_atm_iv" as const,
        ivPercentile: 40,
        ivRank: 35,
        latestValue: 0.15,
        minSessions: 252 as const,
        own: {
          ...emptyBasis,
          asOf: "2026-11-06",
          ivPercentile: 40,
          ivRank: 35,
          latestValue: 0.15,
          reason: null,
          sessions: 252,
        },
        proxy: { ...emptyBasis, index: "VIX" as const },
        proxyIndex: null,
        reason: null,
        sessions: 252,
        underlying: "SPY" as const,
        unit: "decimal" as const,
        windowSessions: 252 as const,
      },
      {
        asOf: "2026-11-05",
        basis: "vol_index_proxy" as const,
        ivPercentile: 78,
        ivRank: 64,
        latestValue: 24,
        minSessions: 252 as const,
        own: emptyBasis,
        proxy: {
          ...emptyBasis,
          asOf: "2026-11-05",
          index: "VXN" as const,
          ivPercentile: 78,
          ivRank: 64,
          latestValue: 24,
          reason: null,
          sessions: 252,
        },
        proxyIndex: "VXN" as const,
        reason: null,
        sessions: 252,
        underlying: "QQQ" as const,
        unit: "vol_points" as const,
        windowSessions: 252 as const,
      },
      {
        asOf: "2026-11-05",
        basis: "vol_index_proxy" as const,
        ivPercentile: 55,
        ivRank: 48,
        latestValue: 19,
        minSessions: 252 as const,
        own: emptyBasis,
        proxy: {
          ...emptyBasis,
          asOf: "2026-11-05",
          index: "RVX" as const,
          ivPercentile: 55,
          ivRank: 48,
          latestValue: 19,
          reason: null,
          sessions: 252,
        },
        proxyIndex: "RVX" as const,
        reason: null,
        sessions: 252,
        underlying: "IWM" as const,
        unit: "vol_points" as const,
        windowSessions: 252 as const,
      },
      {
        asOf: null,
        basis: null,
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252 as const,
        own: emptyBasis,
        proxy: { ...emptyBasis, index: "VXD" as const },
        proxyIndex: null,
        reason:
          "Own ATM IV: No ATM IV sessions stored; VXD proxy: No VXD sessions stored",
        sessions: 0,
        underlying: "DIA" as const,
        unit: null,
        windowSessions: 252 as const,
      },
    ];
    const result = ivTableRows(
      [{ ...row, callIv25d30d: null, underlying: "QQQ" }, row],
      oneYear
    );
    expect(result.map((entry) => entry.underlying)).toEqual([
      "SPY",
      "QQQ",
      "IWM",
    ]);
    const [spy, qqq, iwm] = result;
    expect(spy?.skew25d).toBeCloseTo(0.08);
    expect(spy).toMatchObject({
      asOf: "2026-11-06",
      basis: "own_atm_iv",
      basisSessions: 252,
      callWall: 600,
      ivPercentile: 40,
      ivRank: 35,
    });
    expect(qqq?.skew25d).toBeNull();
    expect(qqq?.proxyIndex).toBe("VXN");
    // IWM has no ivDaily snapshot row -> asOf is null while proxy standing still renders.
    expect(iwm).toMatchObject({
      asOf: null,
      atmIv30d: null,
      basis: "vol_index_proxy",
      basisAsOf: "2026-11-05",
      ivPercentile: 55,
      ivRank: 48,
      proxyIndex: "RVX",
      skew25d: null,
    });
    expect(ivPanelDate([])).toBeNull();
    expect(ivPanelDate(result)).toBe("2026-11-06");
    expect(ivPanelDate([iwm as (typeof result)[number]])).toBe("2026-11-05");
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

describe("job notices", () => {
  const AT = new Date("2026-11-19T22:45:00.000Z");
  const run = (
    job: string,
    extra: Partial<OpenbbRuns[number]> = {}
  ): OpenbbRuns[number] => ({
    blocked: null,
    error: null,
    finishedAt: AT,
    id: job,
    job,
    openbbVersion: null,
    rowsReceived: 0,
    rowsWritten: 0,
    startedAt: AT,
    status: "ok",
    warnings: [],
    ...extra,
  });
  const blocked = {
    attempts: 1,
    nextRetryAt: new Date("2026-11-20T14:05:00.000Z"),
    since: AT,
  };

  it("formats a New York time", () => {
    expect(nyDateTime(AT)).toBe("Nov 19, 5:45 PM ET");
    expect(nyDateTime(new Date("2026-07-01T13:05:00.000Z"))).toBe(
      "Jul 1, 9:05 AM ET"
    );
  });

  it("names reason, start and next retry of a blocked job", () => {
    const runs = [
      run("cboe-vx-curve"),
      run("cboe-option-iv", {
        blocked,
        error: "HTTP 403 from cdn-api.cboe.com",
        status: "blocked_upstream",
      }),
      run("cboe-vol-indices", { blocked, status: "blocked_upstream" }),
    ];
    expect(blockedNotice(runs, "cboe-option-iv")).toBe(
      "Blocked upstream: HTTP 403 from cdn-api.cboe.com since Nov 19, 5:45 PM ET. Next retry: the first ingest run after Nov 20, 9:05 AM ET. The rows below are from the last good run."
    );
    expect(blockedNotice(runs, "cboe-vol-indices")).toContain(
      "Blocked upstream: the host refused the request since"
    );
    expect(blockedNotice(runs, "cboe-vx-curve")).toBeNull();
    expect(blockedNotice(runs, "cftc-cot")).toBeNull();
  });

  it("names the CFE file when the newest VX curve run used it", () => {
    const note =
      "cboe VX curve 2026-11-19: ContentTypeError: 403; used the CFE settlement file of 2026-11-19";
    expect(
      vxSourceNotice([run("cboe-vx-curve", { warnings: ["other", note] })])
    ).toContain("CFE daily settlement file");
    expect(vxSourceNotice([run("cboe-vx-curve")])).toBeNull();
    expect(
      vxSourceNotice([run("cboe-option-iv", { warnings: [note] })])
    ).toBeNull();
    expect(vxSourceNotice([])).toBeNull();
  });

  it("names the Yahoo source and only its symbols when the newest IV run used it", () => {
    const marker = "used the Yahoo option chain";
    const spy = `cboe chain SPY: ContentTypeError: 403; ${marker} (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)`;
    const gld = `cboe chain GLD: ContentTypeError: 403; ${marker} (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)`;
    const skip = `cboe chain SPY: ${marker} earlier this session; skipped the re-fetch`;
    const expected = (symbols: string) =>
      `Source of the newest rows: Yahoo option chain for ${symbols} (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary.`;
    const stored = {
      rowsReceived: 12,
      rowsWritten: 12,
      status: "partial" as const,
    };
    expect(
      ivSourceNotice([
        run("cboe-option-iv", { ...stored, warnings: [gld, spy] }),
      ])
    ).toBe(expected("GLD, SPY"));
    // A mixed run names only the Yahoo symbol; a skip warning keeps the note alive
    // even on a zero-row skip run (the fetcher only writes it after a fully stored run).
    expect(
      ivSourceNotice([run("cboe-option-iv", { ...stored, warnings: [spy] })])
    ).toBe(expected("SPY"));
    expect(
      ivSourceNotice([
        run("cboe-option-iv", { status: "partial", warnings: [skip] }),
      ])
    ).toBe(expected("SPY"));
    // A first-use marker without complete persistence claims nothing: failed ingest
    // (0 written) and partial ingest (5 of 12) both keep the previous rows' source.
    expect(
      ivSourceNotice([
        run("cboe-option-iv", {
          rowsReceived: 12,
          rowsWritten: 0,
          status: "failed",
          warnings: [spy],
        }),
      ])
    ).toBeNull();
    expect(
      ivSourceNotice([
        run("cboe-option-iv", {
          rowsReceived: 12,
          rowsWritten: 5,
          status: "partial",
          warnings: [spy],
        }),
      ])
    ).toBeNull();
    // No marker, the CFE marker only, an ok run, another job, no runs: no note.
    expect(ivSourceNotice([run("cboe-option-iv")])).toBeNull();
    expect(
      ivSourceNotice([
        run("cboe-option-iv", {
          warnings: [
            "cboe chain SPY: used the CFE settlement file of 2026-11-19",
          ],
        }),
      ])
    ).toBeNull();
    expect(
      ivSourceNotice([run("cboe-vx-curve", { warnings: [spy] })])
    ).toBeNull();
    expect(ivSourceNotice([])).toBeNull();
  });
});
