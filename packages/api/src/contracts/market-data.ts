import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only IBKR historical bars from the QuantVPS tailnet history service (vertex-history-bars-v1).
// Bars only; the service holds the only IB session (client id 77) and enforces IBKR pacing.

// CASH = IBKR forex on IDEALPRO (symbol EUR + currency USD); bars only, always MIDPOINT.
export const MARKET_SEC_TYPES = ["STK", "FUT", "CONTFUT", "CASH"] as const;
export const MARKET_BAR_SIZES = [
  "1 min",
  "5 mins",
  "15 mins",
  "30 mins",
  "1 hour",
  "1 day",
] as const;
export const MARKET_WHAT_TO_SHOW = ["TRADES", "MIDPOINT"] as const;
export const MARKET_BARS_MAX = 20_000;
const UNIT_DAYS = { D: 1, W: 7, M: 30, Y: 365 } as const;

export type MarketSecType = (typeof MARKET_SEC_TYPES)[number];
export type MarketBarSize = (typeof MARKET_BAR_SIZES)[number];

// Duration caps per bar size: daily <= 1 Y, intraday <= 1 M, 1 min <= 2 D (days only).
export const marketDurationDays = (duration: string): number | null => {
  const match = /^([1-9]\d{0,2}) ([DWMY])$/.exec(duration);
  if (match === null) return null;
  return Number(match[1]) * UNIT_DAYS[match[2] as keyof typeof UNIT_DAYS];
};

export const marketDurationAllowed = (
  barSize: MarketBarSize,
  duration: string
): boolean => {
  const days = marketDurationDays(duration);
  if (days === null) return false;
  if (barSize === "1 day") return days <= 365;
  if (barSize === "1 min") return duration.endsWith(" D") && days <= 2;
  return days <= 31;
};

// Ticker accepted by the bars request; also gates the /charts?symbol= deep link.
export const MarketSymbolSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9.]{0,11}$/, {
    message: "Symbol: letters, digits and dots, at most 12",
  });
const exchangeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9.]{1,15}$/, {
    message: "Exchange: 2 to 16 letters or digits",
  });

export const MarketBarsInputSchema = z
  .object({
    symbol: MarketSymbolSchema,
    secType: z.enum(MARKET_SEC_TYPES).default("STK"),
    exchange: exchangeSchema.optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .default("USD"),
    barSize: z.enum(MARKET_BAR_SIZES).default("1 day"),
    duration: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,2} [DWMY]$/, {
        message: "Duration: a number, a space and D, W, M or Y",
      })
      .default("1 Y"),
    whatToShow: z.enum(MARKET_WHAT_TO_SHOW).default("TRADES"),
    useRTH: z.boolean().default(true),
    contractMonth: z
      .string()
      .regex(/^\d{6}(\d{2})?$/)
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.secType !== "STK" && input.exchange === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["exchange"],
        message:
          "Futures and forex need an exchange, for example CME or IDEALPRO",
      });
    }
    if (!marketDurationAllowed(input.barSize, input.duration)) {
      ctx.addIssue({
        code: "custom",
        path: ["duration"],
        message:
          "Duration too long for the bar size (daily <= 1 Y, intraday <= 1 M, 1 min <= 2 D)",
      });
    }
    if (input.contractMonth !== undefined && input.secType !== "FUT") {
      return ctx.addIssue({
        code: "custom",
        path: ["contractMonth"],
        message: "Contract month applies to FUT only",
      });
    }
    return;
  });

export const MarketBarSchema = z
  .object({
    t: z.number().int(),
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
    v: z.number().nonnegative().nullable(),
  })
  .strict();

const nullableText = (max: number) => z.string().max(max).nullable();

export const MarketContractSchema = z
  .object({
    conId: z.number().int(),
    secType: z.string().max(16),
    localSymbol: z.string().max(40),
    exchange: z.string().max(32),
    currency: z.string().max(8),
    lastTradeDateOrContractMonth: nullableText(16),
    multiplier: nullableText(16),
    longName: nullableText(160),
    timeZoneId: nullableText(64),
    matches: z.number().int().nonnegative(),
  })
  .strict();

export const MarketBarsRequestEchoSchema = z
  .object({
    symbol: z.string().max(12),
    secType: z.enum(MARKET_SEC_TYPES),
    exchange: z.string().max(16),
    currency: z.string().max(3),
    barSize: z.enum(MARKET_BAR_SIZES),
    duration: z.string().max(8),
    whatToShow: z.enum(MARKET_WHAT_TO_SHOW),
    useRTH: z.boolean(),
    contractMonth: z.string().max(8).nullable(),
  })
  .strict();

export const MarketBarsCacheSchema = z
  .object({
    hit: z.boolean(),
    ageSeconds: z.number().int().nonnegative(),
    ttlSeconds: z.number().int().nonnegative(),
    stale: z.boolean(),
  })
  .strict();

