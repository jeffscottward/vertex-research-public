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
// 14 days for the others. flow_market_premium and flow_tape_seconds are never pruned.

export const FLOW_SYMBOL_VALUES = ["SPY", "ES", "QQQ", "NQ"] as const;
export const FLOW_INDEX_OPTION_TICKER_VALUES = [
  "SPY",
  "SPX",
  "QQQ",
  "NDX",
] as const;
export const FLOW_EXTRA_OPTION_TICKER_VALUES = ["IWM", "NVDA"] as const;
export const FLOW_OPTION_TICKER_VALUES = [
  ...FLOW_INDEX_OPTION_TICKER_VALUES,
  ...FLOW_EXTRA_OPTION_TICKER_VALUES,
] as const;
export const FLOW_OPTION_PRINT_SYMBOL_VALUES = [
  ...FLOW_SYMBOL_VALUES,
  ...FLOW_EXTRA_OPTION_TICKER_VALUES,
] as const;
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
export type FlowIndexOptionTickerValue =
  (typeof FLOW_INDEX_OPTION_TICKER_VALUES)[number];
export type FlowExtraOptionTickerValue =
  (typeof FLOW_EXTRA_OPTION_TICKER_VALUES)[number];
export type FlowOptionTickerValue = (typeof FLOW_OPTION_TICKER_VALUES)[number];
export type FlowOptionPrintSymbolValue =
  (typeof FLOW_OPTION_PRINT_SYMBOL_VALUES)[number];
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
const optionPrintSymbolCheck = (column: unknown) =>
  sql`${column} in ('SPY', 'ES', 'QQQ', 'NQ', 'IWM', 'NVDA')`;

