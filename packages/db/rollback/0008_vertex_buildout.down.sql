-- Guarded reversal of canonical 0008_vertex_buildout only; never the archived hand sources.
-- Refuse ANY row in ANY new table, including immutable lineage/approval audit.
-- Lock first; disable row-security filtering so hidden evidence cannot appear empty.
-- Unknown dependencies, missing objects, or inherited-definition drift fail the transaction.
-- No CASCADE, DELETE, TRUNCATE, IF EXISTS, or immutable-history rewrite.
-- Drizzle ledger reconciliation is deliberately not automated; coordinate it separately
-- before attempting a re-application. This file is outside discoverable migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
LOCK TABLE
"public"."notification_admissions",
"public"."notification_authority_current",
"public"."notification_authority_versions",
"public"."notification_cooldowns",
"public"."vertex_account_aliases",
"public"."vertex_accounts",
"public"."vertex_agent_versions",
"public"."vertex_artifact_lineage",
"public"."vertex_artifacts",
"public"."vertex_backtest_versions",
"public"."vertex_claim_evidence",
"public"."vertex_collection_datasets",
"public"."vertex_collection_generations",
"public"."vertex_collection_shards",
"public"."vertex_collections",
"public"."vertex_command_receipts",
"public"."vertex_dataset_sources",
"public"."vertex_datasets",
"public"."vertex_duplicate_mappings",
"public"."vertex_evidence",
"public"."vertex_execution_projections",
"public"."vertex_grant_actions",
"public"."vertex_grant_bindings",
"public"."vertex_grant_current",
"public"."vertex_grant_versions",
"public"."vertex_instruments",
"public"."vertex_model_use_attempt_identities",
"public"."vertex_model_use_budget_reservations",
"public"."vertex_model_use_budget_windows",
"public"."vertex_model_use_grant_current",
"public"."vertex_model_use_grant_versions",
"public"."vertex_model_use_proof_audits",
"public"."vertex_module_capabilities",
"public"."vertex_module_versions",
"public"."vertex_native_approval_audit",
"public"."vertex_native_checkpoints",
"public"."vertex_native_corporate_actions",
"public"."vertex_native_fact_projections",
"public"."vertex_native_journal_proofs",
"public"."vertex_native_kill_reasons",
"public"."vertex_native_kill_states",
"public"."vertex_native_reconciliations",
"public"."vertex_native_settlement_sources",
"public"."vertex_native_settlements",
"public"."vertex_object_metadata",
"public"."vertex_outbox",
"public"."vertex_paper_jobs",
"public"."vertex_policy_heads",
"public"."vertex_policy_history",
"public"."vertex_policy_ownership_pins",
"public"."vertex_policy_revocations",
"public"."vertex_policy_selections",
"public"."vertex_portfolio_epoch_transitions",
"public"."vertex_portfolio_lots",
"public"."vertex_portfolio_positions",
"public"."vertex_portfolio_snapshots",
"public"."vertex_projection_heads",
"public"."vertex_receipt_fills",
"public"."vertex_receipt_orders",
"public"."vertex_record_idempotency",
"public"."vertex_record_instruments",
"public"."vertex_record_relationships",
"public"."vertex_records",
"public"."vertex_research_proposal_evidence",
"public"."vertex_research_proposals",
"public"."vertex_reservation_observations",
"public"."vertex_reviewed_artifact_links",
"public"."vertex_reviews",
"public"."vertex_rights_versions",
"public"."vertex_sleeve_observations",
"public"."vertex_source_identities",
"public"."vertex_strategy_versions",
"public"."vertex_unavailable_sources",
"public"."vertex_worker_agent_publications",
"public"."vertex_worker_collection_activations",
"public"."vertex_worker_collection_snapshots",
"public"."vertex_worker_jobs",
"public"."vertex_worker_readiness",
"public"."vertex_worker_run_admissions",
"public"."vertex_worker_service_grants",
"public"."vertex_worker_stages",
"public"."workflow_approvals",
"public"."workflow_evidence",
"public"."workflow_journal",
"public"."workflow_messages",
"public"."workflow_omp_resources",
"public"."workflow_runs",
"public"."workflow_snapshots"
IN ACCESS EXCLUSIVE MODE;
DO $vertex_empty_guard$
DECLARE
  relation_name text;
  populated boolean;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'notification_admissions',
    'notification_authority_current',
    'notification_authority_versions',
    'notification_cooldowns',
    'vertex_account_aliases',
    'vertex_accounts',
    'vertex_agent_versions',
    'vertex_artifact_lineage',
    'vertex_artifacts',
    'vertex_backtest_versions',
    'vertex_claim_evidence',
    'vertex_collection_datasets',
    'vertex_collection_generations',
    'vertex_collection_shards',
    'vertex_collections',
    'vertex_command_receipts',
    'vertex_dataset_sources',
    'vertex_datasets',
    'vertex_duplicate_mappings',
    'vertex_evidence',
    'vertex_execution_projections',
    'vertex_grant_actions',
    'vertex_grant_bindings',
    'vertex_grant_current',
    'vertex_grant_versions',
    'vertex_instruments',
    'vertex_model_use_attempt_identities',
    'vertex_model_use_budget_reservations',
    'vertex_model_use_budget_windows',
    'vertex_model_use_grant_current',
    'vertex_model_use_grant_versions',
    'vertex_model_use_proof_audits',
    'vertex_module_capabilities',
    'vertex_module_versions',
    'vertex_native_approval_audit',
    'vertex_native_checkpoints',
    'vertex_native_corporate_actions',
    'vertex_native_fact_projections',
    'vertex_native_journal_proofs',
    'vertex_native_kill_reasons',
    'vertex_native_kill_states',
    'vertex_native_reconciliations',
    'vertex_native_settlement_sources',
    'vertex_native_settlements',
    'vertex_object_metadata',
    'vertex_outbox',
    'vertex_paper_jobs',
    'vertex_policy_heads',
    'vertex_policy_history',
    'vertex_policy_ownership_pins',
    'vertex_policy_revocations',
    'vertex_policy_selections',
    'vertex_portfolio_epoch_transitions',
    'vertex_portfolio_lots',
    'vertex_portfolio_positions',
    'vertex_portfolio_snapshots',
    'vertex_projection_heads',
    'vertex_receipt_fills',
    'vertex_receipt_orders',
    'vertex_record_idempotency',
    'vertex_record_instruments',
    'vertex_record_relationships',
    'vertex_records',
    'vertex_research_proposal_evidence',
    'vertex_research_proposals',
    'vertex_reservation_observations',
    'vertex_reviewed_artifact_links',
    'vertex_reviews',
    'vertex_rights_versions',
    'vertex_sleeve_observations',
    'vertex_source_identities',
    'vertex_strategy_versions',
    'vertex_unavailable_sources',
    'vertex_worker_agent_publications',
    'vertex_worker_collection_activations',
    'vertex_worker_collection_snapshots',
    'vertex_worker_jobs',
    'vertex_worker_readiness',
    'vertex_worker_run_admissions',
    'vertex_worker_service_grants',
    'vertex_worker_stages'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', 'public', relation_name) INTO populated;
    IF populated THEN
      RAISE EXCEPTION 'Refusing Vertex 0008 rollback: table % contains retained data', relation_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$vertex_empty_guard$;

