import { oc } from "@orpc/contract";
import { z } from "zod";

// Setup replay ("time machine"): every past occurrence of one long-only daily setup in one stored
// bar series, each with its outcome (target, stop or time exit), plus a seeded bootstrap Monte
// Carlo over those outcomes. A simulation over past bars, not a prediction. Research only; no
// order path.

export const SETUP_REPLAY_SETUP_IDS = [
  "gapUpHold",
  "breakout20",
  "rsi2Oversold",
  "reclaim50",
] as const;
export const SETUP_REPLAY_STOP_ATR_MULTIPLES = [1, 1.5, 2, 3] as const;
export const SETUP_REPLAY_TARGET_RS = [1, 1.5, 2, 3] as const;
export const SETUP_REPLAY_MAX_HOLD_BARS = [5, 10, 20] as const;
export const SETUP_REPLAY_PATHS = [1000, 5000, 10_000] as const;
/** Occurrences listed in the output, newest first. The summary and Monte Carlo use all of them. */
export const SETUP_REPLAY_MAX_OCCURRENCES = 2000;

/** Daily series id as stored: `SYMBOL:1d`. */
export const SetupReplaySeriesIdSchema = z
  .string()
  .regex(/^[A-Z0-9.^=-]{1,20}:1d$/u);

export const setupReplaySeriesId = (symbol: string): string => `${symbol}:1d`;

const fourChoices = <const T extends readonly [number, number, number, number]>(
  values: T
) =>
  z.union([
    z.literal(values[0]),
    z.literal(values[1]),
    z.literal(values[2]),
    z.literal(values[3]),
  ]);

const threeChoices = <const T extends readonly [number, number, number]>(
  values: T
) =>
  z.union([z.literal(values[0]), z.literal(values[1]), z.literal(values[2])]);

export const SetupReplayRunInputSchema = z
  .object({
    maxHoldBars: threeChoices(SETUP_REPLAY_MAX_HOLD_BARS),
    paths: threeChoices(SETUP_REPLAY_PATHS),
    seriesId: SetupReplaySeriesIdSchema,
    setup: z.enum(SETUP_REPLAY_SETUP_IDS),
    stop: z
      .object({
        kind: z.literal("atr"),
        multiple: fourChoices(SETUP_REPLAY_STOP_ATR_MULTIPLES),
      })
      .strict(),
    targetR: fourChoices(SETUP_REPLAY_TARGET_RS),
  })
  .strict();

export const SetupReplayPresetSchema = z
  .object({
    description: z.string().max(400),
    id: z.enum(SETUP_REPLAY_SETUP_IDS),
    label: z.string().max(80),
  })
  .strict();

export const SetupReplayPresetsOutputSchema = z
  .object({ presets: z.array(SetupReplayPresetSchema).max(20) })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const nullableNumber = z.number().nullable();

export const SetupReplayOccurrenceSchema = z
  .object({
    /**
     * Bars the position was open through, from the fill bar. A time exit fills at the next open,
     * so it shows exactly maxHoldBars; a stop or target counts the bar it filled in.
     */
    barsHeld: z.number().int().min(1),
    entryDate: isoDate,
    entryPrice: z.number().positive(),
    exitDate: isoDate,
    exitPrice: z.number().positive(),
    outcome: z.enum(["target", "stop", "time"]),
    /** Percent, for example 2.5 for +2.5%. */
    returnPct: z.number(),
    rMultiple: z.number(),
  })
  .strict();

export const SetupReplaySummarySchema = z
  .object({
    /** Mean realized R, gap fills included. */
    avgR: nullableNumber,
    /** 1 / (1 + targetR): the target share that breaks even at the planned levels. */
    breakEvenShare: z.number().positive().max(1),
    count: z.number().int().nonnegative(),
    /**
     * Planned (idealized) expectancy: +targetR at the target, -1 at the stop, realized R on time
     * exits. It ignores gap fills; avgR uses the actual fills.
     */
    expectancyR: nullableNumber,
    stopFirst: z.number().int().nonnegative(),
    targetFirst: z.number().int().nonnegative(),
    /** target / (target + stop); compare with breakEvenShare. */
    targetShare: nullableNumber,
    timeExit: z.number().int().nonnegative(),
    /** Share of occurrences with R above 0. */
    winRate: nullableNumber,
  })
  .strict();

export const SetupReplayPercentilesSchema = z
  .object({
    p5: z.number(),
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    p95: z.number(),
  })
  .strict();

export const SetupReplayMonteCarloSchema = z
  .object({
    paths: threeChoices(SETUP_REPLAY_PATHS),
    /** Share of paths whose total R is above 0. */
    pProfit: z.number().min(0).max(1),
    seed: z.number().int().nonnegative(),
    totalR: SetupReplayPercentilesSchema,
    /** Compounded return of one path in percent. */
    totalReturnPct: SetupReplayPercentilesSchema,
    tradesPerPath: z.number().int().min(1),
  })
  .strict();

export const SetupReplayRunOutputSchema = z
  .object({
    /** Null when the setup never occurred. */
    monteCarlo: SetupReplayMonteCarloSchema.nullable(),
    occurrences: z
      .array(SetupReplayOccurrenceSchema)
      .max(SETUP_REPLAY_MAX_OCCURRENCES),
    series: z
      .object({
        bars: z.number().int().min(2),
        from: isoDate,
        id: SetupReplaySeriesIdSchema,
        symbol: z.string(),
        to: isoDate,
      })
      .strict(),
    summary: SetupReplaySummarySchema,
  })
  .strict();

export const SETUP_REPLAY_ERRORS = {
  BAD_REQUEST: { message: "Invalid setup replay parameters", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "No stored daily bars for this series", status: 404 },
  STORAGE_ERROR: { message: "Bar storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const setupReplay = oc.errors(SETUP_REPLAY_ERRORS);

const presets = setupReplay
  .route({
    method: "GET",
    operationId: "setupReplay.presets",
    path: "/setup-replay/presets",
    summary: "List the long-only daily setups the setup replay can run",
    tags: ["Setup replay"],
  })
  .output(SetupReplayPresetsOutputSchema);

const run = setupReplay
  .route({
    method: "POST",
    operationId: "setupReplay.run",
    path: "/setup-replay/run",
    summary:
      "Replay one setup over a stored daily series with a seeded Monte Carlo (research only, no orders)",
    tags: ["Setup replay"],
  })
  .input(SetupReplayRunInputSchema)
  .output(SetupReplayRunOutputSchema);

export const setupReplayContract = { presets, run };

export type SetupReplaySetupId = (typeof SETUP_REPLAY_SETUP_IDS)[number];
export type SetupReplayRunInput = z.infer<typeof SetupReplayRunInputSchema>;
export type SetupReplayRunOutput = z.infer<typeof SetupReplayRunOutputSchema>;
export type SetupReplayPreset = z.infer<typeof SetupReplayPresetSchema>;
export type SetupReplayPresetsOutput = z.infer<
  typeof SetupReplayPresetsOutputSchema
>;
export type SetupReplayOccurrence = z.infer<typeof SetupReplayOccurrenceSchema>;
export type SetupReplaySummary = z.infer<typeof SetupReplaySummarySchema>;
export type SetupReplayMonteCarlo = z.infer<typeof SetupReplayMonteCarloSchema>;
