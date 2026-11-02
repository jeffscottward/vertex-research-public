-- Reversal of 0039_app_role_grants only. Removes the privileges that 0039 granted; it does not
-- touch any other grant. Outside discoverable migrations; Drizzle ledger reconciliation is manual.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    REVOKE SELECT, INSERT, UPDATE ON TABLE "vertex_research_chat_threads" FROM "vertex_research";
    REVOKE SELECT, INSERT ON TABLE "vertex_research_chat_messages" FROM "vertex_research";
    REVOKE SELECT, INSERT ON TABLE "strategy_definition_revisions" FROM "vertex_research";
    REVOKE SELECT, INSERT, UPDATE ON TABLE "assistant_actions" FROM "vertex_research";
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "todos" FROM "vertex_research";
  END IF;
END
$$;
