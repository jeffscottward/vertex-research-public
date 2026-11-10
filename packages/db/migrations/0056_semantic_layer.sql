CREATE TABLE "semantic_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"from_table" text NOT NULL,
	"from_column" text NOT NULL,
	"to_table" text NOT NULL,
	"to_column" text NOT NULL,
	"cardinality" text NOT NULL,
	"description" text NOT NULL,
	"certified" boolean DEFAULT false NOT NULL,
	"certified_at" timestamp with time zone,
	"certified_by" text,
	"certification_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "semantic_relationships_check" CHECK ("semantic_relationships"."id" ~ '^[a-z][a-z0-9_]{1,62}$' and "semantic_relationships"."cardinality" in ('many_to_one', 'one_to_one') and length("semantic_relationships"."description") between 1 and 2000 and (not "semantic_relationships"."certified" or "semantic_relationships"."certified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "semantic_sql_attributes" (
	"id" text PRIMARY KEY NOT NULL,
	"term_id" text NOT NULL,
	"description" text NOT NULL,
	"sql" text NOT NULL,
	"certified" boolean DEFAULT false NOT NULL,
	"certified_at" timestamp with time zone,
	"certified_by" text,
	"certification_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "semantic_sql_attributes_check" CHECK ("semantic_sql_attributes"."id" ~ '^[a-z][a-z0-9_]{1,62}$' and length("semantic_sql_attributes"."sql") between 1 and 8000 and length("semantic_sql_attributes"."description") between 1 and 2000 and (not "semantic_sql_attributes"."certified" or "semantic_sql_attributes"."certified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "semantic_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"feed_path" text,
	"mapped_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" text NOT NULL,
	"params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certified" boolean DEFAULT false NOT NULL,
	"certified_at" timestamp with time zone,
	"certified_by" text,
	"certification_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "semantic_terms_check" CHECK ("semantic_terms"."id" ~ '^[a-z][a-z0-9_]{1,62}$' and "semantic_terms"."source" in ('postgres', 'feed', 'none') and ("semantic_terms"."source" = 'feed') = ("semantic_terms"."feed_path" is not null) and (not "semantic_terms"."certified" or "semantic_terms"."certified_at" is not null) and length("semantic_terms"."label") between 1 and 120 and length("semantic_terms"."description") between 1 and 2000 and length("semantic_terms"."unit") between 1 and 40 and jsonb_typeof("semantic_terms"."synonyms") = 'array' and jsonb_typeof("semantic_terms"."mapped_columns") = 'array' and jsonb_typeof("semantic_terms"."params") = 'array')
);
--> statement-breakpoint
ALTER TABLE "semantic_sql_attributes" ADD CONSTRAINT "semantic_sql_attributes_term_id_semantic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."semantic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_sql_attributes_term_idx" ON "semantic_sql_attributes" USING btree ("term_id");
--> statement-breakpoint
-- Read-only login for certified SQL attributes (docs/vertex-rebuild/agent-semantic-layer.md). The API runs an
-- attribute on its own connection that logs in as "vertex_semantic_reader" (SEMANTIC_DATABASE_URL), inside a
-- READ ONLY transaction. The role gets CONNECT, USAGE on schema public and SELECT on the tables below only:
-- no write privilege, no other table (not "user") and no membership in the app role, so it cannot switch
-- back to the app role. Creating a role needs CREATEROLE: an operator applying this file as a superuser
-- creates it here (NOLOGIN; enable the login with ALTER ROLE ... LOGIN PASSWORD, kept out of git); local
-- and CI servers create it in scripts/ci/rig-postgres.sh. Without the role the API answers "unknown".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader')
    AND (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    CREATE ROLE "vertex_semantic_reader" NOLOGIN NOINHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = 'vertex_semantic_reader') THEN
    RAISE EXCEPTION 'role vertex_semantic_reader must be a plain login: no superuser, bypassrls, createrole, createdb or replication attribute and no membership in another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO "vertex_semantic_reader"', current_database());
    GRANT USAGE ON SCHEMA "public" TO "vertex_semantic_reader";
    GRANT SELECT ON TABLE "strategies", "backtest_runs", "autopilot_campaigns", "autopilot_candidates", "deployment_requests", "forward_drift_monitors" TO "vertex_semantic_reader";
  ELSE
    RAISE WARNING 'role vertex_semantic_reader is missing: certified SQL terms answer unknown until an operator creates it (CREATE ROLE vertex_semantic_reader LOGIN PASSWORD ...) and re-runs these grants';
  END IF;
END
$$;
--> statement-breakpoint
-- App-role privileges, as in 0039_app_role_grants: the app reads the catalog and the operator page edits and
-- certifies it. Terms, attributes and relationships are never deleted by the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
    GRANT SELECT, UPDATE ON TABLE "semantic_terms", "semantic_sql_attributes", "semantic_relationships" TO "vertex_research";
  END IF;
