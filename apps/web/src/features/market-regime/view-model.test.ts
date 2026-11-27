import type { MarketRegimeOutput } from "@darkfactory/api";
import {
  REGIME_CREDIT_STALE_SECONDS,
  REGIME_DAILY_STALE_SECONDS,
  REGIME_GAMMA_PUSH_STALE_SECONDS,
  REGIME_RESEARCH_ONLY_NOTE,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  breadthCellView,
  buildRegimeRowViews,
  creditCellView,
  formatRegimeAge,
  formatRegimeSource,
  gammaCellView,
  regimeSourceStatus,
  summaryBadgeFor,
  trendCellView,
  volatilityCellView,
} from "./view-model.ts";

const makeOutput = (
  overrides?: Partial<MarketRegimeOutput["overall"]>
): MarketRegimeOutput => ({
  etfs: [
    {
      breadth90: {
        ageSeconds: 3600,
        armedOn: "2026-11-19",
        asOf: "2026-11-20T21:15:00.000Z",
        detail: "NYSE Breadth-90 ARMED.",
        latestAdvPct: 42,
        latestDate: "2026-11-20",
        latestFinal: false,
        latestKind: "DOWN_80",
        latestUpPct: 18.4,
        scope: "market_wide",
        sessionsLeft: 29,
        signalState: "ARMED",
        source: "breadth90",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "armed",
        strict: false,
      },
      credit: {
        ageSeconds: 180_000,
        asOf: "2026-11-20",
        detail: "US HY OAS 3.15% — calm.",
        hyOas: 3.15,
        hyOasBps: 315,
        hyOasChange20dBps: -5,
        hyOasPct1y: 22,
        igOas: 0.92,
        scope: "market_wide",
        source: "openbb_macro:HY_OAS",
        stale: false,
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "calm",
      },
      dealerGamma: {
        ageSeconds: 120,
        asOf: "2026-11-20T21:00:00.000Z",
        callWall: 530,
        detail: "QQQ positive gamma.",
        flip: 505,
        netGex: 500_000,
        oiSession: "2026-11-20",
        putWall: 490,
        scope: "etf",
        source: "market_context_gex",
        spot: 512,
        spotVsFlip: "above",
        stale: false,
        staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
        state: "positive",
        upstreamRegime: "dampened",
      },
      hasStaleInputs: false,
      missingCount: 0,
      mixedDrivers: ["Breadth-90 is armed after an 80%+ down day"],
      staleCount: 0,
      summary: "mixed",
      symbol: "QQQ",
      trend: {
        ageSeconds: 45,
        asOf: "2026-11-20",
        close: 512.34,
        detail: "QQQ uptrend.",
        pctVsSma50: 2.1,
        pctVsSma200: 8.5,
        scope: "etf",
        sessions: 252,
        sma50: 501.8,
        sma50AboveSma200: true,
        sma200: 472.2,
        source: "market_daily_series",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "uptrend",
      },
      volatility: {
        ageSeconds: 600,
        asOf: "2026-11-20",
        atmIv30d: 0.21,
        detail: "VIX 15.20 (calm).",
        etfVolIndex: 19.4,
        etfVolIndexId: "VXN",
        ivPercentile: 38,
        scope: "market_wide",
        source: "openbb_vol_context",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "calm",
        termStructure: "contango",
        vix: 15.2,
        vix3mVix6m: 0.96,
        vix9dVix: 0.91,
        vixVix3m: 0.88,
      },
    },
    {
      breadth90: {
        ageSeconds: null,
        armedOn: null,
        asOf: null,
        detail: "No reading stored.",
        latestAdvPct: null,
        latestDate: null,
        latestFinal: null,
        latestKind: null,
        latestUpPct: null,
        scope: "market_wide",
        sessionsLeft: null,
        signalState: null,
        source: "none",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "missing",
        strict: null,
      },
      credit: {
        ageSeconds: null,
        asOf: null,
        detail: "No reading stored.",
        hyOas: null,
        hyOasBps: null,
        hyOasChange20dBps: null,
        hyOasPct1y: null,
        igOas: null,
        scope: "market_wide",
        source: "none",
        stale: false,
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "missing",
      },
      dealerGamma: {
        ageSeconds: null,
        asOf: null,
        callWall: null,
        detail: "No reading stored.",
        flip: null,
        netGex: null,
        oiSession: null,
        putWall: null,
        scope: "etf",
        source: "market_context_gex",
        spot: null,
        spotVsFlip: null,
        stale: false,
        staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
        state: "missing",
        upstreamRegime: null,
      },
      hasStaleInputs: true,
      missingCount: 4,
      mixedDrivers: ["Trend input is stale"],
      staleCount: 1,
      summary: "incomplete",
      symbol: "SPY",
      trend: {
        ageSeconds: 500_000,
        asOf: "2026-11-10",
        close: null,
        detail: "No reading stored.",
        pctVsSma50: null,
        pctVsSma200: null,
        scope: "etf",
        sessions: 10,
        sma50: null,
        sma50AboveSma200: null,
        sma200: null,
        source: "none",
        stale: true,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "missing",
      },
      volatility: {
        ageSeconds: null,
        asOf: null,
        atmIv30d: null,
        detail: "No reading stored.",
        etfVolIndex: null,
        etfVolIndexId: "VIX",
        ivPercentile: null,
        scope: "market_wide",
        source: "none",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "missing",
        termStructure: "missing",
        vix: null,
        vix3mVix6m: null,
        vix9dVix: null,
        vixVix3m: null,
      },
    },
    {
      breadth90: {
        ageSeconds: 3600,
        armedOn: null,
        asOf: "2026-11-20T21:15:00.000Z",
        detail: "IDLE",
        latestAdvPct: 55,
        latestDate: "2026-11-20",
        latestFinal: false,
        latestKind: "NEUTRAL",
        latestUpPct: 54,
        scope: "market_wide",
        sessionsLeft: null,
        signalState: "IDLE",
        source: "breadth90",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "idle",
        strict: false,
      },
      credit: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        detail: "Widening",
        hyOas: 4.2,
        hyOasBps: 420,
        hyOasChange20dBps: 40,
        hyOasPct1y: 70,
        igOas: null,
        scope: "market_wide",
        source: "openbb_macro:HY_OAS",
        stale: false,
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "widening",
      },
      dealerGamma: {
        ageSeconds: null,
        asOf: null,
        callWall: null,
        detail: "No feed for IWM.",
        flip: null,
        netGex: null,
        oiSession: null,
        putWall: null,
        scope: "etf",
        source: "none",
        spot: null,
        spotVsFlip: null,
        stale: false,
        staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
        state: "not_covered",
        upstreamRegime: null,
      },
      hasStaleInputs: false,
      missingCount: 0,
      mixedDrivers: [],
      staleCount: 0,
      summary: "risk_on",
      symbol: "IWM",
      trend: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        close: 220,
        detail: "IWM",
        pctVsSma50: null,
        pctVsSma200: -1.2,
        scope: "etf",
        sessions: 220,
        sma50: 220,
        sma50AboveSma200: false,
        sma200: 222.7,
        source: "market_daily_series",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "downtrend",
      },
      volatility: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        atmIv30d: null,
        detail: "VIX 15",
        etfVolIndex: 15,
        etfVolIndexId: "VIX",
        ivPercentile: null,
        scope: "market_wide",
        source: "openbb_vol_context",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "calm",
        termStructure: "contango",
        vix: 15,
        vix3mVix6m: null,
        vix9dVix: null,
        vixVix3m: null,
      },
    },
    {
      breadth90: {
        ageSeconds: 3600,
        armedOn: "2026-11-18",
        asOf: "2026-11-20T21:15:00.000Z",
        detail: "FORMING",
        latestAdvPct: null,
        latestDate: null,
        latestFinal: true,
        latestKind: "UP_90",
        latestUpPct: null,
        scope: "market_wide",
        sessionsLeft: null,
        signalState: "FORMING",
        source: "breadth90",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "forming",
        strict: false,
      },
      credit: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        detail: "Calm",
        hyOas: 3.0,
        hyOasBps: 300,
        hyOasChange20dBps: 0,
        hyOasPct1y: null,
        igOas: null,
        scope: "market_wide",
        source: "openbb_macro:HY_OAS",
        stale: false,
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "calm",
      },
      dealerGamma: {
        ageSeconds: null,
        asOf: null,
        callWall: null,
        detail: "No feed for DIA.",
        flip: null,
        netGex: null,
        oiSession: null,
        putWall: null,
        scope: "etf",
        source: "none",
        spot: null,
        spotVsFlip: null,
        stale: false,
        staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
        state: "not_covered",
        upstreamRegime: null,
      },
      hasStaleInputs: false,
      missingCount: 0,
      mixedDrivers: [],
      staleCount: 0,
      summary: "risk_off",
      symbol: "DIA",
      trend: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        close: 410,
        detail: "DIA",
        pctVsSma50: -2.5,
        pctVsSma200: 0,
        scope: "etf",
        sessions: 220,
        sma50: 420.5,
        sma50AboveSma200: true,
        sma200: 410,
        source: "market_daily_series",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "mixed",
      },
      volatility: {
        ageSeconds: 3600,
        asOf: "2026-11-20",
        atmIv30d: null,
        detail: "VIX 31",
        etfVolIndex: 25,
        etfVolIndexId: "VXD",
        ivPercentile: null,
        scope: "market_wide",
        source: "openbb_vol_context",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "extreme",
        termStructure: "backwardation",
        vix: 31,
        vix3mVix6m: null,
        vix9dVix: null,
        vixVix3m: 1.08,
      },
    },
  ],
  generatedAt: "2026-11-22T18:00:00.000Z",
  overall: {
    missingPillarCount: 0,
    staleEtfs: [],
    stalePillarCount: 0,
    summary: "mixed",
    ...overrides,
  },
  researchOnlyNote: REGIME_RESEARCH_ONLY_NOTE,
});

