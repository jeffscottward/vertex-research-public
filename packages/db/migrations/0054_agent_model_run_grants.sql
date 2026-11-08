-- App-role privileges for the agent model-run ledger (card vertex-glassbench-app-grants).
-- 0037 and 0038 created these tables without grants, and 0039 did not list them. When migrations run
-- as the app role, the app role owns both tables and this file changes nothing. When an operator
-- applies migrations as another role, the app role "vertex_research" gets only the privileges the
-- agent-model-runs repository uses: runs are recorded, read, row-locked for event appends and
-- updated (flags, status); events are appended and read. Neither table is deleted from by the app.
-- The backtest rating column (0036) is a column on "backtest_results"; table privileges cover new
-- columns, so it needs no grant of its own. On the live database (2026-11-08) the app role owns
-- "backtest_results", "agent_model_runs" and "agent_model_run_events", so this file changes nothing there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "agent_model_runs" TO "vertex_research";
    GRANT SELECT, INSERT ON TABLE "agent_model_run_events" TO "vertex_research";
  END IF;
END
$$;
