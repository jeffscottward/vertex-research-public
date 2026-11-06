import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only listed options chain for one stock symbol (optionsChain.*): the expiry list and,
// per expiry, calls and puts by strike with quotes and Black-Scholes Greeks. Market data
// only: nothing here places, changes or cancels orders.

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

const quoteFields = {
  symbol: z.string(),
  source: z.literal("yahoo"),
  currency: z.string().max(8).nullable(),
  spot: finite.positive().nullable(),
  // Provider quote time and the time this server built the response (ISO-8601 UTC).
  quoteTime: z.string().nullable(),
  receivedAt: z.string(),
  expiries: z.array(OptionsChainExpirySchema).max(400),
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
    rows: z.array(OptionsChainRowSchema).max(2000),
    assumptions: OptionsChainAssumptionsSchema,
    // Data limits the reader must know (delay, computed Greeks, missing IV).
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
export type OptionGreeks = z.infer<typeof OptionGreeksSchema>;
export type OptionsChainExpiry = z.infer<typeof OptionsChainExpirySchema>;
export type OptionsChainAssumptions = z.infer<
  typeof OptionsChainAssumptionsSchema
>;
