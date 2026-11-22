import { describe, expect, it } from "vitest";

import type {
  GexIndexRow,
  MacroSeries,
  MarketContextOutput,
} from "./contracts/market-context.ts";
import {
  MarketRegimeOutputSchema,
  REGIME_CREDIT_STALE_SECONDS,
  REGIME_DAILY_STALE_SECONDS,
  REGIME_GAMMA_PUSH_STALE_SECONDS,
  REGIME_INDEX_SYMBOLS,
  REGIME_RESEARCH_ONLY_NOTE,
} from "./contracts/market-regime.ts";
import {
  buildRegimeEtfRow,
  classifyBreadth90Pillar,
  classifyCreditPillar,
  classifyDealerGammaPillar,
  classifyTrendPillar,
  classifyVolatilityPillar,
  classifyVolTermStructure,
  computeAgeSeconds,
  findCreditFallbackSeries,
  normalizeRegimeAsOf,
  parseRegimeAsOfMs,
  simpleMovingAverage,
  summarizeOverallRegime,
} from "./market-regime-rules.ts";

const NOW = new Date("2026-11-22T18:00:00.000Z");

const seriesCloses = (
  length: number,
  base: number,
  step = 0,
  last?: number
): number[] => {
  const out = Array.from({ length }, (_, index) => base + index * step);
  if (last !== undefined && out.length > 0) {
    out[out.length - 1] = last;
  }
  return out;
};

