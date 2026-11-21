import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Flow pipeline (docs/vertex-rebuild/flow-pipeline.md): flow.collect writes, flow.snapshot reads.
// The collector prunes each table with its own retention (FLOW_RETENTION_DAYS in
// packages/api/src/server/flow-collect.ts): 730 days for flow_net_drift and flow_large_trades,
// 14 days for the others. flow_market_premium is never pruned.

export const FLOW_SYMBOL_VALUES = ["SPY", "ES", "QQQ", "NQ"] as const;
export const FLOW_OPTION_TICKER_VALUES = ["SPY", "SPX", "QQQ", "NDX"] as const;
export const FLOW_SOURCE_VALUES = [
  "ticks",
  "depth",
  "options",
  "gex",
  "net_drift",
  "market_premium",
] as const;
export type FlowSymbolValue = (typeof FLOW_SYMBOL_VALUES)[number];
export type FlowSourceValue = (typeof FLOW_SOURCE_VALUES)[number];
export type FlowSampleStatusValue = "ok" | "empty" | "unavailable" | "skipped";
export type FlowOptionTickerValue = (typeof FLOW_OPTION_TICKER_VALUES)[number];
export type FlowDirectionValue = "bullish" | "bearish" | "neutral";
export type FlowEventKindValue =
  | "large_print"
  | "off_exchange_print"
  | "absorption"
  | "stacked_imbalance"
  | "exhaustion"
  | "option_sweep"
  | "option_block"
  | "option_golden_sweep"
  | "option_print";
export type FlowEventSourceValue = "ibkr" | "quantdata";
export type FlowOptionSideValue =
  | "above_ask"
  | "ask"
  | "mid"
  | "bid"
  | "below_bid"
  | "unknown";
export type FlowMoneynessValue = "itm" | "atm" | "otm" | "unknown";
export type FlowConsolidationValue = "sweep" | "block" | "split" | "other";
export type FlowAbsorptionValue = "buy" | "sell";
export type FlowGexRegimeValue = "positive" | "negative" | "unknown";
export type FlowIvRegimeValue = "inverted" | "flat" | "contango" | "unknown";
export const FLOW_NET_DRIFT_TICKER_VALUES = [
  "SPY",
  "SPX",
  "QQQ",
  "NDX",
] as const;
export const FLOW_NET_DRIFT_PART_VALUES = ["total", "zero_dte"] as const;
export type FlowNetDriftTickerValue =
  (typeof FLOW_NET_DRIFT_TICKER_VALUES)[number];
export type FlowNetDriftPartValue = (typeof FLOW_NET_DRIFT_PART_VALUES)[number];
export const FLOW_TRADE_SIDE_VALUES = ["buy", "sell"] as const;
export const FLOW_SIGNING_VALUES = ["quote", "tick"] as const;
/** The capture modes: `sampled` is the tick sample; `streamed` is the complete trade stream. */
export const FLOW_CAPTURE_VALUES = ["sampled", "streamed"] as const;
export type FlowTradeSideValue = (typeof FLOW_TRADE_SIDE_VALUES)[number];
export type FlowSigningValue = (typeof FLOW_SIGNING_VALUES)[number];
export type FlowCaptureValue = (typeof FLOW_CAPTURE_VALUES)[number];

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const num = (name: string) => doublePrecision(name);
const symbolCheck = (column: unknown) =>
  sql`${column} in ('SPY', 'ES', 'QQQ', 'NQ')`;

export const flowSamples = pgTable(
  "flow_samples",
  {
    at: utc("at").notNull(),
    items: integer("items").notNull(),
    message: text("message"),
    source: text("source").$type<FlowSourceValue>().notNull(),
    status: text("status").$type<FlowSampleStatusValue>().notNull(),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.source, table.at] }),
    check(
      "flow_samples_check",
      sql`${symbolCheck(table.symbol)} and ${table.source} in ('ticks', 'depth', 'options', 'gex', 'net_drift', 'market_premium') and ${table.status} in ('ok', 'empty', 'unavailable', 'skipped') and ${table.items} >= 0 and length(coalesce(${table.message}, '')) <= 300`
    ),
  ]
);

export const flowMinutes = pgTable(
  "flow_minutes",
  {
    absorption: text("absorption").$type<FlowAbsorptionValue>(),
    buyVolume: num("buy_volume").notNull(),
    close: num("close").notNull(),
    coveredSeconds: integer("covered_seconds").notNull(),
    delta: num("delta").notNull(),
    high: num("high").notNull(),
    largePrints: integer("large_prints").notNull(),
    largePrintVolume: num("large_print_volume").notNull(),
    low: num("low").notNull(),
    minute: utc("minute").notNull(),
    offExchangeVolume: num("off_exchange_volume").notNull(),
    open: num("open").notNull(),
    sellVolume: num("sell_volume").notNull(),
    stackedBuy: integer("stacked_buy").notNull(),
    stackedSell: integer("stacked_sell").notNull(),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
    trades: integer("trades").notNull(),
    volume: num("volume").notNull(),
    vwap: num("vwap").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.minute] }),
    check(
      "flow_minutes_check",
      sql`${symbolCheck(table.symbol)} and ${table.coveredSeconds} between 0 and 60 and ${table.volume} >= 0 and coalesce(${table.absorption}, 'buy') in ('buy', 'sell')`
    ),
  ]
);

