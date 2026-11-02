-- 0008 Vertex buildout. Genuine generated declarations; source-only provenance is in ../migration-sources/0008_vertex_buildout/provenance.json. Apply through the transactional PostgreSQL migration runner.
CREATE TABLE "vertex_account_aliases" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vertex_account_aliases_account_alias_environment_pk" PRIMARY KEY("account_alias","environment"),
	CONSTRAINT "vertex_alias_environment" CHECK ("vertex_account_aliases"."environment" in ('research','paper','live'))
);
--> statement-breakpoint
CREATE TABLE "vertex_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vertex_agent_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_role" text NOT NULL,
	"task_contract" text NOT NULL,
	"model_version" text,
	"token_budget" numeric(30, 0) NOT NULL,
	"cost_budget_usd" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "vertex_agent_versions_account_alias_environment_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_artifact_lineage" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"parent_artifact_id" text NOT NULL,
	CONSTRAINT "vertex_artifact_lineage_account_alias_environment_artifact_id_parent_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id","parent_artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_artifacts" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"artifact_id" text NOT NULL,
	"object_key" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"source_content_sha256" text,
	"byte_length" numeric(30, 0) NOT NULL,
	"content_type" text NOT NULL,
	"contract_name" text NOT NULL,
	"schema_version" text NOT NULL,
	"rights_policy_id" text NOT NULL,
	"rights_version" text NOT NULL,
	"created_at" text NOT NULL,
	"created_at_ns" numeric(30, 0) NOT NULL,
	"metadata_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_artifacts_account_alias_environment_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id"),
	CONSTRAINT "vertex_artifact_digest" CHECK ("vertex_artifacts"."artifact_sha256" ~ '^[0-9a-f]{64}$' and ("vertex_artifacts"."source_content_sha256" is null or "vertex_artifacts"."source_content_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "vertex_artifact_length" CHECK ("vertex_artifacts"."byte_length" >= 0 and "vertex_artifacts"."byte_length" <= 9007199254740991),
	CONSTRAINT "vertex_artifact_schema" CHECK ("vertex_artifacts"."schema_version" = '1.0.0')
);
--> statement-breakpoint
CREATE TABLE "vertex_backtest_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"run_id" text NOT NULL,
	"strategy_artifact_id" text NOT NULL,
	"seed" numeric(30, 0) NOT NULL,
	"engine_version" text NOT NULL,
	"results_ref" text,
	"review_status" text NOT NULL,
	"validation_mode" text NOT NULL,
	"forward_sample_count" numeric(30, 0) NOT NULL,
	"training_start" text NOT NULL,
	"training_end" text NOT NULL,
	"test_start" text NOT NULL,
	"test_end" text NOT NULL,
	"benchmark" text NOT NULL,
	CONSTRAINT "vertex_backtest_versions_pkey" PRIMARY KEY("account_alias","environment","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_claim_evidence" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"source_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	CONSTRAINT "vertex_claim_evidence_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_collection_datasets" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	CONSTRAINT "vertex_collection_datasets_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","dataset_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_collection_generations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"previous_snapshot_id" text,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"shard_count" integer NOT NULL,
	"published_at" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_collection_generations_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id"),
	CONSTRAINT "vertex_generation_shard_count" CHECK ("vertex_collection_generations"."shard_count" between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "vertex_collection_shards" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"shard_ordinal" integer NOT NULL,
	"import_artifact_id" text NOT NULL,
	"import_artifact_sha256" text NOT NULL,
	CONSTRAINT "vertex_collection_shards_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","shard_ordinal")
);
--> statement-breakpoint
CREATE TABLE "vertex_collections" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"active_snapshot_id" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "vertex_collections_account_alias_environment_collection_id_pk" PRIMARY KEY("account_alias","environment","collection_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_dataset_sources" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"dataset_id" text NOT NULL,
	"source_ordinal" integer NOT NULL,
	"source_id" text NOT NULL,
	"source_snapshot_id" text NOT NULL,
	"provider" text NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "vertex_dataset_sources_account_alias_environment_dataset_id_source_ordinal_pk" PRIMARY KEY("account_alias","environment","dataset_id","source_ordinal")
);
--> statement-breakpoint
CREATE TABLE "vertex_datasets" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"dataset_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"provider" text NOT NULL,
	"content_hash" text NOT NULL,
	"capture_time" text NOT NULL,
	"as_of_at" text NOT NULL,
	"storage_ref" text NOT NULL,
	"entitlement_policy_id" text NOT NULL,
	"retention_policy" text NOT NULL,
	"data_vintage_id" text,
	"data_vintage_status" text NOT NULL,
	"start_at_inclusive" text NOT NULL,
	"end_at_exclusive" text NOT NULL,
	"adjustment_method" text NOT NULL,
	"calendar" text NOT NULL,
	CONSTRAINT "vertex_datasets_account_alias_environment_dataset_id_pk" PRIMARY KEY("account_alias","environment","dataset_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_duplicate_mappings" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_id" text NOT NULL,
	"canonical_source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "vertex_duplicate_mappings_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_evidence" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"claim" text NOT NULL,
	"method" text NOT NULL,
	"acceptance_status" text NOT NULL,
	CONSTRAINT "vertex_evidence_account_alias_environment_collection_id_evidence_id_pk" PRIMARY KEY("account_alias","environment","collection_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_execution_projections" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"sequence" numeric(30, 0) NOT NULL,
	"event_hash" text NOT NULL,
	"previous_event_hash" text,
	"idempotency_key" text NOT NULL,
	"occurred_at" text NOT NULL,
	"received_at" text NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"applied" boolean NOT NULL,
	"disposition" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_execution_projections_account_alias_environment_projection_id_pk" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_projection_sequence_positive" CHECK ("vertex_execution_projections"."sequence" > 0 and "vertex_execution_projections"."owner_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "vertex_instruments" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"instrument_id" text NOT NULL,
	"observed_at" text NOT NULL,
	CONSTRAINT "vertex_instruments_account_alias_environment_instrument_id_pk" PRIMARY KEY("account_alias","environment","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_module_capabilities" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "vertex_module_capabilities_pkey" PRIMARY KEY("account_alias","environment","artifact_id","capability")
);
--> statement-breakpoint
CREATE TABLE "vertex_module_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"module_id" text NOT NULL,
	"version" text NOT NULL,
	"input_schema_version" text NOT NULL,
	"output_schema_version" text NOT NULL,
	"risk_policy_version" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"runtime" text NOT NULL,
	CONSTRAINT "vertex_module_versions_account_alias_environment_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_outbox" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at_ns" numeric(30, 0) NOT NULL,
	"lease_owner" text,
	"lease_fence" numeric(30, 0) DEFAULT '0' NOT NULL,
	"lease_expires_at" text,
	"lease_expires_at_ns" numeric(30, 0),
	"published_at" text,
	"settlement_hash" text,
	CONSTRAINT "vertex_outbox_account_alias_environment_event_id_pk" PRIMARY KEY("account_alias","environment","event_id"),
	CONSTRAINT "vertex_outbox_fence" CHECK ("vertex_outbox"."lease_fence" >= 0),
	CONSTRAINT "vertex_outbox_lease" CHECK (("vertex_outbox"."lease_owner" is null) = ("vertex_outbox"."lease_expires_at_ns" is null) and ("vertex_outbox"."lease_expires_at" is null) = ("vertex_outbox"."lease_expires_at_ns" is null))
);
--> statement-breakpoint
CREATE TABLE "vertex_paper_jobs" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"admission_id" text NOT NULL,
	"simulator_id" text NOT NULL,
	"review_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"intent_sha256" text NOT NULL,
	"portfolio_snapshot_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"record_hash" text NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_paper_jobs_account_alias_environment_admission_id_pk" PRIMARY KEY("account_alias","environment","admission_id"),
	CONSTRAINT "vertex_paper_only" CHECK ("vertex_paper_jobs"."environment" = 'paper')
);
--> statement-breakpoint
CREATE TABLE "vertex_portfolio_lots" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"quantity" text NOT NULL,
	"unit_cost" text NOT NULL,
	"currency" text NOT NULL,
	"opened_at" text NOT NULL,
	"source_event_id" text NOT NULL,
	CONSTRAINT "vertex_portfolio_lots_account_alias_environment_snapshot_id_lot_id_pk" PRIMARY KEY("account_alias","environment","snapshot_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_portfolio_positions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"quantity" text NOT NULL,
	"market_value" text,
	"cost_basis" text,
	"currency" text NOT NULL,
	"price_as_of" text,
	"sleeve_id" text,
	CONSTRAINT "vertex_portfolio_positions_pkey" PRIMARY KEY("account_alias","environment","snapshot_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_portfolio_snapshots" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"sequence" numeric(30, 0) NOT NULL,
	"source_event_hash" text NOT NULL,
	"source_kind" text NOT NULL,
	"as_of_at_ns" numeric(30, 0) NOT NULL,
	"received_at_ns" numeric(30, 0) NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_portfolio_snapshots_account_alias_environment_snapshot_id_pk" PRIMARY KEY("account_alias","environment","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_projection_heads" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"stream_id" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"high_water_sequence" numeric(30, 0) NOT NULL,
	"high_water_event_hash" text,
	"last_occurred_at" text,
	"last_received_at" text,
	"expires_at_ns" numeric(30, 0),
	"state" text NOT NULL,
	"received_sequence" numeric(30, 0),
	CONSTRAINT "vertex_projection_heads_account_alias_environment_stream_id_pk" PRIMARY KEY("account_alias","environment","stream_id"),
	CONSTRAINT "vertex_projection_head_sequence" CHECK ("vertex_projection_heads"."high_water_sequence" >= 0 and "vertex_projection_heads"."owner_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "vertex_receipt_fills" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"submission_key" text NOT NULL,
	"cumulative_filled_quantity" text NOT NULL,
	"last_reconciled_at" text NOT NULL,
	CONSTRAINT "vertex_receipt_fills_account_alias_environment_projection_id_pk" PRIMARY KEY("account_alias","environment","projection_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_receipt_orders" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"submission_key" text NOT NULL,
	"intent_id" text NOT NULL,
	"broker_order_ref" text,
	"status" text NOT NULL,
	"total_quantity" text NOT NULL,
	"filled_quantity" text NOT NULL,
	"remaining_quantity" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_receipt_orders_account_alias_environment_projection_id_pk" PRIMARY KEY("account_alias","environment","projection_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_record_idempotency" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"record_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	CONSTRAINT "vertex_record_idempotency_account_alias_environment_collection_key_idempotency_key_pk" PRIMARY KEY("account_alias","environment","collection_key","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "vertex_record_instruments" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"relationship" text NOT NULL,
	CONSTRAINT "vertex_record_instruments_pkey" PRIMARY KEY("account_alias","environment","artifact_id","instrument_id","relationship")
);
--> statement-breakpoint
CREATE TABLE "vertex_record_relationships" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"related_artifact_id" text NOT NULL,
	"relationship" text NOT NULL,
	CONSTRAINT "vertex_record_relationships_pkey" PRIMARY KEY("account_alias","environment","artifact_id","related_artifact_id","relationship")
);
--> statement-breakpoint
CREATE TABLE "vertex_records" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"contract_name" text NOT NULL,
	"record_id" text NOT NULL,
	"version" text NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"record_hash" text NOT NULL,
	"recorded_at" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_records_account_alias_environment_collection_key_contract_name_record_id_version_pk" PRIMARY KEY("account_alias","environment","collection_key","contract_name","record_id","version")
);
--> statement-breakpoint
CREATE TABLE "vertex_reservation_observations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"submission_key" text NOT NULL,
	"instrument_id" text,
	"cash_amount" text NOT NULL,
	"share_quantity" text NOT NULL,
	"currency" text NOT NULL,
	"state" text NOT NULL,
	"source_event_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vertex_reservation_observations_pkey" PRIMARY KEY("account_alias","environment","snapshot_id","reservation_id"),
	CONSTRAINT "vertex_reservation_observation_only" CHECK ("vertex_reservation_observations"."authoritative" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_reviews" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"review_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"actor_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"strategy_version" text NOT NULL,
	"review_version" text NOT NULL,
	"decision" text NOT NULL,
	"purpose" text NOT NULL,
	"reviewed_at_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"supersedes_review_id" text,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_reviews_account_alias_environment_review_id_pk" PRIMARY KEY("account_alias","environment","review_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_rights_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"policy_id" text NOT NULL,
	"version" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"status" text NOT NULL,
	"checked_at_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0),
	"retention_until_ns" numeric(30, 0),
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_rights_versions_account_alias_environment_collection_key_policy_id_version_pk" PRIMARY KEY("account_alias","environment","collection_key","policy_id","version"),
	CONSTRAINT "vertex_rights_status" CHECK ("vertex_rights_versions"."status" in ('granted','denied','expired','unknown'))
);
--> statement-breakpoint
CREATE TABLE "vertex_sleeve_observations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"sleeve_id" text NOT NULL,
	"allocated_amount" text NOT NULL,
	"currency" text NOT NULL,
	"source_event_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vertex_sleeve_observations_pkey" PRIMARY KEY("account_alias","environment","snapshot_id","sleeve_id"),
	CONSTRAINT "vertex_sleeve_observation_only" CHECK ("vertex_sleeve_observations"."authoritative" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_source_identities" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_id" text NOT NULL,
	"provider" text NOT NULL,
	"source_snapshot_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_source_identities_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_strategy_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"version" text NOT NULL,
	"sleeve" text NOT NULL,
	"code_digest" text NOT NULL,
	"maximum_loss" text NOT NULL,
	"maximum_notional" text NOT NULL,
	"maximum_positions" numeric(30, 0) NOT NULL,
	"signal_calendar" text NOT NULL,
	"signal_interval" text NOT NULL,
	CONSTRAINT "vertex_strategy_versions_pkey" PRIMARY KEY("account_alias","environment","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_unavailable_sources" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "vertex_unavailable_sources_pkey" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id","source_id")
);
--> statement-breakpoint
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
	CONSTRAINT "notification_admissions_pkey" PRIMARY KEY("tenant_key","recipient_key","channel","purpose","idempotency_key"),
	CONSTRAINT "notification_admissions_keys_check" CHECK ("notification_admissions"."tenant_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_admissions"."recipient_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_admissions"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_admissions"."attempt_id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
	CONSTRAINT "notification_admissions_channel_check" CHECK ("notification_admissions"."channel" in ('phone', 'email')),
	CONSTRAINT "notification_admissions_purpose_check" CHECK ("notification_admissions"."purpose" in ('market-alert', 'research-update', 'operational-alert')),
	CONSTRAINT "notification_admissions_fingerprint_check" CHECK ("notification_admissions"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "notification_admissions_acceptance_check" CHECK ("notification_admissions"."acceptance" in ('pending', 'accepted', 'rejected', 'unknown', 'not-sent')),
	CONSTRAINT "notification_admissions_time_check" CHECK ("notification_admissions"."admitted_at_ms" between 0 and 253402300799999 and "notification_admissions"."expires_at_ms" between 0 and 253402300799999 and "notification_admissions"."expires_at_ms" > "notification_admissions"."admitted_at_ms" and "notification_admissions"."expires_at_ms" - "notification_admissions"."admitted_at_ms" <= 86400000),
	CONSTRAINT "notification_admissions_outcome_check" CHECK (("notification_admissions"."acceptance" = 'pending' and "notification_admissions"."outcome_at_ms" is null) or ("notification_admissions"."acceptance" <> 'pending' and "notification_admissions"."outcome_at_ms" is not null and "notification_admissions"."outcome_at_ms" between "notification_admissions"."admitted_at_ms" and 253402300799999))
);
--> statement-breakpoint
CREATE TABLE "notification_cooldowns" (
	"tenant_key" text NOT NULL,
	"recipient_key" text NOT NULL,
	"channel" text NOT NULL,
	"last_attempt_at_ms" bigint NOT NULL,
	"cooldown_until_ms" bigint NOT NULL,
	CONSTRAINT "notification_cooldowns_pkey" PRIMARY KEY("tenant_key","recipient_key","channel"),
	CONSTRAINT "notification_cooldowns_keys_check" CHECK ("notification_cooldowns"."tenant_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_cooldowns"."recipient_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
	CONSTRAINT "notification_cooldowns_channel_check" CHECK ("notification_cooldowns"."channel" in ('phone', 'email')),
	CONSTRAINT "notification_cooldowns_time_check" CHECK ("notification_cooldowns"."last_attempt_at_ms" between 0 and 253402300799999 and "notification_cooldowns"."cooldown_until_ms" between 0 and 253402300799999 and "notification_cooldowns"."cooldown_until_ms" - "notification_cooldowns"."last_attempt_at_ms" between 1000 and 604800000)
);
--> statement-breakpoint
CREATE TABLE "vertex_object_metadata" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_key" text NOT NULL,
	"object_key" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text,
	"checksum" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "vertex_object_metadata_pkey" PRIMARY KEY("account_alias","environment","collection_key","object_key"),
	CONSTRAINT "vertex_object_metadata_scope_check" CHECK ("vertex_object_metadata"."account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "vertex_object_metadata"."environment" in ('research', 'paper', 'live') and ("vertex_object_metadata"."collection_key" = '' or "vertex_object_metadata"."collection_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')),
	CONSTRAINT "vertex_object_metadata_kind_check" CHECK ("vertex_object_metadata"."kind" in ('manifest', 'content')),
	CONSTRAINT "vertex_object_metadata_digest_check" CHECK ("vertex_object_metadata"."digest" ~ '^[0-9a-f]{64}$' and ("vertex_object_metadata"."checksum" is null or "vertex_object_metadata"."checksum" = "vertex_object_metadata"."digest")),
	CONSTRAINT "vertex_object_metadata_size_check" CHECK ("vertex_object_metadata"."size" between 1 and 9007199254740991 and ("vertex_object_metadata"."kind" <> 'manifest' or "vertex_object_metadata"."size" <= 1048576)),
	CONSTRAINT "vertex_object_metadata_key_check" CHECK (octet_length("vertex_object_metadata"."object_key") <= 1024 and "vertex_object_metadata"."object_key" like 'vertex/v1/%'),
	CONSTRAINT "vertex_object_metadata_type_check" CHECK ("vertex_object_metadata"."content_type" is null or octet_length("vertex_object_metadata"."content_type") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "vertex_grant_actions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"version" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "vertex_grant_actions_pk" PRIMARY KEY("account_alias","environment","grant_id","version","action"),
	CONSTRAINT "vertex_grant_action" CHECK ("vertex_grant_actions"."action" in ('read','publish','review','admit-paper-simulation','project','manage-rights','dispatch-outbox'))
);
--> statement-breakpoint
CREATE TABLE "vertex_grant_bindings" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text PRIMARY KEY NOT NULL,
	"grantee_actor_id" text NOT NULL,
	"collection_key" text NOT NULL,
	"resource_id" text NOT NULL,
	"binding_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_grant_environment" CHECK ("vertex_grant_bindings"."environment" in ('research','paper','live')),
	CONSTRAINT "vertex_grant_binding_hash" CHECK ("vertex_grant_bindings"."binding_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_grant_current" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"current_version" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_grant_current_pk" PRIMARY KEY("account_alias","environment","grant_id"),
	CONSTRAINT "vertex_grant_current_revision" CHECK ("vertex_grant_current"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "vertex_grant_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"version" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"status" text NOT NULL,
	"valid_from" text NOT NULL,
	"valid_from_ns" numeric(30, 0) NOT NULL,
	"expires_at" text NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"recorded_at" text NOT NULL,
	"recorded_at_ns" numeric(30, 0) NOT NULL,
	"recorded_by_actor_id" text NOT NULL,
	"expected_version" text,
	"request_hash" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_grant_versions_pk" PRIMARY KEY("account_alias","environment","grant_id","version"),
	CONSTRAINT "vertex_grant_status" CHECK ("vertex_grant_versions"."status" in ('granted','revoked')),
	CONSTRAINT "vertex_grant_revision_positive" CHECK ("vertex_grant_versions"."revision" > 0),
	CONSTRAINT "vertex_grant_interval" CHECK ("vertex_grant_versions"."valid_from_ns" < "vertex_grant_versions"."expires_at_ns"),
	CONSTRAINT "vertex_grant_version_hashes" CHECK ("vertex_grant_versions"."record_hash" ~ '^[0-9a-f]{64}$' and "vertex_grant_versions"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_command_receipts" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"command" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"result_hash" text NOT NULL,
	"collection_key" text NOT NULL,
	"target_artifact_id" text,
	"review_id" text,
	"admission_id" text,
	"committed_at" text NOT NULL,
	"committed_at_ns" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_command_receipts_pk" PRIMARY KEY("account_alias","environment","actor_id","kind","idempotency_key"),
	CONSTRAINT "vertex_command_kind" CHECK ("vertex_command_receipts"."kind" in ('review','research','simulation')),
	CONSTRAINT "vertex_command_hashes" CHECK ("vertex_command_receipts"."request_hash" ~ '^[0-9a-f]{64}$' and "vertex_command_receipts"."result_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_research_proposal_evidence" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"ordinal" numeric(2, 0) NOT NULL,
	"evidence_id" text NOT NULL,
	"evidence_artifact_id" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	CONSTRAINT "vertex_research_proposal_evidence_pk" PRIMARY KEY("account_alias","environment","artifact_id","evidence_id"),
	CONSTRAINT "vertex_proposal_evidence_ordinal_bound" CHECK ("vertex_research_proposal_evidence"."ordinal" between 0 and 31)
);
--> statement-breakpoint
CREATE TABLE "vertex_research_proposals" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"question" text NOT NULL,
	"role" text NOT NULL,
	"proposal_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"committed_at" text NOT NULL,
	"committed_at_ns" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_research_proposals_pk" PRIMARY KEY("account_alias","environment","artifact_id"),
	CONSTRAINT "vertex_research_question" CHECK (length("vertex_research_proposals"."question") between 1 and 2000),
	CONSTRAINT "vertex_research_role" CHECK ("vertex_research_proposals"."role" in ('research','paper-to-strategy','backtest-review','knowledge-import'))
);
--> statement-breakpoint
CREATE TABLE "vertex_reviewed_artifact_links" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"review_id" text NOT NULL,
	"collection_key" text NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"committed_at" text NOT NULL,
	"committed_at_ns" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_reviewed_artifact_links_pk" PRIMARY KEY("account_alias","environment","review_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_native_checkpoints" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"snapshot_id" text NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"journal_sequence" numeric(30, 0) NOT NULL,
	"journal_head_hash" text NOT NULL,
	CONSTRAINT "vertex_native_checkpoints_pkey" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_checkpoint_identity" CHECK ("vertex_native_checkpoints"."journal_sequence" > 0 and "vertex_native_checkpoints"."snapshot_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_checkpoints"."journal_head_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_native_checkpoint_observation" CHECK ("vertex_native_checkpoints"."authoritative" = false and "vertex_native_checkpoints"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_corporate_actions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"action_id" text NOT NULL,
	"old_instrument_id" text NOT NULL,
	"new_instrument_id" text NOT NULL,
	"quantity_numerator" numeric(30, 0) NOT NULL,
	"quantity_denominator" numeric(30, 0) NOT NULL,
	"previous_quantity" text NOT NULL,
	"new_quantity" text NOT NULL,
	"cash_delta" text NOT NULL,
	"currency" text NOT NULL,
	"previous_qualification_sha256" text NOT NULL,
	"replacement_qualification_sha256" text NOT NULL,
	CONSTRAINT "vertex_native_corporate_actions_pkey" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_corporate_ratio" CHECK ("vertex_native_corporate_actions"."quantity_numerator" > 0 and "vertex_native_corporate_actions"."quantity_denominator" > 0),
	CONSTRAINT "vertex_native_corporate_digests" CHECK ("vertex_native_corporate_actions"."previous_qualification_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_corporate_actions"."replacement_qualification_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_native_corporate_observation" CHECK ("vertex_native_corporate_actions"."authoritative" = false and "vertex_native_corporate_actions"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_fact_projections" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"stream_id" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"sequence" numeric(30, 0) NOT NULL,
	"event_hash" text NOT NULL,
	"previous_event_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" text NOT NULL,
	"received_at" text NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"applied" boolean NOT NULL,
	"disposition" text NOT NULL,
	"fact_kind" text NOT NULL,
	"proof_artifact_id" text NOT NULL,
	"proof_sha256" text NOT NULL,
	"proof_source_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"proof_journal_sequence" numeric(30, 0) NOT NULL,
	"proof_journal_head_hash" text NOT NULL,
	"fact_ordinal" integer NOT NULL,
	CONSTRAINT "vertex_native_fact_projections_account_alias_environment_projection_id_pk" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_fact_journal_shape" CHECK ("vertex_native_fact_projections"."proof_journal_sequence" > 0 and "vertex_native_fact_projections"."proof_journal_head_hash" ~ '^[0-9a-f]{64}$' and "vertex_native_fact_projections"."fact_ordinal" between 0 and 63),
	CONSTRAINT "vertex_native_fact_sequence_positive" CHECK ("vertex_native_fact_projections"."sequence" >= 2 and "vertex_native_fact_projections"."owner_epoch" > 0),
	CONSTRAINT "vertex_native_fact_digest" CHECK ("vertex_native_fact_projections"."event_hash" ~ '^[0-9a-f]{64}$' and "vertex_native_fact_projections"."previous_event_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_native_fact_kind" CHECK ("vertex_native_fact_projections"."fact_kind" in ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state')),
	CONSTRAINT "vertex_native_fact_disposition" CHECK ("vertex_native_fact_projections"."disposition" in ('applied','stale','gap','epoch-mismatch') and ("vertex_native_fact_projections"."applied" = ("vertex_native_fact_projections"."disposition" in ('applied','stale')))),
	CONSTRAINT "vertex_native_fact_observation" CHECK ("vertex_native_fact_projections"."environment" = 'paper' and "vertex_native_fact_projections"."authoritative" = false and "vertex_native_fact_projections"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_journal_proofs" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"source_event_id" text NOT NULL,
	"occurred_at" text NOT NULL,
	"event_type" text NOT NULL,
	"journal_sequence" numeric(30, 0) NOT NULL,
	"journal_head_hash" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"canonical_json" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fact_ordinal" integer NOT NULL,
	CONSTRAINT "vertex_native_journal_proofs_account_alias_environment_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id"),
	CONSTRAINT "vertex_native_proof_ordinal" CHECK ("vertex_native_journal_proofs"."fact_ordinal" between 0 and 63),
	CONSTRAINT "vertex_native_proof_paper" CHECK ("vertex_native_journal_proofs"."environment" = 'paper'),
	CONSTRAINT "vertex_native_proof_size" CHECK ("vertex_native_journal_proofs"."byte_length" between 1 and 1048576 and octet_length("vertex_native_journal_proofs"."canonical_json") = "vertex_native_journal_proofs"."byte_length"),
	CONSTRAINT "vertex_native_proof_digest" CHECK ("vertex_native_journal_proofs"."sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_journal_proofs"."journal_head_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_native_proof_sequence" CHECK ("vertex_native_journal_proofs"."owner_epoch" > 0 and "vertex_native_journal_proofs"."journal_sequence" > 0),
	CONSTRAINT "vertex_native_proof_kind" CHECK ("vertex_native_journal_proofs"."event_type" in ('checkpoint','cash-settlement','assignment','exercise','option-expiry','corporate-action','reconciliation','kill-state'))
);
--> statement-breakpoint
CREATE TABLE "vertex_native_kill_reasons" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"reason_ordinal" integer NOT NULL,
	"reason_code" text NOT NULL,
	CONSTRAINT "vertex_native_kill_reasons_pkey" PRIMARY KEY("account_alias","environment","projection_id","reason_ordinal"),
	CONSTRAINT "vertex_native_kill_reason_bound" CHECK ("vertex_native_kill_reasons"."reason_ordinal" between 0 and 63)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_kill_states" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"action" text NOT NULL,
	"grant_id" text,
	CONSTRAINT "vertex_native_kill_states_pkey" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_kill_action" CHECK ("vertex_native_kill_states"."action" in ('pause-new-risk','reset-new-risk','reconcile-required') and ("vertex_native_kill_states"."action" <> 'reset-new-risk' or "vertex_native_kill_states"."grant_id" is not null)),
	CONSTRAINT "vertex_native_kill_observation" CHECK ("vertex_native_kill_states"."authoritative" = false and "vertex_native_kill_states"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_reconciliations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"reconciliation_id" text NOT NULL,
	"observed_snapshot_id" text NOT NULL,
	"unknown_count" integer NOT NULL,
	"reconciled" boolean NOT NULL,
	CONSTRAINT "vertex_native_reconciliations_pkey" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_reconciliation_count" CHECK ("vertex_native_reconciliations"."unknown_count" between 0 and 10000 and ("vertex_native_reconciliations"."reconciled" = false or "vertex_native_reconciliations"."unknown_count" = 0)),
	CONSTRAINT "vertex_native_reconciliation_observation" CHECK ("vertex_native_reconciliations"."authoritative" = false and "vertex_native_reconciliations"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_settlement_sources" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"source_ordinal" integer NOT NULL,
	"source_event_id" text NOT NULL,
	CONSTRAINT "vertex_native_settlement_sources_pkey" PRIMARY KEY("account_alias","environment","projection_id","source_ordinal"),
	CONSTRAINT "vertex_native_settlement_source_bound" CHECK ("vertex_native_settlement_sources"."source_ordinal" between 0 and 511)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_settlements" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"projection_id" text NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"fact_kind" text NOT NULL,
	"settlement_id" text NOT NULL,
	"settlement_state" text NOT NULL,
	"instrument_id" text,
	"underlying_id" text,
	"settlement_kind" text,
	"quantity" text,
	"currency" text NOT NULL,
	"cash_delta" text NOT NULL,
	"share_delta" text,
	"due_at" text,
	"due_at_ns" numeric(30, 0),
	"occurred_at_ns" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_native_settlements_pkey" PRIMARY KEY("account_alias","environment","projection_id"),
	CONSTRAINT "vertex_native_settlement_shape" CHECK (("vertex_native_settlements"."fact_kind" = 'cash-settlement' and "vertex_native_settlements"."settlement_state" = 'settled' and "vertex_native_settlements"."instrument_id" is null and "vertex_native_settlements"."underlying_id" is null and "vertex_native_settlements"."settlement_kind" is null and "vertex_native_settlements"."quantity" is null and "vertex_native_settlements"."share_delta" is null and "vertex_native_settlements"."due_at" is null and "vertex_native_settlements"."due_at_ns" is null) or ("vertex_native_settlements"."fact_kind" in ('assignment','exercise','option-expiry') and "vertex_native_settlements"."settlement_state" in ('pending','settled') and "vertex_native_settlements"."instrument_id" is not null and "vertex_native_settlements"."underlying_id" is not null and "vertex_native_settlements"."instrument_id" <> "vertex_native_settlements"."underlying_id" and "vertex_native_settlements"."settlement_kind" is not null and "vertex_native_settlements"."settlement_kind" in ('cash','physical') and "vertex_native_settlements"."quantity" is not null and "vertex_native_settlements"."share_delta" is not null and "vertex_native_settlements"."due_at" is not null and "vertex_native_settlements"."due_at_ns" is not null)),
	CONSTRAINT "vertex_native_settlement_due" CHECK ("vertex_native_settlements"."settlement_state" <> 'settled' or "vertex_native_settlements"."due_at_ns" is null or "vertex_native_settlements"."due_at_ns" <= "vertex_native_settlements"."occurred_at_ns"),
	CONSTRAINT "vertex_native_settlement_cash" CHECK ("vertex_native_settlements"."settlement_kind" is null or "vertex_native_settlements"."settlement_kind" <> 'cash' or "vertex_native_settlements"."share_delta" = '0'),
	CONSTRAINT "vertex_native_expiry_zero" CHECK ("vertex_native_settlements"."fact_kind" <> 'option-expiry' or ("vertex_native_settlements"."cash_delta" = '0' and "vertex_native_settlements"."share_delta" = '0')),
	CONSTRAINT "vertex_native_settlement_observation" CHECK ("vertex_native_settlements"."authoritative" = false and "vertex_native_settlements"."execution_authorized" = false)
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_heads" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"selection_id" text,
	"selection_sha256" text,
	"state" text NOT NULL,
	"updated_at" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_policy_heads_account_alias_environment_pk" PRIMARY KEY("account_alias","environment"),
	CONSTRAINT "vertex_policy_head_state" CHECK ("vertex_policy_heads"."state" in ('disabled','active-read-only','draining')),
	CONSTRAINT "vertex_policy_head_identity" CHECK (("vertex_policy_heads"."selection_id" is null) = ("vertex_policy_heads"."selection_sha256" is null) and ("vertex_policy_heads"."state" = 'disabled' or "vertex_policy_heads"."selection_id" is not null)),
	CONSTRAINT "vertex_policy_head_revision" CHECK ("vertex_policy_heads"."revision" > 0),
	CONSTRAINT "vertex_policy_head_scope" CHECK ("vertex_policy_heads"."environment" in ('research','paper')),
	CONSTRAINT "vertex_policy_head_hash" CHECK ("vertex_policy_heads"."record_hash" ~ '^[0-9a-f]{64}$' and ("vertex_policy_heads"."selection_sha256" is null or "vertex_policy_heads"."selection_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_history" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"command_id" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"operation" text NOT NULL,
	"selection_id" text NOT NULL,
	"selection_sha256" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"record_hash" text NOT NULL,
	"recorded_at_ns" numeric(30, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_policy_history_account_alias_environment_command_id_pk" PRIMARY KEY("account_alias","environment","command_id"),
	CONSTRAINT "vertex_policy_history_operation" CHECK ("vertex_policy_history"."operation" in ('stage','activate','rollback','drain','revoke','pin','release')),
	CONSTRAINT "vertex_policy_history_hashes" CHECK ("vertex_policy_history"."selection_sha256" ~ '^[0-9a-f]{64}$' and "vertex_policy_history"."request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_policy_history"."record_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_policy_history_revision_positive" CHECK ("vertex_policy_history"."revision" > 0)
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
	"owner_epoch" numeric(30, 0) NOT NULL,
	"pinned_at_ns" numeric(30, 0) NOT NULL,
	"released_at_ns" numeric(30, 0),
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_policy_ownership_pins_account_alias_environment_holder_id_pk" PRIMARY KEY("account_alias","environment","holder_id"),
	CONSTRAINT "vertex_policy_pin_kind" CHECK ("vertex_policy_ownership_pins"."holder_kind" in ('job','open-position')),
	CONSTRAINT "vertex_policy_pin_owner" CHECK ("vertex_policy_ownership_pins"."owner_epoch" > 0),
	CONSTRAINT "vertex_policy_pin_time" CHECK ("vertex_policy_ownership_pins"."released_at_ns" is null or "vertex_policy_ownership_pins"."released_at_ns" >= "vertex_policy_ownership_pins"."pinned_at_ns"),
	CONSTRAINT "vertex_policy_pin_hashes" CHECK ("vertex_policy_ownership_pins"."selection_sha256" ~ '^[0-9a-f]{64}$' and "vertex_policy_ownership_pins"."code_sha256" ~ '^[0-9a-f]{64}$' and "vertex_policy_ownership_pins"."record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_revocations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"selection_id" text NOT NULL,
	"selection_sha256" text NOT NULL,
	"command_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"recorded_at_ns" numeric(30, 0) NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_policy_revocations_pkey" PRIMARY KEY("account_alias","environment","selection_id"),
	CONSTRAINT "vertex_policy_revocation_hashes" CHECK ("vertex_policy_revocations"."selection_sha256" ~ '^[0-9a-f]{64}$' and "vertex_policy_revocations"."record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_policy_selections" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"selection_id" text NOT NULL,
	"selection_sha256" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"issued_at_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_policy_selections_account_alias_environment_selection_id_pk" PRIMARY KEY("account_alias","environment","selection_id"),
	CONSTRAINT "vertex_policy_scope" CHECK ("vertex_policy_selections"."environment" in ('research','paper')),
	CONSTRAINT "vertex_policy_digest" CHECK ("vertex_policy_selections"."selection_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_policy_window" CHECK ("vertex_policy_selections"."revision" > 0 and "vertex_policy_selections"."issued_at_ns" < "vertex_policy_selections"."expires_at_ns")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_agent_publications" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"run_id" text NOT NULL,
	"run_artifact_id" text NOT NULL,
	"advisory_artifact_id" text NOT NULL,
	"advisory_sha256" text NOT NULL,
	"request_hash" text NOT NULL,
	"review_pins" jsonb NOT NULL,
	"published_at" text NOT NULL,
	CONSTRAINT "vertex_worker_agent_publications_account_alias_environment_run_artifact_id_pk" PRIMARY KEY("account_alias","environment","run_artifact_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_collection_activations" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"previous_snapshot_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"activated_at" text NOT NULL,
	CONSTRAINT "vertex_worker_collection_activations_account_alias_environment_collection_id_idempotency_key_pk" PRIMARY KEY("account_alias","environment","collection_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_collection_snapshots" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"collection_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"job_id" text NOT NULL,
	"reconstruction_artifact_id" text NOT NULL,
	"reconstruction_sha256" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"member_artifacts" jsonb NOT NULL,
	"rights_pins" jsonb NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_worker_collection_snapshots_account_alias_environment_collection_id_snapshot_id_pk" PRIMARY KEY("account_alias","environment","collection_id","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_jobs" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"job_id" text NOT NULL,
	"event_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"worker_instance_id" text NOT NULL,
	"binding_hash" text NOT NULL,
	"state" text NOT NULL,
	"lease_id" text NOT NULL,
	"lease_epoch" numeric(30, 0) NOT NULL,
	"lease_expires_at_ns" numeric(30, 0) NOT NULL,
	"deadline_at_ns" numeric(30, 0) NOT NULL,
	"attempt" integer NOT NULL,
	"outcome_hash" text,
	"output_artifact_ids" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_worker_jobs_account_alias_environment_job_id_pk" PRIMARY KEY("account_alias","environment","job_id"),
	CONSTRAINT "vertex_worker_job_scope" CHECK ("vertex_worker_jobs"."environment" in ('research','paper')),
	CONSTRAINT "vertex_worker_job_state" CHECK ("vertex_worker_jobs"."state" in ('leased','running','succeeded','failed','cancelled','unknown')),
	CONSTRAINT "vertex_worker_job_lease" CHECK ("vertex_worker_jobs"."lease_epoch" > 0 and "vertex_worker_jobs"."attempt" between 1 and 32 and "vertex_worker_jobs"."lease_expires_at_ns" <= "vertex_worker_jobs"."deadline_at_ns")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_readiness" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"job_id" text NOT NULL,
	"lease_epoch" numeric(30, 0) NOT NULL,
	"observed_at_ns" numeric(30, 0) NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_worker_readiness_account_alias_environment_job_id_pk" PRIMARY KEY("account_alias","environment","job_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_run_admissions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"run_id" text NOT NULL,
	"job_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"lease_epoch" numeric(30, 0) NOT NULL,
	"admitted_at" text NOT NULL,
	CONSTRAINT "vertex_worker_run_admissions_account_alias_environment_run_id_pk" PRIMARY KEY("account_alias","environment","run_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_service_grants" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"service_principal_id" text NOT NULL,
	"credential_digest" text NOT NULL,
	"issued_at_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"revoked_at" text,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_worker_service_grants_account_alias_environment_grant_id_pk" PRIMARY KEY("account_alias","environment","grant_id"),
	CONSTRAINT "vertex_worker_grant_scope" CHECK ("vertex_worker_service_grants"."environment" in ('research','paper')),
	CONSTRAINT "vertex_worker_grant_digest" CHECK ("vertex_worker_service_grants"."credential_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_worker_grant_expiry" CHECK ("vertex_worker_service_grants"."expires_at_ns" > "vertex_worker_service_grants"."issued_at_ns")
);
--> statement-breakpoint
CREATE TABLE "vertex_worker_stages" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"artifact_id" text NOT NULL,
	"job_id" text NOT NULL,
	"collection_key" text NOT NULL,
	"object_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"canonical_sha256" text,
	"request_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_worker_stages_account_alias_environment_artifact_id_pk" PRIMARY KEY("account_alias","environment","artifact_id"),
	CONSTRAINT "vertex_worker_stage_length" CHECK ("vertex_worker_stages"."byte_length" between 0 and 1048576),
	CONSTRAINT "vertex_worker_stage_hash" CHECK ("vertex_worker_stages"."content_sha256" ~ '^[0-9a-f]{64}$' and ("vertex_worker_stages"."canonical_sha256" is null or "vertex_worker_stages"."canonical_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "notification_authority_current" (
	"tenant_key" text NOT NULL,
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"record_kind" text NOT NULL,
	"authority_id" text NOT NULL,
	"current_version" text NOT NULL,
	CONSTRAINT "notification_authority_current_pk" PRIMARY KEY("tenant_key","account_alias","environment","record_kind","authority_id")
);
--> statement-breakpoint
CREATE TABLE "notification_authority_versions" (
	"tenant_key" text NOT NULL,
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"record_kind" text NOT NULL,
	"authority_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"recipient_key" text NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"binding_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at_ms" bigint NOT NULL,
	"valid_from_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	CONSTRAINT "notification_authority_versions_pk" PRIMARY KEY("tenant_key","account_alias","environment","record_kind","authority_id","version"),
	CONSTRAINT "notification_authority_versions_keys" CHECK ("notification_authority_versions"."tenant_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_authority_versions"."account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "notification_authority_versions"."authority_id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_authority_versions"."recipient_key" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and "notification_authority_versions"."recorded_by" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
	CONSTRAINT "notification_authority_versions_scope" CHECK ("notification_authority_versions"."environment" in ('research', 'paper') and "notification_authority_versions"."record_kind" in ('consent', 'grant') and "notification_authority_versions"."channel" in ('phone', 'email') and "notification_authority_versions"."purpose" in ('market-alert', 'research-update', 'operational-alert')),
	CONSTRAINT "notification_authority_versions_state" CHECK ("notification_authority_versions"."status" in ('granted', 'revoked') and "notification_authority_versions"."version" ~ '^[1-9][0-9]{0,29}$'),
	CONSTRAINT "notification_authority_versions_hashes" CHECK ("notification_authority_versions"."binding_hash" ~ '^[0-9a-f]{64}$' and "notification_authority_versions"."payload_hash" ~ '^[0-9a-f]{64}$' and "notification_authority_versions"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "notification_authority_versions_interval" CHECK ("notification_authority_versions"."recorded_at_ms" between 0 and 253402300799999 and "notification_authority_versions"."valid_from_ms" between 0 and 253402300799999 and "notification_authority_versions"."expires_at_ms" between 0 and 253402300799999 and "notification_authority_versions"."valid_from_ms" < "notification_authority_versions"."expires_at_ms")
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_attempt_identities" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"request_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	CONSTRAINT "vertex_model_use_attempt_identities_account_alias_environment_request_id_pk" PRIMARY KEY("account_alias","environment","request_id")
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
	"input_bytes" numeric(30, 0) NOT NULL,
	"input_tokens" numeric(30, 0),
	"maximum_output_tokens" numeric(30, 0) NOT NULL,
	"maximum_cost_usd" text NOT NULL,
	"token_charge" numeric(30, 0) NOT NULL,
	"cost_charge_units" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"window_id" text NOT NULL,
	"request_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_version" text NOT NULL,
	"lease_id" text NOT NULL,
	"lease_epoch" numeric(30, 0) NOT NULL,
	"window_revision" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_model_use_budget_reservations_pkey" PRIMARY KEY("account_alias","environment","job_id","selection_id","request_sha256"),
	CONSTRAINT "vertex_model_use_budget_scope" CHECK ("vertex_model_use_budget_reservations"."environment" in ('research','paper')),
	CONSTRAINT "vertex_model_use_budget_operation" CHECK ("vertex_model_use_budget_reservations"."operation" in ('model-tokenize','model-completion')),
	CONSTRAINT "vertex_model_use_budget_bounds" CHECK ("vertex_model_use_budget_reservations"."input_bytes" >= 0 and ("vertex_model_use_budget_reservations"."input_tokens" is null or "vertex_model_use_budget_reservations"."input_tokens" >= 0) and "vertex_model_use_budget_reservations"."maximum_output_tokens" >= 0 and "vertex_model_use_budget_reservations"."token_charge" >= 0 and "vertex_model_use_budget_reservations"."cost_charge_units" >= 0),
	CONSTRAINT "vertex_model_use_budget_cost" CHECK ("vertex_model_use_budget_reservations"."maximum_cost_usd" ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'),
	CONSTRAINT "vertex_model_use_budget_hashes" CHECK ("vertex_model_use_budget_reservations"."selection_sha256" ~ '^[0-9a-f]{64}$' and "vertex_model_use_budget_reservations"."request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_model_use_budget_reservations"."record_hash" ~ '^[0-9a-f]{64}$')
);
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
	"starts_at_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"maximum_tokens" numeric(30, 0) NOT NULL,
	"maximum_cost_units" numeric(30, 0) NOT NULL,
	"reserved_tokens" numeric(30, 0) NOT NULL,
	"reserved_cost_units" numeric(30, 0) NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_model_use_budget_windows_account_alias_environment_window_id_pk" PRIMARY KEY("account_alias","environment","window_id"),
	CONSTRAINT "vertex_model_use_window_bounds" CHECK ("vertex_model_use_budget_windows"."reserved_tokens" >= 0 and "vertex_model_use_budget_windows"."reserved_tokens" <= "vertex_model_use_budget_windows"."maximum_tokens" and "vertex_model_use_budget_windows"."reserved_cost_units" >= 0 and "vertex_model_use_budget_windows"."reserved_cost_units" <= "vertex_model_use_budget_windows"."maximum_cost_units" and "vertex_model_use_budget_windows"."revision" > 0 and "vertex_model_use_budget_windows"."starts_at_ns" < "vertex_model_use_budget_windows"."expires_at_ns")
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_grant_current" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_version" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	CONSTRAINT "vertex_model_use_grant_current_pkey" PRIMARY KEY("account_alias","environment","grant_id"),
	CONSTRAINT "vertex_model_use_current_revision" CHECK ("vertex_model_use_grant_current"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_grant_versions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_version" text NOT NULL,
	"revision" numeric(30, 0) NOT NULL,
	"selection_id" text NOT NULL,
	"selection_sha256" text NOT NULL,
	"research_principal_id" text NOT NULL,
	"consumer_service_id" text NOT NULL,
	"status" text NOT NULL,
	"valid_from_ns" numeric(30, 0) NOT NULL,
	"expires_at_ns" numeric(30, 0) NOT NULL,
	"issued_at_ns" numeric(30, 0) NOT NULL,
	"issued_by_actor_id" text NOT NULL,
	"command_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_model_use_grant_versions_account_alias_environment_grant_id_grant_version_pk" PRIMARY KEY("account_alias","environment","grant_id","grant_version"),
	CONSTRAINT "vertex_model_use_scope" CHECK ("vertex_model_use_grant_versions"."environment" in ('research','paper')),
	CONSTRAINT "vertex_model_use_status" CHECK ("vertex_model_use_grant_versions"."status" in ('granted','revoked')),
	CONSTRAINT "vertex_model_use_window" CHECK ("vertex_model_use_grant_versions"."revision" > 0 and "vertex_model_use_grant_versions"."valid_from_ns" < "vertex_model_use_grant_versions"."expires_at_ns"),
	CONSTRAINT "vertex_model_use_hashes" CHECK ("vertex_model_use_grant_versions"."selection_sha256" ~ '^[0-9a-f]{64}$' and "vertex_model_use_grant_versions"."request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_model_use_grant_versions"."record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_model_use_proof_audits" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"request_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"checked_at_ns" numeric(30, 0) NOT NULL,
	"actor_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"grant_version" text NOT NULL,
	"grant_revision" numeric(30, 0),
	"decision" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_model_use_proof_audits_account_alias_environment_request_id_checked_at_ns_record_hash_pk" PRIMARY KEY("account_alias","environment","request_id","checked_at_ns","record_hash"),
	CONSTRAINT "vertex_model_use_proof_decision" CHECK ("vertex_model_use_proof_audits"."decision" in ('allowed','denied')),
	CONSTRAINT "vertex_model_use_proof_hashes" CHECK ("vertex_model_use_proof_audits"."request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_model_use_proof_audits"."record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vertex_portfolio_epoch_transitions" (
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"transition_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"prior_owner_epoch" numeric(30, 0) NOT NULL,
	"prior_projection_sequence" numeric(30, 0) NOT NULL,
	"prior_projection_hash" text NOT NULL,
	"owner_epoch" numeric(30, 0) NOT NULL,
	"snapshot_id" text NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"genesis_hash" text NOT NULL,
	"journal_identity" text NOT NULL,
	"journal_sequence" numeric(30, 0) NOT NULL,
	"journal_head_sha256" text NOT NULL,
	"native_outbox_evidence_sha256" text NOT NULL,
	"native_owner_fence_sha256" text NOT NULL,
	"approval_base64" text NOT NULL,
	"transition_sha256" text NOT NULL,
	"actor_id" text NOT NULL,
	"recorded_at" text NOT NULL,
	"authorization_kind" text DEFAULT 'direct' NOT NULL,
	"authorizing_replay_request_sha256" text,
	"authorizing_signer_key_sha256" text,
	"authorizing_approval_id" text,
	"authoritative" boolean DEFAULT false NOT NULL,
	"execution_authorized" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_portfolio_epoch_transitions_account_alias_environment_transition_id_pk" PRIMARY KEY("account_alias","environment","transition_id"),
	CONSTRAINT "vertex_epoch_transition_observation" CHECK ("vertex_portfolio_epoch_transitions"."environment" = 'paper' and "vertex_portfolio_epoch_transitions"."authoritative" = false and "vertex_portfolio_epoch_transitions"."execution_authorized" = false),
	CONSTRAINT "vertex_epoch_transition_authorization" CHECK (("vertex_portfolio_epoch_transitions"."authorization_kind" = 'direct' and "vertex_portfolio_epoch_transitions"."authorizing_replay_request_sha256" is null and "vertex_portfolio_epoch_transitions"."authorizing_signer_key_sha256" is null and "vertex_portfolio_epoch_transitions"."authorizing_approval_id" is null) or ("vertex_portfolio_epoch_transitions"."authorization_kind" = 'retained-replay' and "vertex_portfolio_epoch_transitions"."authorizing_replay_request_sha256" is not null and "vertex_portfolio_epoch_transitions"."authorizing_signer_key_sha256" is not null and "vertex_portfolio_epoch_transitions"."authorizing_approval_id" is not null and "vertex_portfolio_epoch_transitions"."authorizing_replay_request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."authorizing_signer_key_sha256" ~ '^[0-9a-f]{64}$' and length("vertex_portfolio_epoch_transitions"."authorizing_approval_id") between 1 and 160)),
	CONSTRAINT "vertex_epoch_transition_sequences" CHECK ("vertex_portfolio_epoch_transitions"."prior_owner_epoch" > 0 and "vertex_portfolio_epoch_transitions"."owner_epoch" > "vertex_portfolio_epoch_transitions"."prior_owner_epoch" and "vertex_portfolio_epoch_transitions"."prior_projection_sequence" > 0 and "vertex_portfolio_epoch_transitions"."journal_sequence" > 0),
	CONSTRAINT "vertex_epoch_transition_digests" CHECK ("vertex_portfolio_epoch_transitions"."prior_projection_hash" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."snapshot_sha256" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."genesis_hash" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."journal_head_sha256" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."native_outbox_evidence_sha256" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."native_owner_fence_sha256" ~ '^[0-9a-f]{64}$' and "vertex_portfolio_epoch_transitions"."transition_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_epoch_transition_approval" CHECK (length("vertex_portfolio_epoch_transitions"."approval_base64") between 4 and 1398104 and "vertex_portfolio_epoch_transitions"."approval_base64" ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' and octet_length(decode("vertex_portfolio_epoch_transitions"."approval_base64", 'base64')) between 1 and 1048576 and replace(encode(decode("vertex_portfolio_epoch_transitions"."approval_base64", 'base64'), 'base64'), E'
', '') = "vertex_portfolio_epoch_transitions"."approval_base64"),
	CONSTRAINT "vertex_epoch_transition_binding" CHECK (("vertex_portfolio_epoch_transitions"."payload"->>'schemaVersion' = '1.0.0' and "vertex_portfolio_epoch_transitions"."payload"->>'transitionId' = "vertex_portfolio_epoch_transitions"."transition_id" and "vertex_portfolio_epoch_transitions"."payload"->>'priorOwnerEpoch' = "vertex_portfolio_epoch_transitions"."prior_owner_epoch"::text and "vertex_portfolio_epoch_transitions"."payload"->>'priorProjectionSequence' = "vertex_portfolio_epoch_transitions"."prior_projection_sequence"::text and "vertex_portfolio_epoch_transitions"."payload"->>'priorProjectionHash' = "vertex_portfolio_epoch_transitions"."prior_projection_hash" and "vertex_portfolio_epoch_transitions"."payload"->>'journalIdentity' = "vertex_portfolio_epoch_transitions"."journal_identity" and "vertex_portfolio_epoch_transitions"."payload"->>'journalSequence' = "vertex_portfolio_epoch_transitions"."journal_sequence"::text and "vertex_portfolio_epoch_transitions"."payload"->>'journalHeadSha256' = "vertex_portfolio_epoch_transitions"."journal_head_sha256" and "vertex_portfolio_epoch_transitions"."payload"->>'nativeOutboxEvidenceSha256' = "vertex_portfolio_epoch_transitions"."native_outbox_evidence_sha256" and "vertex_portfolio_epoch_transitions"."payload"->>'nativeOwnerFenceSha256' = "vertex_portfolio_epoch_transitions"."native_owner_fence_sha256" and "vertex_portfolio_epoch_transitions"."payload"->>'approvalBase64' = "vertex_portfolio_epoch_transitions"."approval_base64" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'snapshotId' = "vertex_portfolio_epoch_transitions"."snapshot_id" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'accountAlias' = "vertex_portfolio_epoch_transitions"."account_alias" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'environment' = "vertex_portfolio_epoch_transitions"."environment" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'streamId' = "vertex_portfolio_epoch_transitions"."stream_id" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'ownerEpoch' = "vertex_portfolio_epoch_transitions"."owner_epoch"::text and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'sequence' = '1' and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'sourceEventHash' = "vertex_portfolio_epoch_transitions"."genesis_hash" and "vertex_portfolio_epoch_transitions"."payload"->'snapshot'->>'sourceKind' = 'paper-simulation') is true)
);
--> statement-breakpoint
CREATE TABLE "vertex_native_approval_audit" (
	"signer_key_id" text NOT NULL,
	"signer_key_sha256" text NOT NULL,
	"approval_id" text NOT NULL,
	"nonce" text NOT NULL,
	"approver_actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_sha256" text NOT NULL,
	"approval_sha256" text NOT NULL,
	"status_revision" numeric(30, 0) NOT NULL,
	"status_sha256" text NOT NULL,
	"expires_at" text NOT NULL,
	"account_alias" text NOT NULL,
	"environment" text NOT NULL,
	"recipient_actor_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"approval_base64" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"recorded_at" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "vertex_native_approval_audit_signer_key_sha256_approval_id_pk" PRIMARY KEY("signer_key_sha256","approval_id"),
	CONSTRAINT "vertex_native_approval_purpose" CHECK ("vertex_native_approval_audit"."environment" = 'paper' and "vertex_native_approval_audit"."action" in ('owner-epoch-transition','native-outbox-replay') and "vertex_native_approval_audit"."approver_actor_id" <> "vertex_native_approval_audit"."recipient_actor_id" and "vertex_native_approval_audit"."status_revision" > 0),
	CONSTRAINT "vertex_native_approval_digests" CHECK ("vertex_native_approval_audit"."signer_key_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."nonce" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."subject_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."approval_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."status_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."request_sha256" ~ '^[0-9a-f]{64}$' and "vertex_native_approval_audit"."record_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vertex_native_approval_proof" CHECK (length("vertex_native_approval_audit"."approval_base64") between 4 and 1398104 and "vertex_native_approval_audit"."approval_base64" ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' and octet_length(decode("vertex_native_approval_audit"."approval_base64", 'base64')) between 1 and 1048576 and replace(encode(decode("vertex_native_approval_audit"."approval_base64", 'base64'), 'base64'), E'
', '') = "vertex_native_approval_audit"."approval_base64"),
	CONSTRAINT "vertex_native_approval_binding" CHECK (("vertex_native_approval_audit"."payload"->>'accountAlias' = "vertex_native_approval_audit"."account_alias" and "vertex_native_approval_audit"."payload"->>'environment' = "vertex_native_approval_audit"."environment" and "vertex_native_approval_audit"."payload"->>'recipientActorId' = "vertex_native_approval_audit"."recipient_actor_id" and "vertex_native_approval_audit"."payload"->>'streamId' = "vertex_native_approval_audit"."stream_id" and "vertex_native_approval_audit"."payload"->>'requestId' = "vertex_native_approval_audit"."request_id" and "vertex_native_approval_audit"."payload"->>'requestSha256' = "vertex_native_approval_audit"."request_sha256" and "vertex_native_approval_audit"."payload"->>'approvalBase64' = "vertex_native_approval_audit"."approval_base64" and "vertex_native_approval_audit"."payload"->>'recordedAt' = "vertex_native_approval_audit"."recorded_at" and "vertex_native_approval_audit"."payload"->'outcome' = "vertex_native_approval_audit"."outcome" and "vertex_native_approval_audit"."payload"->'receipt'->>'signerKeyId' = "vertex_native_approval_audit"."signer_key_id" and "vertex_native_approval_audit"."payload"->'receipt'->>'signerKeySha256' = "vertex_native_approval_audit"."signer_key_sha256" and "vertex_native_approval_audit"."payload"->'receipt'->>'approvalId' = "vertex_native_approval_audit"."approval_id" and "vertex_native_approval_audit"."payload"->'receipt'->>'nonce' = "vertex_native_approval_audit"."nonce" and "vertex_native_approval_audit"."payload"->'receipt'->>'actorId' = "vertex_native_approval_audit"."approver_actor_id" and "vertex_native_approval_audit"."payload"->'receipt'->>'action' = "vertex_native_approval_audit"."action" and "vertex_native_approval_audit"."payload"->'receipt'->>'subjectSha256' = "vertex_native_approval_audit"."subject_sha256" and "vertex_native_approval_audit"."payload"->'receipt'->>'approvalSha256' = "vertex_native_approval_audit"."approval_sha256" and "vertex_native_approval_audit"."payload"->'receipt'->>'statusRevision' = "vertex_native_approval_audit"."status_revision"::text and "vertex_native_approval_audit"."payload"->'receipt'->>'statusSha256' = "vertex_native_approval_audit"."status_sha256" and "vertex_native_approval_audit"."payload"->'receipt'->>'expiresAt' = "vertex_native_approval_audit"."expires_at") is true),
	CONSTRAINT "vertex_native_approval_outcome" CHECK (("vertex_native_approval_audit"."outcome"->>'status' in ('applied','duplicate','gap','epoch-mismatch','stale') and "vertex_native_approval_audit"."outcome"->>'highWaterSequence' ~ '^(0|[1-9][0-9]{0,29})$' and ("vertex_native_approval_audit"."outcome"->'highWaterEventHash' = 'null'::jsonb or "vertex_native_approval_audit"."outcome"->>'highWaterEventHash' ~ '^[0-9a-f]{64}$')) is true)
);
--> statement-breakpoint
-- Referenced unique indexes must exist before foreign keys. These ordinary UNIQUE indexes remain nondeferrable.
CREATE UNIQUE INDEX "vertex_collection_idempotency" ON "vertex_collection_generations" USING btree ("account_alias","environment","collection_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_generation_shard_artifact" ON "vertex_collection_shards" USING btree ("account_alias","environment","collection_id","snapshot_id","import_artifact_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_projection_sequence" ON "vertex_execution_projections" USING btree ("account_alias","environment","stream_id","owner_epoch","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_projection_idempotency" ON "vertex_execution_projections" USING btree ("account_alias","environment","stream_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_outbox_idempotency" ON "vertex_outbox" USING btree ("account_alias","environment","collection_key","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_paper_job_idempotency" ON "vertex_paper_jobs" USING btree ("account_alias","environment","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_portfolio_sequence" ON "vertex_portfolio_snapshots" USING btree ("account_alias","environment","stream_id","owner_epoch","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_record_artifact" ON "vertex_records" USING btree ("account_alias","environment","artifact_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_review_version" ON "vertex_reviews" USING btree ("account_alias","environment","artifact_id","purpose","review_version");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_rights_revision" ON "vertex_rights_versions" USING btree ("account_alias","environment","collection_key","policy_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_admissions_attempt_unique" ON "notification_admissions" USING btree ("tenant_key","recipient_key","channel","attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_grant_binding_scope" ON "vertex_grant_bindings" USING btree ("account_alias","environment","grant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_grant_revision" ON "vertex_grant_versions" USING btree ("account_alias","environment","grant_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_proposal_evidence_ordinal" ON "vertex_research_proposal_evidence" USING btree ("account_alias","environment","artifact_id","ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_fact_sequence" ON "vertex_native_fact_projections" USING btree ("account_alias","environment","stream_id","owner_epoch","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_fact_idempotency" ON "vertex_native_fact_projections" USING btree ("account_alias","environment","stream_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_fact_journal_identity" ON "vertex_native_fact_projections" USING btree ("account_alias","environment","owner_epoch","proof_journal_sequence","proof_journal_head_hash","fact_ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_proof_binding" ON "vertex_native_journal_proofs" USING btree ("account_alias","environment","artifact_id","sha256","source_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_kill_reason_identity" ON "vertex_native_kill_reasons" USING btree ("account_alias","environment","projection_id","reason_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_settlement_source_identity" ON "vertex_native_settlement_sources" USING btree ("account_alias","environment","projection_id","source_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_policy_history_revision" ON "vertex_policy_history" USING btree ("account_alias","environment","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_policy_revision" ON "vertex_policy_selections" USING btree ("account_alias","environment","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_terminal_agent_run" ON "vertex_worker_agent_publications" USING btree ("account_alias","environment","run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_event_admission" ON "vertex_worker_jobs" USING btree ("account_alias","environment","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_one_run_per_job" ON "vertex_worker_run_admissions" USING btree ("account_alias","environment","job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_credential_digest" ON "vertex_worker_service_grants" USING btree ("credential_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_model_use_reservation_id" ON "vertex_model_use_budget_reservations" USING btree ("account_alias","environment","reservation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_model_use_window_identity" ON "vertex_model_use_budget_windows" USING btree ("account_alias","environment","selection_id","policy_id","period_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_model_use_grant_revision" ON "vertex_model_use_grant_versions" USING btree ("account_alias","environment","grant_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_model_use_command" ON "vertex_model_use_grant_versions" USING btree ("account_alias","environment","command_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_epoch_transition_owner" ON "vertex_portfolio_epoch_transitions" USING btree ("account_alias","environment","stream_id","owner_epoch");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_epoch_transition_predecessor" ON "vertex_portfolio_epoch_transitions" USING btree ("account_alias","environment","stream_id","prior_owner_epoch");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_epoch_transition_snapshot" ON "vertex_portfolio_epoch_transitions" USING btree ("account_alias","environment","snapshot_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_approval_nonce" ON "vertex_native_approval_audit" USING btree ("signer_key_sha256","nonce");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_native_approval_exact_request" ON "vertex_native_approval_audit" USING btree ("signer_key_sha256","approval_id","request_sha256");
--> statement-breakpoint
-- Remaining genuine generated operations. Only the exact replay authorization FK is amended to DEFERRABLE INITIALLY DEFERRED.
ALTER TABLE "vertex_account_aliases" ADD CONSTRAINT "vertex_account_aliases_account_id_vertex_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."vertex_accounts"("account_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_agent_versions" ADD CONSTRAINT "vertex_agent_versions_account_alias_environment_artifact_id_vertex_records_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_artifact_lineage" ADD CONSTRAINT "vertex_artifact_lineage_account_alias_environment_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_artifact_lineage" ADD CONSTRAINT "vertex_artifact_lineage_account_alias_environment_parent_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","parent_artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_artifacts" ADD CONSTRAINT "vertex_artifacts_account_alias_environment_collection_key_rights_policy_id_rights_version_vertex_rights_versions_account_alias_environment_collection_key_policy_id_version_fk" FOREIGN KEY ("account_alias","environment","collection_key","rights_policy_id","rights_version") REFERENCES "public"."vertex_rights_versions"("account_alias","environment","collection_key","policy_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_backtest_versions" ADD CONSTRAINT "vertex_backtest_versions_record_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_backtest_versions" ADD CONSTRAINT "vertex_backtest_versions_account_alias_environment_strategy_artifact_id_vertex_strategy_versions_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","strategy_artifact_id") REFERENCES "public"."vertex_strategy_versions"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_claim_evidence" ADD CONSTRAINT "vertex_claim_evidence_account_alias_environment_collection_id_evidence_id_vertex_evidence_account_alias_environment_collection_id_evidence_id_fk" FOREIGN KEY ("account_alias","environment","collection_id","evidence_id") REFERENCES "public"."vertex_evidence"("account_alias","environment","collection_id","evidence_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_claim_evidence" ADD CONSTRAINT "vertex_claim_evidence_source_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id","source_id") REFERENCES "public"."vertex_source_identities"("account_alias","environment","collection_id","snapshot_id","source_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_collection_datasets" ADD CONSTRAINT "vertex_collection_datasets_generation_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id") REFERENCES "public"."vertex_collection_generations"("account_alias","environment","collection_id","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_collection_datasets" ADD CONSTRAINT "vertex_collection_datasets_account_alias_environment_dataset_id_vertex_datasets_account_alias_environment_dataset_id_fk" FOREIGN KEY ("account_alias","environment","dataset_id") REFERENCES "public"."vertex_datasets"("account_alias","environment","dataset_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_collection_generations" ADD CONSTRAINT "vertex_collection_generations_collection_fk" FOREIGN KEY ("account_alias","environment","collection_id") REFERENCES "public"."vertex_collections"("account_alias","environment","collection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_collection_shards" ADD CONSTRAINT "vertex_collection_shards_generation_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id") REFERENCES "public"."vertex_collection_generations"("account_alias","environment","collection_id","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_collection_shards" ADD CONSTRAINT "vertex_collection_shards_account_alias_environment_import_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","import_artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_dataset_sources" ADD CONSTRAINT "vertex_dataset_sources_account_alias_environment_dataset_id_vertex_datasets_account_alias_environment_dataset_id_fk" FOREIGN KEY ("account_alias","environment","dataset_id") REFERENCES "public"."vertex_datasets"("account_alias","environment","dataset_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_datasets" ADD CONSTRAINT "vertex_datasets_account_alias_environment_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_duplicate_mappings" ADD CONSTRAINT "vertex_duplicate_mappings_source_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id","source_id") REFERENCES "public"."vertex_source_identities"("account_alias","environment","collection_id","snapshot_id","source_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_duplicate_mappings" ADD CONSTRAINT "vertex_duplicate_mappings_canonical_source_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id","canonical_source_id") REFERENCES "public"."vertex_source_identities"("account_alias","environment","collection_id","snapshot_id","source_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_evidence" ADD CONSTRAINT "vertex_evidence_account_alias_environment_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_module_capabilities" ADD CONSTRAINT "vertex_module_capabilities_module_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_module_versions"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_module_versions" ADD CONSTRAINT "vertex_module_versions_account_alias_environment_artifact_id_vertex_records_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_paper_jobs" ADD CONSTRAINT "vertex_paper_jobs_account_alias_environment_review_id_vertex_reviews_account_alias_environment_review_id_fk" FOREIGN KEY ("account_alias","environment","review_id") REFERENCES "public"."vertex_reviews"("account_alias","environment","review_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_lots" ADD CONSTRAINT "vertex_portfolio_lots_account_alias_environment_snapshot_id_vertex_portfolio_snapshots_account_alias_environment_snapshot_id_fk" FOREIGN KEY ("account_alias","environment","snapshot_id") REFERENCES "public"."vertex_portfolio_snapshots"("account_alias","environment","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_lots" ADD CONSTRAINT "vertex_portfolio_lots_account_alias_environment_instrument_id_vertex_instruments_account_alias_environment_instrument_id_fk" FOREIGN KEY ("account_alias","environment","instrument_id") REFERENCES "public"."vertex_instruments"("account_alias","environment","instrument_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_positions" ADD CONSTRAINT "vertex_portfolio_positions_snapshot_fk" FOREIGN KEY ("account_alias","environment","snapshot_id") REFERENCES "public"."vertex_portfolio_snapshots"("account_alias","environment","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_positions" ADD CONSTRAINT "vertex_portfolio_positions_account_alias_environment_instrument_id_vertex_instruments_account_alias_environment_instrument_id_fk" FOREIGN KEY ("account_alias","environment","instrument_id") REFERENCES "public"."vertex_instruments"("account_alias","environment","instrument_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_receipt_fills" ADD CONSTRAINT "vertex_receipt_fills_account_alias_environment_projection_id_vertex_execution_projections_account_alias_environment_projection_id_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_execution_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_receipt_orders" ADD CONSTRAINT "vertex_receipt_orders_account_alias_environment_projection_id_vertex_execution_projections_account_alias_environment_projection_id_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_execution_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_record_instruments" ADD CONSTRAINT "vertex_record_instruments_record_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_record_instruments" ADD CONSTRAINT "vertex_record_instruments_account_alias_environment_instrument_id_vertex_instruments_account_alias_environment_instrument_id_fk" FOREIGN KEY ("account_alias","environment","instrument_id") REFERENCES "public"."vertex_instruments"("account_alias","environment","instrument_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_record_relationships" ADD CONSTRAINT "vertex_record_relationships_artifact_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_record_relationships" ADD CONSTRAINT "vertex_record_relationships_account_alias_environment_related_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","related_artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_records" ADD CONSTRAINT "vertex_records_account_alias_environment_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_reservation_observations" ADD CONSTRAINT "vertex_reservation_observations_snapshot_fk" FOREIGN KEY ("account_alias","environment","snapshot_id") REFERENCES "public"."vertex_portfolio_snapshots"("account_alias","environment","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_reviews" ADD CONSTRAINT "vertex_reviews_account_alias_environment_artifact_id_vertex_artifacts_account_alias_environment_artifact_id_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_sleeve_observations" ADD CONSTRAINT "vertex_sleeve_observations_snapshot_fk" FOREIGN KEY ("account_alias","environment","snapshot_id") REFERENCES "public"."vertex_portfolio_snapshots"("account_alias","environment","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_source_identities" ADD CONSTRAINT "vertex_source_identities_generation_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id") REFERENCES "public"."vertex_collection_generations"("account_alias","environment","collection_id","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_strategy_versions" ADD CONSTRAINT "vertex_strategy_versions_record_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_unavailable_sources" ADD CONSTRAINT "vertex_unavailable_sources_generation_fk" FOREIGN KEY ("account_alias","environment","collection_id","snapshot_id") REFERENCES "public"."vertex_collection_generations"("account_alias","environment","collection_id","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_grant_actions" ADD CONSTRAINT "vertex_grant_action_version_fk" FOREIGN KEY ("account_alias","environment","grant_id","version") REFERENCES "public"."vertex_grant_versions"("account_alias","environment","grant_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_grant_current" ADD CONSTRAINT "vertex_grant_current_version_fk" FOREIGN KEY ("account_alias","environment","grant_id","current_version") REFERENCES "public"."vertex_grant_versions"("account_alias","environment","grant_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_grant_versions" ADD CONSTRAINT "vertex_grant_version_binding_fk" FOREIGN KEY ("account_alias","environment","grant_id") REFERENCES "public"."vertex_grant_bindings"("account_alias","environment","grant_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_research_proposal_evidence" ADD CONSTRAINT "vertex_proposal_evidence_proposal_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_research_proposals"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_research_proposal_evidence" ADD CONSTRAINT "vertex_proposal_evidence_artifact_fk" FOREIGN KEY ("account_alias","environment","evidence_artifact_id") REFERENCES "public"."vertex_artifacts"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_research_proposals" ADD CONSTRAINT "vertex_research_proposal_record_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_reviewed_artifact_links" ADD CONSTRAINT "vertex_reviewed_artifact_review_fk" FOREIGN KEY ("account_alias","environment","review_id") REFERENCES "public"."vertex_reviews"("account_alias","environment","review_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_reviewed_artifact_links" ADD CONSTRAINT "vertex_reviewed_artifact_record_fk" FOREIGN KEY ("account_alias","environment","artifact_id") REFERENCES "public"."vertex_records"("account_alias","environment","artifact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_checkpoints" ADD CONSTRAINT "vertex_native_checkpoints_projection_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_fact_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_corporate_actions" ADD CONSTRAINT "vertex_native_corporate_actions_projection_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_fact_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_fact_projections" ADD CONSTRAINT "vertex_native_fact_projections_account_alias_environment_stream_id_vertex_projection_heads_account_alias_environment_stream_id_fk" FOREIGN KEY ("account_alias","environment","stream_id") REFERENCES "public"."vertex_projection_heads"("account_alias","environment","stream_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_fact_projections" ADD CONSTRAINT "vertex_native_fact_projections_account_alias_environment_proof_artifact_id_proof_sha256_proof_source_event_id_vertex_native_journal_proofs_account_alias_environment_artifact_id_sha256_source_event_id_fk" FOREIGN KEY ("account_alias","environment","proof_artifact_id","proof_sha256","proof_source_event_id") REFERENCES "public"."vertex_native_journal_proofs"("account_alias","environment","artifact_id","sha256","source_event_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_kill_reasons" ADD CONSTRAINT "vertex_native_kill_reasons_state_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_kill_states"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_kill_states" ADD CONSTRAINT "vertex_native_kill_states_projection_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_fact_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_reconciliations" ADD CONSTRAINT "vertex_native_reconciliations_projection_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_fact_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_settlement_sources" ADD CONSTRAINT "vertex_native_settlement_sources_settlement_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_settlements"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_native_settlements" ADD CONSTRAINT "vertex_native_settlements_projection_fk" FOREIGN KEY ("account_alias","environment","projection_id") REFERENCES "public"."vertex_native_fact_projections"("account_alias","environment","projection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_policy_heads" ADD CONSTRAINT "vertex_policy_heads_account_alias_environment_selection_id_vertex_policy_selections_account_alias_environment_selection_id_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_policy_history" ADD CONSTRAINT "vertex_policy_history_account_alias_environment_selection_id_vertex_policy_selections_account_alias_environment_selection_id_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_policy_ownership_pins" ADD CONSTRAINT "vertex_policy_ownership_pins_account_alias_environment_selection_id_vertex_policy_selections_account_alias_environment_selection_id_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_policy_revocations" ADD CONSTRAINT "vertex_policy_revocations_selection_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_policy_selections" ADD CONSTRAINT "vertex_policy_selections_account_alias_environment_vertex_account_aliases_account_alias_environment_fk" FOREIGN KEY ("account_alias","environment") REFERENCES "public"."vertex_account_aliases"("account_alias","environment") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_authority_current" ADD CONSTRAINT "notification_authority_current_version_fk" FOREIGN KEY ("tenant_key","account_alias","environment","record_kind","authority_id","current_version") REFERENCES "public"."notification_authority_versions"("tenant_key","account_alias","environment","record_kind","authority_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_model_use_budget_reservations" ADD CONSTRAINT "vertex_model_use_budget_reservations_selection_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_model_use_budget_windows" ADD CONSTRAINT "vertex_model_use_budget_windows_account_alias_environment_selection_id_vertex_policy_selections_account_alias_environment_selection_id_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_model_use_grant_current" ADD CONSTRAINT "vertex_model_use_grant_current_grant_version_fk" FOREIGN KEY ("account_alias","environment","grant_id","grant_version") REFERENCES "public"."vertex_model_use_grant_versions"("account_alias","environment","grant_id","grant_version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_model_use_grant_versions" ADD CONSTRAINT "vertex_model_use_grant_versions_account_alias_environment_selection_id_vertex_policy_selections_account_alias_environment_selection_id_fk" FOREIGN KEY ("account_alias","environment","selection_id") REFERENCES "public"."vertex_policy_selections"("account_alias","environment","selection_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_epoch_transitions" ADD CONSTRAINT "vertex_portfolio_epoch_transitions_account_alias_environment_stream_id_vertex_projection_heads_account_alias_environment_stream_id_fk" FOREIGN KEY ("account_alias","environment","stream_id") REFERENCES "public"."vertex_projection_heads"("account_alias","environment","stream_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_epoch_transitions" ADD CONSTRAINT "vertex_portfolio_epoch_transitions_account_alias_environment_snapshot_id_vertex_portfolio_snapshots_account_alias_environment_snapshot_id_fk" FOREIGN KEY ("account_alias","environment","snapshot_id") REFERENCES "public"."vertex_portfolio_snapshots"("account_alias","environment","snapshot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vertex_portfolio_epoch_transitions" ADD CONSTRAINT "vertex_epoch_transition_replay_authorization_fk" FOREIGN KEY ("authorizing_signer_key_sha256","authorizing_approval_id","authorizing_replay_request_sha256") REFERENCES "public"."vertex_native_approval_audit"("signer_key_sha256","approval_id","request_sha256") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "vertex_artifact_object" ON "vertex_artifacts" USING btree ("account_alias","environment","object_key");
--> statement-breakpoint
CREATE INDEX "vertex_artifact_catalog" ON "vertex_artifacts" USING btree ("account_alias","environment","collection_key","contract_name","created_at_ns");
--> statement-breakpoint
CREATE INDEX "vertex_outbox_due" ON "vertex_outbox" USING btree ("account_alias","environment","available_at_ns") WHERE "vertex_outbox"."published_at" is null;
--> statement-breakpoint
CREATE INDEX "vertex_portfolio_latest" ON "vertex_portfolio_snapshots" USING btree ("account_alias","environment","received_at_ns");
--> statement-breakpoint
CREATE INDEX "vertex_review_current" ON "vertex_reviews" USING btree ("account_alias","environment","artifact_id","purpose","reviewed_at_ns");
--> statement-breakpoint
CREATE INDEX "vertex_grant_lookup" ON "vertex_grant_bindings" USING btree ("grantee_actor_id","account_alias","environment","collection_key","resource_id");
--> statement-breakpoint
CREATE INDEX "vertex_reviewed_artifact_lookup" ON "vertex_reviewed_artifact_links" USING btree ("account_alias","environment","collection_key","artifact_id");
--> statement-breakpoint
CREATE INDEX "vertex_native_fact_pending" ON "vertex_native_fact_projections" USING btree ("account_alias","environment","stream_id","applied","owner_epoch","sequence");
--> statement-breakpoint
CREATE INDEX "vertex_native_proof_source" ON "vertex_native_journal_proofs" USING btree ("account_alias","environment","stream_id","owner_epoch","source_event_id");
--> statement-breakpoint
CREATE INDEX "vertex_native_settlement_history" ON "vertex_native_settlements" USING btree ("account_alias","environment","settlement_id","settlement_state");
--> statement-breakpoint
CREATE INDEX "vertex_policy_activation_history" ON "vertex_policy_history" USING btree ("account_alias","environment","selection_id","operation");
--> statement-breakpoint
CREATE INDEX "vertex_policy_open_pins" ON "vertex_policy_ownership_pins" USING btree ("account_alias","environment","selection_id","released_at_ns");
--> statement-breakpoint
CREATE INDEX "notification_authority_current_scope" ON "notification_authority_current" USING btree ("tenant_key","account_alias","environment","record_kind");
--> statement-breakpoint
CREATE INDEX "vertex_epoch_transition_journal" ON "vertex_portfolio_epoch_transitions" USING btree ("account_alias","environment","journal_identity","journal_sequence");
--> statement-breakpoint
CREATE INDEX "vertex_native_approval_request" ON "vertex_native_approval_audit" USING btree ("account_alias","environment","recipient_actor_id","action","request_id");
--> statement-breakpoint
-- Reconcile stale 0004 snapshot with immutable 0005..0007 history: retain columns/checks/authority, rename equivalent workflow FKs, and restore exact generated index ordering.
ALTER TABLE "workflow_runs" RENAME CONSTRAINT "workflow_runs_owner_id_fkey" TO "workflow_runs_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_journal" RENAME CONSTRAINT "workflow_journal_run_id_fkey" TO "workflow_journal_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_snapshots" RENAME CONSTRAINT "workflow_snapshots_run_id_fkey" TO "workflow_snapshots_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_approvals" RENAME CONSTRAINT "workflow_approvals_run_id_fkey" TO "workflow_approvals_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_approvals" RENAME CONSTRAINT "workflow_approvals_decided_by_fkey" TO "workflow_approvals_decided_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_evidence" RENAME CONSTRAINT "workflow_evidence_run_id_fkey" TO "workflow_evidence_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_messages" RENAME CONSTRAINT "workflow_messages_run_id_fkey" TO "workflow_messages_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_messages" RENAME CONSTRAINT "workflow_messages_author_id_fkey" TO "workflow_messages_author_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_run_id_fkey" TO "workflow_omp_resources_run_id_workflow_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_owner_id_fkey" TO "workflow_omp_resources_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_evidence_id_fkey" TO "workflow_omp_resources_evidence_id_workflow_evidence_id_fk";
--> statement-breakpoint
DROP INDEX "workflow_approvals_run_created_idx";
--> statement-breakpoint
CREATE INDEX "workflow_approvals_run_created_idx" ON "workflow_approvals" USING btree ("run_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX "workflow_runs_owner_updated_idx";
--> statement-breakpoint
CREATE INDEX "workflow_runs_owner_updated_idx" ON "workflow_runs" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX "workflow_runs_owner_state_updated_idx";
--> statement-breakpoint
CREATE INDEX "workflow_runs_owner_state_updated_idx" ON "workflow_runs" USING btree ("owner_id","state","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
-- SQL-only immutable epoch evidence and native approval audit protections, copied from preserved source 0018/0019. No duplicate table/column/FK creation.
CREATE FUNCTION vertex_reject_epoch_transition_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Epoch transition assertion evidence is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vertex_epoch_transition_immutable
BEFORE UPDATE OR DELETE ON vertex_portfolio_epoch_transitions
FOR EACH ROW EXECUTE FUNCTION vertex_reject_epoch_transition_mutation();
--> statement-breakpoint
CREATE TRIGGER vertex_epoch_transition_no_truncate
BEFORE TRUNCATE ON vertex_portfolio_epoch_transitions
FOR EACH STATEMENT EXECUTE FUNCTION vertex_reject_epoch_transition_mutation();
--> statement-breakpoint
CREATE FUNCTION vertex_reject_native_approval_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native approval consumption and audit evidence is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vertex_native_approval_audit_immutable
BEFORE UPDATE OR DELETE ON vertex_native_approval_audit
FOR EACH ROW EXECUTE FUNCTION vertex_reject_native_approval_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER vertex_native_approval_audit_no_truncate
BEFORE TRUNCATE ON vertex_native_approval_audit
FOR EACH STATEMENT EXECUTE FUNCTION vertex_reject_native_approval_audit_mutation();
