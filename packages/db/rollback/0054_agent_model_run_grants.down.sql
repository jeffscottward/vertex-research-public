-- Reversal of 0054_agent_model_run_grants only. Removes the privileges that 0054 granted; it does not
-- touch any other grant. Outside discoverable migrations; Drizzle ledger reconciliation is manual.
-- A table the app role owns got nothing from 0054 (an owner already has every privilege), and an
-- owner may revoke its own privileges, so such a table is skipped: revoking there would lock the app
-- out of its own table. The live database (vertex-postgres, 2026-11-08) is in that case.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = 'public.agent_model_run_events'::regclass
        AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'vertex_research')
    ) THEN
      REVOKE SELECT, INSERT ON TABLE "agent_model_run_events" FROM "vertex_research";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = 'public.agent_model_runs'::regclass
        AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'vertex_research')
    ) THEN
      REVOKE SELECT, INSERT, UPDATE ON TABLE "agent_model_runs" FROM "vertex_research";
    END IF;
  END IF;
END
$$;
