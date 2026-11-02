// Cost profiles for the backtest engine: spread, slippage, commission, pass-through fees and the
// short borrow fee for one instrument at one broker. Pure functions; research and paper use only.
// Nothing here creates or routes an order.
//
// Money values are in the account currency. `units` is the real quantity: shares for a stock,
// underlying units (contracts x multiplier) for an option, so `units * price` is the traded value.

const BPS = 10_000;
const PERCENT = 100;
const DAYS_PER_YEAR = 360;
/** Bisection steps that size an entry so that value plus costs fit the cash. */
const SIZING_ITERATIONS = 100;

export type CostSlippage =
  | Readonly<{ kind: "bps"; bps: number }>
  | Readonly<{ kind: "atr"; fraction: number; period: number }>;

/** Per-contract commission for options whose premium is below `belowPremium`. */
export type PremiumTier = Readonly<{
  belowPremium: number;
  perContract: number;
}>;

export type CostCommission = Readonly<{
  perShare: number;
  perContract: number;
  /** Lower premium tiers that replace `perContract`, checked in order. */
  premiumTiers: readonly PremiumTier[];
  /** Percent of the traded value. */
  percentOfValue: number;
  minPerOrder: number;
  /** null: no money cap. */
  maxPerOrder: number | null;
  /** Percent of the traded value; null: no percent cap. */
  maxPercentOfValue: number | null;
}>;

export type CostFees = Readonly<{
  /** Clearing, audit-trail and similar fees per share (stock) or per contract (option). */
  perUnit: number;
  /** Fraction of the commission (exchange pass-through fees). */
  ofCommission: number;
  /** Fraction of the sale value, charged on sells only (SEC transaction fee). */
  ofSaleValue: number;
}>;

export type CostProfile = Readonly<{
  id: string;
  label: string;
  instrument: "stock" | "option";
  /** Underlying units per contract; 1 for stocks. */
  multiplier: number;
  /** Full quoted spread in basis points of the price; each fill pays half. */
  spreadBps: number;
  slippage: CostSlippage;
  commission: CostCommission;
  fees: CostFees;
  /** Annual borrow fee in percent of the short value (actual/360). */
  borrowFeeAnnualPct: number;
  /** Where the numbers come from (URL and date) or "custom". */
  source: string;
}>;

export type FillSide = "buy" | "sell";

export type OrderCharges = Readonly<{ commission: number; fees: number }>;

export type FillCosts = Readonly<{
  price: number;
  spread: number;
  slippage: number;
  commission: number;
  fees: number;
}>;

const NO_COMMISSION: CostCommission = {
  maxPercentOfValue: null,
  maxPerOrder: null,
  minPerOrder: 0,
  perContract: 0,
  percentOfValue: 0,
  perShare: 0,
  premiumTiers: [],
};

const NO_FEES: CostFees = { ofCommission: 0, ofSaleValue: 0, perUnit: 0 };

const IBKR_STOCKS_URL =
  "https://www.interactivebrokers.com/en/pricing/commissions-stocks.php (read 2026-10-23)";
const IBKR_OPTIONS_URL =
  "https://www.interactivebrokers.com/en/pricing/commissions-options.php (read 2026-10-23)";
const SEC_FEE_RATE = 0.000_020_6;
const CAT_FEE_PER_SHARE = 0.000_003;
const CAT_FEE_PER_CONTRACT = 0.0003;

export const ZERO_COST_PROFILE: CostProfile = {
  borrowFeeAnnualPct: 0,
  commission: NO_COMMISSION,
  fees: NO_FEES,
  id: "zero",
  instrument: "stock",
  label: "No costs",
  multiplier: 1,
  slippage: { bps: 0, kind: "bps" },
  source: "custom",
  spreadBps: 0,
};

/** Presets. Spread, slippage and borrow are 0: they depend on the instrument, not the broker. */
export const COST_PROFILE_PRESETS = {
  "ibkr-pro-fixed-us-stock": {
    ...ZERO_COST_PROFILE,
    commission: {
      ...NO_COMMISSION,
      maxPercentOfValue: 1,
      minPerOrder: 1,
      perShare: 0.005,
    },
    fees: { ...NO_FEES, ofSaleValue: SEC_FEE_RATE, perUnit: CAT_FEE_PER_SHARE },
    id: "ibkr-pro-fixed-us-stock",
    label: "IBKR Pro Fixed, US stocks",
    source: IBKR_STOCKS_URL,
  },
  "ibkr-pro-tiered-us-stock": {
    ...ZERO_COST_PROFILE,
    commission: {
      ...NO_COMMISSION,
      maxPercentOfValue: 1,
      minPerOrder: 0.35,
      perShare: 0.0035,
    },
    // Clearing USD 0.0002 + CAT 0.000003 per share; NYSE 0.000175 + FINRA 0.000565 pass-through.
    // Venue exchange fees and rebates vary by route and are not included.
    fees: {
      ofCommission: 0.000_175 + 0.000_565,
      ofSaleValue: SEC_FEE_RATE,
      perUnit: 0.0002 + CAT_FEE_PER_SHARE,
    },
    id: "ibkr-pro-tiered-us-stock",
    label: "IBKR Pro Tiered (<= 300,000 shares/month), US stocks",
    source: IBKR_STOCKS_URL,
  },
  "ibkr-pro-us-option": {
    ...ZERO_COST_PROFILE,
    commission: {
      ...NO_COMMISSION,
      minPerOrder: 1,
      perContract: 0.65,
      premiumTiers: [
        { belowPremium: 0.05, perContract: 0.25 },
        { belowPremium: 0.1, perContract: 0.5 },
      ],
    },
    // OCC clearing 0.025 + CAT 0.0003 per contract. Exchange fees and the ORF vary and are excluded.
    fees: {
      ...NO_FEES,
      ofSaleValue: SEC_FEE_RATE,
      perUnit: 0.025 + CAT_FEE_PER_CONTRACT,
    },
    id: "ibkr-pro-us-option",
    instrument: "option",
    label: "IBKR Pro (<= 10,000 contracts/month), US options",
    multiplier: 100,
    source: IBKR_OPTIONS_URL,
  },
  zero: ZERO_COST_PROFILE,
} as const satisfies Record<string, CostProfile>;

