# Nautilus backtest engine

Owner decisions (2026-11-05): use NautilusTrader as the only backtest engine, and migrate with parity tests first. Research only: no backtest path creates, routes or sends an order.

## Status

| Item | State |
| --- | --- |
| Engine | `services/research/nautilus_backtest/` (Python), `nautilus-trader==1.227.0` from `services/research/requirements-nautilus-linux-py312.lock`. The same pin as Quant Lab (`quantlab/nautilus_engine.py`). |
| Signals | `nautilus_backtest/signals.py`: Python port of the strategy DSL compiler (`packages/api/src/strategy-dsl-compile.ts`) and the fixed rules (SMA cross, breakout, RSI reversion). Bit-for-bit equal to TypeScript on the golden fixture. |
| Costs | `nautilus_backtest/costs.py`: port of `packages/api/src/backtest-costs.ts` (presets, commission, fees, spread, slippage, sizing). |
| Parity suite | `scripts/research/nautilus-parity.ts`. Latest report: [`research/backtests/nautilus-parity/README.md`](../../research/backtests/nautilus-parity/README.md). |
| CI | `services/research/tests/test_nautilus_backtest_signals.py` (base lane) and `test_nautilus_backtest_engine.py` (Nautilus lane, `VERTEX_REQUIRE_NAUTILUS=1`). |
| Features on Nautilus | None yet. Each feature switches only after its parity passes; see [Switch plan](#switch-plan). |

## Run it

```sh
# One run: JSON request in, JSON result out (exit 2 on an input error).
cd services/research && python -m nautilus_backtest run request.json
# request.json: {"bars": {"t": [...], "o": [...], "h": [...], "l": [...], "c": [...], "v": [...]}, "spec": {...}}

# Parity suite (needs the Core 7 data from research/backtests/core7/fetch_data.py and a venv with the Nautilus lock).
bun run research:nautilus-parity -- --data ~/Documents/reports/vertex-core7/data \
  --python <venv>/bin/python --out research/backtests/nautilus-parity

# Golden fixture (TypeScript is the reference for the Python port).
bun run research:nautilus-golden
```

The `spec` has the fields of a backtest run spec: `rule` (`smaCross`, `breakout`, `rsiReversion` or `{"kind": "dsl", "definition": ...}`), `stopLossPct`, `takeProfitPct`, `costBps`, `costs` (`{"profile": <CostProfile>, "capital": n}` or null), optional `sectorQuadrants` and `initialCapital`. The result has the shape of the TypeScript `InstantRunResult`: `equity` (unit equity per bar), `trades` and `stats`. So `buildBacktestRunReport` and the analytics (deflated Sharpe, Monte Carlo, walk-forward, gs-quant analytics) read Nautilus results without a change.

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
| Backtest runs (Backtest lab, Strategy builder, Autopilot "Run full backtest", library re-runs with `strategyId`) | API server, queued run, `executeClaimed` in `packages/api/src/server/backtest-runs.ts` | `runInstantBacktest`, `runStrategyDefinition` | Stored daily or minute bars, cost profile, capital, sector quadrants |
| Instant backtest | API server, in the request (`packages/api/src/server/instant-backtest.ts`) | `runInstantBacktest` | Stored bars, `costBps` |
| Parameter sweeps | API server, in the request (`packages/api/src/backtest-sweep.ts`) | `runInstantBacktest` per cell | Stored bars |
| Autopilot gate | API server (`packages/api/src/server/autopilot-runner.ts`, `autopilot-gate.ts`) | `runStrategyDefinition` on slices | In-sample, out-of-sample, folds, cost stress |
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
| 2. Backtest runs on a research worker on the rig: the API stores the run with the Nautilus engine id; the worker claims it over the API, runs Nautilus and posts the result; the API builds the report | 2026-11-07 | One live run checked end to end; TS path still available by setting |
| 3. Offline research scripts and Quant Lab default to Nautilus | 2026-11-10 | Core 7 re-run equal to the parity figures |
| 4. Instant backtest, sweeps and the Autopilot gate as queued worker jobs (they run in the request today) | 2026-11-14 | Parity per feature; response-time budget recorded |
| 5. Paper forward and setup replay | 2026-11-18 | Parity per feature |
| 6. Academy: feed modelled option quotes to Nautilus option instruments, or keep the modelled simulator as teaching material outside the engine of record (owner choice at that step) | 2026-11-21 | Decision recorded |
| 7. Retire the TypeScript engine in a separate PR (keep the git history; remove dead paths) | 2026-11-28 | All features switched for two weeks without a parity regression |

The QuantVPS Nautilus node stays disarmed. The research worker runs on the rig or in a research container, never on the live trading node.
