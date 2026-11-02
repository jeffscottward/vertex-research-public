-- Hand-authored additive source; not executed or generated. Register the journal
-- entry/snapshot only during the final controlled migration preparation phase.
-- Opaque server keys and neutral outcomes only; NO message/destination/secrets.
CREATE TABLE "notification_admissions" (
  "tenant_key" text NOT NULL,
  "recipient_key" text NOT NULL,
  "channel" text NOT NULL,
  "purpose" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "attempt_id" text NOT NULL,
  "acceptance" text NOT NULL,
  "admitted_at_ms" bigint NOT NULL,
  "expires_at_ms" bigint NOT NULL,
  "outcome_at_ms" bigint,
  CONSTRAINT "notification_admissions_pkey" PRIMARY KEY ("tenant_key", "recipient_key", "channel", "purpose", "idempotency_key"),
  CONSTRAINT "notification_admissions_keys_check" CHECK ("tenant_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND "recipient_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND "idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND "attempt_id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT "notification_admissions_channel_check" CHECK ("channel" IN ('phone', 'email')),
  CONSTRAINT "notification_admissions_purpose_check" CHECK ("purpose" IN ('market-alert', 'research-update', 'operational-alert')),
  CONSTRAINT "notification_admissions_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "notification_admissions_acceptance_check" CHECK ("acceptance" IN ('pending', 'accepted', 'rejected', 'unknown', 'not-sent')),
  CONSTRAINT "notification_admissions_time_check" CHECK ("admitted_at_ms" BETWEEN 0 AND 253402300799999 AND "expires_at_ms" BETWEEN 0 AND 253402300799999 AND "expires_at_ms" > "admitted_at_ms" AND "expires_at_ms" - "admitted_at_ms" <= 86400000),
  CONSTRAINT "notification_admissions_outcome_check" CHECK (("acceptance" = 'pending' AND "outcome_at_ms" IS NULL) OR ("acceptance" <> 'pending' AND "outcome_at_ms" IS NOT NULL AND "outcome_at_ms" BETWEEN "admitted_at_ms" AND 253402300799999))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_admissions_attempt_unique" ON "notification_admissions" ("tenant_key", "recipient_key", "channel", "attempt_id");
--> statement-breakpoint
CREATE TABLE "notification_cooldowns" (
  "tenant_key" text NOT NULL,
  "recipient_key" text NOT NULL,
  "channel" text NOT NULL,
  "last_attempt_at_ms" bigint NOT NULL,
  "cooldown_until_ms" bigint NOT NULL,
  CONSTRAINT "notification_cooldowns_pkey" PRIMARY KEY ("tenant_key", "recipient_key", "channel"),
  CONSTRAINT "notification_cooldowns_keys_check" CHECK ("tenant_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND "recipient_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT "notification_cooldowns_channel_check" CHECK ("channel" IN ('phone', 'email')),
  CONSTRAINT "notification_cooldowns_time_check" CHECK ("last_attempt_at_ms" BETWEEN 0 AND 253402300799999 AND "cooldown_until_ms" BETWEEN 0 AND 253402300799999 AND "cooldown_until_ms" - "last_attempt_at_ms" BETWEEN 1000 AND 604800000)
);
