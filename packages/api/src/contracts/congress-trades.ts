import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  OPENBB_CONGRESS_CHAMBERS,
  OPENBB_CONGRESS_FILING_STATUSES,
  OPENBB_CONGRESS_HOLDERS,
  OPENBB_CONGRESS_TRANSACTION_TYPES,
  OPENBB_CONGRESS_UNPARSED_REASONS,
  OPENBB_JOB_METADATA,
  OPENBB_RUN_STATUSES,
} from "./openbb.ts";

// Congress trade disclosures: House and Senate STOCK Act periodic transaction reports (PTRs).
// The OpenBB rig jobs congress-house and congress-senate parse the filings into Postgres
// (openbb_congress_trades, openbb_congress_filings); this feed reads them. Members may file up to
// 45 days after a trade. Research only: nothing here can place, change or cancel an order.

export const CONGRESS_TRADE_WINDOWS = [7, 30, 90] as const;
export const CONGRESS_TRADES_MAX_ROWS = 5000;
/** A run older than this many hours makes a chamber overdue (from OPENBB_JOB_METADATA). */
export const CONGRESS_TRADES_OVERDUE_HOURS =
  OPENBB_JOB_METADATA["congress-house"].maxAgeHours;

const text = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const chamber = z.enum(OPENBB_CONGRESS_CHAMBERS);
const count = z.number().int().nonnegative();
const symbol = /^[A-Z0-9.^=-]{1,16}$/u;

export const CongressTradeSchema = z.object({
  amends: z.boolean(),
  amountHigh: count.nullable(),
  amountLabel: text(60),
  amountLow: count.nullable(),
  asset: text(500),
  assetType: text(40).nullable(),
  chamber,
  /** Filing date minus transaction date in days; null without a transaction date. */
  delayDays: z.number().int().nullable(),
  docId: text(36),
  filedOn: date,
  holder: z.enum(OPENBB_CONGRESS_HOLDERS).nullable(),
  member: text(200),
  rowNumber: z.number().int().min(1),
  ticker: text(16).nullable(),
  transactionDate: date.nullable(),
  transactionType: z.enum(OPENBB_CONGRESS_TRANSACTION_TYPES),
  url: text(2000),
});

export const CongressFilingSchema = z.object({
  amends: z.boolean(),
  chamber,
  docId: text(36),
  filedOn: date,
  member: text(200),
  parserVersion: text(20),
  reason: z.enum(OPENBB_CONGRESS_UNPARSED_REASONS).nullable(),
  rowCount: count,
  stateDistrict: text(10).nullable(),
  status: z.enum(OPENBB_CONGRESS_FILING_STATUSES),
  url: text(2000),
});

export const CongressCoverageSchema = z.object({
  chamber,
  /** Finish time of the newest ok or partial run; null when none. */
  lastOkAt: z.date().nullable(),
  /** Finish time of the newest run of the chamber's job, any status; null when it never ran. */
  lastRunAt: z.date().nullable(),
  lastStatus: z.enum(OPENBB_RUN_STATUSES).nullable(),
  /** No ok or partial run in the last 30 hours. */
  overdue: z.boolean(),
});

export const CongressTradesFeedInputSchema = z
  .object({
    chamber: chamber.optional(),
    // GET query values arrive as strings; coerce, then allow only the listed windows.
    days: z.coerce
      .number()
      .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
      .default(30),
    member: z.string().trim().min(1).max(200).optional(),
    ticker: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(symbol))
      .optional(),
  })
  .strict();

export const CongressTradesFeedOutputSchema = z.object({
  coverage: z.array(CongressCoverageSchema),
  filings: z.array(CongressFilingSchema).max(CONGRESS_TRADES_MAX_ROWS),
  members: z.array(text(200)).max(CONGRESS_TRADES_MAX_ROWS),
  receivedAt: z.date(),
  source: text(300),
  trades: z.array(CongressTradeSchema).max(CONGRESS_TRADES_MAX_ROWS),
  unparsed: z.object({
    byReason: z.object({
      layout_unknown: count,
      no_transactions: count,
      scanned_image: count,
    }),
    total: count,
  }),
});

export const CONGRESS_TRADES_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "Congress trade storage: database request failed; no filings were read; retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: {
    message: "Congress trade storage not configured",
    status: 503,
  },
} as const;

const feed = oc
  .errors(CONGRESS_TRADES_ERRORS)
  .route({
    method: "GET",
    operationId: "congressTrades.feed",
    path: "/congress-trades/feed",
    summary:
      "House and Senate STOCK Act transactions filed in the last 7, 30 or 90 days, newest first",
    tags: ["Congress trades"],
  })
  .input(CongressTradesFeedInputSchema)
  .output(CongressTradesFeedOutputSchema);

export const congressTradesContract = { feed };

export type CongressTradeWindow = (typeof CONGRESS_TRADE_WINDOWS)[number];
export type CongressTrade = z.infer<typeof CongressTradeSchema>;
export type CongressFiling = z.infer<typeof CongressFilingSchema>;
export type CongressCoverage = z.infer<typeof CongressCoverageSchema>;
export type CongressTradesFeedInput = z.input<
  typeof CongressTradesFeedInputSchema
>;
export type CongressTradesFeedOutput = z.infer<
  typeof CongressTradesFeedOutputSchema
>;
