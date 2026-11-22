import type {
  MarketDailyColumns,
  OpenbbOptionIvDailyRow,
} from "@darkfactory/db/server";

import {
  type OPENBB_CORE7,
  OPENBB_IV_PERCENTILE_MIN_SESSIONS,
  OPENBB_IV_PERCENTILE_SESSIONS,
  type OPENBB_VOL_INDEX_IDS,
  OPENBB_VOL_INDEX_PROXY,
  type OpenbbIvBasisResult,
  type OpenbbIvOneYear,
  type OpenbbIvProxyBasisResult,
} from "./contracts/openbb.ts";

// 1-year (252-session) IV percentile and IV rank for Core 7 ETFs
// (docs/vertex-rebuild/designs/iv-percentile/plan.md). Evaluates each ETF's own
// openbb_option_iv_daily.atm_iv_30d history (decimal) and its Cboe volatility-index proxy in
// market_daily_series (vol points) independently—never mixing the two series—and requires the full
// 252-session minimum before reporting either metric. Research input only; no orders.

type OpenbbCore7Symbol = (typeof OPENBB_CORE7)[number];
type OpenbbVolIndexId = (typeof OPENBB_VOL_INDEX_IDS)[number];

type WindowStats = Readonly<{
  ivPercentile: number;
  ivRank: number | null;
  reason: string | null;
}>;

const FLAT_RANGE_REASON =
  "Flat 1-year range (min equals max); IV rank not computable";
const computeWindowStats = (values: readonly number[]): WindowStats => {
  const latest = values.at(-1) as number;
  let below = 0;
  let min = latest;
  let max = latest;
  for (const value of values) {
    if (value < latest) below += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const ivPercentile = (100 * below) / (values.length - 1);
  const span = max - min;
  if (span === 0) {
    return { ivPercentile, ivRank: null, reason: FLAT_RANGE_REASON };
  }
  return {
    ivPercentile,
    // Divide before multiplying and clamp so IEEE 754 rounding never exceeds [0, 100].
    ivRank: Math.min(100, Math.max(0, ((latest - min) / span) * 100)),
    reason: null,
  };
};
/**
 * Evaluates an ETF's own trailing 252-session ATM IV (`atm_iv_30d`, decimal) basis.
 * Returns null percentile and rank with an explicit reason when fewer than 252 valid sessions
 * exist in the trailing window or when the latest session lacks an ATM IV reading.
 */
export const openbbEvaluateOwnIvBasis = (
  rows: readonly Pick<OpenbbOptionIvDailyRow, "asOf" | "atmIv30d">[]
): OpenbbIvBasisResult => {
  const window = rows.slice(-OPENBB_IV_PERCENTILE_SESSIONS);
  const latest = window.at(-1);
  if (latest === undefined) {
    return {
      asOf: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: "No ATM IV sessions stored",
      sessions: 0,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  const values = window.flatMap((row) =>
    row.atmIv30d === null ? [] : [row.atmIv30d]
  );
  if (latest.atmIv30d === null) {
    return {
      asOf: latest.asOf,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: "No ATM IV in the latest session",
      sessions: values.length,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  if (values.length < OPENBB_IV_PERCENTILE_MIN_SESSIONS) {
    const detail =
      values.length === window.length
        ? `${values.length} stored`
        : `${values.length} of ${window.length} stored have IV`;
    return {
      asOf: latest.asOf,
      ivPercentile: null,
      ivRank: null,
      latestValue: latest.atmIv30d,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: `Needs ${OPENBB_IV_PERCENTILE_MIN_SESSIONS} sessions with ATM IV (${detail})`,
      sessions: values.length,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  const stats = computeWindowStats(values);
  return {
    asOf: latest.asOf,
    ...stats,
    latestValue: latest.atmIv30d,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    sessions: values.length,
    windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
  };
};

/**
 * Evaluates a Cboe volatility-index proxy (`VIX`, `VXN`, `RVX`, `VXD`, `GVZ`, `VXSLV`, `OVX`)
 * over its newest up to 252 trading sessions in `market_daily_series` (vol points).
 */
export const openbbEvaluateProxyIvBasis = (
  index: OpenbbVolIndexId,
  columns: MarketDailyColumns | undefined
): OpenbbIvProxyBasisResult => {
  if (columns === undefined || columns.dates.length === 0) {
    return {
      asOf: null,
      index,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: `No ${index} sessions stored`,
      sessions: 0,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  const start = Math.max(
    0,
    columns.close.length - OPENBB_IV_PERCENTILE_SESSIONS
  );
  const values = columns.close.slice(start);
  const asOf = columns.dates.at(-1) as string;
  const latestValue = values.at(-1) as number;
  if (values.length < OPENBB_IV_PERCENTILE_MIN_SESSIONS) {
    return {
      asOf,
      index,
      ivPercentile: null,
      ivRank: null,
      latestValue,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      reason: `Needs ${OPENBB_IV_PERCENTILE_MIN_SESSIONS} sessions of ${index} (${values.length} in 420d window)`,
      sessions: values.length,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  const stats = computeWindowStats(values);
  return {
    asOf,
    index,
    ...stats,
    latestValue,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    sessions: values.length,
    windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
  };
};

/**
 * Builds the labelled 1-year IV percentile and IV rank entry for each requested Core 7 ETF.
 * Prefers `own_atm_iv` once own history reaches 252 valid sessions, falls back to the mapped Cboe
 * `vol_index_proxy` until then, and returns `basis: null` with combined reasons when neither meets
 * the 252-session minimum.
 */
export const openbbIvOneYear = (
  underlyings: readonly OpenbbCore7Symbol[],
  ivRows: readonly Pick<
    OpenbbOptionIvDailyRow,
    "asOf" | "atmIv30d" | "underlying"
  >[],
  series: ReadonlyMap<string, MarketDailyColumns>
): OpenbbIvOneYear[] =>
  underlyings.map((underlying) => {
    const own = openbbEvaluateOwnIvBasis(
      ivRows.filter((row) => row.underlying === underlying)
    );
    const proxyIndex = OPENBB_VOL_INDEX_PROXY[underlying];
    const proxy = openbbEvaluateProxyIvBasis(
      proxyIndex,
      series.get(proxyIndex)
    );
    if (own.ivPercentile !== null) {
      return {
        asOf: own.asOf,
        basis: "own_atm_iv",
        ivPercentile: own.ivPercentile,
        ivRank: own.ivRank,
        latestValue: own.latestValue,
        minSessions: own.minSessions,
        own,
        proxy,
        proxyIndex: null,
        reason: own.reason,
        sessions: own.sessions,
        underlying,
        unit: "decimal",
        windowSessions: own.windowSessions,
      };
    }
    if (proxy.ivPercentile !== null) {
      return {
        asOf: proxy.asOf,
        basis: "vol_index_proxy",
        ivPercentile: proxy.ivPercentile,
        ivRank: proxy.ivRank,
        latestValue: proxy.latestValue,
        minSessions: proxy.minSessions,
        own,
        proxy,
        proxyIndex,
        reason: proxy.reason,
        sessions: proxy.sessions,
        underlying,
        unit: "vol_points",
        windowSessions: proxy.windowSessions,
      };
    }
    return {
      asOf: null,
      basis: null,
      ivPercentile: null,
      ivRank: null,
      latestValue: null,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      own,
      proxy,
      proxyIndex: null,
      reason: `Own ATM IV: ${own.reason}; ${proxyIndex} proxy: ${proxy.reason}`,
      sessions: 0,
      underlying,
      unit: null,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  });
