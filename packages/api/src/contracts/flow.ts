import { oc } from "@orpc/contract";
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

/** The rules of the futures-side fold: the options numbers plus the tape and entry-check numbers. */
export const FlowFuturesRulesSchema = FlowControlRulesSchema.extend({
  version: z.literal("flow-futures-rules.v1"),
  maxMissingMinutes: z.number().int().min(0).max(30),
  minCoveredSeconds: z.number().int().min(1).max(60),
  minTrades: z.number().int().min(1).max(1000),
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
    /** Cumulative delta over the stored minutes of the window. */
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
  STORAGE_ERROR: { message: "Flow storage request failed; retry", status: 503 },
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

/** The futures side: `ratio` is the deep-trade ratio before the entry checks. */
export const FlowControlFuturesSideSchema = FlowControlSideSchema.extend({
  hold: z.enum(FLOW_FUTURES_HOLDS).nullable(),
  trades: count,
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
    futuresRules: FlowFuturesRulesSchema,
    futures: FlowControlFuturesSideSchema,
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

export const FlowTapeSpeedInputSchema = z
  .object({
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    minutes: snapshotMinutes,
  })
  .strict();

/** The rule that marks a burst second (packages/api/src/flow-tape-speed-rules.ts). */
export const FlowTapeSpeedRulesSchema = z
  .object({
    version: text(40),
    /** The baseline of a second: the mean trades per second of this many seconds before it. */
    baselineSeconds: count,
    /** Fewer covered seconds in the baseline: the second is not evaluated. */
    minBaselineCoveredSeconds: count,
    /** A burst second has at least this multiple of its baseline... */
    multiple: finite.positive(),
    /** ...and at least this many trades. */
    floorTrades: count,
  })
  .strict();

export const FlowTapeSpeedBarSchema = z
  .object({
    start: timestamp,
    state: z.enum(FLOW_TAPE_SPEED_BAR_STATES),
    /** Covered seconds of the bar (0..bucketSeconds). The counts below are of these seconds. */
    coveredSeconds: count,
    trades: count,
    contracts: count,
    /** The most trades, and the most contracts, of one covered second of the bar. */
    peakTrades: count,
    peakContracts: count,
    burstSeconds: count,
  })
  .strict();

/** A run of consecutive burst seconds. */
export const FlowTapeSpeedBurstSchema = z
  .object({
    /** The first second of the burst. */
    start: timestamp,
    seconds: count,
    /** The most trades of one second of the burst. */
    peakTrades: count,
    contracts: count,
    /** Mean trades per second before the first second of the burst. */
    baseline: nonNegative,
    /** peakTrades ÷ baseline; null for a baseline of 0. */
    multiple: finite.nullable(),
  })
  .strict();

export const FlowTapeSpeedTotalsSchema = z
  .object({
    /** Covered seconds on the axis, and those of them that the rule could evaluate. */
    coveredSeconds: count,
    evaluatedSeconds: count,
    /** Bursts with a second on the axis; `bursts` of the document lists the newest of them. */
    bursts: count,
  })
  .strict();

export const FlowTapeSpeedSchema = z
  .object({
    schemaVersion: z.literal(FLOW_TAPE_SPEED_VERSION),
    symbol: z.enum(FLOW_TAPE_SYMBOLS),
    /** Local symbol of the contract of the newest per-second row of the axis; null without one. */
    contract: text(20).nullable(),
    /** Start of the first bar; bar i starts i × bucketSeconds later. */
    axisStart: timestamp,
    bucketSeconds: count,
    /** End of the newest minute of the axis that has per-second counts; null without one. */
    storedUntil: timestamp.nullable(),
    rules: FlowTapeSpeedRulesSchema,
    /** The freshness of the tape (the ticks source of the symbol). */
    tape: FlowFreshnessSchema,
    totals: FlowTapeSpeedTotalsSchema,
    bars: z.array(FlowTapeSpeedBarSchema).max(FLOW_TAPE_SPEED_MAX_BARS),
    /** Oldest first. */
    bursts: z.array(FlowTapeSpeedBurstSchema).max(FLOW_TAPE_SPEED_MAX_BURSTS),
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
    version: z.literal("hedging-pressure.v1"),
    /** Risk-free rate of the Black-Scholes delta (a fraction per year). */
    rate: nonNegative,
    /** Dividend yield of the Black-Scholes delta (a fraction per year). */
    dividendYield: nonNegative,
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
    minute: timestamp,
    net: finite,
    calls: finite,
    puts: finite,
    minuteNet: finite,
    /** Counted prints of the minute. */
    prints: count,
    /** Underlying price of the newest priced print up to this minute; null before the first. */
    price: finite.nullable(),
  })
  .strict();

export const FlowHedgingTotalsSchema = z
  .object({
    /** Prints read in the session, signed prints, and the prints that are not counted. */
    prints: count,
    signed: count,
    notSigned: count,
    notPriced: count,
    /** Counted prints whose IV was below 1% and used the fallback volatility. */
    ivAdjusted: count,
    net: finite,
    calls: finite,
    puts: finite,
    /** Sum of the absolute hedge notional of the counted prints. */
    gross: nonNegative,
    largestRise: FlowHedgingMinuteSchema.nullable(),
    largestFall: FlowHedgingMinuteSchema.nullable(),
  })
  .strict();

/** Open gaps of the collector inside the session, clipped to the session. */
export const FlowHedgingUnreadSchema = z
  .object({
    from: timestamp,
    to: timestamp,
    ranges: count,
  })
  .strict();

export const FlowHedgingPressureSchema = z
  .object({
    schemaVersion: z.literal(FLOW_HEDGING_PRESSURE_VERSION),
    symbol: z.enum(FLOW_HEDGING_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    /** New York date of the options session; null when no print is stored. */
    session: isoDate.nullable(),
    rules: FlowHedgingPressureRulesSchema,
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    /** Trade time of the newest counted print; null without one. */
    storedUntil: timestamp.nullable(),
    /** The read cap dropped the newest prints of the session. */
    truncated: z.boolean(),
    unread: FlowHedgingUnreadSchema.nullable(),
    totals: FlowHedgingTotalsSchema,
    /** Oldest first. */
    points: z.array(FlowHedgingPointSchema).max(FLOW_HEDGING_MAX_POINTS),
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
    version: z.literal("put-call-ratio.v1"),
    /** Minimum print premium stored by the collector (US dollars). */
    minPremiumUsd: finite.positive(),
    /** Retention window of flow_option_prints (calendar days). */
    retentionDays: z.number().int().min(1),
    /** Equal put and call reference line. */
    parity: z.literal(1),
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
    minute: timestamp,
    /** Running putPremium / callPremium; null when callPremium is 0. */
    premiumRatio: nonNegative.nullable(),
    /** Running putVolume / callVolume; null when callVolume is 0. */
    volumeRatio: nonNegative.nullable(),
    callPremium: nonNegative,
    putPremium: nonNegative,
    callVolume: count,
    putVolume: count,
    /** Stored prints in this minute. */
    prints: count,
    /** Underlying price of the newest priced print up to this minute; null before the first. */
    price: finite.nullable(),
  })
  .strict();

/** One stored regular options session (09:30 to 16:15 New York) in the multi-day series. */
export const FlowPutCallRatioDaySchema = z
  .object({
    session: isoDate,
    prints: count,
    callPrints: count,
    putPrints: count,
    callPremium: nonNegative,
    putPremium: nonNegative,
    callVolume: count,
    putVolume: count,
    /** Session putPremium / callPremium; null when callPremium is 0. */
    premiumRatio: nonNegative.nullable(),
    /** Session putVolume / callVolume; null when callVolume is 0. */
    volumeRatio: nonNegative.nullable(),
    /** Underlying price of the newest priced print in the session; null without one. */
    price: finite.nullable(),
    /** True when an open collector gap overlaps this session's regular options hours. */
    incomplete: z.boolean(),
  })
  .strict();

export const FlowPutCallRatioTotalsSchema = z
  .object({
    prints: count,
    callPrints: count,
    putPrints: count,
    callPremium: nonNegative,
    putPremium: nonNegative,
    callVolume: count,
    putVolume: count,
    premiumRatio: nonNegative.nullable(),
    volumeRatio: nonNegative.nullable(),
    premiumHigh: FlowPutCallRatioMinuteSchema.nullable(),
    premiumLow: FlowPutCallRatioMinuteSchema.nullable(),
    volumeHigh: FlowPutCallRatioMinuteSchema.nullable(),
    volumeLow: FlowPutCallRatioMinuteSchema.nullable(),
  })
  .strict();

export const FlowPutCallRatioSchema = z
  .object({
    schemaVersion: z.literal(FLOW_PUT_CALL_RATIO_VERSION),
    symbol: z.enum(FLOW_PUT_CALL_RATIO_SYMBOLS),
    ticker: z.enum(FLOW_OPTION_TICKERS),
    /** New York date of the newest options session; null when no print is stored. */
    session: isoDate.nullable(),
    rules: FlowPutCallRatioRulesSchema,
    /** The freshness of the options source of the symbol. */
    options: FlowFreshnessSchema,
    /** Trade time of the newest stored print in the newest session; null without one. */
    storedUntil: timestamp.nullable(),
    /** Open collector gaps overlapping the newest session, clipped to the session. */
    unread: FlowHedgingUnreadSchema.nullable(),
    totals: FlowPutCallRatioTotalsSchema,
    /** Running session ratios, oldest first. */
    points: z
      .array(FlowPutCallRatioPointSchema)
      .max(FLOW_PUT_CALL_RATIO_MAX_POINTS),
    /** Daily session ratios over stored sessions, oldest first. */
    days: z.array(FlowPutCallRatioDaySchema).max(FLOW_PUT_CALL_RATIO_MAX_DAYS),
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
    symbol: z.enum(FLOW_SYMBOLS),
    from: timestamp,
    to: timestamp,
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
  })
  .strict();

export const FlowEventsOutputSchema = z
  .object({
    schemaVersion: z.literal(FLOW_EVENTS_VERSION),
    symbol: z.enum(FLOW_SYMBOLS),
    from: timestamp,
    to: timestamp,
    events: z.array(FlowSnapshotEventSchema).max(FLOW_EVENTS_MAX),
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

export const flowContract = {
  collect,
  control,
  events,
  hedgingPressure,
  liquidityHeatmap,
  putCallRatio,
  snapshot,
  tapeSpeed,
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
