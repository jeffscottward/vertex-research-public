// What: the leveraged ETF universe. One row per leveraged or inverse fund (ETF or ETN) with its
// option-liquidity facts and the option gate label for the 24 to 48 hour window. Every row also
// holds the gate constants and the `generatedAt` of the document that wrote it, so a row can be
// read without a second table. The import replaces the whole table in one transaction: a fund that
// is not in the newest document is deleted.
// The checks keep the cheap invariants: no listed options means no option facts; `pass` means no
// reasons and a chain read during the regular session; `spread-not-measured` means a chain read
// after the close. The import CLI checks the full gate rule before it writes.
// Research only: nothing here places, changes or cancels an order.
// Used by: packages/db/src/server/leveraged-etf-universe.ts.
// See: docs/vertex-rebuild/leveraged-etf-universe.md.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type LeveragedEtfProductType = "etf" | "etn";
/** "regular" = the quotes of the chain are from the regular session (09:45 New York to the close) of the day the universe was generated. */
export type LeveragedEtfQuoteSession = "regular" | "closed";
export type LeveragedEtfOptionGate = "pass" | "fail" | "spread-not-measured";
// The column is jsonb and no check reads the names, so a new reason needs no migration.
export type LeveragedEtfOptionGateReason =
  | "no-listed-options"
  | "no-standard-contract"
  | "stale-chain"
  | "no-window-expiry"
  | "open-interest-below-minimum"
  | "no-two-sided-quote"
  | "too-few-two-sided-quotes"
  | "spread-above-maximum"
  | "market-closed-at-quote";

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const leveragedEtfUniverse = pgTable(
  "leveraged_etf_universe",
  {
    symbol: text("symbol").primaryKey(),
    name: text("name").notNull(),
    productType: text("product_type")
      .$type<LeveragedEtfProductType>()
      .notNull(),
    /** Signed target multiple of the fund, for example 3, -2 or 1.25. Never 0 and never 1. */
    leverage: numeric("leverage", {
      mode: "number",
      precision: 4,
      scale: 2,
    }).notNull(),
    /** Ticker of the unleveraged reference. Null means the fund is not mapped. */
    underlying: text("underlying"),
    listingExchange: text("listing_exchange").notNull(),
    optionsListed: boolean("options_listed").notNull(),
    quotedAt: utc("quoted_at"),
    quoteSession: text("quote_session").$type<LeveragedEtfQuoteSession>(),
    spot: numeric("spot", { mode: "number" }),
    /** ISO dates in ascending order. Empty when the fund has no listed options. */
    nearestExpiries: jsonb("nearest_expiries")
      .$type<readonly string[]>()
      .notNull(),
    windowExpiry: date("window_expiry", { mode: "string" }),
    totalOpenInterest: integer("total_open_interest"),
    bandOpenInterest: integer("band_open_interest"),
    halfSpreadPct: numeric("half_spread_pct", { mode: "number" }),
    optionGate: text("option_gate").$type<LeveragedEtfOptionGate>().notNull(),
    optionGateReasons: jsonb("option_gate_reasons")
      .$type<readonly LeveragedEtfOptionGateReason[]>()
      .notNull(),
    gateVersion: integer("gate_version").notNull(),
    gateMinBandOpenInterest: integer("gate_min_band_open_interest").notNull(),
    gateMaxHalfSpreadPct: numeric("gate_max_half_spread_pct", {
      mode: "number",
    }).notNull(),
    gateMinWindowDays: integer("gate_min_window_days").notNull(),
    gateMaxWindowDays: integer("gate_max_window_days").notNull(),
    gateBandPct: numeric("gate_band_pct", { mode: "number" }).notNull(),
    /** The `generatedAt` of the document that wrote this row. */
    generatedAt: utc("generated_at").notNull(),
    updatedAt: utc("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("leveraged_etf_universe_option_gate_idx").on(table.optionGate),
    check(
      "leveraged_etf_universe_fund_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.]{0,9}$' and char_length(${table.name}) between 1 and 200 and ${table.productType} in ('etf', 'etn') and ${table.leverage} between -5 and 5 and ${table.leverage} not in (0, 1) and (${table.underlying} is null or char_length(${table.underlying}) between 1 and 20) and char_length(${table.listingExchange}) between 1 and 20`
    ),
    check(
      "leveraged_etf_universe_options_check",
      sql`case when jsonb_typeof(${table.nearestExpiries}) <> 'array' then false when ${table.optionsListed} then ${table.quotedAt} is not null and ${table.quoteSession} is not null and ${table.quoteSession} in ('regular', 'closed') and ${table.spot} is not null and ${table.spot} > 0 and ${table.totalOpenInterest} is not null and ${table.totalOpenInterest} >= 0 and jsonb_array_length(${table.nearestExpiries}) between 1 and 4 and (${table.windowExpiry} is null) = (${table.bandOpenInterest} is null) and (${table.bandOpenInterest} is null or ${table.bandOpenInterest} >= 0) and (${table.halfSpreadPct} is null or (${table.windowExpiry} is not null and ${table.halfSpreadPct} between 0 and 100)) else ${table.quotedAt} is null and ${table.quoteSession} is null and ${table.spot} is null and ${table.windowExpiry} is null and ${table.totalOpenInterest} is null and ${table.bandOpenInterest} is null and ${table.halfSpreadPct} is null and jsonb_array_length(${table.nearestExpiries}) = 0 end`
    ),
    check(
      "leveraged_etf_universe_gate_check",
      sql`${table.gateVersion} >= 1 and ${table.gateMinBandOpenInterest} >= 0 and ${table.gateMaxHalfSpreadPct} > 0 and ${table.gateMinWindowDays} >= 0 and ${table.gateMaxWindowDays} >= ${table.gateMinWindowDays} and ${table.gateBandPct} > 0 and case when jsonb_typeof(${table.optionGateReasons}) <> 'array' then false when ${table.optionGate} = 'pass' then ${table.optionsListed} and ${table.quoteSession} = 'regular' and ${table.optionGateReasons} = '[]'::jsonb when ${table.optionGate} = 'spread-not-measured' then ${table.optionsListed} and ${table.quoteSession} = 'closed' and ${table.optionGateReasons} = '["market-closed-at-quote"]'::jsonb when ${table.optionGate} = 'fail' then jsonb_array_length(${table.optionGateReasons}) >= 1 else false end`
    ),
  ]
);
