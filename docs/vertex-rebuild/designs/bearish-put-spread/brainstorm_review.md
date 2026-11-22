# Brainstorm review: bearish put-spread rule, spread pricing, breadth series, option strategies in the engine comparison

* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/concepts_brief.md` (lines 1-71)
* **Mode:** BRAINSTORM (EGM, 7 lenses)
* **Date:** 2026-11-22
* **Repository state read:** worktree `vertex-research-public-wt-put-spread-backtest`, branch `ws/put-spread-backtest` (read-only)

## Reviewer status

No Goldfish subagent ran. The harness refused both spawn attempts with `Cannot spawn 'task'. Allowed: none (spawns disabled for this agent)`. The synthesizer then applied each lens's BRAINSTORM checklist (`agents/<lens>.md` in the EGM plugin) itself against the brief, the code and the local data. These findings come from one analyst, not from seven independent reviewers. Treat recall as lower than a full swarm would give. A rerun with spawning enabled should cover the gaps.

| Lens | Goldfish subagent | Lens analysis |
| --- | --- | --- |
| `egm-design` (design_critic: cost, quota, architecture) | not run (spawn refused twice) | done by the synthesizer |
| `egm-codebase-details` (observability, debuggability) | not run (spawn refused twice) | done by the synthesizer |
| `egm-zoom-out` (YAGNI, reuse) | not run (spawn refused twice) | done by the synthesizer |
| `egm-comprehension` (API and research ergonomics) | not run (spawn refused twice) | done by the synthesizer |
| `egm-implementation-readiness` (migration, rollout, rollback) | not run (spawn refused twice) | done by the synthesizer |
| `egm-structural` (coupling, tech debt) | not run (spawn refused twice) | done by the synthesizer |
| `egm-inventive-catalyst` (contradictions, IFR) | not run (spawn refused twice) | done by the synthesizer |

**Severity breakdown:** 🔴 3 Blockers, 🟡 16 Majors, 🟢 8 Nits.

### Evidence computed for this review

A price-only replay used the local qc-ports file `~/Documents/reports/vertex-qc-ports/data/QQQ.csv` (data through 2026-11-13, not the live DB). It ran over 2022-11-10 onward with the proxy signal: high ≥ yesterday's SMA20, close < yesterday's SMA20, close ≥ 0.98 × yesterday's SMA20. **The breadth filter was not applied**, so real counts can only be lower.

| Measure | Value |
| --- | --- |
| Sessions with QQQ close > SMA200 | 88.5% (of 1,006) |
| Proxy signals | 67 |
| Signals whose entry bar already has close > SMA200 | 61 of 67 (91%) |
| Non-overlapping trades, 1-bar hold | 56 (25 out-of-sample) |
| Non-overlapping trades, 20-bar hold | 23 (7 OOS) |
| Non-overlapping trades, 34-bar hold (≈ dte 52 minus exitDte 3, in trading days) | **18 (5 OOS)** |
| Exit on `crossesAbove` SMA200, else hold to 34 bars | 18 trades (5 OOS), median hold 34 bars |

---

## Prioritized findings (Blockers → Majors → Nits)

### 🔴 B1. The `close > SMA200` level exit closes about 91% of trades after at most one bar

* **Lens:** `egm-zoom-out`, `egm-comprehension`
* **Affected scope:** brief lines 21, 41. Code: `packages/api/src/options-engine/portfolio.ts:14-15, 644-653` (policy `flat`: "the exit is the first later bar where a DSL exit condition holds").
* **Description:** The exit is a level condition (`close > SMA200`). QQQ closed above its 200-day average on 88.5% of sessions in the window, and on 61 of the 67 proxy entry bars. The first exit bar after the signal is therefore almost always the entry bar itself or the next one. The backtest would mostly measure a 0-to-1-day hold of a 50-day spread: spread costs paid twice and almost no exposure. That is not the consult's rule. The consult's exit ("close when QQQ closes above its 200-day average") only makes sense as a *reclaim* while price is below the average.
* **Recommendation:** Before any run, restate the exit as an event: `crossesAbove` of close over SMA200 (`STRATEGY_EVENT_OPERATORS`, `strategy-dsl.ts:80-85`). An alternative is to gate entries with `close < SMA200` so the level exit means "reclaimed". Record the choice in the decision record. Add a fixture test that asserts the median hold is more than 1 bar.

### 🔴 B2. The pre-registered ≥ 30-trade gate cannot be met by the intended rule, so the outcome "not proven" is decided before the run

* **Lens:** `egm-zoom-out`, `egm-inventive-catalyst`
* **Affected scope:** brief lines 38-39, 41.
* **Description:** With one open spread at a time and the intended holds (to expiry or exitDte 3), the window holds about 18 non-overlapping trades before the breadth filter, 5 of them out of sample. Only the B1 artifact (1-bar holds) pushes the count past 30. If B1 is fixed and nothing else changes, the decision rule returns "not proven" by construction. The out-of-sample test then rests on about 5 trades, which is noise. If B1 is not fixed, the gate passes on a mis-specified strategy.
* **Recommendation:** Pick one, record it before the runs, and state the expected trade count in the decision record:
  * (a) Test the edge as an event study over **all** signals. `buildOptionsBook` prices every signal event independently (`options-engine/book.ts:558, 725-750`). Use a block bootstrap (for example by month) for the overlap. Keep the one-at-a-time ledger for equity and drawdown only.
  * (b) Extend the window back before 2022-11-10 with the breadth condition dropped (proxy plus price only). `breadth90_days` limits the window, `market_daily_points` does not.
  * (c) Accept "descriptive only" now and write that down instead of presenting a pass/fail gate.

### 🔴 B3. Adding `NYSE_UPVOL_PCT` to qc_ports `data.SERIES_IDS` breaks every file-backed qc_ports run and needs a copied CSV

* **Lens:** `egm-implementation-readiness`, `egm-structural`
* **Affected scope:** brief line 48. Code: `services/research/strategies/qc_ports/data.py:36, 152-161, 192-197`; `services/research/strategies/qc_ports/portfolio.py:99-103`.
* **Description:** `dataset_from_dir` calls `load_context(root=root)`, which loads **every** id in `SERIES_IDS`. `load_series` opens `<root>/<id>.csv` with no existence check (`_rows`). Once the id is in the tuple, every qc_ports study that reads the fetch directory raises `FileNotFoundError` unless `NYSE_UPVOL_PCT.csv` exists. That file would be a second copy of `breadth90_days`, which the brief rejects as an alternative (line 60). The worker path (`nautilus_backtest/signals.py:115`) is different: it gets the rows in the claim payload, so it only needs the id in its allow-list.
* **Recommendation:** Add the id to `signals.py` `SERIES_IDS` (the worker allow-list). Keep it out of the qc_ports default load set: either a separate `OPTIONAL_SERIES` tuple that `load_context` loads only on request, or a `load_series` branch that reads a breadth export only when asked. If the research runners need it on fixture data, give the tests a fixture file. State in the brief which Python list changes and why.

### 🟡 M1. Serving breadth from inside the generic `market_daily_series` repository couples a price-series store to a breadth table

* **Lens:** `egm-structural`
* **Affected scope:** brief line 48. Code: `packages/db/src/server/market-daily-series.ts:87-114, 250-309`.
* **Description:** `loadSeries` first checks `market_daily_series` (the catalog) and returns only ids it finds there (lines 255-262), so a non-catalog id is silently absent. A breadth branch inside this repository adds a hidden special case to a generic store whose other methods (`listSeries`, `latestPoints`, `upsertPoints`) will not know the id. Catalog-driven views will disagree with what the DSL can read.
* **Recommendation:** Add a small **virtual-series provider registry** in the API layer (`packages/api/src/server/strategy-series.ts`, which already composes loads). It maps an id to a loader plus its fill policy, and `NYSE_UPVOL_PCT` maps to the breadth repository. `market-daily-series.ts` stays unchanged. The registry is also where later non-price series (put/call ratio, GEX flips) plug in.

### 🟡 M2. Breadth semantics: final rows only and no forward fill

* **Lens:** `egm-comprehension`, `egm-codebase-details`
* **Affected scope:** brief lines 29, 48. Code: `packages/db/src/schema/index.ts:3054-3080` (`final` column); `packages/api/src/strategy-dsl-compile.ts:1558-1562` (`STRATEGY_SERIES_MAX_FILL_DAYS = 5`); `data.py` `align`.
* **Description:** `breadth90_days` stores non-final rows (`final` boolean). Both engines carry a series value forward for up to 5 trading days. That is right for a price index and wrong for a one-day breadth reading: a missing session would inherit the previous day's up-volume. Non-final intraday rows could also change `seriesSha256` between claim and complete for a run whose `to` is today.
* **Recommendation:** The loader filters `final = true`. Give the series a fill policy of 0 days (missing means no entry), set per series in the registry from M1 and mirrored in Python. Update the `STRATEGY_SERIES_IDS` doc comment (`strategy-dsl.ts:163-168`) to say "percent 0-100, final sessions only, not carried forward". Note the 15:45 live check against the final-value backtest as a limitation.

### 🟡 M3. Deploy order and rollback for the new enum value

* **Lens:** `egm-implementation-readiness`
* **Affected scope:** brief line 71. Code: `services/research/nautilus_backtest/signals.py:954, 1183` (refuses refs outside `SERIES_REFS`); `strategy-dsl.ts:474, 846` (`z.enum(STRATEGY_SERIES_REFS)`).
* **Description:** Deploy order matters. If the web/API on QuantVPS accepts `NYSE_UPVOL_PCT` before the rig worker knows it, the worker refuses the live runs. If the API rolls back after runs with the id are stored, the old schema cannot parse those definitions, and reports or lists that re-parse the spec may fail.
* **Recommendation:** Deploy the rig worker first, then the web on QuantVPS, then the driver checkout. Treat the enum as roll-forward only: to back out, revert the rule, never the id. Add a worker test that a definition with the new id is accepted.

### 🟡 M4. Academy runs from the driver can replace each other while queued

* **Lens:** `egm-implementation-readiness`, `egm-design`
* **Affected scope:** brief lines 33, 50. Code: `packages/api/src/server/academy.ts:256-273` ("a new one replaces the older queued Academy runs of this user", `latest: true`); `scripts/engine-comparison-driver/driver.ts:1-8, 91-98`.
* **Description:** If the driver sends two academy requests (cash-secured put, then iron condor) back to back with one key, the second can replace the first before the worker claims it. The driver's time budgets (instant phase 45 min, claim wait 15 min each, unit limit 2 h) were sized for instant runs only. Identical requests on a non-trading day reuse an existing group, as the instant reuse window already handles. The header comment and tests list the procedures the driver may call (`instantBacktest.run`, `backtestRuns.sweep`, `comparisons.list`, `autopilot.campaigns.tick`). `academy.backtest` is not on that list.
* **Recommendation:** Add a separate academy phase that waits for the claim (`waitClaimed`) between requests, with its own budget and `FAIL academy …` log lines. Handle a reused group. Update the header allow-list, `driver.test.ts` and `infra/engine-comparison-driver/README.md`.

### 🟡 M5. The academy comparison does not test the code path the bearish rule uses

* **Lens:** `egm-zoom-out`
* **Affected scope:** brief lines 25, 33, 50. Code: `packages/academy/src/backtest.ts:2, 159-162, 464` (IV from trailing realized volatility × `ivMult`, flat across strikes, for all tickers except SPY); `options-engine/pricing.ts` (VXN × 0.9 with skew); `packages/api/src/server/backtest-run-engine.ts:232, 275-287` (an options run never goes in a comparison batch).
* **Description:** Academy option backtests run on their own model. For QQQ that means realized volatility with no VXN and no skew. Daily academy runs therefore prove academy parity, which already passed on 2026-11-10. They do not prove anything about the `options` block or `putDebitVertical` path the rule runs on. That path is checked only per submitted run, by the 1e-6 ledger gate.
* **Recommendation:** If item 4 stays, choose the academy `put_debit_spread` structure. It exists in `packages/academy/src/schema.ts:323-327` and is closest to the rule. Also consider having the driver submit the stored bearish definition daily with `backtestRuns.submit`, which runs the real options engine through the 1e-6 gate every day. Otherwise state that item 4 is coverage for academy short-premium only and is unrelated to the rule (see M16).

### 🟡 M6. Model inputs and live quotes are taken at different times

* **Lens:** `egm-design`, `egm-comprehension`
* **Affected scope:** brief line 47. Code: `packages/api/src/contracts/options-chain.ts:151-152` (the chain returns live `spot` and `spotSource`); `options-chain-greeks.ts:134-145` (`yearsToExpiry(now)`) against the engine's calendar days / 365 from the close.
* **Description:** The procedure prices the model from the latest **stored** daily spot, VXN and IRX (usually the prior close) and compares that with **live** quotes. The reported model-to-mid gap then mixes the intraday move with model error.
* **Recommendation:** Use the chain's live spot for the model. Return every input with its value and as-of (spot and source, VXN date, IRX date, years to expiry and its convention), and allow optional input overrides so a past consult can be reproduced (13.06 / 13.37 against 12.76).

### 🟡 M7. Each leg's quote source and freshness must be visible

* **Lens:** `egm-codebase-details`
* **Affected scope:** brief line 47. Code: `packages/api/src/contracts/options-chain.ts:6-23, 77-113` (sources merged per field; bid and ask of one contract come from one source); `server/options-chain.ts:33, 151-255`.
* **Description:** The two legs can come from different sources (Quant Data, IBKR, Yahoo) with different delays. Outside market hours a leg can have a zero bid. A spread priced from mismatched or missing quotes looks valid but is not.
* **Recommendation:** The output includes each leg's bid, ask, mid, source and delay flag, plus a `quality` field: `ok`, `mixed-sources`, `missing-quote` or `crossed`. Debit "at the worse sides" is null when a side is missing, not 0. The procedure never invents a quote.

### 🟡 M8. Quota: the spread procedure must reuse the cached chain read

* **Lens:** `egm-design`
* **Affected scope:** brief line 47. Code: `server/options-chain.ts:33, 70, 274` (60 s cache per symbol and expiry).
* **Description:** Agents will call a spread tool in loops (strike scans). If it reaches the sources directly, IBKR pacing and Yahoo limits are at risk.
* **Recommendation:** Build `optionsChain.spread` on the same cached internal read as `optionsChain.chain` (one read per symbol and expiry per 60 s). Consider batch input (several strike pairs, one expiry, one read). Return the cache age.

### 🟡 M9. The model exists only for the Core 7 symbols

* **Lens:** `egm-comprehension`
* **Affected scope:** brief line 47. Code: `options-engine/pricing.ts:24-57, 150-155, 179-185` (`atmIv`, `halfSpread` and `SKEW` throw for unknown ids).
* **Description:** The chain serves any optionable symbol, but the model throws outside the Core 7 ETFs.
* **Recommendation:** For symbols without a model, return the quote side with `model: null` and a reason (`no IV index for NVDA`) instead of a 500. Document the supported list in the contract summary.

### 🟡 M10. Units and leg input are ambiguous

* **Lens:** `egm-comprehension`
* **Affected scope:** brief lines 10, 47.
* **Description:** The consult works in per-share prices (13.06), while the engine's cost functions return $ per contract (`legCost`). "Either side" leaves open how a caller says debit or credit.
* **Recommendation:** Input: `{symbol, expiry, right, longStrike, shortStrike}`. Debit or credit follows from the strikes, and equal strikes are refused. Output labels every amount as per share and per contract, gives the costed debit both at the quotes and under the engine cost model, and reports cost as % of width.

### 🟡 M11. Three hand-synced series id lists drift

* **Lens:** `egm-structural`
* **Affected scope:** brief line 48. Code: `strategy-dsl.ts:169-202`; `nautilus_backtest/signals.py:112-132`; `qc_ports/data.py:32-36`; `strategy-dsl.test.ts:372` (`toHaveLength(32)`).
* **Description:** Each new series id has to be added by hand to two Python lists and one TypeScript list, plus a length test. Only a comment links them.
* **Recommendation:** Add a parity test, for example a JSON fixture written from `STRATEGY_SERIES_IDS` and asserted in pytest against `signals.SERIES_IDS`, or one manifest file. Keep the qc_ports file-backed set apart on purpose (B3).

### 🟡 M12. The two exit runs do not bracket the owner exit rule

* **Lens:** `egm-comprehension`, `egm-inventive-catalyst`
* **Affected scope:** brief lines 21, 41, 62.
* **Description:** For each trade the owner rule takes one of two results: the T-3 close (if losing at T-3) or the expiry result (if winning at T-3). Across trades the total can fall outside both run totals. And because exit dates shift the next entry under one-at-a-time, the trade sets of the two runs differ. "Two runs bracket it" is not guaranteed.
* **Recommendation:** Add a ledger overlay. Take the hold-to-expiry run's trades with their daily marks, apply the owner rule per trade (mark at T-3 < entry → close at the T-3 mark, else the expiry result) and report it as a third, derived figure. No engine or golden change. Otherwise say "two variants", not "bracket".

### 🟡 M13. Edge test and portfolio simulation should be separate

* **Lens:** `egm-inventive-catalyst`
* **Affected scope:** brief lines 38-39.
* **Description:** One-at-a-time ledger results answer "what would this book have made". They throw away most signals as evidence of edge, which drives B2.
* **Recommendation:** See B2 (a). The book prices every event. Bootstrap per-signal outcomes with blocks, and compare with the baseline priced on the same dates.

### 🟡 M14. The 5 real-flip sessions have no outcomes yet, and nothing records flips going forward

* **Lens:** `egm-zoom-out`, `egm-inventive-catalyst`
* **Affected scope:** brief lines 28, 37.
* **Description:** Spreads entered 2026-11-17 to 2026-11-21 expire in January 2027, so "report the 5 sessions separately" can only list signals. Flip history for QQQ grows only as long as `flow_gex` keeps writing it, and `openbb_option_iv_daily.gamma_flip` is empty for QQQ.
* **Recommendation:** Report those sessions as a signal log with mark-to-model. Open a follow-up card to persist a daily QQQ flip (fill `gamma_flip` for QQQ, or snapshot `flow_gex` at 15:45) so the real rule becomes testable later. Pre-register that forward test now, with the rule definition and the date it will be evaluated.

### 🟡 M15. Runs, driver lines and refusals need labels and IDs for later triage

* **Lens:** `egm-codebase-details`
* **Affected scope:** brief lines 49-51.
* **Recommendation:**
  * Live run names carry `SMA20 proxy` (never "gamma flip"), the variant (`exitDte3`, `toExpiry`, `baseline`) and the definition hash.
  * The job report lists both engines' run ids, `seriesSha256` and the ledger gap.
  * The driver logs one line per academy request (structure, group id, outcome), as it does for instant runs.
  * A worker refusal for an unknown series names the id and the "deploy the worker first" cause, so a deploy-order mistake (M3) is triaged in minutes.

### 🟡 M16. One PR with three deploy targets widens the rollback blast radius

* **Lens:** `egm-implementation-readiness`, `egm-zoom-out`
* **Affected scope:** brief lines 70-71.
* **Description:** Items 1-3 are research code (API plus worker). Item 4 changes a daily operational job on the rig and serves a different goal (M5).
* **Recommendation:** Keep the focused commits, but ship item 4 as its own PR or deploy step so the driver can be reverted without touching the series id (M3).

### 🟢 N1. `exitDte` counts calendar days; the owner rule counts trading days

* **Lens:** `egm-comprehension`
* **Affected scope:** brief lines 21, 41.
* **Description and recommendation:** They agree for a Friday expiry with no holiday. They differ for holiday-shifted expiries (for example a Thursday expiry before Good Friday). State this in the limitations.

### 🟢 N2. Settlement at expiry

* **Lens:** `egm-comprehension`
* **Description and recommendation:** The engine settles at expiry intrinsic value. The owner closes at 15:45 on expiry day. Pin risk and American early exercise of the short put are not modelled. List these as limitations.

### 🟢 N3. Two Black-Scholes implementations in one output

* **Lens:** `egm-structural`
* **Affected scope:** brief line 47. Code: `options-engine/pricing.ts:61, 106-147` (libm `erfc`, golden-pinned to Python); `options-chain-greeks.ts:51-57` (`erf`).
* **Recommendation:** Use `bsPrice` and `bsDelta` for model price and delta, so they match how the engine picks strikes. Use `blackScholes` only for gamma, theta and vega, with the same sigma, t and q. Add a test that both deltas agree within 1e-9. Do not add Greeks to the golden-pinned `pricing.ts`.

### 🟢 N4. Rule definitions written twice

* **Lens:** `egm-structural`
* **Description and recommendation:** The definitions sit in `ideas.py` and as JSON in `docs/specs/strategies/bearish-put-spread.md`. Add a test that the JSON in the spec equals the `ideas.py` constants, or generate the spec block.

### 🟢 N5. Condition 4 passes almost always in the model, so make it a live check

* **Lens:** `egm-inventive-catalyst`
* **Description and recommendation:** At fixed deltas the model's cost per width is nearly constant (12.76 / 45 ≈ 28%). The pricing tool should evaluate condition 4 live, and the backtest should report the cost-per-width distribution only.

### 🟢 N6. Doc comment

* **Lens:** `egm-comprehension`
* **Recommendation:** The `STRATEGY_SERIES_IDS` comment says each series is "the close". Add the breadth meaning (see M2).

### 🟢 N7. Test length assertion

* **Lens:** `egm-implementation-readiness`
* **Recommendation:** `strategy-dsl.test.ts:372` expects 32 ids. Update it to 33 in the same commit as the id.

### 🟢 N8. Sensitivity should also move the skew

* **Lens:** `egm-design`
* **Recommendation:** ±4 vol points moves the level but not the slope. Strike placement and cost per width depend on `SKEW` (QQQ -0.25), so add a slope ±0.1 case.

---

## Inventive contradictions (egm-inventive-catalyst)

| # | Contradiction | Resolution pattern | Trade-off |
| --- | --- | --- | --- |
| C1 | Exact owner exit rule vs. leaving both engines and their golden ledgers unchanged | **Derived view over stored marks** (ledger overlay, M12) | A third, derived figure needs its own test and must not be stored as an engine run |
| C2 | Statistical power vs. one open spread at a time | **Split the evaluation from the execution**: event study on the book for edge, ledger for equity (B2a, M13) | Overlapping samples need a block bootstrap; two kinds of figure to explain |
| C3 | Breadth without a data copy vs. one uniform series contract for both engines | **Provider registry / adapter**: a virtual series behind the same `StrategySeriesLoader` contract, with a fill policy per series (M1, M2) | A small registry to maintain. Python research runners still need a fixture or export path (B3) |
| C4 | A reproducible pricing tool vs. live, changing chain quotes | **Pure core plus a thin I/O shell**: `priceVertical(inputs)` is deterministic and tested on the consult numbers; the procedure only collects inputs and echoes them (M6, M7) | Response size grows by the echoed inputs |
| C5 | Testing the real flip rule vs. no flip history | **Prospective registry**: start persisting QQQ flips daily and pre-register the forward test (M14) | Results come in months, not this job |

Item 2 of the concept (the breadth series) has no false compromise: it is needed and cheap once B3 and M1 are handled.

## Strongest counter-arguments to the concept

1. **The study cannot answer the consult's question.** There is no flip history, the four knowledge bases agree that SMA20 is not a gamma flip, and with honest holds the gate is unreachable (B2). The result will say little about the consult's rule. The work most likely to make the rule testable is recording flips (M14), and that is out of scope.
2. **As written, the backtest measures a different strategy.** The level exit makes about 91% of trades last at most one bar (B1). Any pass/fail on the current definition would be about that artifact.
3. **Item 4 does not serve the stated goal.** Academy runs use a different option model and already passed parity (M5). They add a daily job surface with replacement and budget risks (M4) without touching the rule's engine path.
4. **The model side of the pricing tool is uncalibrated** (calibration is the separate card vertex-option-model-calibration). The model-to-mid gap mostly measures known model error and the timing mismatch (M6). A pure function plus a script would answer the widthSigma-to-delta question with no new API surface. The counter to this counter: agents need the tool through the API, and the quote side alone is valuable.
5. **Four concerns in one PR across three hosts** make rollback all-or-nothing (M3, M16).

## Ideal Final Result

Vertex tests the rule with what it already has, adds no new engine modes and keeps no copy of any data:

* **Breadth** reaches both engines through one virtual-series provider: final sessions only, no carry, registered once and checked by a cross-language parity test.
* **One pure `priceVertical` core** serves three uses: the `optionsChain.spread` procedure (live, on the cached chain read, every input echoed with its as-of), the report's per-entry cost-per-width table, and the live condition-4 check.
* **The rule definition** uses an event exit (reclaiming SMA200). Edge is judged by an event study over every signal priced by the existing book, with a block bootstrap against the baseline priced on the same dates. Equity and drawdown come from the one-at-a-time ledger. The owner exit is a derived overlay on stored marks.
* **The comparison driver** runs the definition the research depends on: the stored bearish definition through `backtestRuns.submit`, the academy `put_debit_spread` lesson, or both, in their own phase with claim waits.
* **A daily QQQ flip record** starts now, with a pre-registered forward test, so the real gamma-flip rule becomes provable later without another design.

## Suggested changes to the brief before implementation

1. Change the exit to `crossesAbove` SMA200, or add a `close < SMA200` entry gate (B1). State the expected trade count with the evidence table above.
2. Replace or extend the decision rule with the event-study test, or declare the result descriptive in advance (B2).
3. Name the Python lists that change: the worker yes, the qc_ports default set no (B3). Add the registry, `final = true` and no-fill semantics (M1, M2).
4. Pricing procedure contract: explicit legs, units, live spot, per-leg sources, `model: null` outside the Core 7, cached read (M6-M10).
5. Driver: its own academy phase with claim waits, the `put_debit_spread` structure or the stored definition, updated allow-list and docs, a separate deploy step (M4, M5, M16).
6. Deploy order: worker, then web, then driver. The enum is roll-forward only (M3).
7. Replace "bracket" with the overlay or with "two variants" (M12). Open a follow-up card to persist QQQ flips (M14).
