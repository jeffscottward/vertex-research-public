-- Hand-authored additive Vertex substrate. No identity, audit, workflow or
-- inherited outbox table is changed. No extension/provider/engine is assumed
-- verified by this source. Exact nanosecond timestamps never pass through float.
CREATE TABLE vertex_accounts (
  account_id text PRIMARY KEY,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE vertex_account_aliases (
  account_alias text NOT NULL,
  environment text NOT NULL,
  account_id text NOT NULL REFERENCES vertex_accounts(account_id),
  created_at text NOT NULL,
  PRIMARY KEY(account_alias,environment),
  CONSTRAINT vertex_alias_environment CHECK(environment IN ('research','paper','live'))
);
--> statement-breakpoint
CREATE TABLE vertex_instruments (
  account_alias text NOT NULL, environment text NOT NULL,
  instrument_id text NOT NULL, observed_at text NOT NULL,
  PRIMARY KEY(account_alias,environment,instrument_id)
);
--> statement-breakpoint
CREATE TABLE vertex_rights_versions (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  policy_id text NOT NULL, version text NOT NULL, revision numeric(30,0) NOT NULL,
  status text NOT NULL, checked_at_ns numeric(30,0) NOT NULL,
  expires_at_ns numeric(30,0), retention_until_ns numeric(30,0),
  record_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_key,policy_id,version),
  CONSTRAINT vertex_rights_status CHECK(status IN ('granted','denied','expired','unknown'))
);
CREATE UNIQUE INDEX vertex_rights_revision ON vertex_rights_versions(account_alias,environment,collection_key,policy_id,revision);
--> statement-breakpoint
CREATE TABLE vertex_artifacts (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  artifact_id text NOT NULL, object_key text NOT NULL,
  artifact_sha256 text NOT NULL, source_content_sha256 text,
  byte_length numeric(30,0) NOT NULL, content_type text NOT NULL,
  contract_name text NOT NULL, schema_version text NOT NULL,
  rights_policy_id text NOT NULL, rights_version text NOT NULL,
  created_at text NOT NULL, created_at_ns numeric(30,0) NOT NULL,
  metadata_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,collection_key,rights_policy_id,rights_version)
    REFERENCES vertex_rights_versions(account_alias,environment,collection_key,policy_id,version),
  CONSTRAINT vertex_artifact_digest CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$' AND (source_content_sha256 IS NULL OR source_content_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT vertex_artifact_length CHECK(byte_length >= 0 AND byte_length <= 9007199254740991),
  CONSTRAINT vertex_artifact_schema CHECK(schema_version = '1.0.0')
);
CREATE INDEX vertex_artifact_object ON vertex_artifacts(account_alias,environment,object_key);
CREATE INDEX vertex_artifact_catalog ON vertex_artifacts(account_alias,environment,collection_key,contract_name,created_at_ns);
--> statement-breakpoint
CREATE TABLE vertex_artifact_lineage (
  account_alias text NOT NULL, environment text NOT NULL,
  artifact_id text NOT NULL, parent_artifact_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id,parent_artifact_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,parent_artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_collections (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  active_snapshot_id text, updated_at text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id)
);
--> statement-breakpoint
CREATE TABLE vertex_collection_generations (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, previous_snapshot_id text, request_hash text NOT NULL,
  idempotency_key text NOT NULL, shard_count integer NOT NULL, published_at text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id),
  FOREIGN KEY(account_alias,environment,collection_id) REFERENCES vertex_collections(account_alias,environment,collection_id),
  CONSTRAINT vertex_generation_shard_count CHECK(shard_count BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX vertex_collection_idempotency ON vertex_collection_generations(account_alias,environment,collection_id,idempotency_key);
--> statement-breakpoint
CREATE TABLE vertex_collection_shards (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, shard_ordinal integer NOT NULL,
  import_artifact_id text NOT NULL, import_artifact_sha256 text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,shard_ordinal),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id) REFERENCES vertex_collection_generations(account_alias,environment,collection_id,snapshot_id),
  FOREIGN KEY(account_alias,environment,import_artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
CREATE UNIQUE INDEX vertex_generation_shard_artifact ON vertex_collection_shards(account_alias,environment,collection_id,snapshot_id,import_artifact_id);
--> statement-breakpoint
CREATE TABLE vertex_source_identities (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, source_id text NOT NULL, provider text NOT NULL,
  source_snapshot_id text NOT NULL, content_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,source_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id) REFERENCES vertex_collection_generations(account_alias,environment,collection_id,snapshot_id)
);
--> statement-breakpoint
CREATE TABLE vertex_unavailable_sources (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, source_id text NOT NULL, reason text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,source_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id) REFERENCES vertex_collection_generations(account_alias,environment,collection_id,snapshot_id)
);
--> statement-breakpoint
CREATE TABLE vertex_duplicate_mappings (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, source_id text NOT NULL, canonical_source_id text NOT NULL, content_hash text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,source_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id,source_id) REFERENCES vertex_source_identities(account_alias,environment,collection_id,snapshot_id,source_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id,canonical_source_id) REFERENCES vertex_source_identities(account_alias,environment,collection_id,snapshot_id,source_id)
);
--> statement-breakpoint
CREATE TABLE vertex_records (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  contract_name text NOT NULL, record_id text NOT NULL, version text NOT NULL,
  artifact_id text NOT NULL, artifact_sha256 text NOT NULL,
  record_hash text NOT NULL, recorded_at text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_key,contract_name,record_id,version),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
