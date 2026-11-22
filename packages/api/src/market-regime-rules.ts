import type { Breadth90GetOutput } from "./contracts/breadth-90.ts";
import type {
  GexIndexRow,
  MacroSeries,
  MarketContextOutput,
} from "./contracts/market-context.ts";
import {
  REGIME_CREDIT_STALE_SECONDS,
  REGIME_DAILY_STALE_SECONDS,
  REGIME_ETF_VOL_INDEX_IDS,
  REGIME_GAMMA_PUSH_STALE_SECONDS,
  type RegimeBreadth90Pillar,
  type RegimeBreadth90State,
  type RegimeCreditPillar,
  type RegimeCreditState,
  type RegimeDealerGammaPillar,
  type RegimeDealerGammaState,
  type RegimeEtfRow,
  type RegimeIndexSymbol,
  type RegimeSpotVsFlip,
  type RegimeSummaryState,
  type RegimeTrendPillar,
  type RegimeTrendState,
  type RegimeVolatilityPillar,
  type RegimeVolatilityState,
  type RegimeVolTermStructure,
} from "./contracts/market-regime.ts";

// Pure classification and staleness rules for marketRegime.get.
// Method citations live in docs/vertex-rebuild/designs/regime-view/design.md
// (_master-rules C058, C108, C200, C806, C006, C095, C878, C146, C033, C230).
// Research context only; no order, alert, or strategy gating logic.

const DAILY_CLOSE_UTC_SUFFIX = "T21:00:00.000Z";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CREDIT_FALLBACK_IDS: Readonly<Record<string, true>> = {
  BAMLH0A0HYM2: true,
  HY_OAS: true,
};

const REGIME_TREND_SHORT_WINDOW = 50;
const REGIME_TREND_LONG_WINDOW = 200;
const REGIME_CREDIT_CHANGE_LOOKBACK = 20;
const REGIME_CREDIT_MIN_PCT_SESSIONS = 20;
const REGIME_CREDIT_WIDENING_OAS = 4.0;
const REGIME_CREDIT_STRESSED_OAS = 5.0;
const REGIME_CREDIT_WIDENING_CHANGE_BPS = 35;
const REGIME_CREDIT_STRESSED_CHANGE_BPS = 75;
const REGIME_VIX_ELEVATED_LINE = 20;
const REGIME_VIX_EXTREME_LINE = 30;
const REGIME_TERM_CONTANGO_MAX = 0.95;
const REGIME_TERM_FLAT_MAX = 1.0;

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Validates and normalizes an asOf string to an accepted ISO datetime or YYYY-MM-DD date, else null. */
export const normalizeRegimeAsOf = (asOf: string | null): string | null => {
  if (asOf === null) return null;
  const trimmed = asOf.trim();
  if (DATE_ONLY_PATTERN.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().startsWith(trimmed)
      ? trimmed
      : null;
  }
  if (ISO_DATETIME_PATTERN.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? trimmed : null;
  }
  return null;
};

/** Parses a validated ISO datetime or YYYY-MM-DD session date (at 21:00 UTC NYSE close). */
export const parseRegimeAsOfMs = (asOf: string | null): number | null => {
  const normalized = normalizeRegimeAsOf(asOf);
  if (normalized === null) return null;
  const iso = DATE_ONLY_PATTERN.test(normalized)
    ? `${normalized}${DAILY_CLOSE_UTC_SUFFIX}`
    : normalized;
  return Date.parse(iso);
};

/** Elapsed seconds from `asOf` to `now` (clamped at 0 for minor clock skew), or null if unparseable. */
export const computeAgeSeconds = (
  asOf: string | null,
  now: Date
): number | null => {
  const asOfMs = parseRegimeAsOfMs(asOf);
  if (asOfMs === null) return null;
  return Math.max(0, Math.floor((now.getTime() - asOfMs) / 1000));
};

const isStaleFromAge = (
  ageSeconds: number | null,
  limitSeconds: number,
  upstreamStale = false
): boolean =>
  upstreamStale || (ageSeconds !== null && ageSeconds > limitSeconds);

const maxAge = (ages: readonly (number | null)[]): number | null => {
  let max: number | null = null;
  for (const age of ages) {
    if (age !== null && (max === null || age > max)) {
      max = age;
    }
  }
  return max;
};

