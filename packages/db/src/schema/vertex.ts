import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Vertex identities are intentionally disjoint from authentication accounts.
// UTC spelling is retained as text; epoch nanoseconds use exact numeric(30,0).
// All decimals remain canonical strings. No table grants execution authority.
const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const collection = () => ({
  ...scope(),
  collectionKey: text("collection_key").notNull(),
});
const ns = (name: string) => numeric(name, { precision: 30, scale: 0 });
const payload = () =>
  jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull();

export const vertexAccounts = pgTable("vertex_accounts", {
  accountId: text("account_id").primaryKey(),
  createdAt: text("created_at").notNull(),
});
export const vertexAccountAliases = pgTable(
  "vertex_account_aliases",
  {
    ...scope(),
    accountId: text("account_id")
      .notNull()
      .references(() => vertexAccounts.accountId),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment] }),
    check(
      "vertex_alias_environment",
      sql`${t.environment} in ('research','paper','live')`
    ),
  ]
);
export const vertexInstruments = pgTable(
  "vertex_instruments",
  {
    ...scope(),
    instrumentId: text("instrument_id").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.instrumentId] }),
  ]
);

export const vertexRightsVersions = pgTable(
  "vertex_rights_versions",
  {
    ...collection(),
    policyId: text("policy_id").notNull(),
    version: text("version").notNull(),
    revision: ns("revision").notNull(),
    status: text("status").notNull(),
    checkedAtNs: ns("checked_at_ns").notNull(),
    expiresAtNs: ns("expires_at_ns"),
    retentionUntilNs: ns("retention_until_ns"),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionKey,
        t.policyId,
        t.version,
      ],
    }),
    uniqueIndex("vertex_rights_revision").on(
      t.accountAlias,
      t.environment,
      t.collectionKey,
      t.policyId,
      t.revision
    ),
    check(
      "vertex_rights_status",
      sql`${t.status} in ('granted','denied','expired','unknown')`
    ),
  ]
);
export const vertexArtifacts = pgTable(
  "vertex_artifacts",
  {
    ...collection(),
    artifactId: text("artifact_id").notNull(),
    objectKey: text("object_key").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    sourceContentSha256: text("source_content_sha256"),
    byteLength: ns("byte_length").notNull(),
    contentType: text("content_type").notNull(),
    contractName: text("contract_name").notNull(),
    schemaVersion: text("schema_version").notNull(),
    rightsPolicyId: text("rights_policy_id").notNull(),
    rightsVersion: text("rights_version").notNull(),
    createdAt: text("created_at").notNull(),
    createdAtNs: ns("created_at_ns").notNull(),
    metadataHash: text("metadata_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.artifactId] }),
    index("vertex_artifact_object").on(
      t.accountAlias,
      t.environment,
      t.objectKey
    ),
    foreignKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionKey,
        t.rightsPolicyId,
        t.rightsVersion,
      ],
      foreignColumns: [
        vertexRightsVersions.accountAlias,
        vertexRightsVersions.environment,
        vertexRightsVersions.collectionKey,
        vertexRightsVersions.policyId,
        vertexRightsVersions.version,
      ],
    }),
    index("vertex_artifact_catalog").on(
      t.accountAlias,
      t.environment,
      t.collectionKey,
      t.contractName,
      t.createdAtNs
    ),
    check(
      "vertex_artifact_digest",
      sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$' and (${t.sourceContentSha256} is null or ${t.sourceContentSha256} ~ '^[0-9a-f]{64}$')`
    ),
    check(
      "vertex_artifact_length",
      sql`${t.byteLength} >= 0 and ${t.byteLength} <= 9007199254740991`
    ),
    check("vertex_artifact_schema", sql`${t.schemaVersion} = '1.0.0'`),
  ]
);
export const vertexArtifactLineage = pgTable(
  "vertex_artifact_lineage",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    parentArtifactId: text("parent_artifact_id").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.artifactId,
        t.parentArtifactId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.parentArtifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);

