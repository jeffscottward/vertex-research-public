// Reads and writes the `?symbol=<TICKER>` deep link on /charts.
// Used by: apps/web/src/components/portal/charts-workspace.tsx.

import { MarketSymbolSchema } from "@darkfactory/api";

const SYMBOL_PARAM = "symbol";

export type SymbolParam =
  | Readonly<{ type: "none" }>
  | Readonly<{ type: "valid"; symbol: string }>
  | Readonly<{ type: "invalid"; raw: string }>;

/** True when the bars request contract accepts `symbol` (BRK.B yes, BF-B no). */
export const isLinkableSymbol = (symbol: string): boolean =>
  MarketSymbolSchema.safeParse(symbol).success;

export const parseSymbolParam = (search: string): SymbolParam => {
  const raw = new URLSearchParams(search).get(SYMBOL_PARAM);
  if (raw === null || raw.trim() === "") return { type: "none" };
  const symbol = raw.trim().toUpperCase();
  return isLinkableSymbol(symbol)
    ? { symbol, type: "valid" }
    : { raw: raw.slice(0, 40), type: "invalid" };
};

/** Returns `search` with the symbol param set, keeping other params. */
export const withSymbolParam = (search: string, symbol: string): string => {
  const params = new URLSearchParams(search);
  params.set(SYMBOL_PARAM, symbol);
  return `?${params.toString()}`;
};