describe("market-regime view-model", () => {
  it("formats elapsed ages across seconds, minutes, hours, and days", () => {
    expect(formatRegimeAge(null)).toBeNull();
    expect(formatRegimeAge(15)).toBe("<1m ago");
    expect(formatRegimeAge(12 * 60)).toBe("12m ago");
    expect(formatRegimeAge(6 * 3600)).toBe("6h ago");
    expect(formatRegimeAge(5 * 86_400)).toBe("5d ago");
  });

  it("maps overall regime health to MarketSourceStatus (partial, stale, ready)", () => {
    expect(regimeSourceStatus(makeOutput())).toBe("ready");
    expect(regimeSourceStatus(makeOutput({ stalePillarCount: 2 }))).toBe(
      "stale"
    );
    expect(regimeSourceStatus(makeOutput({ missingPillarCount: 1 }))).toBe(
      "partial"
    );
  });

  it("maps summary badges and all 5 pillar cell shapes including not_covered, intraday, and unavailable", () => {
    expect(summaryBadgeFor("risk_on")).toEqual({
      label: "Risk on",
      tone: "success",
    });
    expect(summaryBadgeFor("risk_off")).toEqual({
      label: "Risk off",
      tone: "destructive",
    });

    const data = makeOutput();
    const rows = buildRegimeRowViews(data);
    expect(rows).toHaveLength(4);

    // QQQ (populated)
    expect(rows[0]?.trend).toMatchObject({
      primary: "$512.34",
      secondary: "50d +2.1% · 200d +8.5%",
      stale: false,
    });
    expect(rows[0]?.breadth90).toMatchObject({
      primary: "18.4% up-vol",
      secondary: "Armed 2026-11-19 (29 left)",
    });
    expect(rows[0]?.dealerGamma).toMatchObject({
      primary: "Flip 505.00",
      secondary: "Spot 512.00 (above)",
    });
    expect(rows[0]?.credit).toMatchObject({
      primary: "3.15% (315 bps)",
      secondary: "20d -5 bps · IG 0.92%",
    });
    expect(rows[0]?.volatility).toMatchObject({
      primary: "VIX 15.20",
      secondary: "0.88 contango · VXN 19.4",
    });

    // SPY (unavailable / stale)
    expect(rows[1]?.trend).toMatchObject({
      primary: "No price",
      secondary: "10 sessions",
      stale: true,
    });
    expect(rows[1]?.breadth90.primary).toBe("No reading");
    expect(rows[1]?.dealerGamma).toMatchObject({
      primary: "No flip level",
      secondary: "No spot quote",
    });
    expect(rows[1]?.credit).toMatchObject({
      primary: "No spread",
      secondary: "HY OAS",
    });
    expect(rows[1]?.volatility).toMatchObject({
      primary: "No VIX",
      secondary: "No term ratio",
    });

    // IWM (not_covered gamma, intraday breadth, positive bps credit)
    expect(rows[2]?.dealerGamma).toMatchObject({
      badge: { label: "No feed", tone: "neutral" },
      primary: "Not covered",
      secondary: "SPY & QQQ only",
    });
    expect(rows[2]?.breadth90.secondary).toBe("NEUTRAL (intraday)");
    expect(rows[2]?.credit.secondary).toBe("20d +40 bps");
    expect(rows[2]?.trend.secondary).toBe("50d missing · 200d -1.2%");

    // DIA (armed without sessionsLeft, final breadth)
    expect(rows[3]?.breadth90).toMatchObject({
      primary: "FORMING",
      secondary: "Armed 2026-11-18 (0 left)",
    });
    expect(
      breadthCellView({
        ...data.etfs[2]!.breadth90,
        latestFinal: true,
      }).secondary
    ).toBe("NEUTRAL");
    expect(
      creditCellView({
        ...data.etfs[2]!.credit,
        hyOasBps: null,
        hyOasChange20dBps: null,
      })
    ).toMatchObject({
      primary: "4.20%",
      secondary: "HY OAS",
    });
    expect(trendCellView(data.etfs[3]!.trend).badge.label).toBe("Mixed");
    expect(gammaCellView(data.etfs[0]!.dealerGamma).badge.label).toBe(
      "Positive"
    );
    expect(volatilityCellView(data.etfs[3]!.volatility).secondary).toBe(
      "1.08 backwardation · VXD 25.0"
    );
  });

  it("formats internal market-regime source ids as readable words", () => {
    expect(formatRegimeSource("market_daily_series")).toBe(
      "Daily price series"
    );
    expect(formatRegimeSource("ibkr_bars")).toBe("IBKR bars");
    expect(formatRegimeSource("breadth90")).toBe("Breadth-90");
    expect(formatRegimeSource("market_context_gex")).toBe("Market-context GEX");
    expect(formatRegimeSource("openbb_macro:HY_OAS")).toBe(
      "OpenBB macro (HY OAS)"
    );
    expect(formatRegimeSource("market_context_macro:hy_oas")).toBe(
      "Market-context macro (hy oas)"
    );
    expect(
      formatRegimeSource("ibkr_monitor_volatility+openbb_vol_context")
    ).toBe("IBKR volatility + OpenBB volatility");
    expect(formatRegimeSource("none")).toBe("No source");
    expect(formatRegimeSource("custom_feed_v2")).toBe("Custom feed v2");
  });
});
