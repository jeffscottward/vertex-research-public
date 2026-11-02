-- Pending authoritative Drizzle history assembly; not a migratable release by itself.
CREATE TABLE "vertex_worker_service_grants" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "grant_id" text NOT NULL,
  "service_principal_id" text NOT NULL, "credential_digest" text NOT NULL,
  "issued_at_ns" numeric(30,0) NOT NULL, "expires_at_ns" numeric(30,0) NOT NULL,
  "revoked_at" text, "record_hash" text NOT NULL, "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias","environment","grant_id"),
  CONSTRAINT "vertex_worker_grant_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_worker_grant_digest" CHECK ("credential_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vertex_worker_grant_expiry" CHECK ("expires_at_ns" > "issued_at_ns")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_credential_digest" ON "vertex_worker_service_grants" ("credential_digest");
--> statement-breakpoint
CREATE TABLE "vertex_worker_jobs" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "job_id" text NOT NULL,
  "event_id" text NOT NULL, "grant_id" text NOT NULL, "worker_instance_id" text NOT NULL,
  "binding_hash" text NOT NULL, "state" text NOT NULL, "lease_id" text NOT NULL,
  "lease_epoch" numeric(30,0) NOT NULL, "lease_expires_at_ns" numeric(30,0) NOT NULL,
  "deadline_at_ns" numeric(30,0) NOT NULL, "attempt" integer NOT NULL,
  "outcome_hash" text, "output_artifact_ids" jsonb NOT NULL, "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias","environment","job_id"),
  CONSTRAINT "vertex_worker_job_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_worker_job_state" CHECK ("state" IN ('leased','running','succeeded','failed','cancelled','unknown')),
  CONSTRAINT "vertex_worker_job_lease" CHECK ("lease_epoch" > 0 AND "attempt" BETWEEN 1 AND 32 AND "lease_expires_at_ns" <= "deadline_at_ns")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_event_admission" ON "vertex_worker_jobs" ("account_alias","environment","event_id");
--> statement-breakpoint
CREATE TABLE "vertex_worker_run_admissions" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "run_id" text NOT NULL,
  "job_id" text NOT NULL, "request_hash" text NOT NULL, "lease_epoch" numeric(30,0) NOT NULL,
  "admitted_at" text NOT NULL, PRIMARY KEY ("account_alias","environment","run_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_one_run_per_job" ON "vertex_worker_run_admissions" ("account_alias","environment","job_id");
--> statement-breakpoint
CREATE TABLE "vertex_worker_stages" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "artifact_id" text NOT NULL,
  "job_id" text NOT NULL, "collection_key" text NOT NULL, "object_key" text NOT NULL,
  "content_sha256" text NOT NULL, "canonical_sha256" text, "request_hash" text NOT NULL,
  "byte_length" integer NOT NULL, "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias","environment","artifact_id"),
  CONSTRAINT "vertex_worker_stage_length" CHECK ("byte_length" BETWEEN 0 AND 1048576),
  CONSTRAINT "vertex_worker_stage_hash" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$' AND ("canonical_sha256" IS NULL OR "canonical_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_agent_publications" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "run_id" text NOT NULL,
  "run_artifact_id" text NOT NULL, "advisory_artifact_id" text NOT NULL,
  "advisory_sha256" text NOT NULL, "request_hash" text NOT NULL,
  "review_pins" jsonb NOT NULL, "published_at" text NOT NULL,
  PRIMARY KEY ("account_alias","environment","run_artifact_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_terminal_agent_run" ON "vertex_worker_agent_publications" ("account_alias","environment","run_id");
--> statement-breakpoint
CREATE TABLE "vertex_worker_collection_activations" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "collection_id" text NOT NULL,
  "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "previous_snapshot_id" text NOT NULL, "snapshot_id" text NOT NULL, "activated_at" text NOT NULL,
  PRIMARY KEY ("account_alias","environment","collection_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_readiness" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "job_id" text NOT NULL,
  "lease_epoch" numeric(30,0) NOT NULL, "observed_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL, PRIMARY KEY ("account_alias","environment","job_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_collection_snapshots" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "collection_id" text NOT NULL,
  "snapshot_id" text NOT NULL, "job_id" text NOT NULL,
  "reconstruction_artifact_id" text NOT NULL, "reconstruction_sha256" text NOT NULL,
  "manifest_sha256" text NOT NULL, "member_artifacts" jsonb NOT NULL,
  "rights_pins" jsonb NOT NULL, "record_hash" text NOT NULL, "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias","environment","collection_id","snapshot_id")
);
