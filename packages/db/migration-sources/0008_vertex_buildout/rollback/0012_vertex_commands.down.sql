-- Never erase committed reviews, research requests or idempotency history.
-- A populated command substrate needs a separate explicit archival plan.
BEGIN;
LOCK TABLE vertex_command_receipts, vertex_reviewed_artifact_links,
  vertex_research_proposals, vertex_research_proposal_evidence IN ACCESS EXCLUSIVE MODE;
DO $vertex_commands_rollback$
BEGIN
  IF EXISTS(SELECT 1 FROM vertex_command_receipts LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_reviewed_artifact_links LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_research_proposals LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_research_proposal_evidence LIMIT 1)
  THEN
    RAISE EXCEPTION 'Vertex command rollback refused: immutable command or review history exists';
  END IF;
END;
$vertex_commands_rollback$;
DROP TABLE vertex_research_proposal_evidence;
DROP TABLE vertex_research_proposals;
DROP TABLE vertex_reviewed_artifact_links;
DROP TABLE vertex_command_receipts;
COMMIT;
