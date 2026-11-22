// Builds the optionsChain.spread answer from one merged chain and the latest stored closes of the
// symbol's IV index and IRX (research only; no order is placed). Pure: the handler in
// options-chain.ts reads the chain (cached) and the closes.
// - Quotes: the two legs of the chain row at each strike, priced by vertical-spread.ts. A leg without
//   a bid and an ask, or a net outside 0..width, gives no quote price and a reason.
// - Model: the backtest runner's option model (vertical-spread.ts priceVerticalFromModel) at the
//   chain's spot and calendar days to expiry, with the latest IV index and IRX closes. A symbol
//   without an IV index (STRATEGY_IV_INDEX: the Core 7), a missing spot or close, a close older than
//   MODEL_INPUT_MAX_AGE_DAYS, or expiry today gives no model price and a reason.

import type { MarketDailyLatestPoint } from "@darkfactory/db/server";

import type {
  OptionContract,
  OptionsChainOutput,
  OptionsSpreadModel,
  OptionsSpreadOutput,
  OptionsSpreadParsedInput,
  OptionsSpreadQuotes,
} from "../contracts/options-chain.ts";
import { STRATEGY_IV_INDEX } from "../strategy-dsl.ts";
import {
  type ModelVertical,
  priceVerticalFromModel,
  priceVerticalFromQuotes,
  type QuotedVertical,
  type VerticalLegQuote,
} from "../vertical-spread.ts";

/** Oldest stored IV index or IRX close the model uses, in calendar days before the answer date. */
export const MODEL_INPUT_MAX_AGE_DAYS = 7;

const DAY_MS = 86_400_000;

type Part<T> = Readonly<{ value: T | null; reason: string | null }>;

const missing = <T>(reason: string): Part<T> => ({ reason, value: null });

// The message of a pricing refusal (vertical-spread.ts throws Error), without the "Error: " prefix.
const failure = (error: unknown): string =>
  String(error)
    .replace(/^Error: /u, "")
    .slice(0, 200);

const legOf = (
  chain: OptionsChainOutput,
  right: "put" | "call",
  strike: number
): Part<OptionContract> => {
  const row = chain.rows.find((candidate) => candidate.strike === strike);
  const contract = row === undefined ? null : row[right];
  if (contract === null)
    return missing(`No ${strike} ${right} in the ${chain.expiry} chain`);
  if (contract.bid === null || contract.ask === null)
    return missing(`No bid and ask for the ${strike} ${right}`);
  return { reason: null, value: contract };
};

const quoteOf = (
  strike: number,
  contract: OptionContract
): VerticalLegQuote => ({
  ask: contract.ask as number,
  bid: contract.bid as number,
  greeks: contract.greeks,
  iv: contract.iv,
  strike,
});

const quotesPart = (
  chain: OptionsChainOutput,
  input: OptionsSpreadParsedInput
): Part<OptionsSpreadQuotes> => {
  const long = legOf(chain, input.right, input.longStrike);
  if (long.value === null) return missing(long.reason as string);
  const short = legOf(chain, input.right, input.shortStrike);
  if (short.value === null) return missing(short.reason as string);
  let priced: QuotedVertical;
  try {
    priced = priceVerticalFromQuotes(
      input.right,
      quoteOf(input.longStrike, long.value),
      quoteOf(input.shortStrike, short.value)
    );
  } catch (error) {
    return missing(failure(error));
  }
  const greeksOf = (contract: OptionContract) =>
    contract.greeks === null
      ? null
      : {
          delta: contract.greeks.delta,
          gamma: contract.greeks.gamma,
          theta: contract.greeks.theta,
          vega: contract.greeks.vega,
        };
  const leg = (
    side: "long" | "short",
    strike: number,
    contract: OptionContract,
    mid: number
  ) => ({
    ask: contract.ask as number,
    bid: contract.bid as number,
    greeks: greeksOf(contract),
    iv: contract.iv,
    lastTradeAt: contract.lastTradeAt,
    mid,
    quoteSource: contract.sources.quote,
    side,
    strike,
  });
  return {
    reason: null,
    value: {
      breakeven: priced.breakeven,
      greeks: priced.greeks,
      legs: [
        leg("long", input.longStrike, long.value, priced.legs[0].mid),
        leg("short", input.shortStrike, short.value, priced.legs[1].mid),
      ],
      maxGainPerContract: priced.maxGainPerContract,
      maxLossPerContract: priced.maxLossPerContract,
      maxLossWorstPerContract: priced.maxLossWorstPerContract,
      netMid: priced.netMid,
      netPctWidth: priced.netPctWidth,
      netWorst: priced.netWorst,
      rewardToRisk: priced.rewardToRisk,
      structure: priced.structure,
      width: priced.width,
    },
  };
};

