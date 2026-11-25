import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

import { GEX_REGIMES, IV_TERM_REGIMES } from "./options-analytics.ts";

// Unified order-flow + options-flow pipeline (flow.*). The scheduler (flow.collect) samples IBKR
// ticks and depth through vertex-history and QuantData options flow, turns them into per-minute
// features and events, and stores them in Postgres (flow_* tables, migration 0052). flow.snapshot
// reads one symbol's view: underlying order flow, options flow, GEX levels, events, a confluence
// summary and per-source freshness. Research only: nothing here places, changes or cancels orders,
// and a confluence reading is a description of recent flow, never an instruction to trade.
// flow.tapeSpeed reads the per-second counts of the ES or NQ tape as bars with bursts
// (flow-tape-speed.v1): a description of how fast the tape traded, never a trade signal.
// flow.hedgingPressure reads the stored SPY or SPX option prints of the newest options session as
// a running sum of estimated dealer hedge notional (flow-hedging-pressure.v1): an estimate, never
// a trade signal.
// flow.putCallRatio reads the stored SPY or SPX option prints as gross put/call premium and volume
// ratios over the newest options session and over stored sessions (flow-put-call-ratio.v1):
// research context only, never a trade signal.
// flow.tradeBubbles reads the stored ES or NQ 1-minute prices and deep futures trades as
// size-proportional bubbles on the price chart (flow-trade-bubbles.v1): research context only,
// never a trade signal.
// Doc: docs/vertex-rebuild/flow-pipeline.md.

export const FLOW_SYMBOLS = ["SPY", "ES", "QQQ", "NQ"] as const;
export const FLOW_OPTION_TICKERS = ["SPY", "SPX", "QQQ", "NDX"] as const;
export const FLOW_SOURCES = [
  "ticks",
  "depth",
  "options",
  "gex",
  "net_drift",
  "market_premium",
] as const;
/** Maximum age metadata for every QuantVPS flow collector source (single source of truth). */
export type FlowSourceMetadata = Readonly<{
  label: string;
  /** Seconds after which a source's newest data counts as stale while its market is open. */
  maxAgeSeconds: number;
  smartMoney: boolean;
}>;
export const FLOW_SOURCE_METADATA: Readonly<
  Record<(typeof FLOW_SOURCES)[number], FlowSourceMetadata>
> = {
  depth: {
    label: "Order book depth",
    maxAgeSeconds: 180,
    smartMoney: false,
  },
  gex: {
    label: "Options GEX",
    maxAgeSeconds: 1800,
    smartMoney: false,
  },
  market_premium: {
    label: "Large options premium (QuantData)",
    maxAgeSeconds: 1800,
    smartMoney: true,
  },
  net_drift: {
    label: "Options net drift",
    maxAgeSeconds: 300,
    smartMoney: false,
  },
  options: {
    label: "Options prints",
    maxAgeSeconds: 300,
    smartMoney: false,
  },
  ticks: {
    label: "Trade ticks",
    maxAgeSeconds: 600,
    smartMoney: false,
  },
};
/**
 * The sources of flow-snapshot.v1 freshness; net_drift freshness is in flow.control only, and
 * market_premium (market-wide, recorded under SPY) is in smartMoney.ranking only.
 */
export const FLOW_SNAPSHOT_SOURCES = [
  "ticks",
  "depth",
  "options",
  "gex",
] as const;
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
  "not_classified",
] as const;
// `not_reported`: the feed gave no moneyness for the print (stored as `unknown`, see
// StoredMoneyness in flow-options.ts).
export const FLOW_MONEYNESS = ["itm", "atm", "otm", "not_reported"] as const;
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
export const FLOW_VOTES = [
  "bullish",
  "bearish",
  "neutral",
  "no_data",
  "context",
] as const;
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
export const FLOW_EVENTS_VERSION = "flow-events.v1" as const;
export const FLOW_EVENTS_MAX = 200;

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
  "storage_failed",
  "stale",
  "gap",
  "session_start",
  "not_collected",
] as const;
/** Start of a sample message whose source answered but whose rows could not be stored. */
export const FLOW_STORAGE_FAILURE_PREFIX = "storage: write failed";
export const FLOW_PARTS_STATUSES = ["complete", "partial", "no_data"] as const;
/**
 * agree: both sides show the same control side. diverge: opposite control sides. one_sided: one side
 * is in control and the other is balanced. not_comparable: a side has no data or the options side is mixed.
 */
export const FLOW_AGREEMENT_STATES = [
  "not_comparable",
  "agree",
  "diverge",
  "one_sided",
  "both_balanced",
] as const;
/** The entry check of the futures fold that failed first (packages/api/src/flow-control-rules.ts). */
export const FLOW_FUTURES_HOLDS = [
  "few_trades",
  "delta_against",
  "price_against",
] as const;
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
export const FLOW_CAPTURE_MODES = ["sampled", "streamed"] as const;
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

// Tape speed document (flow.tapeSpeed): trades and contracts per second of one streamed future.
/** The symbols with a streamed tape (FLOW_INSTRUMENTS ticks "stream"). */
export const FLOW_TAPE_SYMBOLS = ["ES", "NQ"] as const;
/**
 * counted: the minute has per-second counts and the bar has a covered second. not_recorded: the
 * minute was collected (it has a minute row) and has no per-second counts. no_data: every other
 * bar. The order is the priority.
 */
export const FLOW_TAPE_SPEED_BAR_STATES = [
  "counted",
  "not_recorded",
  "no_data",
] as const;
export const FLOW_TAPE_SPEED_VERSION = "flow-tape-speed.v1" as const;
/** The 390-minute window has 391 minutes on its axis and one bar per minute. */
export const FLOW_TAPE_SPEED_MAX_BARS = 391;
export const FLOW_TAPE_SPEED_MAX_BURSTS = 50;
export type FlowTapeSymbol = (typeof FLOW_TAPE_SYMBOLS)[number];
export type FlowTapeSpeedBarState = (typeof FLOW_TAPE_SPEED_BAR_STATES)[number];

// Hedging pressure document (flow.hedgingPressure): running dealer hedge notional of one session.
/** The symbols with stored option prints (FLOW_INSTRUMENTS sources include "options"). */
export const FLOW_HEDGING_SYMBOLS = ["SPY", "ES"] as const;
export const FLOW_HEDGING_PRESSURE_VERSION =
  "flow-hedging-pressure.v1" as const;
/** One point per minute of the options session, 09:30 to 16:15 New York: 405 minutes. */
export const FLOW_HEDGING_MAX_POINTS = 405;
export type FlowHedgingSymbol = (typeof FLOW_HEDGING_SYMBOLS)[number];

// Put/call ratio document (flow.putCallRatio): gross put/call premium and volume ratios of stored
// option prints over the newest options session (running) and over stored sessions (daily).
/** The symbols with stored option prints (FLOW_INSTRUMENTS sources include "options"). */
export const FLOW_PUT_CALL_RATIO_SYMBOLS = ["SPY", "ES"] as const;
export const FLOW_PUT_CALL_RATIO_VERSION = "flow-put-call-ratio.v1" as const;
/** One point per minute of the options session, 09:30 to 16:15 New York: 405 minutes. */
export const FLOW_PUT_CALL_RATIO_MAX_POINTS = 405;
/** Daily sessions returned (14-day option print retention holds at most ~10-14 sessions). */
export const FLOW_PUT_CALL_RATIO_MAX_DAYS = 20;
export type FlowPutCallRatioSymbol =
  (typeof FLOW_PUT_CALL_RATIO_SYMBOLS)[number];

// Strike × time options flow heatmap (flow.strikeHeatmap): directional signed net premium of
// stored option prints across strikes and intraday time buckets of the newest options session.
/** The symbols with stored option prints (FLOW_INSTRUMENTS sources include "options"). */
export const FLOW_STRIKE_HEATMAP_SYMBOLS = ["SPY", "ES"] as const;
export const FLOW_STRIKE_HEATMAP_VERSION = "flow-strike-heatmap.v1" as const;
/** Supported time bucket widths in minutes (all divide 09:30 New York open cleanly). */
export const FLOW_STRIKE_HEATMAP_BUCKETS = [5, 15, 30] as const;
/** 09:30 to 16:15 New York (405 minutes) at 5-minute granularity = 81 slots. */
export const FLOW_STRIKE_HEATMAP_MAX_SLOTS = 81;
/** Maximum displayed strikes per session (top strikes by gross premium). */
export const FLOW_STRIKE_HEATMAP_MAX_STRIKES = 20;
/** Maximum sparse cells returned (20 strikes × 81 slots). */
export const FLOW_STRIKE_HEATMAP_MAX_CELLS =
  FLOW_STRIKE_HEATMAP_MAX_STRIKES * FLOW_STRIKE_HEATMAP_MAX_SLOTS;
export type FlowStrikeHeatmapSymbol =
  (typeof FLOW_STRIKE_HEATMAP_SYMBOLS)[number];
export type FlowStrikeHeatmapBucketMinutes =
  (typeof FLOW_STRIKE_HEATMAP_BUCKETS)[number];

// Option print bubbles on the intraday price chart (flow.optionBubbles): large stored option
// prints overlaid on the newest options session's underlying price trajectory, sized by premium,
// colored by right (call/put), and styled by aggressor side.
/** The symbols with stored option prints (FLOW_INSTRUMENTS sources include "options"). */
export const FLOW_OPTION_BUBBLES_SYMBOLS = ["SPY", "ES"] as const;
export const FLOW_OPTION_BUBBLES_VERSION = "flow-option-bubbles.v1" as const;
/** Supported minimum print premium thresholds in US dollars. */
export const FLOW_OPTION_BUBBLES_MIN_PREMIUMS = [
  100_000, 250_000, 500_000, 1_000_000,
] as const;
/** Maximum large option prints returned per session (largest prints by premium). */
export const FLOW_OPTION_BUBBLES_MAX_BUBBLES = 120;
/** One price point per minute of the options session, 09:30 to 16:15 New York: 405 minutes. */
export const FLOW_OPTION_BUBBLES_MAX_POINTS = 405;
/** Maximum clipped open collector gap bands returned per session. */
export const FLOW_OPTION_BUBBLES_MAX_GAPS = 50;
export type FlowOptionBubblesSymbol =
  (typeof FLOW_OPTION_BUBBLES_SYMBOLS)[number];