-- Only these exact inherited FK names/relationships and index definitions are reversible.
DO $vertex_inherited_guard$
DECLARE
  binding record;
BEGIN
  FOR binding IN
    SELECT * FROM (VALUES
      ('workflow_runs', 'workflow_runs_owner_id_user_id_fk', 'workflow_runs_owner_id_fkey', 'owner_id', 'user', 'id', 'c'),
      ('workflow_journal', 'workflow_journal_run_id_workflow_runs_id_fk', 'workflow_journal_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'c'),
      ('workflow_snapshots', 'workflow_snapshots_run_id_workflow_runs_id_fk', 'workflow_snapshots_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'c'),
      ('workflow_approvals', 'workflow_approvals_run_id_workflow_runs_id_fk', 'workflow_approvals_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'c'),
      ('workflow_approvals', 'workflow_approvals_decided_by_user_id_fk', 'workflow_approvals_decided_by_fkey', 'decided_by', 'user', 'id', 'a'),
      ('workflow_evidence', 'workflow_evidence_run_id_workflow_runs_id_fk', 'workflow_evidence_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'c'),
      ('workflow_messages', 'workflow_messages_run_id_workflow_runs_id_fk', 'workflow_messages_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'c'),
      ('workflow_messages', 'workflow_messages_author_id_user_id_fk', 'workflow_messages_author_id_fkey', 'author_id', 'user', 'id', 'n'),
      ('workflow_omp_resources', 'workflow_omp_resources_run_id_workflow_runs_id_fk', 'workflow_omp_resources_run_id_fkey', 'run_id', 'workflow_runs', 'id', 'r'),
      ('workflow_omp_resources', 'workflow_omp_resources_owner_id_user_id_fk', 'workflow_omp_resources_owner_id_fkey', 'owner_id', 'user', 'id', 'r'),
      ('workflow_omp_resources', 'workflow_omp_resources_evidence_id_workflow_evidence_id_fk', 'workflow_omp_resources_evidence_id_fkey', 'evidence_id', 'workflow_evidence', 'id', 'r')
    ) AS expected(table_name, current_name, original_name, column_name, target_table, target_column, delete_action)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_attribute local_column ON local_column.attrelid = c.conrelid AND local_column.attname = binding.column_name AND NOT local_column.attisdropped
      JOIN pg_attribute target_column ON target_column.attrelid = c.confrelid AND target_column.attname = binding.target_column AND NOT target_column.attisdropped
      WHERE c.conrelid = to_regclass(format('%I.%I', 'public', binding.table_name))
        AND c.confrelid = to_regclass(format('%I.%I', 'public', binding.target_table))
        AND c.conname = binding.current_name AND c.contype = 'f'
        AND c.conkey = ARRAY[local_column.attnum] AND c.confkey = ARRAY[target_column.attnum]
        AND c.confdeltype::text = binding.delete_action AND c.confupdtype = 'a' AND c.confmatchtype = 's'
        AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
    ) OR EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = to_regclass(format('%I.%I', 'public', binding.table_name)) AND c.conname = binding.original_name
    ) THEN
      RAISE EXCEPTION 'Refusing Vertex 0008 rollback: inherited FK % is not the exact reversible state', binding.current_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
  FOR binding IN
    SELECT * FROM (VALUES
      ('workflow_approvals_run_created_idx', 'workflow_approvals', ARRAY['run_id', 'created_at'], '0 1'),
      ('workflow_runs_owner_updated_idx', 'workflow_runs', ARRAY['owner_id', 'updated_at', 'id'], '0 1 1'),
      ('workflow_runs_owner_state_updated_idx', 'workflow_runs', ARRAY['owner_id', 'state', 'updated_at', 'id'], '0 0 1 1')
    ) AS expected(index_name, table_name, column_names, options)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid JOIN pg_am am ON am.oid = idx.relam
      WHERE i.indexrelid = to_regclass(format('%I.%I', 'public', binding.index_name))
        AND i.indrelid = to_regclass(format('%I.%I', 'public', binding.table_name))
        AND am.amname = 'btree' AND idx.relkind = 'i' AND idx.reloptions IS NULL
        AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
        AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts = cardinality(binding.column_names) AND i.indnkeyatts = i.indnatts
        AND i.indoption::text = binding.options
        AND ARRAY(SELECT attr.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, position)
                  JOIN pg_attribute attr ON attr.attrelid = i.indrelid AND attr.attnum = key.attnum ORDER BY key.position) = binding.column_names
        AND ARRAY(SELECT unnest(i.indcollation::oid[])) =
            ARRAY(SELECT attr.attcollation FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, position)
                  JOIN pg_attribute attr ON attr.attrelid = i.indrelid AND attr.attnum = key.attnum ORDER BY key.position)
        AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS class(oid)
                        JOIN pg_opclass op ON op.oid = class.oid WHERE NOT op.opcdefault OR op.opcmethod <> am.oid)
    ) THEN
      RAISE EXCEPTION 'Refusing Vertex 0008 rollback: inherited index % is not the exact reversible state', binding.index_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$vertex_inherited_guard$;

