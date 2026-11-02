import { sql } from "drizzle-orm";
import {
  check,
  integer,
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
const ns = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();
export const vertexWorkerServiceGrants = pgTable(
  "vertex_worker_service_grants",
  {
    ...scope(),
    grantId: text("grant_id").notNull(),
    servicePrincipalId: text("service_principal_id").notNull(),
    credentialDigest: text("credential_digest").notNull(),
    issuedAtNs: ns("issued_at_ns").notNull(),
    expiresAtNs: ns("expires_at_ns").notNull(),
    revokedAt: text("revoked_at"),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.grantId] }),
    uniqueIndex("vertex_worker_credential_digest").on(t.credentialDigest),
    check(
      "vertex_worker_grant_scope",
      sql`${t.environment} in ('research','paper')`
    ),
    check(
      "vertex_worker_grant_digest",
      sql`${t.credentialDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_worker_grant_expiry",
      sql`${t.expiresAtNs} > ${t.issuedAtNs}`
    ),
  ]
);
export const vertexWorkerJobs = pgTable(
  "vertex_worker_jobs",
  {
    ...scope(),
    jobId: text("job_id").notNull(),
    eventId: text("event_id").notNull(),
    grantId: text("grant_id").notNull(),
    workerInstanceId: text("worker_instance_id").notNull(),
    bindingHash: text("binding_hash").notNull(),
    state: text("state").notNull(),
    leaseId: text("lease_id").notNull(),
    leaseEpoch: ns("lease_epoch").notNull(),
    leaseExpiresAtNs: ns("lease_expires_at_ns").notNull(),
    deadlineAtNs: ns("deadline_at_ns").notNull(),
    attempt: integer("attempt").notNull(),
    outcomeHash: text("outcome_hash"),
    outputArtifactIds: jsonb("output_artifact_ids")
      .$type<readonly string[]>()
      .notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.jobId] }),
    uniqueIndex("vertex_worker_event_admission").on(
      t.accountAlias,
      t.environment,
      t.eventId
    ),
    check(
      "vertex_worker_job_scope",
      sql`${t.environment} in ('research','paper')`
    ),
    check(
      "vertex_worker_job_state",
      sql`${t.state} in ('leased','running','succeeded','failed','cancelled','unknown')`
    ),
    check(
      "vertex_worker_job_lease",
      sql`${t.leaseEpoch} > 0 and ${t.attempt} between 1 and 32 and ${t.leaseExpiresAtNs} <= ${t.deadlineAtNs}`
    ),
  ]
);
export const vertexWorkerRunAdmissions = pgTable(
  "vertex_worker_run_admissions",
  {
    ...scope(),
    runId: text("run_id").notNull(),
    jobId: text("job_id").notNull(),
    requestHash: text("request_hash").notNull(),
    leaseEpoch: ns("lease_epoch").notNull(),
    admittedAt: text("admitted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.runId] }),
    uniqueIndex("vertex_worker_one_run_per_job").on(
      t.accountAlias,
      t.environment,
      t.jobId
    ),
  ]
);
// Private staged bytes are immutable object references, not public artifacts.
export const vertexWorkerStages = pgTable(
  "vertex_worker_stages",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    jobId: text("job_id").notNull(),
    collectionKey: text("collection_key").notNull(),
    objectKey: text("object_key").notNull(),
    contentSha256: text("content_sha256").notNull(),
    canonicalSha256: text("canonical_sha256"),
    requestHash: text("request_hash").notNull(),
    byteLength: integer("byte_length").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.artifactId] }),
    uniqueIndex("vertex_worker_stage_content_identity").on(
      t.accountAlias,
      t.environment,
      t.artifactId,
      t.contentSha256
    ),
    check(
      "vertex_worker_stage_length",
      sql`${t.byteLength} between 0 and 1048576`
    ),
    check(
      "vertex_worker_stage_hash",
      sql`${t.contentSha256} ~ '^[0-9a-f]{64}$' and (${t.canonicalSha256} is null or ${t.canonicalSha256} ~ '^[0-9a-f]{64}$')`
    ),
  ]
);
export const vertexWorkerAgentPublications = pgTable(
  "vertex_worker_agent_publications",
  {
    ...scope(),
    runId: text("run_id").notNull(),
    runArtifactId: text("run_artifact_id").notNull(),
    advisoryArtifactId: text("advisory_artifact_id").notNull(),
    advisorySha256: text("advisory_sha256").notNull(),
    requestHash: text("request_hash").notNull(),
    reviewPins: jsonb("review_pins").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.runArtifactId] }),
    uniqueIndex("vertex_worker_terminal_agent_run").on(
      t.accountAlias,
      t.environment,
      t.runId
    ),
  ]
);
// Private ID binding only: original handoff bytes never enter vertex_records.
export const vertexWorkerExperimentPublications = pgTable(
  "vertex_worker_experiment_publications",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    experimentId: text("experiment_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    objectKey: text("object_key").notNull(),
    byteLength: integer("byte_length").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      name: "vertex_worker_experiment_identity",
      columns: [t.accountAlias, t.environment, t.collectionId, t.experimentId],
    }),
    uniqueIndex("vertex_worker_experiment_artifact").on(
      t.accountAlias,
      t.environment,
      t.artifactId
    ),
    check(
      "vertex_worker_experiment_scope",
      sql`${t.environment} in ('research','paper') and length(${t.collectionId}) > 0`
    ),
    check(
      "vertex_worker_experiment_length",
      sql`${t.byteLength} between 1 and 1048576`
    ),
    check(
      "vertex_worker_experiment_hash",
      sql`${t.contentSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
export const vertexWorkerCollectionActivations = pgTable(
  "vertex_worker_collection_activations",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    previousSnapshotId: text("previous_snapshot_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    activatedAt: text("activated_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.idempotencyKey,
      ],
    }),
  ]
);
export const vertexWorkerReadiness = pgTable(
  "vertex_worker_readiness",
  {
    ...scope(),
    jobId: text("job_id").notNull(),
    leaseEpoch: ns("lease_epoch").notNull(),
    observedAtNs: ns("observed_at_ns").notNull(),
    payload: payload(),
  },
  (t) => [primaryKey({ columns: [t.accountAlias, t.environment, t.jobId] })]
);
export const vertexWorkerCollectionSnapshots = pgTable(
  "vertex_worker_collection_snapshots",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    jobId: text("job_id").notNull(),
    reconstructionArtifactId: text("reconstruction_artifact_id").notNull(),
    reconstructionSha256: text("reconstruction_sha256").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    memberArtifacts: jsonb("member_artifacts").notNull(),
    rightsPins: jsonb("rights_pins").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
    }),
  ]
);