export type FlowOptionBubblesMinPremiumUsd =
  (typeof FLOW_OPTION_BUBBLES_MIN_PREMIUMS)[number];

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const nonNegative = finite.nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().max(40);
const text = (max: number) => z.string().max(max);

/** The rules of the options-side fold (packages/api/src/flow-control-rules.ts). */
export const FlowControlRulesSchema = z
  .object({
    enterRatio: z.number().min(0).max(1),
    exitRatio: z.number().min(0).max(1),
    minBuckets: z.number().int().min(1).max(390),
    minMinutes: z.number().int().min(1).max(60),
    version: text(40),
    windowMinutes: z.number().int().min(1).max(390),
  })
  .strict();
export type FlowControlRules = z.infer<typeof FlowControlRulesSchema>;

/** The rules of the futures-side fold: the options numbers plus the tape and entry-check numbers. */
export const FlowFuturesRulesSchema = FlowControlRulesSchema.extend({
  maxMissingMinutes: z.number().int().min(0).max(30),
  minCoveredSeconds: z.number().int().min(1).max(60),
  minTrades: z.number().int().min(1).max(1000),
  version: z.literal("flow-futures-rules.v1"),
}).strict();
export type FlowFuturesRules = z.infer<typeof FlowFuturesRulesSchema>;

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
    /** Derived events written. */
    events: count,
    /** Rows written (minutes, book snapshots, option prints or GEX snapshots). */
    items: count,
    message: text(300).nullable(),
    source: z.enum(FLOW_SOURCES),
    status: z.enum(FLOW_SAMPLE_STATUSES),
    symbol: z.enum(FLOW_SYMBOLS),
  })
  .strict();

/** The budget line of one collect run (scripts/flow/tick.ts prints it). */
export const FlowCollectBudgetSchema = z
  .object({
    ibkrLimit: count,
    /** IBKR history requests in the last 120 s; null when the run did not read the window. */
    ibkrRecent: count.nullable(),
    /** Free QuantData starts beyond the caller reserve at the end of the run; null without QuantData. */
    quantDataFree: count.nullable(),
    quantDataReserve: count,
    runSeconds: count,
  })
  .strict();

export const FlowCollectOutputSchema = z
  .object({
    at: timestamp,
    budget: FlowCollectBudgetSchema,
    /** true: another collect run was still active in this server, so this one did nothing. */
    busy: z.boolean(),
    dryRun: z.boolean(),
    /** Rows removed by the retention rule (per-table retention). */
    pruned: count,
    runs: z.array(FlowCollectRunSchema),
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
    minutes: snapshotMinutes,
    symbol: z.enum(FLOW_SYMBOLS),
  })
  .strict();

export const FlowFreshnessSchema = z
  .object({
    ageSeconds: count.nullable(),
    /** Last sample that stored data (status ok). */
    lastOkAt: timestamp.nullable(),
    /** Last sample of any status, with its message. */
    lastStatus: z.enum(FLOW_SAMPLE_STATUSES).nullable(),
    message: text(300).nullable(),
    sessionOpen: z.boolean(),
    source: z.enum(FLOW_SNAPSHOT_SOURCES),
    state: z.enum(FLOW_FRESHNESS_STATES),
  })
  .strict();

export const FlowMinuteSchema = z
  .object({
    bearishPremium: nonNegative,
    bookPressure: finite.nullable(),
    bullishPremium: nonNegative,
    buyVolume: nonNegative,
    callPremium: nonNegative,
    close: finite.nullable(),
    /** Seconds of this minute inside a sampled tick window (0..60). */
    coveredSeconds: count,
    /** Cumulative delta over the stored minutes of the window. */
    cvd: finite,
    delta: finite,
    minute: timestamp,
    optionTrades: count,
    putPremium: nonNegative,
    sellVolume: nonNegative,
    trades: count,
    volume: nonNegative,
    vwap: finite.nullable(),
  })
  .strict();

export const FlowBookSchema = z
  .object({
    askSize: nonNegative,
    at: timestamp,
    bestAsk: finite.nullable(),
    bestBid: finite.nullable(),
    bidSize: nonNegative,
    levels: count,
    /** (bid size − ask size) ÷ (bid size + ask size), −1..1. */
    pressure: finite.nullable(),
  })
  .strict();

export const FlowOrderFlowSummarySchema = z
  .object({
    book: FlowBookSchema.nullable(),
    coveredSeconds: count,
    delta: finite,
    /** delta ÷ volume, −1..1; null without volume. */
    deltaRatio: finite.nullable(),
    largePrints: count,
    lastPrice: finite.nullable(),
    /** Off-exchange (FINRA TRF) share of volume; null for futures or without volume. */
    offExchangeShare: finite.nullable(),
    volume: nonNegative,
    vwap: finite.nullable(),
    windowSeconds: count,
  })
  .strict();

export const FlowOptionPrintViewSchema = z
  .object({
    at: timestamp,
    consolidation: z.enum(FLOW_CONSOLIDATIONS),
    contract: text(40),
    expiry: isoDate,
    goldenSweep: z.boolean(),
    moneyness: z.enum(FLOW_MONEYNESS),
    opening: z.boolean(),
    premium: nonNegative,
    price: finite.nullable(),
    right: z.enum(["call", "put"]),
    sentiment: z.enum(FLOW_OPTION_SENTIMENTS),
    side: z.enum(FLOW_OPTION_SIDES),
    size: count,
    strike: finite,
    unusual: z.boolean(),
    volumeOverOi: z.boolean(),
  })
  .strict();

export const FlowOptionsSummarySchema = z
  .object({
    /** Premium filled at or above the ask (buyer-initiated) and at or below the bid. */
    askSidePremium: nonNegative,
    bearishPremium: nonNegative,
    bidSidePremium: nonNegative,
    blockPremium: nonNegative,
    blocks: count,
    bullishPremium: nonNegative,
    callPremium: nonNegative,
    openingPremiumShare: finite.nullable(),
    otmPremiumShare: finite.nullable(),
    putCallPremiumRatio: finite.nullable(),
    putPremium: nonNegative,
    sweepPremium: nonNegative,
    sweeps: count,
    ticker: z.enum(FLOW_OPTION_TICKERS),
    topPrints: z.array(FlowOptionPrintViewSchema).max(FLOW_SNAPSHOT_MAX_PRINTS),
    trades: count,
    unusual: count,
    volumeOverOi: count,
    zeroDtePremiumShare: finite.nullable(),
  })
  .strict();

const levels = z
  .object({
    callWall: finite.nullable(),
    flip: finite.nullable(),
    kingNode: finite.nullable(),
    maxPain: finite.nullable(),
    putWall: finite.nullable(),
  })
  .strict();

export const FlowGexSchema = z
  .object({
    at: timestamp,
    /** Symbol price − options underlying price (ES − SPX); 0 for SPY; null when unknown. */
    basis: finite.nullable(),
    ivRegime: z.enum(IV_TERM_REGIMES),
    /** Levels in options-underlying price (SPX for ES). */
    levels,
    netDex: finite.nullable(),
    regime: z.enum(GEX_REGIMES),
    /** Options underlying price at the snapshot. */
    spot: finite.nullable(),
    /** The same levels in the symbol's own price (shifted by basis); null without basis. */
    symbolLevels: levels.nullable(),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totalGex: finite.nullable(),
    zeroDteShare: finite.nullable(),
  })
  .strict();

export const FlowSnapshotEventSchema = z
  .object({
    at: timestamp,
    detail: text(200),
    direction: z.enum(FLOW_DIRECTIONS),
    kind: z.enum(FLOW_EVENT_KINDS),
    premium: nonNegative.nullable(),
    price: finite.nullable(),
    size: nonNegative.nullable(),
  })
  .strict();

export const FlowFactorSchema = z
  .object({
    detail: text(300),
    key: z.enum(FLOW_FACTOR_KEYS),
    label: text(40),
    value: text(80),
    vote: z.enum(FLOW_VOTES),
  })
  .strict();

export const FlowConfluenceSchema = z
  .object({
    bearish: count,
    /** Directional factors only (order flow, book, options flow); GEX is context. */
    bullish: count,
    factors: z.array(FlowFactorSchema),
    known: count,
    label: text(80),
    summary: z.enum(FLOW_CONFLUENCE_SUMMARIES),
  })
  .strict();

export const FlowSnapshotSchema = z
  .object({
    confluence: FlowConfluenceSchema,
    events: z.array(FlowSnapshotEventSchema).max(FLOW_SNAPSHOT_MAX_EVENTS),
    freshness: z.array(FlowFreshnessSchema),
    generatedAt: timestamp,
    gex: FlowGexSchema.nullable(),
    minutes: z.array(FlowMinuteSchema),
    notes: z.array(text(300)),
    optionsFlow: FlowOptionsSummarySchema,
    orderFlow: FlowOrderFlowSummarySchema,
    schemaVersion: z.literal(FLOW_SNAPSHOT_VERSION),
    symbol: z.enum(FLOW_SYMBOLS),
    windowEnd: timestamp,
    /** The window ends at the newest stored data (not now), so a closed market shows its last session. */
    windowStart: timestamp,
  })
  .strict();

export const FLOW_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Flow storage request failed; retry", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