/** Simple moving average of the final `window` finite numbers, or null when fewer exist. */
export const simpleMovingAverage = (
  closes: readonly number[],
  window: number
): number | null => {
  if (closes.length < window) return null;
  let sum = 0;
  for (let i = closes.length - window; i < closes.length; i += 1) {
    sum += closes[i] as number;
  }
  return sum / window;
};

export type TrendSeriesInput = Readonly<{
  asOf: string | null;
  closes: readonly number[];
  source: string;
  symbol: RegimeIndexSymbol;
  upstreamStale?: boolean;
}>;

/** Classifies ETF trend against 50-day and 200-day simple moving averages (C058, C108). */
export const classifyTrendPillar = (
  input: TrendSeriesInput,
  now: Date
): RegimeTrendPillar => {
  const sessions = input.closes.length;
  const close = sessions > 0 ? (input.closes.at(-1) as number) : null;
  const sma50Raw = simpleMovingAverage(input.closes, REGIME_TREND_SHORT_WINDOW);
  const sma200Raw = simpleMovingAverage(input.closes, REGIME_TREND_LONG_WINDOW);
  const asOf = normalizeRegimeAsOf(input.asOf);
  const ageSeconds = computeAgeSeconds(asOf, now);

  if (close === null || sma50Raw === null || sma200Raw === null) {
    const detail =
      sessions === 0
        ? `Missing: no daily closes stored or fetched for ${input.symbol}.`
        : `Missing: ${input.symbol} has ${sessions} sessions (needs ${REGIME_TREND_LONG_WINDOW} for SMA200).`;
    return {
      ageSeconds,
      asOf,
      close: close === null ? null : round(close),
      detail,
      pctVsSma50:
        close !== null && sma50Raw !== null && sma50Raw > 0
          ? round(((close - sma50Raw) / sma50Raw) * 100)
          : null,
      pctVsSma200: null,
      scope: "etf",
      sessions,
      sma50: sma50Raw === null ? null : round(sma50Raw),
      sma50AboveSma200: null,
      sma200: null,
      source: input.source,
      stale: false,
      staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
      state: "missing",
    };
  }

  const sma50 = round(sma50Raw);
  const sma200 = round(sma200Raw);
  const closeRounded = round(close);
  const pctVsSma50 =
    sma50Raw > 0 ? round(((close - sma50Raw) / sma50Raw) * 100) : null;
  const pctVsSma200 =
    sma200Raw > 0 ? round(((close - sma200Raw) / sma200Raw) * 100) : null;

  let state: RegimeTrendState;
  let detail: string;
  if (close > sma50Raw && close > sma200Raw) {
    state = "uptrend";
    detail = `${input.symbol} ${closeRounded} above SMA50 (${sma50}) and SMA200 (${sma200}).`;
  } else if (close < sma50Raw && close < sma200Raw) {
    state = "downtrend";
    detail = `${input.symbol} ${closeRounded} below SMA50 (${sma50}) and SMA200 (${sma200}).`;
  } else {
    state = "mixed";
    detail = `${input.symbol} ${closeRounded} between SMA50 (${sma50}) and SMA200 (${sma200}).`;
  }

  return {
    ageSeconds,
    asOf,
    close: closeRounded,
    detail,
    pctVsSma50,
    pctVsSma200,
    scope: "etf",
    sessions,
    sma50,
    sma50AboveSma200: sma50Raw > sma200Raw,
    sma200,
    source: input.source,
    stale: isStaleFromAge(
      ageSeconds,
      REGIME_DAILY_STALE_SECONDS,
      input.upstreamStale === true
    ),
    staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
    state,
  };
};

const BREADTH90_STATE_MAP: Readonly<
  Record<
    NonNullable<Breadth90GetOutput["status"]>["state"],
    RegimeBreadth90State
  >
> = {
  ARMED: "armed",
  FIRED: "fired",
  FORMING: "forming",
  IDLE: "idle",
};

