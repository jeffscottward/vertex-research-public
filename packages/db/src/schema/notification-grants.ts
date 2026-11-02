import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

const key = (name: string) => text(name).notNull();
// Consent and send grants are distinct record kinds. Every version is immutable;
// only a current pointer advances. No raw destination, provider value or secret.
export const notificationAuthorityVersions = pgTable(
  "notification_authority_versions",
  {
    tenantKey: key("tenant_key"),
    accountAlias: key("account_alias"),
    environment: key("environment"),
    recordKind: key("record_kind"),
    authorityId: key("authority_id"),
    version: key("version"),
    status: key("status"),
    recipientKey: key("recipient_key"),
    channel: key("channel"),
    purpose: key("purpose"),
    bindingHash: key("binding_hash"),
    payloadHash: key("payload_hash"),
    requestHash: key("request_hash"),
    payload: jsonb("payload").notNull(),
    recordedBy: key("recorded_by"),
    recordedAtMs: bigint("recorded_at_ms", { mode: "number" }).notNull(),
    validFromMs: bigint("valid_from_ms", { mode: "number" }).notNull(),
    expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "notification_authority_versions_pk",
      columns: [
        table.tenantKey,
        table.accountAlias,
        table.environment,
        table.recordKind,
        table.authorityId,
        table.version,
      ],
    }),
    check(
      "notification_authority_versions_keys",
      sql`${table.tenantKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.accountAlias} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${table.authorityId} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.recipientKey} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and ${table.recordedBy} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'`
    ),
    check(
      "notification_authority_versions_scope",
      sql`${table.environment} in ('research', 'paper') and ${table.recordKind} in ('consent', 'grant') and ${table.channel} in ('phone', 'email') and ${table.purpose} in ('market-alert', 'research-update', 'operational-alert')`
    ),
    check(
      "notification_authority_versions_state",
      sql`${table.status} in ('granted', 'revoked') and ${table.version} ~ '^[1-9][0-9]{0,29}$'`
    ),
    check(
      "notification_authority_versions_hashes",
      sql`${table.bindingHash} ~ '^[0-9a-f]{64}$' and ${table.payloadHash} ~ '^[0-9a-f]{64}$' and ${table.requestHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "notification_authority_versions_interval",
      sql`${table.recordedAtMs} between 0 and 253402300799999 and ${table.validFromMs} between 0 and 253402300799999 and ${table.expiresAtMs} between 0 and 253402300799999 and ${table.validFromMs} < ${table.expiresAtMs}`
    ),
  ]
);
export const notificationAuthorityCurrent = pgTable(
  "notification_authority_current",
  {
    tenantKey: key("tenant_key"),
    accountAlias: key("account_alias"),
    environment: key("environment"),
    recordKind: key("record_kind"),
    authorityId: key("authority_id"),
    currentVersion: key("current_version"),
  },
  (table) => [
    primaryKey({
      name: "notification_authority_current_pk",
      columns: [
        table.tenantKey,
        table.accountAlias,
        table.environment,
        table.recordKind,
        table.authorityId,
      ],
    }),
    foreignKey({
      name: "notification_authority_current_version_fk",
      columns: [
        table.tenantKey,
        table.accountAlias,
        table.environment,
        table.recordKind,
        table.authorityId,
        table.currentVersion,
      ],
      foreignColumns: [
        notificationAuthorityVersions.tenantKey,
        notificationAuthorityVersions.accountAlias,
        notificationAuthorityVersions.environment,
        notificationAuthorityVersions.recordKind,
        notificationAuthorityVersions.authorityId,
        notificationAuthorityVersions.version,
      ],
    }),
    index("notification_authority_current_scope").on(
      table.tenantKey,
      table.accountAlias,
      table.environment,
      table.recordKind
    ),
  ]
);
