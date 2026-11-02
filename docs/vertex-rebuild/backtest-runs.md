# Backtest runs

Updated: 2026-10-23. Research and paper use only. Nothing in this feature creates, routes or simulates broker orders.

## Purpose

An operator or an agent queues a backtest of a rule over a date range of stored bars. The run executes as a job outside the request that created it and stores a report. A run can be linked to a strategy library row. The run then stores a snapshot of that strategy and a SHA-256 revision of the snapshot, so a later edit of the strategy does not change what the run says it tested.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `backtestRuns.submit`, `backtestRuns.get`, `backtestRuns.list` | `packages/api/src/contracts/backtest-runs.ts` |
| Procedures, execution, revision hash | `packages/api/src/server/backtest-runs.ts` |
| Report and metrics (pure) | `packages/api/src/backtest-run-report.ts` |
| Engine (shared with the instant backtest) | `packages/api/src/instant-backtest-engine.ts` |
| Cost profiles and presets (pure), contract schema | `packages/api/src/backtest-costs.ts`, `packages/api/src/contracts/backtest-cost-profiles.ts` |
| Table `backtest_runs` | `packages/db/src/schema/index.ts`, migration `0026_backtest_runs`, rollback `packages/db/rollback/0026_backtest_runs.down.sql` |
| Repository | `packages/db/src/server/backtest-runs.ts` |
| Page `/backtest-runs` | `apps/web/src/app/(portal)/backtest-runs/`, `apps/web/src/components/portal/backtest-runs-workspace.tsx`, `backtest-runs-model.ts` |
| Portfolio combination `backtestRuns.combine` | see `docs/vertex-rebuild/portfolio-combos.md` |
| Forward drift `backtestRuns.drift.*` | see `docs/vertex-rebuild/forward-drift.md` |
| Strategy definitions (rule `dsl`) | [strategy-definitions.md](strategy-definitions.md) |
| MCP tools | `backtest_runs_submit`, `backtest_runs_get`, `backtest_runs_list` in `packages/api/src/server/mcp.ts` |
| Parameter sweep `backtestRuns.sweep` | `docs/vertex-rebuild/backtest-sweeps.md` |

## Run lifecycle

1. `submit` validates the input, takes the strategy snapshot when `strategyId` is set, and inserts a `queued` row.
2. The procedure schedules the execution on the request's tracked background scheduler. The request database connection stays open until the task settles. Without a scheduler (tests), the run executes before the response.
3. Execution claims the row with a conditional update (`queued` to `running`), so a run executes at most once. It loads the bars (shared in-process cache), keeps the bars between `from` 00:00 UTC and the end of `to`, runs the engine and stores the report (`succeeded`) or a short error (`failed`). Storage errors store a generic message only.
4. `get` re-schedules a run that is still `queued`, so a lost background task still completes. The page polls `get` once a second for at most 300 reads. It fails the requested run when it stayed `running` for more than 10 minutes.

The page opens the run named in `?run=<id>`; the parameter sweep page links there after "Run full backtest".

The repository changes only `status`, timing, `error` and `report`. The spec, the strategy snapshot and the revision are written once.

## Report

Money values use the initial capital (default 10,000). The metrics are: initial deposit, final equity, total net profit, gross profit and loss, profit factor, expected payoff (net profit per trade), absolute drawdown (initial capital minus the lowest equity), maximal drawdown in money and percent of the running peak, recovery factor, Sharpe and Sortino ratios (per-bar returns, risk-free rate 0), trade counts and win rate, largest and average profit and loss trades, maximum consecutive wins, maximum consecutive losses (the longest losing streak and its money), maximal consecutive loss (the most negative losing streak and its trade count), total return, CAGR, exposure and buy-and-hold return. A trade with zero profit ends both streaks.

The equity, drawdown and price series have at most 2,000 points each; metrics always use every bar. The stored trade list has at most 5,000 trades (`tradesTruncated` marks a longer list). The page shows the metrics, equity and drawdown charts, the trade table and a trade-by-trade replay: the close price with the entry and exit of each trade up to the selected step.

## Cost profiles

