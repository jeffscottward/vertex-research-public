import { oc } from "@orpc/contract";
import { z } from "zod";

// News monitor for the signed-in user's watchlist: headlines from IBKR (vertex-history /news),
// Reuters (Google News RSS), Seeking Alpha and Yahoo Finance RSS, merged per ticker, plus SEC EDGAR
// 8-K filings per ticker. Read-only research; no orders, no quotes, no execution linkage.
// Item labels, the important-item set and the headline keyword idea are adapted from
// day-trader-skill trader-news/news.py (MIT, Jake Schincariol, commit 3d0f4ef).

export const MARKET_NEWS_HOURS = [24, 72, 168, 720] as const;
export type MarketNewsHours = (typeof MARKET_NEWS_HOURS)[number];
export const MARKET_NEWS_MAX_TICKERS = 25;
export const MARKET_NEWS_MAX_HEADLINES = 50;
export const MARKET_NEWS_MAX_FILINGS = 20;

export const MARKET_NEWS_HEADLINE_TAGS = [
  "earnings",
  "guidance",
  "deal",
  "analyst",
  "legal",
  "offering",
  "executive",
] as const;
export type MarketNewsHeadlineTag = (typeof MARKET_NEWS_HEADLINE_TAGS)[number];

/**
 * Headline sources, highest priority first: when several sources carry the same story, the
 * merged list keeps the copy from the source listed first.
 */
export const MARKET_NEWS_SOURCES = [
  "ibkr",
  "reuters",
  "seekingalpha",
  "yahoo",
] as const;
export type MarketNewsSource = (typeof MARKET_NEWS_SOURCES)[number];

export const MARKET_NEWS_SOURCE_LABELS: Readonly<
  Record<MarketNewsSource, string>
> = {
  ibkr: "IBKR",
  reuters: "Reuters",
  seekingalpha: "Seeking Alpha",
  yahoo: "Yahoo Finance",
};

const text = (max: number) => z.string().trim().min(1).max(max);

/** Only absolute http(s) links reach the page, so an `href` can never run script. */
export const MarketNewsUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "Expected an http(s) URL" }
  );

export const MarketNewsHeadlineSchema = z
  .object({
    publishedAt: z.date(),
    publisher: text(200).nullable(),
    source: z.enum(MARKET_NEWS_SOURCES),
    tags: z.array(z.enum(MARKET_NEWS_HEADLINE_TAGS)),
    title: text(500),
    // IBKR headlines carry no public article link.
    url: MarketNewsUrlSchema.nullable(),
  })
  .strict();

export const MarketNewsFilingItemSchema = z
  .object({
    code: z.string().regex(/^\d{1,2}\.\d{2}$/u),
    label: text(120),
  })
  .strict();

export const MarketNewsFilingSchema = z
  .object({
    filedAt: z.date(),
    form: text(40),
    important: z.boolean(),
    items: z.array(MarketNewsFilingItemSchema).max(30),
    title: text(500),
    url: MarketNewsUrlSchema,
  })
  .strict();

export const MarketNewsTickerSchema = z
  .object({
    errors: z.array(text(300)),
    filings: z.array(MarketNewsFilingSchema).max(MARKET_NEWS_MAX_FILINGS),
    headlines: z.array(MarketNewsHeadlineSchema).max(MARKET_NEWS_MAX_HEADLINES),
    symbol: text(16),
  })
  .strict();

export const MarketNewsWatchlistInputSchema = z
  .object({
    // GET query values arrive as strings; coerce, then allow only the listed windows.
    hours: z.coerce
      .number()
      .pipe(
        z.union([z.literal(24), z.literal(72), z.literal(168), z.literal(720)])
      )
      .default(72),
  })
  .strict();

export const MarketNewsWatchlistOutputSchema = z
  .object({
    receivedAt: z.date(),
    tickers: z.array(MarketNewsTickerSchema).max(MARKET_NEWS_MAX_TICKERS),
  })
  .strict();

export const MARKET_NEWS_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Watchlist storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const watchlist = oc
  .errors(MARKET_NEWS_API_ERRORS)
  .route({
    method: "GET",
    operationId: "marketNews.watchlist",
    path: "/market-news/watchlist",
    summary: "Headlines and 8-K filings for each watchlist ticker",
    tags: ["Market news"],
  })
  .input(MarketNewsWatchlistInputSchema)
  .output(MarketNewsWatchlistOutputSchema);

export const marketNewsContract = { watchlist };

export type MarketNewsHeadline = z.infer<typeof MarketNewsHeadlineSchema>;
export type MarketNewsFilingItem = z.infer<typeof MarketNewsFilingItemSchema>;
export type MarketNewsFiling = z.infer<typeof MarketNewsFilingSchema>;
export type MarketNewsTicker = z.infer<typeof MarketNewsTickerSchema>;
export type MarketNewsWatchlistInput = z.input<
  typeof MarketNewsWatchlistInputSchema
>;
export type MarketNewsWatchlistOutput = z.infer<
  typeof MarketNewsWatchlistOutputSchema
>;