describe("market-regime-rules", () => {
  describe("date and age helpers", () => {
    it("normalizes and parses valid dates/datetimes and rejects malformed values", () => {
      expect(normalizeRegimeAsOf(null)).toBeNull();
      expect(normalizeRegimeAsOf("2026-02-30")).toBeNull();
      expect(normalizeRegimeAsOf("2026-11-20T99:00:00Z")).toBeNull();
      expect(normalizeRegimeAsOf("Nov 20, 2026")).toBeNull();
      expect(normalizeRegimeAsOf(" 2026-11-20 ")).toBe("2026-11-20");
      expect(normalizeRegimeAsOf("2026-11-22T17:50:00.000Z")).toBe(
        "2026-11-22T17:50:00.000Z"
      );

      expect(parseRegimeAsOfMs(null)).toBeNull();
      expect(parseRegimeAsOfMs("2026-11-20")).toBe(
        Date.parse("2026-11-20T21:00:00.000Z")
      );
      expect(parseRegimeAsOfMs("2026-11-22T17:50:00.000Z")).toBe(
        Date.parse("2026-11-22T17:50:00.000Z")
      );
    });

    it("clamps slightly future timestamps to zero age and returns null for unparseable input", () => {
      expect(computeAgeSeconds(null, NOW)).toBeNull();
      expect(computeAgeSeconds("2026-11-22T18:05:00.000Z", NOW)).toBe(0);
      expect(computeAgeSeconds("2026-11-22T17:50:00.000Z", NOW)).toBe(600);
    });

    it("computes simple moving averages only when enough closes exist", () => {
      expect(simpleMovingAverage([10, 20], 3)).toBeNull();
      expect(simpleMovingAverage([10, 20, 30, 40], 2)).toBe(35);
    });
  });

  describe("classifyTrendPillar (C058, C108)", () => {
    it("marks missing or short history (<200 sessions) as unavailable without flagging stale", () => {
      const empty = classifyTrendPillar(
        { asOf: null, closes: [], source: "none", symbol: "QQQ" },
        NOW
      );
      expect(empty).toMatchObject({
        close: null,
        sessions: 0,
        sma50: null,
        sma200: null,
        stale: false,
        state: "missing",
      });

      const short = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes: seriesCloses(60, 100),
          source: "market_daily_series",
          symbol: "SPY",
        },
        NOW
      );
      expect(short.state).toBe("missing");
      expect(short.sma50).toBe(100);
      expect(short.pctVsSma50).toBe(0);
      expect(short.sma200).toBeNull();
      expect(short.stale).toBe(false);

      const zeroShort = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes: seriesCloses(60, 0),
          source: "market_daily_series",
          symbol: "SPY",
        },
        NOW
      );
      expect(zeroShort.pctVsSma50).toBeNull();
    });

    it("classifies uptrend, downtrend, mixed, upstreamStale, and 96h staleness", () => {
      const up = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes: seriesCloses(220, 400, 0.5, 550),
          source: "market_daily_series",
          symbol: "QQQ",
        },
        NOW
      );
      expect(up.state).toBe("uptrend");
      expect(up.stale).toBe(false);
      expect(up.sma50AboveSma200).toBe(true);
      expect(up.staleLimitSeconds).toBe(REGIME_DAILY_STALE_SECONDS);

      const upstreamStale = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes: seriesCloses(220, 400, 0.5, 550),
          source: "ibkr_bars",
          symbol: "QQQ",
          upstreamStale: true,
        },
        NOW
      );
      expect(upstreamStale.stale).toBe(true);

      const down = classifyTrendPillar(
        {
          asOf: "2026-11-10",
          closes: seriesCloses(220, 600, -0.5, 420),
          source: "market_daily_series",
          symbol: "IWM",
        },
        NOW
      );
      expect(down.state).toBe("downtrend");
      expect(down.stale).toBe(true);
      expect(down.ageSeconds).toBeGreaterThan(REGIME_DAILY_STALE_SECONDS);

      const closes = seriesCloses(220, 400, 0.5);
      closes[closes.length - 1] = 480;
      const mixed = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes,
          source: "ibkr_bars",
          symbol: "DIA",
        },
        NOW
      );
      expect(mixed.state).toBe("mixed");

      const zero = classifyTrendPillar(
        {
          asOf: "2026-11-20",
          closes: seriesCloses(200, 0),
          source: "market_daily_series",
          symbol: "DIA",
        },
        NOW
      );
      expect(zero.state).toBe("mixed");
      expect(zero.pctVsSma50).toBeNull();
      expect(zero.pctVsSma200).toBeNull();
    });
  });

  describe("classifyBreadth90Pillar", () => {
    it("handles null data, null status, all 4 states, and catches stale latestDay even with fresh status.asOf", () => {
      expect(classifyBreadth90Pillar(null, NOW, "DB down")).toMatchObject({
        detail: "DB down",
        source: "none",
        stale: false,
        state: "missing",
      });
      expect(
        classifyBreadth90Pillar(
          {
            days: [],
            events: [],
            status: null,
            thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
          },
          NOW
        )
      ).toMatchObject({
        source: "breadth90",
        stale: false,
        state: "missing",
      });

      const armed = classifyBreadth90Pillar(
        {
          days: [
            {
              adv: 1200,
              advPct: 40,
              date: "2026-11-20",
              decl: 1800,
              dvol: 850,
              final: true,
              kind: "DOWN_80",
              source: "tradingview",
              sourceAsOf: "2026-11-20T21:00:00Z",
              updatedAt: "2026-11-20T21:15:00.000Z",
              upPct: 15,
              uvol: 150,
            },
          ],
          events: [],
          status: {
            armedOn: "2026-11-20",
            asOf: "2026-11-20T21:15:00.000Z",
            basket: null,
            sessionsLeft: 29,
            state: "ARMED",
            strict: false,
          },
          thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
        },
        NOW
      );
      expect(armed).toMatchObject({
        armedOn: "2026-11-20",
        latestKind: "DOWN_80",
        latestUpPct: 15,
        sessionsLeft: 29,
        signalState: "ARMED",
        stale: false,
        state: "armed",
      });

      // Fresh status.asOf but latestDay.date > 96h old => stale!
      const staleSession = classifyBreadth90Pillar(
        {
          days: [
            {
              adv: 1500,
              advPct: 50,
              date: "2026-11-10",
              decl: 1500,
              dvol: 500,
              final: true,
              kind: "NEUTRAL",
              source: "tradingview",
              sourceAsOf: "2026-11-10T21:00:00Z",
              updatedAt: "2026-11-10T21:15:00.000Z",
              upPct: 50,
              uvol: 500,
            },
          ],
          events: [],
          status: {
            armedOn: null,
            asOf: "2026-11-22T17:55:00.000Z",
            basket: null,
            sessionsLeft: null,
            state: "IDLE",
            strict: false,
          },
          thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
        },
        NOW
      );
      expect(staleSession.stale).toBe(true);
      expect(staleSession.ageSeconds).toBeGreaterThan(
        REGIME_DAILY_STALE_SECONDS
      );

      const formingNoSessionsLeft = classifyBreadth90Pillar(
        {
          days: [],
          events: [],
          status: {
            armedOn: "2026-11-19",
            asOf: "2026-11-20T21:15:00.000Z",
            basket: null,
            sessionsLeft: null,
            state: "FORMING",
            strict: false,
          },
          thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
        },
        NOW
      );
      expect(formingNoSessionsLeft.state).toBe("forming");
      expect(formingNoSessionsLeft.detail).toContain("0 sessions left");
    });
  });

  describe("classifyDealerGammaPillar (C006, C878)", () => {
    const baseContext: MarketContextOutput = {
      generatedAt: "2026-11-22T17:55:00.000Z",
      gex: {
        asOf: "2026-11-20T21:00:00.000Z",
        index: [
          {
            callWall: 605,
            fadeNote: null,
            flip: 590,
            netChex: null,
            netDex: null,
            netGex: 1_250_000_000,
            netVex: null,
            notes: [],
            putWall: 580,
            regime: "dampened",
            spot: 598,
            spotVsFlip: "above",
            status: "ok",
            symbol: "SPY",
            zeroDte: null,
          },
          {
            callWall: 520,
            fadeNote: null,
            flip: 505,
            netChex: null,
            netDex: null,
            netGex: -450_000_000,
            netVex: null,
            notes: [],
            putWall: 490,
            regime: "amplified",
            spot: 500,
            spotVsFlip: "below",
            status: "ok",
            symbol: "QQQ",
            zeroDte: null,
          },
        ],
        label: null,
        oiSession: "2026-11-20",
      },
      macro: null,
      missing: [],
      news: null,
      sections: { gex: null, macro: null, news: null },
      stale: false,
    };

    const baseGex = baseContext.gex as NonNullable<MarketContextOutput["gex"]>;
    const spyRow = baseGex.index[0] as GexIndexRow;

    it("marks IWM and DIA as not_covered without fabricating from SPY", () => {
      expect(classifyDealerGammaPillar("IWM", baseContext, NOW)).toMatchObject({
        scope: "etf",
        source: "none",
        stale: false,
        state: "not_covered",
      });
      expect(classifyDealerGammaPillar("DIA", baseContext, NOW).state).toBe(
        "not_covered"
      );
    });

    it("classifies SPY positive and QQQ negative gamma and aligns ageSeconds/staleLimitSeconds on dual staleness", () => {
      const spy = classifyDealerGammaPillar("SPY", baseContext, NOW);
      expect(spy).toMatchObject({
        flip: 590,
        spot: 598,
        spotVsFlip: "above",
        stale: false,
        staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
        state: "positive",
      });

      const qqq = classifyDealerGammaPillar("QQQ", baseContext, NOW);
      expect(qqq).toMatchObject({
        flip: 505,
        spotVsFlip: "below",
        stale: false,
        state: "negative",
      });

      // Push stopped > 15 min ago -> reports 900s limit and push age
      const stalePush = classifyDealerGammaPillar(
        "SPY",
        {
          ...baseContext,
          generatedAt: "2026-11-22T17:30:00.000Z",
          stale: true,
        },
        NOW
      );
      expect(stalePush.stale).toBe(true);
      expect(stalePush.staleLimitSeconds).toBe(REGIME_GAMMA_PUSH_STALE_SECONDS);
      expect(stalePush.ageSeconds).toBe(1800);
      expect(stalePush.detail).toContain("rig push overdue");

      // Push fresh, but GEX file frozen > 96 hours -> reports 96h limit and upstream age
      const staleGex = classifyDealerGammaPillar(
        "SPY",
        {
          ...baseContext,
          gex: { ...baseGex, asOf: "2026-11-10T21:00:00.000Z" },
        },
        NOW
      );
      expect(staleGex.stale).toBe(true);
      expect(staleGex.staleLimitSeconds).toBe(REGIME_DAILY_STALE_SECONDS);
      expect(staleGex.ageSeconds).toBeGreaterThan(REGIME_DAILY_STALE_SECONDS);
    });

    it("guards row.status !== ok, maps dampened/amplified/neutral regime strings, and handles missing fields", () => {
      const makeCtx = (
        overrides: Partial<GexIndexRow>,
        gexOverrides: Partial<typeof baseGex> = {}
      ): MarketContextOutput => ({
        ...baseContext,
        gex: {
          ...baseGex,
          asOf: null,
          oiSession: null,
          ...gexOverrides,
          index: [{ ...spyRow, ...overrides }],
        },
      });

      expect(
        classifyDealerGammaPillar("SPY", null, NOW, "Feed offline")
      ).toMatchObject({
        detail: "Feed offline",
        source: "none",
        state: "missing",
      });
      expect(
        classifyDealerGammaPillar("SPY", { ...baseContext, gex: null }, NOW)
          .state
      ).toBe("missing");
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({ status: "not_reported" }),
          NOW
        ).state
      ).toBe("missing");

      expect(
        classifyDealerGammaPillar("SPY", makeCtx({ netGex: 0 }), NOW).state
      ).toBe("neutral");
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({ flip: 590, netGex: null, spot: 600, spotVsFlip: null }),
          NOW
        )
      ).toMatchObject({ spotVsFlip: "above", state: "positive" });
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({ flip: 590, netGex: null, spot: 580, spotVsFlip: null }),
          NOW
        )
      ).toMatchObject({ spotVsFlip: "below", state: "negative" });
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({ flip: 590, netGex: null, spot: 590, spotVsFlip: null }),
          NOW
        )
      ).toMatchObject({ spotVsFlip: "at", state: "neutral" });
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({
            flip: null,
            netGex: null,
            regime: "dampened",
            spot: null,
            spotVsFlip: null,
          }),
          NOW
        ).state
      ).toBe("positive");
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({
            flip: null,
            netGex: null,
            regime: "amplified",
            spot: null,
            spotVsFlip: null,
          }),
          NOW
        ).state
      ).toBe("negative");
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({
            flip: null,
            netGex: null,
            regime: "neutral",
            spot: null,
            spotVsFlip: null,
          }),
          NOW
        ).state
      ).toBe("neutral");
      expect(
        classifyDealerGammaPillar(
          "SPY",
          makeCtx({
            flip: null,
            netGex: null,
            regime: null,
            spot: null,
            spotVsFlip: null,
          }),
          NOW
        )
      ).toMatchObject({ stale: false, state: "missing" });
    });
  });

  describe("classifyCreditPillar (C146)", () => {
    const makePoints = (values: readonly number[], lastDate = "2026-11-20") =>
      values.map((value, index) => ({
        date:
          index === values.length - 1
            ? lastDate
            : `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        value,
      }));

    it("uses integer-bps rounding (4.35 - 4.00 = exact +35 bps) and classifies calm/widening/stressed", () => {
      const calm = classifyCreditPillar(
        {
          hyPoints: makePoints([
            ...Array.from({ length: 25 }, () => 3.1),
            3.05,
          ]),
          igPoints: [{ date: "2026-11-20", value: 0.9 }],
        },
        NOW
      );
      expect(calm).toMatchObject({
        hyOas: 3.05,
        hyOasBps: 305,
        hyOasChange20dBps: -5,
        igOas: 0.9,
        source: "openbb_macro:HY_OAS",
        stale: false,
        staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
        state: "calm",
      });

      // Exact +35 bps boundary with IEEE-754 tricky floats (3.35 - 3.00 = 0.34999999999999964)
      const exact35 = classifyCreditPillar(
        {
          hyPoints: makePoints([
            ...Array.from({ length: 20 }, () => 3.0),
            3.35,
          ]),
          igPoints: [],
        },
        NOW
      );
      expect(exact35.hyOasChange20dBps).toBe(35);
      expect(exact35.state).toBe("widening");

      const wideningByLevel = classifyCreditPillar(
        { hyPoints: [{ date: "2026-11-20", value: 4.1 }], igPoints: [] },
        NOW
      );
      expect(wideningByLevel.state).toBe("widening");
      expect(wideningByLevel.hyOasChange20dBps).toBeNull();

      const stressedByLevel = classifyCreditPillar(
        { hyPoints: [{ date: "2026-11-10", value: 5.25 }], igPoints: [] },
        NOW
      );
      expect(stressedByLevel.state).toBe("stressed");
      expect(stressedByLevel.stale).toBe(true);

      const stressedByJump = classifyCreditPillar(
        {
          hyPoints: makePoints([
            ...Array.from({ length: 20 }, () => 3.0),
            3.75,
          ]),
          igPoints: [],
        },
        NOW
      );
      expect(stressedByJump.hyOasChange20dBps).toBe(75);
      expect(stressedByJump.state).toBe("stressed");
    });

    it("matches fallback strictly on HY_OAS/BAMLH0A0HYM2 (never IG_OAS), normalizes bps units, and propagates context staleness", () => {
      const igSeries: MacroSeries = {
        change1d: 0.01,
        change1m: 0.05,
        change1w: 0.02,
        change1y: 0.1,
        date: "2026-11-20",
        group: "credit",
        id: "IG_OAS",
        label: "US IG OAS",
        pct1y: 30,
        source: "FRED",
        sourceUrl: null,
        stale: false,
        status: "ok",
        units: "%",
        value: 1.0,
      };
      expect(findCreditFallbackSeries(undefined)).toBeNull();
      expect(findCreditFallbackSeries([igSeries])).toBeNull();

      const bpsFallback: MacroSeries = {
        ...igSeries,
        change1m: 40,
        id: "BAMLH0A0HYM2",
        label: "US HY OAS",
        pct1y: 62.5,
        units: "bps",
        value: 370,
      };
      expect(findCreditFallbackSeries([igSeries, bpsFallback])?.id).toBe(
        "BAMLH0A0HYM2"
      );

      const fallback = classifyCreditPillar(
        {
          fallbackContextStale: true,
          fallbackSeries: bpsFallback,
          hyPoints: [],
          igPoints: [],
        },
        NOW
      );
      expect(fallback).toMatchObject({
        hyOas: 3.7,
        hyOasBps: 370,
        hyOasChange20dBps: 40,
        hyOasPct1y: 62.5,
        source: "market_context_macro:BAMLH0A0HYM2",
        stale: true,
        state: "widening",
      });

      const fallbackPctNulls = classifyCreditPillar(
        {
          fallbackSeries: {
            ...bpsFallback,
            change1m: null,
            id: "HY_OAS",
            pct1y: null,
            units: "%",
            value: 3.1,
          },
          hyPoints: [],
          igPoints: [],
        },
        NOW
      );
      expect(fallbackPctNulls.state).toBe("calm");
      expect(fallbackPctNulls.stale).toBe(false);

      const missing = classifyCreditPillar(
        {
          fallbackSeries: { ...bpsFallback, status: "error" },
          hyPoints: [],
          igPoints: [{ date: "2026-11-20", value: 1.0 }],
        },
        NOW,
        "Macro read failed"
      );
      expect(missing).toMatchObject({
        detail: "Macro read failed",
        igOas: 1,
        source: "none",
        stale: false,
        state: "missing",
      });
    });
  });

  describe("classifyVolatilityPillar (C033, C230)", () => {
    it("classifies VIX/VIX3M term structure bands", () => {
      expect(classifyVolTermStructure(null)).toBe("missing");
      expect(classifyVolTermStructure(0.9)).toBe("contango");
      expect(classifyVolTermStructure(0.95)).toBe("flat");
      expect(classifyVolTermStructure(1.0)).toBe("flat");
      expect(classifyVolTermStructure(1.01)).toBe("backwardation");
    });

    it("strictly validates liveVixAsOf, checks each contributing vol series for staleness, and sets scope=market_wide", () => {
      const liveCalm = classifyVolatilityPillar(
        {
          atmIv30d: 0.165,
          etfVolClose: 18.2,
          etfVolDate: "2026-11-20",
          ivPercentile: 35.4,
          liveVixAsOf: "2026-11-22T17:58:00.000Z",
          liveVixStale: false,
          liveVixValue: 15.2,
          openbbVix3mDate: "2026-11-20",
          openbbVixClose: 16.0,
          openbbVixDate: "2026-11-20",
          symbol: "QQQ",
          vix3mVix6m: 0.96,
          vix9dVix: 0.92,
          vixVix3m: 0.88,
        },
        NOW
      );
      expect(liveCalm).toMatchObject({
        etfVolIndex: 18.2,
        etfVolIndexId: "VXN",
        scope: "market_wide",
        source: "ibkr_monitor_volatility+openbb_vol_context",
        stale: false,
        state: "calm",
        termStructure: "contango",
        vix: 15.2,
      });

      // Unparseable liveVixAsOf is ignored; falls back to openbb VIX
      const badLiveAsOf = classifyVolatilityPillar(
        {
          atmIv30d: null,
          etfVolClose: null,
          etfVolDate: null,
          ivPercentile: null,
          liveVixAsOf: "yesterday",
          liveVixStale: false,
          liveVixValue: 25,
          openbbVixClose: 18.5,
          openbbVixDate: "2026-11-20",
          symbol: "IWM",
          vix3mVix6m: null,
          vix9dVix: null,
          vixVix3m: 1.05,
        },
        NOW
      );
      expect(badLiveAsOf).toMatchObject({
        source: "openbb_vol_context",
        stale: false,
        state: "elevated",
        termStructure: "backwardation",
        vix: 18.5,
      });

      // Stale VIX3M flags pillar stale even if live VIX is fresh
      const staleTerm = classifyVolatilityPillar(
        {
          atmIv30d: null,
          etfVolClose: null,
          etfVolDate: null,
          ivPercentile: null,
          liveVixAsOf: "2026-11-22T17:58:00.000Z",
          liveVixStale: false,
          liveVixValue: 16,
          openbbVix3mDate: "2026-11-10",
          openbbVixClose: 16,
          openbbVixDate: "2026-11-20",
          symbol: "SPY",
          vix3mVix6m: null,
          vix9dVix: null,
          vixVix3m: 0.9,
        },
        NOW
      );
      expect(staleTerm.stale).toBe(true);

      // VIX >= 30 => extreme (C033)
      const extreme = classifyVolatilityPillar(
        {
          atmIv30d: null,
          etfVolClose: null,
          etfVolDate: null,
          ivPercentile: null,
          liveVixAsOf: "2026-11-22T17:58:00.000Z",
          liveVixStale: true,
          liveVixValue: 32.5,
          openbbVixClose: null,
          openbbVixDate: null,
          symbol: "SPY",
          vix3mVix6m: null,
          vix9dVix: null,
          vixVix3m: null,
        },
        NOW
      );
      expect(extreme).toMatchObject({
        source: "ibkr_monitor_volatility",
        stale: true,
        state: "extreme",
      });

      // Stale fallback live VIX combined with OpenBB ratio/ETF vol reports combined provenance
      const fallbackLivePlusOpenbb = classifyVolatilityPillar(
        {
          atmIv30d: null,
          etfVolClose: 21.4,
          etfVolDate: "2026-11-20",
          ivPercentile: null,
          liveVixAsOf: "2026-11-22T17:58:00.000Z",
          liveVixStale: true,
          liveVixValue: 22.1,
          openbbVix3mDate: "2026-11-20",
          openbbVixClose: null,
          openbbVixDate: null,
          symbol: "QQQ",
          vix3mVix6m: null,
          vix9dVix: null,
          vixVix3m: 0.94,
        },
        NOW
      );
      expect(fallbackLivePlusOpenbb).toMatchObject({
        source: "ibkr_monitor_volatility+openbb_vol_context",
        stale: true,
        state: "elevated",
        vix: 22.1,
      });

      // Unavailable VIX
      const missing = classifyVolatilityPillar(
        {
          atmIv30d: 0.2,
          etfVolClose: 22,
          etfVolDate: "2026-11-20",
          ivPercentile: 50,
          liveVixAsOf: "bad-date",
          liveVixStale: false,
          liveVixValue: 20,
          openbbVixClose: null,
          openbbVixDate: null,
          symbol: "DIA",
          vix3mVix6m: 0.99,
          vix9dVix: 0.98,
          vixVix3m: 0.97,
        },
        NOW,
        "Vol feeds down"
      );
      expect(missing).toMatchObject({
        detail: "Vol feeds down",
        scope: "market_wide",
        stale: false,
        state: "missing",
      });

      const fullyEmpty = classifyVolatilityPillar(
        {
          atmIv30d: null,
          etfVolClose: null,
          etfVolDate: null,
          ivPercentile: null,
          liveVixAsOf: null,
          liveVixStale: false,
          liveVixValue: null,
          openbbVixClose: null,
          openbbVixDate: null,
          symbol: "DIA",
          vix3mVix6m: null,
          vix9dVix: null,
          vixVix3m: null,
        },
        NOW
      );
      expect(fullyEmpty.source).toBe("none");
    });
  });

  describe("buildRegimeEtfRow & summarizeOverallRegime (C806, C878)", () => {
    const freshUpTrend = classifyTrendPillar(
      {
        asOf: "2026-11-20",
        closes: seriesCloses(220, 400, 0.5, 560),
        source: "market_daily_series",
        symbol: "SPY",
      },
      NOW
    );
    const staleUpTrend = classifyTrendPillar(
      {
        asOf: "2026-11-10",
        closes: seriesCloses(220, 400, 0.5, 560),
        source: "market_daily_series",
        symbol: "IWM",
      },
      NOW
    );
    const mixedTrendCloses = seriesCloses(220, 400, 0.5);
    mixedTrendCloses[mixedTrendCloses.length - 1] = 480;
    const mixedTrend = classifyTrendPillar(
      {
        asOf: "2026-11-20",
        closes: mixedTrendCloses,
        source: "market_daily_series",
        symbol: "DIA",
      },
      NOW
    );
    const freshDownTrend = classifyTrendPillar(
      {
        asOf: "2026-11-20",
        closes: seriesCloses(220, 600, -0.5, 420),
        source: "market_daily_series",
        symbol: "QQQ",
      },
      NOW
    );
    const unavailableTrend = classifyTrendPillar(
      { asOf: null, closes: [], source: "none", symbol: "IWM" },
      NOW
    );
    const idleBreadth = classifyBreadth90Pillar(
      {
        days: [],
        events: [],
        status: {
          armedOn: null,
          asOf: "2026-11-20T21:15:00.000Z",
          basket: null,
          sessionsLeft: null,
          state: "IDLE",
          strict: false,
        },
        thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
      },
      NOW
    );
    const armedBreadth = classifyBreadth90Pillar(
      {
        days: [],
        events: [],
        status: {
          armedOn: "2026-11-20",
          asOf: "2026-11-20T21:15:00.000Z",
          basket: null,
          sessionsLeft: 29,
          state: "ARMED",
          strict: true,
        },
        thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
      },
      NOW
    );
    const formingBreadth = classifyBreadth90Pillar(
      {
        days: [],
        events: [],
        status: {
          armedOn: "2026-11-19",
          asOf: "2026-11-20T21:15:00.000Z",
          basket: null,
          sessionsLeft: 28,
          state: "FORMING",
          strict: false,
        },
        thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
      },
      NOW
    );
    const firedBreadth = classifyBreadth90Pillar(
      {
        days: [],
        events: [],
        status: {
          armedOn: "2026-11-18",
          asOf: "2026-11-20T21:15:00.000Z",
          basket: null,
          sessionsLeft: 27,
          state: "FIRED",
          strict: false,
        },
        thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
      },
      NOW
    );
    const notCoveredGamma = classifyDealerGammaPillar("IWM", null, NOW);
    const negativeGamma = classifyDealerGammaPillar(
      "QQQ",
      {
        generatedAt: "2026-11-22T17:55:00.000Z",
        gex: {
          asOf: "2026-11-20T21:00:00.000Z",
          index: [
            {
              callWall: 520,
              fadeNote: null,
              flip: 505,
              netChex: null,
              netDex: null,
              netGex: -500_000,
              netVex: null,
              notes: [],
              putWall: 490,
              regime: "amplified",
              spot: 500,
              spotVsFlip: "below",
              status: "ok",
              symbol: "QQQ",
              zeroDte: null,
            },
          ],
          label: null,
          oiSession: "2026-11-20",
        },
        macro: null,
        missing: [],
        news: null,
        sections: { gex: null, macro: null, news: null },
        stale: false,
      },
      NOW
    );
    const calmCredit = classifyCreditPillar(
      { hyPoints: [{ date: "2026-11-20", value: 3.1 }], igPoints: [] },
      NOW
    );
    const stressedCredit = classifyCreditPillar(
      { hyPoints: [{ date: "2026-11-20", value: 5.5 }], igPoints: [] },
      NOW
    );
    const calmVol = classifyVolatilityPillar(
      {
        atmIv30d: null,
        etfVolClose: null,
        etfVolDate: null,
        ivPercentile: null,
        liveVixAsOf: null,
        liveVixStale: false,
        liveVixValue: null,
        openbbVixClose: 14.5,
        openbbVixDate: "2026-11-20",
        symbol: "SPY",
        vix3mVix6m: null,
        vix9dVix: null,
        vixVix3m: 0.88,
      },
      NOW
    );
    const extremeVol = classifyVolatilityPillar(
      {
        atmIv30d: null,
        etfVolClose: null,
        etfVolDate: null,
        ivPercentile: null,
        liveVixAsOf: null,
        liveVixStale: false,
        liveVixValue: null,
        openbbVixClose: 34,
        openbbVixDate: "2026-11-20",
        symbol: "QQQ",
        vix3mVix6m: null,
        vix9dVix: null,
        vixVix3m: 1.12,
      },
      NOW
    );

    it("excludes not_covered gamma from missingCount, blocks risk_on on stale inputs, and explains mixed drivers", () => {
      const riskOn = buildRegimeEtfRow("IWM", {
        breadth90: idleBreadth,
        credit: calmCredit,
        dealerGamma: notCoveredGamma,
        trend: freshUpTrend,
        volatility: calmVol,
      });
      expect(riskOn.summary).toBe("risk_on");
      expect(riskOn.missingCount).toBe(0);
      expect(riskOn.mixedDrivers).toEqual([]);

      // Stale trend blocks risk_on and names the stale pillar
      const staleDowngrade = buildRegimeEtfRow("IWM", {
        breadth90: idleBreadth,
        credit: calmCredit,
        dealerGamma: notCoveredGamma,
        trend: staleUpTrend,
        volatility: calmVol,
      });
      expect(staleDowngrade.summary).toBe("mixed");
      expect(staleDowngrade.hasStaleInputs).toBe(true);
      expect(staleDowngrade.mixedDrivers).toContain("Trend input is stale");
      expect(staleDowngrade.mixedDrivers).toContain(
        "Trend is uptrend but stale inputs block risk-on"
      );

      // Negative gamma blocks risk_on and explains amplifier
      const negGammaMixed = buildRegimeEtfRow("QQQ", {
        breadth90: formingBreadth,
        credit: calmCredit,
        dealerGamma: negativeGamma,
        trend: mixedTrend,
        volatility: calmVol,
      });
      expect(negGammaMixed.summary).toBe("mixed");
      expect(negGammaMixed.mixedDrivers).toContain(
        "Trend is mixed (between SMA50 and SMA200)"
      );
      expect(negGammaMixed.mixedDrivers).toContain(
        "Dealer gamma is negative (amplified moves)"
      );
      expect(negGammaMixed.mixedDrivers).toContain(
        "Breadth-90 is forming (unfinished intraday thrust while armed)"
      );

      const riskOff = buildRegimeEtfRow("QQQ", {
        breadth90: armedBreadth,
        credit: stressedCredit,
        dealerGamma: notCoveredGamma,
        trend: freshDownTrend,
        volatility: extremeVol,
      });
      expect(riskOff.summary).toBe("risk_off");
      // Acute cross-asset stress (extreme vol + stressed credit) triggers risk_off even before SMA lags
      const acuteRiskOff = buildRegimeEtfRow("SPY", {
        breadth90: idleBreadth,
        credit: stressedCredit,
        dealerGamma: notCoveredGamma,
        trend: freshUpTrend,
        volatility: extremeVol,
      });
      expect(acuteRiskOff.summary).toBe("risk_off");

      const mixedUp = buildRegimeEtfRow("SPY", {
        breadth90: armedBreadth,
        credit: calmCredit,
        dealerGamma: notCoveredGamma,
        trend: freshUpTrend,
        volatility: calmVol,
      });
      expect(mixedUp.summary).toBe("mixed");
      expect(mixedUp.mixedDrivers).toContain(
        "Trend is uptrend while stress lights are active"
      );

      const mixedDown = buildRegimeEtfRow("QQQ", {
        breadth90: firedBreadth,
        credit: calmCredit,
        dealerGamma: notCoveredGamma,
        trend: freshDownTrend,
        volatility: calmVol,
      });
      expect(mixedDown.summary).toBe("mixed");
      expect(mixedDown.mixedDrivers).toContain("Breadth-90 thrust fired");

      // Uptrend + calm fresh pillars + 1 missing pillar -> mixed citing missing input, never active stress
      const missingCreditMixed = buildRegimeEtfRow("IWM", {
        breadth90: idleBreadth,
        credit: classifyCreditPillar({ hyPoints: [], igPoints: [] }, NOW),
        dealerGamma: notCoveredGamma,
        trend: freshUpTrend,
        volatility: calmVol,
      });
      expect(missingCreditMixed.summary).toBe("mixed");
      expect(missingCreditMixed.missingCount).toBe(1);
      expect(missingCreditMixed.mixedDrivers).toContain(
        "Trend is uptrend but missing inputs block risk-on"
      );
      expect(missingCreditMixed.mixedDrivers).toContain(
        "Credit input is missing"
      );
      expect(missingCreditMixed.mixedDrivers).not.toContain(
        "Trend is uptrend while stress lights are active"
      );

      // Missing trend with 3 calm fresh pillars -> mixed explaining missing trend
      const missingTrendMixed = buildRegimeEtfRow("IWM", {
        breadth90: idleBreadth,
        credit: calmCredit,
        dealerGamma: notCoveredGamma,
        trend: unavailableTrend,
        volatility: calmVol,
      });
      expect(missingTrendMixed.summary).toBe("mixed");
      expect(missingTrendMixed.mixedDrivers).toEqual([
        "Trend input is missing",
      ]);

      const incomplete = buildRegimeEtfRow("IWM", {
        breadth90: classifyBreadth90Pillar(null, NOW),
        credit: classifyCreditPillar({ hyPoints: [], igPoints: [] }, NOW),
        dealerGamma: notCoveredGamma,
        trend: unavailableTrend,
        volatility: calmVol,
      });
      expect(incomplete.summary).toBe("incomplete");

      expect(
        summarizeOverallRegime(
          REGIME_INDEX_SYMBOLS.map((s) => ({ ...riskOn, symbol: s }))
        ).summary
      ).toBe("risk_on");
      expect(
        summarizeOverallRegime(
          REGIME_INDEX_SYMBOLS.map((s) => ({ ...riskOff, symbol: s }))
        ).summary
      ).toBe("risk_off");
      expect(
        summarizeOverallRegime(
          REGIME_INDEX_SYMBOLS.map((s) => ({ ...incomplete, symbol: s }))
        ).summary
      ).toBe("incomplete");

      const mixedOverall = summarizeOverallRegime([
        { ...riskOn, symbol: "QQQ" },
        { ...riskOff, symbol: "SPY" },
        { ...staleDowngrade, symbol: "IWM" },
        { ...riskOn, symbol: "DIA" },
      ]);
      expect(mixedOverall).toMatchObject({
        staleEtfs: ["IWM"],
        stalePillarCount: 1,
        summary: "mixed",
      });

      const parsed = MarketRegimeOutputSchema.parse({
        etfs: [
          { ...riskOn, symbol: "QQQ" },
          { ...riskOff, symbol: "SPY" },
          { ...staleDowngrade, symbol: "IWM" },
          { ...riskOn, symbol: "DIA" },
        ],
        generatedAt: NOW.toISOString(),
        overall: mixedOverall,
        researchOnlyNote: REGIME_RESEARCH_ONLY_NOTE,
      });
      expect(parsed.etfs).toHaveLength(4);
    });
  });
});
