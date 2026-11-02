// What: Resolve lesson params and legs into a priced option position. Values, P&L, Greeks,
// breakevens and max profit/loss for any time between entry and the first expiry.
import {
  blackScholes,
  CONTRACT_MULTIPLIER,
  DAYS_PER_YEAR,
  type OptionValue,
} from "./math.ts";
import type { Leg, LessonParam } from "./schema.ts";

export type ParamValues = Readonly<Record<string, number | string>>;

export type ResolvedLeg = Readonly<{
  kind: Leg["kind"];
  side: Leg["side"];
  qty: number;
  strike: number;
  /** Calendar days to expiry at entry (stock: Infinity). */
  dte: number;
  /** Annual volatility as a fraction. */
  vol: number;
  label: string;
  /** Per-share entry value. */
  entry: number;
}>;

export type Market = Readonly<{ spot: number; vol: number; rate: number }>;

export const defaultValues = (
  params: readonly LessonParam[]
): Record<string, number | string> =>
  Object.fromEntries(params.map((param) => [param.id, param.default]));

/** Numeric param lookup with a fallback; strings that parse as numbers are accepted. */
export const num = (
  values: ParamValues,
  key: string,
  fallback: number
): number => {
  const raw = values[key];
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};

export const marketOf = (values: ParamValues): Market => ({
  spot: Math.max(num(values, "spot", 100), 0.01),
  vol: Math.max(num(values, "iv", 30), 0.5) / 100,
  rate: num(values, "rate", 4) / 100,
});

const refValue = (
  value: number | string | undefined,
  values: ParamValues,
  fallback: number
): number =>
  value === undefined
    ? fallback
    : typeof value === "number"
      ? value
      : num(values, value, fallback);

const legLabel = (leg: Leg, strike: number, dte: number): string => {
  if (leg.label !== undefined) return leg.label;
  const side = leg.side === "long" ? "Long" : "Short";
  if (leg.kind === "stock") return `${side} stock`;
  return `${side} ${Math.round(strike * 100) / 100} ${leg.kind} ${Math.round(dte)}d`;
};

const legValue = (
  leg: Pick<ResolvedLeg, "kind" | "strike" | "vol">,
  spot: number,
  daysLeft: number,
  rate: number
): OptionValue => {
  if (leg.kind === "stock")
    return { price: spot, delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 };
  return blackScholes({
    kind: leg.kind,
    spot,
    strike: leg.strike,
    years: Math.max(daysLeft, 0) / DAYS_PER_YEAR,
    rate,
    vol: leg.vol,
  });
};

export const resolveLegs = (
  legs: readonly Leg[],
  values: ParamValues
): ResolvedLeg[] => {
  const market = marketOf(values);
  return legs.map((leg) => {
    const strike =
      leg.kind === "stock" ? 0 : refValue(leg.strike, values, market.spot);
    const dte =
      leg.kind === "stock"
        ? Number.POSITIVE_INFINITY
        : Math.max(refValue(leg.dte, values, 30), 0);
    const vol =
      leg.iv === undefined
        ? market.vol
        : Math.max(refValue(leg.iv, values, market.vol * 100), 0.5) / 100;
    const qty = Math.max(refValue(leg.qty, values, 1), 0);
    const base = { kind: leg.kind, strike, vol };
    return {
      kind: leg.kind,
      side: leg.side,
      qty,
      strike,
      dte,
      vol,
      label: legLabel(leg, strike, dte),
      entry: legValue(base, market.spot, dte, market.rate).price,
    };
  });
};

/** Days from entry to the first option expiry (Infinity for stock-only positions). */
export const horizonOf = (legs: readonly ResolvedLeg[]): number => {
  const options = legs
    .filter((leg) => leg.kind !== "stock")
    .map((leg) => leg.dte);
  return options.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...options);
};

const sign = (leg: ResolvedLeg): number => (leg.side === "long" ? 1 : -1);

export type PositionPoint = Readonly<{
  value: number;
  pnl: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}>;

