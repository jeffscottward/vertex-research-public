import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only IBKR historical bars from the QuantVPS tailnet history service (vertex-history-bars-v1).
// Bars only; the service holds the only IB session (client id 77) and enforces IBKR pacing.

export const MARKET_SEC_TYPES = ["STK", "FUT", "CONTFUT"] as const;
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
        message: "Futures need an exchange, for example CME",
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

export const marketDataContract = { bars };

export type MarketBarsInput = z.input<typeof MarketBarsInputSchema>;
export type MarketBarsParsedInput = z.output<typeof MarketBarsInputSchema>;
export type MarketBar = z.infer<typeof MarketBarSchema>;
export type MarketBarsOutput = z.infer<typeof MarketBarsOutputSchema>;
