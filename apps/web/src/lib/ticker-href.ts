// What: tickerHref, the one URL for a ticker symbol: /stock/<SYMBOL> (trimmed, upper case, encoded); isTickerQuery, whether free text looks like a ticker.
// Used by: apps/web/src/components/ticker-link.tsx; apps/web/src/components/command-palette.tsx (Open <TICKER> suggestion).
// See: apps/web/src/app/(portal)/stock (stock detail route).

/** Link to the stock detail page for one symbol. */
export function tickerHref(symbol: string): string {
  return `/stock/${encodeURIComponent(symbol.trim().toUpperCase())}`;
}

/** 1-6 letters, optionally with one class suffix such as BRK.B or BF-B. */
const TICKER_PATTERN = /^[A-Za-z]{1,6}(?:[.-][A-Za-z]{1,2})?$/u;

/** True when free text looks like a ticker symbol. */
export function isTickerQuery(query: string): boolean {
  return TICKER_PATTERN.test(query.trim());
}