const ageDays = (asOf: string, today: string): number =>
  Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) /
      DAY_MS
  );

const modelPart = (
  chain: OptionsChainOutput,
  input: OptionsSpreadParsedInput,
  points: readonly MarketDailyLatestPoint[] | null
): Part<OptionsSpreadModel> => {
  const indexId = STRATEGY_IV_INDEX[input.symbol];
  if (indexId === undefined)
    return missing(
      `No option model for ${input.symbol}; it covers ${Object.keys(STRATEGY_IV_INDEX).join(", ")}`
    );
  if (points === null)
    return missing("The stored daily series are not available");
  if (chain.spot === null) return missing("The chain has no spot price");
  if (chain.dte === 0)
    return missing("The spread expires today; the model needs at least 1 day");
  const today = chain.receivedAt.slice(0, 10);
  const close = (id: string): Part<MarketDailyLatestPoint> => {
    const point = points.find((candidate) => candidate.id === id);
    if (point === undefined) return missing(`No stored ${id} close`);
    if (ageDays(point.lastDate, today) > MODEL_INPUT_MAX_AGE_DAYS)
      return missing(
        `The stored ${id} close of ${point.lastDate} is more than ${MODEL_INPUT_MAX_AGE_DAYS} days old`
      );
    return { reason: null, value: point };
  };
  const level = close(indexId);
  if (level.value === null) return missing(level.reason as string);
  const irx = close("IRX");
  if (irx.value === null) return missing(irx.reason as string);
  const inputs = {
    days: chain.dte,
    ivIndex: { id: indexId, level: level.value.close },
    rate: irx.value.close / 100,
    spot: chain.spot,
    symbol: input.symbol,
  };
  let priced: ModelVertical;
  try {
    priced = priceVerticalFromModel(
      input.right,
      input.longStrike,
      input.shortStrike,
      inputs
    );
  } catch (error) {
    return missing(failure(error));
  }
  return {
    reason: null,
    value: {
      breakeven: priced.breakeven,
      greeks: priced.greeks,
      inputs: {
        atmIv: priced.atmIv,
        days: chain.dte,
        dividendYield: priced.dividendYield,
        ivIndex: indexId,
        ivIndexAsOf: level.value.lastDate,
        ivIndexLevel: level.value.close,
        rate: inputs.rate,
        rateAsOf: irx.value.lastDate,
        skew: priced.skew,
        spot: chain.spot,
      },
      legs: [{ ...priced.legs[0] }, { ...priced.legs[1] }] as const,
      maxGainPerContract: priced.maxGainPerContract,
      maxLossPerContract: priced.maxLossPerContract,
      maxLossWorstPerContract: priced.maxLossWorstPerContract,
      netMid: priced.netMid,
      netPctWidth: priced.netPctWidth,
      netWorst: priced.netWorst,
      rewardToRisk: priced.rewardToRisk,
      structure: priced.structure,
      width: priced.width,
    },
  };
};

/** The optionsChain.spread answer for one merged chain and the latest stored closes (null: none). */
export const buildOptionsSpread = (
  chain: OptionsChainOutput,
  input: OptionsSpreadParsedInput,
  points: readonly MarketDailyLatestPoint[] | null
): OptionsSpreadOutput => {
  const quotes = quotesPart(chain, input);
  const model = modelPart(chain, input, points);
  return {
    dte: chain.dte,
    expiry: chain.expiry,
    model: model.value,
    modelUnavailable: model.reason,
    modelVsMidPct:
      quotes.value === null || model.value === null
        ? null
        : (model.value.netMid / quotes.value.netMid - 1) * 100,
    quoteTime: chain.quoteTime,
    quotes: quotes.value,
    quotesUnavailable: quotes.reason,
    receivedAt: chain.receivedAt,
    right: input.right,
    spot: chain.spot,
    spotSource: chain.spotSource,
    symbol: chain.symbol,
  };
};
