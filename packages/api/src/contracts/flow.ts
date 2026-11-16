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

export const FLOW_SYMBOLS = ["SPY", "ES", "QQQ", "NQ"] as const;
export const FLOW_OPTION_TICKERS = ["SPY", "SPX", "QQQ", "NDX"] as const;
export const FLOW_SOURCES = [
  "ticks",
  "depth",
  "options",
  "gex",
  "net_drift",
] as const;
/** The sources of flow-snapshot.v1 freshness; net_drift freshness is in flow.control only. */
export const FLOW_SNAPSHOT_SOURCES = [
  "ticks",
  "depth",
  "options",
  "gex",
] as const;
/** The symbols of the MCP tool flow_snapshot, pinned to the recorded semantic-layer eval. */
export const FLOW_SNAPSHOT_TOOL_SYMBOLS = ["SPY", "ES"] as const;
/** Net drift parts: all expiries and same-day (0DTE) expiries; longer = total − zero_dte on read. */
export const FLOW_EXPIRY_PARTS = ["total", "zero_dte"] as const;
/** Id of the net drift request filter (out of the money, no complex, floor, tied or cancelled trades). */
export const FLOW_FILTER_PROFILE = "otm-clean.v1";
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
export type FlowSnapshotSource = (typeof FLOW_SNAPSHOT_SOURCES)[number];
export type FlowExpiryPart = (typeof FLOW_EXPIRY_PARTS)[number];
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

// Control document (flow.control): who is in control of one index group.
export const FLOW_GROUP_IDS = ["sp500", "nasdaq100"] as const;
export const FLOW_CONTROL_STATES = [
  "buyers",
  "sellers",
  "balanced",
  "mixed",
  "no_data",
] as const;
/** Why a side has no state; the order is the priority (the first that applies wins). */
export const FLOW_NO_DATA_REASONS = [
  "market_closed",
  "source_unavailable",
  "stale",
  "gap",
  "session_start",
  "sampled_tape",
  "not_collected",
] as const;
export const FLOW_PARTS_STATUSES = ["complete", "partial", "no_data"] as const;
/** Widened with the futures fold, not in this design. */
export const FLOW_AGREEMENT_STATES = ["not_comparable"] as const;
export const FLOW_CROSS_CHECK_RESULTS = [
  "same_direction",
  "opposite_direction",
  "not_comparable",
  "not_collected",
] as const;
export const FLOW_STUDY_STATUSES = [
  "edge",
  "no-edge",
  "needs-more-data",
  "not_tested",
] as const;
export const FLOW_CAPTURE_MODES = ["sampled"] as const;
export const FLOW_SIGNING_METHODS = ["quote", "tick"] as const;
export const FLOW_TRADE_SIDES = ["buy", "sell"] as const;
export const FLOW_TICKER_ROLES = ["primary", "check"] as const;
export const FLOW_SESSION_EVENTS = ["fomc"] as const;
export const FLOW_CONTROL_VERSION = "flow-control.v1" as const;
export const FLOW_CONTROL_MAX_POINTS = 420;
export const FLOW_CONTROL_MAX_TRADES = 60;
export const FLOW_CONTROL_MAX_MINUTES = 420;
export const FLOW_CONTROL_MAX_ABSORPTIONS = 20;
export const FLOW_CONTROL_MAX_FRESHNESS = 12;
export const FLOW_CONTROL_MAX_NOTES = 12;
export type FlowGroupId = (typeof FLOW_GROUP_IDS)[number];
export type FlowControlState = (typeof FLOW_CONTROL_STATES)[number];
export type FlowNoDataReason = (typeof FLOW_NO_DATA_REASONS)[number];
export type FlowPartsStatus = (typeof FLOW_PARTS_STATUSES)[number];
export type FlowAgreementState = (typeof FLOW_AGREEMENT_STATES)[number];
export type FlowCrossCheckResult = (typeof FLOW_CROSS_CHECK_RESULTS)[number];
export type FlowStudyStatus = (typeof FLOW_STUDY_STATUSES)[number];

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const nonNegative = finite.nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().max(40);
const text = (max: number) => z.string().max(max);

