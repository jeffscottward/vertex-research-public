-- Source-only hand SQL. NOT migratable until the integration owner reconciles
-- authoritative Drizzle snapshots/journal. No grants or consents are seeded.
CREATE TABLE notification_authority_versions (
  tenant_key text NOT NULL,
  account_alias text NOT NULL,
  environment text NOT NULL,
  record_kind text NOT NULL,
  authority_id text NOT NULL,
  version text NOT NULL,
  status text NOT NULL,
  recipient_key text NOT NULL,
  channel text NOT NULL,
  purpose text NOT NULL,
  binding_hash text NOT NULL,
  payload_hash text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  recorded_by text NOT NULL,
  recorded_at_ms bigint NOT NULL,
  valid_from_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  CONSTRAINT notification_authority_versions_pk PRIMARY KEY (tenant_key,account_alias,environment,record_kind,authority_id,version),
  CONSTRAINT notification_authority_versions_keys CHECK (
    tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND account_alias ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    AND authority_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' AND recipient_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    AND recorded_by ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  CONSTRAINT notification_authority_versions_scope CHECK (environment IN ('research','paper') AND record_kind IN ('consent','grant') AND channel IN ('phone','email') AND purpose IN ('market-alert','research-update','operational-alert')),
  CONSTRAINT notification_authority_versions_state CHECK (status IN ('granted','revoked') AND version ~ '^[1-9][0-9]{0,29}$'),
  CONSTRAINT notification_authority_versions_hashes CHECK (binding_hash ~ '^[0-9a-f]{64}$' AND payload_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_authority_versions_interval CHECK (recorded_at_ms BETWEEN 0 AND 253402300799999 AND valid_from_ms BETWEEN 0 AND 253402300799999 AND expires_at_ms BETWEEN 0 AND 253402300799999 AND valid_from_ms < expires_at_ms)
);
--> statement-breakpoint
CREATE TABLE notification_authority_current (
  tenant_key text NOT NULL,
  account_alias text NOT NULL,
  environment text NOT NULL,
  record_kind text NOT NULL,
  authority_id text NOT NULL,
  current_version text NOT NULL,
  CONSTRAINT notification_authority_current_pk PRIMARY KEY (tenant_key,account_alias,environment,record_kind,authority_id),
  CONSTRAINT notification_authority_current_version_fk FOREIGN KEY (tenant_key,account_alias,environment,record_kind,authority_id,current_version)
    REFERENCES notification_authority_versions (tenant_key,account_alias,environment,record_kind,authority_id,version)
);
CREATE INDEX notification_authority_current_scope ON notification_authority_current (tenant_key,account_alias,environment,record_kind);