-- Drop the complete EMPTY new-table set together; cross-table dependencies within
-- that exact set are removable, but dependencies outside it cause RESTRICT failure.
DROP TABLE
"public"."notification_admissions",
"public"."notification_authority_current",
"public"."notification_authority_versions",
"public"."notification_cooldowns",
"public"."vertex_account_aliases",
"public"."vertex_accounts",
"public"."vertex_agent_versions",
"public"."vertex_artifact_lineage",
"public"."vertex_artifacts",
"public"."vertex_backtest_versions",
"public"."vertex_claim_evidence",
"public"."vertex_collection_datasets",
"public"."vertex_collection_generations",
"public"."vertex_collection_shards",
"public"."vertex_collections",
"public"."vertex_command_receipts",
"public"."vertex_dataset_sources",
"public"."vertex_datasets",
"public"."vertex_duplicate_mappings",
"public"."vertex_evidence",
"public"."vertex_execution_projections",
"public"."vertex_grant_actions",
"public"."vertex_grant_bindings",
"public"."vertex_grant_current",
"public"."vertex_grant_versions",
"public"."vertex_instruments",
"public"."vertex_model_use_attempt_identities",
"public"."vertex_model_use_budget_reservations",
"public"."vertex_model_use_budget_windows",
"public"."vertex_model_use_grant_current",
"public"."vertex_model_use_grant_versions",
"public"."vertex_model_use_proof_audits",
"public"."vertex_module_capabilities",
"public"."vertex_module_versions",
"public"."vertex_native_approval_audit",
"public"."vertex_native_checkpoints",
"public"."vertex_native_corporate_actions",
"public"."vertex_native_fact_projections",
"public"."vertex_native_journal_proofs",
"public"."vertex_native_kill_reasons",
"public"."vertex_native_kill_states",
"public"."vertex_native_reconciliations",
"public"."vertex_native_settlement_sources",
"public"."vertex_native_settlements",
"public"."vertex_object_metadata",
"public"."vertex_outbox",
"public"."vertex_paper_jobs",
"public"."vertex_policy_heads",
"public"."vertex_policy_history",
"public"."vertex_policy_ownership_pins",
"public"."vertex_policy_revocations",
"public"."vertex_policy_selections",
"public"."vertex_portfolio_epoch_transitions",
"public"."vertex_portfolio_lots",
"public"."vertex_portfolio_positions",
"public"."vertex_portfolio_snapshots",
"public"."vertex_projection_heads",
"public"."vertex_receipt_fills",
"public"."vertex_receipt_orders",
"public"."vertex_record_idempotency",
"public"."vertex_record_instruments",
"public"."vertex_record_relationships",
"public"."vertex_records",
"public"."vertex_research_proposal_evidence",
"public"."vertex_research_proposals",
"public"."vertex_reservation_observations",
"public"."vertex_reviewed_artifact_links",
"public"."vertex_reviews",
"public"."vertex_rights_versions",
"public"."vertex_sleeve_observations",
"public"."vertex_source_identities",
"public"."vertex_strategy_versions",
"public"."vertex_unavailable_sources",
"public"."vertex_worker_agent_publications",
"public"."vertex_worker_collection_activations",
"public"."vertex_worker_collection_snapshots",
"public"."vertex_worker_jobs",
"public"."vertex_worker_readiness",
"public"."vertex_worker_run_admissions",
"public"."vertex_worker_service_grants",
"public"."vertex_worker_stages"
RESTRICT;
DROP FUNCTION "public"."vertex_reject_epoch_transition_mutation"();
DROP FUNCTION "public"."vertex_reject_native_approval_audit_mutation"();
ALTER TABLE "public"."workflow_runs" RENAME CONSTRAINT "workflow_runs_owner_id_user_id_fk" TO "workflow_runs_owner_id_fkey";
ALTER TABLE "public"."workflow_journal" RENAME CONSTRAINT "workflow_journal_run_id_workflow_runs_id_fk" TO "workflow_journal_run_id_fkey";
ALTER TABLE "public"."workflow_snapshots" RENAME CONSTRAINT "workflow_snapshots_run_id_workflow_runs_id_fk" TO "workflow_snapshots_run_id_fkey";
ALTER TABLE "public"."workflow_approvals" RENAME CONSTRAINT "workflow_approvals_run_id_workflow_runs_id_fk" TO "workflow_approvals_run_id_fkey";
ALTER TABLE "public"."workflow_approvals" RENAME CONSTRAINT "workflow_approvals_decided_by_user_id_fk" TO "workflow_approvals_decided_by_fkey";
ALTER TABLE "public"."workflow_evidence" RENAME CONSTRAINT "workflow_evidence_run_id_workflow_runs_id_fk" TO "workflow_evidence_run_id_fkey";
ALTER TABLE "public"."workflow_messages" RENAME CONSTRAINT "workflow_messages_run_id_workflow_runs_id_fk" TO "workflow_messages_run_id_fkey";
ALTER TABLE "public"."workflow_messages" RENAME CONSTRAINT "workflow_messages_author_id_user_id_fk" TO "workflow_messages_author_id_fkey";
ALTER TABLE "public"."workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_run_id_workflow_runs_id_fk" TO "workflow_omp_resources_run_id_fkey";
ALTER TABLE "public"."workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_owner_id_user_id_fk" TO "workflow_omp_resources_owner_id_fkey";
ALTER TABLE "public"."workflow_omp_resources" RENAME CONSTRAINT "workflow_omp_resources_evidence_id_workflow_evidence_id_fk" TO "workflow_omp_resources_evidence_id_fkey";
DROP INDEX "public"."workflow_approvals_run_created_idx";
CREATE INDEX "workflow_approvals_run_created_idx" ON "public"."workflow_approvals" ("run_id","created_at" DESC);
DROP INDEX "public"."workflow_runs_owner_updated_idx";
CREATE INDEX "workflow_runs_owner_updated_idx" ON "public"."workflow_runs" ("owner_id","updated_at" DESC,"id" DESC);
DROP INDEX "public"."workflow_runs_owner_state_updated_idx";
CREATE INDEX "workflow_runs_owner_state_updated_idx" ON "public"."workflow_runs" ("owner_id","state","updated_at" DESC,"id" DESC);
COMMIT;
