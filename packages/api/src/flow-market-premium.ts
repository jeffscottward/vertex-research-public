// What: the QuantData gainers-losers request body (filter profile premium-gte-100k.v1) and the mapper
// of the answer into one row per ticker. Pure; the market_premium source of flow.collect
// (server/flow-market-premium-collect.ts) sends the request and stores the rows in flow_market_premium.
// Vendor shape: one map keyed by ticker with the session totals of the trades that pass the filter;
// the filter applies to each trade before QuantData adds them up. Multi-leg (complex) trades count,
// each leg as its own trade, as in QuantData's own tool (62% of the large-trade premium on
// 2026-11-19); the filter profile names this choice.
// Doc: docs/vertex-rebuild/flow-pipeline.md (section "Market premium").
import { z } from "zod";

import { TICKER_SYMBOL_PATTERN } from "./contracts/openbb.ts";

export const MARKET_PREMIUM_FILTER_PROFILE = "premium-gte-100k.v1";
/** Each counted trade has at least this premium in US dollars. */
const MARKET_PREMIUM_MIN_TRADE_PREMIUM = 100_000;
/**
 * A complete session with fewer tickers than this is a market holiday (2025-11-27 answered one
 * ticker; trading days had 608-750): the ranking leaves it out of its session window.
 */
export const MARKET_PREMIUM_MIN_SESSION_TICKERS = 50;
/** An answer with more tickers than this is refused (the unfiltered market had 4,477 on 2026-11-19). */
export const MARKET_PREMIUM_MAX_TICKERS = 10_000;

/** The request body for one New York session date (YYYY-MM-DD). */
export const marketPremiumRequest = (
  sessionDate: string
): Readonly<Record<string, unknown>> => ({
  sessionDate,
  filterExpression: {
    conjunction: "AND",
    filters: [
      {
        field: "premium",
        operation: ">=",
        value: MARKET_PREMIUM_MIN_TRADE_PREMIUM,
      },
      // No effect on 2026-11-20 (same answer with and without); kept so busted prints never count.
      { field: "isCancelled", operation: "=", value: false },
    ],
  },
});

const money = z.number().nonnegative();
const count = z.number().int().nonnegative();

const MarketPremiumValueSchema = z.object({
  bullishPremium: money,
  bearishPremium: money,
  premium: money,
  tradeCount: count,
  volume: count,
});

const MarketPremiumDataSchema = z
  .record(z.string(), z.unknown())
  .refine((data) => Object.keys(data).length <= MARKET_PREMIUM_MAX_TICKERS, {
    message: `more than ${MARKET_PREMIUM_MAX_TICKERS} tickers`,
  });

/** One ticker's session totals (large trades only). */
export type FlowMarketPremiumTotals = Readonly<{
  ticker: string;
  bullishPremium: number;
  bearishPremium: number;
  premium: number;
  tradeCount: number;
  volume: number;
}>;

export type FlowMarketPremiumParse =
  | Readonly<{
      ok: true;
      rows: readonly FlowMarketPremiumTotals[];
      /** Keys that do not match the ticker rule; they are not stored. */
      skipped: number;
    }>
  | Readonly<{ ok: false; message: string }>;

const shapeError = (path: string): FlowMarketPremiumParse => ({
  message: `gainers-losers answer has an unexpected shape: ${path === "" ? "(root)" : path}`,
  ok: false,
});

/** Maps a gainers-losers answer to rows in ticker order; the message never holds payload text. */
export const parseMarketPremium = (data: unknown): FlowMarketPremiumParse => {
  const parsed = MarketPremiumDataSchema.safeParse(data);
  if (!parsed.success) return shapeError("");
  const rows: FlowMarketPremiumTotals[] = [];
  let skipped = 0;
  for (const [ticker, value] of Object.entries(parsed.data)) {
    if (!TICKER_SYMBOL_PATTERN.test(ticker)) {
      skipped += 1;
      continue;
    }
    const totals = MarketPremiumValueSchema.safeParse(value);
    if (!totals.success)
      return shapeError(
        [
          // "*" stands for the ticker key: the message names no payload value.
          "*",
          ...totals.error.issues
            .slice(0, 1)
            .flatMap((issue) => issue.path.map(String)),
        ].join(".")
      );
    rows.push({ ticker, ...totals.data });
  }
  // Keys are unique, so two tickers are never equal.
  rows.sort((left, right) => (left.ticker < right.ticker ? -1 : 1));
  return { ok: true, rows, skipped };
};
