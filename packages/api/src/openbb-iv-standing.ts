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
  type OpenbbIvHistoryHorizon,
  type OpenbbIvHistoryOutput,
  type OpenbbIvHistoryPoint,
  type OpenbbIvOneYear,
  type OpenbbIvProxyBasisResult,
} from "./contracts/openbb.ts";

// 1-year (252-session) IV percentile and IV rank for Core 7 ETFs and rolling per-ticker history
// (docs/vertex-rebuild/designs/iv-percentile/plan.md,
// docs/vertex-rebuild/designs/vertex-viz-iv-rank-history/design.md). Evaluates each ticker's own
// openbb_option_iv_daily.atm_iv_30d history (decimal) and its Cboe volatility-index proxy in
// market_daily_points (vol points) independently—never mixing the two series—and requires the full
// 252-session minimum before reporting either metric. Research input only; no orders.

type OpenbbCore7Symbol = (typeof OPENBB_CORE7)[number];
type OpenbbVolIndexId = (typeof OPENBB_VOL_INDEX_IDS)[number];

export type IvWindowStats = Readonly<{
  high52w: number;
  ivPercentile: number;
  ivRank: number | null;
  low52w: number;
  reason: string | null;
}>;

const FLAT_RANGE_REASON =
  "Flat 1-year range (min equals max); IV rank not computable";
const DEFAULT_PROXY_LOOKBACK_DAYS = 420;

const VOL_INDEX_PROXY_BY_SYMBOL: Readonly<
  Partial<Record<string, OpenbbVolIndexId>>
> = OPENBB_VOL_INDEX_PROXY;

/** Returns the mapped Cboe 30-day volatility index proxy for a ticker, or null if none exists. */
export const openbbVolIndexProxy = (symbol: string): OpenbbVolIndexId | null =>
  VOL_INDEX_PROXY_BY_SYMBOL[symbol] ?? null;

/** Computes 1-year IV percentile, IV rank, and 52-week low/high over a non-empty window ending at the last element. */
const computeIvWindowStats = (values: readonly number[]): IvWindowStats => {
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
    return {
      high52w: max,
      ivPercentile,
      ivRank: null,
      low52w: min,
      reason: FLAT_RANGE_REASON,
    };
  }
  return {
    high52w: max,
    ivPercentile,
    // Divide before multiplying and clamp so IEEE 754 rounding never exceeds [0, 100].
    ivRank: Math.min(100, Math.max(0, ((latest - min) / span) * 100)),
    low52w: min,
    reason: null,
  };
};

/**
 * Evaluates a ticker's own trailing 252-session ATM IV (`atm_iv_30d`, decimal) basis.
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
  const { ivPercentile, ivRank, reason } = computeIvWindowStats(values);
  return {
    asOf: latest.asOf,
    ivPercentile,
    ivRank,
    latestValue: latest.atmIv30d,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    reason,
    sessions: values.length,
    windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
  };
};

/**
 * Evaluates a Cboe volatility-index proxy (`VIX`, `VXN`, `RVX`, `VXD`, `GVZ`, `VXSLV`, `OVX`)
 * over its newest up to 252 trading sessions in `market_daily_points` (vol points).
 */