export const MarketBarsOutputSchema = z.object({
  source: z.literal("ibkr-gateway"),
  request: MarketBarsRequestEchoSchema,
  contract: MarketContractSchema,
  bars: z.array(MarketBarSchema).max(MARKET_BARS_MAX),
  count: z.number().int().nonnegative(),
  // Upstream fetch time from IBKR (ISO-8601 UTC) and the last bar's time.
  fetchedAt: z.string(),
  asOf: z.string().nullable(),
  cache: MarketBarsCacheSchema,
  // When this server received the document.
  receivedAt: z.string(),
});

export const MARKET_DATA_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "No IBKR contract matched the request" },
  PACED: { status: 429, message: "IBKR history pacing; retry later" },
  ENTITLEMENT: {
    status: 502,
    message: "IBKR market data permissions missing for this request",
  },
  UPSTREAM_ERROR: {
    status: 502,
    message: "Market data history request failed",
  },
  UNAVAILABLE: { status: 503, message: "IBKR history service unavailable" },
  NOT_CONFIGURED: {
    status: 503,
    message: "Market data history endpoint not configured",
  },
} as const;

const marketData = oc.errors(MARKET_DATA_ERRORS);

const bars = marketData
  .route({
    method: "GET",
    path: "/market-data/bars",
    operationId: "marketData.bars",
    summary:
      "Read-only IBKR historical bars (OHLCV) from the QuantVPS history service",
    tags: ["Market data"],
  })
  .input(MarketBarsInputSchema)
  .output(MarketBarsOutputSchema);

// ---------------------------------------------------------------------------
// Order flow (LuxAlgo gap P5). Read-only IBKR historical ticks and a one-shot market depth
// snapshot from the same QuantVPS history service. Built on the account's existing IBKR
// market data; nothing here subscribes to a new paid feed or touches orders.

export const MARKET_TICKS_MAX = 1000;
export const MARKET_TICKS_DEFAULT = 500;
export const MARKET_DEPTH_ROWS_MAX = 20;
export const MARKET_DEPTH_ROWS_DEFAULT = 10;

const instrumentRefinements = (
  input: {
    secType: MarketSecType;
    exchange?: string | undefined;
    contractMonth?: string | undefined;
  },
  ctx: z.RefinementCtx
) => {
  if (input.secType === "CASH") {
    ctx.addIssue({
      code: "custom",
      path: ["secType"],
      message: "Ticks and depth are not available for forex (CASH)",
    });
  }
  if (input.secType !== "STK" && input.exchange === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["exchange"],
      message: "Futures need an exchange, for example CME",
    });
  }
  if (input.contractMonth !== undefined && input.secType !== "FUT") {
    ctx.addIssue({
      code: "custom",
      path: ["contractMonth"],
      message: "Contract month applies to FUT only",
    });
  }
};

const instrumentFields = {
  symbol: MarketSymbolSchema,
  secType: z.enum(MARKET_SEC_TYPES).default("STK"),
  exchange: exchangeSchema.optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .default("USD"),
  contractMonth: z
    .string()
    .regex(/^\d{6}(\d{2})?$/)
    .optional(),
};

export const MarketTicksInputSchema = z
  .object({
    ...instrumentFields,
    // Most recent N trade prints (IBKR reqHistoricalTicks caps one request at 1000).
    count: z
      .number()
      .int()
      .min(50)
      .max(MARKET_TICKS_MAX)
      .default(MARKET_TICKS_DEFAULT),
    // false includes pre/post-market prints.
    useRTH: z.boolean().default(false),
    // Also fetch bid/ask quotes over the same window so trades can be signed by the quote rule.
    quotes: z.boolean().default(true),
  })
  .strict()
  .superRefine(instrumentRefinements);

export const MarketTradeTickSchema = z
  .object({
    t: z.number().int(), // unix seconds
    p: z.number(),
    s: z.number().nonnegative(),
    x: nullableText(16), // venue; null when IBKR sends none (futures)
    c: nullableText(32), // IBKR special conditions
  })
  .strict();

export const MarketQuoteTickSchema = z
  .object({
    t: z.number().int(),
    bp: z.number(),
    bs: z.number().nonnegative(),
    ap: z.number(),
    as: z.number().nonnegative(),
  })
  .strict();

export const MarketInstrumentEchoSchema = z
  .object({
    symbol: z.string().max(12),
    secType: z.enum(MARKET_SEC_TYPES),
    exchange: z.string().max(16),
    currency: z.string().max(3),
    contractMonth: z.string().max(8).nullable(),
  })
  .strict();

