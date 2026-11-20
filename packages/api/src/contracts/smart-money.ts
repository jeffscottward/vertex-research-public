import { oc } from "@orpc/contract";
import { z } from "zod";

import { TICKER_SYMBOL_PATTERN } from "./openbb.ts";

// Smart money: market-wide lists of what large traders, insiders and Congress members do, each
// with its own source and delay. PR 2: large-trade options premium per ticker from QuantData
// gainers-losers (flow_market_premium, written by flow.collect). Research only: nothing here can
// place, change or cancel an order. Design: docs/vertex-rebuild/designs/smart-money/.

export const SMART_MONEY_SESSION_WINDOWS = [1, 5, 20] as const;
export const SMART_MONEY_SORTS = [
  "net_bullish",
  "net_bearish",
  "total",
] as const;
export const SMART_MONEY_MAX_ROWS = 100;
export const SMART_MONEY_SESSION_STATUSES = [
  "complete",
  "partial",
  "no_data",
  "unavailable",
] as const;
export const SMART_MONEY_COVERAGE_STATES = [
  "fresh",
  "stale",
  "closed",
  "never",
] as const;

const text = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const ticker = z.string().regex(TICKER_SYMBOL_PATTERN);
const money = z.number().nonnegative();
const count = z.number().int().nonnegative();

export const SmartMoneyRankingInputSchema = z
  .object({
    // GET query values arrive as strings; coerce, then allow only the listed values.
    limit: z.coerce.number().int().min(1).max(SMART_MONEY_MAX_ROWS).default(50),
    sessions: z.coerce
      .number()
      .pipe(z.union([z.literal(1), z.literal(5), z.literal(20)]))
      .default(1),
    sort: z.enum(SMART_MONEY_SORTS).default("net_bullish"),
    ticker: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .transform((value) => value.toUpperCase())
      .pipe(ticker)
      .optional(),
  })
  .strict();

const SmartMoneyRankingRowSchema = z.object({
  bearishPremium: money,
  bullishPremium: money,
  netPremium: z.number(),
  premium: money,
  rank: z.number().int().positive(),
  sessionsPresent: count,
  ticker,
  tradeCount: count,
  volume: count,
});

const SmartMoneyCoverageSchema = z.object({
  /** When the newest capture of today's session arrived, or null. */
  capturedAt: z.date().nullable(),
  lastAttemptAt: z.date().nullable(),
  lastMessage: text(300).nullable(),
  /** When the state became stale (the capture time or 10:00 New York, plus 30 minutes), else null. */
  overdueSince: z.date().nullable(),
  /** Today's New York date; the live capture runs on weekdays. */
  sessionDate: date,
  /**
   * fresh: today's capture is at most 30 minutes old while options trade (09:30-16:15 New York);
   * stale: older, or missing after the first 30 minutes; never: no capture yet in the first 30
   * minutes; closed: outside that window, a weekend, or a session without data.
   */
  state: z.enum(SMART_MONEY_COVERAGE_STATES),
  status: z.enum(SMART_MONEY_SESSION_STATUSES).nullable(),
});

export const SmartMoneyRankingOutputSchema = z.object({
  /** Newest capture of the newest summed session, or null when nothing is stored. */
  capturedAt: z.date().nullable(),
  coverage: SmartMoneyCoverageSchema,
  delay: text(300),
  /** The gap fill's progress over the weekdays of the last 400 days (before today). */
  history: z.object({
    from: date,
    noData: count,
    pending: count,
    stored: count,
    weekdays: count,
  }),
  receivedAt: z.date(),
  rows: z.array(SmartMoneyRankingRowSchema).max(SMART_MONEY_MAX_ROWS),
  /**
   * The summed sessions, newest first. complete: fetched on a day after the session date (final
   * totals); partial: a live capture during the session (running totals).
   */
  sessions: z
    .array(
      z.object({
        capturedAt: z.date(),
        sessionDate: date,
        status: z.enum(["complete", "partial"]),
      })
    )
    .max(20),
  source: text(300),
  totals: z.object({
    bearishPremium: money,
    bullishPremium: money,
    netPremium: z.number(),
    premium: money,
    tickers: count,
  }),
});

export const SMART_MONEY_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Smart money storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "Smart money storage not configured", status: 503 },
} as const;

const ranking = oc
  .errors(SMART_MONEY_ERRORS)
  .route({
    method: "GET",
    operationId: "smartMoney.ranking",
    path: "/smart-money/ranking",
    summary:
      "Tickers ranked by large-trade options premium (trades >= $100,000 each) over the newest 1, 5 or 20 sessions",
    tags: ["Smart money"],
  })
  .input(SmartMoneyRankingInputSchema)
  .output(SmartMoneyRankingOutputSchema);

export const smartMoneyContract = { ranking };

export type SmartMoneySort = (typeof SMART_MONEY_SORTS)[number];
export type SmartMoneySessionWindow =
  (typeof SMART_MONEY_SESSION_WINDOWS)[number];
export type SmartMoneyRankingInput = z.input<
  typeof SmartMoneyRankingInputSchema
>;
export type SmartMoneyRankingOutput = z.infer<
  typeof SmartMoneyRankingOutputSchema
>;
export type SmartMoneyRankingRow = z.infer<typeof SmartMoneyRankingRowSchema>;
