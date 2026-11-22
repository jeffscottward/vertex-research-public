// Prices a vertical option spread (two legs, one right, one expiry) from leg quotes or from the
// option model of the backtest runner (research only; no order is placed). Pure math, no I/O.
// - Net per share: long leg price minus short leg price. Above 0 is a debit, below 0 a credit.
// - Debit spread (long leg nearer the money): max loss = debit, max gain = width - debit.
//   Credit spread (short leg nearer the money): max gain = credit, max loss = width - credit.
//   Breakeven: put = higher strike - debit (or credit), call = lower strike + debit (or credit).
// - Worse sides: buy at the ask and sell at the bid (quotes), or the model half-spread on both
//   legs (halfSpread of options-engine/pricing.ts). Commissions are not included.
// - Model: the backtest runner's own functions (atmIv, smileIv, bsPrice, bsDelta); Greeks per
//   leg from blackScholes (options-chain-greeks.ts) at that leg's smile IV.
// - Greeks are per share in the units of options-chain-greeks.ts: delta and gamma per $1 of the
//   underlying, theta per calendar day, vega per volatility point.

import { blackScholes } from "./options-chain-greeks.ts";
import {
  atmIv as atmIvOf,
  bsDelta,
  bsPrice,
  DIVIDEND_YIELD,
  halfSpread,
  MULTIPLIER,
  type Right,
  SKEW,
  smileIv,
} from "./options-engine/pricing.ts";

export type VerticalStructure =
  | "callCreditVertical"
  | "callDebitVertical"
  | "putCreditVertical"
  | "putDebitVertical";

export type VerticalPayoff = Readonly<{
  structure: VerticalStructure;
  width: number;
  /** Per share. */
  maxLoss: number;
  maxGain: number;
  breakeven: number;
}>;

export type SpreadGreeks = Readonly<{
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}>;

export type VerticalLegQuote = Readonly<{
  strike: number;
  bid: number;
  ask: number;
  iv: number | null;
  greeks: SpreadGreeks | null;
}>;

type Priced = Readonly<{
  structure: VerticalStructure;
  width: number;
  /** Net per share at the mids (above 0: debit). */
  netMid: number;
  /** Net per share at the worse sides. */
  netWorst: number;
  maxLossPerContract: number;
  maxLossWorstPerContract: number;
  maxGainPerContract: number;
  breakeven: number;
  /** |netMid| as a percent of the width (debit paid or credit taken). */
  netPctWidth: number;
  /** Max gain over max loss at the mids. */
  rewardToRisk: number;
}>;

export type QuotedVertical = Priced &
  Readonly<{
    legs: readonly [
      VerticalLegQuote & Readonly<{ mid: number; side: "long" }>,
      VerticalLegQuote & Readonly<{ mid: number; side: "short" }>,
    ];
    /** Long leg Greeks minus short leg Greeks; null when a leg has none. */
    greeks: SpreadGreeks | null;
  }>;

export type ModelInputs = Readonly<{
  symbol: string;
  spot: number;
  /** Calendar days to expiry (the model uses days / 365). */
  days: number;
  /** Annual rate as a decimal (IRX / 100). */
  rate: number;
  ivIndex: Readonly<{ id: string; level: number }>;
}>;

export type ModelLeg = Readonly<{
  side: "long" | "short";
  strike: number;
  iv: number;
  mid: number;
  delta: number;
}>;

export type ModelVertical = Priced &
  Readonly<{
    legs: readonly [ModelLeg, ModelLeg];
    greeks: SpreadGreeks;
    atmIv: number;
    dividendYield: number;
    skew: number;
  }>;

const positiveStrike = (name: string, value: number): void => {
  if (!(Number.isFinite(value) && value > 0))
    throw new Error(`${name} must be a finite number above 0`);
};

/** Structure, width, max loss, max gain and breakeven per share of a vertical with this net. */
export const verticalPayoff = (
  right: Right,
  longStrike: number,
  shortStrike: number,
  net: number
): VerticalPayoff => {
  positiveStrike("longStrike", longStrike);
  positiveStrike("shortStrike", shortStrike);
  if (!Number.isFinite(net)) throw new Error("net must be a finite number");
  if (longStrike === shortStrike)
    throw new Error("The two strikes must differ");
  const width = Math.abs(longStrike - shortStrike);
  // The long leg is nearer the money when it is the higher put or the lower call.
  const debit =
    right === "put" ? longStrike > shortStrike : longStrike < shortStrike;
  const high = Math.max(longStrike, shortStrike);
  const low = Math.min(longStrike, shortStrike);
  const premium = Math.abs(net);
  if (debit) {
    if (!(net > 0))
      throw new Error(
        "A debit spread (long leg nearer the money) needs a net debit above 0"
      );
    if (!(net < width))
      throw new Error("A debit spread costs less than its width");
  } else {
    if (!(net < 0))
      throw new Error(
        "A credit spread (short leg nearer the money) needs a net credit above 0"
      );
    if (!(premium < width))
      throw new Error("A credit spread takes in less than its width");
  }
  const kind = debit ? "Debit" : "Credit";
  return {
    breakeven: right === "put" ? high - premium : low + premium,
    maxGain: debit ? width - premium : premium,
    maxLoss: debit ? premium : width - premium,
    structure: `${right}${kind}Vertical` as VerticalStructure,
    width,
  };
};