/** Classifies market-wide NYSE Breadth-90 from breadth90.get output (C200, C806). */
export const classifyBreadth90Pillar = (
  data: Breadth90GetOutput | null,
  now: Date,
  errorDetail?: string
): RegimeBreadth90Pillar => {
  const status = data?.status ?? null;
  if (data === null || status === null) {
    return {
      ageSeconds: null,
      armedOn: null,
      asOf: null,
      detail:
        errorDetail ?? "Missing: no Breadth-90 status stored yet in Postgres.",
      latestAdvPct: null,
      latestDate: null,
      latestFinal: null,
      latestKind: null,
      latestUpPct: null,
      scope: "market_wide",
      sessionsLeft: null,
      signalState: null,
      source: data === null ? "none" : "breadth90",
      stale: false,
      staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
      state: "missing",
      strict: null,
    };
  }

  const latest = data.days.at(-1) ?? null;
  const state = BREADTH90_STATE_MAP[status.state];
  const ageSeconds = maxAge([
    computeAgeSeconds(status.asOf, now),
    latest === null ? null : computeAgeSeconds(latest.date, now),
  ]);
  const stale = isStaleFromAge(ageSeconds, REGIME_DAILY_STALE_SECONDS);
  const latestNote =
    latest === null
      ? ""
      : ` Latest ${latest.date}: ${latest.upPct.toFixed(1)}% up-volume (${latest.kind}).`;
  const armedNote =
    status.armedOn === null
      ? ""
      : ` Armed ${status.armedOn} (${status.sessionsLeft ?? 0} sessions left).`;

  return {
    ageSeconds,
    armedOn: status.armedOn,
    asOf: status.asOf,
    detail: `NYSE Breadth-90 ${status.state}.${armedNote}${latestNote}`,
    latestAdvPct: latest === null ? null : latest.advPct,
    latestDate: latest === null ? null : latest.date,
    latestFinal: latest === null ? null : latest.final,
    latestKind: latest === null ? null : latest.kind,
    latestUpPct: latest === null ? null : latest.upPct,
    scope: "market_wide",
    sessionsLeft: status.sessionsLeft,
    signalState: status.state,
    source: "breadth90",
    stale,
    staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
    state,
    strict: status.strict,
  };
};

const normalizeSpotVsFlip = (row: GexIndexRow): RegimeSpotVsFlip | null => {
  const raw = row.spotVsFlip?.trim().toLowerCase();
  if (raw === "above" || raw === "below" || raw === "at") return raw;
  if (row.spot !== null && row.flip !== null) {
    if (row.spot > row.flip) return "above";
    if (row.spot < row.flip) return "below";
    return "at";
  }
  return null;
};

const resolveGammaState = (
  row: GexIndexRow,
  spotVsFlip: RegimeSpotVsFlip | null
): RegimeDealerGammaState => {
  if (row.netGex !== null) {
    if (row.netGex > 0) return "positive";
    if (row.netGex < 0) return "negative";
    return "neutral";
  }
  if (spotVsFlip === "above") return "positive";
  if (spotVsFlip === "below") return "negative";
  if (spotVsFlip === "at") return "neutral";
  const regime = row.regime?.trim().toLowerCase() ?? "";
  if (regime.startsWith("positive") || regime.startsWith("dampened"))
    return "positive";
  if (regime.startsWith("negative") || regime.startsWith("amplified"))
    return "negative";
  if (regime.startsWith("neutral")) return "neutral";
  return "missing";
};

const GAMMA_ROLE_NOTE: Readonly<Record<RegimeDealerGammaState, string>> = {
  missing: "no gamma reading",
  negative: "amplified moves / trend acceleration",
  neutral: "at gamma flip",
  not_covered: "no dealer gamma feed",
  positive: "pinning / mean-reversion (not directional)",
};

const emptyDealerGamma = (
  state: "not_covered" | "missing",
  source: string,
  detail: string,
  asOf: string | null = null,
  oiSession: string | null = null
): RegimeDealerGammaPillar => ({
  ageSeconds: null,
  asOf,
  callWall: null,
  detail,
  flip: null,
  netGex: null,
  oiSession,
  putWall: null,
  scope: "etf",
  source,
  spot: null,
  spotVsFlip: null,
  stale: false,
  staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
  state,
  upstreamRegime: null,
});

