import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  OptionContract,
  OptionsChainExpiriesOutput,
  OptionsChainOutput,
  OptionsChainRow,
} from "../contracts/options-chain.ts";
import {
  blackScholes,
  daysToExpiry,
  expiryCloseMs,
  type OptionRight,
  yearsToExpiry,
} from "../options-chain-greeks.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type OptionQuote,
  type OptionsChainSnapshot,
  type OptionsChainSource,
  OptionsChainSourceError,
} from "./options-chain-source.ts";
import { createYahooOptionsSource } from "./options-chain-yahoo.ts";

// Read-only options chain (optionsChain.expiries, optionsChain.chain). Reads one provider
// snapshot per symbol and expiry through the OptionsChainSource port (Yahoo by default),
// caches it for 60 s and adds Black-Scholes Greeks from the provider IV. Operator-only.
// Nothing here can place, change or cancel orders.

/** Fixed risk-free rate assumption for the Greeks (continuously compounded, decimal). */
export const OPTIONS_CHAIN_RISK_FREE_RATE = 0.04;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = Readonly<{
  at: number;
  value: Promise<OptionsChainSnapshot>;
}>;

let source: OptionsChainSource | null = null;
const systemClock = (): Date => new Date();
let clock = systemClock;
const cache = new Map<string, CacheEntry>();

/** Test seam: replaces the adapter and clock and clears the cache. */
export const setOptionsChainForTesting = (
  options: Readonly<{ source?: OptionsChainSource; now?: () => Date }> = {}
): void => {
  source = options.source ?? null;
  clock = options.now ?? systemClock;
  cache.clear();
};

const readSnapshot = (
  symbol: string,
  expiry: string | undefined,
  now: Date
): Promise<OptionsChainSnapshot> => {
  const key = `${symbol}|${expiry ?? "nearest"}`;
  const hit = cache.get(key);
  if (hit !== undefined && now.getTime() - hit.at < CACHE_TTL_MS)
    return hit.value;
  source ??= createYahooOptionsSource();
  const value = source.read(symbol, expiry);
  cache.delete(key);
  cache.set(key, { at: now.getTime(), value });
  // Failures are not cached.
  value.catch(() => cache.delete(key));
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(oldest);
  }
  return value;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const percent = (value: number): string => `${(value * 100).toFixed(2)} %`;

// Expiries that have not closed yet (16:00 New York), plus `keep` (the expiry being shown).
const quoteFields = (
  snapshot: OptionsChainSnapshot,
  now: Date,
  keep: string | null = null
): OptionsChainExpiriesOutput => {
  const today = isoDay(now);
  return {
    currency: snapshot.currency,
    expiries: snapshot.expiries
      .filter((date) => date === keep || expiryCloseMs(date) > now.getTime())
      .map((date) => ({ date, dte: daysToExpiry(date, today) })),
    quoteTime: snapshot.quoteTime,
    receivedAt: now.toISOString(),
    source: "yahoo",
    spot: snapshot.spot,
    symbol: snapshot.symbol,
  };
};

/** Builds the chain response: rows by strike, calls and puts side by side, with Greeks. */
export const buildOptionsChain = (
  snapshot: OptionsChainSnapshot,
  expiry: string,
  now: Date
): OptionsChainOutput => {
  const rate = OPTIONS_CHAIN_RISK_FREE_RATE;
  const dividendYield = snapshot.dividendYield ?? 0;
  const years = yearsToExpiry(expiry, now);
  let missingIv = 0;
  const contract = (quote: OptionQuote, right: OptionRight): OptionContract => {
    const result =
      snapshot.spot === null || quote.iv === null
        ? null
        : blackScholes({
            dividendYield,
            rate,
            right,
            spot: snapshot.spot,
            strike: quote.strike,
            volatility: quote.iv,
            years,
          });
    if (quote.iv === null) missingIv += 1;
    const { strike: _strike, ...fields } = quote;
    return {
      ...fields,
      greeks:
        result === null
          ? null
          : {
              delta: result.delta,
              gamma: result.gamma,
              rho: result.rho,
              theta: result.theta,
              vega: result.vega,
            },
    };
  };
  const byStrike = new Map<number, OptionsChainRow>();
  const row = (strike: number): OptionsChainRow =>
    byStrike.get(strike) ?? { call: null, put: null, strike };
  for (const quote of snapshot.calls)
    byStrike.set(quote.strike, {
      ...row(quote.strike),
      call: contract(quote, "call"),
    });
  for (const quote of snapshot.puts)
    byStrike.set(quote.strike, {
      ...row(quote.strike),
      put: contract(quote, "put"),
    });
  const notes = [
    "Quotes come from Yahoo Finance and can be delayed by 15 minutes or more. Bid and ask can show 0 outside market hours.",
    `Greeks are calculated here with Black-Scholes (European exercise) from the Yahoo IV: risk-free rate ${percent(rate)} (fixed assumption), dividend yield ${percent(dividendYield)} (trailing), time to 16:00 New York on the expiry day.`,
    "US stock options are American-style. The model does not include early exercise.",
    ...(missingIv > 0
      ? [`${missingIv} contracts have no usable IV, so they show no Greeks.`]
      : []),
    ...(snapshot.spot === null
      ? ["No spot price is available, so no Greeks are shown."]
      : []),
    ...(years <= 0 ? ["This expiry has closed, so no Greeks are shown."] : []),
    "Read-only market data for research. It is not a trading signal.",
  ];
  const fields = quoteFields(snapshot, now, expiry);
  return {
    ...fields,
    assumptions: {
      dayCount: "act/365",
      dividendYield,
      model: "black-scholes-european",
      riskFreeRate: rate,
    },
    dte: daysToExpiry(expiry, isoDay(now)),
    expiry,
    notes,
    rows: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
  };
};

const api = implement(appContract).$context<ApiContext>();

type ChainErrors = Readonly<
  Record<
    OptionsChainSourceError["code"],
    (options: { message: string }) => Error
  >
>;

const mapFailure = (error: unknown, errors: ChainErrors): Error =>
  error instanceof OptionsChainSourceError
    ? errors[error.code]({ message: error.message })
    : errors.UNAVAILABLE({ message: "Options data source unavailable" });

const expiries = api.optionsChain.expiries
  .use(requireOperator)
  .handler(async ({ input, errors }) => {
    const now = clock();
    try {
      return quoteFields(await readSnapshot(input.symbol, undefined, now), now);
    } catch (error) {
      throw mapFailure(error, errors);
    }
  });

const chain = api.optionsChain.chain
  .use(requireOperator)
  .handler(async ({ input, errors }) => {
    const now = clock();
    let snapshot: OptionsChainSnapshot;
    try {
      snapshot = await readSnapshot(input.symbol, input.expiry, now);
      // After the close the provider can still list today's expiry first: show the next one.
      const shown = snapshot.expiry;
      const next = snapshot.expiries.find(
        (date) => expiryCloseMs(date) > now.getTime()
      );
      if (
        input.expiry === undefined &&
        shown !== null &&
        expiryCloseMs(shown) <= now.getTime() &&
        next !== undefined
      )
        snapshot = await readSnapshot(input.symbol, next, now);
    } catch (error) {
      throw mapFailure(error, errors);
    }
    const expiry = snapshot.expiry;
    if (expiry === null || (input.expiry ?? expiry) !== expiry)
      throw errors.NOT_FOUND({
        message:
          input.expiry === undefined
            ? `No listed options for ${input.symbol}`
            : `No ${input.symbol} options expire on ${input.expiry}`,
      });
    return buildOptionsChain(snapshot, expiry, now);
  });

export const optionsChainRouter = { expiries, chain };
