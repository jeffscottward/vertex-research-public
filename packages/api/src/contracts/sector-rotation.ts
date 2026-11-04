import { oc } from "@orpc/contract";
import { z } from "zod";

import { WATCHLIST_SYMBOL_PATTERN } from "./watchlist.ts";

// Sector rotation map (sectorRotation.*): relative strength of each symbol against a benchmark,
// drawn as a ratio (x axis) and a momentum (y axis), both centered on 100. Our own documented
// formula (packages/api/src/sector-rotation.ts), not the proprietary JdK RS-Ratio algorithm.
// Research only: no order path, no instruction to trade. A quadrant is a description of past
// prices, never an authorization.

export const SECTOR_ROTATION_QUADRANTS = [
  "leading",
  "weakening",
  "lagging",
  "improving",
] as const;
export const SECTOR_ROTATION_TIMEFRAMES = ["daily", "weekly"] as const;
export const SECTOR_ROTATION_BENCHMARK = "SPY";
/** The 11 Select Sector SPDR ETFs: the stored, nightly universe. */
export const SECTOR_ROTATION_SECTORS = [
  { name: "Materials", symbol: "XLB" },
  { name: "Communication Services", symbol: "XLC" },
  { name: "Energy", symbol: "XLE" },
  { name: "Financials", symbol: "XLF" },
  { name: "Industrials", symbol: "XLI" },
  { name: "Technology", symbol: "XLK" },
  { name: "Consumer Staples", symbol: "XLP" },
  { name: "Real Estate", symbol: "XLRE" },
  { name: "Utilities", symbol: "XLU" },
  { name: "Health Care", symbol: "XLV" },
  { name: "Consumer Discretionary", symbol: "XLY" },
] as const;
/** Symbols one custom map may hold (watchlist, basket or typed list). */
export const SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS = 30;
/** Calendar days of history a map returns (12 months). */
export const SECTOR_ROTATION_HISTORY_DAYS = 366;
/** Points one series may hold: 12 months of daily bars with margin. */
export const SECTOR_ROTATION_MAX_POINTS = 400;
/** Version of the snapshot document that research agents read (compatibility fixture pinned). */
export const SECTOR_ROTATION_SNAPSHOT_VERSION = 1;
/** Quadrant transitions a snapshot lists, newest first. */
export const SECTOR_ROTATION_SNAPSHOT_MAX_TRANSITIONS = 20;

export type SectorRotationQuadrant = (typeof SECTOR_ROTATION_QUADRANTS)[number];
export type SectorRotationTimeframe =
  (typeof SECTOR_ROTATION_TIMEFRAMES)[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const value = z.number().finite();
const quadrant = z.enum(SECTOR_ROTATION_QUADRANTS);
const outputSymbol = z.string().regex(WATCHLIST_SYMBOL_PATTERN);
const inputSymbol = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((text) => text.toUpperCase())
  .pipe(z.string().regex(WATCHLIST_SYMBOL_PATTERN));

export const SectorRotationParamsSchema = z.object({
  /** EMA span applied to the raw relative strength 100 × price ÷ benchmark. */
  rsSmoothing: z.number().int().min(1),
  /** Simple moving average window of the smoothed relative strength (the trend). */
  trendWindow: z.number().int().min(2),
  /** Periods between the two ratio values of the rate of change. */
  momentumLag: z.number().int().min(1),
  /** EMA span applied to the rate of change. */
  momentumSmoothing: z.number().int().min(1),
});

export const SectorRotationPointSchema = z.object({
  date,
  momentum: value,
  quadrant,
  ratio: value,
});

export const SectorRotationLatestSchema = SectorRotationPointSchema.extend({
  /** Consecutive periods (days or weeks) in the current quadrant, this period included. */
  periods: z.number().int().min(1),
  /** Date of the first period of the current quadrant streak. */
  since: date,
});

export const SectorRotationSeriesSchema = z.object({
  latest: SectorRotationLatestSchema.nullable(),
  name: z.string().max(80).nullable(),
  points: z.array(SectorRotationPointSchema).max(SECTOR_ROTATION_MAX_POINTS),
  symbol: outputSymbol,
});

export const SectorRotationTransitionSchema = z.object({
  date,
  from: quadrant,
  name: z.string().max(80).nullable(),
  symbol: outputSymbol,
  to: quadrant,
});

const SymbolErrorSchema = z.object({
  reason: z.string().max(300),
  symbol: z.string().max(16),
});

export const SectorRotationUniverseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sectors") }).strict(),
  z
    .object({
      kind: z.literal("custom"),
      symbols: z
        .array(inputSymbol)
        .min(1)
        .max(SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS)
        .transform((symbols) => [...new Set(symbols)]),
    })
    .strict(),
]);

export const SectorRotationMapInputSchema = z
  .object({
    benchmark: inputSymbol.default(SECTOR_ROTATION_BENCHMARK),
    timeframe: z.enum(SECTOR_ROTATION_TIMEFRAMES).default("weekly"),
    universe: SectorRotationUniverseSchema.default({ kind: "sectors" }),
  })
  .strict();

export const SectorRotationMapOutputSchema = z.object({
  asOf: date,
  benchmark: outputSymbol,
  /** Symbols without usable bars (unknown ticker, too little history). */
  errors: z.array(SymbolErrorSchema),
  /** ISO timestamp of the computation (stored run or this request). */
  generatedAt: z.string().datetime(),
  params: SectorRotationParamsSchema,
  series: z.array(SectorRotationSeriesSchema),
  /** "stored" = nightly sector points from Postgres; "computed" = custom list computed on request. */
  source: z.enum(["stored", "computed"]),
  timeframe: z.enum(SECTOR_ROTATION_TIMEFRAMES),
  universe: z.enum(["sectors", "custom"]),
});