/** Position totals in dollars (options x100) at a spot and days elapsed since entry. */
export const positionAt = (
  legs: readonly ResolvedLeg[],
  spot: number,
  elapsed: number,
  rate: number,
  volShift = 0
): PositionPoint => {
  let value = 0;
  let pnl = 0;
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;
  for (const leg of legs) {
    const shifted = { ...leg, vol: Math.max(leg.vol + volShift, 0.005) };
    const v = legValue(shifted, spot, leg.dte - elapsed, rate);
    const units = sign(leg) * leg.qty * CONTRACT_MULTIPLIER;
    value += units * v.price;
    pnl += units * (v.price - leg.entry);
    delta += units * v.delta;
    gamma += units * v.gamma;
    theta += units * v.theta;
    vega += units * v.vega;
  }
  return { value, pnl, delta, gamma, theta, vega };
};

/** Per-leg values and Greeks at a spot and time (dollars, options x100). */
export const legBreakdown = (
  legs: readonly ResolvedLeg[],
  spot: number,
  elapsed: number,
  rate: number
) =>
  legs.map((leg) => {
    const v = legValue(leg, spot, leg.dte - elapsed, rate);
    const units = sign(leg) * leg.qty * CONTRACT_MULTIPLIER;
    return {
      label: leg.label,
      kind: leg.kind,
      side: leg.side,
      qty: leg.qty,
      strike: leg.kind === "stock" ? null : leg.strike,
      dte: leg.kind === "stock" ? null : leg.dte,
      vol: leg.kind === "stock" ? null : leg.vol,
      entry: leg.entry,
      price: v.price,
      pnl: units * (v.price - leg.entry),
      delta: units * v.delta,
      gamma: units * v.gamma,
      theta: units * v.theta,
      vega: units * v.vega,
    };
  });

/** Net entry cash per position in dollars: positive = debit paid, negative = credit received. */
export const entryCost = (legs: readonly ResolvedLeg[]): number =>
  legs.reduce(
    (total, leg) =>
      total + sign(leg) * leg.qty * CONTRACT_MULTIPLIER * leg.entry,
    0
  );

export type PayoffSummary = Readonly<{
  breakevens: number[];
  maxProfit: number | null;
  maxLoss: number | null;
  /** Expiry P&L at the current spot. */
  atSpot: number;
}>;

/** Expiry P&L summary scanned over 0..4x spot; null = unbounded in that direction. */
export const payoffSummary = (
  legs: readonly ResolvedLeg[],
  spot: number,
  rate: number
): PayoffSummary => {
  const horizon = horizonOf(legs);
  const elapsed = Number.isFinite(horizon) ? horizon : 0;
  const steps = 1600;
  const top = spot * 4;
  let maxProfit = Number.NEGATIVE_INFINITY;
  let maxLoss = Number.POSITIVE_INFINITY;
  const breakevens: number[] = [];
  let previous: number | null = null;
  let previousX = 0;
  for (let index = 0; index <= steps; index += 1) {
    const x = (top * index) / steps;
    const pnl = positionAt(legs, x, elapsed, rate).pnl;
    maxProfit = Math.max(maxProfit, pnl);
    maxLoss = Math.min(maxLoss, pnl);
    if (
      previous !== null &&
      Math.sign(previous) !== Math.sign(pnl) &&
      pnl !== 0
    ) {
      const crossing =
        previousX +
        ((x - previousX) * Math.abs(previous)) /
          (Math.abs(previous) + Math.abs(pnl));
      breakevens.push(crossing);
    }
    previous = pnl;
    previousX = x;
  }
  // Slope beyond the scan decides whether the extreme is bounded.
  const far = positionAt(legs, top * 1.5, elapsed, rate).pnl;
  const edge = positionAt(legs, top, elapsed, rate).pnl;
  const upSlope = far - edge;
  return {
    breakevens,
    maxProfit: upSlope > 1e-6 ? null : maxProfit,
    maxLoss: upSlope < -1e-6 ? null : maxLoss,
    atSpot: positionAt(legs, spot, elapsed, rate).pnl,
  };
};
