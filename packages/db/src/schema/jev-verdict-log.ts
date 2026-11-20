// What: the JEV verdict log. One row per successful JEV refresh, written after the in-memory
// store has the verdict, so the forecast scorecard can score real verdicts later.
// Append-only: the app role gets SELECT and INSERT only (migration 0082); there is no update
// or delete path. Duplicates (same symbol and data date) are kept; the scorer decides which
// one counts (earliest decidedAt).
// Research only: the order gate never reads this table, and nothing here places, changes or
// cancels an order.
// Used by: packages/db/src/server/jev-verdict-log.ts.
// See: docs/vertex-rebuild/jev-verdict-log.md.
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const JEV_VERDICT_LOG_STANCES = [
  "BULLISH",
  "BEARISH",
  "NEUTRAL",
] as const;
export type JevVerdictLogStance = (typeof JEV_VERDICT_LOG_STANCES)[number];

export const jevVerdictLog = pgTable(
  "jev_verdict_log",
  {
    choice: text("choice"),
    // Close date of the last daily bar JEV saw (YYYY-MM-DD), or null when not reported.
    dataAsOf: text("data_as_of"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull(),
    model: text("model"),
    probBearish: doublePrecision("prob_bearish").notNull(),
    probBullish: doublePrecision("prob_bullish").notNull(),
    probNeutral: doublePrecision("prob_neutral").notNull(),
    source: text("source").notNull(),
    sourceVersion: text("source_version"),
    stance: text("stance").notNull(),
    symbol: text("symbol").notNull(),
  },
  (table) => [
    index("jev_verdict_log_symbol_data_idx").on(table.symbol, table.dataAsOf),
    index("jev_verdict_log_decided_idx").on(table.decidedAt),
    check(
      "jev_verdict_log_check",
      sql`${table.stance} in ('BULLISH', 'BEARISH', 'NEUTRAL') and (${table.choice} is null or ${table.choice} in ('BULLISH', 'BEARISH', 'NEUTRAL')) and ${table.probBearish} between 0 and 1 and ${table.probBullish} between 0 and 1 and ${table.probNeutral} between 0 and 1 and length(${table.source}) between 1 and 64 and length(${table.symbol}) between 1 and 12 and (${table.dataAsOf} is null or ${table.dataAsOf} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and (${table.sourceVersion} is null or length(${table.sourceVersion}) <= 64) and (${table.model} is null or length(${table.model}) <= 200)`
    ),
  ]
);
