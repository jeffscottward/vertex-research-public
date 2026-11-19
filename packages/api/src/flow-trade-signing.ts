// What: signs IBKR trade prints as buyer- or seller-initiated. Quote rule first (the latest
// bid/ask at or before the print: price >= ask is a buy, price <= bid is a sell); prints inside
// the spread, or with no usable quote, fall back to the tick rule (compare with the previous
// different trade price). Each print keeps the method used so the UI can say which rule applied.
// The streamed tape (signTape) uses the same two rules; each of its prints carries its own quote.
// Used by: the flow pipeline (server/flow-collect.ts) and the web order-flow panel (apps/web
// features/order-flow footprint, delta, time & sales).
import type {
  MarketQuoteTick,
  MarketTradeTick,
} from "./contracts/market-data.ts";

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
  bid: number | null,
  ask: number | null
): "buy" | "sell" | null => {
  if (
    bid === null ||
    ask === null ||
    !(Number.isFinite(bid) && Number.isFinite(ask)) ||
    bid <= 0 ||
    ask <= bid
  )
    return null;
  if (price >= ask) return "buy";
  return price <= bid ? "sell" : null;
};

/**
 * The tick rule of one pass over prints in time order. The returned function takes the price of
 * the next print and compares it with the last earlier price that differs from it (a repeat of the
 * last price keeps the reference from before the repeat). It returns null while no different
 * earlier price exists. seed is the price of the print before the first print, or null.
 */
const tickRuleFrom = (
  seed: number | null
): ((price: number) => "buy" | "sell" | null) => {
  let previousDifferent: number | null = null;
  let lastPrice = seed;
  return (price) => {
    if (lastPrice !== null && lastPrice !== price)
      previousDifferent = lastPrice;
    lastPrice = price;
    if (previousDifferent === null) return null;
    return price > previousDifferent ? "buy" : "sell";
  };
};

/** The quote rule wins; else the tick rule; else no side. */
const sideAndMethod = (
  byQuote: "buy" | "sell" | null,
  byTick: "buy" | "sell" | null
): Readonly<{ side: TradeSide; method: SigningMethod }> => {
  if (byQuote !== null) return { method: "quote", side: byQuote };
  if (byTick !== null) return { method: "tick", side: byTick };
  return { method: "none", side: "unknown" };
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
  const tickRule = tickRuleFrom(null);
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
      // The tick rule reads every print, also a print that the quote rule signs.
      const byTick = tickRule(trade.p);
      const bid = quote?.bp ?? null;
      const ask = quote?.ap ?? null;
      const { method, side } = sideAndMethod(
        quoteRuleSide(trade.p, bid, ask),
        byTick
      );
      return {
        ask,
        bid,
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

/** One print of the streamed tape: exchange second, price, size, bid and ask at the print. */
export type TapePrint = readonly [
  t: number,
  price: number,
  size: number,
  bid: number | null,
  ask: number | null,
];

/**
 * Signs the prints of the streamed tape in their given order (oldest first). Each print carries
 * the bid and ask that were in force when it arrived (null before the first quote message). The
 * quote rule gives the method "quote"; else the tick rule gives "tick"; else the print has the
 * method "none" and the side "unknown". previousPrice is the price of the newest print before the
 * first print (or null): it seeds the tick rule, so a second read signs a print the same way.
 */
export const signTape = (
  prints: readonly TapePrint[],
  previousPrice: number | null
): SignedTrade[] => {
  const tickRule = tickRuleFrom(previousPrice);
  return prints.map(([t, price, size, bid, ask]) => {
    const byTick = tickRule(price);
    const { method, side } = sideAndMethod(
      quoteRuleSide(price, bid, ask),
      byTick
    );
    return {
      ask,
      bid,
      conditions: null,
      method,
      price,
      side,
      size,
      t,
      venue: null,
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
