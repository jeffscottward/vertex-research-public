import { oc } from "@orpc/contract";
import { z } from "zod";

import { GEX_REGIMES, IV_TERM_REGIMES } from "./options-analytics.ts";

// Unified order-flow + options-flow pipeline (flow.*). The scheduler (flow.collect) samples IBKR
// ticks and depth through vertex-history and QuantData options flow, turns them into per-minute
// features and events, and stores them in Postgres (flow_* tables, migration 0052). flow.snapshot
// reads one symbol's view: underlying order flow, options flow, GEX levels, events, a confluence
// summary and per-source freshness. Research only: nothing here places, changes or cancels orders,
// and a confluence reading is a description of recent flow, never an instruction to trade.
// Doc: docs/vertex-rebuild/flow-pipeline.md.

export const FLOW_SYMBOLS = ["SPY", "ES"] as const;
export const FLOW_OPTION_TICKERS = ["SPY", "SPX"] as const;
export const FLOW_SOURCES = ["ticks", "depth", "options", "gex"] as const;
export const FLOW_SAMPLE_STATUSES = [
  "ok",
  "empty",
  "unavailable",
  "skipped",
] as const;
export const FLOW_EVENT_KINDS = [
  "large_print",
  "off_exchange_print",
  "absorption",
  "stacked_imbalance",
  "exhaustion",
  "option_sweep",
  "option_block",
  "option_golden_sweep",
  "option_print",
] as const;
export const FLOW_DIRECTIONS = ["bullish", "bearish", "neutral"] as const;
export const FLOW_OPTION_SIDES = [
  "above_ask",
  "ask",
  "mid",
  "bid",
  "below_bid",
  "unknown",
] as const;
export const FLOW_MONEYNESS = ["itm", "atm", "otm", "unknown"] as const;
export const FLOW_CONSOLIDATIONS = [
  "sweep",
  "block",
  "split",
  "other",
] as const;
export const FLOW_OPTION_SENTIMENTS = [
  "bullish",
  "bearish",
  "neutral",
] as const;
export const FLOW_VOTES = ["bullish", "bearish", "neutral", "unknown"] as const;
export const FLOW_CONFLUENCE_SUMMARIES = [
  "agree_bullish",
  "agree_bearish",
  "disagree",
  "neutral",
  "insufficient",
] as const;
export const FLOW_FRESHNESS_STATES = [
  "fresh",
  "stale",
  "closed",
  "never",
] as const;
export const FLOW_FACTOR_KEYS = [
  "order_flow",
  "book",
  "options_flow",
  "gex",
] as const;
export const FLOW_SNAPSHOT_VERSION = "flow-snapshot.v1" as const;
export const FLOW_SNAPSHOT_MINUTES_DEFAULT = 120;
export const FLOW_SNAPSHOT_MINUTES_MAX = 390;
export const FLOW_SNAPSHOT_MAX_EVENTS = 60;
export const FLOW_SNAPSHOT_MAX_PRINTS = 25;

export type FlowSymbol = (typeof FLOW_SYMBOLS)[number];
export type FlowOptionTicker = (typeof FLOW_OPTION_TICKERS)[number];
export type FlowSource = (typeof FLOW_SOURCES)[number];
export type FlowSampleStatus = (typeof FLOW_SAMPLE_STATUSES)[number];
export type FlowEventKind = (typeof FLOW_EVENT_KINDS)[number];
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];
export type FlowOptionSide = (typeof FLOW_OPTION_SIDES)[number];
export type FlowMoneyness = (typeof FLOW_MONEYNESS)[number];
export type FlowConsolidation = (typeof FLOW_CONSOLIDATIONS)[number];
export type FlowOptionSentiment = (typeof FLOW_OPTION_SENTIMENTS)[number];
export type FlowVote = (typeof FLOW_VOTES)[number];
export type FlowConfluenceSummary = (typeof FLOW_CONFLUENCE_SUMMARIES)[number];
export type FlowFreshnessState = (typeof FLOW_FRESHNESS_STATES)[number];
export type FlowFactorKey = (typeof FLOW_FACTOR_KEYS)[number];

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const nonNegative = finite.nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().max(40);
const text = (max: number) => z.string().max(max);

export const FlowCollectInputSchema = z
  .object({
    /** Fetch and compute, but store nothing. */
    dryRun: z.boolean().default(false),
    /**
     * Operator backfill: ignore market sessions and due times (IBKR budget checks still apply), and
     * read options flow from the last 72 h, so a closed market shows its last session.
     */
    seed: z.boolean().default(false),
    /** Limit the run to these symbols (default: all). */
    symbols: z.array(z.enum(FLOW_SYMBOLS)).min(1).max(2).optional(),
  })
  .strict();

