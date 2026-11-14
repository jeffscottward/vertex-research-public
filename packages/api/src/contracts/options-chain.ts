import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only listed options chain for one stock symbol (optionsChain.*): the expiry list and,
// per expiry, calls and puts by strike with quotes and Black-Scholes Greeks. The chain merges
// three sources (Quant Data analytics first, then IBKR live quotes, then Yahoo Finance) and
// names the source of each value; the order per field is OPTIONS_CHAIN_PRIORITY
// (options-chain-merge.ts). Market data only: nothing here places, changes or cancels orders.

/** Data sources of the chain, in priority order (owner decision 2026-11-13: Quant Data first). */
export const OPTIONS_CHAIN_SOURCES = ["quantdata", "ibkr", "yahoo"] as const;
export type OptionsChainSourceId = (typeof OPTIONS_CHAIN_SOURCES)[number];

export const OPTIONS_CHAIN_SOURCE_LABELS: Readonly<
  Record<OptionsChainSourceId, string>
> = { ibkr: "IBKR", quantdata: "Quant Data", yahoo: "Yahoo Finance" };

/** Output limits. The merge keeps to them (options-chain-merge.ts). */
export const OPTIONS_CHAIN_MAX_ROWS = 2000;
export const OPTIONS_CHAIN_MAX_EXPIRIES = 400;

// used: at least one value of the response came from the source. empty: it answered but gave
// nothing usable. failed: the read failed. off: not configured, or not asked.
export const OPTIONS_CHAIN_SOURCE_STATUSES = [
  "used",
  "empty",
  "failed",
  "off",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Date: YYYY-MM-DD" })
  // Date.parse rolls 2026-02-31 over to March, so the date must read back unchanged.
  .refine(
    (value) => {
      const time = Date.parse(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
      );
    },
    { message: "Date: a real calendar day" }
  );
const finite = z.number().finite();
const price = finite.nonnegative().nullable();
const count = z.number().int().nonnegative().nullable();

export const OptionsChainSymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/, {
    message: "Symbol: letters and digits, optional class suffix",
  });

export const OptionsChainExpiriesInputSchema = z
  .object({ symbol: OptionsChainSymbolSchema })
  .strict();

// A missing expiry selects the nearest listed expiry.
export const OptionsChainInputSchema = z
  .object({ symbol: OptionsChainSymbolSchema, expiry: isoDate.optional() })
  .strict();

// Greeks per contract: delta and gamma per $1 of the underlying, theta per calendar day,
// vega per 1 volatility point and rho per 1 rate point. Null when IV or spot is missing.
export const OptionGreeksSchema = z
  .object({
    delta: finite,
    gamma: finite,
    theta: finite,
    vega: finite,
    rho: finite,
  })
  .strict();

// The source of each merged value of one contract; null when the value is null.
export const OptionContractSourcesSchema = z
  .object({
    // Bid and ask come from one source together.
    quote: z.enum(["ibkr", "yahoo"]).nullable(),
    iv: z.enum(["quantdata", "yahoo"]).nullable(),
    openInterest: z.enum(["quantdata", "yahoo"]).nullable(),
    // model: Black-Scholes from the chosen IV.
    delta: z.enum(["quantdata", "model"]).nullable(),
  })
  .strict();

// Quant Data order-flow prints of one contract in the flow window.
export const OptionContractFlowSchema = z
  .object({
    premium: finite.nonnegative(),
    trades: z.number().int().positive(),
    // Contracts traded by those prints.
    volume: z.number().int().nonnegative(),
  })
  .strict();

export const OptionContractSchema = z
  .object({
    contractSymbol: z.string().min(1).max(40),
    bid: price,
    ask: price,
    last: price,
    change: finite.nullable(),
    volume: count,
    openInterest: count,
    // Implied volatility as a decimal (0.25 = 25 %).
    iv: finite.nonnegative().nullable(),
    inTheMoney: z.boolean(),
    lastTradeAt: z.string().nullable(),
    greeks: OptionGreeksSchema.nullable(),
    sources: OptionContractSourcesSchema,
    flow: OptionContractFlowSchema.nullable(),
  })
  .strict();

export const OptionsChainRowSchema = z
  .object({
    strike: finite.positive(),
    call: OptionContractSchema.nullable(),
    put: OptionContractSchema.nullable(),
  })
  .strict();

export const OptionsChainExpirySchema = z
  .object({ date: isoDate, dte: z.number().int().nonnegative() })
  .strict();

const sourceStatus = <Source extends OptionsChainSourceId>(source: Source) =>
  z
    .object({
      source: z.literal(source),
      status: z.enum(OPTIONS_CHAIN_SOURCE_STATUSES),
      // Safe to show: no URL, token or upstream body.
      message: z.string().max(200).nullable(),
    })
    .strict();

// Exactly one entry per source, in priority order.
export const OptionsChainSourceStatusesSchema = z.tuple([
  sourceStatus("quantdata"),
  sourceStatus("ibkr"),
  sourceStatus("yahoo"),
]);

