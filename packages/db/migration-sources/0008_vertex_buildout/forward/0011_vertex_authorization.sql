-- Source-only, hand-authored persistent exact grants. Content grants do not
-- confer grant-management privilege. No original table or grant is modified.
CREATE TABLE vertex_grant_bindings (
  account_alias text NOT NULL,
  environment text NOT NULL,
  grant_id text PRIMARY KEY,
  grantee_actor_id text NOT NULL,
  collection_key text NOT NULL,
  resource_id text NOT NULL,
  binding_hash text NOT NULL,
  payload jsonb NOT NULL,
  CONSTRAINT vertex_grant_environment CHECK(environment IN ('research','paper','live')),
  CONSTRAINT vertex_grant_binding_hash CHECK(binding_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX vertex_grant_binding_scope ON vertex_grant_bindings(account_alias,environment,grant_id);
CREATE INDEX vertex_grant_lookup ON vertex_grant_bindings(grantee_actor_id,account_alias,environment,collection_key,resource_id);
--> statement-breakpoint
CREATE TABLE vertex_grant_versions (
  account_alias text NOT NULL,
  environment text NOT NULL,
  grant_id text NOT NULL,
  version text NOT NULL,
  revision numeric(30,0) NOT NULL,
  status text NOT NULL,
  valid_from text NOT NULL,
  valid_from_ns numeric(30,0) NOT NULL,
  expires_at text NOT NULL,
  expires_at_ns numeric(30,0) NOT NULL,
  recorded_at text NOT NULL,
  recorded_at_ns numeric(30,0) NOT NULL,
  recorded_by_actor_id text NOT NULL,
  expected_version text,
  request_hash text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  CONSTRAINT vertex_grant_versions_pk PRIMARY KEY(account_alias,environment,grant_id,version),
  CONSTRAINT vertex_grant_version_binding_fk FOREIGN KEY(account_alias,environment,grant_id)
    REFERENCES vertex_grant_bindings(account_alias,environment,grant_id),
  CONSTRAINT vertex_grant_status CHECK(status IN ('granted','revoked')),
  CONSTRAINT vertex_grant_revision_positive CHECK(revision > 0),
  CONSTRAINT vertex_grant_interval CHECK(valid_from_ns < expires_at_ns),
  CONSTRAINT vertex_grant_version_hashes CHECK(record_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX vertex_grant_revision ON vertex_grant_versions(account_alias,environment,grant_id,revision);
--> statement-breakpoint
CREATE TABLE vertex_grant_actions (
  account_alias text NOT NULL,
  environment text NOT NULL,
  grant_id text NOT NULL,
  version text NOT NULL,
  action text NOT NULL,
  CONSTRAINT vertex_grant_actions_pk PRIMARY KEY(account_alias,environment,grant_id,version,action),
  CONSTRAINT vertex_grant_action_version_fk FOREIGN KEY(account_alias,environment,grant_id,version)
    REFERENCES vertex_grant_versions(account_alias,environment,grant_id,version),
  CONSTRAINT vertex_grant_action CHECK(action IN ('read','publish','review','admit-paper-simulation','project','manage-rights','dispatch-outbox'))
);
--> statement-breakpoint
CREATE TABLE vertex_grant_current (
  account_alias text NOT NULL,
  environment text NOT NULL,
  grant_id text NOT NULL,
  current_version text NOT NULL,
  revision numeric(30,0) NOT NULL,
  CONSTRAINT vertex_grant_current_pk PRIMARY KEY(account_alias,environment,grant_id),
  CONSTRAINT vertex_grant_current_version_fk FOREIGN KEY(account_alias,environment,grant_id,current_version)
    REFERENCES vertex_grant_versions(account_alias,environment,grant_id,version),
  CONSTRAINT vertex_grant_current_revision CHECK(revision > 0)
);
