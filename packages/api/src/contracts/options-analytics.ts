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
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/, {
        message: "Symbol: letters and digits, optional class suffix",
      }),
    // GET query values arrive as strings; coerce, then allow only the listed windows.
    flowHours: z.coerce
      .number()
      .int()
      .refine(
        (hours) => (OPTIONS_FLOW_HOURS as readonly number[]).includes(hours),
        { message: "flowHours: 1, 6, 24 or 72" }
      )
      .default(24),
  })
  .strict();

export const OPTIONS_SECTION_STATUSES = ["ok", "empty", "unavailable"] as const;
const SectionStatusSchema = z.enum(OPTIONS_SECTION_STATUSES);

const sectionBase = {
  status: SectionStatusSchema,
  // Plain-text reason when status is "empty" or "unavailable"; null when "ok".
  message: z.string().max(300).nullable(),
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const finite = z.number().finite();

export const TermStructurePointSchema = z
  .object({
    expiry: isoDate,
    dte: z.number().int().nonnegative(),
    atmIv: finite,
  })
  .strict();

// `target` is the IV_SKEW_TARGET_DELTAS column the point was chosen for; `delta` is
// the chosen contract's own rounded delta, which can be up to 18 points away.
export const SkewPointSchema = z
  .object({
    expiry: isoDate,
    target: z.number().int(),
    delta: z.number().int(),
    iv: finite,
  })
  .strict();

export const SurfaceRowSchema = z
  .object({
    expiry: isoDate,
    dte: z.number().int().nonnegative(),
    ivs: z.array(finite.nullable()),
  })
  .strict();

export const VolatilitySectionSchema = z
  .object({
    ...sectionBase,
    termStructure: z.array(TermStructurePointSchema),
    skew: z.array(SkewPointSchema),
    surface: z
      .object({ moneyness: z.array(finite), rows: z.array(SurfaceRowSchema) })
      .strict(),
  })
  .strict();

export const ExposureStrikeSchema = z
  .object({
    strike: finite,
    callOpenInterest: z.number().int().nonnegative(),
    putOpenInterest: z.number().int().nonnegative(),
    // Estimated gamma exposure in dollars per 1% move; null when no IV was available.
    gex: finite.nullable(),
  })
  .strict();

export const ExposureSectionSchema = z
  .object({
    ...sectionBase,
    strikes: z.array(ExposureStrikeSchema),
    maxPain: finite.nullable(),
    totalGex: finite.nullable(),
    // Expiry whose IVs were used for the gamma estimate.
    gexExpiry: isoDate.nullable(),
  })
  .strict();

export const FlowEventSchema = z
  .object({
    time: z.string(),
    contract: z.string().max(40),
    right: z.enum(["call", "put"]),
    strike: finite,
    expiry: isoDate,
    premium: finite,
    size: z.number().int().nonnegative(),
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    flowType: z.string().max(24).nullable(),
    unusual: z.boolean(),
  })
  .strict();

export const FlowBucketSchema = z
  .object({
    start: z.string(),
    callPremium: finite,
    putPremium: finite,
    netPremium: finite,
    trades: z.number().int().nonnegative(),
  })
  .strict();

export const FlowSectionSchema = z
  .object({
    ...sectionBase,
    hours: z.number().int().positive(),
    callPremium: finite,
    putPremium: finite,
    events: z.array(FlowEventSchema),
    buckets: z.array(FlowBucketSchema),
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
export const GEX_REGIMES = ["positive", "negative", "unknown"] as const;
export const GEX_FLOW_BIASES = [
  "bullish",
  "bearish",
  "balanced",
  "unknown",
] as const;
export const IV_TERM_REGIMES = [
  "inverted",
  "flat",
  "contango",
  "unknown",
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
    key: z.enum(GEX_CONTEXT_FACTOR_KEYS),
    label: z.string().max(40),
    value: z.string().max(80),
    tone: z.enum(GEX_CONTEXT_TONES),
    detail: z.string().max(300),
  })
  .strict();

export const GexContextSchema = z
  .object({
    regime: z.enum(GEX_REGIMES),
    // Sign convention behind GEX, the levels, vanna and charm.
    dealerSignAssumption: z.literal("dealers long calls, short puts"),
    levels: z
      .object({
        // Spot where the estimated GEX profile crosses zero (nearest crossing to spot).
        flip: finite.nullable(),
        // Strikes with the largest positive and the most negative estimated GEX.
        callWall: finite.nullable(),
        putWall: finite.nullable(),
        // One-day implied move in dollars: spot x front ATM IV / sqrt(252).
        dailyMove: finite.nullable(),
        // Signed distance from spot to each level, in daily implied moves.
        flipMoves: finite.nullable(),
        callWallMoves: finite.nullable(),
        putWallMoves: finite.nullable(),
      })
      .strict(),
    greeks: z
      .object({
        // Net delta of open interest in dollars, holders' side (calls +, puts -); the
        // only field here that does not use the dealer-sign assumption.
        netDex: finite.nullable(),
        // Estimated change of dealer delta (dollars) per +1 IV point.
        netVanna: finite.nullable(),
        // Estimated change of dealer delta (dollars) per calendar day.
        netCharm: finite.nullable(),
      })
      .strict(),
    flow: z
      .object({
        bias: z.enum(GEX_FLOW_BIASES),
        bullishPremium: finite,
        bearishPremium: finite,
        newestTradeAt: z.string().nullable(),
        // Share of flow premium in contracts expiring today and within 7 days.
        zeroDteShare: finite.nullable(),
        weekShare: finite.nullable(),
      })
      .strict(),
    expiry: z
      .object({
        nextExpiry: isoDate.nullable(),
        nextExpiryDte: z.number().int().nonnegative().nullable(),
        nextMonthlyOpex: isoDate,
        monthlyOpexDays: z.number().int().nonnegative(),
      })
      .strict(),
    iv: z
      .object({
        regime: z.enum(IV_TERM_REGIMES),
        frontIv: finite.nullable(),
        backIv: finite.nullable(),
      })
      .strict(),
    session: z.enum(MARKET_SESSIONS),
    factors: z.array(GexContextFactorSchema),
  })
  .strict();

export const OptionsAnalyticsOutputSchema = z
  .object({
    symbol: z.string(),
    source: z.literal("quantdata"),
    receivedAt: z.string(),
    spot: finite.nullable(),
    rateLimited: z.boolean(),
    retryAfterSeconds: z.number().nonnegative().nullable(),
    // Data limits the reader must know (proxies, approximations, missing fields).
    notes: z.array(z.string().max(300)),
    volatility: VolatilitySectionSchema,
    exposure: ExposureSectionSchema,
    flow: FlowSectionSchema,
    context: GexContextSchema,
  })
  .strict();

export const OPTIONS_ANALYTICS_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_CONFIGURED: {
    status: 503,
    message: "QuantData is not configured (QUANTDATA_API_KEY)",
  },
} as const;

const snapshot = oc
  .errors(OPTIONS_ANALYTICS_ERRORS)
  .route({
    method: "GET",
    path: "/options-analytics/snapshot",
    operationId: "optionsAnalytics.snapshot",
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
