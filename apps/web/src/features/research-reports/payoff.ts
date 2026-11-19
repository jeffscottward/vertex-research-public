// Expiry payoff model of the dossier payoff lab (merge plan P1-6): profit or loss at expiry from
// intrinsic value, stored strikes and stored entry premiums. It is not a mark-to-market valuation:
// no time value, no volatility, no early exercise. Pure arithmetic: no report name, no stored text
// and no clock. Research only: no trading permission.

export type OptionKind =
  | "long-call"
  | "cash-secured-put"
  | "bull-call-spread"
  | "put-credit-spread";
export type PayoffKind = "stock" | OptionKind;

/** `undefined`: no multiplier stored. `null`: a stored value that is not a positive finite number. */
export type StoredMultiplier = number | null | undefined;

export type PayoffLeg = Readonly<{
  side: "buy" | "sell";
  type: "call" | "put";
  strike: number;
  premium: number | null;
  multiplier: StoredMultiplier;
}>;

export type PayoffStrategy =
  | Readonly<{ kind: "stock"; basis: number | null }>
  | Readonly<{
      kind: OptionKind;
      legs: readonly PayoffLeg[];
      multiplier: StoredMultiplier;
      /** Shares per contract for a leg without a stored multiplier; `null`: none may be assumed. */
      assumedMultiplier: number | null;
    }>;

export type PayoffReason =
  | "size"
  | "stock-basis"
  | "range"
  | "no-legs"
  | "strike"
  | "premium"
  | "structure"
  | "multiplier-invalid"
  | "multiplier-missing"
  | "multiplier-mismatch";

/** A `to` of `null` means every price at or above `from`. */
export type BreakevenRange = Readonly<{ from: number; to: number | null }>;

export type AvailablePayoff = Readonly<{
  available: true;
  /** Shares for stock, whole contracts for an option kind. */
  units: number;
  /** Shares per contract; `null` for stock. */
  contractMultiplier: number | null;
  /** True when a leg without a stored multiplier used `assumedMultiplier`. */
  multiplierAssumed: boolean;
  netPremiumPerShare: number;
  maxLoss: number;
  /** `null` means uncapped. */
  maxProfit: number | null;
  breakevens: readonly number[];
  breakevenRanges: readonly BreakevenRange[];
  /** 0 and the strikes, ascending: the payoff is linear between two neighbours and after the last. */
  knots: readonly number[];
  at: (price: number) => number | null;
}>;
export type ExpiryPayoff =
  | Readonly<{ available: false; reason: PayoffReason }>
  | AvailablePayoff;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const refused = (reason: PayoffReason): ExpiryPayoff => ({
  available: false,
  reason,
});

/** A stored multiplier: absent stays `undefined`; a positive finite number (also as text) is kept. */
export const readMultiplier = (value: unknown): StoredMultiplier => {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return finite(parsed) && parsed > 0 ? parsed : null;
};

const stockPayoff = (basis: number | null, units: number): ExpiryPayoff => {
  if (!finite(basis) || basis < 0) return refused("stock-basis");
  const maxLoss = basis * units;
  if (!finite(maxLoss)) return refused("range");
  return {
    at: (price) => {
      if (!finite(price) || price < 0) return null;
      const profit = (price - basis) * units;
      return finite(profit) ? profit : null;
    },
    available: true,
    breakevenRanges: [],
    breakevens: [basis],
    contractMultiplier: null,
    knots: [0],
    maxLoss,
    maxProfit: null,
    multiplierAssumed: false,
    netPremiumPerShare: basis,
    units,
  };
};

type Structure =
  | Readonly<{ shape: "long-call"; strike: number }>
  | Readonly<{ shape: "cash-secured-put"; strike: number }>
  | Readonly<{ shape: "bull-call-spread"; low: number; width: number }>
  | Readonly<{ shape: "put-credit-spread"; high: number; width: number }>;

