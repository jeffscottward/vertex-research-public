-- Synthetic, fictional Vertex research data for the semantic-layer prototype.
-- Schema: the real Vertex migrations 0000-0048 (applied before this file).
-- No production or account data. Every name, id and number here is invented.
begin;

insert into "user"(id, name, email, email_verified, role) values
  ('u_owner', 'Fictional Owner', 'owner@vertex.test', true, 'admin');

insert into strategies(id, slug, name, kind, status, tags, params) values
  ('s_orb', 'opening-range-breakout', 'Opening Range Breakout', 'native', 'paper', '[]', '[]'),
  ('s_mr',  'rsi-mean-reversion',     'RSI Mean Reversion',     'native', 'backtested', '[]', '[]'),
  ('s_mom', 'sector-momentum',        'Sector Momentum',        'native', 'live_candidate', '[]', '[]'),
  ('s_vix', 'vix-term-structure',     'VIX Term Structure',     'python', 'researching', '[]', '[]'),
  ('s_gap', 'gap-fade',               'Gap Fade',               'native', 'retired', '[]', '[]');

-- Engine runs. report.metrics.maxDrawdownPct is a positive FRACTION despite its name (0.2 = 20%; packages/api/src/backtest-run-report.ts); sharpe is annualized.
insert into backtest_runs(id, status, strategy_id, spec, engine_version, requested_by, error, report, created_at, finished_at) values
  ('br_orb_1', 'succeeded', 's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.4', 'u_owner', null,
   '{"metrics":{"sharpe":1.10,"maxDrawdownPct":0.142,"totalReturn":0.183,"totalTrades":212,"winRate":0.54}}', '2026-10-01T14:00Z', '2026-10-01T14:03Z'),
  ('br_orb_2', 'succeeded', 's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":0.82,"maxDrawdownPct":0.189,"totalReturn":0.121,"totalTrades":240,"winRate":0.52}}', '2026-10-20T14:00Z', '2026-10-20T14:04Z'),
  ('br_orb_3', 'failed',    's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.5', 'u_owner', 'bars missing for 2026-10-31', null, '2026-11-01T14:00Z', '2026-11-01T14:01Z'),
  ('br_mr_1',  'succeeded', 's_mr',  '{"symbol":"QQQ","timeframe":"1h"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":1.45,"maxDrawdownPct":0.098,"totalReturn":0.264,"totalTrades":96,"winRate":0.61}}', '2026-10-15T14:00Z', '2026-10-15T14:02Z'),
  ('br_mom_1', 'succeeded', 's_mom', '{"symbol":"XLK","timeframe":"1d"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":1.31,"maxDrawdownPct":0.225,"totalReturn":0.402,"totalTrades":58,"winRate":0.57}}', '2026-10-28T14:00Z', '2026-10-28T14:06Z'),
  ('br_vix_1', 'queued',    's_vix', '{"symbol":"VIXY","timeframe":"1d"}', 'vx-engine-1.5', 'u_owner', null, null, '2026-11-04T14:00Z', null);

-- Agent-recorded backtests. metrics keys are free-form; max_drawdown is a negative fraction.
insert into agent_tasks(id, kind, agent, title, status, metrics, links) values
  ('t_bt_1', 'backtest', 'research-agent', 'ORB in-sample sweep', 'succeeded', '{}', '[]'),
  ('t_bt_2', 'backtest', 'research-agent', 'Sector momentum notebook', 'succeeded', '{}', '[]');
insert into backtest_results(id, task_id, strategy, instruments, period_start, period_end, data_source, metrics, equity, drawdown, max_drawdown, trades, trade_count, folds, strategy_id, created_at) values
  ('bt_orb_nb', 't_bt_1', 'ORB 15m in-sample', 'SPY', '2023-01-01', '2025-12-31', 'notebook', '{"sharpe_ratio":1.9,"cagr":0.21}', '[]', '[]', -0.11, '[]', 0, '[]', 's_orb', '2026-09-12T10:00Z'),
  ('bt_mom_nb', 't_bt_2', 'Sector momentum v0', 'XLK,XLF,XLE', '2020-01-01', '2025-12-31', 'notebook', '{"Sharpe":1.62,"CAGR":0.17}', '[]', '[]', -0.27, '[]', 0, '[]', 's_mom', '2026-09-30T10:00Z');

-- Autopilot. status: evaluated = not gated yet, rejected = failed autopilot-gate-v1, verified = passed.
-- fitness = in-sample Sharpe; oos_sharpe = out-of-sample Sharpe from the gate.
insert into autopilot_campaigns(id, name, symbol, timeframe, status, config, created_by, candidate_count, gated_count, verified_count) values
  ('c_spy', 'SPY 1h breed', 'SPY', '1h', 'completed', '{}', 'u_owner', 5, 4, 2),
  ('c_qqq', 'QQQ 1d breed', 'QQQ', '1d', 'running',   '{}', 'u_owner', 2, 1, 0);
