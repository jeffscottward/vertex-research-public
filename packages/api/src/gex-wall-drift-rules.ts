// What: the GEX wall x net drift read (gex-wall-drift-rules.v1). It describes a price touch of a
// GEX wall by the side of the gamma flip and by the session net options premium drift of the last
// 15 minutes: hold-A, break-risk, no-read or no-data, with a typed code and the inputs it used.
// Pure; imports contract types only. The /flow and /stock pages compute it in the browser; the
// pre-registered study (docs/specs/strategies/gex-wall-drift-confluence.md) embeds these rules and
// its test checks that both are equal.
// Limits: walls sum open interest over all expiries while intraday drift is mostly same-day, and
// the GEX sign assumes customers sell calls and buy puts (gex-context.ts).
// Research only: a read describes what was observed; it is never a trade signal.
// Doc: docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md.
import type { FlowOptionTicker } from "./contracts/flow.ts";

export type GexWallDriftRules = Readonly<{
  version: string;
  /** Price is at a wall when |price - wall| <= this percent of price. */
  nearWallPct: number;
  /** The drift window in minutes, from the baseline minute to the newest settled minute. */
  windowMinutes: number;
  /** A baseline older than windowMinutes + this many minutes: no-data (window_gap). */
  windowToleranceMinutes: number;
  /** Fewer settled drift minutes after the baseline: no-data (thin_window). */
  minBuckets: number;
  /** A side's drift is rising when its change is at least this share of the gross premium. */
  risingShare: number;
  /** Older GEX levels: no-data. Frozen; a test keeps it no looser than the gex source limit. */
  maxGexAgeMinutes: number;
  /** Older net drift: no-data. Frozen; a test keeps it no looser than the net_drift source limit. */
  maxDriftAgeMinutes: number;
  /** |drift price - GEX spot| above this percent of price: no-data (price_scale_mismatch). */
  maxScaleGapPct: number;
}>;

export const GEX_WALL_DRIFT_RULES: GexWallDriftRules = Object.freeze({
  maxDriftAgeMinutes: 5,
  maxGexAgeMinutes: 30,
  maxScaleGapPct: 2,
  minBuckets: 10,
  nearWallPct: 0.25,
  risingShare: 0.3,
  version: "gex-wall-drift-rules.v1",
  windowMinutes: 15,
  windowToleranceMinutes: 3,
});

export const GEX_WALL_DRIFT_READS = [
  "hold-A",
  "break-risk",
  "no-read",
  "no-data",
] as const;
export type GexWallDriftReadValue = (typeof GEX_WALL_DRIFT_READS)[number];

/** Why a read is no-data (inputs missing or stale) or no-read (inputs fine, nothing to grade). */
export const GEX_WALL_DRIFT_CODES = [
  // no-data
  "gex_missing",
  "gex_stale",
  "gex_no_spot",
  "gex_no_walls",
  "drift_missing",
  "drift_stale",
  "window_short",
  "window_gap",
  "thin_window",
  "no_price",
  "zero_premium",
  "ticker_mismatch",
  "price_scale_mismatch",
  // no-read
  "not_at_wall",
  "wall_geometry",
  "both_walls_near",
  "both_rising",
  "flat",
  "hold_below_flip",
  "hold_no_flip",
] as const;
export type GexWallDriftCode = (typeof GEX_WALL_DRIFT_CODES)[number];

export type GexWall = "call" | "put" | "none";
/** not_read: the read stopped (no-data) before price was compared with the flip. */
export type GexFlipSide = "above" | "below" | "no_flip" | "not_read";

/** GEX levels in the options ticker's own price (never basis-shifted levels), or why none. */
export type GexWallLevelsInput =
  | Readonly<{
      kind: "levels";
      ticker: FlowOptionTicker;
      /** "flow_gex" (/flow, the study source) or "options_analytics" (/stock). */
      source: "flow_gex" | "options_analytics";
      /** ISO time of the GEX estimate. */
      at: string;
      spot: number | null;
      callWall: number | null;
      putWall: number | null;
      flip: number | null;
    }>
  | Readonly<{ kind: "missing"; code: "gex_missing"; detail: string }>;

