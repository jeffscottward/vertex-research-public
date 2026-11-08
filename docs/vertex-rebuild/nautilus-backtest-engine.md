# Nautilus backtest engine

Owner decisions (2026-11-05): use NautilusTrader as the only backtest engine, and migrate with parity tests first. A later decision the same day: for the instant backtest, sweeps and the Autopilot gate, run both engines side by side with no forced switch (see [Dual run](#dual-run-engine-comparison)). Research only: no backtest path creates, routes or sends an order.

## Status

| Item | State |
| --- | --- |
| Engine | `services/research/nautilus_backtest/` (Python), `nautilus-trader==1.227.0` from `services/research/requirements-nautilus-linux-py312.lock`. The same pin as Quant Lab (`quantlab/nautilus_engine.py`). |
| Signals | `nautilus_backtest/signals.py`: Python port of the strategy DSL compiler (`packages/api/src/strategy-dsl-compile.ts`) and the fixed rules (SMA cross, breakout, RSI reversion). Bit-for-bit equal to TypeScript on the golden fixture. |
| Costs | `nautilus_backtest/costs.py`: port of `packages/api/src/backtest-costs.ts` (presets, commission, fees, spread, slippage, sizing). |
| Parity suite | CLI `scripts/research-nautilus-parity.ts`, logic and tests in `scripts/research/nautilus-parity.ts` and `nautilus-parity.test.ts`. Latest report: [`research/backtests/nautilus-parity/README.md`](../../research/backtests/nautilus-parity/README.md). |
| CI | `services/research/tests/test_nautilus_backtest_signals.py` (base lane) and `test_nautilus_backtest_engine.py` (Nautilus lane, `VERTEX_REQUIRE_NAUTILUS=1`). |
| Features on Nautilus | Backtest runs: on Nautilus in production since 2026-11-06 (`VERTEX_BACKTEST_RUNS_ENGINE=nautilus`, rig worker); see [Backtest runs on Nautilus](#backtest-runs-on-nautilus). Instant backtest, sweeps and the Autopilot gate: dual run in production since 2026-11-06 (`VERTEX_ENGINE_COMPARISON=on`): the TypeScript result shows first and the same run repeats on Nautilus; the owner decides any switch from the side-by-side data (owner decision 2026-11-05). Paper forward, setup replay, Academy, the offline research scripts and Quant Lab still use the TypeScript engine (or their own engines); see [Switch plan](#switch-plan). |
| Dual run | Instant backtest, parameter sweeps and the Autopilot gate: with `VERTEX_ENGINE_COMPARISON=on` they keep the TypeScript result and also queue the same runs on Nautilus (research worker on the rig), with where it ran, wall time, queue wait, CPU time and the differences recorded; see [Dual run](#dual-run-engine-comparison). Default off in code; on in production since 2026-11-06. |

## Run it

```sh
# One run: JSON request in, JSON result out (exit 2 on an input error).
cd services/research && python -m nautilus_backtest run request.json
# request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]}, "spec": {...}}

# Parity suite (needs the Core 7 data from research/backtests/core7/fetch_data.py and a venv with the Nautilus lock).
bun run research:nautilus-parity -- --data ~/Documents/reports/vertex-core7/data \
  --python <venv>/bin/python --out research/backtests/nautilus-parity

# Golden fixture (TypeScript is the reference for the Python port).
bun run research:nautilus-golden  # scripts/research-nautilus-golden.ts
```

The `spec` has the fields of a backtest run spec: `rule` (`smaCross`, `breakout`, `rsiReversion` or `{"kind": "dsl", "definition": ...}`), `stopLossPct`, `takeProfitPct`, `costBps`, `costs` (`{"profile": <CostProfile>, "capital": n}` or null), optional `sectorQuadrants` and `initialCapital`. The result has the shape of the TypeScript `InstantRunResult`: `equity` (unit equity per bar), `trades` and `stats`. So `buildBacktestRunReport` and the analytics (deflated Sharpe, Monte Carlo, walk-forward, gs-quant analytics) read Nautilus results without a change.

## Backtest runs on Nautilus

Backtest runs (Backtest lab, Strategy builder, Autopilot "Run full backtest", library re-runs) run on Nautilus when the web app has `VERTEX_BACKTEST_RUNS_ENGINE=nautilus`. Unset or `typescript` keeps the API engine; nothing else changes. A stored run keeps its own engine id, so switching the setting never moves a stored run to the other engine.

1. `backtestRuns.submit` stores the run with the engine id `nautilus-trader-1.227.0` and does not run it in the API server.
2. The worker (`scripts/backtest-worker/nautilus-worker.ts`, `bun run vertex:backtest-worker:nautilus`) runs on the research host as a user systemd service ([infra/research-worker/README.md](../../infra/research-worker/README.md)). It calls `backtestRuns.engine.claim` over HTTPS with an operator agent write key. Claim moves the oldest queued run of the engine to `running` with a conditional update, so two workers never run the same run. It returns the spec, the bars of the date range (the same slice the API engine uses; JSON `null` for a missing value), the resolved cost settings, the sector rotation points that the definition's filters need and `series`: the daily series store rows (`id -> {dates, open, high, low, close, adjClose}`, up to `to`) that the definition reads, or null. `seriesSha256` is the bar series hash; for a run that reads series it also covers the rows, and for an options run it is the rows hash (an options run's bars are the run symbol's store row, not `market_bars`). A run whose inputs cannot be loaded fails at claim with the API engine's message.
3. The worker claims with `max` 50, so it gets a batch (one run, or up to 50 runs of one comparison group on one bar series), runs it in `VERTEX_WORKER_PROCESSES` processes of `python -m nautilus_backtest batch - -` in `services/research` (the shared bars and one case per run, with its index range, on stdin), and posts every result (`equity`, `trades`, `stats`, `engineRun`) and every input error (the same message as the TypeScript engine) with `backtestRuns.engine.completeMany`, in as few requests as stay under 900 KB each (the web app refuses requests over 1 MiB; 50 ten-year daily results are about 2.4 MB). A single result over that limit goes alone; when the API refuses it (413), only that run fails with "The Nautilus result is larger than the API request limit". Every request counts in the request budget. After a network error or a 5xx answer it tries again (4 tries, waits of 1, 2 and 4 seconds; a 429 is tried again once, after at most 125 s) and then fails the runs with "Could not deliver the Nautilus result"; any other 4xx fails them with "The API rejected the Nautilus result". Exit 3 (no Nautilus), any other exit, a different engine version, a process over 9 minutes or a worker stop: every run of that process fails with a short message, and the worker logs the engine stderr locally.
4. `complete` checks the result with the contract: finite numbers, unit equity above 0 at every bar, trade prices and units above 0, `stats.bars` equal to the equity length, trade bar indexes inside the series. It reloads the bars and refuses a result whose bar count or `seriesSha256` differs from the stored bars. It recomputes the stats from the stored bars and the worker's equity and trades with the TypeScript `summarize` and refuses a result whose stats differ by more than 1e-9 (relative); the refused run fails with the reason. It stores the API's own stats and builds the report with `buildBacktestRunReport`, the same code as the API engine. An options run (a dsl rule with an `options` block) is claimed alone (one in a comparison batch fails) and runs in the options runner (`strategies.qc_ports.portfolio.run_spec_json`, ledger plus NautilusTrader parity). Its result is that document (`kind: "options"`: capital, dates, equity, open positions, trades with each spread's `maxLoss`, size skips, book skips, signals, metrics, `nautilusGap`), validated strictly and bounded (20,000 days and trades). `complete` reloads the rows, checks the hash, the capital and the SPY calendar of the range, recomputes the metrics from the ledger (`summarize` with one trial, the skips, the largest open risk from `maxLoss` and the stale-IV exits; 1e-9 relative) and builds the report with `buildOptionsRunReport`, the same code as the TypeScript options run, with the worker's `nautilusGap`. `complete` and `fail` change only a run that is `running` on the same engine; anything else returns `CONFLICT` and changes nothing.
5. `backtestRuns.get` fails a Nautilus run that waited more than 10 minutes while no Nautilus run was claimed in those 10 minutes, so no worker is active ("Nautilus backtest worker did not pick up the run"). A busy worker never fails its backlog. A run left `running` for more than 10 minutes fails as for API runs. The Backtest runs and Strategy builder pages follow a run for up to 20 minutes.

Request budget: the worker backs off from 3 s to 45 s between empty claims, sends at most 150 requests before a 125 s quiet pause, waits 125 s after a 429 on a claim, and waits at most once (never past the API stale limit) after a 429 on a delivery. The agent key limiter resets a key's count only after more than 60 s without an accepted request, so a client that polls more often never resets it. With one Autopilot tick inside the pause, the two gaps add up to 125 s, so one is over 60 s; with two ticks, the gap between them is over 60 s. It depends on ticks being more than 60 s apart with one request each; a separate worker key is the robust fix ([infra/research-worker/README.md](../../infra/research-worker/README.md#request-budget)).

These are the defaults for a shared key. With its own write key the worker polls fast: `VERTEX_WORKER_IDLE_MS=3000`, `VERTEX_WORKER_IDLE_MAX_MS=3000`, `VERTEX_WORKER_REQUEST_BUDGET=550` (1 to 580) and `VERTEX_WORKER_QUIET_PAUSE_MS=65000` (at least 61000) give about 1.5 s average queue wait and one 65 s pause about every 27 minutes ([own key](../../infra/research-worker/README.md#own-key-fast-polling)). Web restarts: `infra/quantvps/restart-when-idle.sh` writes the worker pause file (`VERTEX_WORKER_PAUSE_FILE`) for its idle wait and removes it on exit; while the file exists and is younger than 90 min the worker claims nothing. It also claims nothing while another process holds the script's restart lock (`VERTEX_WORKER_RESTART_LOCK`), which covers older copies of the script that never write the pause file; it checks `/proc/locks` and runs `flock -n` only when the lock file's inode is locked ([web restarts](../../infra/research-worker/README.md#web-restarts)).

Monitoring: after 3 failed worker cycles in a row (API errors on claim or fail, a result that could not be delivered or was rejected, an engine crash, timeout or version mismatch; not a run's input error or an empty claim) the worker posts one alert line to the optional `VERTEX_ALERT_POST_URL` / `VERTEX_ALERT_CHANNEL` chat route, and one recovery line on the next normal cycle ([infra/research-worker/README.md](../../infra/research-worker/README.md#settings)).

The engine procedures need an operator agent write key; read keys and agent viewers cannot call them. A unit test (`packages/api/src/backtest-runs.test.ts`) feeds the TypeScript engine's result through `complete` and checks that the report equals the API engine's report. `scripts/backtest-worker/nautilus-worker.e2e.test.ts` runs the worker with the real engine against an in-process fake API when `VERTEX_NAUTILUS_PYTHON` is set:

```sh
VERTEX_NAUTILUS_PYTHON=<venv>/bin/python pnpm exec vitest run --config vitest.config.ts --project operations scripts/backtest-worker
```

## Dual run (engine comparison)

Owner decision (2026-11-05): Nautilus runs only on the rig worker, never on QuantVPS. The instant backtest, the parameter sweep and the Autopilot gate run both engines on the same request: the TypeScript result is shown at once on the unchanged path, and the same run(s) are queued on Nautilus. Nothing switches. The setting is `VERTEX_ENGINE_COMPARISON` (`off` by default, `on`); `VERTEX_HOST_LABEL` names where the web server runs (default `web server`).

Storage: no new table. Each repeated run is a backtest run with the Nautilus engine id and `spec.comparison`: `feature` (`instant`, `sweep`, `autopilotGate`), `groupId` (instant and sweep: `<feature>-` plus 32 hex of the SHA-256 of the canonical request content: series SHA-256, date range, rule or grid, stop, target and cost settings; the gate: `autopilot:<campaign id>`), `label`, `key` (sweep cell index or Autopilot candidate id), `dropped` (runs the cap left out) and `typescript`: its stats (the `InstantStats` fields), the trades as `[entry bar, exit bar, exit reason]` (at most 5,000), the trade count, `wallMs` and `host`. `backtestRuns.list` leaves comparison runs out; `backtestRuns.comparisons.list({feature?, groupId?, limit})` lists them (read keys may call it) with the status, the queue wait (`startedAt - createdAt`), `engineRun` and `differences`.

No flooding: the instant backtest and the sweep page run again on every form change. An identical request (same group id) whose group has a queued, running or succeeded run from the last 24 hours queues nothing new (a group whose runs all failed, superseded or for another reason, gets new runs) and shows that group (`reused: true`). A new group of the same feature from the same user fails that user's still-queued runs of older groups of the feature with "Superseded by a newer request" (one conditional update; running runs are never touched; the answer reports `superseded`). Both happen in one transaction under two advisory locks, taken in this order: feature and user (so two requests of one user run one after the other and the later one supersedes the earlier one, even when they arrive at once), then the group id (so two identical requests at once store the group once). A superseded request that is asked for again gets new runs in its group; the pages show the newest run per cell and "superseded" for the replaced ones. The gate's campaign group takes every tick's runs (no reuse, no superseding).

Only a caller that may write queues comparison runs: an operator session or a write-access agent key. `backtestRuns.sweep` is a read procedure, so a read-access key or a read-only agent viewer gets the TypeScript result without `comparison` and nothing is queued.

| Feature | What is repeated | Cap |
| --- | --- | --- |
| Instant backtest | The run over the whole stored series (`from` and `to` are the first and last bar dates) | One run per request |
| Parameter sweep | One run per evaluated cell (cells the TypeScript engine refused are not repeated), labelled with the cell's parameters | First 100 cells per sweep; the UI states it |
| Autopilot gate | For each candidate a tick gated: the in-sample slice and the full run whose tail is the out-of-sample part, as date ranges | 20 runs per tick; the runs record how many the cap left out |

For the gate the TypeScript side is computed again on exactly the bars of each date range (for daily bars these are the gate's own bars; for minute bars the in-sample range ends with a whole day), and counts in the tick's time.

Timing: the server measures the TypeScript engine call. A Worker runtime does not advance `performance.now`/`Date.now` during pure compute, so a zero time is stored as `wallMs: null` with `wallNote: "timer frozen in Worker runtime"`, never as 0. The page also shows the browser round trip as the time the user saw. The worker records per run `engineRun`: `host` (`os.hostname()`), `wallMs` (engine time of the case), `processWallMs` and `cpuMs` (user + system CPU time of the engine process, from `getrusage`), `processes`, `processCases` and `gpu: "not used (Nautilus engine is CPU-only)"`.

Batches: `backtestRuns.engine.claim` takes `max` (1 to 50) and then returns a batch: the oldest queued run and, when it belongs to a comparison group, more runs of that group (a run without a group comes alone), with the bars from the earliest `from` to the latest `to` and each run's index range. `series` then holds every series that a run of the batch reads, each up to the latest `to` of the runs that read it, and a run that reads series has its own `seriesSha256` (its bars and its own rows). The worker splits the batch over `VERTEX_WORKER_PROCESSES` engine processes (default 8, at most 16; measured on the rig: 184 cells on 6,587 daily bars took 73.9 s in one process, 11.8 s in 8 and 7.7 s in 24) and posts all results and errors with `backtestRuns.engine.completeMany` (one outcome per run; same checks and stats recomputation as `complete`), split under 900 KB per request. So a claimed batch costs one claim request and one or more delivery requests.

Differences: when a comparison run completes, the API compares the Nautilus result (with the API's own recomputed stats) with `comparison.typescript`: the trade count, the first trade that differs in entry bar, exit bar or exit reason, and total return, Sharpe and max drawdown with the [parity tolerances](#parity-tolerances) (1e-5, 1e-3, 1e-5). It stores `report.differences = {ok, items[]}`.

Report for the owner (from the stored data): per feature, where it ran (`comparison.typescript.host`, `engineRun.host`), wall time p50/p95 over 20 runs (`typescript.wallMs` and the page round trip; `engineRun.wallMs`), queue wait, CPU (`engineRun.cpuMs`), GPU (not used) and the differences.

Pages: the instant backtest shows "TypeScript · host · round trip" at once and a Nautilus card that follows the group until its run is done (queued, running, engine time and queue wait, then a match or differences badge with the list). The sweep shows a summary line and a Nautilus column in the ranked cells. An Autopilot campaign shows a Nautilus check per gated candidate.

## Order and fill model

Nautilus matches every order and keeps the cash and position ledger. The model gives the same rules as the TypeScript engine:

- Each bar is fed as three one-minute bars: the open print, the path from the open to the low, and the path from the low to the high and the close. The low comes before the high.
- Stop first (the TypeScript rule): a bar that reaches the stop exits at the stop, also when it opens beyond the target. The target order rests during a bar only when that bar's low stays above the stop. The strategy reads the coming bar's low for this execution rule only; signals never read it.
- Signals use data up to the close of bar i. Entries and signal exits are market orders at the open print of bar i + 1.
- An entry places a reduce-only stop-market order and, under the stop-first rule, a reduce-only market-if-touched order. A level touched inside the bar fills at the level. A level gapped through fills at the open.
- An open position closes at the last close (exit reason `end`).
- The fee model charges the flat `costBps`, half the spread, the slippage, the commission and the fees in USD. Nautilus fills at the reference price; the trade record shows the cost-adjusted price.
- One CFD instrument with 9-decimal prices and quantities, so fractional units match the TypeScript sizing.

Known differences: Nautilus books fees in whole cents, and prices and quantities have 9 decimals. Both stay inside the parity tolerances.

## Parity tolerances

Every case must give the same trades (entry bar, exit bar, exit reason, same order), fill prices within 1e-6 (relative), unit equity within 1e-5 (relative) at every bar, Sharpe within 1e-3, and max drawdown and total return within 1e-5. An input error must give the same message in both engines.

## Backtest entry points

| Feature | Where it runs today | Engine call | Needs |
| --- | --- | --- | --- |
| Backtest runs (Backtest lab, Strategy builder, Autopilot "Run full backtest", library re-runs with `strategyId`) | API server, queued run, `executeClaimed` in `packages/api/src/server/backtest-runs.ts`; with `VERTEX_BACKTEST_RUNS_ENGINE=nautilus` the research worker | `runInstantBacktest`, `runStrategyDefinition`, or the Nautilus engine | Stored daily or minute bars, cost profile, capital, sector quadrants |
| Instant backtest | API server, in the request (`packages/api/src/server/instant-backtest.ts`); with `VERTEX_ENGINE_COMPARISON=on` also queued on the rig worker | `runInstantBacktest` | Stored bars, `costBps` |
| Parameter sweeps | API server, in the request (`packages/api/src/backtest-sweep.ts`); with comparison on, the first 100 cells also on the rig worker | `runInstantBacktest` per cell | Stored bars |
| Autopilot gate | API server (`packages/api/src/server/autopilot-runner.ts`, `autopilot-gate.ts`); with comparison on, the in-sample and full runs (20 per tick) also on the rig worker | `runStrategyDefinition` on slices | In-sample, out-of-sample, folds, cost stress |
| Paper forward | API server (`packages/api/src/paper-forward.ts`) | Fixed rules | Latest bars |
| Setup replay | API server (`packages/api/src/setup-replay.ts`) | `runSignalBacktest` | Daily bars, ATR stops |
| Academy | `packages/academy/src/backtest.ts` | Own Black-Scholes options simulator | Modelled option prices (no real option quotes) |
| Quant Lab | `python -m quantlab backtest --engine stdlib\|nautilus` | Own engine; Nautilus engine exists | Daily bars |
| Offline research (`scripts/research/core7-rerun.ts`, `quantjourney.ts`) | Rig scripts | `runStrategyDefinition` | Core 7 data |
| Backtests page analytics, Optimizations, Strategy library, Portfolio combos, Forward drift | Read stored results | None | Result schema only |

## Switch plan

A feature switches only when its parity cases pass. The TypeScript engine stays behind a per-feature setting until the last feature switches. Dates are targets.

| Step | Target date | Pass condition |
| --- | --- | --- |
| 1. Engine, golden fixture, parity suite and report (this change) | 2026-11-05 | Parity report: all cases pass; CI green |
| 2. Backtest runs on a research worker on the rig: the API stores the run with the Nautilus engine id; the worker claims it over the API, runs Nautilus and posts the result; the API builds the report (done: live on 2026-11-06, first live run matched the TypeScript run of the same spec) | 2026-11-07 | One live run checked end to end; TS path still available by setting |
| 3. Offline research scripts and Quant Lab default to Nautilus | 2026-11-10 | Core 7 re-run equal to the parity figures |
| 4. Instant backtest, sweeps and the Autopilot gate: dual run (done 2026-11-06; owner decision: no forced switch). Report of record: the "current engine vs Nautilus on the rig" page on the rig reports site (run times p50/p95, queue wait, CPU/GPU, differences) | 2026-11-20 | Two weeks of live side-by-side data reported; the owner decides whether to switch |
| 5. Paper forward and setup replay | 2026-11-18 | Parity per feature |
| 6. Academy: feed modelled option quotes to Nautilus option instruments, or keep the modelled simulator as teaching material outside the engine of record (owner choice at that step) | 2026-11-21 | Decision recorded |
| 7. Retire the TypeScript engine in a separate PR (keep the git history; remove dead paths), only if the owner switches the interactive paths in step 4 | after step 4 | All features switched for two weeks without a parity regression |

The QuantVPS Nautilus node stays disarmed. The research worker runs on the rig or in a research container, never on the live trading node.
