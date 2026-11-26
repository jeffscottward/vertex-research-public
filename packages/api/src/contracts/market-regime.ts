import { oc } from "@orpc/contract";
import { z } from "zod";

import { BREADTH90_DAY_KINDS, BREADTH90_STATES } from "./breadth-90.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import { MARKET_CONTEXT_STALE_SECONDS } from "./market-context.ts";

// Unified market regime view (card vertex-regime-view, design:
// docs/vertex-rebuild/designs/regime-view/design.md). Joins trend (50/200-day SMA), Breadth-90,
// dealer gamma, credit (HY OAS), and volatility (level + term structure) for QQQ, SPY, IWM and
// DIA into one read-only procedure. Research context only: never authorizes a trade, alert, or
// strategy gate.

export const REGIME_INDEX_SYMBOLS = ["QQQ", "SPY", "IWM", "DIA"] as const;
export type RegimeIndexSymbol = (typeof REGIME_INDEX_SYMBOLS)[number];

export const REGIME_SUMMARY_STATES = [
  "risk_on",
  "mixed",
  "risk_off",
  "incomplete",
] as const;
export type RegimeSummaryState = (typeof REGIME_SUMMARY_STATES)[number];

export const REGIME_PILLAR_SCOPES = ["etf", "market_wide"] as const;
export type RegimePillarScope = (typeof REGIME_PILLAR_SCOPES)[number];

export const REGIME_TREND_STATES = [
  "uptrend",
  "mixed",
  "downtrend",
  "missing",
] as const;
export type RegimeTrendState = (typeof REGIME_TREND_STATES)[number];

export const REGIME_BREADTH90_STATES = [
  "fired",
  "forming",
  "armed",
  "idle",
  "missing",
] as const;
export type RegimeBreadth90State = (typeof REGIME_BREADTH90_STATES)[number];

export const REGIME_DEALER_GAMMA_STATES = [
  "positive",
  "neutral",
  "negative",
  "not_covered",
  "missing",
] as const;
export type RegimeDealerGammaState =
  (typeof REGIME_DEALER_GAMMA_STATES)[number];

export const REGIME_CREDIT_STATES = [
  "calm",
  "widening",
  "stressed",
  "missing",
] as const;
export type RegimeCreditState = (typeof REGIME_CREDIT_STATES)[number];

export const REGIME_VOLATILITY_STATES = [
  "calm",
  "elevated",
  "extreme",
  "missing",
] as const;
export type RegimeVolatilityState = (typeof REGIME_VOLATILITY_STATES)[number];

export const REGIME_VOL_TERM_STRUCTURES = [
  "contango",
  "flat",
  "backwardation",
  "missing",
] as const;
export type RegimeVolTermStructure =
  (typeof REGIME_VOL_TERM_STRUCTURES)[number];

export const REGIME_SPOT_VS_FLIP = ["above", "below", "at"] as const;
export type RegimeSpotVsFlip = (typeof REGIME_SPOT_VS_FLIP)[number];

export const REGIME_ETF_VOL_INDEX_IDS = {
  DIA: "VXD",
  IWM: "RVX",
  QQQ: "VXN",
  SPY: "VIX",
} as const satisfies Readonly<Record<RegimeIndexSymbol, string>>;

/** Maximum age for daily-session inputs (matches SPX_CLOSED_STALE_MS: 96 h spans holiday weekends). */
export const REGIME_DAILY_STALE_SECONDS = 96 * 3600;
/** Maximum push age for rig market-context GEX (15 min = 3 missed 5-min pushes). */
export const REGIME_GAMMA_PUSH_STALE_SECONDS = MARKET_CONTEXT_STALE_SECONDS;
/** Maximum age for FRED HY OAS credit spreads (5 days accounts for T-1/T-2 FRED publication lag). */
export const REGIME_CREDIT_STALE_SECONDS = 5 * 24 * 3600;

export const REGIME_RESEARCH_ONLY_NOTE =
  "Research context only. Never authorizes a trade, alert, or strategy gate.";

const finiteNullable = z.number().finite().nullable();
const asOfValue = z
  .union([z.iso.datetime({ offset: true }), CalendarDateSchema])
  .nullable();

const RegimePillarBaseFields = {
  ageSeconds: z.number().int().nonnegative().nullable(),
  asOf: asOfValue,
  detail: z.string().min(1).max(300),
  scope: z.enum(REGIME_PILLAR_SCOPES),
  source: z.string().min(1).max(80),
  stale: z.boolean(),
  staleLimitSeconds: z.number().int().positive(),
};

export const RegimeTrendPillarSchema = z
  .object({
    ...RegimePillarBaseFields,
    close: finiteNullable,
    pctVsSma50: finiteNullable,
    pctVsSma200: finiteNullable,
    sessions: z.number().int().nonnegative(),
    sma50: finiteNullable,
    sma50AboveSma200: z.boolean().nullable(),
    sma200: finiteNullable,
    state: z.enum(REGIME_TREND_STATES),
  })
  .strict();
