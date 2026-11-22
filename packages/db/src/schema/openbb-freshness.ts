import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Durable per-monitor freshness alert and delivery-outbox state (card vertex-price-freshness-alert;
// research data alerting only, no orders). One row per named monitor (for example "price-freshness"):
// steady-state healthy checks write zero rows, and pending_* holds an undelivered alert or recovery
// until server ntfy or the QuantVPS #omp-alerts fallback acknowledges delivery.

export const OPENBB_FRESHNESS_KINDS = ["alert", "recovery"] as const;
export type OpenbbFreshnessKind = (typeof OPENBB_FRESHNESS_KINDS)[number];

export const OPENBB_FRESHNESS_PERSISTED_DELIVERIES = [
  "pending",
  "not-configured",
  "failed",
] as const;
export type OpenbbFreshnessPersistedDelivery =
  (typeof OPENBB_FRESHNESS_PERSISTED_DELIVERIES)[number];

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const openbbFreshnessState = pgTable(
  "price_freshness_state",
  {
    activeKeys: text("active_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastTransitionAt: utcTimestamp("last_transition_at"),
    monitor: text("monitor").primaryKey(),
    pendingDelivery:
      text("pending_delivery").$type<OpenbbFreshnessPersistedDelivery>(),
    pendingEventId: text("pending_event_id"),
    pendingKeys: text("pending_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    pendingKind: text("pending_kind").$type<OpenbbFreshnessKind>(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "price_freshness_state_check",
      sql`${table.monitor} ~ '^[a-z0-9-]{1,40}$' and array_position(${table.activeKeys}, NULL) is null and array_position(${table.pendingKeys}, NULL) is null and ((${table.pendingEventId} is null and ${table.pendingKind} is null and ${table.pendingDelivery} is null and ${table.pendingKeys} = '{}'::text[]) or (${table.pendingEventId} is not null and ${table.pendingKind} is not null and ${table.pendingDelivery} is not null and char_length(trim(${table.pendingEventId})) between 1 and 80 and char_length(${table.pendingEventId}) <= 80 and ${table.pendingKind} in ('alert', 'recovery') and ${table.pendingDelivery} in ('pending', 'not-configured', 'failed') and ((${table.pendingKind} = 'alert' and cardinality(${table.pendingKeys}) > 0) or (${table.pendingKind} = 'recovery' and ${table.pendingKeys} = '{}'::text[]))))`
    ),
  ]
);
