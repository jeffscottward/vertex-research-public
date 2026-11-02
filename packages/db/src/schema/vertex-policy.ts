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
import { vertexAccountAliases } from "./vertex.ts";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const exact = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();
// Selection records and history are insert-only. Heads/pins are the only
// mutable records; every mutation is serialized and audited by the store.
export const vertexPolicySelections = pgTable(
  "vertex_policy_selections",
  {
    ...scope(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    revision: exact("revision").notNull(),
    issuedAtNs: exact("issued_at_ns").notNull(),
    expiresAtNs: exact("expires_at_ns").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.selectionId] }),
    uniqueIndex("vertex_policy_revision").on(
      t.accountAlias,
      t.environment,
      t.revision
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment],
      foreignColumns: [
        vertexAccountAliases.accountAlias,
        vertexAccountAliases.environment,
      ],
    }),
    check("vertex_policy_scope", sql`${t.environment} in ('research','paper')`),
    check("vertex_policy_digest", sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "vertex_policy_window",
      sql`${t.revision} > 0 and ${t.issuedAtNs} < ${t.expiresAtNs}`
    ),
  ]
);
export const vertexPolicyHeads = pgTable(
  "vertex_policy_heads",
  {
    ...scope(),
    revision: exact("revision").notNull(),
    selectionId: text("selection_id"),
    selectionSha256: text("selection_sha256"),
    state: text("state").notNull(),
    updatedAt: text("updated_at").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    check(
      "vertex_policy_head_state",
      sql`${t.state} in ('disabled','active-read-only','draining')`
    ),
    check(
      "vertex_policy_head_identity",
      sql`(${t.selectionId} is null) = (${t.selectionSha256} is null) and (${t.state} = 'disabled' or ${t.selectionId} is not null)`
    ),
    check("vertex_policy_head_revision", sql`${t.revision} > 0`),
    check(
      "vertex_policy_head_scope",
      sql`${t.environment} in ('research','paper')`
    ),
    check(
      "vertex_policy_head_hash",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$' and (${t.selectionSha256} is null or ${t.selectionSha256} ~ '^[0-9a-f]{64}$')`
    ),
  ]
);
export const vertexPolicyHistory = pgTable(
  "vertex_policy_history",
  {
    ...scope(),
    commandId: text("command_id").notNull(),
    revision: exact("revision").notNull(),
    operation: text("operation").notNull(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    actorId: text("actor_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    recordHash: text("record_hash").notNull(),
    recordedAtNs: exact("recorded_at_ns").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.commandId] }),
    uniqueIndex("vertex_policy_history_revision").on(
      t.accountAlias,
      t.environment,
      t.revision
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    index("vertex_policy_activation_history").on(
      t.accountAlias,
      t.environment,
      t.selectionId,
      t.operation
    ),
    check(
      "vertex_policy_history_operation",
      sql`${t.operation} in ('stage','activate','rollback','drain','revoke','pin','release')`
    ),
    check(
      "vertex_policy_history_hashes",
      sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check("vertex_policy_history_revision_positive", sql`${t.revision} > 0`),
  ]
);
export const vertexPolicyRevocations = pgTable(
  "vertex_policy_revocations",
  {
    ...scope(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    commandId: text("command_id").notNull(),
    actorId: text("actor_id").notNull(),
    recordedAtNs: exact("recorded_at_ns").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      name: "vertex_policy_revocations_pkey",
      columns: [t.accountAlias, t.environment, t.selectionId],
    }),
    foreignKey({
      name: "vertex_policy_revocations_selection_fk",
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    check(
      "vertex_policy_revocation_hashes",
      sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexPolicyOwnershipPins = pgTable(
  "vertex_policy_ownership_pins",
  {
    ...scope(),
    holderId: text("holder_id").notNull(),
    holderKind: text("holder_kind").notNull(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    moduleId: text("module_id").notNull(),
    moduleVersion: text("module_version").notNull(),
    codeSha256: text("code_sha256").notNull(),
    ownerServiceId: text("owner_service_id").notNull(),
    ownerEpoch: exact("owner_epoch").notNull(),
    pinnedAtNs: exact("pinned_at_ns").notNull(),
    releasedAtNs: exact("released_at_ns"),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.holderId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    index("vertex_policy_open_pins").on(
      t.accountAlias,
      t.environment,
      t.selectionId,
      t.releasedAtNs
    ),
    check(
      "vertex_policy_pin_kind",
      sql`${t.holderKind} in ('job','open-position')`
    ),
    check("vertex_policy_pin_owner", sql`${t.ownerEpoch} > 0`),
    check(
      "vertex_policy_pin_time",
      sql`${t.releasedAtNs} is null or ${t.releasedAtNs} >= ${t.pinnedAtNs}`
    ),
    check(
      "vertex_policy_pin_hashes",
      sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$' and ${t.codeSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
