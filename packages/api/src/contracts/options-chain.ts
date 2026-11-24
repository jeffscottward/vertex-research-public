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
  .object({ expiry: isoDate.optional(), symbol: OptionsChainSymbolSchema })
  .strict();

// Greeks per contract: delta and gamma per $1 of the underlying, theta per calendar day,
// vega per 1 volatility point and rho per 1 rate point. Null when IV or spot is missing.
export const OptionGreeksSchema = z
  .object({
    delta: finite,
    gamma: finite,
    rho: finite,
    theta: finite,
    vega: finite,
  })
  .strict();

// The source of each merged value of one contract; null when the value is null.
export const OptionContractSourcesSchema = z
  .object({
    // model: Black-Scholes from the chosen IV.
    delta: z.enum(["quantdata", "model"]).nullable(),
    iv: z.enum(["quantdata", "yahoo"]).nullable(),
    openInterest: z.enum(["quantdata", "yahoo"]).nullable(),
    // Bid and ask come from one source together.
    quote: z.enum(["ibkr", "yahoo"]).nullable(),
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
    ask: price,
    bid: price,
    change: finite.nullable(),
    contractSymbol: z.string().min(1).max(40),
    flow: OptionContractFlowSchema.nullable(),
    greeks: OptionGreeksSchema.nullable(),
    inTheMoney: z.boolean(),
    // Implied volatility as a decimal (0.25 = 25 %).
    iv: finite.nonnegative().nullable(),
    last: price,
    lastTradeAt: z.string().nullable(),
    openInterest: count,
    sources: OptionContractSourcesSchema,
    volume: count,
  })
  .strict();

export const OptionsChainRowSchema = z
  .object({
    call: OptionContractSchema.nullable(),
    put: OptionContractSchema.nullable(),
    strike: finite.positive(),
  })
  .strict();

export const OptionsChainExpirySchema = z
  .object({ date: isoDate, dte: z.number().int().nonnegative() })
  .strict();

const sourceStatus = <Source extends OptionsChainSourceId>(source: Source) =>
  z
    .object({
      // Safe to show: no URL, token or upstream body.
      message: z.string().max(200).nullable(),
      source: z.literal(source),
      status: z.enum(OPTIONS_CHAIN_SOURCE_STATUSES),
    })
    .strict();

// Exactly one entry per source, in priority order.
export const OptionsChainSourceStatusesSchema = z.tuple([
  sourceStatus("quantdata"),
  sourceStatus("ibkr"),
  sourceStatus("yahoo"),
]);

const quoteFields = {
  currency: z.string().max(8).nullable(),
  expiries: z.array(OptionsChainExpirySchema).max(OPTIONS_CHAIN_MAX_EXPIRIES),
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
  sources: OptionsChainSourceStatusesSchema,
  spot: finite.positive().nullable(),
  spotSource: z.enum(OPTIONS_CHAIN_SOURCES).nullable(),
  symbol: z.string(),
};

export const OptionsChainExpiriesOutputSchema = z.object(quoteFields).strict();

export const OptionsChainAssumptionsSchema = z
  .object({
    // Time to expiry runs to 16:00 New York on the expiry day, ACT/365.
    dayCount: z.literal("act/365"),
    dividendYield: finite.nonnegative(),
    model: z.literal("black-scholes-european"),
    // Continuously compounded annual rates as decimals (0.04 = 4 %).
    riskFreeRate: finite,
  })
  .strict();

export const OptionsChainOutputSchema = z
  .object({
    ...quoteFields,
    assumptions: OptionsChainAssumptionsSchema,
    dte: z.number().int().nonnegative(),
    expiry: isoDate,
    // True when the Quant Data order-flow answer had more pages than the one read: `flow` and
    // the Quant Data open interest then cover the first provider page only.
    flowFirstPageOnly: z.boolean(),
    // Data limits the reader must know (sources used, delay, computed Greeks, missing IV).
    notes: z.array(z.string().max(300)).max(10),
    rows: z.array(OptionsChainRowSchema).max(OPTIONS_CHAIN_MAX_ROWS),
  })
  .strict();

export const OPTIONS_CHAIN_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: {
    message: "No listed options for this symbol and expiry",
    status: 404,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: {
    message: "Options data source request failed; retry",
    status: 503,
  },
  UPSTREAM_ERROR: { message: "Options data request failed", status: 502 },
} as const;

const optionsChain = oc.errors(OPTIONS_CHAIN_ERRORS);

