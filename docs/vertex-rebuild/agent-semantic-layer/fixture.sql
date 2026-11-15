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
-- The baseline runs of the drift monitors (br_orb_2, br_mr_1, br_mom_1) also have what the five drift
-- checks compare with: a profit factor (with gross profit, gross loss, net profit and final equity that
-- agree with it and with totalReturn), a longest losing streak with its money, and report.equity, a chart
-- series of 24 quarterly points from 2021-01-01 to 2026-09-30 (t in epoch milliseconds) whose total
-- return and max drawdown are the metrics of the run. grossLoss and the streak money are negative, as
-- the engine stores them. profitTrades and lossTrades are totalTrades split by winRate; maxDrawdownAbs
-- and absoluteDrawdown are those of the series. All other fields of these three reports stay
-- at the defaults (for example cagr, sortino, recoveryFactor, maxConsecutiveWins, bars, trades); no drift
-- check reads them. tests/integration/semantic-layer/drift-tools.test.ts compares the series with the
-- metrics. The other runs keep the defaults of the update at the end of this file.
insert into backtest_runs(id, status, strategy_id, spec, engine_version, requested_by, error, report, created_at, finished_at) values
  ('br_orb_1', 'succeeded', 's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.4', 'u_owner', null,
   '{"metrics":{"sharpe":1.10,"maxDrawdownPct":0.142,"totalReturn":0.183,"totalTrades":212,"winRate":0.54}}', '2026-10-01T14:00Z', '2026-10-01T14:03Z'),
  ('br_orb_2', 'succeeded', 's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":0.82,"maxDrawdownPct":0.189,"totalReturn":0.121,"totalTrades":240,"winRate":0.52,
     "profitFactor":1.2,"grossProfit":72600,"grossLoss":-60500,"netProfit":12100,"finalEquity":112100,"maxConsecutiveLosses":6,"maxConsecutiveLossesMoney":-2140,"maximalConsecutiveLoss":-2140,"maximalConsecutiveLossCount":6,
     "profitTrades":125,"lossTrades":115,"maxDrawdownAbs":22302,"absoluteDrawdown":4302},
    "equity":[
     {"drawdownPct":0,"equity":100000,"t":1609459200000},{"drawdownPct":0,"equity":102660,"t":1617235200000},{"drawdownPct":0,"equity":104190,"t":1625097600000},
     {"drawdownPct":0,"equity":107390,"t":1633046400000},{"drawdownPct":0,"equity":108780,"t":1640995200000},{"drawdownPct":0,"equity":111580,"t":1648771200000},
     {"drawdownPct":0,"equity":113050,"t":1656633600000},{"drawdownPct":0,"equity":116330,"t":1664582400000},{"drawdownPct":0,"equity":118000,"t":1672531200000},
     {"drawdownPct":0.043475,"equity":112870,"t":1680307200000},{"drawdownPct":0.097203,"equity":106530,"t":1688169600000},{"drawdownPct":0.13661,"equity":101880,"t":1696118400000},
     {"drawdownPct":0.189,"equity":95698,"t":1704067200000},{"drawdownPct":0.173898,"equity":97480,"t":1711929600000},{"drawdownPct":0.167034,"equity":98290,"t":1719792000000},
     {"drawdownPct":0.146864,"equity":100670,"t":1727740800000},{"drawdownPct":0.138475,"equity":101660,"t":1735689600000},{"drawdownPct":0.122288,"equity":103570,"t":1743465600000},
     {"drawdownPct":0.115847,"equity":104330,"t":1751328000000},{"drawdownPct":0.095169,"equity":106770,"t":1759276800000},{"drawdownPct":0.089746,"equity":107410,"t":1767225600000},
     {"drawdownPct":0.072458,"equity":109450,"t":1775001600000},{"drawdownPct":0.066356,"equity":110170,"t":1782864000000},{"drawdownPct":0.05,"equity":112100,"t":1790726400000}]}', '2026-10-20T14:00Z', '2026-10-20T14:04Z'),
  ('br_orb_3', 'failed',    's_orb', '{"symbol":"SPY","timeframe":"5m"}', 'vx-engine-1.5', 'u_owner', 'bars missing for 2026-10-31', null, '2026-11-01T14:00Z', '2026-11-01T14:01Z'),
  ('br_mr_1',  'succeeded', 's_mr',  '{"symbol":"QQQ","timeframe":"1h"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":1.45,"maxDrawdownPct":0.098,"totalReturn":0.264,"totalTrades":96,"winRate":0.61,
     "profitFactor":1.8,"grossProfit":59400,"grossLoss":-33000,"netProfit":26400,"finalEquity":126400,"maxConsecutiveLosses":3,"maxConsecutiveLossesMoney":-1520,"maximalConsecutiveLoss":-1520,"maximalConsecutiveLossCount":3,
     "profitTrades":59,"lossTrades":37,"maxDrawdownAbs":10976,"absoluteDrawdown":0},
    "equity":[
     {"drawdownPct":0,"equity":100000,"t":1609459200000},{"drawdownPct":0,"equity":102410,"t":1617235200000},{"drawdownPct":0,"equity":103690,"t":1625097600000},
     {"drawdownPct":0,"equity":106640,"t":1633046400000},{"drawdownPct":0,"equity":107780,"t":1640995200000},{"drawdownPct":0,"equity":110330,"t":1648771200000},
     {"drawdownPct":0,"equity":112000,"t":1656633600000},{"drawdownPct":0.044286,"equity":107040,"t":1664582400000},{"drawdownPct":0.098,"equity":101024,"t":1672531200000},
     {"drawdownPct":0.079196,"equity":103130,"t":1680307200000},{"drawdownPct":0.070625,"equity":104090,"t":1688169600000},{"drawdownPct":0.046964,"equity":106740,"t":1696118400000},
     {"drawdownPct":0.039464,"equity":107580,"t":1704067200000},{"drawdownPct":0.019554,"equity":109810,"t":1711929600000},{"drawdownPct":0.011339,"equity":110730,"t":1719792000000},
     {"drawdownPct":0,"equity":113430,"t":1727740800000},{"drawdownPct":0,"equity":114560,"t":1735689600000},{"drawdownPct":0,"equity":116710,"t":1743465600000},
     {"drawdownPct":0,"equity":117590,"t":1751328000000},{"drawdownPct":0,"equity":120350,"t":1759276800000},{"drawdownPct":0,"equity":121080,"t":1767225600000},
     {"drawdownPct":0,"equity":123390,"t":1775001600000},{"drawdownPct":0,"equity":124210,"t":1782864000000},{"drawdownPct":0,"equity":126400,"t":1790726400000}]}', '2026-10-15T14:00Z', '2026-10-15T14:02Z'),
  ('br_mom_1', 'succeeded', 's_mom', '{"symbol":"XLK","timeframe":"1d"}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":1.31,"maxDrawdownPct":0.225,"totalReturn":0.402,"totalTrades":58,"winRate":0.57,
     "profitFactor":2,"grossProfit":80400,"grossLoss":-40200,"netProfit":40200,"finalEquity":140200,"maxConsecutiveLosses":4,"maxConsecutiveLossesMoney":-7350,"maximalConsecutiveLoss":-7350,"maximalConsecutiveLossCount":4,
     "profitTrades":33,"lossTrades":25,"maxDrawdownAbs":28800,"absoluteDrawdown":800},
    "equity":[
     {"drawdownPct":0,"equity":100000,"t":1609459200000},{"drawdownPct":0,"equity":103520,"t":1617235200000},{"drawdownPct":0,"equity":105900,"t":1625097600000},
     {"drawdownPct":0,"equity":109990,"t":1633046400000},{"drawdownPct":0,"equity":112220,"t":1640995200000},{"drawdownPct":0,"equity":115900,"t":1648771200000},
     {"drawdownPct":0,"equity":118190,"t":1656633600000},{"drawdownPct":0,"equity":122390,"t":1664582400000},{"drawdownPct":0,"equity":124890,"t":1672531200000},
     {"drawdownPct":0,"equity":128000,"t":1680307200000},{"drawdownPct":0.077813,"equity":118040,"t":1688169600000},{"drawdownPct":0.144922,"equity":109450,"t":1696118400000},
     {"drawdownPct":0.225,"equity":99200,"t":1704067200000},{"drawdownPct":0.193438,"equity":103240,"t":1711929600000},{"drawdownPct":0.170078,"equity":106230,"t":1719792000000},
     {"drawdownPct":0.133359,"equity":110930,"t":1727740800000},{"drawdownPct":0.108516,"equity":114110,"t":1735689600000},{"drawdownPct":0.075703,"equity":118310,"t":1743465600000},
     {"drawdownPct":0.053125,"equity":121200,"t":1751328000000},{"drawdownPct":0.015312,"equity":126040,"t":1759276800000},{"drawdownPct":0,"equity":128760,"t":1767225600000},
     {"drawdownPct":0,"equity":133140,"t":1775001600000},{"drawdownPct":0,"equity":135930,"t":1782864000000},{"drawdownPct":0,"equity":140200,"t":1790726400000}]}', '2026-10-28T14:00Z', '2026-10-28T14:06Z'),
  ('br_vix_1', 'queued',    's_vix', '{"symbol":"VIXY","timeframe":"1d"}', 'vx-engine-1.5', 'u_owner', null, null, '2026-11-04T14:00Z', null);