export const vertexCollections = pgTable(
  "vertex_collections",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    activeSnapshotId: text("active_snapshot_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.collectionId] }),
  ]
);
export const vertexCollectionGenerations = pgTable(
  "vertex_collection_generations",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    previousSnapshotId: text("previous_snapshot_id"),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    shardCount: integer("shard_count").notNull(),
    publishedAt: text("published_at").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      name: "vertex_collection_generations_pkey",
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
    }),
    uniqueIndex("vertex_collection_idempotency").on(
      t.accountAlias,
      t.environment,
      t.collectionId,
      t.idempotencyKey
    ),
    foreignKey({
      name: "vertex_collection_generations_collection_fk",
      columns: [t.accountAlias, t.environment, t.collectionId],
      foreignColumns: [
        vertexCollections.accountAlias,
        vertexCollections.environment,
        vertexCollections.collectionId,
      ],
    }),
    check(
      "vertex_generation_shard_count",
      sql`${t.shardCount} between 1 and 64`
    ),
  ]
);
export const vertexCollectionShards = pgTable(
  "vertex_collection_shards",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    shardOrdinal: integer("shard_ordinal").notNull(),
    importArtifactId: text("import_artifact_id").notNull(),
    importArtifactSha256: text("import_artifact_sha256").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_collection_shards_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.shardOrdinal,
      ],
    }),
    uniqueIndex("vertex_generation_shard_artifact").on(
      t.accountAlias,
      t.environment,
      t.collectionId,
      t.snapshotId,
      t.importArtifactId
    ),
    foreignKey({
      name: "vertex_collection_shards_generation_fk",
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
      foreignColumns: [
        vertexCollectionGenerations.accountAlias,
        vertexCollectionGenerations.environment,
        vertexCollectionGenerations.collectionId,
        vertexCollectionGenerations.snapshotId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.importArtifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);
export const vertexSourceIdentities = pgTable(
  "vertex_source_identities",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    sourceId: text("source_id").notNull(),
    provider: text("provider").notNull(),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      name: "vertex_source_identities_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.sourceId,
      ],
    }),
    foreignKey({
      name: "vertex_source_identities_generation_fk",
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
      foreignColumns: [
        vertexCollectionGenerations.accountAlias,
        vertexCollectionGenerations.environment,
        vertexCollectionGenerations.collectionId,
        vertexCollectionGenerations.snapshotId,
      ],
    }),
  ]
);
export const vertexUnavailableSources = pgTable(
  "vertex_unavailable_sources",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    sourceId: text("source_id").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_unavailable_sources_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.sourceId,
      ],
    }),
    foreignKey({
      name: "vertex_unavailable_sources_generation_fk",
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
      foreignColumns: [
        vertexCollectionGenerations.accountAlias,
        vertexCollectionGenerations.environment,
        vertexCollectionGenerations.collectionId,
        vertexCollectionGenerations.snapshotId,
      ],
    }),
  ]
);
export const vertexDuplicateMappings = pgTable(
  "vertex_duplicate_mappings",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    sourceId: text("source_id").notNull(),
    canonicalSourceId: text("canonical_source_id").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_duplicate_mappings_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.sourceId,
      ],
    }),
    foreignKey({
      name: "vertex_duplicate_mappings_source_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.sourceId,
      ],
      foreignColumns: [
        vertexSourceIdentities.accountAlias,
        vertexSourceIdentities.environment,
        vertexSourceIdentities.collectionId,
        vertexSourceIdentities.snapshotId,
        vertexSourceIdentities.sourceId,
      ],
    }),
    foreignKey({
      name: "vertex_duplicate_mappings_canonical_source_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.canonicalSourceId,
      ],
      foreignColumns: [
        vertexSourceIdentities.accountAlias,
        vertexSourceIdentities.environment,
        vertexSourceIdentities.collectionId,
        vertexSourceIdentities.snapshotId,
        vertexSourceIdentities.sourceId,
      ],
    }),
  ]
);

