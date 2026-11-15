// Ports for the read-only options chain (optionsChain.*). Three sources, merged by
// options-chain-merge.ts in the order of OPTIONS_CHAIN_PRIORITY (Quant Data, IBKR, Yahoo):
// - OptionsAnalyticsSource: IV, delta, open interest and order flow per contract of every
//   expiry, and the underlying price. Adapter: options-chain-quantdata.ts.
// - OptionsQuoteSource: live bid and ask only. Adapter: options-chain-ibkr.ts.
// - OptionsChainSource: one full provider snapshot (the quote, every listed expiry and the
//   contracts of one expiry). Adapter: options-chain-yahoo.ts.
// Greeks are computed by the merge, never by an adapter. Dates are YYYY-MM-DD.

import type { OptionRight } from "../options-chain-greeks.ts";

export type OptionQuote = Readonly<{
  contractSymbol: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  change: number | null;
  volume: number | null;
  openInterest: number | null;
  // Provider implied volatility as a decimal; null when missing.
  iv: number | null;
  inTheMoney: boolean;
  lastTradeAt: string | null;
}>;

export type OptionsChainSnapshot = Readonly<{
  symbol: string;
  currency: string | null;
  spot: number | null;
  quoteTime: string | null;
  // Trailing annual dividend yield as a decimal; null when the provider has none.
  dividendYield: number | null;
  // Every listed expiry (YYYY-MM-DD), ascending.
  expiries: readonly string[];
  // Expiry of `calls` and `puts`; null when the symbol lists no options.
  expiry: string | null;
  calls: readonly OptionQuote[];
  puts: readonly OptionQuote[];
}>;

export interface OptionsChainSource {
  /** Reads one expiry (YYYY-MM-DD), or the nearest listed expiry when omitted. */
  readonly read: (
    symbol: string,
    expiry?: string
  ) => Promise<OptionsChainSnapshot>;
}

/** One live two-sided quote. Sources return only usable quotes (ask > 0, ask >= bid >= 0). */
export type OptionsLiveQuote = Readonly<{
  strike: number;
  right: OptionRight;
  bid: number;
  ask: number;
}>;

export type OptionsQuoteSnapshot = Readonly<{
  // Expiry of `quotes`.
  expiry: string;
  // Every listed expiry, ascending.
  expiries: readonly string[];
  // Live underlying price; null when the source has none.
  spot: number | null;
  // When the source took the quotes (ISO-8601 UTC).
  asOf: string;
  quotes: readonly OptionsLiveQuote[];
  // Why the snapshot holds no live value although the source answered. Safe to show.
  warning: string | null;
}>;

export interface OptionsQuoteSource {
  /**
   * Reads live quotes of one expiry, or of the nearest open expiry when omitted. Throws
   * OptionsChainSourceOff when the source is not asked, OptionsChainSourceError on failure.
   */
  readonly read: (
    symbol: string,
    expiry?: string
  ) => Promise<OptionsQuoteSnapshot>;
}

/** Order-flow prints of one contract in the flow window. */
export type OptionsContractFlow = Readonly<{
  premium: number;
  trades: number;
  // Contracts traded by those prints.
  volume: number;
}>;

export type OptionsAnalyticsRow = Readonly<{
  expiry: string;
  strike: number;
  right: OptionRight;
  // Implied volatility as a decimal.
  iv: number | null;
  delta: number | null;
  openInterest: number | null;
  flow: OptionsContractFlow | null;
}>;

export type OptionsAnalyticsSnapshot = Readonly<{
  spot: number | null;
  // Every expiry that has at least one row, ascending.
  expiries: readonly string[];
  // The contracts of every expiry. Each row has at least one value.
  rows: readonly OptionsAnalyticsRow[];
  // True when the order-flow answer had more pages than the one read: `flow` and
  // `openInterest` then cover the first provider page only.
  flowFirstPageOnly: boolean;
  // Set when one of the source's requests failed and the rest answered, or when the flow is
  // the first provider page only. Safe to show.
  warning: string | null;
}>;

export interface OptionsAnalyticsSource {
  /** Reads the analytics of every expiry. Throws OptionsChainSourceError when every request failed. */
  readonly read: (symbol: string) => Promise<OptionsAnalyticsSnapshot>;
}

export type OptionsChainSourceErrorCode =
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "UNAVAILABLE";

/** Typed adapter failure. The message is safe to show: no URL, cookie or crumb. */
export class OptionsChainSourceError extends Error {
  readonly code: OptionsChainSourceErrorCode;
  constructor(code: OptionsChainSourceErrorCode, message: string) {
    super(message);
    this.name = "OptionsChainSourceError";
    this.code = code;
  }
}

/** The source was not asked (not configured, or outside its hours). The message is safe to show. */
export class OptionsChainSourceOff extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionsChainSourceOff";
  }
}
