import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Option chain snapshots (docs/vertex-rebuild/designs/option-chain-store/design.md, migration
// 0093_option_chain_snapshots). The rig collector posts chains to optionsChain.ingestSnapshot
// (write key) and research agents read them through optionsChain.snapshot (read key).
// Research only: nothing here places, changes or cancels orders.

export const OPTION_CHAIN_SNAPSHOT_RIGHTS = ["call", "put"] as const;
export type OptionChainSnapshotRight =
  (typeof OPTION_CHAIN_SNAPSHOT_RIGHTS)[number];

export const OPTION_CHAIN_SNAPSHOT_QUOTE_SOURCES = [
  "ibkr",
  "yahoo",
  "quantdata",
  "mixed",
] as const;
export type OptionChainSnapshotQuoteSource =
  (typeof OPTION_CHAIN_SNAPSHOT_QUOTE_SOURCES)[number];

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

// NaN sorts above Infinity in Postgres, so `< 'Infinity'` refuses both Infinity and NaN.
const finiteNonNegative = (column: AnyPgColumn): SQL =>
  sql`(${column} is null or (${column} >= 0 and ${column} < 'Infinity'::float8))`;

export const optionChainSnapshots = pgTable(
  "option_chain_snapshots",
  {
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    expiry: date("expiry", { mode: "string" }).notNull(),
    id: text("id").primaryKey(),
    quoteCount: integer("quote_count").notNull(),
    snapshotAt: utcTimestamp("snapshot_at").notNull(),
    source: text("source").notNull(),
    spot: doublePrecision("spot"),
    tradingDay: date("trading_day", { mode: "string" }).notNull(),
    underlying: text("underlying").notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("option_chain_snapshots_at_underlying_expiry_idx").on(
      table.snapshotAt,
      table.underlying,
      table.expiry
    ),
    index("option_chain_snapshots_underlying_at_idx").on(
      table.underlying,
      table.snapshotAt
    ),
    index("option_chain_snapshots_underlying_day_idx").on(
      table.underlying,
      table.tradingDay,
      table.snapshotAt
    ),
    check(
      "option_chain_snapshots_check",
      sql.join(
        [
          sql`char_length(trim(${table.id})) between 1 and 128`,
          sql`${table.underlying} ~ '^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$'`,
          sql`char_length(trim(${table.source})) between 1 and 64`,
          sql`${table.quoteCount} > 0`,
          sql`(${table.spot} is null or (${table.spot} > 0 and ${table.spot} < 'Infinity'::float8))`,
        ],
        sql` and `
      )
    ),
  ]
);

export const optionChainSnapshotQuotes = pgTable(
  "option_chain_snapshot_quotes",
  {
    ask: doublePrecision("ask"),
    bid: doublePrecision("bid"),
    iv: doublePrecision("iv"),
    last: doublePrecision("last"),
    openInterest: integer("open_interest"),
    right: text("right").notNull().$type<OptionChainSnapshotRight>(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => optionChainSnapshots.id, { onDelete: "cascade" }),
    source: text("source").notNull().$type<OptionChainSnapshotQuoteSource>(),
    strike: doublePrecision("strike").notNull(),
    volume: integer("volume"),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.strike, table.right],
      name: "option_chain_snapshot_quotes_pk",
    }),
    check(
      "option_chain_snapshot_quotes_check",
      sql.join(
        [
          sql`${table.strike} > 0 and ${table.strike} < 'Infinity'::float8`,
          sql`${table.right} in ('call', 'put')`,
          finiteNonNegative(table.bid),
          finiteNonNegative(table.ask),
          finiteNonNegative(table.last),
          sql`(${table.volume} is null or ${table.volume} >= 0)`,
          sql`(${table.openInterest} is null or ${table.openInterest} >= 0)`,
          finiteNonNegative(table.iv),
          sql`${table.source} in ('ibkr', 'yahoo', 'quantdata', 'mixed')`,
        ],
        sql` and `
      )
    ),
  ]
);

export type OptionChainSnapshotRow = typeof optionChainSnapshots.$inferSelect;
export type OptionChainSnapshotQuoteRow =
  typeof optionChainSnapshotQuotes.$inferSelect;