/** The rules of the options-side fold (packages/api/src/flow-control-rules.ts). */
export const FlowControlRulesSchema = z
  .object({
    version: text(40),
    windowMinutes: z.number().int().min(1).max(390),
    enterRatio: z.number().min(0).max(1),
    exitRatio: z.number().min(0).max(1),
    minMinutes: z.number().int().min(1).max(60),
    minBuckets: z.number().int().min(1).max(390),
  })
  .strict();
export type FlowControlRules = z.infer<typeof FlowControlRulesSchema>;

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
    symbols: z.array(z.enum(FLOW_SYMBOLS)).min(1).max(4).optional(),
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

/** The budget line of one collect run (scripts/flow/tick.ts prints it). */
export const FlowCollectBudgetSchema = z
  .object({
    /** Free QuantData starts beyond the caller reserve at the end of the run; null without QuantData. */
    quantDataFree: count.nullable(),
    quantDataReserve: count,
    /** IBKR history requests in the last 120 s; null when the run did not read the window. */
    ibkrRecent: count.nullable(),
    ibkrLimit: count,
    runSeconds: count,
  })
  .strict();

export const FlowCollectOutputSchema = z
  .object({
    at: timestamp,
    /** true: another collect run was still active in this server, so this one did nothing. */
    busy: z.boolean(),
    dryRun: z.boolean(),
    runs: z.array(FlowCollectRunSchema),
    budget: FlowCollectBudgetSchema,
    /** Rows removed by the retention rule (per-table retention). */
    pruned: count,
  })
  .strict();

const snapshotMinutes = z.coerce
  .number()
  .int()
  .min(15)
  .max(FLOW_SNAPSHOT_MINUTES_MAX)
  .default(FLOW_SNAPSHOT_MINUTES_DEFAULT);

export const FlowSnapshotInputSchema = z
  .object({
    symbol: z.enum(FLOW_SYMBOLS),
    minutes: snapshotMinutes,
  })
  .strict();

/** The input of the MCP tool flow_snapshot (the same keys in the same order, SPY and ES only). */
export const FlowSnapshotToolInputSchema = z
  .object({
    symbol: z.enum(FLOW_SNAPSHOT_TOOL_SYMBOLS),
    minutes: snapshotMinutes,
  })
  .strict();

