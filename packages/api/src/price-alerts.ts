import { z } from "zod";

import type { PriceAlertKind } from "./contracts/price-alerts.ts";

// Pure price alert logic: the Yahoo intraday chart parser, the touch evaluator, the run planner and
// the fixed notification text. Adapted from trader-alerts/alerts.py in
// https://github.com/Jakeschincariol/day-trader-skill (MIT, see fixtures/day-trader-skill/NOTICE.md):
// "stop" is an at-or-below rule and "target" an at-or-above rule, and a rule rings once. Unlike the
// original, a touch between checks counts: the 5-minute bar highs and lows since the last check are
// evaluated as well as the last price, and a bar from before the rule existed never counts. The
// network call lives in server/price-alerts.ts.

/** Fixed notification text. Symbols, prices, levels and URLs are never interpolated. */
export const PRICE_ALERT_NOTIFICATION = Object.freeze({
  body: "A price alert rule triggered. Open Vertex to review it. This is not an instruction to trade.",
  title: "Vertex price alert",
});

/** Yahoo chart URL for one symbol: today's session in 5-minute bars. */
export const priceAlertChartUrl = (symbol: string): string =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.replace(/[./]/gu, "-"))}?range=1d&interval=5m`;

const nullableNumbers = z.array(z.number().nullable()).optional();

const YahooIntradayChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          indicators: z.object({
            quote: z
              .array(z.object({ high: nullableNumbers, low: nullableNumbers }))
              .optional(),
          }),
          meta: z.object({
            regularMarketPrice: z.number().nullable().optional(),
            regularMarketTime: z.number().nullable().optional(),
          }),
          timestamp: z.array(z.number()).optional(),
        })
      )
      .nullable(),
  }),
});

export type PriceAlertBar = Readonly<{
  start: Date;
  high: number;
  low: number;
}>;

export type PriceAlertQuote = Readonly<{
  symbol: string;
  last: number;
  lastAt: Date | null;
  bars: readonly PriceAlertBar[];
}>;

export type PriceAlertQuoteResult =
  | Readonly<{ ok: true; quote: PriceAlertQuote }>
  | Readonly<{ ok: false; reason: string }>;

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Last price and the intraday bars from a Yahoo chart document. Bars without a high and low are dropped. */
export const quoteFromYahooChart = (
  raw: unknown,
  symbol: string
): PriceAlertQuoteResult => {
  const parsed = YahooIntradayChartSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: "Yahoo returned an unexpected document" };
  const result = parsed.data.chart.result?.[0];
  if (result === undefined)
    return { ok: false, reason: "Yahoo has no data for this symbol" };
  const last = result.meta.regularMarketPrice;
  if (!positive(last))
    return { ok: false, reason: "Yahoo has no last price for this symbol" };
  const quote = result.indicators.quote?.[0];
  const bars = (result.timestamp ?? []).flatMap((time, index) => {
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    if (!(positive(high) && positive(low))) return [];
    return [{ high, low, start: new Date(time * 1000) }];
  });
  const lastTime = result.meta.regularMarketTime;
  return {
    ok: true,
    quote: {
      bars,
      last,
      lastAt: typeof lastTime === "number" ? new Date(lastTime * 1000) : null,
      symbol,
    },
  };
};

/** Width of one intraday bar in the chart the server requests (interval=5m). */
const PRICE_ALERT_BAR_MS = 5 * 60_000;

export type PriceAlertCondition = Readonly<{
  kind: PriceAlertKind;
  /** Positive decimal string. */
  level: string;
  createdAt: Date;
  /** Null before the first evaluation. */
  lastCheckedAt: Date | null;
}>;

export type PriceAlertEvaluation =
  | Readonly<{ hit: false }>
  | Readonly<{ hit: true; price: number }>;

const reaches = (kind: PriceAlertKind, price: number, level: number) =>
  kind === "above" ? price >= level : price <= level;

/**
 * Bars this evaluation may use. First check: only bars that started at or after the rule's creation,
 * so a move from before the rule existed never counts. Later checks: every bar that ends after the
 * last check, including the bar that straddles it (its part before the last check was already
 * evaluated then, so re-checking it is safe and a touch later in that bar is not missed).
 */
const inWindow = (bar: PriceAlertBar, condition: PriceAlertCondition) =>
  condition.lastCheckedAt === null
    ? bar.start.getTime() >= condition.createdAt.getTime()
    : bar.start.getTime() + PRICE_ALERT_BAR_MS >
      condition.lastCheckedAt.getTime();

/**
 * Did the price reach the level in the window? The first bar in the window that touches the level
 * wins (its high for "above", its low for "below"); otherwise the last price decides.
 */
export const evaluatePriceAlert = (
  condition: PriceAlertCondition,
  quote: PriceAlertQuote
): PriceAlertEvaluation => {
  const level = Number(condition.level);
  for (const bar of quote.bars) {
    if (!inWindow(bar, condition)) continue;
    const extreme = condition.kind === "above" ? bar.high : bar.low;
    if (reaches(condition.kind, extreme, level))
      return { hit: true, price: extreme };
  }
  return reaches(condition.kind, quote.last, level)
    ? { hit: true, price: quote.last }
    : { hit: false };
};

/** A price as a plain decimal string with at most four fractional digits. */
export const formatPriceAlertPrice = (price: number): string =>
  price.toFixed(4).replace(/\.?0+$/u, "");

export type PriceAlertRunPlan<Rule extends Readonly<{ symbol: string }>> =
  Readonly<{
    symbols: readonly string[];
    rules: readonly Rule[];
  }>;

/** The first maxSymbols distinct symbols (in rule order) and the rules that watch them. */
export const planPriceAlertRun = <Rule extends Readonly<{ symbol: string }>>(
  rules: readonly Rule[],
  maxSymbols: number
): PriceAlertRunPlan<Rule> => {
  const symbols: string[] = [];
  for (const rule of rules) {
    if (symbols.length >= maxSymbols) break;
    if (!symbols.includes(rule.symbol)) symbols.push(rule.symbol);
  }
  return {
    rules: rules.filter((rule) => symbols.includes(rule.symbol)),
    symbols,
  };
};