-- Engine runs with no strategy (strategy_id null), answered per run spec (symbol, timeframe, rule, stop loss,
-- take profit, cost, date range) by the
-- run_spec SQL attributes of migration 0058: IWM sma 10/30 twice (the newer run is the latest), DIA breakout
-- with a newer failed run, GLD sma 5/20 with a drawdown worse than 20% and, as a separate run spec, the same
-- rule with a 2% stop loss (a sweep cell: a different backtest, not a newer run of the first).
insert into backtest_runs(id, status, strategy_id, spec, engine_version, requested_by, error, report, created_at, finished_at) values
  ('br_free_iwm_1', 'succeeded', null, '{"symbol":"IWM","timeframe":"1d","rule":{"kind":"smaCross","fast":10,"slow":30}}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":0.64,"maxDrawdownPct":0.311,"totalReturn":0.087,"totalTrades":41,"winRate":0.49}}', '2026-10-10T14:00Z', '2026-10-10T14:02Z'),
  ('br_free_iwm_2', 'succeeded', null, '{"symbol":"IWM","timeframe":"1d","rule":{"kind":"smaCross","fast":10,"slow":30}}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":0.71,"maxDrawdownPct":0.258,"totalReturn":0.095,"totalTrades":43,"winRate":0.51}}', '2026-10-25T14:00Z', '2026-10-25T14:02Z'),
  ('br_free_dia_1', 'succeeded', null, '{"symbol":"DIA","timeframe":"1m","rule":{"kind":"breakout","entryLookback":20,"exitLookback":10,"trendSma":200}}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":1.21,"maxDrawdownPct":0.083,"totalReturn":0.212,"totalTrades":133,"winRate":0.58}}', '2026-10-18T14:00Z', '2026-10-18T14:05Z'),
  ('br_free_dia_2', 'failed',    null, '{"symbol":"DIA","timeframe":"1m","rule":{"kind":"breakout","entryLookback":20,"exitLookback":10,"trendSma":200}}', 'vx-engine-1.5', 'u_owner', 'bars missing for 2026-11-01', null, '2026-11-02T14:00Z', '2026-11-02T14:01Z'),
  ('br_free_gld_1', 'succeeded', null, '{"symbol":"GLD","timeframe":"1d","rule":{"kind":"smaCross","fast":5,"slow":20}}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":-0.12,"maxDrawdownPct":0.412,"totalReturn":-0.034,"totalTrades":77,"winRate":0.44}}', '2026-10-30T14:00Z', '2026-10-30T14:03Z'),
  ('br_free_gld_2', 'succeeded', null, '{"symbol":"GLD","timeframe":"1d","rule":{"kind":"smaCross","fast":5,"slow":20},"stopLossPct":2}', 'vx-engine-1.5', 'u_owner', null,
   '{"metrics":{"sharpe":0.33,"maxDrawdownPct":0.152,"totalReturn":0.041,"totalTrades":81,"winRate":0.47}}', '2026-11-01T14:00Z', '2026-11-01T14:03Z');

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
insert into forward_drift_monitors(id, label, baseline_run_id, thresholds, level, created_by, paper_status, created_at, updated_at) values
  ('m_orb', 'ORB paper forward',             'br_orb_2', '{}', 'alert', 'u_owner', 'running', '2026-10-21T14:00Z', '2026-11-05T14:00Z'),
  ('m_mom', 'Sector momentum paper forward', 'br_mom_1', '{}', 'warn',  'u_owner', 'running', '2026-10-29T14:00Z', '2026-11-05T14:00Z'),
  ('m_mr',  'RSI MR paper forward',          'br_mr_1',  '{}', 'ok',    'u_owner', 'off',     '2026-10-16T14:00Z', '2026-11-05T14:00Z');
