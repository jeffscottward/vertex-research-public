DROP INDEX "semantic_sql_attributes_term_idx";--> statement-breakpoint
ALTER TABLE "semantic_sql_attributes" ADD COLUMN "grain" text DEFAULT 'strategy' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_sql_attributes_term_grain_idx" ON "semantic_sql_attributes" USING btree ("term_id","grain");--> statement-breakpoint
ALTER TABLE "semantic_sql_attributes" ADD CONSTRAINT "semantic_sql_attributes_grain_check" CHECK ("semantic_sql_attributes"."grain" in ('strategy', 'run_spec', 'candidate', 'request', 'monitor'));--> statement-breakpoint
-- Fill the new column for the 0056 attributes: what one row stands for. Only "grain" changes: their SQL,
-- certification, updated_at and updated_by stay as they are.
UPDATE "semantic_sql_attributes" SET "grain" = CASE "id" WHEN 'strategy_gate_pass' THEN 'candidate' WHEN 'deployment_request' THEN 'request' WHEN 'drift_level' THEN 'monitor' ELSE "grain" END WHERE "id" IN ('strategy_gate_pass', 'deployment_request', 'drift_level');--> statement-breakpoint
-- Engine runs without a strategy (docs/vertex-rebuild/agent-semantic-layer.md, card vertex-semantic-unlinked-runs).
-- backtest_sharpe and backtest_max_drawdown keep their certified per-strategy SQL (grain strategy, migration 0056,
-- unchanged). Each gets a second SQL attribute with grain run_spec: the latest succeeded engine run per run spec
-- (symbol, timeframe, rule, stop loss, take profit, cost and date range: runs that differ in any of them are
-- different backtests, for example sweep cells) over runs whose strategy_id is null. Both rows are NOT certified: the agent wrote them,
-- the owner reviews and certifies them on /semantic-terms. Until then the API runs only the certified per-strategy
-- SQL and says that the run-spec SQL waits for certification. $1 and $2 bind the term's existing parameters
-- (strategy, min_percent); strategy matches the strategy name stored on the run, the DSL definition name or the symbol.
INSERT INTO "semantic_sql_attributes" ("id", "term_id", "grain", "description", "sql", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('backtest_sharpe_run_spec', 'backtest_sharpe', 'run_spec', 'Sharpe of the latest succeeded engine run per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for runs with no strategy.', $sql$with runs as (
  select run.id, run.created_at, run.finished_at, run.engine_version, run.report -> 'metrics' as metrics,
    run.strategy_snapshot ->> 'name' as snapshot_name, run.strategy_snapshot ->> 'slug' as snapshot_slug,
    run.spec ->> 'symbol' as symbol, run.spec ->> 'timeframe' as timeframe, run.spec -> 'rule' as rule,
    run.spec ->> 'stopLossPct' as stop_loss_pct, run.spec ->> 'takeProfitPct' as take_profit_pct,
    run.spec ->> 'costBps' as cost_bps, run.spec ->> 'from' as date_from, run.spec ->> 'to' as date_to
  from backtest_runs run
  where run.status = 'succeeded' and run.strategy_id is null and run.report is not null
), latest as (
  select distinct on (runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to) runs.*,
    count(*) over (partition by runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to)::integer as succeeded_runs_in_spec,
    coalesce(runs.snapshot_name, runs.rule -> 'definition' ->> 'name') as strategy_name
  from runs
  order by runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to, runs.finished_at desc nulls last, runs.created_at desc
)
select latest.symbol, latest.timeframe,
  case latest.rule ->> 'kind'
    when 'smaCross' then 'smaCross fast ' || (latest.rule ->> 'fast') || ' slow ' || (latest.rule ->> 'slow')
    when 'breakout' then 'breakout entry ' || (latest.rule ->> 'entryLookback') || ' exit ' || (latest.rule ->> 'exitLookback') || case when (latest.rule ->> 'trendSma') in ('0', '0.0') then ' no trend filter' else ' trend SMA ' || (latest.rule ->> 'trendSma') end
    when 'dsl' then 'dsl ' || coalesce(latest.rule -> 'definition' ->> 'name', 'definition')
    else coalesce(latest.rule ->> 'kind', 'unknown')
  end as rule,
  latest.stop_loss_pct::double precision as stop_loss_pct, latest.take_profit_pct::double precision as take_profit_pct,
  latest.cost_bps::double precision as cost_bps, latest.date_from, latest.date_to,
  latest.strategy_name as strategy_on_run, latest.id as run_id, latest.engine_version, latest.finished_at,
  (latest.metrics ->> 'sharpe')::double precision as sharpe,
  latest.succeeded_runs_in_spec,
  (select count(*) from backtest_runs newer where newer.strategy_id is null and newer.spec ->> 'symbol' = latest.symbol and newer.spec ->> 'timeframe' = latest.timeframe and newer.spec -> 'rule' = latest.rule and newer.spec ->> 'stopLossPct' is not distinct from latest.stop_loss_pct and newer.spec ->> 'takeProfitPct' is not distinct from latest.take_profit_pct and newer.spec ->> 'costBps' is not distinct from latest.cost_bps and newer.spec ->> 'from' is not distinct from latest.date_from and newer.spec ->> 'to' is not distinct from latest.date_to and newer.created_at > latest.created_at and newer.status <> 'succeeded')::integer as newer_runs_not_succeeded
from latest
where ($1::text is null or upper(latest.symbol) = upper($1::text) or latest.snapshot_slug = $1::text or latest.strategy_name ilike '%' || $1::text || '%' or regexp_replace(initcap(latest.strategy_name), '[^A-Z]', '', 'g') = upper($1::text))
order by sharpe desc nulls last, latest.symbol, rule, latest.id$sql$, false, null, null, 'Needs owner certification: written by the agent in migration 0058 (card vertex-semantic-unlinked-runs); not certified by the agent.'),
  ('backtest_max_drawdown_run_spec', 'backtest_max_drawdown', 'run_spec', 'Max drawdown in percent of the latest succeeded engine run per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for runs with no strategy.', $sql$with runs as (
  select run.id, run.created_at, run.finished_at, run.engine_version, run.report -> 'metrics' as metrics,
    run.strategy_snapshot ->> 'name' as snapshot_name, run.strategy_snapshot ->> 'slug' as snapshot_slug,
    run.spec ->> 'symbol' as symbol, run.spec ->> 'timeframe' as timeframe, run.spec -> 'rule' as rule,
    run.spec ->> 'stopLossPct' as stop_loss_pct, run.spec ->> 'takeProfitPct' as take_profit_pct,
    run.spec ->> 'costBps' as cost_bps, run.spec ->> 'from' as date_from, run.spec ->> 'to' as date_to
  from backtest_runs run
  where run.status = 'succeeded' and run.strategy_id is null and run.report is not null
), latest as (
  select distinct on (runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to) runs.*,
    count(*) over (partition by runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to)::integer as succeeded_runs_in_spec,
    coalesce(runs.snapshot_name, runs.rule -> 'definition' ->> 'name') as strategy_name
  from runs
  order by runs.symbol, runs.timeframe, runs.rule, runs.stop_loss_pct, runs.take_profit_pct, runs.cost_bps, runs.date_from, runs.date_to, runs.finished_at desc nulls last, runs.created_at desc
)
select latest.symbol, latest.timeframe,
  case latest.rule ->> 'kind'
    when 'smaCross' then 'smaCross fast ' || (latest.rule ->> 'fast') || ' slow ' || (latest.rule ->> 'slow')
    when 'breakout' then 'breakout entry ' || (latest.rule ->> 'entryLookback') || ' exit ' || (latest.rule ->> 'exitLookback') || case when (latest.rule ->> 'trendSma') in ('0', '0.0') then ' no trend filter' else ' trend SMA ' || (latest.rule ->> 'trendSma') end
    when 'dsl' then 'dsl ' || coalesce(latest.rule -> 'definition' ->> 'name', 'definition')
    else coalesce(latest.rule ->> 'kind', 'unknown')
  end as rule,
  latest.stop_loss_pct::double precision as stop_loss_pct, latest.take_profit_pct::double precision as take_profit_pct,
  latest.cost_bps::double precision as cost_bps, latest.date_from, latest.date_to,
  latest.strategy_name as strategy_on_run, latest.id as run_id, latest.engine_version, latest.finished_at,
  round((latest.metrics ->> 'maxDrawdownPct')::numeric * 100, 2)::double precision as max_drawdown_percent,
  latest.succeeded_runs_in_spec,
  (select count(*) from backtest_runs newer where newer.strategy_id is null and newer.spec ->> 'symbol' = latest.symbol and newer.spec ->> 'timeframe' = latest.timeframe and newer.spec -> 'rule' = latest.rule and newer.spec ->> 'stopLossPct' is not distinct from latest.stop_loss_pct and newer.spec ->> 'takeProfitPct' is not distinct from latest.take_profit_pct and newer.spec ->> 'costBps' is not distinct from latest.cost_bps and newer.spec ->> 'from' is not distinct from latest.date_from and newer.spec ->> 'to' is not distinct from latest.date_to and newer.created_at > latest.created_at and newer.status <> 'succeeded')::integer as newer_runs_not_succeeded
from latest
where ($1::text is null or upper(latest.symbol) = upper($1::text) or latest.snapshot_slug = $1::text or latest.strategy_name ilike '%' || $1::text || '%' or regexp_replace(initcap(latest.strategy_name), '[^A-Z]', '', 'g') = upper($1::text))
  and ($2::numeric is null or (latest.metrics ->> 'maxDrawdownPct')::numeric * 100 > $2::numeric)
order by max_drawdown_percent desc nulls last, latest.symbol, rule, latest.id$sql$, false, null, null, 'Needs owner certification: written by the agent in migration 0058 (card vertex-semantic-unlinked-runs); not certified by the agent.');
