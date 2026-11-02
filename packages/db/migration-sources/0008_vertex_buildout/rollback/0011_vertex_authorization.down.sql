-- Refuse to erase any grant, revocation, privilege-actor record or current
-- pointer. Populated authorization history requires a separately approved
-- archival plan. This rollback touches only the four new authorization tables.
BEGIN;
LOCK TABLE vertex_grant_bindings, vertex_grant_versions, vertex_grant_actions,
  vertex_grant_current IN ACCESS EXCLUSIVE MODE;
DO $vertex_authorization_rollback$
BEGIN
  IF EXISTS(SELECT 1 FROM vertex_grant_bindings LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_grant_versions LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_grant_actions LIMIT 1)
    OR EXISTS(SELECT 1 FROM vertex_grant_current LIMIT 1)
  THEN
    RAISE EXCEPTION 'Vertex authorization rollback refused: retained grant history is populated';
  END IF;
END;
$vertex_authorization_rollback$;
DROP TABLE vertex_grant_current;
DROP TABLE vertex_grant_actions;
DROP TABLE vertex_grant_versions;
DROP TABLE vertex_grant_bindings;
COMMIT;