-- The API stores all five thresholds on every monitor and its list contract requires them
-- (contracts/forward-drift.ts), so drift_status works on this fixture. Values: DEFAULT_DRIFT_THRESHOLDS
-- (tests/integration/semantic-layer/drift-tools.test.ts compares them).
update forward_drift_monitors set thresholds = '{"drawdown":{"alert":1.5,"warn":1},"losingStreak":{"alert":1.5,"warn":1.25},"profitFactor":{"alert":0.5,"warn":0.75},"sharpe":{"alert":0,"warn":0.5},"winRate":{"alert":0.6,"warn":0.8}}'
  where thresholds = '{}';

-- Forward data of the monitors, so that the stored level is backed by data: drift_monitor_get evaluates
-- points and trades and must give the level that drift_status lists. Each monitor has one equity point
-- per trading day and its closed trades; t is the bar time in epoch milliseconds, 00:00Z of the bar day.
-- m_orb and m_mr start on 2026-10-01 (the day after their baseline run ends) and have 25 points to
-- 2026-11-04. m_mom starts on 2026-10-08 and has 20 points.
--   m_orb: equity is 100000 plus closed pnl. Rolling win rate 23.1% against 52%, rolling profit factor
--          0.37 against 1.2 and a negative Sharpe: alert. Five losses in a row against six: ok.
--   m_mom: the open position is marked daily. Max drawdown 24.4% against 22.5%: warn. 20 points are 19
--          returns, one fewer than the Sharpe check needs, and three trades are fewer than the ten that
--          profit factor and win rate need: those three checks are insufficient. With one more point of
--          this falling series the Sharpe check would be at alert.
--   m_mr:  equity is 100000 plus closed pnl. All five checks are inside their thresholds: ok.
-- The Sharpe check computes its baseline from report.equity (the chart series of the run), as the API
-- does, so it differs from report.metrics.sharpe: 0.39, 0.79 and 1.02 against 0.82, 1.31 and 1.45.
-- The rows are what the API stores for this history, with one time (2026-11-05T14:00Z) for updated_at
-- and the alert rows, a simplification: the monitor is created, its whole series is recorded by hand in
-- one request (backtestRuns/drift/record, which saves through appendObservations), and for m_orb and
-- m_mom the paper runner is then switched on and has not ticked yet. created_at keeps its earlier date
-- (insert above) and is not compared. tests/integration/semantic-layer/drift-tools.test.ts runs that
-- history on a new monitor and compares level, levels, version, strategy_revision, updated_at, the
-- runner columns and the alert rows. After a change of the drift rules or of this data that test fails,
-- and its diff shows the values the API stores now ("Expected"); copy them here.
update forward_drift_monitors set version = 1,
  levels = '{"drawdown":"ok","losingStreak":"ok","profitFactor":"alert","sharpe":"alert","winRate":"alert"}',
  points = '[
    {"equity":100420,"t":1790812800000},{"equity":100420,"t":1790899200000},{"equity":100110,"t":1791158400000},{"equity":100110,"t":1791244800000},{"equity":99820,"t":1791331200000},
    {"equity":99820,"t":1791417600000},{"equity":100270,"t":1791504000000},{"equity":100270,"t":1791763200000},{"equity":99940,"t":1791849600000},{"equity":99940,"t":1791936000000},
    {"equity":99590,"t":1792022400000},{"equity":99590,"t":1792108800000},{"equity":99180,"t":1792368000000},{"equity":99180,"t":1792454400000},{"equity":99580,"t":1792540800000},
    {"equity":99280,"t":1792627200000},{"equity":98900,"t":1792713600000},{"equity":98900,"t":1792972800000},{"equity":98560,"t":1793059200000},{"equity":98560,"t":1793145600000},
    {"equity":98200,"t":1793232000000},{"equity":98200,"t":1793318400000},{"equity":97880,"t":1793577600000},{"equity":97880,"t":1793664000000},{"equity":97880,"t":1793750400000}]',
  trades = '[
    {"pnl":420,"t":1790812800000},{"pnl":-310,"t":1791158400000},{"pnl":-290,"t":1791331200000},{"pnl":450,"t":1791504000000},{"pnl":-330,"t":1791849600000},
    {"pnl":-350,"t":1792022400000},{"pnl":-410,"t":1792368000000},{"pnl":400,"t":1792540800000},{"pnl":-300,"t":1792627200000},{"pnl":-380,"t":1792713600000},
    {"pnl":-340,"t":1793059200000},{"pnl":-360,"t":1793232000000},{"pnl":-320,"t":1793577600000}]'
  where id = 'm_orb';