const priced = (
  right: Right,
  longStrike: number,
  shortStrike: number,
  netMid: number,
  netWorst: number
): Priced => {
  const payoff = verticalPayoff(right, longStrike, shortStrike, netMid);
  // Only the mid is validated: on wide quotes the worse-side net can cross 0 or the width. A debit
  // loses what it paid; a credit loses the width minus what it took (credit = -netWorst).
  const debit = payoff.structure === `${right}DebitVertical`;
  const worstLoss = Math.max(0, debit ? netWorst : payoff.width + netWorst);
  return {
    breakeven: payoff.breakeven,
    maxGainPerContract: payoff.maxGain * MULTIPLIER,
    maxLossPerContract: payoff.maxLoss * MULTIPLIER,
    maxLossWorstPerContract: worstLoss * MULTIPLIER,
    netMid,
    netPctWidth: (Math.abs(netMid) / payoff.width) * 100,
    netWorst,
    rewardToRisk: payoff.maxGain / payoff.maxLoss,
    structure: payoff.structure,
    width: payoff.width,
  };
};

const netGreeks = (long: SpreadGreeks, short: SpreadGreeks): SpreadGreeks => ({
  delta: long.delta - short.delta,
  gamma: long.gamma - short.gamma,
  theta: long.theta - short.theta,
  vega: long.vega - short.vega,
});

const checkQuote = (right: Right, quote: VerticalLegQuote): void => {
  const name = `${quote.strike} ${right}`;
  if (
    !(
      Number.isFinite(quote.bid) &&
      Number.isFinite(quote.ask) &&
      quote.bid >= 0 &&
      quote.ask >= 0
    )
  )
    throw new Error(`${name}: bid and ask must be finite numbers, 0 or above`);
  if (quote.bid > quote.ask)
    throw new Error(`${name}: bid must not be above ask`);
};

/** A vertical priced from the quotes of its long and short leg. */
export const priceVerticalFromQuotes = (
  right: Right,
  long: VerticalLegQuote,
  short: VerticalLegQuote
): QuotedVertical => {
  checkQuote(right, long);
  checkQuote(right, short);
  const longMid = (long.bid + long.ask) / 2;
  const shortMid = (short.bid + short.ask) / 2;
  return {
    ...priced(
      right,
      long.strike,
      short.strike,
      longMid - shortMid,
      long.ask - short.bid
    ),
    greeks:
      long.greeks === null || short.greeks === null
        ? null
        : netGreeks(long.greeks, short.greeks),
    legs: [
      { ...long, mid: longMid, side: "long" },
      { ...short, mid: shortMid, side: "short" },
    ],
  };
};

/** A vertical priced with the backtest runner's option model. */
export const priceVerticalFromModel = (
  right: Right,
  longStrike: number,
  shortStrike: number,
  inputs: ModelInputs
): ModelVertical => {
  const { symbol, spot, days, rate, ivIndex } = inputs;
  if (!(Number.isFinite(days) && days > 0))
    throw new Error("days must be a finite number above 0");
  const skew = SKEW.get(symbol);
  if (skew === undefined) throw new Error(`No skew model for ${symbol}`);
  const q = DIVIDEND_YIELD.get(symbol) ?? 0;
  const t = days / 365;
  const atm = atmIvOf(ivIndex.id, ivIndex.level);
  const leg = (side: "long" | "short", strike: number) => {
    const iv = smileIv(atm, spot, strike, t, skew);
    const greeks = blackScholes({
      dividendYield: q,
      rate,
      right,
      spot,
      strike,
      volatility: iv,
      years: t,
    });
    if (greeks === null)
      throw new Error("spot and strikes must be finite numbers above 0");
    const mid = bsPrice(right, spot, strike, t, rate, q, iv);
    const delta = bsDelta(right, spot, strike, t, rate, q, iv);
    const modelLeg: ModelLeg = { delta, iv, mid, side, strike };
    return { greeks, leg: modelLeg };
  };
  const long = leg("long", longStrike);
  const short = leg("short", shortStrike);
  const netMid = long.leg.mid - short.leg.mid;
  const netWorst =
    netMid +
    halfSpread(symbol, long.leg.mid) +
    halfSpread(symbol, short.leg.mid);
  return {
    ...priced(right, longStrike, shortStrike, netMid, netWorst),
    atmIv: atm,
    dividendYield: q,
    greeks: netGreeks(long.greeks, short.greeks),
    legs: [long.leg, short.leg],
    skew,
  };
};