export const FlowCollectRunSchema = z
  .object({
    symbol: z.enum(FLOW_SYMBOLS),
    source: z.enum(FLOW_SOURCES),
    status: z.enum(FLOW_SAMPLE_STATUSES),
    /** Rows written (minutes, book snapshots, option prints or GEX snapshots). */
    items: count,
    /** Derived events written. */
    events: count,
    message: text(300).nullable(),
  })
  .strict();

export const FlowCollectOutputSchema = z
  .object({
    at: timestamp,
    /** true: another collect run was still active in this server, so this one did nothing. */
    busy: z.boolean(),
    dryRun: z.boolean(),
    runs: z.array(FlowCollectRunSchema),
    /** Rows removed by the retention rule (14 days). */
    pruned: count,
  })
  .strict();

export const FlowSnapshotInputSchema = z
  .object({
    symbol: z.enum(FLOW_SYMBOLS),
    minutes: z.coerce
      .number()
      .int()
      .min(15)
      .max(FLOW_SNAPSHOT_MINUTES_MAX)
      .default(FLOW_SNAPSHOT_MINUTES_DEFAULT),
  })
  .strict();

export const FlowFreshnessSchema = z
  .object({
    source: z.enum(FLOW_SOURCES),
    state: z.enum(FLOW_FRESHNESS_STATES),
    /** Last sample that stored data (status ok). */
    lastOkAt: timestamp.nullable(),
    ageSeconds: count.nullable(),
    /** Last sample of any status, with its message. */
    lastStatus: z.enum(FLOW_SAMPLE_STATUSES).nullable(),
    message: text(300).nullable(),
    sessionOpen: z.boolean(),
  })
  .strict();

export const FlowMinuteSchema = z
  .object({
    minute: timestamp,
    trades: count,
    volume: nonNegative,
    buyVolume: nonNegative,
    sellVolume: nonNegative,
    delta: finite,
    /** Cumulative delta over the sampled minutes of the window. */
    cvd: finite,
    vwap: finite.nullable(),
    close: finite.nullable(),
    /** Seconds of this minute inside a sampled tick window (0..60). */
    coveredSeconds: count,
    bookPressure: finite.nullable(),
    optionTrades: count,
    callPremium: nonNegative,
    putPremium: nonNegative,
    bullishPremium: nonNegative,
    bearishPremium: nonNegative,
  })
  .strict();

export const FlowBookSchema = z
  .object({
    at: timestamp,
    bestBid: finite.nullable(),
    bestAsk: finite.nullable(),
    bidSize: nonNegative,
    askSize: nonNegative,
    /** (bid size − ask size) ÷ (bid size + ask size), −1..1. */
    pressure: finite.nullable(),
    levels: count,
  })
  .strict();

export const FlowOrderFlowSummarySchema = z
  .object({
    volume: nonNegative,
    delta: finite,
    /** delta ÷ volume, −1..1; null without volume. */
    deltaRatio: finite.nullable(),
    coveredSeconds: count,
    windowSeconds: count,
    largePrints: count,
    /** Off-exchange (FINRA TRF) share of volume; null for futures or without volume. */
    offExchangeShare: finite.nullable(),
    lastPrice: finite.nullable(),
    vwap: finite.nullable(),
    book: FlowBookSchema.nullable(),
  })
  .strict();

export const FlowOptionPrintViewSchema = z
  .object({
    at: timestamp,
    contract: text(40),
    right: z.enum(["call", "put"]),
    strike: finite,
    expiry: isoDate,
    size: count,
    price: finite.nullable(),
    premium: nonNegative,
    side: z.enum(FLOW_OPTION_SIDES),
    sentiment: z.enum(FLOW_OPTION_SENTIMENTS),
    consolidation: z.enum(FLOW_CONSOLIDATIONS),
    moneyness: z.enum(FLOW_MONEYNESS),
    unusual: z.boolean(),
    goldenSweep: z.boolean(),
    volumeOverOi: z.boolean(),
    opening: z.boolean(),
  })
  .strict();

export const FlowOptionsSummarySchema = z
  .object({
    ticker: z.enum(FLOW_OPTION_TICKERS),
    trades: count,
    callPremium: nonNegative,
    putPremium: nonNegative,
    putCallPremiumRatio: finite.nullable(),
    bullishPremium: nonNegative,
    bearishPremium: nonNegative,
    /** Premium filled at or above the ask (buyer-initiated) and at or below the bid. */
    askSidePremium: nonNegative,
    bidSidePremium: nonNegative,
    sweeps: count,
    sweepPremium: nonNegative,
    blocks: count,
    blockPremium: nonNegative,
    unusual: count,
    volumeOverOi: count,
    otmPremiumShare: finite.nullable(),
    zeroDtePremiumShare: finite.nullable(),
    openingPremiumShare: finite.nullable(),
    topPrints: z.array(FlowOptionPrintViewSchema).max(FLOW_SNAPSHOT_MAX_PRINTS),
  })
  .strict();

const levels = z
  .object({
    flip: finite.nullable(),
    callWall: finite.nullable(),
    putWall: finite.nullable(),
    maxPain: finite.nullable(),
  })
  .strict();