update forward_drift_monitors set version = 1,
  levels = '{"drawdown":"warn","losingStreak":"ok","profitFactor":"insufficient","sharpe":"insufficient","winRate":"insufficient"}',
  points = '[
    {"equity":100000,"t":1791417600000},{"equity":101200,"t":1791504000000},{"equity":102900,"t":1791763200000},{"equity":103800,"t":1791849600000},{"equity":102300,"t":1791936000000},
    {"equity":99800,"t":1792022400000},{"equity":97200,"t":1792108800000},{"equity":94900,"t":1792368000000},{"equity":92800,"t":1792454400000},{"equity":90900,"t":1792540800000},
    {"equity":89400,"t":1792627200000},{"equity":88100,"t":1792713600000},{"equity":86900,"t":1792972800000},{"equity":85800,"t":1793059200000},{"equity":84900,"t":1793145600000},
    {"equity":83300,"t":1793232000000},{"equity":81200,"t":1793318400000},{"equity":79600,"t":1793577600000},{"equity":78500,"t":1793664000000},{"equity":79600,"t":1793750400000}]',
  trades = '[
    {"pnl":2100,"t":1791849600000},{"pnl":-1800,"t":1792627200000},{"pnl":900,"t":1793664000000}]'
  where id = 'm_mom';