const resolveGammaFreshness = (
  context: MarketContextOutput,
  gex: NonNullable<MarketContextOutput["gex"]>,
  state: RegimeDealerGammaState,
  now: Date
) => {
  const upstreamAge = maxAge([
    computeAgeSeconds(gex.asOf, now),
    computeAgeSeconds(gex.oiSession, now),
  ]);
  const pushAge = computeAgeSeconds(context.generatedAt, now);
  const pushStale = isStaleFromAge(
    pushAge,
    REGIME_GAMMA_PUSH_STALE_SECONDS,
    context.stale
  );
  const upstreamStale = isStaleFromAge(upstreamAge, REGIME_DAILY_STALE_SECONDS);
  const usePushWindow = pushStale && !upstreamStale;
  return {
    ageSeconds: usePushWindow ? pushAge : (upstreamAge ?? pushAge),
    asOf: gex.asOf ?? gex.oiSession ?? context.generatedAt,
    pushStale,
    stale: state !== "missing" && (pushStale || upstreamStale),
    staleLimitSeconds: usePushWindow
      ? REGIME_GAMMA_PUSH_STALE_SECONDS
      : REGIME_DAILY_STALE_SECONDS,
  };
};

/** Classifies per-ETF dealer gamma from marketContext.get GEX rows (C006, C095, C878). */
export const classifyDealerGammaPillar = (
  symbol: RegimeIndexSymbol,
  context: MarketContextOutput | null,
  now: Date,
  errorDetail?: string
): RegimeDealerGammaPillar => {
  if (symbol !== "SPY" && symbol !== "QQQ") {
    return emptyDealerGamma(
      "not_covered",
      "none",
      `No dealer gamma feed for ${symbol} (market-context covers SPY and QQQ only).`
    );
  }

  const gex = context?.gex ?? null;
  const row =
    gex?.index.find((entry: GexIndexRow) => entry.symbol === symbol) ?? null;
  if (context === null || gex === null || row === null || row.status !== "ok") {
    return emptyDealerGamma(
      "missing",
      context === null ? "none" : "market_context_gex",
      errorDetail ??
        `Missing: no ok GEX row for ${symbol} in market-context snapshot.`,
      gex?.asOf ?? gex?.oiSession ?? context?.generatedAt ?? null,
      gex?.oiSession ?? null
    );
  }

  const spotVsFlip = normalizeSpotVsFlip(row);
  const state = resolveGammaState(row, spotVsFlip);
  const freshness = resolveGammaFreshness(context, gex, state, now);
  const flipText = row.flip === null ? "no flip" : `flip ${round(row.flip)}`;
  const spotText = row.spot === null ? "no spot" : `spot ${round(row.spot)}`;

  return {
    ageSeconds: freshness.ageSeconds,
    asOf: freshness.asOf,
    callWall: row.callWall,
    detail: `${symbol} ${state} gamma (${spotText}, ${flipText}; ${GAMMA_ROLE_NOTE[state]}).${freshness.pushStale ? " [rig push overdue]" : ""}`,
    flip: row.flip,
    netGex: row.netGex,
    oiSession: gex.oiSession,
    putWall: row.putWall,
    scope: "etf",
    source: "market_context_gex",
    spot: row.spot,
    spotVsFlip,
    stale: freshness.stale,
    staleLimitSeconds: freshness.staleLimitSeconds,
    state,
    upstreamRegime: row.regime,
  };
};

export type CreditPoint = Readonly<{ date: string; value: number }>;

export type CreditInput = Readonly<{
  fallbackContextStale?: boolean;
  fallbackSeries?: MacroSeries | null;
  hyPoints: readonly CreditPoint[];
  igPoints: readonly CreditPoint[];
}>;

/** Matches only HY OAS fallback series (never bare group="credit", which can match IG_OAS). */
export const findCreditFallbackSeries = (
  series: readonly MacroSeries[] | undefined
): MacroSeries | null => {
  if (series === undefined) return null;
  return (
    series.find(
      (row) =>
        Object.hasOwn(CREDIT_FALLBACK_IDS, row.id.toUpperCase()) &&
        row.status === "ok"
    ) ?? null
  );
};

const normalizeMacroSpreadPct = (value: number, units: string): number =>
  units.trim().toLowerCase().includes("bp") ? value / 100 : value;

const percentileOfLatest = (values: readonly number[]): number | null => {
  if (values.length < REGIME_CREDIT_MIN_PCT_SESSIONS) return null;
  const latest = values.at(-1) as number;
  const below = values.filter((value) => value < latest).length;
  return round((100 * below) / (values.length - 1), 1);
};