/** One settled point of a cumulative net drift series (FlowNetDriftPoint). */
export type GexDriftPoint = Readonly<{
  minute: string;
  total: Readonly<{ netCallPremiumUsd: number; netPutPremiumUsd: number }>;
  underlyingPrice: number | null;
}>;

/** The net drift series of one ticker, or why there is none. */
export type GexDriftInput =
  | Readonly<{
      kind: "series";
      ticker: FlowOptionTicker;
      /** Settled minutes only, oldest first. */
      points: readonly GexDriftPoint[];
    }>
  | Readonly<{ kind: "missing"; code: "drift_missing"; detail: string }>;

export type GexWallDriftInput = Readonly<{
  now: Date;
  levels: GexWallLevelsInput;
  drift: GexDriftInput;
}>;

/** The drift window: changes of the cumulative lines between baseline and newest minute. */
export type GexDriftWindow = Readonly<{
  baselineMinute: string;
  newestMinute: string;
  spanMinutes: number;
  buckets: number;
  /** USD; a positive put change is net put buying. */
  callChange: number;
  putChange: number;
  /** Sum of the absolute per-point changes of both lines. */
  gross: number;
  /** The underlying price of the newest minute (null when the vendor sent none). */
  price: number | null;
}>;

export type GexWallDriftRead = Readonly<{
  rulesVersion: string;
  read: GexWallDriftReadValue;
  code: GexWallDriftCode | null;
  wall: GexWall;
  flipSide: GexFlipSide;
  ticker: FlowOptionTicker | null;
  levelsSource: "flow_gex" | "options_analytics" | null;
  levelsAt: string | null;
  price: number | null;
  priceAt: string | null;
  wallStrike: number | null;
  /** (price - wall strike) / price, in percent; null without a wall. */
  distancePct: number | null;
  flip: number | null;
  window: GexDriftWindow | null;
  /** Change / gross premium of each side; null when the drift is not read. */
  callShare: number | null;
  putShare: number | null;
  /** Descriptive text: what was observed, never advice. */
  reason: string;
}>;

const MINUTE_MS = 60_000;

/** A missing or unparsable time is stale too. */
const isStale = (now: Date, at: string, maxMinutes: number): boolean => {
  const age = (now.getTime() - Date.parse(at)) / MINUTE_MS;
  return !Number.isFinite(age) || age > maxMinutes;
};

const MILLIONS = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  signDisplay: "exceptZero",
  style: "currency",
});

/** USD in millions with its sign: "+$1.50M", "-$1.20M", "$0.00M". */
const usd = (value: number): string => `${MILLIONS.format(value / 1_000_000)}M`;

/**
 * The window of a settled cumulative series: the newest point, the baseline point (the newest
 * point at or before newest - windowMinutes) and the points after the baseline. Null without a
 * baseline (fewer than windowMinutes of drift this session).
 */
export const gexDriftWindow = (
  points: readonly GexDriftPoint[],
  rules: GexWallDriftRules = GEX_WALL_DRIFT_RULES
): GexDriftWindow | null => {
  const newest = points.at(-1);
  if (newest === undefined) return null;
  const newestMs = Date.parse(newest.minute);
  const baselineIndex = points.findLastIndex(
    (point) =>
      Date.parse(point.minute) <= newestMs - rules.windowMinutes * MINUTE_MS
  );
  if (baselineIndex < 0) return null;
  const window = points.slice(baselineIndex);
  const baseline = window[0] as GexDriftPoint;
  let gross = 0;
  for (let index = 1; index < window.length; index += 1) {
    const before = (window[index - 1] as GexDriftPoint).total;
    const after = (window[index] as GexDriftPoint).total;
    gross +=
      Math.abs(after.netCallPremiumUsd - before.netCallPremiumUsd) +
      Math.abs(after.netPutPremiumUsd - before.netPutPremiumUsd);
  }
  return {
    baselineMinute: baseline.minute,
    buckets: window.length - 1,
    callChange:
      newest.total.netCallPremiumUsd - baseline.total.netCallPremiumUsd,
    gross,
    newestMinute: newest.minute,
    price: newest.underlyingPrice,
    putChange: newest.total.netPutPremiumUsd - baseline.total.netPutPremiumUsd,
    spanMinutes: (newestMs - Date.parse(baseline.minute)) / MINUTE_MS,
  };
};