export const vertexRecords = pgTable(
  "vertex_records",
  {
    ...collection(),
    contractName: text("contract_name").notNull(),
    recordId: text("record_id").notNull(),
    version: text("version").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    recordHash: text("record_hash").notNull(),
    recordedAt: text("recorded_at").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionKey,
        t.contractName,
        t.recordId,
        t.version,
      ],
    }),
    uniqueIndex("vertex_record_artifact").on(
      t.accountAlias,
      t.environment,
      t.artifactId
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);
export const vertexRecordIdempotency = pgTable(
  "vertex_record_idempotency",
  {
    ...collection(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    recordId: text("record_id").notNull(),
    artifactId: text("artifact_id").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionKey,
        t.idempotencyKey,
      ],
    }),
  ]
);
export const vertexRecordRelationships = pgTable(
  "vertex_record_relationships",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    relatedArtifactId: text("related_artifact_id").notNull(),
    relationship: text("relationship").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_record_relationships_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.artifactId,
        t.relatedArtifactId,
        t.relationship,
      ],
    }),
    foreignKey({
      name: "vertex_record_relationships_artifact_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.relatedArtifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);

export const vertexStrategyVersions = pgTable(
  "vertex_strategy_versions",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    version: text("version").notNull(),
    sleeve: text("sleeve").notNull(),
    codeDigest: text("code_digest").notNull(),
    maximumLoss: text("maximum_loss").notNull(),
    maximumNotional: text("maximum_notional").notNull(),
    maximumPositions: ns("maximum_positions").notNull(),
    signalCalendar: text("signal_calendar").notNull(),
    signalInterval: text("signal_interval").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_strategy_versions_pkey",
      columns: [t.accountAlias, t.environment, t.artifactId],
    }),
    foreignKey({
      name: "vertex_strategy_versions_record_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
  ]
);
export const vertexBacktestVersions = pgTable(
  "vertex_backtest_versions",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    runId: text("run_id").notNull(),
    strategyArtifactId: text("strategy_artifact_id").notNull(),
    seed: ns("seed").notNull(),
    engineVersion: text("engine_version").notNull(),
    resultsRef: text("results_ref"),
    reviewStatus: text("review_status").notNull(),
    validationMode: text("validation_mode").notNull(),
    forwardSampleCount: ns("forward_sample_count").notNull(),
    trainingStart: text("training_start").notNull(),
    trainingEnd: text("training_end").notNull(),
    testStart: text("test_start").notNull(),
    testEnd: text("test_end").notNull(),
    benchmark: text("benchmark").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_backtest_versions_pkey",
      columns: [t.accountAlias, t.environment, t.artifactId],
    }),
    foreignKey({
      name: "vertex_backtest_versions_record_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.strategyArtifactId],
      foreignColumns: [
        vertexStrategyVersions.accountAlias,
        vertexStrategyVersions.environment,
        vertexStrategyVersions.artifactId,
      ],
    }),
  ]
);
export const vertexAgentVersions = pgTable(
  "vertex_agent_versions",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    runId: text("run_id").notNull(),
    agentRole: text("agent_role").notNull(),
    taskContract: text("task_contract").notNull(),
    modelVersion: text("model_version"),
    tokenBudget: ns("token_budget").notNull(),
    costBudgetUsd: text("cost_budget_usd").notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.artifactId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
  ]
);
export const vertexModuleVersions = pgTable(
  "vertex_module_versions",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    moduleId: text("module_id").notNull(),
    version: text("version").notNull(),
    inputSchemaVersion: text("input_schema_version").notNull(),
    outputSchemaVersion: text("output_schema_version").notNull(),
    riskPolicyVersion: text("risk_policy_version").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    lifecycleState: text("lifecycle_state").notNull(),
    runtime: text("runtime").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.artifactId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
  ]
);
export const vertexModuleCapabilities = pgTable(
  "vertex_module_capabilities",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_module_capabilities_pkey",
      columns: [t.accountAlias, t.environment, t.artifactId, t.capability],
    }),
    foreignKey({
      name: "vertex_module_capabilities_module_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexModuleVersions.accountAlias,
        vertexModuleVersions.environment,
        vertexModuleVersions.artifactId,
      ],
    }),
  ]
);
export const vertexRecordInstruments = pgTable(
  "vertex_record_instruments",
  {
    ...scope(),
    artifactId: text("artifact_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    relationship: text("relationship").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_record_instruments_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.artifactId,
        t.instrumentId,
        t.relationship,
      ],
    }),
    foreignKey({
      name: "vertex_record_instruments_record_fk",
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexRecords.accountAlias,
        vertexRecords.environment,
        vertexRecords.artifactId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.instrumentId],
      foreignColumns: [
        vertexInstruments.accountAlias,
        vertexInstruments.environment,
        vertexInstruments.instrumentId,
      ],
    }),
  ]
);