export const SECTOR_ROTATION_ALERT_DELIVERIES = [
  "sent",
  "not-configured",
  "failed",
  "dry-run",
] as const;

export const SectorRotationAlertSchema = SectorRotationTransitionSchema.extend({
  delivery: z.enum(SECTOR_ROTATION_ALERT_DELIVERIES),
  /** The one fixed-text line sent to ntfy (also printed by the scheduler). */
  line: z.string().max(300),
});

export const SectorRotationCollectInputSchema = z
  .object({
    /** Compute and report only: store nothing, record no alert, send nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();

export const SectorRotationCollectOutputSchema = z.object({
  /** Alerts first recorded by this run: daily entries into leading or lagging. */
  alerts: z.array(SectorRotationAlertSchema),
  asOf: date,
  dryRun: z.boolean(),
  fetchErrors: z.array(SymbolErrorSchema),
  /** Points written (upserted) per timeframe; 0 on a dry run. */
  stored: z.object({
    daily: z.number().int().min(0),
    weekly: z.number().int().min(0),
  }),
  /** Daily quadrant changes on the latest date. */
  transitions: z.array(SectorRotationTransitionSchema),
});

export const SectorRotationSnapshotInputSchema = z
  .object({
    timeframe: z.enum(SECTOR_ROTATION_TIMEFRAMES).default("daily"),
  })
  .strict();

export const SectorRotationSnapshotSectorSchema =
  SectorRotationLatestSchema.extend({
    name: z.string().max(80).nullable(),
    symbol: outputSymbol,
  });

/**
 * Typed research input (versioned): the current quadrant of every stored sector and the recent
 * transitions. Read by the Today page and by research agents (regime desk). The Python model
 * services/research/gamma/schemas/market.py SectorRotationSnapshot mirrors this schema; both sides
 * parse the shared fixture packages/api/src/fixtures/sector-rotation-snapshot.v1.json.
 */
export const SectorRotationSnapshotSchema = z.object({
  asOf: date,
  benchmark: outputSymbol,
  /** Quadrant changes between previousDate and asOf. */
  changes: z.array(SectorRotationTransitionSchema),
  /** The stored period before asOf; null when only one period is stored. */
  previousDate: date.nullable(),
  /** Transitions inside the stored window, newest first (at most 20). */
  recentTransitions: z
    .array(SectorRotationTransitionSchema)
    .max(SECTOR_ROTATION_SNAPSHOT_MAX_TRANSITIONS),
  schemaVersion: z.literal(SECTOR_ROTATION_SNAPSHOT_VERSION),
  sectors: z.array(SectorRotationSnapshotSectorSchema),
  timeframe: z.enum(SECTOR_ROTATION_TIMEFRAMES),
});

export const SECTOR_ROTATION_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Sector rotation not yet collected", status: 404 },
  STORAGE_ERROR: {
    message: "Sector rotation storage unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "Market data source unavailable", status: 503 },
} as const;

const sectorRotation = oc.errors(SECTOR_ROTATION_API_ERRORS);
const tags = ["Sector rotation"];

const map = sectorRotation
  .route({
    method: "POST",
    operationId: "sectorRotation.map",
    path: "/sector-rotation/map",
    summary:
      "Ratio and momentum history of the stored sectors or a custom symbol list",
    tags,
  })
  .input(SectorRotationMapInputSchema)
  .output(SectorRotationMapOutputSchema);

const collect = sectorRotation
  .route({
    method: "POST",
    operationId: "sectorRotation.collect",
    path: "/sector-rotation/collect",
    summary:
      "Scheduler: fetch sector bars, store daily and weekly points and record quadrant alerts",
    tags,
  })
  .input(SectorRotationCollectInputSchema)
  .output(SectorRotationCollectOutputSchema);

const snapshot = sectorRotation
  .route({
    method: "GET",
    operationId: "sectorRotation.snapshot",
    path: "/sector-rotation/snapshot",
    summary: "Current sector quadrants and recent transitions (research input)",
    tags,
  })
  .input(SectorRotationSnapshotInputSchema)
  .output(SectorRotationSnapshotSchema);

export const sectorRotationContract = { collect, map, snapshot };

export type SectorRotationParams = z.infer<typeof SectorRotationParamsSchema>;
export type SectorRotationPoint = z.infer<typeof SectorRotationPointSchema>;
export type SectorRotationLatest = z.infer<typeof SectorRotationLatestSchema>;
export type SectorRotationSeries = z.infer<typeof SectorRotationSeriesSchema>;
export type SectorRotationTransition = z.infer<
  typeof SectorRotationTransitionSchema
>;
export type SectorRotationMapInput = z.input<
  typeof SectorRotationMapInputSchema
>;
export type SectorRotationMapOutput = z.infer<
  typeof SectorRotationMapOutputSchema
>;
export type SectorRotationAlert = z.infer<typeof SectorRotationAlertSchema>;
export type SectorRotationAlertDelivery =
  (typeof SECTOR_ROTATION_ALERT_DELIVERIES)[number];
export type SectorRotationCollectOutput = z.infer<
  typeof SectorRotationCollectOutputSchema
>;
export type SectorRotationSnapshot = z.infer<
  typeof SectorRotationSnapshotSchema
>;
export type SectorRotationSnapshotSector = z.infer<
  typeof SectorRotationSnapshotSectorSchema
>;