const classifyCreditState = (
  hyOas: number,
  change20dBps: number | null
): RegimeCreditState => {
  if (
    hyOas >= REGIME_CREDIT_STRESSED_OAS ||
    (change20dBps !== null && change20dBps >= REGIME_CREDIT_STRESSED_CHANGE_BPS)
  ) {
    return "stressed";
  }
  if (
    hyOas >= REGIME_CREDIT_WIDENING_OAS ||
    (change20dBps !== null && change20dBps >= REGIME_CREDIT_WIDENING_CHANGE_BPS)
  ) {
    return "widening";
  }
  return "calm";
};

const creditFromPrimary = (
  hyPoints: readonly CreditPoint[],
  latestHy: CreditPoint,
  latestIg: CreditPoint | null,
  now: Date
): RegimeCreditPillar => {
  const hyOas = round(latestHy.value, 2);
  const hyOasBps = Math.round(latestHy.value * 100);
  const priorIndex = hyPoints.length - 1 - REGIME_CREDIT_CHANGE_LOOKBACK;
  const prior = priorIndex >= 0 ? (hyPoints[priorIndex] as CreditPoint) : null;
  const hyOasChange20dBps =
    prior === null ? null : hyOasBps - Math.round(prior.value * 100);
  const state = classifyCreditState(latestHy.value, hyOasChange20dBps);
  const ageSeconds = computeAgeSeconds(latestHy.date, now);
  const deltaNote =
    hyOasChange20dBps === null
      ? ""
      : `, 20d ${hyOasChange20dBps >= 0 ? "+" : ""}${hyOasChange20dBps} bps`;

  return {
    ageSeconds,
    asOf: latestHy.date,
    detail: `US HY OAS ${hyOas.toFixed(2)}% (${hyOasBps} bps${deltaNote}) — ${state}.`,
    hyOas,
    hyOasBps,
    hyOasChange20dBps,
    hyOasPct1y: percentileOfLatest(hyPoints.map((point) => point.value)),
    igOas: latestIg === null ? null : round(latestIg.value, 2),
    scope: "market_wide",
    source: "openbb_macro:HY_OAS",
    stale: isStaleFromAge(ageSeconds, REGIME_CREDIT_STALE_SECONDS),
    staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
    state,
  };
};

const creditFromFallback = (
  fallback: MacroSeries,
  fallbackValue: number,
  fallbackContextStale: boolean,
  now: Date
): RegimeCreditPillar => {
  const spreadPct = normalizeMacroSpreadPct(fallbackValue, fallback.units);
  const hyOas = round(spreadPct, 2);
  const hyOasBps = Math.round(spreadPct * 100);
  const hyOasChange20dBps =
    fallback.change1m === null
      ? null
      : Math.round(
          normalizeMacroSpreadPct(fallback.change1m, fallback.units) * 100
        );
  const state = classifyCreditState(spreadPct, hyOasChange20dBps);
  const ageSeconds = computeAgeSeconds(fallback.date, now);

  return {
    ageSeconds,
    asOf: fallback.date,
    detail: `US HY OAS ${hyOas.toFixed(2)}% (${hyOasBps} bps, fallback macro feed) — ${state}.`,
    hyOas,
    hyOasBps,
    hyOasChange20dBps,
    hyOasPct1y: fallback.pct1y === null ? null : round(fallback.pct1y, 1),
    igOas: null,
    scope: "market_wide",
    source: `market_context_macro:${fallback.id}`,
    stale: isStaleFromAge(
      ageSeconds,
      REGIME_CREDIT_STALE_SECONDS,
      fallback.stale || fallbackContextStale
    ),
    staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
    state,
  };
};

