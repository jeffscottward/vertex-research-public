/**
 * Black-Scholes option model and cost model of the qc-ports options runner, ported from
 * services/research/strategies/qc_ports/options.py with the same operation order (research
 * only; see that file for the model assumptions).
 *
 * - European Black-Scholes-Merton with a continuous dividend yield q per symbol and the
 *   risk-free rate r; time in calendar days / 365.
 * - ATM implied vol = factor * IV index / 100 (0.9 for VIX, VXN, VXD and RVX, 0.95 for GVZ, OVX
 *   and VXSLV).
 * - Skew: IV(K) = ATM * max(0.5, 1 + slope * x), x = ln(K/S) / (ATM * sqrt(T)) clamped to [-3, 3].
 * - Strike grid: step 1 when spot >= 25, else 0.5.
 * - Costs per leg and side: $0.65 commission per contract plus half the bid/ask spread,
 *   half-spread = max(0.01, pct * mid) per share (100 shares a contract).
 *
 * norm_cdf goes through the correctly rounded erfc of libm.ts, as CPython's math.erfc on glibc.
 */
import { erfc, exp, log } from "./libm.ts";

export type Right = "call" | "put";

export const MULTIPLIER = 100;
const COMMISSION = 0.65;
const MIN_HALF_SPREAD = 0.01;
const ATM_FACTOR: ReadonlyMap<string, number> = new Map([
  ["VIX", 0.9],
  ["VXN", 0.9],
  ["VXD", 0.9],
  ["RVX", 0.9],
  ["GVZ", 0.95],
  ["OVX", 0.95],
  ["VXSLV", 0.95],
]);
const HALF_SPREAD_PCT: ReadonlyMap<string, number> = new Map([
  ["SPY", 0.01],
  ["QQQ", 0.015],
  ["IWM", 0.02],
  ["DIA", 0.03],
  ["GLD", 0.025],
  ["SLV", 0.04],
  ["USO", 0.04],
]);
export const DIVIDEND_YIELD: ReadonlyMap<string, number> = new Map([
  ["SPY", 0.015],
  ["QQQ", 0.007],
  ["DIA", 0.018],
  ["IWM", 0.012],
]);
/** IV change per standardized-moneyness unit, relative to ATM (model assumption). */
export const SKEW: ReadonlyMap<string, number> = new Map([
  ["SPY", -0.3],
  ["QQQ", -0.25],
  ["DIA", -0.3],
  ["IWM", -0.22],
  ["GLD", 0.05],
  ["SLV", 0.05],
  ["USO", -0.1],
]);
const SKEW_FLOOR = 0.5;
const SKEW_CLAMP = 3;

export const normCdf = (x: number): number => 0.5 * erfc(-x / Math.sqrt(2));

const requireFinite = (values: Readonly<Record<string, number>>): void => {
  for (const [name, value] of Object.entries(values))
    if (!Number.isFinite(value))
      throw new Error(`${name} must be a finite number`);
};

/** Refuses NaN, infinities and out-of-range inputs (spot, strike, sigma > 0; t, r, q >= 0). */
const check = (
  right: string,
  spot: number,
  strike: number,
  sigma: number,
  t: number,
  r: number,
  q: number
) => {
  if (right !== "call" && right !== "put")
    throw new Error("right must be call or put");
  requireFinite({ spot, strike, sigma, t, r, q });
  if (!(spot > 0 && strike > 0))
    throw new Error("spot and strike must be above 0");
  if (!(sigma > 0)) throw new Error("sigma must be above 0");
  if (t < 0 || r < 0 || q < 0)
    throw new Error("t, r and q must not be negative");
};

/** d1 of Black-Scholes and its root sigma * sqrt(t) (d2 = d1 - root). */
const d1Root = (
  spot: number,
  strike: number,
  t: number,
  r: number,
  q: number,
  sigma: number
) => {
  const root = sigma * Math.sqrt(t);
  return {
    d1: (log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / root,
    root,
  };
};

/** Black-Scholes-Merton price per share; intrinsic value at t = 0. */
export const bsPrice = (
  right: Right,
  spot: number,
  strike: number,
  t: number,
  r: number,
  q: number,
  sigma: number
): number => {
  check(right, spot, strike, sigma, t, r, q);
  if (t === 0)
    return right === "call"
      ? Math.max(0, spot - strike)
      : Math.max(0, strike - spot);
  const { d1, root } = d1Root(spot, strike, t, r, q, sigma);
  const d2 = d1 - root;
  const growth = exp(-q * t);
  const discount = exp(-r * t);
  if (right === "call")
    return spot * growth * normCdf(d1) - strike * discount * normCdf(d2);
  return strike * discount * normCdf(-d2) - spot * growth * normCdf(-d1);
};

/** Spot delta (call in [0, 1], put in [-1, 0]). */
export const bsDelta = (
  right: Right,
  spot: number,
  strike: number,
  t: number,
  r: number,
  q: number,
  sigma: number
): number => {
  check(right, spot, strike, sigma, t, r, q);
  if (t === 0) {
    if (right === "call") return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const { d1 } = d1Root(spot, strike, t, r, q, sigma);
  const growth = exp(-q * t);
  return right === "call" ? growth * normCdf(d1) : -growth * normCdf(-d1);
};

/** ATM implied vol (fraction) from an IV index level in percent. */
export const atmIv = (indexId: string, level: number): number => {
  const factor = ATM_FACTOR.get(indexId);
  if (factor === undefined) throw new Error(`No ATM factor for ${indexId}`);
  requireFinite({ level });
  if (!(level > 0)) throw new Error("IV index level must be above 0");
  return (factor * level) / 100;
};

/** IV at `strike`: ATM scaled by the linear skew in standardized moneyness (floored, clamped). */
export const smileIv = (
  atm: number,
  spot: number,
  strike: number,
  t: number,
  slope: number
): number => {
  requireFinite({ atm, spot, strike, t, slope });
  if (!(atm > 0)) throw new Error("ATM IV must be above 0");
  if (t <= 0 || slope === 0) return atm;
  const x = Math.max(
    -SKEW_CLAMP,
    Math.min(SKEW_CLAMP, log(strike / spot) / (atm * Math.sqrt(t)))
  );
  return atm * Math.max(SKEW_FLOOR, 1 + slope * x);
};

export const strikeStep = (spot: number): number => (spot >= 25 ? 1 : 0.5);

/** Half the bid/ask spread per share of one option at `mid`. */
export const halfSpread = (symbol: string, mid: number): number => {
  const pct = HALF_SPREAD_PCT.get(symbol);
  if (pct === undefined) throw new Error(`No spread model for ${symbol}`);
  requireFinite({ mid });
  if (mid < 0) throw new Error("mid must not be negative");
  return Math.max(MIN_HALF_SPREAD, pct * mid);
};

/** Cost in $ per contract of trading one leg once: commission + half-spread * 100. */
export const legCost = (symbol: string, mid: number): number =>
  COMMISSION + MULTIPLIER * halfSpread(symbol, mid);
