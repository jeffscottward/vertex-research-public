import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexPolicySelections } from "./vertex-policy.ts";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const exact = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();

// Separate from vertex_rights_versions and its immutable four storage uses.
export const vertexModelUseGrantVersions = pgTable(
  "vertex_model_use_grant_versions",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    grantVersion: text("grant_version").notNull(),
    revision: exact("revision").notNull(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    researchPrincipalId: text("research_principal_id").notNull(),
    consumerServiceId: text("consumer_service_id").notNull(),
    status: text("status").notNull(),
    validFromNs: exact("valid_from_ns").notNull(),
    expiresAtNs: exact("expires_at_ns").notNull(),
    issuedAtNs: exact("issued_at_ns").notNull(),
    issuedByActorId: text("issued_by_actor_id").notNull(),
    commandId: text("command_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.grantId, t.grantVersion],
    }),
    uniqueIndex("vertex_model_use_grant_revision").on(
      t.accountAlias,
      t.environment,
      t.grantId,
      t.revision
    ),
    uniqueIndex("vertex_model_use_command").on(
      t.accountAlias,
      t.environment,
      t.commandId
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    check(
      "vertex_model_use_scope",
      sql`${t.environment} in ('research','paper')`
    ),
    check("vertex_model_use_status", sql`${t.status} in ('granted','revoked')`),
    check(
      "vertex_model_use_window",
      sql`${t.revision} > 0 and ${t.validFromNs} < ${t.expiresAtNs}`
    ),
    check(
      "vertex_model_use_hashes",
      sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexModelUseGrantCurrent = pgTable(
  "vertex_model_use_grant_current",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    grantVersion: text("grant_version").notNull(),
    revision: exact("revision").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_model_use_grant_current_pkey",
      columns: [t.accountAlias, t.environment, t.grantId],
    }),
    foreignKey({
      name: "vertex_model_use_grant_current_grant_version_fk",
      columns: [t.accountAlias, t.environment, t.grantId, t.grantVersion],
      foreignColumns: [
        vertexModelUseGrantVersions.accountAlias,
        vertexModelUseGrantVersions.environment,
        vertexModelUseGrantVersions.grantId,
        vertexModelUseGrantVersions.grantVersion,
      ],
    }),
    check("vertex_model_use_current_revision", sql`${t.revision} > 0`),
  ]
);
export const vertexModelUseProofAudits = pgTable(
  "vertex_model_use_proof_audits",
  {
    ...scope(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    checkedAtNs: exact("checked_at_ns").notNull(),
    actorId: text("actor_id").notNull(),
    grantId: text("grant_id").notNull(),
    grantVersion: text("grant_version").notNull(),
    grantRevision: exact("grant_revision"),
    decision: text("decision").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.requestId,
        t.checkedAtNs,
        t.recordHash,
      ],
    }),
    check(
      "vertex_model_use_proof_decision",
      sql`${t.decision} in ('allowed','denied')`
    ),
    check(
      "vertex_model_use_proof_hashes",
      sql`${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);

// Aggregate admission ledger. Only the model-use DB store reserves against
// immutable selected budgets; no expiry/retry refunds or external retry permit.
export const vertexModelUseBudgetWindows = pgTable(
  "vertex_model_use_budget_windows",
  {
    ...scope(),
    windowId: text("window_id").notNull(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    policyId: text("policy_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyArtifactSha256: text("policy_artifact_sha256").notNull(),
    periodId: text("period_id").notNull(),
    startsAtNs: exact("starts_at_ns").notNull(),
    expiresAtNs: exact("expires_at_ns").notNull(),
    maximumTokens: exact("maximum_tokens").notNull(),
    maximumCostUnits: exact("maximum_cost_units").notNull(),
    reservedTokens: exact("reserved_tokens").notNull(),
    reservedCostUnits: exact("reserved_cost_units").notNull(),
    revision: exact("revision").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.windowId] }),
    uniqueIndex("vertex_model_use_window_identity").on(
      t.accountAlias,
      t.environment,
      t.selectionId,
      t.policyId,
      t.periodId
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    check(
      "vertex_model_use_window_bounds",
      sql`${t.reservedTokens} >= 0 and ${t.reservedTokens} <= ${t.maximumTokens} and ${t.reservedCostUnits} >= 0 and ${t.reservedCostUnits} <= ${t.maximumCostUnits} and ${t.revision} > 0 and ${t.startsAtNs} < ${t.expiresAtNs}`
    ),
  ]
);
export const vertexModelUseBudgetReservations = pgTable(
  "vertex_model_use_budget_reservations",
  {
    ...scope(),
    jobId: text("job_id").notNull(),
    selectionId: text("selection_id").notNull(),
    selectionSha256: text("selection_sha256").notNull(),
    requestSha256: text("request_sha256").notNull(),
    reservationId: text("reservation_id").notNull(),
    operation: text("operation").notNull(),
    inputBytes: exact("input_bytes").notNull(),
    inputTokens: exact("input_tokens"),
    maximumOutputTokens: exact("maximum_output_tokens").notNull(),
    maximumCostUsd: text("maximum_cost_usd").notNull(),
    tokenCharge: exact("token_charge").notNull(),
    costChargeUnits: exact("cost_charge_units").notNull(),
    expiresAtNs: exact("expires_at_ns").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
    windowId: text("window_id").notNull(),
    requestId: text("request_id").notNull(),
    grantId: text("grant_id").notNull(),
    grantVersion: text("grant_version").notNull(),
    leaseId: text("lease_id").notNull(),
    leaseEpoch: exact("lease_epoch").notNull(),
    windowRevision: exact("window_revision").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_model_use_budget_reservations_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.jobId,
        t.selectionId,
        t.requestSha256,
      ],
    }),
    uniqueIndex("vertex_model_use_reservation_id").on(
      t.accountAlias,
      t.environment,
      t.reservationId
    ),
    foreignKey({
      name: "vertex_model_use_budget_reservations_selection_fk",
      columns: [t.accountAlias, t.environment, t.selectionId],
      foreignColumns: [
        vertexPolicySelections.accountAlias,
        vertexPolicySelections.environment,
        vertexPolicySelections.selectionId,
      ],
    }),
    check(
      "vertex_model_use_budget_scope",
      sql`${t.environment} in ('research','paper')`
    ),
    check(
      "vertex_model_use_budget_operation",
      sql`${t.operation} in ('model-tokenize','model-completion')`
    ),
    check(
      "vertex_model_use_budget_bounds",
      sql`${t.inputBytes} >= 0 and (${t.inputTokens} is null or ${t.inputTokens} >= 0) and ${t.maximumOutputTokens} >= 0 and ${t.tokenCharge} >= 0 and ${t.costChargeUnits} >= 0`
    ),
    check(
      "vertex_model_use_budget_cost",
      sql`${t.maximumCostUsd} ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'`
    ),
    check(
      "vertex_model_use_budget_hashes",
      sql`${t.selectionSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexModelUseAttemptIdentities = pgTable(
  "vertex_model_use_attempt_identities",
  {
    ...scope(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountAlias, t.environment, t.requestId] })]
);