const expiries = optionsChain
  .route({
    method: "GET",
    operationId: "optionsChain.expiries",
    path: "/options-chain/expiries",
    summary: "Read-only listed option expiries and spot price for one symbol",
    tags: ["Market data"],
  })
  .input(OptionsChainExpiriesInputSchema)
  .output(OptionsChainExpiriesOutputSchema);

const chain = optionsChain
  .route({
    method: "GET",
    operationId: "optionsChain.chain",
    path: "/options-chain/chain",
    summary:
      "Read-only calls and puts for one expiry with quotes, IV and Black-Scholes Greeks",
    tags: ["Market data"],
  })
  .input(OptionsChainInputSchema)
  .output(OptionsChainOutputSchema);

export const OPTIONS_CHAIN_SNAPSHOT_MAX_QUOTES = 4000;
export const OPTIONS_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS = 400;
export const OPTIONS_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS = 60;
export const OPTIONS_CHAIN_SNAPSHOT_MAX_EXPIRIES = 20;
export const OPTIONS_CHAIN_SNAPSHOT_MAX_INT32 = 2_147_483_647;
export const OPTIONS_CHAIN_SNAPSHOT_MAX_IV = 100;
export const OPTIONS_CHAIN_SNAPSHOT_RIGHTS = ["call", "put"] as const;
export const OPTIONS_CHAIN_SNAPSHOT_QUOTE_SOURCES = [
  "ibkr",
  "yahoo",
  "quantdata",
  "mixed",
] as const;

const snapshotTimestamp = z.iso.datetime({ offset: true });
const int32Count = z
  .number()
  .int()
  .min(0)
  .max(OPTIONS_CHAIN_SNAPSHOT_MAX_INT32)
  .nullable();

export const OptionsChainSnapshotQuoteSchema = z
  .object({
    ask: price,
    bid: price,
    iv: finite.nonnegative().max(OPTIONS_CHAIN_SNAPSHOT_MAX_IV).nullable(),
    last: price,
    openInterest: int32Count,
    right: z.enum(OPTIONS_CHAIN_SNAPSHOT_RIGHTS),
    source: z.enum(OPTIONS_CHAIN_SNAPSHOT_QUOTE_SOURCES),
    strike: finite.positive(),
    volume: int32Count,
  })
  .strict();

export const OptionsChainSnapshotIngestInputSchema = z
  .object({
    expiry: isoDate,
    quotes: z
      .array(OptionsChainSnapshotQuoteSchema)
      .min(1)
      .max(OPTIONS_CHAIN_SNAPSHOT_MAX_QUOTES)
      .superRefine((quotes, context) => {
        const seen = new Set<string>();
        for (const [index, quote] of quotes.entries()) {
          const key = `${quote.strike}|${quote.right}`;
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              message: `quotes must be unique by (strike, right); ${key} appears twice`,
              path: [index],
            });
          } else {
            seen.add(key);
          }
        }
      }),
    snapshotAt: snapshotTimestamp,
    source: z.string().trim().min(1).max(64),
    spot: finite.positive().nullable(),
    tradingDay: isoDate,
    underlying: OptionsChainSymbolSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const snapUtcDay = new Date(value.snapshotAt).toISOString().slice(0, 10);
    const diffMs = Math.abs(
      Date.parse(`${value.tradingDay}T00:00:00Z`) -
        Date.parse(`${snapUtcDay}T00:00:00Z`)
    );
    if (diffMs > 86_400_000) {
      context.addIssue({
        code: "custom",
        message: "tradingDay must be within 1 calendar day of snapshotAt",
        path: ["tradingDay"],
      });
    }
  });

export const OptionsChainSnapshotIngestOutputSchema = z
  .object({
    created: z.boolean(),
    expiry: isoDate,
    quoteCount: z.number().int().positive(),
    snapshotAt: snapshotTimestamp,
    snapshotId: z.string().min(1).max(128),
    tradingDay: isoDate,
    underlying: OptionsChainSymbolSchema,
  })
  .strict();

export const OptionsChainSnapshotReadInputSchema = z
  .object({
    expiry: isoDate.optional(),
    snapshotAt: snapshotTimestamp.optional(),
    tradingDay: isoDate.optional(),
    underlying: OptionsChainSymbolSchema,
  })
  .strict();

