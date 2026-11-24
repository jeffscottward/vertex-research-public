// Pure expected-move calculation from one merged options chain (research only; no I/O, no clock).
// Converts the at-the-money (ATM) straddle price to a one-standard-deviation (±1σ) move via
// √(π/2) ≈ 1.2533, or falls back to spot × ATM IV × √T when market quotes are missing.
// Never conflates live/delayed quotes with Black-Scholes IV estimates.

import type {
  ExpectedMoveBasis,
  ExpectedMoveLegSource,
  OptionContract,
  OptionsChainOutput,
  OptionsChainRow,
  OptionsExpectedMoveBand,
  OptionsExpectedMoveOutput,
} from "./contracts/options-chain.ts";
import { expiryCloseMs, yearsToExpiry } from "./options-chain-greeks.ts";

/** Black-Scholes conversion factor from an ATM straddle price to a 1σ move: √(π / 2) ≈ 1.2533. */
export const STRADDLE_TO_ONE_SIGMA = Math.sqrt(Math.PI / 2);

const RESEARCH_ONLY_NOTE =
  "Research view only. Expected move bands are not a trade signal or order authorization.";
const MAX_NOTES = 10;

export type AtmPairRow = Readonly<{
  strike: number;
  call: OptionContract;
  put: OptionContract;
}>;

/**
 * Selects the strike closest to `spot` that carries both a call and a put contract.
 * Ties break deterministically to the lower strike. Returns null when no paired strike exists.
 */
export const findAtmPairRow = (
  rows: readonly OptionsChainRow[],
  spot: number
): AtmPairRow | null => {
  let best: AtmPairRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.call === null || row.put === null) continue;
    const distance = Math.abs(row.strike - spot);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && row.strike < best.strike)
    ) {
      best = { call: row.call, put: row.put, strike: row.strike };
      bestDistance = distance;
    }
  }
  return best;
};

type PricedLeg = Readonly<{
  kind: "mid" | "last";
  price: number;
  source: ExpectedMoveLegSource;
}>;

// Midpoint requires positive bid and ask >= bid from a named quote source so after-hours zero bids
// never halve a leg price.
const legMid = (contract: OptionContract): PricedLeg | null => {
  if (
    contract.bid === null ||
    contract.ask === null ||
    contract.bid <= 0 ||
    contract.ask < contract.bid ||
    contract.sources.quote === null
  )
    return null;
  return {
    kind: "mid",
    price: (contract.bid + contract.ask) / 2,
    source: contract.sources.quote,
  };
};

// Last trade price comes solely from Yahoo snapshots in options-chain-merge.ts.
const legQuoteOrLast = (contract: OptionContract): PricedLeg | null => {
  const mid = legMid(contract);
  if (mid !== null) return mid;
  if (contract.last !== null && contract.last > 0)
    return { kind: "last", price: contract.last, source: "yahoo" };
  return null;
};