export const FlowFreshnessSchema = z
  .object({
    source: z.enum(FLOW_SNAPSHOT_SOURCES),
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

export const FlowControlInputSchema = z
  .object({ group: z.enum(FLOW_GROUP_IDS) })
  .strict();

export const FlowControlSideSchema = z
  .object({
    instrument: text(12),
    state: z.enum(FLOW_CONTROL_STATES),
    noDataReason: z.enum(FLOW_NO_DATA_REASONS).nullable(),
    direction: z.enum(FLOW_DIRECTIONS),
    label: text(120),
    detail: text(300),
    since: timestamp.nullable(),
    asOf: timestamp.nullable(),
    ratio: z.number().min(-1).max(1).nullable(),
    enterRatio: z.number().min(0).max(1),
    windowStart: timestamp.nullable(),
    windowEnd: timestamp.nullable(),
    inputs: z
      .object({
        numerator: z.number().nullable(),
        denominator: z.number().nullable(),
        rows: count,
      })
      .strict(),
  })
  .strict();

export const FlowControlOptionsSideSchema = FlowControlSideSchema.extend({
  primaryTicker: z.enum(FLOW_OPTION_TICKERS),
  checkTicker: z.enum(FLOW_OPTION_TICKERS),
  checkState: z.enum(FLOW_CONTROL_STATES),
}).strict();

export const FlowAgreementSchema = z
  .object({
    state: z.enum(FLOW_AGREEMENT_STATES),
    direction: z.enum(FLOW_DIRECTIONS),
    label: text(120),
    detail: text(300),
    since: timestamp.nullable(),
  })
  .strict();

export const FlowNetDriftTotalsSchema = z
  .object({
    netCallPremiumUsd: z.number(),
    netPutPremiumUsd: z.number(),
    callMinusPutUsd: z.number(),
    netCallVolume: z.number(),
    netPutVolume: z.number(),
  })
  .strict();

/** Cumulative since 09:30 New York. */
export const FlowNetDriftLineSchema = z
  .object({ netCallPremiumUsd: z.number(), netPutPremiumUsd: z.number() })
  .strict();

export const FlowNetDriftPointSchema = z
  .object({
    minute: timestamp,
    total: FlowNetDriftLineSchema,
    zeroDte: FlowNetDriftLineSchema.nullable(),
    longer: FlowNetDriftLineSchema.nullable(),
    underlyingPrice: z.number().nullable(),
  })
  .strict();

export const FlowNetDriftSeriesSchema = z
  .object({
    ticker: z.enum(FLOW_OPTION_TICKERS),
    role: z.enum(FLOW_TICKER_ROLES),
    asOf: timestamp.nullable(),
    filterProfile: text(40),
    totals: z
      .object({
        cumulativeFrom: timestamp,
        total: FlowNetDriftTotalsSchema.nullable(),
        zeroDte: FlowNetDriftTotalsSchema.nullable(),
        longer: FlowNetDriftTotalsSchema.nullable(),
      })
      .strict(),
    partsStatus: z.enum(FLOW_PARTS_STATUSES),
    partsDetail: text(300).nullable(),
    slopeUsdPerMinute: z.number().nullable(),
    slopeWindowMinutes: z.number().int().min(1).max(390),
    points: z.array(FlowNetDriftPointSchema).max(FLOW_CONTROL_MAX_POINTS),
  })
  .strict();

export const FlowDeepTradesSchema = z
  .object({
    symbol: z.enum(FLOW_SYMBOLS),
    limitSize: z.number().nullable(),
    signing: z.enum(FLOW_SIGNING_METHODS).nullable(),
    capture: z.enum(FLOW_CAPTURE_MODES),
    coverage: z
      .object({
        seenSeconds: count,
        windowSeconds: count,
        share: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    sums: z
      .object({
        buyVolume: z.number(),
        sellVolume: z.number(),
        netVolume: z.number(),
        cumulativeFrom: timestamp.nullable(),
      })
      .strict(),
    trades: z
      .array(
        z
          .object({
            at: timestamp,
            side: z.enum(FLOW_TRADE_SIDES),
            size: z.number(),
            price: z.number(),
            signing: z.enum(FLOW_SIGNING_METHODS),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_TRADES),
    totalTrades: count,
    minutes: z
      .array(
        z
          .object({
            minute: timestamp,
            buyVolume: z.number(),
            sellVolume: z.number(),
            coveredSeconds: z.number().int().min(0).max(60),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_MINUTES),
    absorptions: z
      .array(
        z
          .object({
            at: timestamp,
            direction: z.enum(FLOW_DIRECTIONS),
            price: z.number().nullable(),
            detail: text(200),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_ABSORPTIONS),
  })
  .strict();

export const FlowCrossCheckSchema = z
  .object({
    ticker: z.enum(FLOW_OPTION_TICKERS),
    result: z.enum(FLOW_CROSS_CHECK_RESULTS),
    storedPrints: count,
    unreadRanges: count,
    oldestUnreadAt: timestamp.nullable(),
    detail: text(300),
  })
  .strict();

export const FlowControlStudySchema = z
  .object({
    status: z.enum(FLOW_STUDY_STATUSES),
    strategyId: text(80),
    testedOn: text(10).nullable(),
    rulesVersion: text(400).nullable(),
    detail: text(300),
    agreementDetail: text(120),
  })
  .strict();

export const FlowControlFreshnessSchema = z
  .object({
    source: z.enum(FLOW_SOURCES),
    instrument: text(12),
    state: z.enum(FLOW_FRESHNESS_STATES),
    lastOkAt: timestamp.nullable(),
    ageSeconds: count.nullable(),
    message: text(300).nullable(),
  })
  .strict();

export const FlowSessionLevelsSchema = z
  .object({
    ticker: z.enum(FLOW_OPTION_TICKERS),
    sessionOpen: z.number().nullable(),
    sessionHigh: z.number().nullable(),
    sessionLow: z.number().nullable(),
    previousClose: z.number().nullable(),
    source: z.literal("one_minute_closes"),
  })
  .strict();

export const FlowControlSchema = z
  .object({
    schemaVersion: z.literal(FLOW_CONTROL_VERSION),
    group: z.enum(FLOW_GROUP_IDS),
    generatedAt: timestamp,
    session: z
      .object({
        date: text(10),
        open: z.boolean(),
        optionsOpen: z.boolean(),
        futuresOpen: z.boolean(),
        event: z.enum(FLOW_SESSION_EVENTS).nullable(),
      })
      .strict(),
    levels: FlowSessionLevelsSchema.nullable(),
    rules: FlowControlRulesSchema,
    futures: FlowControlSideSchema,
    options: FlowControlOptionsSideSchema,
    agreement: FlowAgreementSchema,
    netDrift: z.array(FlowNetDriftSeriesSchema).max(2),
    deepTrades: FlowDeepTradesSchema,
    crossCheck: FlowCrossCheckSchema,
    study: FlowControlStudySchema,
    freshness: z
      .array(FlowControlFreshnessSchema)
      .max(FLOW_CONTROL_MAX_FRESHNESS),
    notes: z.array(text(300)).max(FLOW_CONTROL_MAX_NOTES),
  })
  .strict();

const flow = oc.errors(FLOW_API_ERRORS);
const tags = ["Flow"];

const collect = flow
  .route({
    method: "POST",
    operationId: "flow.collect",
    path: "/flow/collect",
    summary:
      "Scheduler: sample ticks, depth, options flow, GEX and net drift for SPY, ES, QQQ and NQ, store features and events",
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

const control = flow
  .route({
    method: "GET",
    operationId: "flow.control",
    path: "/flow/control",
    summary:
      "One index group: who is in control on the futures side and the options side, net drift and study status (research input)",
    tags,
  })
  .input(FlowControlInputSchema)
  .output(FlowControlSchema);

export const flowContract = { collect, control, snapshot };

export type FlowCollectInput = z.input<typeof FlowCollectInputSchema>;
export type FlowCollectParsedInput = z.output<typeof FlowCollectInputSchema>;
export type FlowCollectOutput = z.infer<typeof FlowCollectOutputSchema>;
export type FlowCollectRun = z.infer<typeof FlowCollectRunSchema>;
export type FlowCollectBudget = z.infer<typeof FlowCollectBudgetSchema>;
export type FlowControlInput = z.infer<typeof FlowControlInputSchema>;
export type FlowControl = z.infer<typeof FlowControlSchema>;
export type FlowControlSide = z.infer<typeof FlowControlSideSchema>;
export type FlowControlOptionsSide = z.infer<
  typeof FlowControlOptionsSideSchema
>;
export type FlowAgreement = z.infer<typeof FlowAgreementSchema>;
export type FlowNetDriftTotals = z.infer<typeof FlowNetDriftTotalsSchema>;
export type FlowNetDriftPoint = z.infer<typeof FlowNetDriftPointSchema>;
export type FlowNetDriftSeries = z.infer<typeof FlowNetDriftSeriesSchema>;
export type FlowDeepTrades = z.infer<typeof FlowDeepTradesSchema>;
export type FlowCrossCheck = z.infer<typeof FlowCrossCheckSchema>;
export type FlowControlStudy = z.infer<typeof FlowControlStudySchema>;
export type FlowControlFreshness = z.infer<typeof FlowControlFreshnessSchema>;
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
