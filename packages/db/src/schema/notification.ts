import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Server-resolved opaque identifiers only. No notification body, destination,
// topic, token, provider reference, configuration reference or raw errors.
const key = (name: string) => text(name).notNull();
const milliseconds = (name: string) =>
  bigint(name, { mode: "number" }).notNull();

export const notificationAdmissions = pgTable(
  "notification_admissions",
  {
    tenantKey: key("tenant_key"),
    recipientKey: key("recipient_key"),
    channel: key("channel"),
    purpose: key("purpose"),
    idempotencyKey: key("idempotency_key"),
    fingerprint: key("fingerprint"),
    attemptId: key("attempt_id"),
    acceptance: key("acceptance"),
    admittedAtMs: milliseconds("admitted_at_ms"),
    expiresAtMs: milliseconds("expires_at_ms"),
    outcomeAtMs: bigint("outcome_at_ms", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      name: "notification_admissions_pkey",
      columns: [
        table.tenantKey,
        table.recipientKey,
        table.channel,
        table.purpose,
        table.idempotencyKey,
      ],
    }),
    uniqueIndex("notification_admissions_attempt_unique").on(
      table.tenantKey,
      table.recipientKey,
      table.channel,
      table.attemptId
    ),
    check(
      "notification_admissions_keys_check",
      sql`${table.tenantKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.recipientKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.attemptId} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'`
    ),
    check(
      "notification_admissions_channel_check",
      sql`${table.channel} in ('phone', 'email')`
    ),
    check(
      "notification_admissions_purpose_check",
      sql`${table.purpose} in ('market-alert', 'research-update', 'operational-alert')`
    ),
    check(
      "notification_admissions_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "notification_admissions_acceptance_check",
      sql`${table.acceptance} in ('pending', 'accepted', 'rejected', 'unknown', 'not-sent')`
    ),
    check(
      "notification_admissions_time_check",
      sql`${table.admittedAtMs} between 0 and 253402300799999 and ${table.expiresAtMs} between 0 and 253402300799999 and ${table.expiresAtMs} > ${table.admittedAtMs} and ${table.expiresAtMs} - ${table.admittedAtMs} <= 86400000`
    ),
    check(
      "notification_admissions_outcome_check",
      sql`(${table.acceptance} = 'pending' and ${table.outcomeAtMs} is null) or (${table.acceptance} <> 'pending' and ${table.outcomeAtMs} is not null and ${table.outcomeAtMs} between ${table.admittedAtMs} and 253402300799999)`
    ),
  ]
);

// Deliberately excludes purpose: a recipient's cross-purpose cooldown shares one
// row. No public method deletes/shortens it or releases it after a failed send.
export const notificationCooldowns = pgTable(
  "notification_cooldowns",
  {
    tenantKey: key("tenant_key"),
    recipientKey: key("recipient_key"),
    channel: key("channel"),
    lastAttemptAtMs: milliseconds("last_attempt_at_ms"),
    cooldownUntilMs: milliseconds("cooldown_until_ms"),
  },
  (table) => [
    primaryKey({
      name: "notification_cooldowns_pkey",
      columns: [table.tenantKey, table.recipientKey, table.channel],
    }),
    check(
      "notification_cooldowns_keys_check",
      sql`${table.tenantKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.recipientKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'`
    ),
    check(
      "notification_cooldowns_channel_check",
      sql`${table.channel} in ('phone', 'email')`
    ),
    check(
      "notification_cooldowns_time_check",
      sql`${table.lastAttemptAtMs} between 0 and 253402300799999 and ${table.cooldownUntilMs} between 0 and 253402300799999 and ${table.cooldownUntilMs} - ${table.lastAttemptAtMs} between 1000 and 604800000`
    ),
  ]
);