END
$$;
--> statement-breakpoint
-- Seed: the ten terms of docs/vertex-rebuild/agent-semantic-layer.md.
INSERT INTO "semantic_terms" ("id", "label", "description", "synonyms", "source", "feed_path", "mapped_columns", "unit", "params", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('net_liquidation', 'Net liquidation value', 'Net liquidation value (NLV) of the owner''s live IBKR account, from the vertex-portfolio feed (summary.netLiquidation). The QuantVPS exec-node equity in deployment_status is the paper account and is not NLV. Feed down, disconnected or stale: status unknown, never 0.', '["NLV", "net liq", "net liquidation", "account value", "account worth", "account size", "equity"]'::jsonb, 'feed', 'vertex-portfolio summary.netLiquidation', '[]'::jsonb, 'USD', '[]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('open_risk', 'Open options risk', 'Sum of the defined maximum loss of every open option structure in the live account: long option or debit spread = debit paid; defined-width credit spread = width x multiplier x contracts - net credit. Also as a percent of NLV. A short option without a protective long leg has no defined maximum loss, so the total is unknown. Research definition only; it changes no trade or risk setting.', '["open risk", "risk", "money at risk", "at risk in options", "premium at risk", "max loss open", "options exposure"]'::jsonb, 'feed', 'vertex-portfolio positions (option legs)', '[]'::jsonb, 'USD', '[]'::jsonb, true, now(), 'migration 0056', 'Owner decision 2026-11-05 (docs/vertex-rebuild/agent-semantic-layer.md).'),
  ('pnl', 'Account P&L', 'P&L of the owner''s live IBKR account from the vertex-portfolio feed: daily (today), unrealized (open positions) and realized. The exec-node P&L in deployment_status is the paper account.', '["P&L", "PnL", "profit", "loss", "how did I do", "today", "daily P&L", "unrealized P&L", "realized P&L"]'::jsonb, 'feed', 'vertex-portfolio pnl.daily | pnl.unrealized | pnl.realized', '[]'::jsonb, 'USD', '[{"name": "window", "type": "text", "required": false, "description": "One P&L window. Omit for all three.", "options": ["daily", "unrealized", "realized"]}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('position', 'Live position', 'Positions of one symbol in the owner''s live IBKR account from the vertex-portfolio feed: quantity, average price, last price, market value, cost basis and unrealized P&L. Stock and option rows are separate.', '["position", "holding", "shares I own", "how many shares", "what are my shares worth", "options I hold"]'::jsonb, 'feed', 'vertex-portfolio positions', '[]'::jsonb, 'shares or contracts; values in USD', '[{"name": "symbol", "type": "text", "required": true, "description": "Underlying symbol, for example NVDA."}, {"name": "sec_type", "type": "text", "required": false, "description": "STK for shares, OPT for options. Omit for both.", "options": ["STK", "OPT"]}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('crown_copy_leg', 'Crown copy-book legs', 'Crown copy-book legs and their share of NLV. Vertex has no data source for them (crownCopy is only an input flag of the risk allocator). The answer is not available; do not estimate.', '["Crown copy", "Crown copy book", "copy book", "copy legs", "Crown legs"]'::jsonb, 'none', null, '[]'::jsonb, 'count', '[]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('strategy_gate_pass', 'Autopilot gate outcome', 'Autopilot candidates and their gate outcome: passed = status verified, failed = status rejected (autopilot-gate-v1), not_gated = status evaluated (not judged yet; not a failure). in_sample_sharpe is the fitness; oos_sharpe is out-of-sample.', '["passed the gate", "failed the gate", "gate", "verified candidates", "rejected candidates", "autopilot results"]'::jsonb, 'postgres', null, '["autopilot_candidates.status", "autopilot_candidates.fitness", "autopilot_candidates.oos_sharpe", "autopilot_candidates.gated_at", "autopilot_campaigns.name", "autopilot_campaigns.symbol"]'::jsonb, 'Sharpe ratio (annualized)', '[{"name": "campaign", "type": "text", "required": false, "description": "Campaign id, symbol or part of its name. Omit for all campaigns."}, {"name": "outcome", "type": "text", "required": false, "description": "passed, failed or not_gated. Omit for all.", "options": ["passed", "failed", "not_gated"]}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('backtest_sharpe', 'Backtest Sharpe', 'Sharpe of the latest succeeded engine run (backtest_runs) per strategy, sorted best first. Agent notebook records (backtest_results) are excluded. newer_runs_not_succeeded counts newer runs that failed or are still queued or running.', '["Sharpe", "Sharpe ratio", "best backtest", "backtest performance"]'::jsonb, 'postgres', null, '["backtest_runs.report.metrics.sharpe", "backtest_runs.status", "backtest_runs.finished_at", "strategies.name"]'::jsonb, 'Sharpe ratio (annualized)', '[{"name": "strategy", "type": "text", "required": false, "description": "Strategy slug, initials (ORB) or part of its name. Omit for every strategy."}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('backtest_max_drawdown', 'Backtest max drawdown', 'Maximum drawdown of the latest succeeded engine run (backtest_runs) per strategy, in percent. The engine stores report.metrics.maxDrawdownPct as a positive fraction (0.2 = 20%); this term multiplies it by 100. Agent notebook records (backtest_results) are excluded.', '["max drawdown", "drawdown", "worst drawdown", "MDD"]'::jsonb, 'postgres', null, '["backtest_runs.report.metrics.maxDrawdownPct", "backtest_runs.status", "backtest_runs.finished_at", "strategies.name"]'::jsonb, 'percent', '[{"name": "strategy", "type": "text", "required": false, "description": "Strategy slug, initials (ORB) or part of its name. Omit for every strategy."}, {"name": "min_percent", "type": "number", "required": false, "description": "Only drawdowns worse than this percent, for example 20."}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('deployment_request', 'Paper deployment request', 'Paper deployment requests with their strategy, newest decision or request first. requested = waiting for the owner; draft = not submitted; approved and rejected are owner decisions.', '["deployment request", "waiting for me", "approve for paper", "paper trading request", "last approved"]'::jsonb, 'postgres', null, '["deployment_requests.status", "deployment_requests.requested_at", "deployment_requests.decided_at", "strategies.name"]'::jsonb, 'none', '[{"name": "status", "type": "text", "required": false, "description": "One status. Omit for all. requested = waiting for the owner; draft = not submitted.", "options": ["draft", "requested", "approved", "rejected", "withdrawn"]}, {"name": "strategy", "type": "text", "required": false, "description": "Strategy slug, initials (ORB) or part of its name."}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('drift_level', 'Paper forward drift level', 'Drift level of each paper forward monitor against its baseline backtest run. Without a level only warn and alert monitors are listed.', '["drift", "drifting", "forward drift", "drift alert", "drift monitor"]'::jsonb, 'postgres', null, '["forward_drift_monitors.level", "forward_drift_monitors.paper_status", "forward_drift_monitors.label", "strategies.name"]'::jsonb, 'none', '[{"name": "level", "type": "text", "required": false, "description": "ok, warn, alert, insufficient or all. Omit for warn and alert only.", "options": ["all", "ok", "warn", "alert", "insufficient"]}]'::jsonb, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.');
--> statement-breakpoint
INSERT INTO "semantic_sql_attributes" ("id", "term_id", "description", "sql", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('strategy_gate_pass', 'strategy_gate_pass', 'List autopilot candidates with their gate outcome.', $sql$select camp.name as campaign, camp.symbol, cand.label as candidate,
  case cand.status when 'verified' then 'passed' when 'rejected' then 'failed' else 'not_gated' end as gate_outcome,
  cand.fitness as in_sample_sharpe, cand.oos_sharpe, cand.gated_at
from autopilot_candidates cand
join autopilot_campaigns camp on camp.id = cand.campaign_id
where ($1::text is null or camp.id = $1::text or camp.symbol = upper($1::text) or camp.name ilike '%' || $1::text || '%')
  and ($2::text is null or $2::text = case cand.status when 'verified' then 'passed' when 'rejected' then 'failed' else 'not_gated' end)
order by camp.name, gate_outcome, cand.oos_sharpe desc nulls last$sql$, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('backtest_sharpe', 'backtest_sharpe', 'Sharpe of the latest succeeded engine run per strategy.', $sql$with latest as (
  select distinct on (run.strategy_id) run.id, run.strategy_id, run.created_at, run.finished_at, run.engine_version, run.report
  from backtest_runs run
  where run.status = 'succeeded' and run.strategy_id is not null and run.report is not null
  order by run.strategy_id, run.finished_at desc nulls last, run.created_at desc
)
select strat.name as strategy, strat.slug, latest.id as run_id, latest.engine_version, latest.finished_at,
  (latest.report -> 'metrics' ->> 'sharpe')::double precision as sharpe,
  (select count(*) from backtest_runs newer where newer.strategy_id = latest.strategy_id and newer.created_at > latest.created_at and newer.status <> 'succeeded')::integer as newer_runs_not_succeeded
from latest
join strategies strat on strat.id = latest.strategy_id
where ($1::text is null or strat.slug = $1::text or strat.name ilike '%' || $1::text || '%' or regexp_replace(initcap(strat.name), '[^A-Z]', '', 'g') = upper($1::text))
order by sharpe desc nulls last, strat.name$sql$, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('backtest_max_drawdown', 'backtest_max_drawdown', 'Max drawdown in percent of the latest succeeded engine run per strategy.', $sql$with latest as (
  select distinct on (run.strategy_id) run.id, run.strategy_id, run.created_at, run.finished_at, run.engine_version, run.report
  from backtest_runs run
  where run.status = 'succeeded' and run.strategy_id is not null and run.report is not null
  order by run.strategy_id, run.finished_at desc nulls last, run.created_at desc
)
select strat.name as strategy, strat.slug, latest.id as run_id, latest.engine_version, latest.finished_at,
  round((latest.report -> 'metrics' ->> 'maxDrawdownPct')::numeric * 100, 2)::double precision as max_drawdown_percent,
  (select count(*) from backtest_runs newer where newer.strategy_id = latest.strategy_id and newer.created_at > latest.created_at and newer.status <> 'succeeded')::integer as newer_runs_not_succeeded
from latest
join strategies strat on strat.id = latest.strategy_id
where ($1::text is null or strat.slug = $1::text or strat.name ilike '%' || $1::text || '%' or regexp_replace(initcap(strat.name), '[^A-Z]', '', 'g') = upper($1::text))
  and ($2::numeric is null or (latest.report -> 'metrics' ->> 'maxDrawdownPct')::numeric * 100 > $2::numeric)
order by max_drawdown_percent desc nulls last, strat.name$sql$, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('deployment_request', 'deployment_request', 'Paper deployment requests with their strategy and owner decision.', $sql$select req.id, strat.name as strategy, req.symbol, req.timeframe, req.mode, req.status,
  case req.status when 'requested' then 'waiting for the owner' when 'draft' then 'not submitted' when 'approved' then 'approved by the owner' when 'rejected' then 'rejected by the owner' else 'withdrawn' end as meaning,
  req.requested_at, req.decided_at, req.decision_note
from deployment_requests req
join strategies strat on strat.id = req.strategy_id
where ($1::text is null or req.status = $1::text)
  and ($2::text is null or strat.slug = $2::text or strat.name ilike '%' || $2::text || '%' or regexp_replace(initcap(strat.name), '[^A-Z]', '', 'g') = upper($2::text))
order by coalesce(req.decided_at, req.requested_at) desc nulls last, req.id$sql$, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.'),
  ('drift_level', 'drift_level', 'Paper forward drift monitors by level.', $sql$select mon.label as monitor, strat.name as strategy, mon.level, mon.paper_status, mon.baseline_run_id, mon.updated_at
from forward_drift_monitors mon
left join backtest_runs run on run.id = mon.baseline_run_id
left join strategies strat on strat.id = run.strategy_id
where case when $1::text is null then mon.level in ('warn', 'alert') when $1::text = 'all' then true else mon.level = $1::text end
order by case mon.level when 'alert' then 0 when 'warn' then 1 when 'insufficient' then 2 else 3 end, mon.label$sql$, true, now(), 'migration 0056', 'Definition reviewed in PR #22 (docs/vertex-rebuild/agent-semantic-layer.md) and in the build PR; owner chose option (b) on 2026-11-05.');
--> statement-breakpoint
INSERT INTO "semantic_relationships" ("id", "from_table", "from_column", "to_table", "to_column", "cardinality", "description", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('backtest_runs_strategy', 'backtest_runs', 'strategy_id', 'strategies', 'id', 'many_to_one', 'Engine backtest run to its strategy. Engine runs are the source for backtest metrics.', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.'),
  ('backtest_results_strategy', 'backtest_results', 'strategy_id', 'strategies', 'id', 'many_to_one', 'Agent notebook backtest record to its strategy. Not an engine run: free-form metric keys and a negative max_drawdown; never use it for certified backtest metrics.', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.'),
  ('autopilot_candidates_campaign', 'autopilot_candidates', 'campaign_id', 'autopilot_campaigns', 'id', 'many_to_one', 'Autopilot candidate to the campaign that bred it.', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.'),
  ('autopilot_candidates_strategy', 'autopilot_candidates', 'strategy_id', 'strategies', 'id', 'many_to_one', 'Verified autopilot candidate to the strategy promoted from it (null until promoted).', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.'),
  ('deployment_requests_strategy', 'deployment_requests', 'strategy_id', 'strategies', 'id', 'many_to_one', 'Paper deployment request to its strategy.', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.'),
  ('forward_drift_monitors_baseline_run', 'forward_drift_monitors', 'baseline_run_id', 'backtest_runs', 'id', 'many_to_one', 'Paper forward drift monitor to the engine run it is compared with.', true, now(), 'migration 0056', 'Foreign key in the Vertex schema; reviewed in the semantic-layer build PR.');
