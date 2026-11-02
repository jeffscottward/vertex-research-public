-- Manual rollback is allowed only before any Vertex row is persisted.
-- Imported evidence, reviews, projections and outbox/audit history are retained:
-- nonempty substrate requires an independently approved archival plan, not DROP.
-- No original identity, workflow, audit or outbox relation is touched.
BEGIN;
LOCK TABLE vertex_accounts, vertex_account_aliases, vertex_instruments,
  vertex_rights_versions, vertex_artifacts, vertex_artifact_lineage,
  vertex_collections, vertex_collection_generations, vertex_collection_shards,
  vertex_source_identities, vertex_unavailable_sources, vertex_duplicate_mappings,
  vertex_records, vertex_record_idempotency, vertex_record_relationships,
  vertex_strategy_versions, vertex_backtest_versions, vertex_agent_versions,
  vertex_module_versions, vertex_module_capabilities, vertex_record_instruments,
  vertex_datasets, vertex_dataset_sources, vertex_evidence, vertex_claim_evidence,
  vertex_collection_datasets, vertex_reviews, vertex_paper_jobs,
  vertex_projection_heads, vertex_execution_projections, vertex_receipt_orders,
  vertex_receipt_fills, vertex_portfolio_snapshots, vertex_portfolio_positions,
  vertex_portfolio_lots, vertex_reservation_observations, vertex_sleeve_observations,
  vertex_outbox IN ACCESS EXCLUSIVE MODE;
DO $vertex_rollback$
DECLARE
  relation_name text;
  has_rows boolean;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'vertex_accounts','vertex_account_aliases','vertex_instruments',
    'vertex_rights_versions','vertex_artifacts','vertex_artifact_lineage',
    'vertex_collections','vertex_collection_generations','vertex_collection_shards',
    'vertex_source_identities','vertex_unavailable_sources','vertex_duplicate_mappings',
    'vertex_records','vertex_record_idempotency','vertex_record_relationships',
    'vertex_strategy_versions','vertex_backtest_versions','vertex_agent_versions',
    'vertex_module_versions','vertex_module_capabilities','vertex_record_instruments',
    'vertex_datasets','vertex_dataset_sources','vertex_evidence','vertex_claim_evidence',
    'vertex_collection_datasets','vertex_reviews','vertex_paper_jobs',
    'vertex_projection_heads','vertex_execution_projections','vertex_receipt_orders',
    'vertex_receipt_fills','vertex_portfolio_snapshots','vertex_portfolio_positions',
    'vertex_portfolio_lots','vertex_reservation_observations','vertex_sleeve_observations',
    'vertex_outbox'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', relation_name) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'Vertex rollback refused: persisted history exists; retain substrate and obtain an explicit archival plan';
    END IF;
  END LOOP;
END;
$vertex_rollback$;
DROP TABLE vertex_outbox;
DROP TABLE vertex_sleeve_observations;
DROP TABLE vertex_reservation_observations;
DROP TABLE vertex_portfolio_lots;
DROP TABLE vertex_portfolio_positions;
DROP TABLE vertex_portfolio_snapshots;
DROP TABLE vertex_receipt_fills;
DROP TABLE vertex_receipt_orders;
DROP TABLE vertex_execution_projections;
DROP TABLE vertex_projection_heads;
DROP TABLE vertex_paper_jobs;
DROP TABLE vertex_reviews;
DROP TABLE vertex_collection_datasets;
DROP TABLE vertex_claim_evidence;
DROP TABLE vertex_evidence;
DROP TABLE vertex_dataset_sources;
DROP TABLE vertex_datasets;
DROP TABLE vertex_record_relationships;
DROP TABLE vertex_record_idempotency;
DROP TABLE vertex_record_instruments;
DROP TABLE vertex_module_capabilities;
DROP TABLE vertex_module_versions;
DROP TABLE vertex_agent_versions;
DROP TABLE vertex_backtest_versions;
DROP TABLE vertex_strategy_versions;
DROP TABLE vertex_records;
DROP TABLE vertex_duplicate_mappings;
DROP TABLE vertex_unavailable_sources;
DROP TABLE vertex_source_identities;
DROP TABLE vertex_collection_shards;
DROP TABLE vertex_collection_generations;
DROP TABLE vertex_collections;
DROP TABLE vertex_artifact_lineage;
DROP TABLE vertex_artifacts;
DROP TABLE vertex_rights_versions;
DROP TABLE vertex_instruments;
DROP TABLE vertex_account_aliases;
DROP TABLE vertex_accounts;
COMMIT;