insert into autopilot_candidates(id, campaign_id, label, genome, genome_key, definition, in_sample, parent_ids, generation, origin, series, first_t, last_t, returns_count, returns_mean, returns_std, fitness, oos_sharpe, status, gate, gated_at, strategy_id) values
  ('a1', 'c_spy', 'SPY sma-cross 20/50', '{}', 'k1', '{}', '{}', '[]', 3, 'crossover', 'SPY:1h', '2021-01-01Z', '2026-10-01Z', 400, 0.0004, 0.01, 1.40, 0.91, 'verified', '{"passed":true}', '2026-10-21Z', null),
  ('a2', 'c_spy', 'SPY rsi14 below 30',  '{}', 'k2', '{}', '{}', '[]', 2, 'mutation',  'SPY:1h', '2021-01-01Z', '2026-10-01Z', 380, 0.0003, 0.01, 1.10, 0.63, 'verified', '{"passed":true}', '2026-10-21Z', null),
  ('a3', 'c_spy', 'SPY breakout 55',     '{}', 'k3', '{}', '{}', '[]', 4, 'mutation',  'SPY:1h', '2021-01-01Z', '2026-10-01Z', 410, 0.0005, 0.01, 1.85, 0.21, 'rejected', '{"passed":false,"failed":["oosSharpe"]}', '2026-10-21Z', null),
  ('a4', 'c_spy', 'SPY bollinger 20/2',  '{}', 'k4', '{}', '{}', '[]', 1, 'random',    'SPY:1h', '2021-01-01Z', '2026-10-01Z', 300, 0.0002, 0.01, 1.20, 0.48, 'rejected', '{"passed":false,"failed":["oosSharpe","monteCarlo"]}', '2026-10-21Z', null),
  ('a5', 'c_spy', 'SPY macd 12/26',      '{}', 'k5', '{}', '{}', '[]', 4, 'crossover', 'SPY:1h', '2021-01-01Z', '2026-10-01Z', 350, 0.0004, 0.01, 1.60, null, 'evaluated', null, null, null),
  ('a6', 'c_qqq', 'QQQ donchian 20',     '{}', 'k6', '{}', '{}', '[]', 1, 'random',    'QQQ:1d', '2018-01-01Z', '2026-10-01Z', 120, 0.0006, 0.02, 0.95, 0.12, 'rejected', '{"passed":false,"failed":["forwardFolds"]}', '2026-11-02Z', null),
  ('a7', 'c_qqq', 'QQQ sma 10/40',       '{}', 'k7', '{}', '{}', '[]', 1, 'random',    'QQQ:1d', '2018-01-01Z', '2026-10-01Z', 110, 0.0005, 0.02, 0.80, null, 'evaluated', null, null, null);

-- Paper deployment requests. requested = waiting for the owner; draft = not submitted.
insert into deployment_requests(id, strategy_id, params, symbol, timeframe, mode, limits, status, requested_by, requested_at, decided_by, decided_at, decision_note) values
  ('d1', 's_orb', '{}', 'SPY', '5m', 'paper', '{"maxOrderSize":10,"maxPosition":50,"maxOrdersPerMinute":5,"dailyLossLimit":500}', 'requested', 'u_owner', '2026-11-04T15:00Z', null, null, null),
  ('d2', 's_mom', '{}', 'XLK', '1d', 'paper', '{"maxOrderSize":20,"maxPosition":100,"maxOrdersPerMinute":2,"dailyLossLimit":800}', 'approved', 'u_owner', '2026-10-29T15:00Z', 'u_owner', '2026-10-30T13:00Z', null),
  ('d3', 's_mr',  '{}', 'QQQ', '1h', 'paper', '{"maxOrderSize":10,"maxPosition":40,"maxOrdersPerMinute":5,"dailyLossLimit":400}', 'rejected', 'u_owner', '2026-10-24T15:00Z', 'u_owner', '2026-10-25T13:00Z', 'Drawdown too close to the limit'),
  ('d4', 's_vix', '{}', 'VIXY', '1d', 'paper', '{"maxOrderSize":5,"maxPosition":20,"maxOrdersPerMinute":2,"dailyLossLimit":300}', 'draft', 'u_owner', null, null, null, null);

-- Paper forward drift monitors. level: ok, warn, alert, insufficient.
insert into forward_drift_monitors(id, label, baseline_run_id, thresholds, level, created_by, paper_status) values
  ('m_orb', 'ORB paper forward',             'br_orb_2', '{}', 'alert', 'u_owner', 'running'),
  ('m_mom', 'Sector momentum paper forward', 'br_mom_1', '{}', 'warn',  'u_owner', 'running'),
  ('m_mr',  'RSI MR paper forward',          'br_mr_1',  '{}', 'ok',    'u_owner', 'off');
commit;
