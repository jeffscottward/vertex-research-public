// What: signs IBKR trade prints as buyer- or seller-initiated. Quote rule first (the latest
// bid/ask at or before the print: price >= ask is a buy, price <= bid is a sell); prints inside
// the spread, or with no usable quote, fall back to the tick rule (compare with the previous
// different trade price). Each print keeps the method used so the UI can say which rule applied.
// Used by: footprint.ts, delta.ts, time-and-sales.ts, components/portal/order-flow-panel.tsx.
import type { MarketQuoteTick, MarketTradeTick } from "@darkfactory/api";

export type TradeSide = "buy" | "sell" | "unknown";
/** quote: quote rule; tick: tick rule; none: no quote and no earlier different price. */
export type SigningMethod = "quote" | "tick" | "none";

export type SignedTrade = Readonly<{
  t: number;
  price: number;
  size: number;
  venue: string | null;
  conditions: string | null;
  side: TradeSide;
  method: SigningMethod;
  /** The quote in force at the print (null when none was at or before it). */
  bid: number | null;
  ask: number | null;
}>;

export type SigningCounts = Readonly<{
  quote: number;
  tick: number;
  none: number;
  buy: number;
  sell: number;
  unknown: number;
}>;

export const SIGNING_METHOD_LABELS: Readonly<Record<SigningMethod, string>> =
  Object.freeze({ none: "unsigned", quote: "quote rule", tick: "tick rule" });

/**
 * The quote rule alone: buy at or above the ask, sell at or below the bid, null inside the
 * spread or when the quote is missing, locked (bid == ask), crossed or empty.
 */
const quoteRuleSide = (
  price: number,
  quote: MarketQuoteTick | undefined
): "buy" | "sell" | null => {
  if (
    quote === undefined ||
    !(Number.isFinite(quote.bp) && Number.isFinite(quote.ap)) ||
    quote.bp <= 0 ||
    quote.ap <= quote.bp
  )
    return null;
  if (price >= quote.ap) return "buy";
  return price <= quote.bp ? "sell" : null;
};

const QUOTE_MAX_AGE_SECONDS = 5;

/**
 * Signs every print, oldest first. Quotes are matched by time (seconds): a quote stamped in
 * the same second as the print counts as "at or before" it. A quote more than 5 s older than the
 * print is ignored, so that print falls back to the tick rule.
 */
export const signTrades = (
  trades: readonly MarketTradeTick[],
  quotes: readonly MarketQuoteTick[]
): SignedTrade[] => {
  // Array sort is stable, so prints in the same second keep IBKR's order.
  const orderedQuotes = [...quotes].sort((a, b) => a.t - b.t);
  let quoteIndex = -1;
  let previousDifferent: number | null = null;
  let lastPrice: number | null = null;
  return [...trades]
    .sort((a, b) => a.t - b.t)
    .map((trade) => {
      // Past the last quote the lookup is undefined, which compares as never-before.
      while (
        (orderedQuotes[quoteIndex + 1]?.t ?? Number.POSITIVE_INFINITY) <=
        trade.t
      )
        quoteIndex += 1;
      const latest = orderedQuotes[quoteIndex];
      // A quote more than QUOTE_MAX_AGE_SECONDS older than the print no longer describes the
      // market it traded into: treat it as missing (tick rule).
      const quote =
        latest !== undefined && trade.t - latest.t <= QUOTE_MAX_AGE_SECONDS
          ? latest
          : undefined;
      // Tick-rule reference: the last earlier price that differs from this print's price
      // (a repeat of the last price keeps the reference from before the repeat).
      if (lastPrice !== null && lastPrice !== trade.p)
        previousDifferent = lastPrice;
      lastPrice = trade.p;
      const byQuote = quoteRuleSide(trade.p, quote);
      let side: TradeSide = byQuote ?? "unknown";
      let method: SigningMethod = byQuote === null ? "none" : "quote";
      if (byQuote === null && previousDifferent !== null) {
        side = trade.p > previousDifferent ? "buy" : "sell";
        method = "tick";
      }
      return {
        ask: quote?.ap ?? null,
        bid: quote?.bp ?? null,
        conditions: trade.c,
        method,
        price: trade.p,
        side,
        size: trade.s,
        t: trade.t,
        venue: trade.x,
      };
    });
};

export const countSigning = (trades: readonly SignedTrade[]): SigningCounts => {
  const counts = { buy: 0, none: 0, quote: 0, sell: 0, tick: 0, unknown: 0 };
  for (const trade of trades) {
    counts[trade.method] += 1;
    counts[trade.side] += 1;
  }
  return counts;
};

/** "412 quote rule · 80 tick rule · 8 unsigned" (zero counts left out). */
export const describeSigning = (counts: SigningCounts): string => {
  const parts = (["quote", "tick", "none"] as const)
    .filter((method) => counts[method] > 0)
    .map((method) => `${counts[method]} ${SIGNING_METHOD_LABELS[method]}`);
  return parts.length === 0 ? "no trades" : parts.join(" · ");
};
