import { oc } from "@orpc/contract";
import { z } from "zod";

// Congress trade disclosures: the U.S. House Clerk STOCK Act periodic transaction report (PTR)
// filing feed, read from the public <YEAR>FD.zip index. The transaction rows (tickers, amounts)
// live only in each filing's PDF, which is linked, not parsed. Members may file up to 45 days
// after a trade. Research only: nothing here can place, change or cancel an order.

export const CONGRESS_TRADE_WINDOWS = [7, 30, 90] as const;
export const CONGRESS_TRADES_MAX_ROWS = 5000;
export const CONGRESS_DOC_ID_PATTERN = /^\d{1,12}$/u;
export const CONGRESS_FILED_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const text = (max: number) => z.string().max(max);

export const CongressTradeFilingSchema = z.object({
  docId: z.string().regex(CONGRESS_DOC_ID_PATTERN),
  filedOn: z.string().regex(CONGRESS_FILED_ON_PATTERN),
  firstName: text(100),
  lastName: text(100),
  member: text(200),
  pdfUrl: z
    .string()
    .url()
    .startsWith("https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/"),
  stateDistrict: text(10),
  year: z.number().int().min(2000).max(2100),
});

export const CongressTradesFeedInputSchema = z
  .object({
    // GET query values arrive as strings; coerce, then allow only the listed windows.
    days: z.coerce
      .number()
      .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
      .default(30),
  })
  .strict();

export const CongressTradesFeedOutputSchema = z.object({
  filings: z.array(CongressTradeFilingSchema).max(CONGRESS_TRADES_MAX_ROWS),
  members: z.array(text(200)).max(CONGRESS_TRADES_MAX_ROWS),
  receivedAt: z.date(),
  source: text(300),
});

export const CONGRESS_TRADES_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "No disclosure index for this window", status: 404 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "House Clerk disclosures unavailable", status: 503 },
  UPSTREAM_ERROR: {
    message: "House Clerk disclosure request failed",
    status: 502,
  },
} as const;

const feed = oc
  .errors(CONGRESS_TRADES_ERRORS)
  .route({
    method: "GET",
    operationId: "congressTrades.feed",
    path: "/congress-trades/feed",
    summary:
      "House STOCK Act periodic transaction report filings in the last 7, 30 or 90 days, newest first",
    tags: ["Congress trades"],
  })
  .input(CongressTradesFeedInputSchema)
  .output(CongressTradesFeedOutputSchema);

export const congressTradesContract = { feed };

export type CongressTradeWindow = (typeof CONGRESS_TRADE_WINDOWS)[number];
export type CongressTradeFiling = z.infer<typeof CongressTradeFilingSchema>;
export type CongressTradesFeedInput = z.input<
  typeof CongressTradesFeedInputSchema
>;
export type CongressTradesFeedOutput = z.infer<
  typeof CongressTradesFeedOutputSchema
>;