/** The supported 1:1 structures; `null` when the legs do not match the kind. */
const structureOf = (
  kind: OptionKind,
  legs: readonly PayoffLeg[]
): Structure | null => {
  const buy = legs.find((leg) => leg.side === "buy");
  const sell = legs.find((leg) => leg.side === "sell");
  if (kind === "long-call")
    return legs.length === 1 && buy?.type === "call"
      ? { shape: kind, strike: buy.strike }
      : null;
  if (kind === "cash-secured-put")
    return legs.length === 1 && sell?.type === "put"
      ? { shape: kind, strike: sell.strike }
      : null;
  const type = kind === "bull-call-spread" ? "call" : "put";
  if (
    legs.length !== 2 ||
    buy?.type !== type ||
    sell?.type !== type ||
    buy.strike >= sell.strike
  )
    return null;
  const width = sell.strike - buy.strike;
  return kind === "bull-call-spread"
    ? { low: buy.strike, shape: kind, width }
    : { high: sell.strike, shape: kind, width };
};

/**
 * Intrinsic value per share at expiry. A spread is clamped to its width directly, so two huge,
 * nearly equal intrinsic values are never subtracted.
 */
const intrinsic = (structure: Structure, price: number): number => {
  if (structure.shape === "long-call")
    return Math.max(price - structure.strike, 0);
  if (structure.shape === "cash-secured-put")
    return -Math.max(structure.strike - price, 0);
  if (structure.shape === "bull-call-spread")
    return Math.min(Math.max(price - structure.low, 0), structure.width);
  return -Math.min(Math.max(structure.high - price, 0), structure.width);
};

type OptionStrategy = Exclude<PayoffStrategy, { kind: "stock" }>;

/** Shares per contract of one leg: its own stored value, else the strategy value, else the assumed one. */
const legMultiplier = (
  strategy: OptionStrategy,
  leg: PayoffLeg
): number | PayoffReason => {
  if (leg.multiplier === null) return "multiplier-invalid";
  return (
    leg.multiplier ??
    strategy.multiplier ??
    strategy.assumedMultiplier ??
    "multiplier-missing"
  );
};

/** One multiplier for every leg, equal to the strategy multiplier when one is stored. */
const contractMultiplier = (
  strategy: OptionStrategy,
  first: PayoffLeg,
  rest: readonly PayoffLeg[]
): number | PayoffReason => {
  if (strategy.multiplier === null) return "multiplier-invalid";
  const agreed = legMultiplier(strategy, first);
  if (typeof agreed !== "number") return agreed;
  if (strategy.multiplier !== undefined && agreed !== strategy.multiplier)
    return "multiplier-mismatch";
  for (const leg of rest) {
    const value = legMultiplier(strategy, leg);
    if (typeof value !== "number") return value;
    if (value !== agreed) return "multiplier-mismatch";
  }
  return agreed;
};

/** Bought premiums minus sold premiums per share; `null` when a premium is missing or invalid. */
const netPremiumOf = (legs: readonly PayoffLeg[]): number | null => {
  let netPremium = 0;
  for (const leg of legs) {
    if (!finite(leg.premium) || leg.premium < 0) return null;
    netPremium += leg.side === "buy" ? leg.premium : -leg.premium;
  }
  return netPremium;
};

type KnotValue = Readonly<{ price: number; value: number }>;
type Breakevens = Readonly<{
  breakevens: readonly number[];
  breakevenRanges: readonly BreakevenRange[];
}>;

/**
 * Breakeven points and ranges from the values at the knots. The payoff is piecewise linear and
 * never falls as the price rises, so every crossing is at a knot, between two neighbouring knots,
 * or on the last linear ray. `null` when the last-ray crossing is beyond the number range.
 */