export const FlowControlInputSchema = z
  .object({ group: z.enum(FLOW_GROUP_IDS) })
  .strict();

export const FlowControlSideSchema = z
  .object({
    asOf: timestamp.nullable(),
    detail: text(300),
    direction: z.enum(FLOW_DIRECTIONS),
    enterRatio: z.number().min(0).max(1),
    inputs: z
      .object({
        denominator: z.number().nullable(),
        numerator: z.number().nullable(),
        rows: count,
      })
      .strict(),
    instrument: text(12),
    label: text(120),
    noDataReason: z.enum(FLOW_NO_DATA_REASONS).nullable(),
    ratio: z.number().min(-1).max(1).nullable(),
    since: timestamp.nullable(),
    state: z.enum(FLOW_CONTROL_STATES),
    windowEnd: timestamp.nullable(),
    windowStart: timestamp.nullable(),
  })
  .strict();

export const FlowControlOptionsSideSchema = FlowControlSideSchema.extend({
  checkState: z.enum(FLOW_CONTROL_STATES),
  checkTicker: z.enum(FLOW_OPTION_TICKERS),
  primaryTicker: z.enum(FLOW_OPTION_TICKERS),
}).strict();

/** The futures side: `ratio` is the deep-trade ratio before the entry checks. */
export const FlowControlFuturesSideSchema = FlowControlSideSchema.extend({
  hold: z.enum(FLOW_FUTURES_HOLDS).nullable(),
  trades: count,
}).strict();

export const FlowAgreementSchema = z
  .object({
    detail: text(300),
    direction: z.enum(FLOW_DIRECTIONS),
    label: text(120),
    since: timestamp.nullable(),
    state: z.enum(FLOW_AGREEMENT_STATES),
  })
  .strict();

export const FlowNetDriftTotalsSchema = z
  .object({
    callMinusPutUsd: z.number(),
    netCallPremiumUsd: z.number(),
    netCallVolume: z.number(),
    netPutPremiumUsd: z.number(),
    netPutVolume: z.number(),
  })
  .strict();

/** Cumulative since 09:30 New York. */
export const FlowNetDriftLineSchema = z
  .object({ netCallPremiumUsd: z.number(), netPutPremiumUsd: z.number() })
  .strict();

export const FlowNetDriftPointSchema = z
  .object({
    longer: FlowNetDriftLineSchema.nullable(),
    minute: timestamp,
    total: FlowNetDriftLineSchema,
    underlyingPrice: z.number().nullable(),
    zeroDte: FlowNetDriftLineSchema.nullable(),
  })
  .strict();