export const OptionsChainSnapshotRunSummarySchema = z
  .object({
    expiries: z.array(isoDate).max(OPTIONS_CHAIN_SNAPSHOT_MAX_EXPIRIES),
    quoteCount: z.number().int().nonnegative(),
    snapshotAt: snapshotTimestamp,
    source: z.string().min(1).max(256),
    spot: finite.positive().nullable(),
    tradingDay: isoDate,
  })
  .strict();

export const OptionsChainSnapshotExpirySchema = z
  .object({
    expiry: isoDate,
    quoteCount: z.number().int().nonnegative(),
    quotes: z
      .array(OptionsChainSnapshotQuoteSchema)
      .max(OPTIONS_CHAIN_SNAPSHOT_MAX_QUOTES),
    source: z.string().min(1).max(64),
    spot: finite.positive().nullable(),
  })
  .strict();

export const OptionsChainSnapshotReadOutputSchema = z
  .object({
    availableDays: z
      .array(isoDate)
      .max(OPTIONS_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS),
    availableSnapshots: z
      .array(OptionsChainSnapshotRunSummarySchema)
      .max(OPTIONS_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS),
    expiries: z
      .array(OptionsChainSnapshotExpirySchema)
      .max(OPTIONS_CHAIN_SNAPSHOT_MAX_EXPIRIES),
    snapshotAt: snapshotTimestamp.nullable(),
    tradingDay: isoDate.nullable(),
    underlying: OptionsChainSymbolSchema,
  })
  .strict();

export const OPTIONS_CHAIN_SNAPSHOT_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "Option chain snapshot storage: database request failed; request not confirmed; reload to check, then retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const optionsChainSnapshot = oc.errors(OPTIONS_CHAIN_SNAPSHOT_ERRORS);

const ingestSnapshot = optionsChainSnapshot
  .route({
    method: "POST",
    operationId: "optionsChain.ingestSnapshot",
    path: "/options-chain/snapshots/ingest",
    summary:
      "Collector ingest: store or replace one (snapshotAt, underlying, expiry) option chain snapshot",
    tags: ["Market data"],
  })
  .input(OptionsChainSnapshotIngestInputSchema)
  .output(OptionsChainSnapshotIngestOutputSchema);

const snapshot = optionsChainSnapshot
  .route({
    method: "GET",
    operationId: "optionsChain.snapshot",
    path: "/options-chain/snapshots",
    summary:
      "Read stored option chain snapshots (newest or requested run/day) with bid, ask and IV per strike",
    tags: ["Market data"],
  })
  .input(OptionsChainSnapshotReadInputSchema)
  .output(OptionsChainSnapshotReadOutputSchema);

// Vertical spread priced from the chain's quotes and from the backtest option model (research only;
// the procedure places no order). Strikes arrive as GET query strings, so they are coerced.
export const OPTIONS_SPREAD_STRUCTURES = [
  "putDebitVertical",
  "putCreditVertical",
  "callDebitVertical",
  "callCreditVertical",
] as const;

export const OptionsSpreadInputSchema = z
  .object({
    expiry: isoDate,
    longStrike: z.coerce.number().finite().positive(),
    right: z.enum(["put", "call"]),
    shortStrike: z.coerce.number().finite().positive(),
    symbol: OptionsChainSymbolSchema,
  })
  .strict()
  .refine((input) => input.longStrike !== input.shortStrike, {
    message: "The two strikes must differ",
    path: ["shortStrike"],
  });

// Net Greeks per share: long leg minus short leg, in the units of OptionGreeksSchema.
export const SpreadGreeksSchema = z
  .object({ delta: finite, gamma: finite, theta: finite, vega: finite })
  .strict();

// Per share unless the name says per contract (100 shares). Net above 0 is a debit, below 0 a
// credit. Worse sides: buy at the ask and sell at the bid (quotes), or the model half-spread on each
// leg (model). Commissions are not included.
const spreadPriced = {
  breakeven: finite,
  maxGainPerContract: finite.nonnegative(),
  maxLossPerContract: finite.nonnegative(),
  maxLossWorstPerContract: finite.nonnegative(),
  netMid: finite,
  // |netMid| as a percent of the width: the debit paid or the credit taken.
  netPctWidth: finite.nonnegative(),
  netWorst: finite,
  rewardToRisk: finite.nonnegative(),
  structure: z.enum(OPTIONS_SPREAD_STRUCTURES),
  width: finite.positive(),
};