export const flowBook = pgTable(
  "flow_book",
  {
    askSize: num("ask_size").notNull(),
    at: utc("at").notNull(),
    bestAsk: num("best_ask"),
    bestBid: num("best_bid"),
    bidSize: num("bid_size").notNull(),
    levels: integer("levels").notNull(),
    pressure: num("pressure"),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.at] }),
    check("flow_book_check", sql`${symbolCheck(table.symbol)}`),
  ]
);

export const flowOptionPrints = pgTable(
  "flow_option_prints",
  {
    ask: num("ask"),
    bid: num("bid"),
    consolidation: text("consolidation")
      .$type<FlowConsolidationValue>()
      .notNull(),
    dte: num("dte"),
    expiry: date("expiry", { mode: "string" }).notNull(),
    goldenSweep: boolean("golden_sweep").notNull(),
    id: text("id").primaryKey(),
    iv: num("iv"),
    moneyness: text("moneyness").$type<FlowMoneynessValue>().notNull(),
    moneynessPct: num("moneyness_pct"),
    openInterest: num("open_interest"),
    opening: boolean("opening").notNull(),
    premium: num("premium").notNull(),
    price: num("price"),
    right: text("right").$type<"call" | "put">().notNull(),
    sentiment: text("sentiment").$type<FlowDirectionValue>().notNull(),
    side: text("side").$type<FlowOptionSideValue>().notNull(),
    size: integer("size").notNull(),
    strike: num("strike").notNull(),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
    ticker: text("ticker").$type<FlowOptionTickerValue>().notNull(),
    tradedAt: utc("traded_at").notNull(),
    underlyingPrice: num("underlying_price"),
    unusual: boolean("unusual").notNull(),
    volume: num("volume"),
    volumeOverOi: boolean("volume_over_oi").notNull(),
  },
  (table) => [
    index("flow_option_prints_symbol_time_idx").on(
      table.symbol,
      table.tradedAt
    ),
    check(
      "flow_option_prints_check",
      sql`${symbolCheck(table.symbol)} and ${table.ticker} in ('SPY', 'SPX', 'QQQ', 'NDX') and ${table.right} in ('call', 'put') and ${table.premium} >= 0 and length(${table.id}) <= 64`
    ),
  ]
);

/**
 * Option-print ranges a run left unfetched because it reached its page cap (migration 0053). Later
 * runs page each range newest first, move `end_time` back to the oldest print they fetched, and
 * delete the row once the range is read completely, so a busy window is stored in full over several
 * runs. `start_time` and `end_time` are inclusive QuantData query bounds.
 */
export const flowOptionGaps = pgTable(
  "flow_option_gaps",
  {
    createdAt: utc("created_at").notNull(),
    endTime: utc("end_time").notNull(),
    startTime: utc("start_time").notNull(),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.startTime] }),
    check(
      "flow_option_gaps_check",
      sql`${symbolCheck(table.symbol)} and ${table.endTime} >= ${table.startTime}`
    ),
  ]
);

export const flowEvents = pgTable(
  "flow_events",
  {
    at: utc("at").notNull(),
    detail: text("detail").notNull(),
    direction: text("direction").$type<FlowDirectionValue>().notNull(),
    key: text("key").notNull(),
    kind: text("kind").$type<FlowEventKindValue>().notNull(),
    premium: num("premium"),
    price: num("price"),
    size: num("size"),
    source: text("source").$type<FlowEventSourceValue>().notNull(),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.key] }),
    index("flow_events_symbol_time_idx").on(table.symbol, table.at),
    check(
      "flow_events_check",
      sql`${symbolCheck(table.symbol)} and ${table.direction} in ('bullish', 'bearish', 'neutral') and ${table.source} in ('ibkr', 'quantdata') and length(${table.detail}) <= 300 and length(${table.key}) <= 160`
    ),
  ]
);

export const flowGex = pgTable(
  "flow_gex",
  {
    at: utc("at").notNull(),
    basis: num("basis"),
    callWall: num("call_wall"),
    flip: num("flip"),
    ivRegime: text("iv_regime").$type<FlowIvRegimeValue>().notNull(),
    maxPain: num("max_pain"),
    netDex: num("net_dex"),
    putWall: num("put_wall"),
    regime: text("regime").$type<FlowGexRegimeValue>().notNull(),
    spot: num("spot"),
    symbol: text("symbol").$type<FlowSymbolValue>().notNull(),
    ticker: text("ticker").$type<FlowOptionTickerValue>().notNull(),
    totalGex: num("total_gex"),
    zeroDteShare: num("zero_dte_share"),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.at] }),
    check(
      "flow_gex_check",
      sql`${symbolCheck(table.symbol)} and ${table.ticker} in ('SPY', 'SPX', 'QQQ', 'NDX')`
    ),
  ]
);