/** Classifies US High Yield OAS credit regime (C146, C806; numeric bands documented as defaults). */
export const classifyCreditPillar = (
  input: CreditInput,
  now: Date,
  errorDetail?: string
): RegimeCreditPillar => {
  const latestHy = input.hyPoints.at(-1) ?? null;
  const latestIg = input.igPoints.at(-1) ?? null;
  if (latestHy !== null) {
    return creditFromPrimary(input.hyPoints, latestHy, latestIg, now);
  }

  const fallback = input.fallbackSeries ?? null;
  if (
    fallback !== null &&
    fallback.status === "ok" &&
    fallback.value !== null
  ) {
    return creditFromFallback(
      fallback,
      fallback.value,
      input.fallbackContextStale === true,
      now
    );
  }

  return {
    ageSeconds: null,
    asOf: null,
    detail:
      errorDetail ??
      "Missing: no HY_OAS credit spread series found in OpenBB macro or market-context.",
    hyOas: null,
    hyOasBps: null,
    hyOasChange20dBps: null,
    hyOasPct1y: null,
    igOas: latestIg === null ? null : round(latestIg.value, 2),
    scope: "market_wide",
    source: "none",
    stale: false,
    staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
    state: "missing",
  };
};

export type VolatilityInput = Readonly<{
  atmIv30d: number | null;
  etfVolClose: number | null;
  etfVolDate: string | null;
  ivPercentile: number | null;
  liveVixAsOf: string | null;
  liveVixStale: boolean;
  liveVixValue: number | null;
  openbbVix3mDate?: string | null;
  openbbVixClose: number | null;
  openbbVixDate: string | null;
  symbol: RegimeIndexSymbol;
  vix3mVix6m: number | null;
  vix9dVix: number | null;
  vixVix3m: number | null;
}>;

export const classifyVolTermStructure = (
  vixVix3m: number | null
): RegimeVolTermStructure => {
  if (vixVix3m === null) return "missing";
  if (vixVix3m > REGIME_TERM_FLAT_MAX) return "backwardation";
  if (vixVix3m >= REGIME_TERM_CONTANGO_MAX) return "flat";
  return "contango";
};

const resolveVolSelection = (input: VolatilityInput) => {
  const liveAsOf = normalizeRegimeAsOf(input.liveVixAsOf);
  const openbbAsOf = normalizeRegimeAsOf(input.openbbVixDate);
  const liveMs = parseRegimeAsOfMs(liveAsOf);
  const openbbMs = parseRegimeAsOfMs(openbbAsOf);
  const useLive =
    input.liveVixValue !== null &&
    liveAsOf !== null &&
    !input.liveVixStale &&
    (input.openbbVixClose === null ||
      (liveMs !== null && (openbbMs === null || liveMs >= openbbMs)));

  const fallbackLive =
    input.openbbVixClose === null &&
    input.liveVixValue !== null &&
    liveAsOf !== null;
  const vix = useLive
    ? input.liveVixValue
    : (input.openbbVixClose ?? (fallbackLive ? input.liveVixValue : null));
  const vixAsOf = useLive
    ? liveAsOf
    : input.openbbVixClose === null
      ? liveAsOf
      : openbbAsOf;
  const hasOpenbb =
    input.openbbVixClose !== null ||
    input.vixVix3m !== null ||
    input.etfVolClose !== null;
  const usedLive = useLive || fallbackLive;

  let source = "none";
  if (usedLive && hasOpenbb)
    source = "ibkr_monitor_volatility+openbb_vol_context";
  else if (usedLive) source = "ibkr_monitor_volatility";
  else if (hasOpenbb) source = "openbb_vol_context";

  return { openbbAsOf, source, usedLive, vix, vixAsOf };
};

const resolveVolState = (
  vix: number,
  termStructure: RegimeVolTermStructure
): RegimeVolatilityState => {
  if (vix >= REGIME_VIX_EXTREME_LINE) return "extreme";
  if (vix >= REGIME_VIX_ELEVATED_LINE || termStructure === "backwardation") {
    return "elevated";
  }
  return "calm";
};

const roundOrNull = (value: number | null, digits: number): number | null =>
  value === null ? null : round(value, digits);