const QuotedSpreadLegSchema = z
  .object({
    ask: finite.nonnegative(),
    bid: finite.nonnegative(),
    greeks: SpreadGreeksSchema.nullable(),
    iv: finite.nonnegative().nullable(),
    lastTradeAt: z.string().nullable(),
    mid: finite.nonnegative(),
    quoteSource: z.enum(["ibkr", "yahoo"]).nullable(),
    side: z.enum(["long", "short"]),
    strike: finite.positive(),
  })
  .strict();

export const OptionsSpreadQuotesSchema = z
  .object({
    ...spreadPriced,
    // Null when a leg has no Greeks.
    greeks: SpreadGreeksSchema.nullable(),
    legs: z.tuple([QuotedSpreadLegSchema, QuotedSpreadLegSchema]),
  })
  .strict();

const ModelSpreadLegSchema = z
  .object({
    delta: finite,
    iv: finite.positive(),
    mid: finite.nonnegative(),
    side: z.enum(["long", "short"]),
    strike: finite.positive(),
  })
  .strict();

// The model inputs: the chain's spot, the latest stored close of the symbol's IV index and of IRX,
// the chain's calendar days to expiry (the model uses days / 365) and the model constants.
export const OptionsSpreadModelInputsSchema = z
  .object({
    atmIv: finite.positive(),
    days: z.number().int().positive(),
    dividendYield: finite.nonnegative(),
    ivIndex: z.string(),
    ivIndexAsOf: isoDate,
    ivIndexLevel: finite.positive(),
    // IRX / 100.
    rate: finite,
    rateAsOf: isoDate,
    skew: finite,
    spot: finite.positive(),
  })
  .strict();

export const OptionsSpreadModelSchema = z
  .object({
    ...spreadPriced,
    greeks: SpreadGreeksSchema,
    inputs: OptionsSpreadModelInputsSchema,
    legs: z.tuple([ModelSpreadLegSchema, ModelSpreadLegSchema]),
  })
  .strict();

export const OptionsSpreadOutputSchema = z
  .object({
    dte: z.number().int().nonnegative(),
    expiry: isoDate,
    model: OptionsSpreadModelSchema.nullable(),
    modelUnavailable: z.string().max(200).nullable(),
    // Model net over quoted net at the mids, minus 1, in percent; null without both.
    modelVsMidPct: finite.nullable(),
    // Each part is null with a reason when it cannot be priced; the other part is still given.
    quotes: OptionsSpreadQuotesSchema.nullable(),
    quotesUnavailable: z.string().max(200).nullable(),
    quoteTime: z.string().nullable(),
    receivedAt: z.string(),
    right: z.enum(["put", "call"]),
    spot: finite.positive().nullable(),
    spotSource: z.enum(OPTIONS_CHAIN_SOURCES).nullable(),
    symbol: z.string(),
  })
  .strict();

const spread = optionsChain
  .route({
    method: "GET",
    operationId: "optionsChain.spread",
    path: "/options-chain/spread",
    summary:
      "Read-only vertical spread price from chain quotes and the backtest option model (debit, max loss and gain, breakeven, cost per width, net Greeks)",
    tags: ["Market data"],
  })
  .input(OptionsSpreadInputSchema)
  .output(OptionsSpreadOutputSchema);

export const EXPECTED_MOVE_BASES = [
  "atm_straddle_mid",
  "atm_straddle_last",
  "atm_iv_model",
] as const;
export type ExpectedMoveBasis = (typeof EXPECTED_MOVE_BASES)[number];

export const EXPECTED_MOVE_LEG_SOURCES = ["ibkr", "yahoo"] as const;
export type ExpectedMoveLegSource = (typeof EXPECTED_MOVE_LEG_SOURCES)[number];

export const OptionsExpectedMoveBandSchema = z
  .object({
    atmIv: finite.positive().nullable(),
    atmStrike: finite.positive(),
    basis: z.enum(EXPECTED_MOVE_BASES),
    callPrice: finite.nonnegative().nullable(),
    callQuoteSource: z.enum(EXPECTED_MOVE_LEG_SOURCES).nullable(),
    expectedMove: finite.positive(),
    expectedMovePct: finite.positive(),
    expiryCloseAt: snapshotTimestamp,
    expiryCloseMs: z.number().int().positive(),
    lowerBand: finite.nonnegative(),
    putPrice: finite.nonnegative().nullable(),
    putQuoteSource: z.enum(EXPECTED_MOVE_LEG_SOURCES).nullable(),
    straddleLower: finite.nonnegative().nullable(),
    straddlePct: finite.positive().nullable(),
    straddlePrice: finite.positive().nullable(),
    straddleUpper: finite.positive().nullable(),
    upperBand: finite.positive(),
  })
  .strict();

