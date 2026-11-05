import { oc } from "@orpc/contract";
import { z } from "zod";

// Display-only JEV verdict for one stock symbol on /charts (merge plan P5). The server sends
// JEV only allow-listed public price fields derived from daily bars: never account ids,
// positions, NLV, balances or order data. The verdict never places, changes or cancels
// orders. `get` reads the cached verdict and never calls JEV; `refresh` calls JEV at most
// once per symbol per JEV_MIN_INTERVAL_SECONDS and at most JEV_MAX_CALLS_PER_HOUR in total.

export const JEV_STANCES = ["BULLISH", "NEUTRAL", "BEARISH"] as const;
export const JEV_VERDICT_STATES = ["none", "fresh", "stale"] as const;
export const JEV_MIN_INTERVAL_SECONDS = 1800;
export const JEV_MAX_CALLS_PER_HOUR = 12;
export const JEV_STALE_AFTER_SECONDS = 3600;

export const JevVerdictInputSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      // Same characters as the market-data bars request (MarketSymbolSchema).
      .regex(/^[A-Z][A-Z0-9.]{0,11}$/, {
        message: "Symbol: letters, digits and dots, at most 12",
      }),
  })
  .strict();

const probability = z.number().min(0).max(1);

export const JevFactorSchema = z
  .object({
    key: z.string().max(40),
    label: z.string().max(120),
    probability,
  })
  .strict();

export const JevVerdictSchema = z
  .object({
    // JEV's own top choice; `stance` is NEUTRAL when that choice is below the threshold.
    choice: z.enum(JEV_STANCES).nullable(),
    // Close date of the last daily bar that JEV saw.
    dataAsOf: z.string().nullable(),
    decidedAt: z.string(),
    factors: z.array(JevFactorSchema).max(8),
    model: z.string().max(120).nullable(),
    probabilities: z
      .object({
        BEARISH: probability,
        BULLISH: probability,
        NEUTRAL: probability,
      })
      .strict(),
    reason: z.string().max(400),
    // Names of the public fields sent to JEV (no values), for audit on the page.
    sentFields: z.array(z.string().max(40)).max(32),
    stance: z.enum(JEV_STANCES),
  })
  .strict();

export const JEV_FAILURE_CODES = [
  "JEV_HTTP",
  "JEV_TIMEOUT",
  "JEV_INVALID",
  "MARKET_DATA",
  "INSUFFICIENT_DATA",
] as const;

export const JevFailureSchema = z
  .object({
    at: z.string(),
    code: z.enum(JEV_FAILURE_CODES),
    message: z.string().max(300),
  })
  .strict();

export const JevVerdictOutputSchema = z
  .object({
    // false: OPENROUTER_API_KEY or the history service is missing; refresh is unavailable.
    configured: z.boolean(),
    lastFailure: JevFailureSchema.nullable(),
    minIntervalSeconds: z.number().int().positive(),
    nextRefreshAt: z.string().nullable(),
    notes: z.array(z.string().max(300)),
    // true only when this call reached JEV and stored a new verdict.
    refreshed: z.boolean(),
    staleAfterSeconds: z.number().int().positive(),
    state: z.enum(JEV_VERDICT_STATES),
    symbol: z.string(),
    // true when a refresh was refused by the throttle (no JEV call was made).
    throttled: z.boolean(),
    verdict: JevVerdictSchema.nullable(),
  })
  .strict();

export const JEV_VERDICT_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_CONFIGURED: {
    message:
      "JEV verdict is not configured (OPENROUTER_API_KEY and VERTEX_HISTORY_URL)",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const get = oc
  .errors(JEV_VERDICT_ERRORS)
  .route({
    method: "GET",
    operationId: "jevVerdict.get",
    path: "/jev-verdict",
    summary:
      "Cached display-only JEV verdict for one symbol; never calls JEV and never places orders",
    tags: ["Market data"],
  })
  .input(JevVerdictInputSchema)
  .output(JevVerdictOutputSchema);

const refresh = oc
  .errors(JEV_VERDICT_ERRORS)
  .route({
    method: "POST",
    operationId: "jevVerdict.refresh",
    path: "/jev-verdict/refresh",
    summary:
      "Ask JEV for a new display-only verdict from public daily prices, within the per-symbol throttle",
    tags: ["Market data"],
  })
  .input(JevVerdictInputSchema)
  .output(JevVerdictOutputSchema);

export const jevVerdictContract = { get, refresh };

export type JevVerdictInput = z.input<typeof JevVerdictInputSchema>;
export type JevVerdictParsedInput = z.output<typeof JevVerdictInputSchema>;
export type JevVerdictOutput = z.infer<typeof JevVerdictOutputSchema>;
export type JevVerdict = z.infer<typeof JevVerdictSchema>;
export type JevFailure = z.infer<typeof JevFailureSchema>;
export type JevFailureCode = (typeof JEV_FAILURE_CODES)[number];
export type JevStance = (typeof JEV_STANCES)[number];
export type JevVerdictState = (typeof JEV_VERDICT_STATES)[number];