/** Classifies market-wide volatility level and VIX/VIX3M term structure with per-ETF context (C033, C230). */
export const classifyVolatilityPillar = (
  input: VolatilityInput,
  now: Date,
  errorDetail?: string
): RegimeVolatilityPillar => {
  const etfVolIndexId = REGIME_ETF_VOL_INDEX_IDS[input.symbol];
  const termStructure = classifyVolTermStructure(input.vixVix3m);
  const { openbbAsOf, source, usedLive, vix, vixAsOf } =
    resolveVolSelection(input);

  const sharedFields = {
    atmIv30d: roundOrNull(input.atmIv30d, 4),
    etfVolIndex: roundOrNull(input.etfVolClose, 2),
    etfVolIndexId,
    ivPercentile: roundOrNull(input.ivPercentile, 1),
    scope: "market_wide" as const,
    source,
    staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
    termStructure,
    vix3mVix6m: roundOrNull(input.vix3mVix6m, 3),
    vix9dVix: roundOrNull(input.vix9dVix, 3),
    vixVix3m: roundOrNull(input.vixVix3m, 3),
  };

  if (vix === null) {
    return {
      ...sharedFields,
      ageSeconds: null,
      asOf: null,
      detail:
        errorDetail ??
        "Missing: no VIX reading in OpenBB vol context or ibkr-monitor.",
      stale: false,
      state: "missing",
      vix: null,
    };
  }

  const state = resolveVolState(vix, termStructure);
  const worstAge = maxAge([
    computeAgeSeconds(vixAsOf, now),
    input.vixVix3m === null ? null : computeAgeSeconds(openbbAsOf, now),
    input.vixVix3m === null
      ? null
      : computeAgeSeconds(input.openbbVix3mDate ?? openbbAsOf, now),
    input.etfVolClose === null
      ? null
      : computeAgeSeconds(input.etfVolDate, now),
  ]);
  const termText =
    input.vixVix3m === null
      ? "no term ratio"
      : `VIX/VIX3M ${round(input.vixVix3m, 3)} (${termStructure})`;
  const etfNote =
    input.symbol !== "SPY" && input.etfVolClose !== null
      ? `, ${etfVolIndexId} ${round(input.etfVolClose, 2)}`
      : "";

  return {
    ...sharedFields,
    ageSeconds: worstAge,
    asOf: vixAsOf,
    detail: `VIX ${round(vix, 2)} (${state}), ${termText}${etfNote}.`,
    stale: isStaleFromAge(
      worstAge,
      REGIME_DAILY_STALE_SECONDS,
      usedLive && input.liveVixStale
    ),
    state,
    vix: round(vix, 2),
  };
};

type RegimePillarsBundle = Readonly<{
  breadth90: RegimeBreadth90Pillar;
  credit: RegimeCreditPillar;
  dealerGamma: RegimeDealerGammaPillar;
  trend: RegimeTrendPillar;
  volatility: RegimeVolatilityPillar;
}>;

const collectStressDrivers = (pillars: RegimePillarsBundle): string[] => {
  const drivers: string[] = [];
  if (pillars.trend.state === "downtrend") {
    drivers.push("Trend is downtrend (below SMA50 and SMA200)");
  } else if (pillars.trend.state === "mixed") {
    drivers.push("Trend is mixed (between SMA50 and SMA200)");
  }
  if (pillars.breadth90.state === "armed") {
    drivers.push("Breadth-90 is armed after an 80%+ down day");
  } else if (pillars.breadth90.state === "forming") {
    drivers.push(
      "Breadth-90 is forming (unfinished intraday thrust while armed)"
    );
  }
  if (pillars.dealerGamma.state === "negative") {
    drivers.push("Dealer gamma is negative (amplified moves)");
  }
  if (
    pillars.credit.state === "widening" ||
    pillars.credit.state === "stressed"
  ) {
    drivers.push(`Credit spreads are ${pillars.credit.state}`);
  }
  if (
    pillars.volatility.state === "elevated" ||
    pillars.volatility.state === "extreme"
  ) {
    drivers.push(`Volatility is ${pillars.volatility.state}`);
  }
  return drivers;
};

const classifyRowSummary = (
  pillars: RegimePillarsBundle,
  availableCount: number,
  staleCount: number
): RegimeSummaryState => {
  if (availableCount < 3) return "incomplete";
  const macroStressCount = [
    pillars.breadth90.state === "armed" ||
      pillars.breadth90.state === "forming",
    pillars.credit.state === "widening" || pillars.credit.state === "stressed",
    pillars.volatility.state === "elevated" ||
      pillars.volatility.state === "extreme",
  ].filter(Boolean).length;

  if (
    (pillars.trend.state === "downtrend" && macroStressCount >= 2) ||
    (pillars.volatility.state === "extreme" &&
      pillars.credit.state === "stressed")
  ) {
    return "risk_off";
  }
  const breadthCalm =
    pillars.breadth90.state === "idle" || pillars.breadth90.state === "fired";
  if (
    staleCount === 0 &&
    pillars.trend.state === "uptrend" &&
    breadthCalm &&
    pillars.dealerGamma.state !== "negative" &&
    pillars.credit.state === "calm" &&
    pillars.volatility.state === "calm"
  ) {
    return "risk_on";
  }
  return "mixed";
};