export const FlowNetDriftSeriesSchema = z
  .object({
    asOf: timestamp.nullable(),
    filterProfile: text(40),
    partsDetail: text(300).nullable(),
    partsStatus: z.enum(FLOW_PARTS_STATUSES),
    points: z.array(FlowNetDriftPointSchema).max(FLOW_CONTROL_MAX_POINTS),
    role: z.enum(FLOW_TICKER_ROLES),
    slopeUsdPerMinute: z.number().nullable(),
    slopeWindowMinutes: z.number().int().min(1).max(390),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totals: z
      .object({
        cumulativeFrom: timestamp,
        longer: FlowNetDriftTotalsSchema.nullable(),
        total: FlowNetDriftTotalsSchema.nullable(),
        zeroDte: FlowNetDriftTotalsSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const FlowDeepTradesSchema = z
  .object({
    absorptions: z
      .array(
        z
          .object({
            at: timestamp,
            detail: text(200),
            direction: z.enum(FLOW_DIRECTIONS),
            price: z.number().nullable(),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_ABSORPTIONS),
    capture: z.enum(FLOW_CAPTURE_MODES),
    coverage: z
      .object({
        seenSeconds: count,
        share: z.number().min(0).max(1).nullable(),
        windowSeconds: count,
      })
      .strict(),
    limitSize: z.number().nullable(),
    minutes: z
      .array(
        z
          .object({
            buyVolume: z.number(),
            coveredSeconds: z.number().int().min(0).max(60),
            minute: timestamp,
            sellVolume: z.number(),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_MINUTES),
    signing: z.enum(FLOW_SIGNING_METHODS).nullable(),
    sums: z
      .object({
        buyVolume: z.number(),
        cumulativeFrom: timestamp.nullable(),
        netVolume: z.number(),
        sellVolume: z.number(),
      })
      .strict(),
    symbol: z.enum(FLOW_SYMBOLS),
    totalTrades: count,
    trades: z
      .array(
        z
          .object({
            at: timestamp,
            price: z.number(),
            side: z.enum(FLOW_TRADE_SIDES),
            signing: z.enum(FLOW_SIGNING_METHODS),
            size: z.number(),
          })
          .strict()
      )
      .max(FLOW_CONTROL_MAX_TRADES),
  })
  .strict();

export const FlowCrossCheckSchema = z
  .object({
    detail: text(300),
    oldestUnreadAt: timestamp.nullable(),
    result: z.enum(FLOW_CROSS_CHECK_RESULTS),
    storedPrints: count,
    ticker: z.enum(FLOW_OPTION_TICKERS),
    unreadRanges: count,
  })
  .strict();

export const FlowControlStudySchema = z
  .object({
    agreementDetail: text(120),
    detail: text(300),
    rulesVersion: text(400).nullable(),
    status: z.enum(FLOW_STUDY_STATUSES),
    strategyId: text(80),
    testedOn: text(10).nullable(),
  })
  .strict();

export const FlowControlFreshnessSchema = z
  .object({
    ageSeconds: count.nullable(),
    instrument: text(12),
    lastOkAt: timestamp.nullable(),
    message: text(300).nullable(),
    source: z.enum(FLOW_SOURCES),
    state: z.enum(FLOW_FRESHNESS_STATES),
  })
  .strict();

export const FlowSessionLevelsSchema = z
  .object({
    previousClose: z.number().nullable(),
    sessionHigh: z.number().nullable(),
    sessionLow: z.number().nullable(),
    sessionOpen: z.number().nullable(),
    source: z.literal("one_minute_closes"),
    ticker: z.enum(FLOW_OPTION_TICKERS),
  })
  .strict();

export const FlowControlSchema = z
  .object({
    agreement: FlowAgreementSchema,
    crossCheck: FlowCrossCheckSchema,
    deepTrades: FlowDeepTradesSchema,
    freshness: z
      .array(FlowControlFreshnessSchema)
      .max(FLOW_CONTROL_MAX_FRESHNESS),
    futures: FlowControlFuturesSideSchema,
    futuresRules: FlowFuturesRulesSchema,
    generatedAt: timestamp,
    group: z.enum(FLOW_GROUP_IDS),
    levels: FlowSessionLevelsSchema.nullable(),
    netDrift: z.array(FlowNetDriftSeriesSchema).max(2),
    notes: z.array(text(300)).max(FLOW_CONTROL_MAX_NOTES),
    options: FlowControlOptionsSideSchema,
    rules: FlowControlRulesSchema,
    schemaVersion: z.literal(FLOW_CONTROL_VERSION),
    session: z
      .object({
        date: text(10),
        event: z.enum(FLOW_SESSION_EVENTS).nullable(),
        futuresOpen: z.boolean(),
        open: z.boolean(),
        optionsOpen: z.boolean(),
      })
      .strict(),
    study: FlowControlStudySchema,
  })
  .strict();

export const FlowTapeSpeedInputSchema = z
  .object({
    minutes: snapshotMinutes,
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
  })
  .strict();

/** The rule that marks a burst second (packages/api/src/flow-tape-speed-rules.ts). */
export const FlowTapeSpeedRulesSchema = z
  .object({
    /** The baseline of a second: the mean trades per second of this many seconds before it. */
    baselineSeconds: count,
    /** ...and at least this many trades. */
    floorTrades: count,
    /** Fewer covered seconds in the baseline: the second is not evaluated. */
    minBaselineCoveredSeconds: count,
    /** A burst second has at least this multiple of its baseline... */
    multiple: finite.positive(),
    version: text(40),
  })
  .strict();

export const FlowTapeSpeedBarSchema = z
  .object({
    burstSeconds: count,
    contracts: count,
    /** Covered seconds of the bar (0..bucketSeconds). The counts below are of these seconds. */
    coveredSeconds: count,
    peakContracts: count,
    /** The most trades, and the most contracts, of one covered second of the bar. */
    peakTrades: count,
    start: timestamp,
    state: z.enum(FLOW_TAPE_SPEED_BAR_STATES),
    trades: count,
  })
  .strict();

/** A run of consecutive burst seconds. */
export const FlowTapeSpeedBurstSchema = z
  .object({
    /** Mean trades per second before the first second of the burst. */
    baseline: nonNegative,
    contracts: count,
    /** peakTrades ÷ baseline; null for a baseline of 0. */
    multiple: finite.nullable(),
    /** The most trades of one second of the burst. */
    peakTrades: count,
    seconds: count,
    /** The first second of the burst. */
    start: timestamp,
  })
  .strict();

export const FlowTapeSpeedTotalsSchema = z
  .object({
    /** Bursts with a second on the axis; `bursts` of the document lists the newest of them. */
    bursts: count,
    /** Covered seconds on the axis, and those of them that the rule could evaluate. */
    coveredSeconds: count,
    evaluatedSeconds: count,
  })
  .strict();

export const FlowTapeSpeedSchema = z
  .object({
    /** Start of the first bar; bar i starts i × bucketSeconds later. */
    axisStart: timestamp,
    bars: z.array(FlowTapeSpeedBarSchema).max(FLOW_TAPE_SPEED_MAX_BARS),
    bucketSeconds: count,
    /** Oldest first. */
    bursts: z.array(FlowTapeSpeedBurstSchema).max(FLOW_TAPE_SPEED_MAX_BURSTS),
    /** Local symbol of the contract of the newest per-second row of the axis; null without one. */
    contract: text(20).nullable(),
    rules: FlowTapeSpeedRulesSchema,
    schemaVersion: z.literal(FLOW_TAPE_SPEED_VERSION),
    /** End of the newest minute of the axis that has per-second counts; null without one. */
    storedUntil: timestamp.nullable(),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    /** The freshness of the tape (the ticks source of the symbol). */
    tape: FlowFreshnessSchema,
    totals: FlowTapeSpeedTotalsSchema,
  })
  .strict();

export const FlowHedgingPressureInputSchema = z
  .object({
    symbol: z.enum(FLOW_HEDGING_SYMBOLS),
  })
  .strict();

/** The assumptions of the delta of each print (packages/api/src/flow-hedging-pressure-rules.ts). */
export const FlowHedgingPressureRulesSchema = z
  .object({
    /** Dividend yield of the Black-Scholes delta (a fraction per year). */
    dividendYield: nonNegative,
    /** Risk-free rate of the Black-Scholes delta (a fraction per year). */
    rate: nonNegative,
    version: z.literal("hedging-pressure.v1"),
    /** Volatility (a fraction) used when the stored IV is below 1%. */
    volFallback: finite.positive(),
  })
  .strict();

/** One minute and its own hedge notional. */
export const FlowHedgingMinuteSchema = z
  .object({
    minute: timestamp,
    minuteNet: finite,
  })
  .strict();

/** One minute with at least one counted print; the sums are running sums at its end (US dollars). */
export const FlowHedgingPointSchema = z
  .object({
    calls: finite,
    minute: timestamp,
    minuteNet: finite,
    net: finite,
    /** Underlying price of the newest priced print up to this minute; null before the first. */
    price: finite.nullable(),
    /** Counted prints of the minute. */
    prints: count,
    puts: finite,
  })
  .strict();

export const FlowHedgingTotalsSchema = z
  .object({
    calls: finite,
    /** Sum of the absolute hedge notional of the counted prints. */
    gross: nonNegative,
    /** Counted prints whose IV was below 1% and used the fallback volatility. */
    ivAdjusted: count,
    largestFall: FlowHedgingMinuteSchema.nullable(),
    largestRise: FlowHedgingMinuteSchema.nullable(),
    net: finite,
    notPriced: count,
    notSigned: count,
    /** Prints read in the session, signed prints, and the prints that are not counted. */
    prints: count,
    puts: finite,
    signed: count,
  })
  .strict();

/** Open gaps of the collector inside the session, clipped to the session. */
export const FlowHedgingUnreadSchema = z
  .object({
    from: timestamp,
    ranges: count,
    to: timestamp,
  })
  .strict();

export const FlowHedgingPressureSchema = z
  .object({
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    /** Oldest first. */
    points: z.array(FlowHedgingPointSchema).max(FLOW_HEDGING_MAX_POINTS),
    rules: FlowHedgingPressureRulesSchema,
    schemaVersion: z.literal(FLOW_HEDGING_PRESSURE_VERSION),
    /** New York date of the options session; null when no print is stored. */
    session: isoDate.nullable(),
    /** Trade time of the newest counted print; null without one. */
    storedUntil: timestamp.nullable(),
    symbol: z.enum(FLOW_HEDGING_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totals: FlowHedgingTotalsSchema,
    /** The read cap dropped the newest prints of the session. */
    truncated: z.boolean(),
    unread: FlowHedgingUnreadSchema.nullable(),
  })
  .strict();

export const FlowPutCallRatioInputSchema = z
  .object({
    symbol: z.enum(FLOW_PUT_CALL_RATIO_SYMBOLS),
  })
  .strict();

/** The rules of the put/call ratio lines (packages/api/src/flow-put-call-ratio-rules.ts). */
export const FlowPutCallRatioRulesSchema = z
  .object({
    /** Minimum print premium stored by the collector (US dollars). */
    minPremiumUsd: finite.positive(),
    /** Equal put and call reference line. */
    parity: z.literal(1),
    /** Retention window of flow_option_prints (calendar days). */
    retentionDays: z.number().int().min(1),
    version: z.literal("put-call-ratio.v1"),
  })
  .strict();

/** One minute and its running put/call ratio extreme. */
export const FlowPutCallRatioMinuteSchema = z
  .object({
    minute: timestamp,
    ratio: nonNegative,
  })
  .strict();

/** One minute of the newest session with at least one print; sums and ratios are running. */
export const FlowPutCallRatioPointSchema = z
  .object({
    callPremium: nonNegative,
    callVolume: count,
    minute: timestamp,
    /** Running putPremium / callPremium; null when callPremium is 0. */
    premiumRatio: nonNegative.nullable(),
    /** Underlying price of the newest priced print up to this minute; null before the first. */
    price: finite.nullable(),
    /** Stored prints in this minute. */
    prints: count,
    putPremium: nonNegative,
    putVolume: count,
    /** Running putVolume / callVolume; null when callVolume is 0. */
    volumeRatio: nonNegative.nullable(),
  })
  .strict();

/** One stored regular options session (09:30 to 16:15 New York) in the multi-day series. */
export const FlowPutCallRatioDaySchema = z
  .object({
    callPremium: nonNegative,
    callPrints: count,
    callVolume: count,
    /** True when an open collector gap overlaps this session's regular options hours. */
    incomplete: z.boolean(),
    /** Session putPremium / callPremium; null when callPremium is 0. */
    premiumRatio: nonNegative.nullable(),
    /** Underlying price of the newest priced print in the session; null without one. */
    price: finite.nullable(),
    prints: count,
    putPremium: nonNegative,
    putPrints: count,
    putVolume: count,
    session: isoDate,
    /** Session putVolume / callVolume; null when callVolume is 0. */
    volumeRatio: nonNegative.nullable(),
  })
  .strict();

export const FlowPutCallRatioTotalsSchema = z
  .object({
    callPremium: nonNegative,
    callPrints: count,
    callVolume: count,
    premiumHigh: FlowPutCallRatioMinuteSchema.nullable(),
    premiumLow: FlowPutCallRatioMinuteSchema.nullable(),
    premiumRatio: nonNegative.nullable(),
    prints: count,
    putPremium: nonNegative,
    putPrints: count,
    putVolume: count,
    volumeHigh: FlowPutCallRatioMinuteSchema.nullable(),
    volumeLow: FlowPutCallRatioMinuteSchema.nullable(),
    volumeRatio: nonNegative.nullable(),
  })
  .strict();

export const FlowPutCallRatioSchema = z
  .object({
    /** Daily session ratios over stored sessions, oldest first. */
    days: z.array(FlowPutCallRatioDaySchema).max(FLOW_PUT_CALL_RATIO_MAX_DAYS),
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    /** Running session ratios, oldest first. */
    points: z
      .array(FlowPutCallRatioPointSchema)
      .max(FLOW_PUT_CALL_RATIO_MAX_POINTS),
    rules: FlowPutCallRatioRulesSchema,
    schemaVersion: z.literal(FLOW_PUT_CALL_RATIO_VERSION),
    /** New York date of the newest options session; null when no print is stored. */
    session: isoDate.nullable(),
    /** Trade time of the newest stored print in the newest session; null without one. */
    storedUntil: timestamp.nullable(),
    symbol: z.enum(FLOW_PUT_CALL_RATIO_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totals: FlowPutCallRatioTotalsSchema,
    /** Open collector gaps overlapping the newest session, clipped to the session. */
    unread: FlowHedgingUnreadSchema.nullable(),
  })
  .strict();

const strikeHeatmapBucketMinutesInput = z
  .union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal("5").transform(() => 5 as const),
    z.literal("15").transform(() => 15 as const),
    z.literal("30").transform(() => 30 as const),
  ])
  .default(15);

const strikeHeatmapBucketMinutesOutput = z.union([
  z.literal(5),
  z.literal(15),
  z.literal(30),
]);

export const FlowStrikeHeatmapInputSchema = z
  .object({
    bucketMinutes: strikeHeatmapBucketMinutesInput,
    symbol: z.enum(FLOW_STRIKE_HEATMAP_SYMBOLS),
  })
  .strict();

/** The rules of the strike × time options flow heatmap (packages/api/src/flow-strike-heatmap-rules.ts). */
export const FlowStrikeHeatmapRulesSchema = z
  .object({
    /** Default time bucket width in minutes. */
    defaultBucketMinutes: strikeHeatmapBucketMinutesOutput,
    /** Maximum strikes returned per session (top strikes by gross premium). */
    maxStrikes: z.number().int().min(1).max(FLOW_STRIKE_HEATMAP_MAX_STRIKES),
    /** Minimum print premium stored by the collector (US dollars). */
    minPremiumUsd: finite.positive(),
    /** Retention window of flow_option_prints (calendar days). */
    retentionDays: z.number().int().min(1),
    version: z.literal("strike-heatmap.v1"),
  })
  .strict();

/** One time slot of the newest options session (aggregated across all session strikes). */
export const FlowStrikeHeatmapSlotSchema = z
  .object({
    bearishPremium: nonNegative,
    bullishPremium: nonNegative,
    end: timestamp,
    grossPremium: nonNegative,
    index: z
      .number()
      .int()
      .min(0)
      .max(FLOW_STRIKE_HEATMAP_MAX_SLOTS - 1),
    netPremium: finite,
    /** Carried-forward newest positive underlying price at or before the end of this slot; null before first priced print. */
    price: finite.positive().nullable(),
    prints: count,
    start: timestamp,
    /** True when any open flow_option_gaps range overlaps this slot. */
    unread: z.boolean(),
    unsignedPrints: count,
    volume: count,
  })
  .strict();

/** One displayed strike row (top strikes by gross premium, sorted descending by strike). */
export const FlowStrikeHeatmapStrikeSchema = z
  .object({
    bearishPremium: nonNegative,
    bullishPremium: nonNegative,
    callPremium: nonNegative,
    grossPremium: nonNegative,
    netPremium: finite,
    prints: count,
    putPremium: nonNegative,
    strike: finite.positive(),
    unsignedPrints: count,
    volume: count,
  })
  .strict();

/** One non-empty (strike, slotIndex) cell for a displayed strike. */
export const FlowStrikeHeatmapCellSchema = z
  .object({
    bearishPremium: nonNegative,
    bullishPremium: nonNegative,
    callPremium: nonNegative,
    grossPremium: nonNegative,
    netPremium: finite,
    prints: count,
    putPremium: nonNegative,
    slotIndex: z
      .number()
      .int()
      .min(0)
      .max(FLOW_STRIKE_HEATMAP_MAX_SLOTS - 1),
    strike: finite.positive(),
    unsignedPrints: count,
    volume: count,
  })
  .strict();

/** Session-wide option flow totals across all strikes, plus omitted-strike accounting. */
export const FlowStrikeHeatmapTotalsSchema = z
  .object({
    bearishPremium: nonNegative,
    bullishPremium: nonNegative,
    callPremium: nonNegative,
    grossPremium: nonNegative,
    latestPrice: finite.positive().nullable(),
    netPremium: finite,
    omittedGrossPremium: nonNegative,
    omittedNetPremium: finite,
    omittedPrints: count,
    omittedStrikes: count,
    prints: count,
    putPremium: nonNegative,
    shownStrikes: count,
    totalStrikes: count,
    unsignedPrints: count,
    volume: count,
  })
  .strict();

export const FlowStrikeHeatmapSchema = z
  .object({
    bucketMinutes: strikeHeatmapBucketMinutesOutput,
    cells: z
      .array(FlowStrikeHeatmapCellSchema)
      .max(FLOW_STRIKE_HEATMAP_MAX_CELLS),
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    rules: FlowStrikeHeatmapRulesSchema,
    schemaVersion: z.literal(FLOW_STRIKE_HEATMAP_VERSION),
    /** New York date of the newest options session; null when no print is stored. */
    session: isoDate.nullable(),
    slots: z
      .array(FlowStrikeHeatmapSlotSchema)
      .max(FLOW_STRIKE_HEATMAP_MAX_SLOTS),
    /** Trade time of the newest stored print in the newest session; null without one. */
    storedUntil: timestamp.nullable(),
    strikes: z
      .array(FlowStrikeHeatmapStrikeSchema)
      .max(FLOW_STRIKE_HEATMAP_MAX_STRIKES),
    symbol: z.enum(FLOW_STRIKE_HEATMAP_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totals: FlowStrikeHeatmapTotalsSchema,
    /** Open collector gaps overlapping the newest session, clipped to the session. */
    unread: FlowHedgingUnreadSchema.nullable(),
  })
  .strict();

const optionBubblesMinPremiumInput = z
  .union([
    z.literal(100_000),
    z.literal(250_000),
    z.literal(500_000),
    z.literal(1_000_000),
    z.literal("100000").transform(() => 100_000 as const),
    z.literal("250000").transform(() => 250_000 as const),
    z.literal("500000").transform(() => 500_000 as const),
    z.literal("1000000").transform(() => 1_000_000 as const),
  ])
  .default(250_000);

const optionBubblesMinPremiumOutput = z.union([
  z.literal(100_000),
  z.literal(250_000),
  z.literal(500_000),
  z.literal(1_000_000),
]);

export const FlowOptionBubblesInputSchema = z
  .object({
    minPremiumUsd: optionBubblesMinPremiumInput,
    symbol: z.enum(FLOW_OPTION_BUBBLES_SYMBOLS),
  })
  .strict();

/** The rules of option print bubbles (packages/api/src/flow-option-bubbles-rules.ts). */
export const FlowOptionBubblesRulesSchema = z
  .object({
    /** Default user-facing premium filter floor (US dollars). */
    defaultMinPremiumUsd: optionBubblesMinPremiumOutput,
    /** Maximum big prints returned per session (largest by premium). */
    maxBubbles: z.number().int().min(1).max(FLOW_OPTION_BUBBLES_MAX_BUBBLES),
    /** Retention window of flow_option_prints (calendar days). */
    retentionDays: z.number().int().min(1),
    /** Minimum print premium stored by the collector (US dollars). */
    storedMinPremiumUsd: finite.positive(),
    version: z.literal("option-bubbles.v1"),
  })
  .strict();

/** One clipped open collector gap interval inside the newest options session. */
export const FlowOptionBubblesGapSchema = z
  .object({
    end: timestamp,
    start: timestamp,
  })
  .strict();

/** One minute of the intraday underlying price path from stored option prints. */
export const FlowOptionBubblesPricePointSchema = z
  .object({
    minute: timestamp,
    price: finite.positive(),
    /** True when any open flow_option_gaps range overlaps this minute. */
    unread: z.boolean(),
  })
  .strict();

/** One big option print rendered as a bubble on the intraday price chart. */
export const FlowOptionBubblesItemSchema = z
  .object({
    at: timestamp,
    consolidation: z.enum(FLOW_CONSOLIDATIONS),
    contract: text(40),
    /** Directional sign from shared OPTION_SIDE_SIGN: +1 bullish, -1 bearish, 0 unsigned. */
    directionalSign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    dte: nonNegative.nullable(),
    expiry: isoDate,
    goldenSweep: z.boolean(),
    id: text(64),
    iv: finite.nullable(),
    moneyness: z.enum(FLOW_MONEYNESS),
    opening: z.boolean(),
    premium: nonNegative,
    price: finite.nullable(),
    right: z.enum(["call", "put"]),
    sentiment: z.enum(FLOW_OPTION_SENTIMENTS),
    side: z.enum(FLOW_OPTION_SIDES),
    size: count,
    strike: finite.positive(),
    /** Underlying price reported on the print; null when not reported (not plotted on Y axis). */
    underlyingPrice: finite.positive().nullable(),
    unusual: z.boolean(),
    volumeOverOi: z.boolean(),
  })
  .strict();

/** Summary totals of the newest options session and the returned big option print bubbles. */
export const FlowOptionBubblesTotalsSchema = z
  .object({
    askSidePremium: nonNegative,
    bearishPremium: nonNegative,
    bidSidePremium: nonNegative,
    bullishPremium: nonNegative,
    callBubbles: count,
    callPremium: nonNegative,
    latestPrice: finite.positive().nullable(),
    maxBubblePremium: nonNegative,
    plottedBubbles: count,
    putBubbles: count,
    putPremium: nonNegative,
    sessionGrossPremium: nonNegative,
    sessionPrints: count,
    shownBubbles: count,
    unplottedBubbles: count,
    unsignedPremium: nonNegative,
  })
  .strict();

export const FlowOptionBubblesSchema = z
  .object({
    /** Largest prints meeting minPremiumUsd, ordered chronologically (at asc, id asc). */
    bubbles: z
      .array(FlowOptionBubblesItemSchema)
      .max(FLOW_OPTION_BUBBLES_MAX_BUBBLES),
    /** Individual clipped open collector gap intervals for chart shading, oldest first. */
    gaps: z.array(FlowOptionBubblesGapSchema).max(FLOW_OPTION_BUBBLES_MAX_GAPS),
    minPremiumUsd: optionBubblesMinPremiumOutput,
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    /** 1-minute underlying price trajectory across the session, oldest first. */
    pricePoints: z
      .array(FlowOptionBubblesPricePointSchema)
      .max(FLOW_OPTION_BUBBLES_MAX_POINTS),
    rules: FlowOptionBubblesRulesSchema,
    schemaVersion: z.literal(FLOW_OPTION_BUBBLES_VERSION),
    /** New York date of the newest options session; null when no print is stored. */
    session: isoDate.nullable(),
    /** Session close (16:15 New York) in ISO UTC; null when no print is stored. */
    sessionEnd: timestamp.nullable(),
    /** Session open (09:30 New York) in ISO UTC; null when no print is stored. */
    sessionStart: timestamp.nullable(),
    /** Trade time of the newest stored print in the newest session; null without one. */
    storedUntil: timestamp.nullable(),
    symbol: z.enum(FLOW_OPTION_BUBBLES_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    totals: FlowOptionBubblesTotalsSchema,
    /** True when more than rules.maxBubbles prints met minPremiumUsd in the session. */
    truncated: z.boolean(),
    /** Open collector gaps overlapping the newest session, clipped to the session. */
    unread: FlowHedgingUnreadSchema.nullable(),
  })
  .strict();

export const FLOW_LIQUIDITY_HEATMAP_VERSION =
  "flow-liquidity-heatmap.v1" as const;
export const FLOW_LIQUIDITY_HEATMAP_RULES_VERSION =
  "flow-liquidity-heatmap-rules.v1" as const;
export const FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS = 240;
export const FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS = 80;
export const FLOW_LIQUIDITY_HEATMAP_MAX_TRADES = 500;
export const FLOW_LIQUIDITY_HEATMAP_MAX_WALLS = 10;
export const FLOW_LIQUIDITY_HEATMAP_CAPTURE_MODES = [
  "streamed",
  "sampled",
  "mixed",
  "none",
] as const;
export const FLOW_LIQUIDITY_HEATMAP_CELL_SIDES = [
  "bid",
  "ask",
  "both",
] as const;
export const FLOW_LIQUIDITY_HEATMAP_COLUMN_STATES = [
  "recorded",
  "no_data",
] as const;

export type FlowLiquidityHeatmapCaptureMode =
  (typeof FLOW_LIQUIDITY_HEATMAP_CAPTURE_MODES)[number];
export type FlowLiquidityHeatmapCellSide =
  (typeof FLOW_LIQUIDITY_HEATMAP_CELL_SIDES)[number];
export type FlowLiquidityHeatmapColumnState =
  (typeof FLOW_LIQUIDITY_HEATMAP_COLUMN_STATES)[number];

export const FlowLiquidityHeatmapInputSchema = z
  .object({
    minutes: snapshotMinutes,
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
  })
  .strict();

export const FlowLiquidityHeatmapCellSchema = z
  .object({
    /** Integer index into priceLevels. */
    p: z
      .number()
      .int()
      .min(0)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS - 1),
    /** Total resting contracts in this price bucket at this column. */
    s: z.number().positive(),
    side: z.enum(FLOW_LIQUIDITY_HEATMAP_CELL_SIDES),
  })
  .strict();

export const FlowLiquidityHeatmapColumnSchema = z
  .object({
    bestAsk: z.number().positive().nullable(),
    bestBid: z.number().positive().nullable(),
    capture: z.enum(FLOW_CAPTURE_MODES).nullable(),
    cells: z
      .array(FlowLiquidityHeatmapCellSchema)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS),
    mid: z.number().positive().nullable(),
    state: z.enum(FLOW_LIQUIDITY_HEATMAP_COLUMN_STATES),
    t: timestamp,
  })
  .strict();

export const FlowLiquidityHeatmapDomLevelSchema = z
  .object({
    askSize: z.number().nonnegative(),
    bidSize: z.number().nonnegative(),
    p: z
      .number()
      .int()
      .min(0)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS - 1),
    price: z.number().positive(),
  })
  .strict();

export const FlowLiquidityHeatmapTradeSchema = z
  .object({
    capture: z.enum(FLOW_CAPTURE_MODES),
    price: z.number().positive(),
    side: z.enum(FLOW_TRADE_SIDES),
    signing: z.enum(FLOW_SIGNING_METHODS),
    size: z.number().positive(),
    t: timestamp,
  })
  .strict();

export const FlowLiquidityHeatmapWallSchema = z
  .object({
    columnsPresent: z.number().int().min(1),
    persistencePct: z.number().min(0).max(100),
    price: z.number().positive(),
    side: z.enum(["bid", "ask"]),
    size: z.number().positive(),
  })
  .strict();

export const FlowLiquidityHeatmapRulesSchema = z
  .object({
    intensityQuantile: z.number().positive().max(1),
    largeTradeLimit: z.number().positive(),
    maxColumns: z.number().int().positive(),
    maxPriceBuckets: z.number().int().positive(),
    sampleSeconds: z.number().int().positive(),
    version: z.literal(FLOW_LIQUIDITY_HEATMAP_RULES_VERSION),
  })
  .strict();

export const FlowLiquidityHeatmapSchema = z
  .object({
    axisEnd: timestamp,
    axisStart: timestamp,
    capture: z.enum(FLOW_LIQUIDITY_HEATMAP_CAPTURE_MODES),
    columnSeconds: z.number().int().positive(),
    columns: z
      .array(FlowLiquidityHeatmapColumnSchema)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_COLUMNS),
    contract: z.string().min(1).max(20).nullable(),
    currentDom: z
      .array(FlowLiquidityHeatmapDomLevelSchema)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS),
    depth: FlowFreshnessSchema,
    minTick: z.number().positive(),
    priceLevels: z
      .array(z.number().positive())
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_PRICE_BUCKETS),
    priceMax: z.number().positive().nullable(),
    priceMin: z.number().positive().nullable(),
    priceStep: z.number().positive(),
    rules: FlowLiquidityHeatmapRulesSchema,
    scale: z
      .object({
        maxSize: z.number().nonnegative(),
        p95Size: z.number().nonnegative(),
        totalCells: z.number().int().nonnegative(),
      })
      .strict(),
    schemaVersion: z.literal(FLOW_LIQUIDITY_HEATMAP_VERSION),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    totals: z
      .object({
        coveragePct: z.number().min(0).max(100),
        largeTrades: z.number().int().nonnegative(),
        recordedColumns: z.number().int().nonnegative(),
        snapshots: z.number().int().nonnegative(),
        totalColumns: z.number().int().nonnegative(),
      })
      .strict(),
    trades: z
      .array(FlowLiquidityHeatmapTradeSchema)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_TRADES),
    tradesTruncated: z.boolean(),
    walls: z
      .array(FlowLiquidityHeatmapWallSchema)
      .max(FLOW_LIQUIDITY_HEATMAP_MAX_WALLS),
    windowEnd: timestamp,
    windowStart: timestamp,
  })
  .strict();

export const FLOW_TRADE_BUBBLES_VERSION = "flow-trade-bubbles.v1" as const;
export const FLOW_TRADE_BUBBLES_RULES_VERSION = "trade-bubbles.v1" as const;
export const FLOW_TRADE_BUBBLES_MAX_CANDLES = 395;
export const FLOW_TRADE_BUBBLES_MAX_BUBBLES = 500;
export const FLOW_TRADE_BUBBLES_CAPTURE_MODES = [
  "streamed",
  "sampled",
  "mixed",
  "none",
] as const;

export type FlowTradeBubblesCaptureMode =
  (typeof FLOW_TRADE_BUBBLES_CAPTURE_MODES)[number];

export const FlowTradeBubblesInputSchema = z
  .object({
    minutes: snapshotMinutes,
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
  })
  .strict();

export const FlowTradeBubblesRulesSchema = z
  .object({
    deepTradeLimit: finite.positive(),
    deepTradeLimitMeasuredOn: isoDate,
    maxBubbles: z.number().int().positive(),
    retentionDays: z.number().int().positive(),
    version: z.literal(FLOW_TRADE_BUBBLES_RULES_VERSION),
  })
  .strict();

export const FlowTradeBubblesPriceRangeSchema = z
  .object({
    max: finite.positive(),
    min: finite.positive(),
  })
  .strict();

export const FlowTradeBubblesCandleSchema = z
  .object({
    close: finite.positive(),
    coveredSeconds: z.number().int().min(0).max(60),
    high: finite.positive(),
    low: finite.positive(),
    minute: timestamp,
    open: finite.positive(),
    volume: nonNegative,
    vwap: finite.positive(),
  })
  .strict();

export const FlowTradeBubbleSchema = z
  .object({
    capture: z.enum(FLOW_CAPTURE_MODES),
    limitSize: finite.positive(),
    price: finite.positive(),
    second: timestamp,
    seq: count,
    side: z.enum(FLOW_TRADE_SIDES),
    signing: z.enum(FLOW_SIGNING_METHODS),
    size: finite.positive(),
    sizeMultiple: finite.positive(),
  })
  .strict();

export const FlowTradeBubblesTotalsSchema = z
  .object({
    buyTrades: count,
    buyVolume: nonNegative,
    largestBubble: FlowTradeBubbleSchema.nullable(),
    maxSize: finite.positive().nullable(),
    netVolume: finite,
    p95Size: finite.positive().nullable(),
    sellTrades: count,
    sellVolume: nonNegative,
    shownTrades: count,
    totalTrades: count,
    truncated: z.boolean(),
  })
  .strict();

export const FlowTradeBubblesSchema = z
  .object({
    bubbles: z.array(FlowTradeBubbleSchema).max(FLOW_TRADE_BUBBLES_MAX_BUBBLES),
    candles: z
      .array(FlowTradeBubblesCandleSchema)
      .max(FLOW_TRADE_BUBBLES_MAX_CANDLES),
    captureMode: z.enum(FLOW_TRADE_BUBBLES_CAPTURE_MODES),
    minutes: z.number().int().min(15).max(390),
    priceRange: FlowTradeBubblesPriceRangeSchema.nullable(),
    rules: FlowTradeBubblesRulesSchema,
    schemaVersion: z.literal(FLOW_TRADE_BUBBLES_VERSION),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    tape: FlowFreshnessSchema,
    tickSize: finite.positive(),
    totals: FlowTradeBubblesTotalsSchema,
    windowEnd: timestamp,
    windowStart: timestamp,
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

export const FlowEventsInputSchema = z
  .object({
    from: timestamp,
    kinds: z
      .array(z.enum(FLOW_EVENT_KINDS))
      .min(1)
      .max(FLOW_EVENT_KINDS.length)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(FLOW_EVENTS_MAX)
      .default(FLOW_EVENTS_MAX),
    symbol: z.enum(FLOW_SYMBOLS),
    to: timestamp,
  })
  .strict();

export const FlowEventsOutputSchema = z
  .object({
    events: z.array(FlowSnapshotEventSchema).max(FLOW_EVENTS_MAX),
    from: timestamp,
    schemaVersion: z.literal(FLOW_EVENTS_VERSION),
    symbol: z.enum(FLOW_SYMBOLS),
    to: timestamp,
    truncated: z.boolean(),
  })
  .strict();

const events = flow
  .route({
    method: "GET",
    operationId: "flow.events",
    path: "/flow/events",
    summary:
      "Stored flow_events (e.g. stacked imbalances, absorption) for one symbol and time range (research input)",
    tags,
  })
  .input(FlowEventsInputSchema)
  .output(FlowEventsOutputSchema);

const tapeSpeed = flow
  .route({
    method: "GET",
    operationId: "flow.tapeSpeed",
    path: "/flow/tape-speed",
    summary:
      "ES or NQ: trades and contracts per second as bars, and bursts by the tape speed rule (research input)",
    tags,
  })
  .input(FlowTapeSpeedInputSchema)
  .output(FlowTapeSpeedSchema);

const hedgingPressure = flow
  .route({
    method: "GET",
    operationId: "flow.hedgingPressure",
    path: "/flow/hedging-pressure",
    summary:
      "SPY or ES: running dealer hedge notional of the session's option prints (research input)",
    tags,
  })
  .input(FlowHedgingPressureInputSchema)
  .output(FlowHedgingPressureSchema);

const putCallRatio = flow
  .route({
    method: "GET",
    operationId: "flow.putCallRatio",
    path: "/flow/put-call-ratio",
    summary:
      "SPY or ES: put/call premium and volume ratios over the newest options session and over stored days (research input)",
    tags,
  })
  .input(FlowPutCallRatioInputSchema)
  .output(FlowPutCallRatioSchema);

const strikeHeatmap = flow
  .route({
    method: "GET",
    operationId: "flow.strikeHeatmap",
    path: "/flow/strike-heatmap",
    summary:
      "SPY or ES: strike × time signed net-premium heatmap over the newest options session (research input)",
    tags,
  })
  .input(FlowStrikeHeatmapInputSchema)
  .output(FlowStrikeHeatmapSchema);

const optionBubbles = flow
  .route({
    method: "GET",
    operationId: "flow.optionBubbles",
    path: "/flow/option-bubbles",
    summary:
      "SPY or ES: big option prints as bubbles on the intraday underlying price chart over the newest options session (research input)",
    tags,
  })
  .input(FlowOptionBubblesInputSchema)
  .output(FlowOptionBubblesSchema);

const liquidityHeatmap = flow
  .route({
    method: "GET",
    operationId: "flow.liquidityHeatmap",
    path: "/flow/liquidity-heatmap",
    summary:
      "ES or NQ: recorded CME L2 resting liquidity heatmap over time, mid/BBO price, large-trade dots, and current DOM (research input)",
    tags,
  })
  .input(FlowLiquidityHeatmapInputSchema)
  .output(FlowLiquidityHeatmapSchema);

export const FLOW_LIVE_DOM_VERSION = "flow-live-dom.v1" as const;
export const FLOW_LIVE_DOM_RULES_VERSION = "flow-live-dom-rules.v1" as const;
export const FLOW_LIVE_DOM_MAX_LEVELS = 80;
export const FLOW_LIVE_DOM_ROWS_MIN = 1;
export const FLOW_LIVE_DOM_ROWS_MAX = 10;
export const FLOW_LIVE_DOM_ROWS_DEFAULT = 10;
export const FLOW_LIVE_DOM_WINDOW_SECONDS = [300, 900, 1800, 3600] as const;
export const FLOW_LIVE_DOM_WINDOW_SECONDS_DEFAULT = 900 as const;
export const FLOW_LIVE_DOM_CADENCE_MS = [500, 1000, 2000] as const;
export const FLOW_LIVE_DOM_CADENCE_MS_DEFAULT = 500 as const;
export const FLOW_LIVE_DOM_STREAM_LEASE_MS = 20_000;
export const FLOW_LIVE_DOM_MAX_POLLS_PER_LEASE = 40;
export const FLOW_LIVE_DOM_HEARTBEAT_MS = 5000;
export const FLOW_LIVE_DOM_SOURCES = [
  "live_stream",
  "recorded_fallback",
  "empty",
] as const;
export const FLOW_LIVE_DOM_VOLUME_SOURCES = [
  "streamed_tape",
  "large_trades_only",
  "none",
] as const;
export const FLOW_LIVE_DOM_BOOK_STATES = [
  "normal",
  "locked",
  "crossed",
  "one_sided",
  "empty",
] as const;
export const FLOW_LIVE_DOM_FEED_STATES = [
  "live",
  "starting",
  "down",
  "off",
  "halted",
  "recorded",
  "never",
] as const;
export const FLOW_LIVE_DOM_TRADE_SIDES = ["buy", "sell", "unsigned"] as const;
export const FLOW_LIVE_DOM_IMBALANCE_SIDES = ["buy", "sell"] as const;
export const FLOW_LIVE_DOM_RECONNECT_REASONS = [
  "lease_expired",
  "recorded_fallback",
  "upstream_interrupted",
] as const;

export type FlowLiveDomWindowSeconds =
  (typeof FLOW_LIVE_DOM_WINDOW_SECONDS)[number];
export type FlowLiveDomCadenceMs = (typeof FLOW_LIVE_DOM_CADENCE_MS)[number];
export type FlowLiveDomSource = (typeof FLOW_LIVE_DOM_SOURCES)[number];
export type FlowLiveDomVolumeSource =
  (typeof FLOW_LIVE_DOM_VOLUME_SOURCES)[number];
export type FlowLiveDomBookState = (typeof FLOW_LIVE_DOM_BOOK_STATES)[number];
export type FlowLiveDomFeedState = (typeof FLOW_LIVE_DOM_FEED_STATES)[number];
export type FlowLiveDomTradeSide = (typeof FLOW_LIVE_DOM_TRADE_SIDES)[number];
export type FlowLiveDomImbalanceSide =
  (typeof FLOW_LIVE_DOM_IMBALANCE_SIDES)[number];
export type FlowLiveDomReconnectReason =
  (typeof FLOW_LIVE_DOM_RECONNECT_REASONS)[number];

const domWindowSeconds = z.coerce
  .number()
  .int()
  .refine(
    (value): value is FlowLiveDomWindowSeconds =>
      (FLOW_LIVE_DOM_WINDOW_SECONDS as readonly number[]).includes(value),
    {
      message: "windowSeconds must be one of 300, 900, 1800, 3600",
    }
  )
  .default(FLOW_LIVE_DOM_WINDOW_SECONDS_DEFAULT);

const domCadenceMs = z.coerce
  .number()
  .int()
  .refine(
    (value): value is FlowLiveDomCadenceMs =>
      (FLOW_LIVE_DOM_CADENCE_MS as readonly number[]).includes(value),
    {
      message: "cadenceMs must be one of 500, 1000, 2000",
    }
  )
  .default(FLOW_LIVE_DOM_CADENCE_MS_DEFAULT);

export const FlowLiveDomInputSchema = z
  .object({
    rows: z.coerce
      .number()
      .int()
      .min(FLOW_LIVE_DOM_ROWS_MIN)
      .max(FLOW_LIVE_DOM_ROWS_MAX)
      .default(FLOW_LIVE_DOM_ROWS_DEFAULT),
    since: z.coerce.number().int().min(1).max(9_999_999_999).optional(),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    windowSeconds: domWindowSeconds,
  })
  .strict();

export const FlowLiveDomStreamInputSchema = FlowLiveDomInputSchema.extend({
  cadenceMs: domCadenceMs,
}).strict();

export const FlowLiveDomRowSchema = z
  .object({
    askSize: z.number().nonnegative(),
    bidSize: z.number().nonnegative(),
    cumAskSize: z.number().nonnegative(),
    cumBidSize: z.number().nonnegative(),
    imbalance: z.enum(FLOW_LIVE_DOM_IMBALANCE_SIDES).nullable(),
    isBestAsk: z.boolean(),
    isBestBid: z.boolean(),
    isLastTrade: z.boolean(),
    isPoc: z.boolean(),
    price: z.number().positive(),
    tickIndex: z.number().int(),
    tradedBuy: z.number().nonnegative(),
    tradedDelta: z.number().finite(),
    tradedSell: z.number().nonnegative(),
    tradedTotal: z.number().nonnegative(),
    tradedUnsigned: z.number().nonnegative(),
    trades: z.number().int().nonnegative(),
  })
  .strict();

export const FlowLiveDomLastTradeSchema = z
  .object({
    price: z.number().positive(),
    side: z.enum(FLOW_LIVE_DOM_TRADE_SIDES),
    size: z.number().positive(),
    t: timestamp,
  })
  .strict();

export const FlowLiveDomTotalsSchema = z
  .object({
    askSize: z.number().nonnegative(),
    bidSharePct: z.number().min(0).max(100).nullable(),
    bidSize: z.number().nonnegative(),
    tradedBuy: z.number().nonnegative(),
    tradedDelta: z.number().finite(),
    tradedSell: z.number().nonnegative(),
    tradedTotal: z.number().nonnegative(),
    tradedUnsigned: z.number().nonnegative(),
    trades: z.number().int().nonnegative(),
  })
  .strict();

export const FlowLiveDomFeedSchema = z
  .object({
    error: z.string().max(200).nullable(),
    lastAt: timestamp.nullable(),
    state: z.enum(FLOW_LIVE_DOM_FEED_STATES),
  })
  .strict();

export const FlowLiveDomRulesSchema = z
  .object({
    heartbeatMs: z.number().int().positive(),
    imbalanceMinContracts: z.number().int().positive(),
    imbalanceRatio: z.number().positive(),
    maxLevels: z.number().int().positive(),
    maxPollsPerLease: z.number().int().positive(),
    streamLeaseMs: z.number().int().positive(),
    version: z.literal(FLOW_LIVE_DOM_RULES_VERSION),
  })
  .strict();

export const FlowLiveDomSchema = z
  .object({
    bestAsk: z.number().positive().nullable(),
    bestBid: z.number().positive().nullable(),
    bookState: z.enum(FLOW_LIVE_DOM_BOOK_STATES),
    capturedAt: timestamp,
    contract: z.string().min(1).max(20).nullable(),
    depthFeed: FlowLiveDomFeedSchema,
    depthUpdates: z.number().int().nonnegative(),
    lastTrade: FlowLiveDomLastTradeSchema.nullable(),
    mid: z.number().positive().nullable(),
    minTick: z.number().positive(),
    pocPrice: z.number().positive().nullable(),
    pocVolume: z.number().nonnegative(),
    rows: z.array(FlowLiveDomRowSchema).max(FLOW_LIVE_DOM_MAX_LEVELS),
    rules: FlowLiveDomRulesSchema,
    schemaVersion: z.literal(FLOW_LIVE_DOM_VERSION),
    seq: z.number().int().nonnegative(),
    since: z.number().int().min(1).nullable(),
    source: z.enum(FLOW_LIVE_DOM_SOURCES),
    spread: z.number().finite().nullable(),
    spreadTicks: z.number().int().nullable(),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    tapeFeed: FlowLiveDomFeedSchema,
    tapeSeq: z.number().int().nonnegative(),
    totals: FlowLiveDomTotalsSchema,
    volumeSource: z.enum(FLOW_LIVE_DOM_VOLUME_SOURCES),
    windowSeconds: z.number().int().positive(),
  })
  .strict();

export const FlowLiveDomStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      frame: FlowLiveDomSchema,
      type: z.literal("frame"),
    })
    .strict(),
  z
    .object({
      at: timestamp,
      seq: z.number().int().nonnegative(),
      type: z.literal("heartbeat"),
    })
    .strict(),
  z
    .object({
      at: timestamp,
      reason: z.enum(FLOW_LIVE_DOM_RECONNECT_REASONS),
      retryAfterMs: z.number().int().min(0).max(30_000),
      type: z.literal("reconnect"),
    })
    .strict(),
]);

const liveDom = flow
  .route({
    method: "GET",
    operationId: "flow.liveDom",
    path: "/flow/live-dom",
    summary:
      "ES or NQ: single live CME L2 DOM ladder frame with per-price traded volume and recorded fallback (research input)",
    tags,
  })
  .input(FlowLiveDomInputSchema)
  .output(FlowLiveDomSchema);

const liveDomStream = flow
  .route({
    method: "GET",
    operationId: "flow.liveDomStream",
    path: "/flow/live-dom/stream",
    summary:
      "ES or NQ: streaming SSE CME L2 DOM ladder with per-price traded volume over a bounded lease (research input)",
    tags,
  })
  .input(FlowLiveDomStreamInputSchema)
  .output(eventIterator(FlowLiveDomStreamEventSchema));
const tradeBubbles = flow
  .route({
    method: "GET",
    operationId: "flow.tradeBubbles",
    path: "/flow/trade-bubbles",
    summary:
      "ES or NQ: 1-minute price bars and stored deep futures trades as sized bubbles (research input)",
    tags,
  })
  .input(FlowTradeBubblesInputSchema)
  .output(FlowTradeBubblesSchema);

export const flowContract = {
  collect,
  control,
  events,
  hedgingPressure,
  liquidityHeatmap,
  liveDom,
  liveDomStream,
  optionBubbles,
  putCallRatio,
  snapshot,
  strikeHeatmap,
  tapeSpeed,
  tradeBubbles,
};

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
export type FlowControlFuturesSide = z.infer<
  typeof FlowControlFuturesSideSchema
>;
export type FlowFuturesHold = (typeof FLOW_FUTURES_HOLDS)[number];
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
export type FlowEventsInput = z.input<typeof FlowEventsInputSchema>;
export type FlowEventsParsedInput = z.output<typeof FlowEventsInputSchema>;
export type FlowEventsOutput = z.infer<typeof FlowEventsOutputSchema>;
export type FlowTapeSpeedInput = z.input<typeof FlowTapeSpeedInputSchema>;
export type FlowTapeSpeedParsedInput = z.output<
  typeof FlowTapeSpeedInputSchema
>;
export type FlowTapeSpeed = z.infer<typeof FlowTapeSpeedSchema>;
export type FlowTapeSpeedBar = z.infer<typeof FlowTapeSpeedBarSchema>;
export type FlowTapeSpeedBurst = z.infer<typeof FlowTapeSpeedBurstSchema>;
export type FlowTapeSpeedRules = z.infer<typeof FlowTapeSpeedRulesSchema>;
export type FlowHedgingPressureInput = z.infer<
  typeof FlowHedgingPressureInputSchema
>;
export type FlowHedgingPressure = z.infer<typeof FlowHedgingPressureSchema>;
export type FlowHedgingPressureRules = z.infer<
  typeof FlowHedgingPressureRulesSchema
>;
export type FlowHedgingPoint = z.infer<typeof FlowHedgingPointSchema>;
export type FlowHedgingTotals = z.infer<typeof FlowHedgingTotalsSchema>;
export type FlowHedgingMinute = z.infer<typeof FlowHedgingMinuteSchema>;
export type FlowHedgingUnread = z.infer<typeof FlowHedgingUnreadSchema>;
export type FlowPutCallRatioInput = z.infer<typeof FlowPutCallRatioInputSchema>;
export type FlowPutCallRatio = z.infer<typeof FlowPutCallRatioSchema>;
export type FlowPutCallRatioRules = z.infer<typeof FlowPutCallRatioRulesSchema>;
export type FlowPutCallRatioPoint = z.infer<typeof FlowPutCallRatioPointSchema>;
export type FlowPutCallRatioDay = z.infer<typeof FlowPutCallRatioDaySchema>;
export type FlowPutCallRatioTotals = z.infer<
  typeof FlowPutCallRatioTotalsSchema
>;
export type FlowPutCallRatioMinute = z.infer<
  typeof FlowPutCallRatioMinuteSchema
>;
export type FlowStrikeHeatmapInput = z.input<
  typeof FlowStrikeHeatmapInputSchema
>;
export type FlowStrikeHeatmapParsedInput = z.output<
  typeof FlowStrikeHeatmapInputSchema
>;
export type FlowStrikeHeatmap = z.infer<typeof FlowStrikeHeatmapSchema>;
export type FlowStrikeHeatmapRules = z.infer<
  typeof FlowStrikeHeatmapRulesSchema
>;
export type FlowStrikeHeatmapSlot = z.infer<typeof FlowStrikeHeatmapSlotSchema>;
export type FlowStrikeHeatmapStrike = z.infer<
  typeof FlowStrikeHeatmapStrikeSchema
>;
export type FlowStrikeHeatmapCell = z.infer<typeof FlowStrikeHeatmapCellSchema>;
export type FlowStrikeHeatmapTotals = z.infer<
  typeof FlowStrikeHeatmapTotalsSchema
>;
export type FlowLiquidityHeatmapInput = z.input<
  typeof FlowLiquidityHeatmapInputSchema
>;
export type FlowLiquidityHeatmapParsedInput = z.output<
  typeof FlowLiquidityHeatmapInputSchema
>;
export type FlowLiquidityHeatmap = z.infer<typeof FlowLiquidityHeatmapSchema>;
export type FlowLiquidityHeatmapCell = z.infer<
  typeof FlowLiquidityHeatmapCellSchema
>;
export type FlowLiquidityHeatmapColumn = z.infer<
  typeof FlowLiquidityHeatmapColumnSchema
>;
export type FlowLiquidityHeatmapDomLevel = z.infer<
  typeof FlowLiquidityHeatmapDomLevelSchema
>;
export type FlowLiquidityHeatmapTrade = z.infer<
  typeof FlowLiquidityHeatmapTradeSchema
>;
export type FlowLiquidityHeatmapWall = z.infer<
  typeof FlowLiquidityHeatmapWallSchema
>;
export type FlowLiquidityHeatmapRules = z.infer<
  typeof FlowLiquidityHeatmapRulesSchema
>;
export type FlowLiveDomInput = z.input<typeof FlowLiveDomInputSchema>;
export type FlowLiveDomParsedInput = z.output<typeof FlowLiveDomInputSchema>;
export type FlowLiveDomStreamInput = z.input<
  typeof FlowLiveDomStreamInputSchema
>;
export type FlowLiveDomStreamParsedInput = z.output<
  typeof FlowLiveDomStreamInputSchema
>;
export type FlowLiveDomRow = z.infer<typeof FlowLiveDomRowSchema>;
export type FlowLiveDomLastTrade = z.infer<typeof FlowLiveDomLastTradeSchema>;
export type FlowLiveDomTotals = z.infer<typeof FlowLiveDomTotalsSchema>;
export type FlowLiveDomFeed = z.infer<typeof FlowLiveDomFeedSchema>;
export type FlowLiveDomRules = z.infer<typeof FlowLiveDomRulesSchema>;
export type FlowLiveDom = z.infer<typeof FlowLiveDomSchema>;
export type FlowLiveDomStreamEvent = z.infer<
  typeof FlowLiveDomStreamEventSchema
>;
export type FlowOptionBubblesInput = z.input<
  typeof FlowOptionBubblesInputSchema
>;
export type FlowOptionBubblesParsedInput = z.output<
  typeof FlowOptionBubblesInputSchema
>;
export type FlowOptionBubbles = z.infer<typeof FlowOptionBubblesSchema>;
export type FlowOptionBubblesRules = z.infer<
  typeof FlowOptionBubblesRulesSchema
>;
export type FlowOptionBubblesGap = z.infer<typeof FlowOptionBubblesGapSchema>;
export type FlowOptionBubblesPricePoint = z.infer<
  typeof FlowOptionBubblesPricePointSchema
>;
export type FlowOptionBubblesItem = z.infer<typeof FlowOptionBubblesItemSchema>;
export type FlowOptionBubblesTotals = z.infer<
  typeof FlowOptionBubblesTotalsSchema
>;
export type FlowTradeBubblesInput = z.input<typeof FlowTradeBubblesInputSchema>;
export type FlowTradeBubblesParsedInput = z.output<
  typeof FlowTradeBubblesInputSchema
>;
export type FlowTradeBubblesRules = z.infer<typeof FlowTradeBubblesRulesSchema>;
export type FlowTradeBubblesPriceRange = z.infer<
  typeof FlowTradeBubblesPriceRangeSchema
>;
export type FlowTradeBubblesCandle = z.infer<
  typeof FlowTradeBubblesCandleSchema
>;
export type FlowTradeBubble = z.infer<typeof FlowTradeBubbleSchema>;
export type FlowTradeBubblesTotals = z.infer<
  typeof FlowTradeBubblesTotalsSchema
>;
export type FlowTradeBubbles = z.infer<typeof FlowTradeBubblesSchema>;