type Draft = Omit<GexWallDriftRead, "read" | "code" | "reason">;

const result = (
  draft: Draft,
  read: GexWallDriftReadValue,
  code: GexWallDriftCode | null,
  reason: string
): GexWallDriftRead => ({ ...draft, code, read, reason });

const noData = (
  draft: Draft,
  code: GexWallDriftCode,
  reason: string
): GexWallDriftRead =>
  result(
    { ...draft, callShare: null, putShare: null },
    "no-data",
    code,
    reason
  );

type Ready = Readonly<{
  draft: Draft;
  levels: Extract<GexWallLevelsInput, { kind: "levels" }>;
  window: GexDriftWindow;
  price: number;
}>;

const EMPTY_DRAFT: Omit<Draft, "rulesVersion"> = {
  callShare: null,
  distancePct: null,
  flip: null,
  flipSide: "not_read",
  levelsAt: null,
  levelsSource: null,
  price: null,
  priceAt: null,
  putShare: null,
  ticker: null,
  wall: "none",
  wallStrike: null,
  window: null,
};

/** The input stage: a no-data read for missing, stale or mismatched inputs, else the inputs. */
const readInputs = (
  { levels, drift, now }: GexWallDriftInput,
  rules: GexWallDriftRules
): GexWallDriftRead | Ready => {
  const empty: Draft = { ...EMPTY_DRAFT, rulesVersion: rules.version };
  if (levels.kind === "missing")
    return noData(empty, levels.code, levels.detail);
  const draft: Draft = {
    ...empty,
    flip: levels.flip,
    levelsAt: levels.at,
    levelsSource: levels.source,
    ticker: levels.ticker,
  };
  if (isStale(now, levels.at, rules.maxGexAgeMinutes))
    return noData(
      draft,
      "gex_stale",
      `GEX levels are older than ${rules.maxGexAgeMinutes} min`
    );
  if (levels.spot === null)
    return noData(draft, "gex_no_spot", "GEX has no spot price");
  if (levels.callWall === null && levels.putWall === null)
    return noData(
      draft,
      "gex_no_walls",
      "GEX has neither a call nor a put wall"
    );
  if (drift.kind === "missing") return noData(draft, drift.code, drift.detail);
  if (drift.ticker !== levels.ticker)
    return noData(
      draft,
      "ticker_mismatch",
      `GEX is for ${levels.ticker}, net drift for ${drift.ticker}`
    );
  const window = gexDriftWindow(drift.points, rules);
  if (window === null)
    return noData(
      draft,
      "window_short",
      `net drift has less than ${rules.windowMinutes} min this session`
    );
  const withWindow: Draft = { ...draft, window };
  const settledAt = new Date(Date.parse(window.newestMinute) + MINUTE_MS);
  if (isStale(now, settledAt.toISOString(), rules.maxDriftAgeMinutes))
    return noData(
      withWindow,
      "drift_stale",
      `net drift is older than ${rules.maxDriftAgeMinutes} min`
    );
  if (window.spanMinutes > rules.windowMinutes + rules.windowToleranceMinutes)
    return noData(
      withWindow,
      "window_gap",
      `net drift has a gap: the window spans ${window.spanMinutes} min`
    );
  if (window.buckets < rules.minBuckets)
    return noData(
      withWindow,
      "thin_window",
      `net drift has ${window.buckets} of ${rules.minBuckets} minutes in the window`
    );
  if (window.price === null)
    return noData(withWindow, "no_price", "net drift has no underlying price");
  const { price } = window;
  const priced: Draft = {
    ...withWindow,
    flipSide:
      levels.flip === null
        ? "no_flip"
        : price >= levels.flip
          ? "above"
          : "below",
    price,
    priceAt: window.newestMinute,
  };
  const gapPct = (Math.abs(price - levels.spot) / Math.abs(price)) * 100;
  if (gapPct > rules.maxScaleGapPct)
    return noData(
      priced,
      "price_scale_mismatch",
      `price ${price} and GEX spot ${levels.spot} differ by more than ${rules.maxScaleGapPct}%`
    );
  if (window.gross === 0)
    return noData(
      priced,
      "zero_premium",
      "net drift has no premium in the window"
    );
  return { draft: priced, levels, price, window };
};

