-- SOURCE ONLY: pending Main's authoritative combined Drizzle history assembly.
-- Separate model processing grants; storage rights retain their four uses.
CREATE TABLE "vertex_model_use_grant_versions" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "grant_id" text NOT NULL,
  "grant_version" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "research_principal_id" text NOT NULL,
  "consumer_service_id" text NOT NULL,
  "status" text NOT NULL,
  "valid_from_ns" numeric(30,0) NOT NULL,
  "expires_at_ns" numeric(30,0) NOT NULL,
  "issued_at_ns" numeric(30,0) NOT NULL,
  "issued_by_actor_id" text NOT NULL,
  "command_id" text NOT NULL,
  "request_sha256" text NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "grant_id", "grant_version"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_model_use_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_model_use_status" CHECK ("status" IN ('granted','revoked')),
  CONSTRAINT "vertex_model_use_window" CHECK ("revision" > 0 AND "valid_from_ns" < "expires_at_ns"),
  CONSTRAINT "vertex_model_use_hashes" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$' AND "request_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "vertex_model_use_grant_revision" ON "vertex_model_use_grant_versions" ("account_alias", "environment", "grant_id", "revision");
CREATE UNIQUE INDEX "vertex_model_use_command" ON "vertex_model_use_grant_versions" ("account_alias", "environment", "command_id");
--> statement-breakpoint
CREATE TABLE "vertex_model_use_grant_current" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "grant_id" text NOT NULL,
  "grant_version" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "grant_id"),
  FOREIGN KEY ("account_alias", "environment", "grant_id", "grant_version") REFERENCES "vertex_model_use_grant_versions" ("account_alias", "environment", "grant_id", "grant_version"),
  CONSTRAINT "vertex_model_use_current_revision" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_proof_audits" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "request_id" text NOT NULL,
  "request_sha256" text NOT NULL,
  "checked_at_ns" numeric(30,0) NOT NULL,
  "actor_id" text NOT NULL,
  "grant_id" text NOT NULL,
  "grant_version" text NOT NULL,
  "grant_revision" numeric(30,0),
  "decision" text NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "request_id", "checked_at_ns", "record_hash"),
  CONSTRAINT "vertex_model_use_proof_decision" CHECK ("decision" IN ('allowed','denied')),
  CONSTRAINT "vertex_model_use_proof_hashes" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_budget_reservations" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "job_id" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "request_sha256" text NOT NULL,
  "reservation_id" text NOT NULL,
  "operation" text NOT NULL,
  "input_bytes" numeric(30,0) NOT NULL,
  "input_tokens" numeric(30,0),
  "maximum_output_tokens" numeric(30,0) NOT NULL,
  "maximum_cost_usd" text NOT NULL,
  "token_charge" numeric(30,0) NOT NULL,
  "cost_charge_units" numeric(30,0) NOT NULL,
  "expires_at_ns" numeric(30,0) NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "job_id", "selection_id", "request_sha256"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_model_use_budget_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_model_use_budget_operation" CHECK ("operation" IN ('model-tokenize','model-completion')),
  CONSTRAINT "vertex_model_use_budget_bounds" CHECK ("input_bytes" >= 0 AND ("input_tokens" IS NULL OR "input_tokens" >= 0) AND "maximum_output_tokens" >= 0 AND "token_charge" >= 0 AND "cost_charge_units" >= 0),
  CONSTRAINT "vertex_model_use_budget_cost" CHECK ("maximum_cost_usd" ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'),
  CONSTRAINT "vertex_model_use_budget_hashes" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$' AND "request_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "vertex_model_use_reservation_id" ON "vertex_model_use_budget_reservations" ("account_alias", "environment", "reservation_id");
--> statement-breakpoint
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "window_id" text NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "request_id" text NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "grant_id" text NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "grant_version" text NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "lease_id" text NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "lease_epoch" numeric(30,0) NOT NULL;
ALTER TABLE "vertex_model_use_budget_reservations" ADD COLUMN "window_revision" numeric(30,0) NOT NULL;
--> statement-breakpoint
CREATE TABLE "vertex_model_use_budget_windows" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "window_id" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "policy_id" text NOT NULL,
  "policy_version" text NOT NULL,
  "policy_artifact_sha256" text NOT NULL,
  "period_id" text NOT NULL,
  "starts_at_ns" numeric(30,0) NOT NULL,
  "expires_at_ns" numeric(30,0) NOT NULL,
  "maximum_tokens" numeric(30,0) NOT NULL,
  "maximum_cost_units" numeric(30,0) NOT NULL,
  "reserved_tokens" numeric(30,0) NOT NULL,
  "reserved_cost_units" numeric(30,0) NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "window_id"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_model_use_window_bounds" CHECK ("reserved_tokens" >= 0 AND "reserved_tokens" <= "maximum_tokens" AND "reserved_cost_units" >= 0 AND "reserved_cost_units" <= "maximum_cost_units" AND "revision" > 0 AND "starts_at_ns" < "expires_at_ns")
);
CREATE UNIQUE INDEX "vertex_model_use_window_identity" ON "vertex_model_use_budget_windows" ("account_alias", "environment", "selection_id", "policy_id", "period_id");
--> statement-breakpoint
CREATE TABLE "vertex_model_use_attempt_identities" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "request_id" text NOT NULL,
  "request_sha256" text NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "request_id")
);