export const vertexDatasets = pgTable(
  "vertex_datasets",
  {
    ...collection(),
    datasetId: text("dataset_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    provider: text("provider").notNull(),
    contentHash: text("content_hash").notNull(),
    captureTime: text("capture_time").notNull(),
    asOfAt: text("as_of_at").notNull(),
    storageRef: text("storage_ref").notNull(),
    entitlementPolicyId: text("entitlement_policy_id").notNull(),
    retentionPolicy: text("retention_policy").notNull(),
    dataVintageId: text("data_vintage_id"),
    dataVintageStatus: text("data_vintage_status").notNull(),
    startAtInclusive: text("start_at_inclusive").notNull(),
    endAtExclusive: text("end_at_exclusive").notNull(),
    adjustmentMethod: text("adjustment_method").notNull(),
    calendar: text("calendar"),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.datasetId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
    check(
      "vertex_datasets_unknown_calendar",
      sql`${t.calendar} is not null or (${t.provider} = 'ibkr' and ${t.dataVintageId} is null and ${t.dataVintageStatus} = 'unavailable')`
    ),
  ]
);
export const vertexDatasetSources = pgTable(
  "vertex_dataset_sources",
  {
    ...scope(),
    datasetId: text("dataset_id").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    sourceId: text("source_id").notNull(),
    sourceSnapshotId: text("source_snapshot_id").notNull(),
    provider: text("provider").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.datasetId, t.sourceOrdinal],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.datasetId],
      foreignColumns: [
        vertexDatasets.accountAlias,
        vertexDatasets.environment,
        vertexDatasets.datasetId,
      ],
    }),
  ]
);
export const vertexEvidence = pgTable(
  "vertex_evidence",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    sourceId: text("source_id").notNull(),
    contentHash: text("content_hash").notNull(),
    claim: text("claim").notNull(),
    method: text("method").notNull(),
    acceptanceStatus: text("acceptance_status").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.collectionId, t.evidenceId],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);
export const vertexClaimEvidence = pgTable(
  "vertex_claim_evidence",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    sourceId: text("source_id").notNull(),
    artifactId: text("artifact_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_claim_evidence_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.evidenceId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.collectionId, t.evidenceId],
      foreignColumns: [
        vertexEvidence.accountAlias,
        vertexEvidence.environment,
        vertexEvidence.collectionId,
        vertexEvidence.evidenceId,
      ],
    }),
    foreignKey({
      name: "vertex_claim_evidence_source_fk",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.sourceId,
      ],
      foreignColumns: [
        vertexSourceIdentities.accountAlias,
        vertexSourceIdentities.environment,
        vertexSourceIdentities.collectionId,
        vertexSourceIdentities.snapshotId,
        vertexSourceIdentities.sourceId,
      ],
    }),
  ]
);
export const vertexCollectionDatasets = pgTable(
  "vertex_collection_datasets",
  {
    ...scope(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    datasetId: text("dataset_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_collection_datasets_pkey",
      columns: [
        t.accountAlias,
        t.environment,
        t.collectionId,
        t.snapshotId,
        t.datasetId,
      ],
    }),
    foreignKey({
      name: "vertex_collection_datasets_generation_fk",
      columns: [t.accountAlias, t.environment, t.collectionId, t.snapshotId],
      foreignColumns: [
        vertexCollectionGenerations.accountAlias,
        vertexCollectionGenerations.environment,
        vertexCollectionGenerations.collectionId,
        vertexCollectionGenerations.snapshotId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.datasetId],
      foreignColumns: [
        vertexDatasets.accountAlias,
        vertexDatasets.environment,
        vertexDatasets.datasetId,
      ],
    }),
  ]
);