export const MarketTicksOutputSchema = z.object({
  source: z.literal("ibkr-gateway"),
  request: MarketInstrumentEchoSchema.extend({
    count: z.number().int(),
    useRTH: z.boolean(),
    quotes: z.boolean(),
  }).strict(),
  contract: MarketContractSchema,
  // IBKR ContractDetails.minTick (price increment); null when IBKR reports none.
  minTick: z.number().positive().nullable(),
  // Oldest first.
  trades: z.array(MarketTradeTickSchema).max(MARKET_TICKS_MAX),
  // Oldest first; empty when quotes=false or IBKR returned none.
  quotes: z.array(MarketQuoteTickSchema).max(MARKET_TICKS_MAX),
  fetchedAt: z.string(),
  // Time of the newest trade (ISO-8601 UTC); null when there are no trades.
  asOf: z.string().nullable(),
  cache: MarketBarsCacheSchema,
  receivedAt: z.string(),
});

export const MarketDepthInputSchema = z
  .object({
    ...instrumentFields,
    rows: z
      .number()
      .int()
      .min(1)
      .max(MARKET_DEPTH_ROWS_MAX)
      .default(MARKET_DEPTH_ROWS_DEFAULT),
  })
  .strict()
  .superRefine(instrumentRefinements);

export const MarketDepthLevelSchema = z
  .object({
    price: z.number(),
    // As IBKR reports it; multiply by sizeMultiplier for shares or contracts.
    size: z.number().nonnegative(),
    // Market maker or venue for SMART (aggregated) depth; null for a single-exchange book.
    venue: nullableText(16),
  })
  .strict();

export const MarketDepthVenuesSchema = z
  .object({
    depth: z.array(z.string().max(16)).max(40),
    top: z.array(z.string().max(16)).max(40),
    missing: z.array(z.string().max(16)).max(40),
  })
  .strict();

export const MarketDepthOutputSchema = z.object({
  source: z.literal("ibkr-gateway"),
  request: MarketInstrumentEchoSchema.extend({
    rows: z.number().int(),
    // true: IBKR SMART depth (stocks, aggregated across venues); false: one exchange book (futures).
    smartDepth: z.boolean(),
  }).strict(),
  contract: MarketContractSchema,
  // IBKR ContractDetails.minTick (price increment); null when IBKR reports none.
  minTick: z.number().positive().nullable(),
  // Best price first.
  bids: z.array(MarketDepthLevelSchema).max(MARKET_DEPTH_ROWS_MAX),
  asks: z.array(MarketDepthLevelSchema).max(MARKET_DEPTH_ROWS_MAX),
  // IBKR mdSizeMultiplier (100 when US stock depth is quoted in round lots, 1 for futures).
  sizeMultiplier: z.number().positive(),
  // From IBKR notice 2152: venues with full depth, venues with top of book only, and venues that
  // need a market data subscription the account lacks. Null when IBKR sent no notice.
  venues: MarketDepthVenuesSchema.nullable(),
  // Depth update messages folded into this snapshot.
  updates: z.number().int().nonnegative(),
  fetchedAt: z.string(),
  cache: MarketBarsCacheSchema,
  receivedAt: z.string(),
});

const ticks = marketData
  .route({
    method: "GET",
    path: "/market-data/ticks",
    operationId: "marketData.ticks",
    summary:
      "Read-only IBKR historical trade prints and bid/ask quotes (time & sales) from the QuantVPS history service",
    tags: ["Market data"],
  })
  .input(MarketTicksInputSchema)
  .output(MarketTicksOutputSchema);

const depth = marketData
  .route({
    method: "GET",
    path: "/market-data/depth",
    operationId: "marketData.depth",
    summary:
      "Read-only one-shot IBKR market depth (L2) snapshot from the QuantVPS history service",
    tags: ["Market data"],
  })
  .input(MarketDepthInputSchema)
  .output(MarketDepthOutputSchema);

export const marketDataContract = { bars, ticks, depth };

export type MarketBarsInput = z.input<typeof MarketBarsInputSchema>;
export type MarketBarsParsedInput = z.output<typeof MarketBarsInputSchema>;
export type MarketBar = z.infer<typeof MarketBarSchema>;
export type MarketBarsOutput = z.infer<typeof MarketBarsOutputSchema>;
export type MarketTicksInput = z.input<typeof MarketTicksInputSchema>;
export type MarketTicksParsedInput = z.output<typeof MarketTicksInputSchema>;
export type MarketTradeTick = z.infer<typeof MarketTradeTickSchema>;
export type MarketQuoteTick = z.infer<typeof MarketQuoteTickSchema>;
export type MarketTicksOutput = z.infer<typeof MarketTicksOutputSchema>;
export type MarketDepthInput = z.input<typeof MarketDepthInputSchema>;
export type MarketDepthParsedInput = z.output<typeof MarketDepthInputSchema>;
export type MarketDepthLevel = z.infer<typeof MarketDepthLevelSchema>;
export type MarketDepthVenues = z.infer<typeof MarketDepthVenuesSchema>;
export type MarketDepthOutput = z.infer<typeof MarketDepthOutputSchema>;
