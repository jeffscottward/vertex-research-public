import { sql } from "drizzle-orm";
import {
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
// Rows older than 14 days are pruned by the collector.

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const num = (name: string) => doublePrecision(name);
const symbolCheck = (column: unknown) => sql`${column} in ('SPY', 'ES')`;

export const flowSamples = pgTable(
  "flow_samples",
  {
    at: utc("at").notNull(),
    items: integer("items").notNull(),
    message: text("message"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    symbol: text("symbol").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.source, table.at] }),
    check(
      "flow_samples_check",
      sql`${symbolCheck(table.symbol)} and ${table.source} in ('ticks', 'depth', 'options', 'gex') and ${table.status} in ('ok', 'empty', 'unavailable', 'skipped') and ${table.items} >= 0 and length(coalesce(${table.message}, '')) <= 300`
    ),
  ]
);

export const flowMinutes = pgTable(
  "flow_minutes",
  {
    absorption: text("absorption"),
    buyVolume: num("buy_volume").notNull(),
    close: num("close").notNull(),
    coveredSeconds: integer("covered_seconds").notNull(),
    delta: num("delta").notNull(),
    high: num("high").notNull(),
    largePrintVolume: num("large_print_volume").notNull(),
    largePrints: integer("large_prints").notNull(),
    low: num("low").notNull(),
    minute: utc("minute").notNull(),
    offExchangeVolume: num("off_exchange_volume").notNull(),
    open: num("open").notNull(),
    sellVolume: num("sell_volume").notNull(),
    stackedBuy: integer("stacked_buy").notNull(),
    stackedSell: integer("stacked_sell").notNull(),
    symbol: text("symbol").notNull(),
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
    symbol: text("symbol").notNull(),
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
    consolidation: text("consolidation").notNull(),
    dte: num("dte"),
    expiry: date("expiry", { mode: "string" }).notNull(),
    goldenSweep: boolean("golden_sweep").notNull(),
    id: text("id").primaryKey(),
    iv: num("iv"),
    moneyness: text("moneyness").notNull(),
    moneynessPct: num("moneyness_pct"),
    openInterest: num("open_interest"),
    opening: boolean("opening").notNull(),
    premium: num("premium").notNull(),
    price: num("price"),
    right: text("right").notNull(),
    sentiment: text("sentiment").notNull(),
    side: text("side").notNull(),
    size: integer("size").notNull(),
    strike: num("strike").notNull(),
    symbol: text("symbol").notNull(),
    ticker: text("ticker").notNull(),
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
      sql`${symbolCheck(table.symbol)} and ${table.ticker} in ('SPY', 'SPX') and ${table.right} in ('call', 'put') and ${table.premium} >= 0 and length(${table.id}) <= 64`
    ),
  ]
);

export const flowEvents = pgTable(
  "flow_events",
  {
    at: utc("at").notNull(),
    detail: text("detail").notNull(),
    direction: text("direction").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    premium: num("premium"),
    price: num("price"),
    size: num("size"),
    source: text("source").notNull(),
    symbol: text("symbol").notNull(),
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
    ivRegime: text("iv_regime").notNull(),
    maxPain: num("max_pain"),
    netDex: num("net_dex"),
    putWall: num("put_wall"),
    regime: text("regime").notNull(),
    spot: num("spot"),
    symbol: text("symbol").notNull(),
    ticker: text("ticker").notNull(),
    totalGex: num("total_gex"),
    zeroDteShare: num("zero_dte_share"),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.at] }),
    check(
      "flow_gex_check",
      sql`${symbolCheck(table.symbol)} and ${table.ticker} in ('SPY', 'SPX')`
    ),
  ]
);