export const vertexReviews = pgTable(
  "vertex_reviews",
  {
    ...collection(),
    reviewId: text("review_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    actorId: text("actor_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    reviewVersion: text("review_version").notNull(),
    decision: text("decision").notNull(),
    purpose: text("purpose").notNull(),
    reviewedAtNs: ns("reviewed_at_ns").notNull(),
    expiresAtNs: ns("expires_at_ns").notNull(),
    supersedesReviewId: text("supersedes_review_id"),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.reviewId] }),
    uniqueIndex("vertex_review_version").on(
      t.accountAlias,
      t.environment,
      t.artifactId,
      t.purpose,
      t.reviewVersion
    ),
    index("vertex_review_current").on(
      t.accountAlias,
      t.environment,
      t.artifactId,
      t.purpose,
      t.reviewedAtNs
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.artifactId],
      foreignColumns: [
        vertexArtifacts.accountAlias,
        vertexArtifacts.environment,
        vertexArtifacts.artifactId,
      ],
    }),
  ]
);
export const vertexPaperJobs = pgTable(
  "vertex_paper_jobs",
  {
    ...scope(),
    admissionId: text("admission_id").notNull(),
    simulatorId: text("simulator_id").notNull(),
    reviewId: text("review_id").notNull(),
    intentId: text("intent_id").notNull(),
    intentSha256: text("intent_sha256").notNull(),
    portfolioSnapshotId: text("portfolio_snapshot_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    recordHash: text("record_hash").notNull(),
    expiresAtNs: ns("expires_at_ns").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.admissionId] }),
    uniqueIndex("vertex_paper_job_idempotency").on(
      t.accountAlias,
      t.environment,
      t.idempotencyKey
    ),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.reviewId],
      foreignColumns: [
        vertexReviews.accountAlias,
        vertexReviews.environment,
        vertexReviews.reviewId,
      ],
    }),
    check("vertex_paper_only", sql`${t.environment} = 'paper'`),
  ]
);

