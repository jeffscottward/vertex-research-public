# Paper forward runner

Updated: 2026-10-23. Paper mode only. The runner simulates fills with the backtest engine. It has no broker client, sends no orders and makes no broker calls. A tick result is information for drift checks; it does not authorize a trade.

## Purpose

A drift monitor compares paper results of a strategy revision with its baseline backtest run ([forward-drift.md](forward-drift.md)). The paper forward runner produces those paper results automatically. It runs the baseline run's strategy on stored bars that arrive after the run's end date, and it records the settled paper equity points and closed paper trades on the monitor. Each recording evaluates the five drift checks and can raise in-app alerts.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `backtestRuns.drift.paperSet`, `.paperTick` | `packages/api/src/contracts/forward-drift.ts` |
| Paper step (pure): engine run and settled-result cursor | `packages/api/src/paper-forward.ts` |
| Tick runner: bars, step, append, outcome note | `packages/api/src/server/paper-forward-runner.ts` |
| Shared engine parameters of a run spec | `packages/api/src/server/backtest-run-params.ts` |
| Shared append (limits, evaluation, alerts, version lock) | `packages/api/src/server/forward-drift-append.ts` |
| Runner state columns `paper_status`, `paper_ticked_at`, `paper_note` | migration `0028_paper_forward_runner`, rollback `packages/db/rollback/0028_paper_forward_runner.down.sql` |
| Scheduler client | `scripts/paper-forward/tick.ts`, `bun run vertex:paper:tick` |
| User systemd units | `infra/paper-forward/vertex-paper-forward.{service,timer}` |
| Page section "Paper forward runner" | `apps/web/src/components/portal/forward-drift-workspace.tsx` |

Both procedures are operator-only and need a write key; read keys cannot start, stop or tick a runner.

## How one tick works

1. Read the monitor and its baseline run. The run must have status `succeeded`.
2. Load the stored bars of the run's symbol and timeframe through the market bars repository (read-only history path). Keep the bars from the run's start date to the newest bar.
3. Run the backtest engine over these bars with the run's own settings: rule, stop loss, take profit, flat cost (bps) and cost profile. The settings come from the same function that a backtest run uses.
4. Keep only settled results. A bar is settled when one later bar exists; the newest bar is never recorded, because the next bar can still change its result. A trade counts when it has closed, its exit bar is settled, its exit reason is not the end of data, and it entered on or after the forward start.
5. The forward start is the first bar after the run's end date (`to` + 1 day, UTC). Earlier bars only warm up the strategy.
6. Equity points are engine equity times the run's initial capital. Trade P&L is the engine P&L times the initial capital, stamped with the exit bar time.
7. Append only points and trades later than the last stored point and trade. One tick appends at most 2,000 points and the trades up to the last appended point. A longer gap continues on the next tick.
8. Save the tick time and an outcome note. Notes include "No new settled bars after the forward start", "No stored 1d bars for SPY" and "The monitor changed during the tick; the next tick retries".

When the monitor storage limit (5,000 points or trades) would be exceeded, the tick records nothing, sets the runner to stopped and notes the reason.

## Determinism

The engine is causal: an entry or exit at bar k uses bars up to k only, and the engine runs from the same start bar on every tick. So a runner that receives bars one at a time records the same trades and equity values as one backtest over the same bars. Tests check this in `packages/api/src/paper-forward.test.ts` (pure step, one bar per step, with a cost profile, stop and target) and in `packages/api/src/backtest-runs.test.ts` (procedure ticks over a growing bar series).

## Broker isolation

`packages/api/src/paper-forward.test.ts` walks the import graph of the paper step, the tick runner and the scheduler script. It fails when any reachable import specifier names a broker, IBKR, order, execution, Quant VPS, native or gateway module, or when a package outside a short allowlist (`@darkfactory/db/server`, `@orpc/contract`, `zod`) is imported. The scheduler client sends one HTTP request to the Vertex API and nothing else.

## Scheduler

`bun run vertex:paper:tick` calls `backtestRuns.drift.paperTick` without an id. That ticks every running runner, least recently ticked first, at most 20 per call. A monitor whose tick fails gets a "Tick failed" note; the other monitors in the call still tick. Add a monitor id after `--` to tick one monitor. The client reads `VERTEX_ORIGIN` and `VERTEX_AGENT_API_KEY` (an operator write key) from the environment and never prints the key.

Install the user timer (every 15 minutes) on the host that runs the scheduler:

```sh
install -m 0600 /dev/null ~/.config/vertex/paper-forward.env   # then add VERTEX_ORIGIN and VERTEX_AGENT_API_KEY
cp infra/paper-forward/vertex-paper-forward.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vertex-paper-forward.timer
```

The service expects the checkout at `~/Github/trading/vertex-research-platform`; edit `WorkingDirectory` for another path. New bars arrive through the existing importer (`bun run vertex:bars:import`); a tick without new settled bars records nothing.

## Page

The drift panel of `/forward-drift` has a "Paper forward runner" section. It shows the runner status, the last tick time and note, a start/stop button and "Run one tick now". The tick result line shows the new points, trades and alerts.

## Limits

- While a runner is running, `record` returns `CONFLICT`. A manual point or trade later than the newest settled bar would move the runner's cursor past bars it has not recorded. While the runner is stopped, manual recording works, but data recorded after the newest settled bar makes later ticks skip the bars up to that time. Use one source of paper data per monitor.
- One position at a time, long only, as in the backtest engine. Fills are simulated at bar prices with the run's cost settings; real fills differ.
- The runner uses the stored series. When an import replaces the series with revised history, later ticks use the revised bars, but stored paper points are not rewritten.
- Positions open across the forward start are part of the forward equity, but their trade is not recorded, because it entered before the forward start.
