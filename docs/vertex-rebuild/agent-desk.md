# Paper agent desk

Status: research tool, paper only. It sends no orders and has no broker, network or order code.

Source: ported from vertex-research PR #2 (`feat/paper-agent-desk`, commit `8d0b799b`, reel brief IG `DekKdTQorlC`). The port fixes the defects that the 2026-10-18 review found in that PR. See "Changes from PR #2".

## What it does

The desk runs five deterministic agents for each ticker. It reads accepted report revisions. It does not collect data and it does not call a model.

| Agent | Input | Output |
| --- | --- | --- |
| `fundamental` | fundamentals, committee and news datasets | Last earnings date and age, base-case valuation, committee status. Evidence older than 100 days blocks entries. |
| `news-sentiment` | news dataset, optional sentiment file | Recent news, upcoming and undated catalysts, risk count, counts of supplied X/social labels. |
| `technical` | market history | Close above the 200-session SMA, SMA rising over 20 sessions, ROC63 within ±3 % after a ROC63 of at least 10 % in the previous 63 sessions. |
| `backtest` | market history | The same rule replayed on the ticker's history, 5 bps per side. |
| `process` | the four results and the paper book | `paper-open`, `watch`, `no-action`, or the state of an active paper position. |

Options-only rule (owner, 2026-10-16): a paper position records the underlying reference price for process review. It does not select or price an option, and it does not propose a share position. The text summary states this on its second line.

## Trade model

The paper book and the backtest use the same function (`simulateTrade`), so their fills agree:

- A signal at the close of bar t enters at the open of bar t+1. The close is used when the open is missing.
- A close below the SMA, the entry bar included, exits at the open of the next bar.
- Otherwise the trade exits at the close of its 63rd bar. The entry bar is bar 1.
- After an exit, the next signal can come no earlier than the bar after the exit bar.

Each run replays every active position from its signal bar. Exits between runs are found even when the desk did not run on those days.

Evidence dated after the run date is not used. Bars, news items and financial facts after `--as-of` are ignored. A fundamentals, committee or news dataset captured after `--as-of` contributes no valuation, committee or catalyst view. A sentiment file dated after `--as-of` is excluded.

## Usage

The report datasets are still in the Workspace app (`~/Github/trading/vertex-research/data`). The merge plan moves them to PostgreSQL in phase P1. Until then, the desk reads them read-only through `--data-root`.

```sh
bun run agent-desk -- --data-root ~/Github/trading/vertex-research/data --tickers AAPL,NVDA,MSFT,AMZN,CRWD --as-of 2026-09-10
bun run agent-desk -- --data-root ~/Github/trading/vertex-research/data --tickers AAPL,NVDA --write
```

- Without `--write`, the command prints the run and saves nothing.
- With `--write`, it saves `private/agent-desk/paper-book.json` and `private/agent-desk/runs/<as-of>.json`. The `private/` folder is ignored by Git. Files are 0600 in 0700 folders. A lock file stops two writers at the same time.
- `--write` refuses a run date after today and a run date before the last saved run.
- `--json` prints the full run report.
- A sentiment file goes in `private/agent-desk/sentiment/<ID>.json`: `{ "asOf", "source", "posts": [{ "date", "stance": "bull" | "bear" | "neutral" }] }`. No collector writes this file.

## Limits

- Backtests are in-sample on underlying prices. They include no dividends, option pricing, taxes or survivorship correction. They are not a forecast and not trade approval.
- Analyst estimates, revisions and the next earnings date are not collected.
- Active positions of tickers that are not in a run are not updated. They still count toward the cap of 5 active positions and are listed under "Not in this run".
- A committee dataset captured after the run date gives no committee view. It does not block an entry by itself; the fundamentals dataset from the same capture normally blocks.
- If a `--write` run stops abnormally, `paper-book.json.lock` can remain. Delete it only when no desk run is active.

## Changes from PR #2

- Fundamentals, committee and catalyst views from datasets captured after the run date are excluded (PR #2 showed negative evidence ages and passed the gate).
- The backtest checks the entry bar's close against the SMA.
- Paper exits are replayed from the signal bar, so a dip between runs and the 63-session hold exit are found on time.
- Paper entries and exits fill at the next open, the same as the backtest.
- A same-date rerun after a close does not reopen the position. A dry run for an earlier date hides positions opened later and replays positions closed later.
- The text summary states the options-only policy and labels returns as underlying reference returns.
- `requiredSamples` is 220 bars, the first bar with every rule input.
- The reason text names the rule checks that failed.
- A missing asset type is treated as a company; only ETF, index and future skip fundamentals.
- CLI: strict flags (`--write=false` is an error), real calendar dates, a write lock, and no leftover temporary files.
- Report reader: the market dataset must match the catalog symbol and currency, a `security` block must match the catalog, report IDs must be unique, and sentiment files are opened without following links.