/** One vendor one-minute net drift value per ticker and part (total, zero_dte). */
export const flowNetDrift = pgTable(
  "flow_net_drift",
  {
    filterProfile: text("filter_profile").notNull(),
    minute: utc("minute").notNull(),
    netCallPremium: num("net_call_premium").notNull(),
    netCallVolume: num("net_call_volume").notNull(),
    netPutPremium: num("net_put_premium").notNull(),
    netPutVolume: num("net_put_volume").notNull(),
    part: text("part").$type<FlowNetDriftPartValue>().notNull(),
    ticker: text("ticker").$type<FlowNetDriftTickerValue>().notNull(),
    underlyingPrice: num("underlying_price"),
  },
  (table) => [
    primaryKey({ columns: [table.ticker, table.part, table.minute] }),
    check(
      "flow_net_drift_check",
      sql`${table.ticker} in ('SPY', 'SPX', 'QQQ', 'NDX') and ${table.part} in ('total', 'zero_dte') and length(${table.filterProfile}) <= 40`
    ),
  ]
);

/**
 * Deep trades: single futures prints at or above the deep-trade limit, from the
 * sampled or the streamed tape (`capture`). Insert-once by (symbol, second, seq); futures only.
 */
export const flowLargeTrades = pgTable(
  "flow_large_trades",
  {
    capture: text("capture").$type<FlowCaptureValue>().notNull(),
    limitSize: doublePrecision("limit_size").notNull(),
    price: doublePrecision("price").notNull(),
    sampledAt: utc("sampled_at").notNull(),
    second: utc("second").notNull(),
    seq: integer("seq").notNull(),
    side: text("side").$type<FlowTradeSideValue>().notNull(),
    signing: text("signing").$type<FlowSigningValue>().notNull(),
    size: doublePrecision("size").notNull(),
    symbol: text("symbol").$type<"ES" | "NQ">().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.second, table.seq] }),
    check(
      "flow_large_trades_check",
      sql`${table.symbol} in ('ES', 'NQ') and ${table.side} in ('buy', 'sell') and ${table.signing} in ('quote', 'tick') and ${table.capture} in ('sampled', 'streamed') and ${table.seq} >= 0 and ${table.price} > 0 and ${table.limitSize} > 0 and ${table.size} >= ${table.limitSize}`
    ),
  ]
);

/**
 * Market-wide large-trade options premium: QuantData gainers-losers session totals per ticker, over
 * trades with premium >= $100,000 each (filter_profile). One row per session date and ticker; each
 * capture overwrites the running total (captured_at). Never pruned.
 */
export const flowMarketPremium = pgTable(
  "flow_market_premium",
  {
    bearishPremium: num("bearish_premium").notNull(),
    bullishPremium: num("bullish_premium").notNull(),
    capturedAt: utc("captured_at").notNull(),
    filterProfile: text("filter_profile").notNull(),
    premium: num("premium").notNull(),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    ticker: text("ticker").notNull(),
    tradeCount: integer("trade_count").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionDate, table.ticker] }),
    check(
      "flow_market_premium_check",
      sql`${table.ticker} ~ '^[A-Z0-9.^=-]{1,16}$' and ${table.bullishPremium} >= 0 and ${table.bearishPremium} >= 0 and ${table.premium} >= 0 and ${table.tradeCount} >= 0 and ${table.volume} >= 0 and length(${table.filterProfile}) <= 40`
    ),
  ]
);

export const FLOW_MARKET_PREMIUM_SESSION_STATUS_VALUES = [
  "complete",
  "partial",
  "no_data",
  "unavailable",
] as const;
export type FlowMarketPremiumSessionStatusValue =
  (typeof FLOW_MARKET_PREMIUM_SESSION_STATUS_VALUES)[number];

/**
 * Session ledger of flow_market_premium: one row per session date that the collector tried (live
 * capture or gap fill). complete and no_data are final; partial and unavailable are tried again.
 * Never pruned.
 */
export const flowMarketPremiumSessions = pgTable(
  "flow_market_premium_sessions",
  {
    attempts: integer("attempts").notNull(),
    capturedAt: utc("captured_at"),
    lastAttemptAt: utc("last_attempt_at").notNull(),
    lastMessage: text("last_message").notNull(),
    sessionDate: date("session_date", { mode: "string" }).primaryKey(),
    status: text("status")
      .$type<FlowMarketPremiumSessionStatusValue>()
      .notNull(),
    tickers: integer("tickers").notNull(),
  },
  (table) => [
    check(
      "flow_market_premium_sessions_check",
      sql`${table.status} in ('complete', 'partial', 'no_data', 'unavailable') and ${table.attempts} >= 1 and ${table.tickers} >= 0 and length(${table.lastMessage}) <= 300 and (${table.capturedAt} is not null) = (${table.status} in ('complete', 'partial'))`
    ),
  ]
);