export const openbbEvaluateProxyIvBasis = (
  index: OpenbbVolIndexId,
  columns: MarketDailyColumns | undefined,
  lookbackDays = DEFAULT_PROXY_LOOKBACK_DAYS
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
      reason: `Needs ${OPENBB_IV_PERCENTILE_MIN_SESSIONS} sessions of ${index} (${values.length} in ${lookbackDays}d window)`,
      sessions: values.length,
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  const { ivPercentile, ivRank, reason } = computeIvWindowStats(values);
  return {
    asOf,
    index,
    ivPercentile,
    ivRank,
    latestValue,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    reason,
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
const buildOwnRollingPoints = (
  rows: readonly Pick<OpenbbOptionIvDailyRow, "asOf" | "atmIv30d">[],
  requestedSessions: OpenbbIvHistoryHorizon
): OpenbbIvHistoryPoint[] => {
  const windowSize = OPENBB_IV_PERCENTILE_SESSIONS;
  const points: OpenbbIvHistoryPoint[] = [];
  for (let end = windowSize - 1; end < rows.length; end += 1) {
    const start = end - windowSize + 1;
    const values: number[] = [];
    let complete = true;
    for (let cursor = start; cursor <= end; cursor += 1) {
      const value = (
        rows[cursor] as Pick<OpenbbOptionIvDailyRow, "asOf" | "atmIv30d">
      ).atmIv30d;
      if (value === null) {
        complete = false;
        break;
      }
      values.push(value);
    }
    if (!complete) continue;
    const stats = computeIvWindowStats(values);
    const current = rows[end] as Pick<
      OpenbbOptionIvDailyRow,
      "asOf" | "atmIv30d"
    >;
    points.push({
      date: current.asOf,
      high52w: stats.high52w,
      iv: current.atmIv30d as number,
      ivPercentile: stats.ivPercentile,
      ivRank: stats.ivRank,
      low52w: stats.low52w,
    });
  }
  return points.slice(-requestedSessions);
};

const buildProxyRollingPoints = (
  columns: MarketDailyColumns,
  requestedSessions: OpenbbIvHistoryHorizon
): OpenbbIvHistoryPoint[] => {
  const windowSize = OPENBB_IV_PERCENTILE_SESSIONS;
  const firstEnd = Math.max(
    windowSize - 1,
    columns.close.length - requestedSessions
  );
  const points: OpenbbIvHistoryPoint[] = [];
  for (let end = firstEnd; end < columns.close.length; end += 1) {
    const windowValues = columns.close.slice(end - windowSize + 1, end + 1);
    const stats = computeIvWindowStats(windowValues);
    points.push({
      date: columns.dates[end] as string,
      high52w: stats.high52w,
      iv: columns.close[end] as number,
      ivPercentile: stats.ivPercentile,
      ivRank: stats.ivRank,
      low52w: stats.low52w,
    });
  }
  return points;
};

export type OpenbbIvHistoryBuildInput = Readonly<{
  ownRows: readonly Pick<OpenbbOptionIvDailyRow, "asOf" | "atmIv30d">[];
  proxyColumns: MarketDailyColumns | undefined;
  proxyLookbackDays: number;
  requestedSessions: OpenbbIvHistoryHorizon;
  symbol: string;
}>;

/**
 * Builds a rolling 252-session IV rank and IV percentile history for one ticker.
 * Selects `own_atm_iv` once own rolling points cover the requested horizon (or when no proxy
 * history exists), otherwise selects the mapped Cboe `vol_index_proxy` so Core 7 charts keep full
 * multi-month history during own-IV accumulation. Never mixes the two series.
 */
export const openbbIvHistory = ({
  ownRows,
  proxyColumns,
  proxyLookbackDays,
  requestedSessions,
  symbol,
}: OpenbbIvHistoryBuildInput): OpenbbIvHistoryOutput => {
  const own = openbbEvaluateOwnIvBasis(ownRows);
  const proxyIndex = openbbVolIndexProxy(symbol);
  const proxy =
    proxyIndex === null
      ? null
      : openbbEvaluateProxyIvBasis(proxyIndex, proxyColumns, proxyLookbackDays);
  const ownPoints =
    own.ivPercentile === null
      ? []
      : buildOwnRollingPoints(ownRows, requestedSessions);
  const proxyPoints =
    proxy === null || proxy.ivPercentile === null
      ? []
      : buildProxyRollingPoints(
          proxyColumns as MarketDailyColumns,
          requestedSessions
        );

  if (
    ownPoints.length > 0 &&
    (ownPoints.length >= requestedSessions || proxyPoints.length === 0)
  ) {
    const latest = ownPoints.at(-1) as OpenbbIvHistoryPoint;
    return {
      asOf: latest.date,
      basis: "own_atm_iv",
      latest,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      own,
      points: ownPoints,
      proxy,
      proxyIndex: null,
      reason: own.reason,
      requestedSessions,
      symbol,
      unit: "decimal",
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  if (proxyIndex !== null && proxyPoints.length > 0 && proxy !== null) {
    const latest = proxyPoints.at(-1) as OpenbbIvHistoryPoint;
    return {
      asOf: latest.date,
      basis: "vol_index_proxy",
      latest,
      minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
      own,
      points: proxyPoints,
      proxy,
      proxyIndex,
      reason: proxy.reason,
      requestedSessions,
      symbol,
      unit: "vol_points",
      windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
    };
  }
  return {
    asOf: null,
    basis: null,
    latest: null,
    minSessions: OPENBB_IV_PERCENTILE_MIN_SESSIONS,
    own,
    points: [],
    proxy,
    proxyIndex: null,
    reason:
      proxy === null
        ? `No Cboe volatility-index proxy for ${symbol}; own ATM IV: ${own.reason}`
        : `Own ATM IV: ${own.reason}; ${proxy.index} proxy: ${proxy.reason}`,
    requestedSessions,
    symbol,
    unit: null,
    windowSessions: OPENBB_IV_PERCENTILE_SESSIONS,
  };
};
