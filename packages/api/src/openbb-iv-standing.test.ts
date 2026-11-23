import type { MarketDailyColumns } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import {
  OPENBB_CORE7,
  OPENBB_IV_PERCENTILE_MIN_SESSIONS,
  OPENBB_IV_PERCENTILE_SESSIONS,
  OPENBB_VOL_INDEX_PROXY,
  OpenbbIvOneYearSchema,
} from "./contracts/openbb.ts";
import {
  openbbEvaluateOwnIvBasis,
  openbbEvaluateProxyIvBasis,
  openbbIvOneYear,
} from "./openbb-iv-standing.ts";
import { STRATEGY_IV_INDEX } from "./strategy-dsl.ts";

const makeDates = (count: number, startDay = 1): string[] =>
  Array.from({ length: count }, (_, index) => {
    const ms = Date.UTC(2025, 0, startDay + index);
    return new Date(ms).toISOString().slice(0, 10);
  });

const makeColumns = (
  dates: readonly string[],
  closes: readonly number[]
): MarketDailyColumns => ({
  adjClose: dates.map(() => null),
  close: [...closes],
  dates: [...dates],
  high: dates.map(() => null),
  low: dates.map(() => null),
  open: dates.map(() => null),
});

describe("openbbIvOneYear and per-basis 1-year IV evaluators", () => {
  it("matches a hand-computed 252-session fixture for IV percentile and IV rank", () => {
    // 252 sessions:
    // - 100 values at 12 (strictly below 22)
    // -  50 values at 15 (strictly below 22)
    // -  50 values at 22 (tied with latest; not strictly below)
    // -  51 values at 32 (strictly above 22)
    // -   1 latest value at 22
    // Expected:
    //   below = 150 out of 251 prior values -> ivPercentile = (100 * 150) / 251
    //   min = 12, max = 32, latest = 22     -> ivRank = (100 * (22 - 12)) / (32 - 12) = 50
    const closes = [
      ...new Array<number>(100).fill(12),
      ...new Array<number>(50).fill(15),
      ...new Array<number>(50).fill(22),
      ...new Array<number>(51).fill(32),
      22,
    ];
    expect(closes).toHaveLength(252);
    const dates = makeDates(252);
    const proxy = openbbEvaluateProxyIvBasis("VXN", makeColumns(dates, closes));
    expect(proxy).toEqual({
      asOf: dates.at(-1),
      index: "VXN",
      ivPercentile: (100 * 150) / 251,
      ivRank: 50,
      latestValue: 22,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: null,
      sessions: 252,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    });
  });

  it("handles 1-year high (100/100), 1-year low (0/0), and trims observations older than 252 sessions", () => {
    // An ancient extreme (99) 300 sessions ago must be excluded from the trailing 252-session window.
    const dates = makeDates(260);
    const highSeries = [
      99,
      ...new Array<number>(7).fill(50),
      ...Array.from({ length: 252 }, (_, index) => 10 + index * 0.1),
    ];
    const high = openbbEvaluateProxyIvBasis(
      "VIX",
      makeColumns(dates, highSeries)
    );
    expect(high.ivPercentile).toBe(100);
    expect(high.ivRank).toBe(100);
    expect(high.sessions).toBe(252);
    expect(high.asOf).toBe(dates.at(-1));

    const lowSeries = [
      1,
      ...new Array<number>(7).fill(5),
      ...Array.from({ length: 252 }, (_, index) => 40 - index * 0.1),
    ];
    const low = openbbEvaluateProxyIvBasis(
      "VIX",
      makeColumns(dates, lowSeries)
    );
    expect(low.ivPercentile).toBe(0);
    expect(low.ivRank).toBe(0);
    expect(low.sessions).toBe(252);
  });

  it("keeps ivRank within [0, 100] under IEEE 754 float64 rounding and matches STRATEGY_IV_INDEX", () => {
    // (100 * (0.13384 - 0.1038)) / (0.13384 - 0.1038) rounds to 100.00000000000001 in float64.
    const dates = makeDates(252);
    const rows = dates.map((asOf, index) => ({
      asOf,
      atmIv30d: index === 0 ? 0.1038 : index === 251 ? 0.133_84 : 0.12,
    }));
    const result = openbbEvaluateOwnIvBasis(rows);
    expect(result.ivRank).toBe(100);
    expect(result.ivPercentile).toBe(100);

    for (const symbol of OPENBB_CORE7) {
      expect(OPENBB_VOL_INDEX_PROXY[symbol]).toBe(STRATEGY_IV_INDEX[symbol]);
    }
  });

  it("returns no percentile or rank with a clear reason when a basis has fewer sessions than the minimum", () => {
    expect(openbbEvaluateOwnIvBasis([])).toEqual({
      asOf: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: 252,
      reason: "No ATM IV sessions stored",
      sessions: 0,
      windowSessions: 252,
    });

    const nineRows = makeDates(9).map((asOf, index) => ({
      asOf,
      atmIv30d: 0.2 + index * 0.01,
    }));
    expect(openbbEvaluateOwnIvBasis(nineRows)).toEqual({
      asOf: nineRows.at(-1)?.asOf ?? null,
      ivPercentile: null,
      ivRank: null,
      latestValue: 0.28,
      minSessions: 252,
      reason: "Needs 252 sessions with ATM IV (9 stored)",
      sessions: 9,
      windowSessions: 252,
    });

    const almostFull = makeDates(251).map((asOf) => ({
      asOf,
      atmIv30d: 0.25,
    }));
    expect(openbbEvaluateOwnIvBasis(almostFull).ivPercentile).toBeNull();
    expect(openbbEvaluateOwnIvBasis(almostFull).reason).toBe(
      "Needs 252 sessions with ATM IV (251 stored)"
    );

    const withGap = makeDates(252).map((asOf, index) => ({
      asOf,
      atmIv30d: index === 10 ? null : 0.25,
    }));
    expect(openbbEvaluateOwnIvBasis(withGap)).toMatchObject({
      ivPercentile: null,
      ivRank: null,
      reason: "Needs 252 sessions with ATM IV (251 of 252 stored have IV)",
      sessions: 251,
    });

    const nullLatest = makeDates(252).map((asOf, index) => ({
      asOf,
      atmIv30d: index === 251 ? null : 0.25,
    }));
    expect(openbbEvaluateOwnIvBasis(nullLatest)).toMatchObject({
      asOf: nullLatest.at(-1)?.asOf ?? null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      reason: "No ATM IV in the latest session",
      sessions: 251,
    });

    expect(openbbEvaluateProxyIvBasis("RVX", undefined)).toEqual({
      asOf: null,
      index: "RVX",
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: 252,
      reason: "No RVX sessions stored",
      sessions: 0,
      windowSessions: 252,
    });

    expect(
      openbbEvaluateProxyIvBasis("VXD", makeColumns([], []))
    ).toMatchObject({
      asOf: null,
      ivPercentile: null,
      ivRank: null,
      reason: "No VXD sessions stored",
      sessions: 0,
    });

    const shortProxyDates = makeDates(100);
    const shortProxy = openbbEvaluateProxyIvBasis(
      "VXN",
      makeColumns(shortProxyDates, new Array<number>(100).fill(20))
    );
    expect(shortProxy).toEqual({
      asOf: shortProxyDates.at(-1),
      index: "VXN",
      ivPercentile: null,
      ivRank: null,
      latestValue: 20,
      minSessions: 252,
      reason: "Needs 252 sessions of VXN (100 in 420d window)",
      sessions: 100,
      windowSessions: 252,
    });
  });

  it("reports ivPercentile 0 and ivRank null with a reason on a flat 252-session range", () => {
    const dates = makeDates(252);
    const flat = openbbEvaluateProxyIvBasis(
      "VIX",
      makeColumns(dates, new Array<number>(252).fill(18))
    );
    expect(flat).toEqual({
      asOf: dates.at(-1),
      index: "VIX",
      ivPercentile: 0,
      ivRank: null,
      latestValue: 18,
      minSessions: 252,
      reason: "Flat 1-year range (min equals max); IV rank not computable",
      sessions: 252,
      windowSessions: 252,
    });
  });

  it("selects vol_index_proxy below 252 own sessions, switches to own_atm_iv at 252, and combines reasons when neither qualifies", () => {
    const dates252 = makeDates(252);
    const rampOwn = dates252.map((asOf, index) => ({
      asOf,
      atmIv30d: 0.1 + index * 0.001,
      underlying: "SPY",
    }));
    const nineQqq = makeDates(9).map((asOf, index) => ({
      asOf,
      atmIv30d: 0.24 + index * 0.01,
      underlying: "QQQ",
    }));
    const series = new Map<string, MarketDailyColumns>([
      [
        "VIX",
        makeColumns(
          dates252,
          Array.from({ length: 252 }, (_, index) => 30 - index * 0.05)
        ),
      ],
      [
        "VXN",
        makeColumns(
          dates252,
          Array.from({ length: 252 }, (_, index) => 15 + index * 0.05)
        ),
      ],
      [
        "RVX",
        makeColumns(
          dates252,
          Array.from({ length: 252 }, (_, index) => 18 + index * 0.04)
        ),
      ],
      [
        "VXD",
        makeColumns(
          dates252,
          Array.from({ length: 252 }, (_, index) => 12 + index * 0.03)
        ),
      ],
      ["GVZ", makeColumns(makeDates(50), new Array<number>(50).fill(16))],
    ]);

    const standing = openbbIvOneYear(
      OPENBB_CORE7,
      [...rampOwn, ...nineQqq],
      series
    );
    expect(standing).toHaveLength(OPENBB_CORE7.length);
    for (const item of standing) {
      expect(() => OpenbbIvOneYearSchema.parse(item)).not.toThrow();
    }

    const byUnderlying = new Map(
      standing.map((item) => [item.underlying, item])
    );

    // SPY: own reached 252 sessions -> selects own_atm_iv (while keeping VIX proxy visible).
    const spy = byUnderlying.get("SPY");
    expect(spy).toMatchObject({
      asOf: dates252.at(-1),
      basis: "own_atm_iv",
      ivPercentile: 100,
      ivRank: 100,
      proxyIndex: null,
      reason: null,
      sessions: 252,
      unit: "decimal",
      windowSessions: 252,
    });
    expect(spy?.proxy).toMatchObject({
      index: "VIX",
      ivPercentile: 0,
      ivRank: 0,
      sessions: 252,
    });

    // QQQ: own has 9 sessions -> falls back to VXN proxy, while own carries its reason.
    const qqq = byUnderlying.get("QQQ");
    expect(qqq).toMatchObject({
      asOf: dates252.at(-1),
      basis: "vol_index_proxy",
      ivPercentile: 100,
      ivRank: 100,
      proxyIndex: "VXN",
      reason: null,
      sessions: 252,
      unit: "vol_points",
      windowSessions: 252,
    });
    expect(qqq?.own).toMatchObject({
      ivPercentile: null,
      ivRank: null,
      reason: "Needs 252 sessions with ATM IV (9 stored)",
      sessions: 9,
    });

    // IWM and DIA: no own rows -> fall back cleanly to RVX and VXD.
    expect(byUnderlying.get("IWM")).toMatchObject({
      basis: "vol_index_proxy",
      ivPercentile: 100,
      ivRank: 100,
      proxyIndex: OPENBB_VOL_INDEX_PROXY.IWM,
      sessions: 252,
    });
    expect(byUnderlying.get("DIA")).toMatchObject({
      basis: "vol_index_proxy",
      ivPercentile: 100,
      ivRank: 100,
      proxyIndex: OPENBB_VOL_INDEX_PROXY.DIA,
      sessions: 252,
    });

    // GLD: own has 0 rows, GVZ has only 50 sessions -> basis is null with combined reason.
    expect(byUnderlying.get("GLD")).toMatchObject({
      asOf: null,
      basis: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      proxyIndex: null,
      reason:
        "Own ATM IV: No ATM IV sessions stored; GVZ proxy: Needs 252 sessions of GVZ (50 in 420d window)",
      sessions: 0,
      unit: null,
      windowSessions: 252,
    });
  });
});