update forward_drift_monitors set version = 1,
  levels = '{"drawdown":"ok","losingStreak":"ok","profitFactor":"ok","sharpe":"ok","winRate":"ok"}',
  points = '[
    {"equity":100000,"t":1790812800000},{"equity":100520,"t":1790899200000},{"equity":100520,"t":1791158400000},{"equity":101130,"t":1791244800000},{"equity":101130,"t":1791331200000},
    {"equity":100650,"t":1791417600000},{"equity":100650,"t":1791504000000},{"equity":101100,"t":1791763200000},{"equity":101100,"t":1791849600000},{"equity":101800,"t":1791936000000},
    {"equity":101800,"t":1792022400000},{"equity":101270,"t":1792108800000},{"equity":101270,"t":1792368000000},{"equity":101660,"t":1792454400000},{"equity":101660,"t":1792540800000},
    {"equity":102300,"t":1792627200000},{"equity":102300,"t":1792713600000},{"equity":102860,"t":1792972800000},{"equity":102860,"t":1793059200000},{"equity":102410,"t":1793145600000},
    {"equity":102410,"t":1793232000000},{"equity":102890,"t":1793318400000},{"equity":102890,"t":1793577600000},{"equity":103480,"t":1793664000000},{"equity":103480,"t":1793750400000}]',
  trades = '[
    {"pnl":520,"t":1790899200000},{"pnl":610,"t":1791244800000},{"pnl":-480,"t":1791417600000},{"pnl":450,"t":1791763200000},{"pnl":700,"t":1791936000000},
    {"pnl":-530,"t":1792108800000},{"pnl":390,"t":1792454400000},{"pnl":640,"t":1792627200000},{"pnl":560,"t":1792972800000},{"pnl":-450,"t":1793145600000},
    {"pnl":480,"t":1793318400000},{"pnl":590,"t":1793664000000}]'
  where id = 'm_mr';
