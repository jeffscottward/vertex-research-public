# Paper agent desk

Status: research tool, paper only. It sends no orders and has no broker, network or order code.

Source: ported from vertex-research PR #2 (`feat/paper-agent-desk`, commit `8d0b799b`, reel brief IG `DekKdTQorlC`). The port fixes the defects that the 2026-10-18 review found in that PR. See "Changes from PR #2".

## What it does

The desk runs six deterministic agents for each ticker. It reads accepted report revisions. It does not collect data and it does not call a model.

| Agent | Input | Output |
| --- | --- | --- |
| `fundamental` | fundamentals, committee and news datasets | Last earnings date and age, base-case valuation, committee status. Evidence older than 100 days blocks entries. |
| `news-sentiment` | news dataset, optional sentiment file | Recent news, upcoming and undated catalysts, risk count, counts of supplied X/social labels. |
| `technical` | market history | Close above the 200-session SMA, SMA rising over 20 sessions, ROC63 within ±3 % after a ROC63 of at least 10 % in the previous 63 sessions. |
| `backtest` | market history | The same rule replayed on the ticker's history, 5 bps per side. |
| `process` | the four results and the paper book | `paper-open`, `watch`, `no-action`, or the state of an active paper position. |
| `pitch` | the fundamental, news-sentiment and technical results, and the valuation scenarios of the fundamentals dataset | One readiness posture with its reasons, the bear, base and bull cases, exit references and upcoming catalysts. Analysis only: the `process` agent and the paper book do not read it. |

Options-only rule (owner, 2026-10-16): a paper position records the underlying reference price for process review. It does not select or price an option, and it does not propose a share position. The text summary states this on its second line.

## Pitch agent

The pitch agent (`scripts/agent-desk/pitch.ts`) adapts the structure of LangAlpha's trade-pitch and research-conventions skills (Apache-2.0, see `NOTICE`). Short terms of art (the posture names) are kept; no LangAlpha code or passages are copied, and no model is called.

- **Posture.** One of `review-ready`, `screen-grade`, `not-ready` and `blocked`, read from one ordered table; the lowest row that holds sets it. `blocked`: the fundamentals dataset or the daily bars are missing. `not-ready`: fundamentals or bars are stale, the bars are too few, or the committee status is `insufficient-data`. `screen-grade`: fewer than three scenario cases (also when the fundamentals dataset is dated after the run date, and the reason says so), three cases that are not ordered bear, base, bull, or no upcoming dated catalyst. `review-ready`: the sentiment labels are missing or stale, or the committee view is missing, undated or dated after the run date. `postureReasons` names every input responsible and is never empty. Posture grades the evidence, not the strength of the view.
- **Top of the ladder.** LangAlpha's top posture, `decision-grade`, is deliberately not used. The desk does not collect scenario probabilities or bear-case liquidity checks, so the Vertex ladder stops at `review-ready`. When no table row holds, the posture is `review-ready` and the one reason names those two missing inputs.
- **Not applicable.** For an ETF, index or future the status is `not-applicable`, `posture` is `null`, and `postureReasons` says that company fundamentals do not apply.
- **Direction.** `long-supported` needs base-case upside, a close above the SMA and a rising SMA. `not-supported` means one of them fails. `unknown` means an input is missing, or the base case is not in the scenario list below. The desk is long-only, so there is no short direction. Direction is not an instruction.
- **Scenarios.** The bear, base and bull cases with `upsidePct` and `presentPrice`. A case is dropped as a data error when its `upsidePct` is not a finite number, is below -100 or is above 100,000. `presentPrice` is `null` unless it is a finite number, at most 1,000,000,000, and above 0 after rounding to four decimals. A fundamentals dataset captured after the run date gives no scenarios. `skew` is given only when all three cases exist and are ordered bear, base, bull by `upsidePct`. The agent does not read scenario probabilities, so `skew` is labelled `illustrative` and `probabilityWeightedUpsidePct` is always `null`.
- **Exits.** `smaExitReference` is the rule's SMA (200 sessions by default) at the latest bar, with its distance from the close in percent. It is given only while the close is above the SMA, so the distance is negative (or 0 after rounding); otherwise it is `null`. It is a reference level, not a stop order. `reUnderwrite` lists the changes that break a `long-supported` view, including a close below the SMA; it is empty for any other direction. A scenario figure in it is quoted from the fundamentals dataset with the dataset's capture date. `nextCatalyst` is the nearest dated catalyst after the run date. It is an event, not a deadline.
- **Monitoring.** At most five upcoming dated catalysts, nearest first; catalysts on the same date are ordered by the shown title. A title is shown on one line: each run of white space or invisible characters becomes one space, `|` becomes `/`, and the title is cut to 120 characters. A catalyst with no visible title is dropped.

The text summary shows one `Pitch (analysis only)` line for each ticker: posture (or `not-applicable`), direction, `SMA exit reference` and `next catalyst`. The run report gains `tickers[].agents.pitch`; `version` stays 1, because the version number is also the paper book's format version and no code reads saved run reports.

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
