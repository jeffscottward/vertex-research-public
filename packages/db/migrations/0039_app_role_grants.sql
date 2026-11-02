-- App-role privileges for tables the web app reads or writes (card vertex-db-app-grants).
-- When migrations run as the app role, the app role owns these tables and this file changes nothing.
-- When an operator applies migrations as another role, the app role "vertex_research" gets only the
-- privileges its repositories use. The research-chat copy tables, the copy cleanup intents and the
-- worker experiment publications stay without grants on purpose (source-only slices).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todos" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "assistant_actions" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "strategy_definition_revisions" TO "vertex_research";
    GRANT SELECT, INSERT, UPDATE ON TABLE "vertex_research_chat_threads" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "vertex_research_chat_messages" TO "vertex_research";
  END IF;
END
$$;
