import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only options analytics for one stock symbol (port of Gamma Forge volatility,
// exposure and flow views). Data comes from QuantData through a cached, rate-limited
// server-side client. Research only: nothing here places, changes or cancels orders.

export const OPTIONS_FLOW_HOURS = [1, 6, 24, 72] as const;
export const IV_SURFACE_MONEYNESS = [
  0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2,
] as const;
export const IV_SKEW_TARGET_DELTAS = [-40, -25, -10, 10, 25, 40] as const;

export const OptionsAnalyticsInputSchema = z
  .object({
    // GET query values arrive as strings; coerce, then allow only the listed windows.
    flowHours: z.coerce
      .number()
      .int()
      .refine(
        (hours) => (OPTIONS_FLOW_HOURS as readonly number[]).includes(hours),
        { message: "flowHours: 1, 6, 24 or 72" }
      )
      .default(24),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/, {
        message: "Symbol: letters and digits, optional class suffix",
      }),
  })
  .strict();

export const OPTIONS_SECTION_STATUSES = ["ok", "empty", "unavailable"] as const;
const SectionStatusSchema = z.enum(OPTIONS_SECTION_STATUSES);

const sectionBase = {
  // Plain-text reason when status is "empty" or "unavailable"; null when "ok".
  message: z.string().max(300).nullable(),
  status: SectionStatusSchema,
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const finite = z.number().finite();

export const TermStructurePointSchema = z
  .object({
    atmIv: finite,
    dte: z.number().int().nonnegative(),
    expiry: isoDate,
  })
  .strict();

// `target` is the IV_SKEW_TARGET_DELTAS column the point was chosen for; `delta` is
// the chosen contract's own rounded delta, which can be up to 18 points away.
export const SkewPointSchema = z
  .object({
    delta: z.number().int(),
    expiry: isoDate,
    iv: finite,
    target: z.number().int(),
  })
  .strict();

export const SurfaceRowSchema = z
  .object({
    dte: z.number().int().nonnegative(),
    expiry: isoDate,
    ivs: z.array(finite.nullable()),
  })
  .strict();

export const VolatilitySectionSchema = z
  .object({
    ...sectionBase,
    skew: z.array(SkewPointSchema),
    surface: z
      .object({ moneyness: z.array(finite), rows: z.array(SurfaceRowSchema) })
      .strict(),
    termStructure: z.array(TermStructurePointSchema),
  })
  .strict();

export const ExposureStrikeSchema = z
  .object({
    callOpenInterest: z.number().int().nonnegative(),
    // Estimated gamma exposure in dollars per 1% move; null when no IV was available.
    gex: finite.nullable(),
    putOpenInterest: z.number().int().nonnegative(),
    strike: finite,
  })
  .strict();

export const ExposureSectionSchema = z
  .object({
    ...sectionBase,
    // Expiry whose IVs were used for the gamma estimate.
    gexExpiry: isoDate.nullable(),
    maxPain: finite.nullable(),
    strikes: z.array(ExposureStrikeSchema),
    totalGex: finite.nullable(),
  })
  .strict();

export const FlowEventSchema = z
  .object({
    contract: z.string().max(40),
    expiry: isoDate,
    flowType: z.string().max(24).nullable(),
    premium: finite,
    right: z.enum(["call", "put"]),
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    size: z.number().int().nonnegative(),
    strike: finite,
    time: z.string(),
    unusual: z.boolean(),
  })
  .strict();

export const FlowBucketSchema = z
  .object({
    callPremium: finite,
    netPremium: finite,
    putPremium: finite,
    start: z.string(),
    trades: z.number().int().nonnegative(),
  })
  .strict();

export const FlowSectionSchema = z
  .object({
    ...sectionBase,
    buckets: z.array(FlowBucketSchema),
    callPremium: finite,
    events: z.array(FlowEventSchema),
    hours: z.number().int().positive(),
    putPremium: finite,
  })
  .strict();

// "Read this before trusting the number": the caveats a GEX reading needs (dealer-sign
// assumption, freshness, expiry mix, flow, distance to levels, other dealer Greeks, IV
// regime, session, events). Computed from the same QuantData payloads; no extra requests.
export const GEX_CONTEXT_FACTOR_KEYS = [
  "dealerSign",
  "regime",
  "freshness",
  "expiryMix",
  "levels",
  "flow",
  "dex",
  "charm",
  "vanna",
  "ivRegime",
  "events",
] as const;
export const GEX_CONTEXT_TONES = ["neutral", "caution", "alert"] as const;
export const GEX_REGIMES = ["positive", "negative", "no_data", "zero"] as const;
export const GEX_FLOW_BIASES = [
  "bullish",
  "bearish",
  "balanced",
  "no_signed_flow",
  "not_received",
] as const;
export const IV_TERM_REGIMES = [
  "inverted",
  "flat",
  "contango",
  "no_term_data",
] as const;
export const MARKET_SESSIONS = [
  "closed",
  "premarket",
  "morning",
  "midday",
  "afternoon",
  "afterhours",
] as const;

export const GexContextFactorSchema = z
  .object({
    detail: z.string().max(300),
    key: z.enum(GEX_CONTEXT_FACTOR_KEYS),
    label: z.string().max(40),
    tone: z.enum(GEX_CONTEXT_TONES),
    value: z.string().max(80),
  })
  .strict();

export const GexContextSchema = z
  .object({
    // Sign convention behind GEX, the levels, vanna and charm.
    dealerSignAssumption: z.literal("dealers long calls, short puts"),
    expiry: z
      .object({
        monthlyOpexDays: z.number().int().nonnegative(),
        nextExpiry: isoDate.nullable(),
        nextExpiryDte: z.number().int().nonnegative().nullable(),
        nextMonthlyOpex: isoDate,
      })
      .strict(),
    factors: z.array(GexContextFactorSchema),
    flow: z
      .object({
        bearishPremium: finite,
        bias: z.enum(GEX_FLOW_BIASES),
        bullishPremium: finite,
        newestTradeAt: z.string().nullable(),
        weekShare: finite.nullable(),
        // Share of flow premium in contracts expiring today and within 7 days.
        zeroDteShare: finite.nullable(),
      })
      .strict(),
    greeks: z
      .object({
        // Estimated change of dealer delta (dollars) per calendar day.
        netCharm: finite.nullable(),
        // Net delta of open interest in dollars, holders' side (calls +, puts -); the
        // only field here that does not use the dealer-sign assumption.
        netDex: finite.nullable(),
        // Estimated change of dealer delta (dollars) per +1 IV point.
        netVanna: finite.nullable(),
      })
      .strict(),
    iv: z
      .object({
        backIv: finite.nullable(),
        frontIv: finite.nullable(),
        regime: z.enum(IV_TERM_REGIMES),
      })
      .strict(),
    levels: z
      .object({
        // Strikes with the largest positive and the most negative estimated GEX.
        callWall: finite.nullable(),
        callWallMoves: finite.nullable(),
        // One-day implied move in dollars: spot x front ATM IV / sqrt(252).
        dailyMove: finite.nullable(),
        // Spot where the estimated GEX profile crosses zero (nearest crossing to spot).
        flip: finite.nullable(),
        // Signed distance from spot to each level, in daily implied moves.
        flipMoves: finite.nullable(),
        // Strike with the largest absolute estimated net GEX (dealer gamma magnet).
        kingNode: finite.nullable(),
        putWall: finite.nullable(),
        putWallMoves: finite.nullable(),
      })
      .strict(),
    regime: z.enum(GEX_REGIMES),
    session: z.enum(MARKET_SESSIONS),
  })
  .strict();

// Strike profiles (open interest, flow volume, net premium and max pain by strike) on one strike
// ladder: the exposure display strikes plus the max-pain strike. Flow comes from the snapshot's
// first order-flow page ("quantdata_page") or, for the option tickers the flow collector stores,
// from every stored print of the window ("stored_prints").
export const STRIKE_PROFILE_FLOW_SOURCES = [
  "quantdata_page",
  "stored_prints",
] as const;

export const StrikeProfileRowSchema = z
  .object({
    bearishPremium: finite.nonnegative(),
    // Premium by QuantData sentiment; neutral prints add to neither.
    bullishPremium: finite.nonnegative(),
    callOpenInterest: z.number().int().nonnegative(),
    // Contracts in the counted flow prints (not total exchange volume).
    callVolume: z.number().int().nonnegative(),
    // Intrinsic value in dollars of all open contracts (all expiries) if the underlying
    // settles at this strike; the smallest is max pain.
    holderPayout: finite.nonnegative(),
    putOpenInterest: z.number().int().nonnegative(),
    putVolume: z.number().int().nonnegative(),
    strike: finite,
    trades: z.number().int().nonnegative(),
  })
  .strict();

export const StrikeProfilesSchema = z
  .object({
    flow: z
      .object({
        // Page: no further provider page. Stored: no collector gap overlaps the window and
        // the collector's options source is not stale.
        complete: z.boolean(),
        newestTradeAt: z.string().nullable(),
        offLadderTrades: z.number().int().nonnegative(),
        oldestTradeAt: z.string().nullable(),
        source: z.enum(STRIKE_PROFILE_FLOW_SOURCES),
        // Counted prints of the source, and those at strikes that are not on the ladder.
        trades: z.number().int().nonnegative(),
      })
      .strict(),
    // Ascending strike, at most 81 rows.
    strikes: z.array(StrikeProfileRowSchema),
  })
  .strict();

export const OptionsAnalyticsOutputSchema = z
  .object({
    context: GexContextSchema,
    exposure: ExposureSectionSchema,
    flow: FlowSectionSchema,
    // Data limits the reader must know (proxies, approximations, missing fields).
    notes: z.array(z.string().max(300)),
    rateLimited: z.boolean(),
    receivedAt: z.string(),
    retryAfterSeconds: z.number().nonnegative().nullable(),
    source: z.literal("quantdata"),
    spot: finite.nullable(),
    strikeProfiles: StrikeProfilesSchema,
    symbol: z.string(),
    volatility: VolatilitySectionSchema,
  })
  .strict();

export const OPTIONS_ANALYTICS_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_CONFIGURED: {
    message: "QuantData is not configured (QUANTDATA_API_KEY)",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const snapshot = oc
  .errors(OPTIONS_ANALYTICS_ERRORS)
  .route({
    method: "GET",
    operationId: "optionsAnalytics.snapshot",
    path: "/options-analytics/snapshot",
    summary:
      "Read-only IV term structure, skew, IV surface, estimated GEX, option flow and the GEX context (caveats) for one symbol",
    tags: ["Market data"],
  })
  .input(OptionsAnalyticsInputSchema)
  .output(OptionsAnalyticsOutputSchema);

export const optionsAnalyticsContract = { snapshot };

export type OptionsAnalyticsInput = z.input<typeof OptionsAnalyticsInputSchema>;
export type OptionsAnalyticsParsedInput = z.output<
  typeof OptionsAnalyticsInputSchema
>;
export type OptionsAnalyticsOutput = z.infer<
  typeof OptionsAnalyticsOutputSchema
>;
export type VolatilitySection = z.infer<typeof VolatilitySectionSchema>;
export type ExposureSection = z.infer<typeof ExposureSectionSchema>;
export type FlowSection = z.infer<typeof FlowSectionSchema>;
export type FlowEvent = z.infer<typeof FlowEventSchema>;
export type GexContext = z.infer<typeof GexContextSchema>;
export type GexContextFactor = z.infer<typeof GexContextFactorSchema>;
export type OptionsSectionStatus = (typeof OPTIONS_SECTION_STATUSES)[number];
export type StrikeProfiles = z.infer<typeof StrikeProfilesSchema>;
export type StrikeProfileRow = z.infer<typeof StrikeProfileRowSchema>;
export type StrikeProfileFlowSource =
  (typeof STRIKE_PROFILE_FLOW_SOURCES)[number];
