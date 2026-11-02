-- SOURCE ONLY: pending Main's authoritative combined Drizzle history assembly.
-- Do not apply or add journal/snapshot metadata independently.
CREATE TABLE "vertex_policy_selections" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "issued_at_ns" numeric(30,0) NOT NULL,
  "expires_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "selection_id"),
  FOREIGN KEY ("account_alias", "environment") REFERENCES "vertex_account_aliases" ("account_alias", "environment"),
  CONSTRAINT "vertex_policy_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_policy_digest" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vertex_policy_window" CHECK ("revision" > 0 AND "issued_at_ns" < "expires_at_ns")
);
CREATE UNIQUE INDEX "vertex_policy_revision" ON "vertex_policy_selections" ("account_alias", "environment", "revision");
--> statement-breakpoint
CREATE TABLE "vertex_policy_heads" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "selection_id" text,
  "selection_sha256" text,
  "state" text NOT NULL,
  "updated_at" text NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_policy_head_state" CHECK ("state" IN ('disabled','active-read-only','draining')),
  CONSTRAINT "vertex_policy_head_identity" CHECK (("selection_id" IS NULL) = ("selection_sha256" IS NULL) AND ("state" = 'disabled' OR "selection_id" IS NOT NULL)),
  CONSTRAINT "vertex_policy_head_revision" CHECK ("revision" > 0),
  CONSTRAINT "vertex_policy_head_scope" CHECK ("environment" IN ('research','paper')),
  CONSTRAINT "vertex_policy_head_hash" CHECK ("record_hash" ~ '^[0-9a-f]{64}$' AND ("selection_sha256" IS NULL OR "selection_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_history" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "command_id" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "operation" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "actor_id" text NOT NULL,
  "request_sha256" text NOT NULL,
  "record_hash" text NOT NULL,
  "recorded_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "command_id"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_policy_history_operation" CHECK ("operation" IN ('stage','activate','rollback','drain','revoke','pin','release')),
  CONSTRAINT "vertex_policy_history_hashes" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$' AND "request_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vertex_policy_history_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "vertex_policy_history_revision" ON "vertex_policy_history" ("account_alias", "environment", "revision");
CREATE INDEX "vertex_policy_activation_history" ON "vertex_policy_history" ("account_alias", "environment", "selection_id", "operation");
--> statement-breakpoint
CREATE TABLE "vertex_policy_revocations" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "command_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "recorded_at_ns" numeric(30,0) NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "selection_id"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_policy_revocation_hashes" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_ownership_pins" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "holder_id" text NOT NULL,
  "holder_kind" text NOT NULL,
  "selection_id" text NOT NULL,
  "selection_sha256" text NOT NULL,
  "module_id" text NOT NULL,
  "module_version" text NOT NULL,
  "code_sha256" text NOT NULL,
  "owner_service_id" text NOT NULL,
  "owner_epoch" numeric(30,0) NOT NULL,
  "pinned_at_ns" numeric(30,0) NOT NULL,
  "released_at_ns" numeric(30,0),
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("account_alias", "environment", "holder_id"),
  FOREIGN KEY ("account_alias", "environment", "selection_id") REFERENCES "vertex_policy_selections" ("account_alias", "environment", "selection_id"),
  CONSTRAINT "vertex_policy_pin_kind" CHECK ("holder_kind" IN ('job','open-position')),
  CONSTRAINT "vertex_policy_pin_owner" CHECK ("owner_epoch" > 0),
  CONSTRAINT "vertex_policy_pin_time" CHECK ("released_at_ns" IS NULL OR "released_at_ns" >= "pinned_at_ns"),
  CONSTRAINT "vertex_policy_pin_hashes" CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$' AND "code_sha256" ~ '^[0-9a-f]{64}$' AND "record_hash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "vertex_policy_open_pins" ON "vertex_policy_ownership_pins" ("account_alias", "environment", "selection_id", "released_at_ns");
