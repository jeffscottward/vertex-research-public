# Forward drift

Updated: 2026-10-23. Paper data only. Nothing in this feature creates, routes, changes or simulates broker orders. An alert is information for the operator; it does not stop, pause or change a strategy, and it does not authorize a trade.

## Purpose

A backtest says how a strategy revision behaved on history. Forward drift compares paper (forward) results of the same revision with that backtest. A monitor pins one finished backtest run as the baseline. Paper equity points and closed paper trades are recorded on the monitor. Each recording evaluates five checks and raises an in-app alert when a check reaches a more severe level.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `backtestRuns.drift.create`, `.record`, `.get`, `.list`, `.acknowledge` | `packages/api/src/contracts/forward-drift.ts` |
| Procedures | `packages/api/src/server/forward-drift.ts` |
| Checks, thresholds and escalation rule (pure) | `packages/api/src/forward-drift.ts` |
| Tables `forward_drift_monitors`, `forward_drift_alerts` | `packages/db/src/schema/index.ts`, migration `0027_forward_drift`, rollback `packages/db/rollback/0027_forward_drift.down.sql` |
| Repository | `packages/db/src/server/forward-drift.ts` |
| Page `/forward-drift` (open alerts, monitors, drift panel, record form) | `apps/web/src/app/(portal)/forward-drift/`, `apps/web/src/components/portal/forward-drift-workspace.tsx` |

All procedures are operator-only. An agent write key may create, record and acknowledge; a read key may only list and get. `record` accepts only `source: "paper"`.

## Baseline pin

`create` takes the baseline run id and the expected strategy revision. The run must have status `succeeded`, and the expected revision must equal the run's `strategyRevision` (null for a run without a linked strategy). The monitor stores the run id and the revision; neither changes later. A finished run is immutable, so the baseline values do not change either.

Baseline values come from the run report: maximal drawdown (percent of the running peak), maximum consecutive losses, profit factor and win rate. The baseline Sharpe is calculated from the run's stored equity series (at most 2,000 points) with the same method as the paper Sharpe, so both use the same sampling rule.

## Recording paper results

`record` appends equity points (time in epoch milliseconds, equity above 0) and closed trades (time, profit or loss). One request holds at most 2,000 points and 2,000 trades. A monitor stores at most 5,000 of each. New points must be later than the last stored point, and new trades must be later than the last stored trade, so a resent request cannot store the same data twice. Trades inside one request may share a time. A request outside these limits is rejected (`BAD_REQUEST`); nothing is dropped silently.

The page accepts the same data as text, one line per value: a time and a value, separated by a comma, semicolon or space. The time is epoch milliseconds (digits only), an ISO date (`2026-10-01`) or an ISO date-time (`2026-10-01T14:30`, optionally with seconds and a zone such as `Z` or `+02:00`). A date or date-time without a zone is read as UTC. The page rejects other time formats with the line number.

The monitor row has a version number. `record` saves the new series, the levels and the raised alerts in one transaction, only when the version did not change since the read. A concurrent recording gets `CONFLICT` and must send its data again.

## Checks

Each check divides the paper value by the baseline value (the ratio) and compares the ratio with a warn and an alert threshold. A ratio within 1e-9 of a threshold counts as reaching it.

| Check | Paper value | Direction | Default warn | Default alert | Data needed |
| --- | --- | --- | --- | --- | --- |
| Max drawdown | Largest fall from a running peak of the paper equity | Higher is worse | 1.0 | 1.5 | 2 points |
| Losing streak | Longest run of paper trades with a loss (a zero trade ends the run) | Higher is worse | 1.25 | 1.5 | 1 trade |
| Rolling profit factor | Gross profit / gross loss of the last 20 trades | Lower is worse | 0.75 | 0.5 | 10 trades |
| Sharpe | Annualized from per-point returns, risk-free rate 0 | Lower is worse | 0.5 | 0 | 20 returns |
| Rolling win rate | Share of the last 20 trades with a profit | Lower is worse | 0.8 | 0.6 | 10 trades |

Rules for division and missing data:

- Drawdown divides by the baseline drawdown or 1%, whichever is larger.
- Losing streak divides by the baseline streak or 1, whichever is larger.
- Profit factor, Sharpe and win rate need a positive baseline value. Without one, the check is "insufficient".
- Without a losing trade in the window, the profit factor has no value and the check is "ok".
- Paper returns that do not vary (for example a flat series without a position) have no Sharpe; the check is "insufficient", because that is not evidence of drift.
- A check without enough data is "insufficient". The monitor level is the most severe check level; it is "insufficient" only when every check is.

`create` accepts per-check overrides of the thresholds. For "higher is worse" checks the alert threshold must be at or above the warn threshold; for "lower is worse" checks it must be at or below.

## Alerts

After each recording, a check raises one alert when its level is warn or alert and more severe than its level after the previous recording. An unchanged level, or a fall from alert to warn, raises nothing. A check that returns to ok or insufficient and crosses again raises a new alert.

Alerts are in-app rows: check, level, a text with the paper and baseline values, the ratio and both thresholds, and the time. The page lists the newest 200 open alerts at the top. "Acknowledge" closes one alert once and records who acknowledged it.

External delivery is not wired. The Vertex ntfy and email notification path accepts only governed events from the native control-plane outbox with recipient grants and consent; adding a drift event kind to that path is separate work. Vertex has no Discord notifier.

## Limits

- Paper data comes from the operator or an agent through `record`, or from the paper forward runner ([paper-forward.md](paper-forward.md)). `record` returns `CONFLICT` while the runner is running.
- Statistics use the recorded points, not every bar. The baseline Sharpe uses the run's sampled equity series.
- Thresholds are per monitor and fixed at creation.
