-- Better Auth @better-auth/api-key 1.6.24 table for operator-issued agent API keys.
-- Columns mirror the plugin schema (packages/auth/generated/better-auth-schema.ts, table "apikey").
-- "key" stores the SHA-256 base64url hash only; plaintext keys are shown once and never stored.
-- Idempotent (IF NOT EXISTS) so it can be applied directly ahead of unapplied 0009-0013 and a later
-- full migrate is a no-op. No foreign key: the plugin schema has none; verification rejects keys whose
-- reference user is missing or inactive.
CREATE TABLE IF NOT EXISTS "apikey" (
  "id" text PRIMARY KEY NOT NULL,
  "config_id" text DEFAULT 'default' NOT NULL,
  "name" text,
  "start" text,
  "reference_id" text NOT NULL,
  "prefix" text,
  "key" text NOT NULL,
  "refill_interval" integer,
  "refill_amount" integer,
  "last_refill_at" timestamp with time zone,
  "enabled" boolean DEFAULT true,
  "rate_limit_enabled" boolean DEFAULT true,
  "rate_limit_time_window" integer DEFAULT 60000,
  "rate_limit_max" integer DEFAULT 600,
  "request_count" integer DEFAULT 0,
  "remaining" integer,
  "last_request" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "permissions" text,
  "metadata" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apikey_config_id_idx" ON "apikey" USING btree ("config_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apikey_reference_id_idx" ON "apikey" USING btree ("reference_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" USING btree ("key");