export const vertexProjectionHeads = pgTable(
  "vertex_projection_heads",
  {
    ...scope(),
    streamId: text("stream_id").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    highWaterSequence: ns("high_water_sequence").notNull(),
    highWaterEventHash: text("high_water_event_hash"),
    lastOccurredAt: text("last_occurred_at"),
    lastReceivedAt: text("last_received_at"),
    expiresAtNs: ns("expires_at_ns"),
    state: text("state").notNull(),
    receivedSequence: ns("received_sequence"),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.streamId] }),
    check(
      "vertex_projection_head_sequence",
      sql`${t.highWaterSequence} >= 0 and ${t.ownerEpoch} > 0`
    ),
  ]
);
export const vertexExecutionProjections = pgTable(
  "vertex_execution_projections",
  {
    ...scope(),
    projectionId: text("projection_id").notNull(),
    streamId: text("stream_id").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    sequence: ns("sequence").notNull(),
    eventHash: text("event_hash").notNull(),
    previousEventHash: text("previous_event_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
    expiresAtNs: ns("expires_at_ns").notNull(),
    applied: boolean("applied").notNull(),
    disposition: text("disposition").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.projectionId] }),
    uniqueIndex("vertex_projection_sequence").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.ownerEpoch,
      t.sequence
    ),
    uniqueIndex("vertex_projection_idempotency").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.idempotencyKey
    ),
    check(
      "vertex_projection_sequence_positive",
      sql`${t.sequence} > 0 and ${t.ownerEpoch} > 0`
    ),
  ]
);
export const vertexReceiptOrders = pgTable(
  "vertex_receipt_orders",
  {
    ...scope(),
    projectionId: text("projection_id").notNull(),
    submissionKey: text("submission_key").notNull(),
    intentId: text("intent_id").notNull(),
    brokerOrderRef: text("broker_order_ref"),
    status: text("status").notNull(),
    totalQuantity: text("total_quantity").notNull(),
    filledQuantity: text("filled_quantity").notNull(),
    remainingQuantity: text("remaining_quantity").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.projectionId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexExecutionProjections.accountAlias,
        vertexExecutionProjections.environment,
        vertexExecutionProjections.projectionId,
      ],
    }),
  ]
);
// Public v1 receipts expose cumulative fills, not invented fill/assignment facts.
export const vertexReceiptFills = pgTable(
  "vertex_receipt_fills",
  {
    ...scope(),
    projectionId: text("projection_id").notNull(),
    submissionKey: text("submission_key").notNull(),
    cumulativeFilledQuantity: text("cumulative_filled_quantity").notNull(),
    lastReconciledAt: text("last_reconciled_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.projectionId] }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.projectionId],
      foreignColumns: [
        vertexExecutionProjections.accountAlias,
        vertexExecutionProjections.environment,
        vertexExecutionProjections.projectionId,
      ],
    }),
  ]
);
export const vertexPortfolioSnapshots = pgTable(
  "vertex_portfolio_snapshots",
  {
    ...scope(),
    snapshotId: text("snapshot_id").notNull(),
    streamId: text("stream_id").notNull(),
    ownerEpoch: ns("owner_epoch").notNull(),
    sequence: ns("sequence").notNull(),
    sourceEventHash: text("source_event_hash").notNull(),
    sourceKind: text("source_kind").notNull(),
    asOfAtNs: ns("as_of_at_ns").notNull(),
    receivedAtNs: ns("received_at_ns").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.snapshotId] }),
    uniqueIndex("vertex_portfolio_sequence").on(
      t.accountAlias,
      t.environment,
      t.streamId,
      t.ownerEpoch,
      t.sequence
    ),
    index("vertex_portfolio_latest").on(
      t.accountAlias,
      t.environment,
      t.receivedAtNs
    ),
  ]
);
export const vertexPortfolioPositions = pgTable(
  "vertex_portfolio_positions",
  {
    ...scope(),
    snapshotId: text("snapshot_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    quantity: text("quantity").notNull(),
    marketValue: text("market_value"),
    costBasis: text("cost_basis"),
    currency: text("currency").notNull(),
    priceAsOf: text("price_as_of"),
    sleeveId: text("sleeve_id"),
  },
  (t) => [
    primaryKey({
      name: "vertex_portfolio_positions_pkey",
      columns: [t.accountAlias, t.environment, t.snapshotId, t.instrumentId],
    }),
    foreignKey({
      name: "vertex_portfolio_positions_snapshot_fk",
      columns: [t.accountAlias, t.environment, t.snapshotId],
      foreignColumns: [
        vertexPortfolioSnapshots.accountAlias,
        vertexPortfolioSnapshots.environment,
        vertexPortfolioSnapshots.snapshotId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.instrumentId],
      foreignColumns: [
        vertexInstruments.accountAlias,
        vertexInstruments.environment,
        vertexInstruments.instrumentId,
      ],
    }),
  ]
);
export const vertexPortfolioLots = pgTable(
  "vertex_portfolio_lots",
  {
    ...scope(),
    snapshotId: text("snapshot_id").notNull(),
    lotId: text("lot_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    quantity: text("quantity").notNull(),
    unitCost: text("unit_cost").notNull(),
    currency: text("currency").notNull(),
    openedAt: text("opened_at").notNull(),
    sourceEventId: text("source_event_id").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.snapshotId, t.lotId],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.snapshotId],
      foreignColumns: [
        vertexPortfolioSnapshots.accountAlias,
        vertexPortfolioSnapshots.environment,
        vertexPortfolioSnapshots.snapshotId,
      ],
    }),
    foreignKey({
      columns: [t.accountAlias, t.environment, t.instrumentId],
      foreignColumns: [
        vertexInstruments.accountAlias,
        vertexInstruments.environment,
        vertexInstruments.instrumentId,
      ],
    }),
  ]
);
export const vertexReservationObservations = pgTable(
  "vertex_reservation_observations",
  {
    ...scope(),
    snapshotId: text("snapshot_id").notNull(),
    reservationId: text("reservation_id").notNull(),
    submissionKey: text("submission_key").notNull(),
    instrumentId: text("instrument_id"),
    cashAmount: text("cash_amount").notNull(),
    shareQuantity: text("share_quantity").notNull(),
    currency: text("currency").notNull(),
    state: text("state").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    authoritative: boolean("authoritative").notNull().default(false),
  },
  (t) => [
    primaryKey({
      name: "vertex_reservation_observations_pkey",
      columns: [t.accountAlias, t.environment, t.snapshotId, t.reservationId],
    }),
    foreignKey({
      name: "vertex_reservation_observations_snapshot_fk",
      columns: [t.accountAlias, t.environment, t.snapshotId],
      foreignColumns: [
        vertexPortfolioSnapshots.accountAlias,
        vertexPortfolioSnapshots.environment,
        vertexPortfolioSnapshots.snapshotId,
      ],
    }),
    check(
      "vertex_reservation_observation_only",
      sql`${t.authoritative} = false`
    ),
  ]
);
export const vertexSleeveObservations = pgTable(
  "vertex_sleeve_observations",
  {
    ...scope(),
    snapshotId: text("snapshot_id").notNull(),
    sleeveId: text("sleeve_id").notNull(),
    allocatedAmount: text("allocated_amount").notNull(),
    currency: text("currency").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    authoritative: boolean("authoritative").notNull().default(false),
  },
  (t) => [
    primaryKey({
      name: "vertex_sleeve_observations_pkey",
      columns: [t.accountAlias, t.environment, t.snapshotId, t.sleeveId],
    }),
    foreignKey({
      name: "vertex_sleeve_observations_snapshot_fk",
      columns: [t.accountAlias, t.environment, t.snapshotId],
      foreignColumns: [
        vertexPortfolioSnapshots.accountAlias,
        vertexPortfolioSnapshots.environment,
        vertexPortfolioSnapshots.snapshotId,
      ],
    }),
    check("vertex_sleeve_observation_only", sql`${t.authoritative} = false`),
  ]
);

export const vertexOutbox = pgTable(
  "vertex_outbox",
  {
    ...collection(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: payload(),
    availableAtNs: ns("available_at_ns").notNull(),
    leaseOwner: text("lease_owner"),
    leaseFence: ns("lease_fence").notNull().default("0"),
    leaseExpiresAt: text("lease_expires_at"),
    leaseExpiresAtNs: ns("lease_expires_at_ns"),
    publishedAt: text("published_at"),
    settlementHash: text("settlement_hash"),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.eventId] }),
    uniqueIndex("vertex_outbox_idempotency").on(
      t.accountAlias,
      t.environment,
      t.collectionKey,
      t.idempotencyKey
    ),
    index("vertex_outbox_due")
      .on(t.accountAlias, t.environment, t.availableAtNs)
      .where(sql`${t.publishedAt} is null`),
    check("vertex_outbox_fence", sql`${t.leaseFence} >= 0`),
    check(
      "vertex_outbox_lease",
      sql`(${t.leaseOwner} is null) = (${t.leaseExpiresAtNs} is null) and (${t.leaseExpiresAt} is null) = (${t.leaseExpiresAtNs} is null)`
    ),
  ]
);