export const OptionsExpectedMoveOutputSchema = z
  .object({
    ...quoteFields,
    band: OptionsExpectedMoveBandSchema.nullable(),
    dte: z.number().int().nonnegative(),
    expiry: isoDate,
    notes: z.array(z.string().max(300)).max(10),
    unavailableReason: z.string().max(240).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.band === null) === (value.unavailableReason === null)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either band or unavailableReason",
        path: ["band"],
      });
    }
    if (value.band === null) return;
    if (value.spot === null) {
      ctx.addIssue({
        code: "custom",
        message: "Spot is required when band is present",
        path: ["spot"],
      });
    } else if (
      value.band.lowerBand > value.spot ||
      value.spot > value.band.upperBand
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Spot must lie within [lowerBand, upperBand]",
        path: ["band"],
      });
    }
    const straddleFields = [
      value.band.callPrice,
      value.band.putPrice,
      value.band.callQuoteSource,
      value.band.putQuoteSource,
      value.band.straddlePrice,
      value.band.straddlePct,
      value.band.straddleUpper,
      value.band.straddleLower,
    ];
    if (
      value.band.basis === "atm_iv_model" &&
      straddleFields.some((field) => field !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "ATM IV model must omit straddle quote fields",
        path: ["band", "straddlePrice"],
      });
    }
    if (value.band.basis === "atm_iv_model" && value.band.atmIv === null) {
      ctx.addIssue({
        code: "custom",
        message: "ATM IV model requires atmIv",
        path: ["band", "atmIv"],
      });
    }
    if (
      value.band.basis !== "atm_iv_model" &&
      straddleFields.some((field) => field === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Straddle basis requires all straddle quote fields",
        path: ["band", "straddlePrice"],
      });
    }
  });

const expectedMove = optionsChain
  .route({
    method: "GET",
    operationId: "optionsChain.expectedMove",
    path: "/options-chain/expected-move",
    summary:
      "Read-only ATM straddle expected move bands (±1σ and straddle breakeven) for one symbol and expiry",
    tags: ["Market data"],
  })
  .input(OptionsChainInputSchema)
  .output(OptionsExpectedMoveOutputSchema);

export const optionsChainContract = {
  chain,
  expectedMove,
  expiries,
  ingestSnapshot,
  snapshot,
  spread,
};

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
export type OptionsSpreadInput = z.input<typeof OptionsSpreadInputSchema>;
export type OptionsSpreadParsedInput = z.output<
  typeof OptionsSpreadInputSchema
>;
export type OptionsSpreadOutput = z.infer<typeof OptionsSpreadOutputSchema>;
export type OptionsSpreadQuotes = z.infer<typeof OptionsSpreadQuotesSchema>;
export type OptionsSpreadModel = z.infer<typeof OptionsSpreadModelSchema>;
export type OptionsChainExpiry = z.infer<typeof OptionsChainExpirySchema>;
export type OptionsChainAssumptions = z.infer<
  typeof OptionsChainAssumptionsSchema
>;
export type OptionsExpectedMoveInput = OptionsChainInput;
export type OptionsExpectedMoveParsedInput = OptionsChainParsedInput;
export type OptionsExpectedMoveBand = z.infer<
  typeof OptionsExpectedMoveBandSchema
>;
export type OptionsExpectedMoveOutput = z.infer<
  typeof OptionsExpectedMoveOutputSchema
>;

export type OptionsChainSnapshotQuote = z.infer<
  typeof OptionsChainSnapshotQuoteSchema
>;
export type OptionsChainSnapshotIngestInput = z.input<
  typeof OptionsChainSnapshotIngestInputSchema
>;
export type OptionsChainSnapshotIngestOutput = z.infer<
  typeof OptionsChainSnapshotIngestOutputSchema
>;
export type OptionsChainSnapshotReadInput = z.input<
  typeof OptionsChainSnapshotReadInputSchema
>;
export type OptionsChainSnapshotReadOutput = z.infer<
  typeof OptionsChainSnapshotReadOutputSchema
>;
export type OptionsChainSnapshotRunSummary = z.infer<
  typeof OptionsChainSnapshotRunSummarySchema
>;
export type OptionsChainSnapshotExpiry = z.infer<
  typeof OptionsChainSnapshotExpirySchema
>;