-- One open alert row per check that is at warn or alert.
insert into forward_drift_alerts(id, monitor_id, check_key, level, message, forward_value, baseline_value, ratio, created_at) values
  ('a_orb_profitFactor', 'm_orb', 'profitFactor', 'alert', 'Rolling profit factor alert: forward 0.37 vs baseline 1.20 (ratio 0.31; warn at 0.75, alert at 0.5)', 0.3746312684365782, 1.2, 0.3121927236971485, '2026-11-05T14:00Z'),
  ('a_orb_sharpe', 'm_orb', 'sharpe', 'alert', 'Sharpe alert: forward -7.28 vs baseline 0.39 (ratio -18.72; warn at 0.5, alert at 0)', -7.275756700840381, 0.3885716492011301, -18.724363230819108, '2026-11-05T14:00Z'),
  ('a_orb_winRate', 'm_orb', 'winRate', 'alert', 'Rolling win rate alert: forward 23.08% vs baseline 52.00% (ratio 0.44; warn at 0.8, alert at 0.6)', 0.23076923076923078, 0.52, 0.4437869822485207, '2026-11-05T14:00Z'),
  ('a_mom_drawdown', 'm_mom', 'drawdown', 'warn', 'Max drawdown warn: forward 24.37% vs baseline 22.50% (ratio 1.08; warn at 1, alert at 1.5)', 0.24373795761078998, 0.225, 1.083279811603511, '2026-11-05T14:00Z');

-- Give the engine rows the full spec and report shape the API validates (contracts/backtest-runs.ts), so
-- backtest_runs_list and backtest_runs_get work on this fixture. The metrics and rules above win over these defaults.
-- A report that has an equity series keeps it, and takes firstT and lastT from it.
update backtest_runs set spec = jsonb_build_object(
  'costBps', 1, 'from', '2021-01-01', 'to', '2026-09-30', 'initialCapital', 100000,
  'rule', coalesce(spec->'rule', jsonb_build_object('kind', 'smaCross', 'fast', 20, 'slow', 50)),
  'stopLossPct', coalesce((spec->>'stopLossPct')::numeric, 0), 'takeProfitPct', 0, 'symbol', spec->>'symbol',
  'timeframe', case when spec->>'timeframe' = '1d' then '1d' else '1m' end);
update backtest_runs set report = jsonb_build_object(
  'bars', 1000, 'equity', coalesce(report->'equity', '[]'::jsonb),
  'firstT', coalesce((report->'equity'->0->'t')::bigint, 1609459200),
  'lastT', coalesce((report->'equity'->-1->'t')::bigint, 1759190400), 'prices', '[]'::jsonb,
  'seriesSha256', 'synthetic', 'trades', '[]'::jsonb, 'tradesTruncated', false,
  'metrics', jsonb_build_object(
    'absoluteDrawdown', 0, 'averageLossTrade', null, 'averageProfitTrade', null, 'buyHoldReturn', 0,
    'cagr', null, 'expectedPayoff', null, 'exposure', 0.5, 'finalEquity', 100000, 'grossLoss', 0,
    'grossProfit', 0, 'initialDeposit', 100000, 'largestLossTrade', null, 'largestProfitTrade', null,
    'lossTrades', 0, 'maxConsecutiveLosses', 0, 'maxConsecutiveLossesMoney', 0, 'maxConsecutiveWins', 0,
    'maxDrawdownAbs', 0, 'maximalConsecutiveLoss', 0, 'maximalConsecutiveLossCount', 0, 'netProfit', 0,
    'profitFactor', null, 'profitTrades', 0, 'recoveryFactor', null, 'sortino', null
  ) || (report->'metrics'))
where report is not null;

-- Migration 0058 seeds the run_spec SQL attributes NOT certified; in production the owner certifies them on
-- /semantic-terms. This synthetic database certifies them as that operator would, so the eval and the
-- integration tests exercise the certified answer for engine runs with no strategy.
update semantic_sql_attributes set certified = true, certified_at = '2026-11-08T12:00Z',
  certified_by = 'eval fixture (stands in for the owner)', certification_note = 'Synthetic eval database only.'
where grain = 'run_spec';
commit;