export const FlowGexSchema = z
  .object({
    at: timestamp,
    ticker: z.enum(FLOW_OPTION_TICKERS),
    /** Options underlying price at the snapshot. */
    spot: finite.nullable(),
    /** Symbol price − options underlying price (ES − SPX); 0 for SPY; null when unknown. */
    basis: finite.nullable(),
    regime: z.enum(GEX_REGIMES),
    totalGex: finite.nullable(),
    netDex: finite.nullable(),
    zeroDteShare: finite.nullable(),
    ivRegime: z.enum(IV_TERM_REGIMES),
    /** Levels in options-underlying price (SPX for ES). */
    levels,
    /** The same levels in the symbol's own price (shifted by basis); null without basis. */
    symbolLevels: levels.nullable(),
  })
  .strict();

export const FlowSnapshotEventSchema = z
  .object({
    at: timestamp,
    kind: z.enum(FLOW_EVENT_KINDS),
    direction: z.enum(FLOW_DIRECTIONS),
    price: finite.nullable(),
    size: nonNegative.nullable(),
    premium: nonNegative.nullable(),
    detail: text(200),
  })
  .strict();

export const FlowFactorSchema = z
  .object({
    key: z.enum(FLOW_FACTOR_KEYS),
    label: text(40),
    vote: z.enum(FLOW_VOTES),
    value: text(80),
    detail: text(300),
  })
  .strict();

export const FlowConfluenceSchema = z
  .object({
    summary: z.enum(FLOW_CONFLUENCE_SUMMARIES),
    label: text(80),
    /** Directional factors only (order flow, book, options flow); GEX is context. */
    bullish: count,
    bearish: count,
    known: count,
    factors: z.array(FlowFactorSchema),
  })
  .strict();

export const FlowSnapshotSchema = z
  .object({
    schemaVersion: z.literal(FLOW_SNAPSHOT_VERSION),
    symbol: z.enum(FLOW_SYMBOLS),
    generatedAt: timestamp,
    /** The window ends at the newest stored data (not now), so a closed market shows its last session. */
    windowStart: timestamp,
    windowEnd: timestamp,
    freshness: z.array(FlowFreshnessSchema),
    minutes: z.array(FlowMinuteSchema),
    orderFlow: FlowOrderFlowSummarySchema,
    optionsFlow: FlowOptionsSummarySchema,
    gex: FlowGexSchema.nullable(),
    events: z.array(FlowSnapshotEventSchema).max(FLOW_SNAPSHOT_MAX_EVENTS),
    confluence: FlowConfluenceSchema,
    notes: z.array(text(300)),
  })
  .strict();

export const FLOW_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Flow storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const flow = oc.errors(FLOW_API_ERRORS);
const tags = ["Flow"];

const collect = flow
  .route({
    method: "POST",
    operationId: "flow.collect",
    path: "/flow/collect",
    summary:
      "Scheduler: sample ticks, depth, options flow and GEX for SPY and ES, store features and events",
    tags,
  })
  .input(FlowCollectInputSchema)
  .output(FlowCollectOutputSchema);

const snapshot = flow
  .route({
    method: "GET",
    operationId: "flow.snapshot",
    path: "/flow/snapshot",
    summary:
      "One symbol's order flow, options flow, GEX levels, events and confluence (research input)",
    tags,
  })
  .input(FlowSnapshotInputSchema)
  .output(FlowSnapshotSchema);

export const flowContract = { collect, snapshot };

export type FlowCollectInput = z.input<typeof FlowCollectInputSchema>;
export type FlowCollectParsedInput = z.output<typeof FlowCollectInputSchema>;
export type FlowCollectOutput = z.infer<typeof FlowCollectOutputSchema>;
export type FlowCollectRun = z.infer<typeof FlowCollectRunSchema>;
export type FlowSnapshotInput = z.input<typeof FlowSnapshotInputSchema>;
export type FlowSnapshotParsedInput = z.output<typeof FlowSnapshotInputSchema>;
export type FlowSnapshot = z.infer<typeof FlowSnapshotSchema>;
export type FlowFreshness = z.infer<typeof FlowFreshnessSchema>;
export type FlowMinute = z.infer<typeof FlowMinuteSchema>;
export type FlowBook = z.infer<typeof FlowBookSchema>;
export type FlowOrderFlowSummary = z.infer<typeof FlowOrderFlowSummarySchema>;
export type FlowOptionsSummary = z.infer<typeof FlowOptionsSummarySchema>;
export type FlowOptionPrintView = z.infer<typeof FlowOptionPrintViewSchema>;
export type FlowGex = z.infer<typeof FlowGexSchema>;
export type FlowSnapshotEvent = z.infer<typeof FlowSnapshotEventSchema>;
export type FlowFactor = z.infer<typeof FlowFactorSchema>;
export type FlowConfluence = z.infer<typeof FlowConfluenceSchema>;