/** Combines the 5 pillars for one ETF into a summary state and explicit mixed drivers (C806, C878). */
export const buildRegimeEtfRow = (
  symbol: RegimeIndexSymbol,
  pillars: RegimePillarsBundle
): RegimeEtfRow => {
  const named = [
    ["Trend", pillars.trend],
    ["Breadth-90", pillars.breadth90],
    ["Dealer gamma", pillars.dealerGamma],
    ["Credit", pillars.credit],
    ["Volatility", pillars.volatility],
  ] as const;

  const staleNames = named
    .filter(([, pillar]) => pillar.stale)
    .map(([label]) => label);
  const staleCount = staleNames.length;
  // Structurally uncovered gamma (IWM/DIA) is `not_covered`, not a feed failure.
  const missingNames = named
    .filter(([, pillar]) => pillar.state === "missing")
    .map(([label]) => label);
  const missingCount = missingNames.length;
  const availableCount = named.filter(
    ([, pillar]) => pillar.state !== "missing" && pillar.state !== "not_covered"
  ).length;

  const stressDrivers = collectStressDrivers(pillars);
  const summary = classifyRowSummary(pillars, availableCount, staleCount);

  const mixedDrivers: string[] = [];
  if (summary === "mixed") {
    if (pillars.trend.state === "uptrend") {
      if (stressDrivers.length > 0) {
        mixedDrivers.push("Trend is uptrend while stress lights are active");
      } else if (staleCount > 0) {
        mixedDrivers.push("Trend is uptrend but stale inputs block risk-on");
      } else {
        mixedDrivers.push("Trend is uptrend but missing inputs block risk-on");
      }
    } else if (pillars.trend.state === "downtrend") {
      mixedDrivers.push(
        "Trend is downtrend without broad cross-asset confirmation"
      );
    }
    mixedDrivers.push(...stressDrivers);
    for (const label of staleNames) {
      mixedDrivers.push(`${label} input is stale`);
    }
    for (const label of missingNames) {
      mixedDrivers.push(`${label} input is missing`);
    }
    if (pillars.breadth90.state === "fired") {
      mixedDrivers.push("Breadth-90 thrust fired");
    }
  }

  return {
    breadth90: pillars.breadth90,
    credit: pillars.credit,
    dealerGamma: pillars.dealerGamma,
    hasStaleInputs: staleCount > 0,
    missingCount,
    mixedDrivers: mixedDrivers.slice(0, 8),
    staleCount,
    summary,
    symbol,
    trend: pillars.trend,
    volatility: pillars.volatility,
  };
};

/** Summarizes the four ETF rows into one top-level regime posture. */
export const summarizeOverallRegime = (
  etfs: readonly RegimeEtfRow[]
): Readonly<{
  staleEtfs: RegimeIndexSymbol[];
  stalePillarCount: number;
  summary: RegimeSummaryState;
  missingPillarCount: number;
}> => {
  const staleEtfs = etfs
    .filter((row) => row.hasStaleInputs)
    .map((row) => row.symbol);
  const stalePillarCount = etfs.reduce((sum, row) => sum + row.staleCount, 0);
  const missingPillarCount = etfs.reduce(
    (sum, row) => sum + row.missingCount,
    0
  );

  let summary: RegimeSummaryState;
  if (etfs.every((row) => row.summary === "incomplete")) {
    summary = "incomplete";
  } else if (etfs.every((row) => row.summary === "risk_on")) {
    summary = "risk_on";
  } else if (etfs.every((row) => row.summary === "risk_off")) {
    summary = "risk_off";
  } else {
    summary = "mixed";
  }

  return {
    missingPillarCount,
    staleEtfs,
    stalePillarCount,
    summary,
  };
};