export const flowSamples = pgTable(
  "flow_samples",
  {
    at: utc("at").notNull(),
    items: integer("items").notNull(),
    message: text("message"),
    source: text("source").$type<FlowSourceValue>().notNull(),
    status: text("status").$type<FlowSampleStatusValue>().notNull(),
    symbol: text("symbol").$type<FlowOptionPrintSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.source, table.at] }),
    check(
      "flow_samples_check",
      sql`(${symbolCheck(table.symbol)} or (${table.symbol} in ('IWM', 'NVDA') and ${table.source} = 'options')) and ${table.source} in ('ticks', 'depth', 'options', 'gex', 'net_drift', 'market_premium') and ${table.status} in ('ok', 'empty', 'unavailable', 'skipped') and ${table.items} >= 0 and length(coalesce(${table.message}, '')) <= 300`
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
    // Opening and Vol > OI: null = not reported. Quant Data sets both on every print that reports
    // open interest 0, so the collector stores them as null (card
    // vertex-flow-print-flags-oi-zero-third-state; doc: docs/vertex-rebuild/flow-pipeline.md).
    opening: boolean("opening"),
    premium: num("premium").notNull(),
    price: num("price"),
    right: text("right").$type<"call" | "put">().notNull(),
    sentiment: text("sentiment").$type<FlowDirectionValue>().notNull(),
    side: text("side").$type<FlowOptionSideValue>().notNull(),
    size: integer("size").notNull(),
    strike: num("strike").notNull(),
    symbol: text("symbol").$type<FlowOptionPrintSymbolValue>().notNull(),
    ticker: text("ticker").$type<FlowOptionTickerValue>().notNull(),
    tradedAt: utc("traded_at").notNull(),
    underlyingPrice: num("underlying_price"),
    unusual: boolean("unusual").notNull(),
    volume: num("volume"),
    volumeOverOi: boolean("volume_over_oi"),
  },
  (table) => [
    index("flow_option_prints_symbol_time_idx").on(
      table.symbol,
      table.tradedAt
    ),
    check(
      "flow_option_prints_check",
      sql`${optionPrintSymbolCheck(table.symbol)} and ${table.ticker} in ('SPY', 'SPX', 'QQQ', 'NDX', 'IWM', 'NVDA') and ${table.right} in ('call', 'put') and ${table.premium} >= 0 and length(${table.id}) <= 64 and (${table.opening} is null) = (${table.volumeOverOi} is null) and (${table.opening} is not null or (${table.openInterest} is not null and ${table.openInterest} = 0))`
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
    symbol: text("symbol").$type<FlowOptionPrintSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.startTime] }),
    check(
      "flow_option_gaps_check",
      sql`${optionPrintSymbolCheck(table.symbol)} and ${table.endTime} >= ${table.startTime}`
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
    symbol: text("symbol").$type<FlowOptionPrintSymbolValue>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.key] }),
    index("flow_events_symbol_time_idx").on(table.symbol, table.at),
    check(
      "flow_events_check",
      sql`(${symbolCheck(table.symbol)} or (${table.symbol} in ('IWM', 'NVDA') and ${table.source} = 'quantdata')) and ${table.direction} in ('bullish', 'bearish', 'neutral') and ${table.source} in ('ibkr', 'quantdata') and length(${table.detail}) <= 300 and length(${table.key}) <= 160`
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
    ticker: text("ticker").$type<FlowIndexOptionTickerValue>().notNull(),
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
 * Tape speed counts: the prints and the contracts of each exchange second of one minute of the
 * streamed tape (ES, NQ), and which of the 60 seconds were covered (`covered`, one character per
 * second, `1` = covered). A row exists for each complete minute that the collector read with at
 * least one covered second or one print; a covered minute without a print holds zeros. The
 * counts hold every print of the minute, also those of an uncovered second. A later read of the
 * minute replaces the row when it holds at least as many trades (the rule of the streamed minute
 * rows). Raw counts only: no burst, no baseline, no bucket. Never pruned (about 0.45 GB per
 * year); a later burst study sets the cutoff.
 */
export const flowTapeSeconds = pgTable(
  "flow_tape_seconds",
  {
    contract: text("contract").notNull(),
    contracts: integer("contracts").array().notNull(),
    covered: text("covered").notNull(),
    minute: utc("minute").notNull(),
    symbol: text("symbol").$type<"ES" | "NQ">().notNull(),
    totalTrades: integer("total_trades").notNull(),
    trades: integer("trades").array().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.minute] }),
    check(
      "flow_tape_seconds_check",
      sql`${table.symbol} in ('ES', 'NQ') and cardinality(${table.trades}) = 60 and cardinality(${table.contracts}) = 60 and array_position(${table.trades}, NULL) is null and array_position(${table.contracts}, NULL) is null and 0 <= all(${table.trades}) and 0 <= all(${table.contracts}) and ${table.covered} ~ '^[01]{60}$' and ${table.totalTrades} >= 0 and length(${table.contract}) between 1 and 20`
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

/**
 * Per-level CME L2 order book snapshots for ES and NQ (Bookmap-style liquidity heatmap).
 * Stored as parallel 1D double-precision arrays (up to 20 levels per side, strictly finite and
 * positive) with capture provenance ('streamed' from vertex-history DepthStream at 5 s, or
 * 'sampled' from 1-minute /depth fallback). Pruned after 7 days.
 */
export const flowBookSnapshots = pgTable(
  "flow_book_snapshots",
  {
    askPrices: doublePrecision("ask_prices").array().notNull(),
    askSizes: doublePrecision("ask_sizes").array().notNull(),
    bestAsk: num("best_ask"),
    bestBid: num("best_bid"),
    bidPrices: doublePrecision("bid_prices").array().notNull(),
    bidSizes: doublePrecision("bid_sizes").array().notNull(),
    capture: text("capture").$type<FlowCaptureValue>().notNull(),
    capturedAt: utc("captured_at").notNull(),
    contract: text("contract").notNull(),
    minTick: num("min_tick").notNull(),
    symbol: text("symbol").$type<"ES" | "NQ">().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.capturedAt] }),
    check(
      "flow_book_snapshots_check",
      sql`${table.symbol} in ('ES', 'NQ') and ${table.capture} in ('sampled', 'streamed') and ${table.minTick} > 0 and ${table.minTick} < 'Infinity'::double precision and length(${table.contract}) between 1 and 20 and coalesce(array_ndims(${table.bidPrices}), 0) <= 1 and coalesce(array_ndims(${table.bidSizes}), 0) <= 1 and coalesce(array_ndims(${table.askPrices}), 0) <= 1 and coalesce(array_ndims(${table.askSizes}), 0) <= 1 and cardinality(${table.bidPrices}) = cardinality(${table.bidSizes}) and cardinality(${table.bidPrices}) <= 20 and cardinality(${table.askPrices}) = cardinality(${table.askSizes}) and cardinality(${table.askPrices}) <= 20 and cardinality(${table.bidPrices}) + cardinality(${table.askPrices}) > 0 and array_position(${table.bidPrices}, NULL) is null and array_position(${table.bidSizes}, NULL) is null and array_position(${table.askPrices}, NULL) is null and array_position(${table.askSizes}, NULL) is null and 0 < all(${table.bidPrices}) and 'Infinity'::double precision > all(${table.bidPrices}) and 0 < all(${table.bidSizes}) and 'Infinity'::double precision > all(${table.bidSizes}) and 0 < all(${table.askPrices}) and 'Infinity'::double precision > all(${table.askPrices}) and 0 < all(${table.askSizes}) and 'Infinity'::double precision > all(${table.askSizes}) and (${table.bestBid} is null) = (cardinality(${table.bidPrices}) = 0) and (${table.bestBid} is null or (${table.bestBid} > 0 and ${table.bestBid} < 'Infinity'::double precision)) and (${table.bestAsk} is null) = (cardinality(${table.askPrices}) = 0) and (${table.bestAsk} is null or (${table.bestAsk} > 0 and ${table.bestAsk} < 'Infinity'::double precision))`
    ),
  ]
);