const quoteFields = {
  symbol: z.string(),
  sources: OptionsChainSourceStatusesSchema,
  currency: z.string().max(8).nullable(),
  spot: finite.positive().nullable(),
  spotSource: z.enum(OPTIONS_CHAIN_SOURCES).nullable(),
  // The expiry list is the union of the lists of these sources: every source that gave at
  // least one listed expiry, in priority order, each at most once. Empty when none did.
  expiriesSources: z
    .array(z.enum(OPTIONS_CHAIN_SOURCES))
    .max(OPTIONS_CHAIN_SOURCES.length)
    .refine(
      (sources) => {
        // The priority position of each source must rise from one entry to the next.
        const positions = sources.map((source) =>
          OPTIONS_CHAIN_SOURCES.indexOf(source)
        );
        return positions.every(
          (position, index) => position > (positions[index - 1] ?? -1)
        );
      },
      { message: "Sources: priority order, each at most once" }
    ),
  // Provider quote time and the time this server built the response (ISO-8601 UTC).
  quoteTime: z.string().nullable(),
  receivedAt: z.string(),
  expiries: z.array(OptionsChainExpirySchema).max(OPTIONS_CHAIN_MAX_EXPIRIES),
};

export const OptionsChainExpiriesOutputSchema = z.object(quoteFields).strict();

export const OptionsChainAssumptionsSchema = z
  .object({
    model: z.literal("black-scholes-european"),
    // Continuously compounded annual rates as decimals (0.04 = 4 %).
    riskFreeRate: finite,
    dividendYield: finite.nonnegative(),
    // Time to expiry runs to 16:00 New York on the expiry day, ACT/365.
    dayCount: z.literal("act/365"),
  })
  .strict();

export const OptionsChainOutputSchema = z
  .object({
    ...quoteFields,
    expiry: isoDate,
    dte: z.number().int().nonnegative(),
    rows: z.array(OptionsChainRowSchema).max(OPTIONS_CHAIN_MAX_ROWS),
    // True when the Quant Data order-flow answer had more pages than the one read: `flow` and
    // the Quant Data open interest then cover the first provider page only.
    flowFirstPageOnly: z.boolean(),
    assumptions: OptionsChainAssumptionsSchema,
    // Data limits the reader must know (sources used, delay, computed Greeks, missing IV).
    notes: z.array(z.string().max(300)).max(10),
  })
  .strict();

export const OPTIONS_CHAIN_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: {
    status: 404,
    message: "No listed options for this symbol and expiry",
  },
  UPSTREAM_ERROR: { status: 502, message: "Options data request failed" },
  UNAVAILABLE: { status: 503, message: "Options data source unavailable" },
} as const;

const optionsChain = oc.errors(OPTIONS_CHAIN_ERRORS);

const expiries = optionsChain
  .route({
    method: "GET",
    path: "/options-chain/expiries",
    operationId: "optionsChain.expiries",
    summary: "Read-only listed option expiries and spot price for one symbol",
    tags: ["Market data"],
  })
  .input(OptionsChainExpiriesInputSchema)
  .output(OptionsChainExpiriesOutputSchema);

const chain = optionsChain
  .route({
    method: "GET",
    path: "/options-chain/chain",
    operationId: "optionsChain.chain",
    summary:
      "Read-only calls and puts for one expiry with quotes, IV and Black-Scholes Greeks",
    tags: ["Market data"],
  })
  .input(OptionsChainInputSchema)
  .output(OptionsChainOutputSchema);

export const optionsChainContract = { expiries, chain };

export type OptionsChainExpiriesInput = z.input<
  typeof OptionsChainExpiriesInputSchema
>;
export type OptionsChainInput = z.input<typeof OptionsChainInputSchema>;
export type OptionsChainParsedInput = z.output<typeof OptionsChainInputSchema>;
export type OptionsChainExpiriesOutput = z.infer<
  typeof OptionsChainExpiriesOutputSchema
>;
export type OptionsChainOutput = z.infer<typeof OptionsChainOutputSchema>;
export type OptionsChainRow = z.infer<typeof OptionsChainRowSchema>;
export type OptionContract = z.infer<typeof OptionContractSchema>;
export type OptionContractSources = z.infer<typeof OptionContractSourcesSchema>;
export type OptionContractFlow = z.infer<typeof OptionContractFlowSchema>;
export type OptionsChainSourceStatuses = z.infer<
  typeof OptionsChainSourceStatusesSchema
>;
export type OptionsChainSourceStatus = OptionsChainSourceStatuses[number];
export type OptionGreeks = z.infer<typeof OptionGreeksSchema>;
export type OptionsChainExpiry = z.infer<typeof OptionsChainExpirySchema>;
export type OptionsChainAssumptions = z.infer<
  typeof OptionsChainAssumptionsSchema
>;