/** The wall that price touches, or the no-read code that stops the read. */
const locateWall = (
  { callWall, putWall }: Ready["levels"],
  price: number,
  rules: GexWallDriftRules
):
  | Readonly<{ strike: number; wall: "call" | "put" }>
  | Readonly<{ code: GexWallDriftCode; text: string }> => {
  if (callWall !== null && putWall !== null && callWall <= putWall)
    return {
      code: "wall_geometry",
      text: `call wall ${callWall} is not above put wall ${putWall}`,
    };
  const band = (Math.abs(price) * rules.nearWallPct) / 100;
  const nearCall = callWall !== null && Math.abs(price - callWall) <= band;
  const nearPut = putWall !== null && Math.abs(price - putWall) <= band;
  if (nearCall && nearPut)
    return {
      code: "both_walls_near",
      text: `both walls are within ${rules.nearWallPct}%`,
    };
  if (nearCall) return { strike: callWall, wall: "call" };
  if (nearPut) return { strike: putWall, wall: "put" };
  return {
    code: "not_at_wall",
    text: `price ${price} is not within ${rules.nearWallPct}% of a wall`,
  };
};

/** The touch stage: the wall, then the drift (truth table in the design document). */
const gradeTouch = (
  { draft: inputs, levels, price, window }: Ready,
  rules: GexWallDriftRules
): GexWallDriftRead => {
  const callShare = window.callChange / window.gross;
  const putShare = window.putChange / window.gross;
  const { flipSide } = inputs;
  const draft: Draft = { ...inputs, callShare, putShare };
  const flows = `call ${usd(window.callChange)}, put ${usd(window.putChange)} in ${window.spanMinutes} min`;
  const touched = locateWall(levels, price, rules);
  if ("code" in touched)
    return result(draft, "no-read", touched.code, `${touched.text}; ${flows}`);
  const { strike, wall } = touched;
  const atWall: Draft = {
    ...draft,
    distancePct: ((price - strike) / price) * 100,
    wall,
    wallStrike: strike,
  };
  const flipText =
    flipSide === "no_flip"
      ? "no gamma flip in the GEX estimate"
      : `${flipSide} gamma flip ${levels.flip}`;
  const at = `at ${wall} wall ${strike}, ${flipText}`;
  const callRising = callShare >= rules.risingShare;
  const putRising = putShare >= rules.risingShare;
  if (callRising && putRising)
    return result(
      atWall,
      "no-read",
      "both_rising",
      `call and put drift both rising ${at}; ${flows}`
    );
  // The push side drives price through the wall: puts at the put wall, calls at the call wall.
  const pushRising = wall === "put" ? putRising : callRising;
  const holdRising = wall === "put" ? callRising : putRising;
  const holdSide = wall === "put" ? "call" : "put";
  if (pushRising)
    return result(
      atWall,
      "break-risk",
      null,
      `${wall} drift rising ${at}; ${flows}`
    );
  if (!holdRising)
    return result(atWall, "no-read", "flat", `drift flat ${at}; ${flows}`);
  if (flipSide === "above")
    return result(
      atWall,
      "hold-A",
      null,
      `${holdSide} drift rising ${at}; ${flows}`
    );
  return result(
    atWall,
    "no-read",
    flipSide === "below" ? "hold_below_flip" : "hold_no_flip",
    `${holdSide} drift rising ${at}; a hold is graded above the flip only; ${flows}`
  );
};

/**
 * Grades the current wall touch. Order: missing or stale inputs (no-data), the wall geometry and
 * touch, then the drift: both sides rising (no-read), the side that pushes through the wall rising
 * (break-risk), the other side rising (hold-A above the flip only), else flat (no-read).
 */
export const gradeGexWallDrift = (
  input: GexWallDriftInput,
  rules: GexWallDriftRules = GEX_WALL_DRIFT_RULES
): GexWallDriftRead => {
  const ready = readInputs(input, rules);
  return "read" in ready ? ready : gradeTouch(ready, rules);
};