export type CostProfilePresetId = keyof typeof COST_PROFILE_PRESETS;
export const COST_PROFILE_PRESET_IDS = Object.keys(
  COST_PROFILE_PRESETS
) as CostProfilePresetId[];

const optionRate = (commission: CostCommission, premium: number): number => {
  for (const tier of commission.premiumTiers) {
    if (premium < tier.belowPremium) return tier.perContract;
  }
  return commission.perContract;
};

/** Commission and fees of one order of `units` at `price`. 0 units cost nothing. */
export const orderCharges = (
  profile: CostProfile,
  side: FillSide,
  units: number,
  price: number
): OrderCharges => {
  if (units <= 0) return { commission: 0, fees: 0 };
  const { commission: rule, fees } = profile;
  const value = units * price;
  const option = profile.instrument === "option";
  const count = option ? units / profile.multiplier : units;
  let commission =
    (option ? count * optionRate(rule, price) : units * rule.perShare) +
    (value * rule.percentOfValue) / PERCENT;
  commission = Math.max(commission, rule.minPerOrder);
  if (rule.maxPerOrder !== null)
    commission = Math.min(commission, rule.maxPerOrder);
  if (rule.maxPercentOfValue !== null)
    commission = Math.min(
      commission,
      (value * rule.maxPercentOfValue) / PERCENT
    );
  const saleFee = side === "sell" ? value * fees.ofSaleValue : 0;
  return {
    commission,
    fees: count * fees.perUnit + commission * fees.ofCommission + saleFee,
  };
};

/** Price move per unit against the trader from half the spread plus slippage. */
const adverseMove = (
  profile: CostProfile,
  price: number,
  atr: number
): Readonly<{ spread: number; slippage: number }> => {
  const spread = (price * profile.spreadBps) / BPS / 2;
  const slip = profile.slippage;
  const slippage =
    slip.kind === "bps"
      ? (price * slip.bps) / BPS
      : Number.isFinite(atr)
        ? atr * slip.fraction
        : 0;
  return { slippage, spread };
};

/** Fill price and costs of one order at reference price `price`. */
export const fillCosts = (
  profile: CostProfile,
  side: FillSide,
  units: number,
  price: number,
  atr: number
): FillCosts => {
  const move = adverseMove(profile, price, atr);
  const total = move.spread + move.slippage;
  // A sell can not fill below zero; scale both parts down so that they add up to the move.
  const scale = side === "sell" && total > price ? price / total : 1;
  const fill = side === "buy" ? price + total : price - total * scale;
  const charges = orderCharges(profile, side, units, fill);
  return {
    commission: charges.commission,
    fees: charges.fees,
    price: fill,
    slippage: units * move.slippage * scale,
    spread: units * move.spread * scale,
  };
};

/**
 * Largest buy quantity whose value plus commission and fees fits `cash` at fill price `fill`.
 * `scale` converts quantities and cash to real money (the engine works at starting equity 1, so it
 * passes the initial capital). Returns 0 when the minimum charges alone exceed the cash.
 * Charges never fall when the quantity grows, so a bisection finds the largest quantity that fits.
 */
export const affordableUnits = (
  profile: CostProfile,
  cash: number,
  fill: number,
  scale = 1
): number => {
  const all = cash / fill;
  const chargesOf = (size: number) => {
    const charges = orderCharges(profile, "buy", size * scale, fill);
    return (charges.commission + charges.fees) / scale;
  };
  // Without charges this is exact and matches the engine path without a profile.
  if (chargesOf(all) === 0) return all;
  const spend = (size: number) => size * fill + chargesOf(size);
  let low = 0;
  let high = all;
  for (let step = 0; step < SIZING_ITERATIONS; step += 1) {
    const middle = (low + high) / 2;
    if (spend(middle) <= cash) low = middle;
    else high = middle;
  }
  return low;
};

/** Borrow fee of a short position of `value` held for `days` calendar days. */
export const borrowFee = (
  profile: CostProfile,
  value: number,
  days: number
): number =>
  (Math.abs(value) * profile.borrowFeeAnnualPct * days) /
  PERCENT /
  DAYS_PER_YEAR;

/** Average true range over `period` bars ending at each bar; NaN until `period` ranges exist. */
export const averageTrueRange = (
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period: number
): Float64Array => {
  const size = close.length;
  const out = new Float64Array(size).fill(Number.NaN);
  const ranges = new Float64Array(size);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    const h = high[index] as number;
    const l = low[index] as number;
    const previous = index > 0 ? (close[index - 1] as number) : Number.NaN;
    const range =
      index > 0
        ? Math.max(h - l, Math.abs(h - previous), Math.abs(l - previous))
        : h - l;
    ranges[index] = range;
    sum += range;
    if (index >= period) sum -= ranges[index - period] as number;
    if (index >= period - 1) out[index] = sum / period;
  }
  return out;
};