`submit` accepts an optional `costProfile`: a preset id or a full custom profile. The server stores the resolved profile in the run spec, so a later preset change does not change a stored run. Engine version `instant-2` adds cost profiles; without a profile the fills are the same as `instant-1`.

A profile has these parts:

| Part | Effect on a fill |
| --- | --- |
| `spreadBps` | Full quoted spread in basis points. Each fill pays half: a buy fills higher, a sell lower. |
| `slippage` | `bps` of the price, or `atr`: a fraction of the average true range (`period` bars) up to the bar before the fill. |
| `commission` | Per share (stock), per contract with optional premium tiers (option), percent of value, minimum per order, money cap and percent-of-value cap. |
| `fees` | Per share or contract (clearing, audit trail), a fraction of the commission (pass-through) and a fraction of the sale value on sells (SEC fee). |
| `borrowFeeAnnualPct` | Short borrow fee, actual/360. The engine is long only today, so no run charges it yet; `borrowFee()` is ready for a short side. |
| `instrument`, `multiplier` | `option` counts contracts as units / multiplier (100). |

The flat `costBps` still applies on top. Charges are money for the initial capital. An entry buys the most units whose value plus charges fit the cash; when the minimum charges alone exceed the cash, the entry is skipped. The trade list shows the fill prices. With a profile, the entry price and the stop and target levels come from the cost-adjusted fill. ATR slippage is 0 until `period` bars exist. The page offers only the stock presets, because runs use stock bars; the API accepts every preset and custom profiles. A trade has `costs` (both legs) and `grossPnl` (P&L before costs). The report adds `costs`: commission, fees, spread, slippage, flat bps cost, total and net profit before costs. The page shows these rows above the metrics.

A golden test (`instant-backtest-engine.test.ts`) checks that the `zero` profile gives the same equity, statistics and trades as a run without a profile, bit for bit.

### Presets

Read from Interactive Brokers' public fee pages on 2026-10-23:

- Stocks: <https://www.interactivebrokers.com/en/pricing/commissions-stocks.php>
- Options: <https://www.interactivebrokers.com/en/pricing/commissions-options.php>

| Id | Commission | Fees included |
| --- | --- | --- |
| `ibkr-pro-fixed-us-stock` | USD 0.005 per share, minimum USD 1.00, maximum 1% of trade value | SEC 0.0000206 x sale value, FINRA CAT 0.000003 per share |
| `ibkr-pro-tiered-us-stock` | First tier (<= 300,000 shares per month): USD 0.0035 per share, minimum USD 0.35, maximum 1% | Clearing 0.0002 per share, CAT, NYSE 0.000175 and FINRA 0.000565 x commission, SEC |
| `ibkr-pro-us-option` | (<= 10,000 contracts per month) USD 0.65 per contract; 0.50 below USD 0.10 premium; 0.25 below USD 0.05; minimum USD 1.00 | OCC 0.025 + CAT 0.0003 per contract, SEC |
| `zero` | none | none |

Not included: venue exchange fees and rebates (they depend on the route), the options regulatory fee (ORF, varies by exchange), higher-volume tiers, and spread, slippage and borrow (they depend on the instrument; set them in a custom profile). Unit tests reproduce IBKR's own worked examples (for example 1,000 shares at USD 25 = USD 5.00 Fixed; 2 contracts at USD 5 premium = USD 1.30). Fees change; check the pages before relying on a preset.

## Strategy link limit

The engine runs only the rule in the run spec (moving-average cross or breakout). A linked strategy is provenance: the run records which strategy revision the operator meant to test, but the engine does not execute that strategy's own code. Read the spec for what actually ran. Rejecting strategies whose definition does not map to an engine rule needs a rule field on library entries; that is open work.

## Access

All procedures are operator-only. Agent API keys may call them; read keys may call only `list`, `get` and `sweep`.

## Limits

The execution model and limits are those of the instant backtest engine (`docs/vertex-rebuild/instant-backtest.md`): one symbol, long only, next-open fills, cost in basis points per side plus the optional cost profile above. A run is a screening result. It does not authorize a trade.