CREATE UNIQUE INDEX vertex_record_artifact ON vertex_records(account_alias,environment,artifact_id);
--> statement-breakpoint
CREATE TABLE vertex_record_idempotency (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  record_id text NOT NULL, artifact_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_key,idempotency_key)
);
--> statement-breakpoint
CREATE TABLE vertex_record_relationships (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  related_artifact_id text NOT NULL, relationship text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id,related_artifact_id,relationship),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,related_artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_datasets (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  dataset_id text NOT NULL, artifact_id text NOT NULL, provider text NOT NULL,
  content_hash text NOT NULL, capture_time text NOT NULL, as_of_at text NOT NULL,
  storage_ref text NOT NULL, entitlement_policy_id text NOT NULL, retention_policy text NOT NULL,
  data_vintage_id text, data_vintage_status text NOT NULL,
  start_at_inclusive text NOT NULL, end_at_exclusive text NOT NULL, adjustment_method text NOT NULL, calendar text NOT NULL,
  PRIMARY KEY(account_alias,environment,dataset_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_dataset_sources (
  account_alias text NOT NULL, environment text NOT NULL, dataset_id text NOT NULL,
  source_ordinal integer NOT NULL, source_id text NOT NULL, source_snapshot_id text NOT NULL,
  provider text NOT NULL, content_hash text NOT NULL,
  PRIMARY KEY(account_alias,environment,dataset_id,source_ordinal),
  FOREIGN KEY(account_alias,environment,dataset_id) REFERENCES vertex_datasets(account_alias,environment,dataset_id)
);
--> statement-breakpoint
CREATE TABLE vertex_evidence (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, evidence_id text NOT NULL, artifact_id text NOT NULL,
  source_id text NOT NULL, content_hash text NOT NULL, claim text NOT NULL,
  method text NOT NULL, acceptance_status text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,evidence_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_claim_evidence (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, evidence_id text NOT NULL, source_id text NOT NULL, artifact_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,evidence_id),
  FOREIGN KEY(account_alias,environment,collection_id,evidence_id) REFERENCES vertex_evidence(account_alias,environment,collection_id,evidence_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id,source_id) REFERENCES vertex_source_identities(account_alias,environment,collection_id,snapshot_id,source_id)
);
--> statement-breakpoint
CREATE TABLE vertex_collection_datasets (
  account_alias text NOT NULL, environment text NOT NULL, collection_id text NOT NULL,
  snapshot_id text NOT NULL, dataset_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,collection_id,snapshot_id,dataset_id),
  FOREIGN KEY(account_alias,environment,collection_id,snapshot_id) REFERENCES vertex_collection_generations(account_alias,environment,collection_id,snapshot_id),
  FOREIGN KEY(account_alias,environment,dataset_id) REFERENCES vertex_datasets(account_alias,environment,dataset_id)
);
--> statement-breakpoint
CREATE TABLE vertex_reviews (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  review_id text NOT NULL, artifact_id text NOT NULL, artifact_sha256 text NOT NULL,
  actor_id text NOT NULL, policy_version text NOT NULL, strategy_version text NOT NULL,
  review_version text NOT NULL, decision text NOT NULL, purpose text NOT NULL,
  reviewed_at_ns numeric(30,0) NOT NULL, expires_at_ns numeric(30,0) NOT NULL,
  supersedes_review_id text, record_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,review_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_artifacts(account_alias,environment,artifact_id)
);
CREATE UNIQUE INDEX vertex_review_version ON vertex_reviews(account_alias,environment,artifact_id,purpose,review_version);
CREATE INDEX vertex_review_current ON vertex_reviews(account_alias,environment,artifact_id,purpose,reviewed_at_ns);
--> statement-breakpoint
CREATE TABLE vertex_paper_jobs (
  account_alias text NOT NULL, environment text NOT NULL, admission_id text NOT NULL,
  simulator_id text NOT NULL, review_id text NOT NULL, intent_id text NOT NULL,
  intent_sha256 text NOT NULL, portfolio_snapshot_id text NOT NULL,
  idempotency_key text NOT NULL, record_hash text NOT NULL, expires_at_ns numeric(30,0) NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,admission_id),
  FOREIGN KEY(account_alias,environment,review_id) REFERENCES vertex_reviews(account_alias,environment,review_id),
  CONSTRAINT vertex_paper_only CHECK(environment = 'paper')
);
CREATE UNIQUE INDEX vertex_paper_job_idempotency ON vertex_paper_jobs(account_alias,environment,idempotency_key);
--> statement-breakpoint
CREATE TABLE vertex_projection_heads (
  account_alias text NOT NULL, environment text NOT NULL, stream_id text NOT NULL,
  owner_epoch numeric(30,0) NOT NULL, high_water_sequence numeric(30,0) NOT NULL,
  high_water_event_hash text, last_occurred_at text, last_received_at text,
  expires_at_ns numeric(30,0), state text NOT NULL, received_sequence numeric(30,0),
  PRIMARY KEY(account_alias,environment,stream_id),
  CONSTRAINT vertex_projection_head_sequence CHECK(high_water_sequence >= 0 AND owner_epoch > 0)
);
--> statement-breakpoint
CREATE TABLE vertex_execution_projections (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  stream_id text NOT NULL, owner_epoch numeric(30,0) NOT NULL, sequence numeric(30,0) NOT NULL,
  event_hash text NOT NULL, previous_event_hash text, idempotency_key text NOT NULL,
  occurred_at text NOT NULL, received_at text NOT NULL, expires_at_ns numeric(30,0) NOT NULL,
  applied boolean NOT NULL, disposition text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  CONSTRAINT vertex_projection_sequence_positive CHECK(sequence > 0 AND owner_epoch > 0)
);
CREATE UNIQUE INDEX vertex_projection_sequence ON vertex_execution_projections(account_alias,environment,stream_id,owner_epoch,sequence);
CREATE UNIQUE INDEX vertex_projection_idempotency ON vertex_execution_projections(account_alias,environment,stream_id,idempotency_key);
--> statement-breakpoint
CREATE TABLE vertex_receipt_orders (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  submission_key text NOT NULL, intent_id text NOT NULL, broker_order_ref text,
  status text NOT NULL, total_quantity text NOT NULL, filled_quantity text NOT NULL,
  remaining_quantity text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_execution_projections(account_alias,environment,projection_id)
);
--> statement-breakpoint
-- Cumulative native-observed fills only. Public v1 contains no assignment event
-- or per-fill identity: do not manufacture either from cumulative quantities.
CREATE TABLE vertex_receipt_fills (
  account_alias text NOT NULL, environment text NOT NULL, projection_id text NOT NULL,
  submission_key text NOT NULL, cumulative_filled_quantity text NOT NULL, last_reconciled_at text NOT NULL,
  PRIMARY KEY(account_alias,environment,projection_id),
  FOREIGN KEY(account_alias,environment,projection_id) REFERENCES vertex_execution_projections(account_alias,environment,projection_id)
);
--> statement-breakpoint
CREATE TABLE vertex_portfolio_snapshots (
  account_alias text NOT NULL, environment text NOT NULL, snapshot_id text NOT NULL,
  stream_id text NOT NULL, owner_epoch numeric(30,0) NOT NULL, sequence numeric(30,0) NOT NULL,
  source_event_hash text NOT NULL, source_kind text NOT NULL,
  as_of_at_ns numeric(30,0) NOT NULL, received_at_ns numeric(30,0) NOT NULL,
  record_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(account_alias,environment,snapshot_id)
);
CREATE UNIQUE INDEX vertex_portfolio_sequence ON vertex_portfolio_snapshots(account_alias,environment,stream_id,owner_epoch,sequence);
CREATE INDEX vertex_portfolio_latest ON vertex_portfolio_snapshots(account_alias,environment,received_at_ns);
--> statement-breakpoint
CREATE TABLE vertex_portfolio_positions (
  account_alias text NOT NULL, environment text NOT NULL, snapshot_id text NOT NULL,
  instrument_id text NOT NULL, quantity text NOT NULL, market_value text, cost_basis text,
  currency text NOT NULL, price_as_of text, sleeve_id text,
  PRIMARY KEY(account_alias,environment,snapshot_id,instrument_id),
  FOREIGN KEY(account_alias,environment,snapshot_id) REFERENCES vertex_portfolio_snapshots(account_alias,environment,snapshot_id),
  FOREIGN KEY(account_alias,environment,instrument_id) REFERENCES vertex_instruments(account_alias,environment,instrument_id)
);
--> statement-breakpoint
CREATE TABLE vertex_portfolio_lots (
  account_alias text NOT NULL, environment text NOT NULL, snapshot_id text NOT NULL,
  lot_id text NOT NULL, instrument_id text NOT NULL, quantity text NOT NULL,
  unit_cost text NOT NULL, currency text NOT NULL, opened_at text NOT NULL, source_event_id text NOT NULL,
  PRIMARY KEY(account_alias,environment,snapshot_id,lot_id),
  FOREIGN KEY(account_alias,environment,snapshot_id) REFERENCES vertex_portfolio_snapshots(account_alias,environment,snapshot_id),
  FOREIGN KEY(account_alias,environment,instrument_id) REFERENCES vertex_instruments(account_alias,environment,instrument_id)
);
--> statement-breakpoint
CREATE TABLE vertex_reservation_observations (
  account_alias text NOT NULL, environment text NOT NULL, snapshot_id text NOT NULL,
  reservation_id text NOT NULL, submission_key text NOT NULL, instrument_id text,
  cash_amount text NOT NULL, share_quantity text NOT NULL, currency text NOT NULL,
  state text NOT NULL, source_event_id text NOT NULL, authoritative boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_alias,environment,snapshot_id,reservation_id),
  FOREIGN KEY(account_alias,environment,snapshot_id) REFERENCES vertex_portfolio_snapshots(account_alias,environment,snapshot_id),
  CONSTRAINT vertex_reservation_observation_only CHECK(authoritative = false)
);
--> statement-breakpoint
CREATE TABLE vertex_sleeve_observations (
  account_alias text NOT NULL, environment text NOT NULL, snapshot_id text NOT NULL,
  sleeve_id text NOT NULL, allocated_amount text NOT NULL, currency text NOT NULL,
  source_event_id text NOT NULL, authoritative boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_alias,environment,snapshot_id,sleeve_id),
  FOREIGN KEY(account_alias,environment,snapshot_id) REFERENCES vertex_portfolio_snapshots(account_alias,environment,snapshot_id),
  CONSTRAINT vertex_sleeve_observation_only CHECK(authoritative = false)
);
--> statement-breakpoint
CREATE TABLE vertex_outbox (
  account_alias text NOT NULL, environment text NOT NULL, collection_key text NOT NULL,
  event_id text NOT NULL, event_type text NOT NULL, idempotency_key text NOT NULL,
  record_hash text NOT NULL, payload jsonb NOT NULL, available_at_ns numeric(30,0) NOT NULL,
  lease_owner text, lease_fence numeric(30,0) NOT NULL DEFAULT 0,
  lease_expires_at text, lease_expires_at_ns numeric(30,0), published_at text, settlement_hash text,
  PRIMARY KEY(account_alias,environment,event_id),
  CONSTRAINT vertex_outbox_fence CHECK(lease_fence >= 0),
  CONSTRAINT vertex_outbox_lease CHECK((lease_owner IS NULL) = (lease_expires_at_ns IS NULL) AND (lease_expires_at IS NULL) = (lease_expires_at_ns IS NULL))
);
CREATE UNIQUE INDEX vertex_outbox_idempotency ON vertex_outbox(account_alias,environment,collection_key,idempotency_key);
CREATE INDEX vertex_outbox_due ON vertex_outbox(account_alias,environment,available_at_ns) WHERE published_at IS NULL;
--> statement-breakpoint
CREATE TABLE vertex_strategy_versions (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  strategy_id text NOT NULL, version text NOT NULL, sleeve text NOT NULL,
  code_digest text NOT NULL, maximum_loss text NOT NULL, maximum_notional text NOT NULL,
  maximum_positions numeric(30,0) NOT NULL, signal_calendar text NOT NULL, signal_interval text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_records(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_backtest_versions (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  run_id text NOT NULL, strategy_artifact_id text NOT NULL, seed numeric(30,0) NOT NULL,
  engine_version text NOT NULL, results_ref text, review_status text NOT NULL,
  validation_mode text NOT NULL, forward_sample_count numeric(30,0) NOT NULL,
  training_start text NOT NULL, training_end text NOT NULL, test_start text NOT NULL,
  test_end text NOT NULL, benchmark text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_records(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,strategy_artifact_id) REFERENCES vertex_strategy_versions(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_agent_versions (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  run_id text NOT NULL, agent_role text NOT NULL, task_contract text NOT NULL,
  model_version text, token_budget numeric(30,0) NOT NULL,
  cost_budget_usd text NOT NULL, status text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_records(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_module_versions (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  module_id text NOT NULL, version text NOT NULL, input_schema_version text NOT NULL,
  output_schema_version text NOT NULL, risk_policy_version text NOT NULL,
  artifact_digest text NOT NULL, lifecycle_state text NOT NULL, runtime text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_records(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_module_capabilities (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id,capability),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_module_versions(account_alias,environment,artifact_id)
);
--> statement-breakpoint
CREATE TABLE vertex_record_instruments (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  instrument_id text NOT NULL, relationship text NOT NULL,
  PRIMARY KEY(account_alias,environment,artifact_id,instrument_id,relationship),
  FOREIGN KEY(account_alias,environment,artifact_id) REFERENCES vertex_records(account_alias,environment,artifact_id),
  FOREIGN KEY(account_alias,environment,instrument_id) REFERENCES vertex_instruments(account_alias,environment,instrument_id)
);