/** Average of strictly positive ATM leg implied volatilities, or null when neither leg reports one. */
const atmImpliedVol = (
  call: OptionContract,
  put: OptionContract
): number | null => {
  const values = [call.iv, put.iv].filter(
    (value): value is number => value !== null && value > 0
  );
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const buildNotes = (
  basisNote: string | null,
  chainNotes: readonly string[]
): string[] => {
  const ordered = [
    ...(basisNote === null ? [] : [basisNote]),
    RESEARCH_ONLY_NOTE,
    ...chainNotes,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of ordered) {
    if (seen.has(note)) continue;
    seen.add(note);
    result.push(note);
    if (result.length >= MAX_NOTES) break;
  }
  return result;
};

const basisDescription = (basis: ExpectedMoveBasis): string => {
  if (basis === "atm_straddle_mid")
    return "1σ expected move = ATM straddle midpoint × √(π/2) (~1.253×); breakeven = ±1× straddle.";
  if (basis === "atm_straddle_last")
    return "1σ expected move = ATM straddle (using last trade where two-sided quotes are absent) × √(π/2) (~1.253×).";
  return "Estimated from spot × ATM IV × √T (ACT/365 to 16:00 New York); no two-sided ATM straddle quotes available.";
};

const quoteEnvelope = (chain: OptionsChainOutput) => ({
  currency: chain.currency,
  dte: chain.dte,
  expiries: chain.expiries,
  expiriesSources: chain.expiriesSources,
  expiry: chain.expiry,
  quoteTime: chain.quoteTime,
  receivedAt: chain.receivedAt,
  sources: chain.sources,
  spot: chain.spot,
  spotSource: chain.spotSource,
  symbol: chain.symbol,
});

const unavailable = (
  chain: OptionsChainOutput,
  reason: string
): OptionsExpectedMoveOutput => ({
  ...quoteEnvelope(chain),
  band: null,
  notes: buildNotes(null, chain.notes),
  unavailableReason: reason,
});

const resolveReferenceTime = (
  chain: OptionsChainOutput,
  now?: Date
): Date | null => {
  const candidate = now ?? new Date(chain.receivedAt);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
};

const buildBand = (
  chain: OptionsChainOutput,
  spot: number,
  years: number,
  pair: AtmPairRow
): OptionsExpectedMoveBand | null => {
  const closeMs = expiryCloseMs(chain.expiry);
  const closeAt = new Date(closeMs).toISOString();
  const atmIv = atmImpliedVol(pair.call, pair.put);

  const callLeg = legQuoteOrLast(pair.call);
  const putLeg = legQuoteOrLast(pair.put);
  if (callLeg !== null && putLeg !== null) {
    const straddlePrice = callLeg.price + putLeg.price;
    const expectedMove = straddlePrice * STRADDLE_TO_ONE_SIGMA;
    const basis: ExpectedMoveBasis =
      callLeg.kind === "mid" && putLeg.kind === "mid"
        ? "atm_straddle_mid"
        : "atm_straddle_last";
    return {
      atmIv,
      atmStrike: pair.strike,
      basis,
      callPrice: callLeg.price,
      callQuoteSource: callLeg.source,
      expectedMove,
      expectedMovePct: expectedMove / spot,
      expiryCloseAt: closeAt,
      expiryCloseMs: closeMs,
      lowerBand: Math.max(0, spot - expectedMove),
      putPrice: putLeg.price,
      putQuoteSource: putLeg.source,
      straddleLower: Math.max(0, spot - straddlePrice),
      straddlePct: straddlePrice / spot,
      straddlePrice,
      straddleUpper: spot + straddlePrice,
      upperBand: spot + expectedMove,
    };
  }

  if (atmIv !== null) {
    const expectedMove = spot * atmIv * Math.sqrt(years);
    return {
      atmIv,
      atmStrike: pair.strike,
      basis: "atm_iv_model",
      callPrice: null,
      callQuoteSource: null,
      expectedMove,
      expectedMovePct: expectedMove / spot,
      expiryCloseAt: closeAt,
      expiryCloseMs: closeMs,
      lowerBand: Math.max(0, spot - expectedMove),
      putPrice: null,
      putQuoteSource: null,
      straddleLower: null,
      straddlePct: null,
      straddlePrice: null,
      straddleUpper: null,
      upperBand: spot + expectedMove,
    };
  }

  return null;
};

/**
 * Derives the per-expiry ±1σ expected move bands and ATM straddle breakevens from one merged
 * options chain snapshot. Pure and deterministic; never throws on incomplete chains.
 */
export const computeOptionsExpectedMove = (
  chain: OptionsChainOutput,
  now?: Date
): OptionsExpectedMoveOutput => {
  if (chain.spot === null || !Number.isFinite(chain.spot) || chain.spot <= 0)
    return unavailable(
      chain,
      "Underlying spot price is missing from this options chain snapshot."
    );
  const reference = resolveReferenceTime(chain, now);
  if (reference === null)
    return unavailable(
      chain,
      "Chain snapshot timestamp is invalid; cannot determine time to expiry."
    );
  const years = yearsToExpiry(chain.expiry, reference);
  if (!(years > 0))
    return unavailable(
      chain,
      `Expiry ${chain.expiry} has already closed (16:00 New York).`
    );
  const pair = findAtmPairRow(chain.rows, chain.spot);
  if (pair === null)
    return unavailable(
      chain,
      `No strike in ${chain.expiry} carries both a call and a put contract.`
    );
  const band = buildBand(chain, chain.spot, years, pair);
  if (band === null)
    return unavailable(
      chain,
      `ATM strike ${pair.strike} has neither usable call/put quotes nor implied volatility.`
    );
  return {
    ...quoteEnvelope(chain),
    band,
    notes: buildNotes(basisDescription(band.basis), chain.notes),
    unavailableReason: null,
  };
};