export type RegimeTrendPillar = z.infer<typeof RegimeTrendPillarSchema>;

export const RegimeBreadth90PillarSchema = z
  .object({
    ...RegimePillarBaseFields,
    armedOn: CalendarDateSchema.nullable(),
    latestAdvPct: finiteNullable,
    latestDate: CalendarDateSchema.nullable(),
    latestFinal: z.boolean().nullable(),
    latestKind: z.enum(BREADTH90_DAY_KINDS).nullable(),
    latestUpPct: finiteNullable,
    sessionsLeft: z.number().int().nonnegative().nullable(),
    signalState: z.enum(BREADTH90_STATES).nullable(),
    state: z.enum(REGIME_BREADTH90_STATES),
    strict: z.boolean().nullable(),
  })
  .strict();
export type RegimeBreadth90Pillar = z.infer<typeof RegimeBreadth90PillarSchema>;

export const RegimeDealerGammaPillarSchema = z
  .object({
    ...RegimePillarBaseFields,
    callWall: finiteNullable,
    flip: finiteNullable,
    netGex: finiteNullable,
    oiSession: CalendarDateSchema.nullable(),
    putWall: finiteNullable,
    spot: finiteNullable,
    spotVsFlip: z.enum(REGIME_SPOT_VS_FLIP).nullable(),
    state: z.enum(REGIME_DEALER_GAMMA_STATES),
    upstreamRegime: z.string().min(1).max(40).nullable(),
  })
  .strict();
export type RegimeDealerGammaPillar = z.infer<
  typeof RegimeDealerGammaPillarSchema
>;

export const RegimeCreditPillarSchema = z
  .object({
    ...RegimePillarBaseFields,
    hyOas: finiteNullable,
    hyOasBps: z.number().int().nullable(),
    hyOasChange20dBps: z.number().int().nullable(),
    hyOasPct1y: finiteNullable,
    igOas: finiteNullable,
    state: z.enum(REGIME_CREDIT_STATES),
  })
  .strict();
export type RegimeCreditPillar = z.infer<typeof RegimeCreditPillarSchema>;

export const RegimeVolatilityPillarSchema = z
  .object({
    ...RegimePillarBaseFields,
    atmIv30d: finiteNullable,
    etfVolIndex: finiteNullable,
    etfVolIndexId: z.enum(["VIX", "VXN", "RVX", "VXD"]),
    ivPercentile: finiteNullable,
    state: z.enum(REGIME_VOLATILITY_STATES),
    termStructure: z.enum(REGIME_VOL_TERM_STRUCTURES),
    vix: finiteNullable,
    vix3mVix6m: finiteNullable,
    vix9dVix: finiteNullable,
    vixVix3m: finiteNullable,
  })
  .strict();
export type RegimeVolatilityPillar = z.infer<
  typeof RegimeVolatilityPillarSchema
>;

export const RegimeEtfRowSchema = z
  .object({
    breadth90: RegimeBreadth90PillarSchema,
    credit: RegimeCreditPillarSchema,
    dealerGamma: RegimeDealerGammaPillarSchema,
    hasStaleInputs: z.boolean(),
    missingCount: z.number().int().nonnegative().max(5),
    mixedDrivers: z.array(z.string().min(1).max(200)).max(8),
    staleCount: z.number().int().nonnegative().max(5),
    summary: z.enum(REGIME_SUMMARY_STATES),
    symbol: z.enum(REGIME_INDEX_SYMBOLS),
    trend: RegimeTrendPillarSchema,
    volatility: RegimeVolatilityPillarSchema,
  })
  .strict();
export type RegimeEtfRow = z.infer<typeof RegimeEtfRowSchema>;

export const MarketRegimeOutputSchema = z
  .object({
    etfs: z.array(RegimeEtfRowSchema).length(REGIME_INDEX_SYMBOLS.length),
    generatedAt: z.iso.datetime({ offset: true }),
    overall: z
      .object({
        missingPillarCount: z.number().int().nonnegative(),
        staleEtfs: z.array(z.enum(REGIME_INDEX_SYMBOLS)).max(4),
        stalePillarCount: z.number().int().nonnegative(),
        summary: z.enum(REGIME_SUMMARY_STATES),
      })
      .strict(),
    researchOnlyNote: z.string().min(1).max(200),
  })
  .strict();
export type MarketRegimeOutput = z.infer<typeof MarketRegimeOutputSchema>;

export const MARKET_REGIME_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const get = oc
  .errors(MARKET_REGIME_API_ERRORS)
  .route({
    method: "GET",
    operationId: "marketRegime.get",
    path: "/market-regime",
    summary:
      "Read-only unified market regime across QQQ, SPY, IWM and DIA (trend, breadth-90, dealer gamma, credit, volatility)",
    tags: ["Market context"],
  })
  .input(z.object({}).strict())
  .output(MarketRegimeOutputSchema);

export const marketRegimeContract = { get };