const breakevensOf = (
  origin: KnotValue,
  rest: readonly KnotValue[],
  uncapped: boolean,
  perShare: number
): Breakevens | null => {
  const breakevens: number[] = origin.value === 0 ? [origin.price] : [];
  const breakevenRanges: BreakevenRange[] = [];
  let previous = origin;
  for (const point of rest) {
    if (point.value === 0) breakevens.push(point.price);
    if (previous.value === 0 && point.value === 0)
      breakevenRanges.push({ from: previous.price, to: point.price });
    else if (previous.value < 0 && point.value > 0) {
      // The ratio form avoids overflow in the product of a price and a profit.
      const weight = -previous.value / (point.value - previous.value);
      breakevens.push(previous.price + weight * (point.price - previous.price));
    }
    previous = point;
  }
  if (uncapped && previous.value < 0) {
    const crossing = previous.price - previous.value / perShare;
    if (!finite(crossing)) return null;
    breakevens.push(crossing);
  } else if (!uncapped && previous.value === 0)
    breakevenRanges.push({ from: previous.price, to: null });
  return {
    breakevenRanges,
    // The payoff never falls, so its zero set is one interval: with a range, every point is an end of it.
    breakevens: breakevenRanges.length === 0 ? breakevens : [],
  };
};

const optionPayoff = (
  strategy: OptionStrategy,
  units: number
): ExpiryPayoff => {
  const { legs } = strategy;
  const [first, ...rest] = legs;
  if (first === undefined) return refused("no-legs");
  if (legs.some((leg) => !finite(leg.strike) || leg.strike < 0))
    return refused("strike");
  const netPremium = netPremiumOf(legs);
  if (netPremium === null) return refused("premium");
  const structure = structureOf(strategy.kind, legs);
  if (structure === null) return refused("structure");
  const perContract = contractMultiplier(strategy, first, rest);
  if (typeof perContract !== "number") return refused(perContract);
  const multiplier = units * perContract;
  if (!(finite(multiplier) && finite(netPremium * multiplier)))
    return refused("range");

  const at = (price: number): number | null => {
    if (!finite(price) || price < 0) return null;
    const profit = (intrinsic(structure, price) - netPremium) * multiplier;
    return finite(profit) ? profit : null;
  };

  // The knots: 0, then the distinct strikes above 0 in ascending order.
  const strikes = [...new Set(legs.map((leg) => leg.strike))]
    .filter((strike) => strike > 0)
    .sort((a, b) => a - b);
  const originValue = at(0);
  if (originValue === null) return refused("range");
  const origin: KnotValue = { price: 0, value: originValue };
  const later: KnotValue[] = [];
  for (const price of strikes) {
    const value = at(price);
    if (value === null) return refused("range");
    later.push({ price, value });
  }
  const points = [origin, ...later];
  const knots = points.map((point) => point.price);
  const uncapped = strategy.kind === "long-call";
  const crossings = breakevensOf(origin, later, uncapped, multiplier);
  if (crossings === null) return refused("range");
  const values = points.map((point) => point.value);
  return {
    ...crossings,
    at,
    available: true,
    contractMultiplier: perContract,
    knots,
    maxLoss: Math.max(0, -Math.min(...values)),
    maxProfit: uncapped ? null : Math.max(0, ...values),
    multiplierAssumed:
      strategy.multiplier === undefined &&
      legs.some((leg) => leg.multiplier === undefined),
    netPremiumPerShare: netPremium,
    units,
  };
};

/**
 * The expiry payoff of one strategy at `units` (shares for stock, whole contracts for an option
 * kind). Leg premiums are the entry assumption; a missing premium is never read as zero.
 */
export const prepareExpiryPayoff = (
  strategy: PayoffStrategy,
  units: number
): ExpiryPayoff => {
  if (
    !finite(units) ||
    units <= 0 ||
    (strategy.kind !== "stock" && !Number.isInteger(units))
  )
    return refused("size");
  return strategy.kind === "stock"
    ? stockPayoff(strategy.basis, units)
    : optionPayoff(strategy, units);
};

export const expiryProfit = (
  strategy: PayoffStrategy,
  price: number,
  units: number
): number | null => {
  const payoff = prepareExpiryPayoff(strategy, units);
  return payoff.available ? payoff.at(price) : null;
};
