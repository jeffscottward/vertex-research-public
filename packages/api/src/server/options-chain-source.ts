// Port for the read-only options chain (optionsChain.*). An adapter returns one provider
// snapshot: the quote, every listed expiry and the contracts of one expiry. Greeks are
// computed by the service, never by the adapter. Adapters: options-chain-yahoo.ts.

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
