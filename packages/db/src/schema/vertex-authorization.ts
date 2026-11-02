import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const ordinal = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();

// Global grant identity cannot be re-bound to a different tenant, resource,
// collection, actor or action set. New permissions require a new grant identity.
export const vertexGrantBindings = pgTable(
  "vertex_grant_bindings",
  {
    ...scope(),
    grantId: text("grant_id").primaryKey(),
    granteeActorId: text("grantee_actor_id").notNull(),
    collectionKey: text("collection_key").notNull(),
    resourceId: text("resource_id").notNull(),
    bindingHash: text("binding_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    uniqueIndex("vertex_grant_binding_scope").on(
      t.accountAlias,
      t.environment,
      t.grantId
    ),
    index("vertex_grant_lookup").on(
      t.granteeActorId,
      t.accountAlias,
      t.environment,
      t.collectionKey,
      t.resourceId
    ),
    check(
      "vertex_grant_environment",
      sql`${t.environment} in ('research','paper','live')`
    ),
    check(
      "vertex_grant_binding_hash",
      sql`${t.bindingHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexGrantVersions = pgTable(
  "vertex_grant_versions",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    version: text("version").notNull(),
    revision: ordinal("revision").notNull(),
    status: text("status").notNull(),
    validFrom: text("valid_from").notNull(),
    validFromNs: ordinal("valid_from_ns").notNull(),
    expiresAt: text("expires_at").notNull(),
    expiresAtNs: ordinal("expires_at_ns").notNull(),
    recordedAt: text("recorded_at").notNull(),
    recordedAtNs: ordinal("recorded_at_ns").notNull(),
    recordedByActorId: text("recorded_by_actor_id").notNull(),
    expectedVersion: text("expected_version"),
    requestHash: text("request_hash").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.grantId, t.version],
      name: "vertex_grant_versions_pk",
    }),
    uniqueIndex("vertex_grant_revision").on(
      t.accountAlias,
      t.environment,
      t.grantId,
      t.revision
    ),
    foreignKey({
      name: "vertex_grant_version_binding_fk",
      columns: [t.accountAlias, t.environment, t.grantId],
      foreignColumns: [
        vertexGrantBindings.accountAlias,
        vertexGrantBindings.environment,
        vertexGrantBindings.grantId,
      ],
    }),
    check("vertex_grant_status", sql`${t.status} in ('granted','revoked')`),
    check("vertex_grant_revision_positive", sql`${t.revision} > 0`),
    check("vertex_grant_interval", sql`${t.validFromNs} < ${t.expiresAtNs}`),
    check(
      "vertex_grant_version_hashes",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$' and ${t.requestHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexGrantActions = pgTable(
  "vertex_grant_actions",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    version: text("version").notNull(),
    action: text("action").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.grantId, t.version, t.action],
      name: "vertex_grant_actions_pk",
    }),
    foreignKey({
      name: "vertex_grant_action_version_fk",
      columns: [t.accountAlias, t.environment, t.grantId, t.version],
      foreignColumns: [
        vertexGrantVersions.accountAlias,
        vertexGrantVersions.environment,
        vertexGrantVersions.grantId,
        vertexGrantVersions.version,
      ],
    }),
    check(
      "vertex_grant_action",
      sql`${t.action} in ('read','publish','review','admit-paper-simulation','project','manage-rights','dispatch-outbox','cleanup-chat-copies')`
    ),
  ]
);
export const vertexGrantCurrent = pgTable(
  "vertex_grant_current",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    currentVersion: text("current_version").notNull(),
    revision: ordinal("revision").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.grantId],
      name: "vertex_grant_current_pk",
    }),
    foreignKey({
      name: "vertex_grant_current_version_fk",
      columns: [t.accountAlias, t.environment, t.grantId, t.currentVersion],
      foreignColumns: [
        vertexGrantVersions.accountAlias,
        vertexGrantVersions.environment,
        vertexGrantVersions.grantId,
        vertexGrantVersions.version,
      ],
    }),
    check("vertex_grant_current_revision", sql`${t.revision} > 0`),
  ]
);
