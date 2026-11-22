# Codebase Details Goldfish review: bearish put-spread design

* **Mode:** REVIEW, Stage 9 Implementation Readiness Test
* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`
* **DetailedRange:** lines 149-189 (Detailed Implementation, Testing and acceptance, Limitations). FeatureRange (lines 1-148) was read for context. Line numbers below refer to the design file.
* **Standard:** `resources/document_standards/implementation-readiness-standard.md` (zero-decision rule, phasing, exact file boundary, actionable steps, test plan)
* **Worktree state:** HEAD `17fe7095`. The worktree already holds uncommitted implementation work for this design (`git status`: `vertical-spread.ts`/`.test.ts`, `virtual-daily-series.ts`/`.test.ts`, `qc_ports/bearish_put.py`, `test_series_ids_parity.py`, and edits to `market-daily-series.ts`, `strategy-dsl.ts`, `signals.py`, `ci-suites.txt`). Where this work disagrees with the design, it is reported below; the design is the document under review.

## Verdict

**Not implementation-ready.** Two claims contradict the code: the 1e-6 "existing gate" and the feasibility of the 1e-9 delta agreement test. The plan's file boundary has also already diverged from the work in the worktree (`ideas.py` versus `bearish_put.py`, five versus four definitions). Several edge cases and test cases are still left for the implementer to decide: the driver academy phase, the spread handler errors, the spec-JSON format and the staleness of model inputs. The plan also has no phases.

Verified as accurate: `loadSeries` routing and column semantics, the `readChain` 60 s cache, `signals.SERIES_IDS` with worker validation through `SERIES_REFS`, the qc_ports `data.SERIES_IDS` file loading, the academy `academy/backtest` contract and comparison queueing, the driver claim-wait structure, runner exit and placement semantics, and the Limitations model constants.

## Findings

### 1. 🔴 Blocker: "engine parity 1e-6 (existing gate)" contradicts the API re-run check

* **Affected:** line 175 (also lines 44 and 98 in FeatureRange; line 147).
* **Code:** The API's re-run of the TypeScript runner on worker completion (`packages/api/src/server/backtest-run-engine.ts` `optionsResultMismatch`, lines ~486-520) compares daily equity, prices, `returnOnRisk` and `maxLoss` within `ENGINE_STATS_TOLERANCE = 1e-9` (relative, line 79). It compares fees and pnl within one cent (`CENT = 0.01 + 1e-9`) and requires identical run days, open positions, trade count and skips. The 1e-6 value is `PARITY_REL_TOL` in `services/research/strategies/qc_ports/portfolio.py:60`. That is the worker-internal NautilusTrader-versus-Python-ledger parity inside `run_definition(..., nautilus=True)`, reported as `nautilusGap`.
* **Why it matters:** Readers will treat 1e-6 as the acceptance gate for the five live runs and for the "Tolerances fixed before code" line. The real API gate is three orders of magnitude tighter, and it covers more fields than a "ledger gap".
* **Recommendation:** Replace this with two gates. (a) The worker's Nautilus-versus-ledger parity: `PARITY_REL_TOL` 1e-6 → `nautilusGap`. (b) The API's TypeScript-versus-worker check: `ENGINE_STATS_TOLERANCE` 1e-9 relative, with fees and pnl within one cent. Correct lines 44, 98 and 175.

### 2. 🔴 Blocker: the planned 1e-9 delta-agreement test cannot pass

* **Affected:** line 154 (`vertical-spread.test.ts`: "delta agreement of `bsDelta` and `blackScholes` within 1e-9"); line 105 (FeatureRange).
* **Code:** `bsDelta` (`options-engine/pricing.ts:130`) uses `normCdf = 0.5 * erfc(...)` with the correctly rounded `erfc` of `libm.ts`. `blackScholes` (`options-chain-greeks.ts:57`) uses `normalCdf` built on the Abramowitz-Stegun 7.1.26 `erf` (lines 37-48), and its comment says "absolute error below 1.5e-7". A put delta of `-carry·N(-d1)` therefore differs between the two by up to about 7.5e-8. That is roughly 75 times the planned tolerance.
* **Why it matters:** Following the plan literally produces a failing test, or forces the implementer to choose a new tolerance. Either way, the zero-decision rule is broken.
* **Recommendation:** Set the tolerance to `2e-7` (bounded by the A&S error times `carry ≤ 1`), or drop the test. State that the model's net delta comes from `bsDelta`, as line 105 says, and that only gamma, theta and vega come from `blackScholes`.

### 3. 🟡 Major: the file boundary for the rule definitions disagrees with the work in the worktree

* **Affected:** lines 167-168 (and lines 116-122 in FeatureRange).
* **Design:** Five constants in `services/research/strategies/qc_ports/ideas.py`: `BEAR_PUT_EXIT3`, `BEAR_PUT_EXPIRY`, `BEAR_PUT_BASELINE`, `BEAR_PUT_LONG_EXIT3` and `BEAR_PUT_LONG_BASELINE`.
* **Worktree:** A new file `services/research/strategies/qc_ports/bearish_put.py` imports the builders from `ideas.py`. It defines four definitions (`RULE_EXIT3`, `RULE_EXPIRY`, `PROXY_EXIT3`, `BASELINE`) with a `DEFINITIONS` map keyed by "Spec heading". Its names do not carry the window.
* **Also:** `ideas.py`'s module docstring scopes it to "The 11 QuantConnect idea ports", and `IDEAS`/`__all__` are curated (`test_qc_ports_ideas.py:65` counts runs). Putting non-QC definitions there clashes with the file's stated purpose. The window is a submit parameter (`from`/`to` of `BacktestRunSubmitInputSchema`); it is not a definition property. So `BEAR_PUT_BASELINE` and `BEAR_PUT_LONG_BASELINE`, and the two EXIT3 variants, differ only in `name`. `backtestRuns.submit` has no `name` field; the run name is the definition name.
* **Recommendation:** Pick one file and record it as `Create` or `Modify`. `bearish_put.py`, reusing the `ideas.py` builders, is the cleaner choice. Fix the constant names and their count. Say explicitly that the window lives only in the definition `name` and in the submit `from`/`to`. List the exact `from`/`to` of each of the five submits; D2 gives the windows, but the submit list on line 123 does not map them to runs.

### 4. 🟡 Major: no phases or checkpoints

* **Affected:** lines 149-175.
* **Standard:** "The plan must partition the work into logical, incremental phases. Each phase must leave the codebase in a stable, buildable, and testable state."
* **Gap:** The Detailed Implementation is one flat table. One ordering constraint is hard and is already stated for deploy (lines 130-136): the worker must know `NYSE_UPVOL_PCT` before the API accepts it, so `signals.py` and the parity test must land with or before `strategy-dsl.ts`. The plan does not carry that ordering into the commits or PRs.
* **Recommendation:** Add phases. For example: P1 the series id plus the registry and parity test; P2 the spread pricing and procedure plus OpenAPI; P3 the definitions, spec and tests; P4 the driver academy phase plus README; P5 the live runs and event study (operational). Give each phase its own verification commands.

### 5. 🟡 Major: the driver academy phase leaves several decisions to the implementer

* **Affected:** line 171 (and line 128 in FeatureRange).
* **Code facts:** `runEngineComparisonDriver` (`scripts/engine-comparison-driver/driver.ts:449-476`) runs `runInstants` → `runSweep` → `runCampaign` → summary, and returns 0 or 1 by `log.failures` (`CONFIG_ERROR_EXIT` 2 for configuration). `runInstant` handles these outcomes: `comparison` undefined ("engine comparison off or read-only key"), `error`/`groupId null`, `reused` (with a one-time reuse-window wait in `requestInstant`, `REUSE_WAIT_MAX_MS` 20 min), `superseded`, claim `timeout` (stops the phase), 404 `NO_STORED_BARS` (skip) and 403 (stop). The academy handler (`packages/api/src/server/academy.ts:281-420`) answers `comparison` only when the queue is on and `academyEngineResult` maps the result. A "no comparison" can therefore also mean an unmappable result. Its 404 text is `No stored daily bars for QQQ. Import them with bun run vertex:bars:import.`, which differs from `NO_STORED_BARS = "No stored bars for this series"`. Its group id depends on the bar window's last date and the series SHA, so on weekends and holidays an identical request is `reused`.
* **Undecided:** (a) the position of the phase relative to the sweep and the campaign ("after the instant runs" is ambiguous); (b) its time budget (`INSTANT_PHASE_MAX_MS` covers instants only; the service allows 2 h); (c) whether an instant-phase `stop` (claim timeout or 403) also skips the academy phase; (d) whether `requestInstant`'s reuse-wait applies; (e) whether each outcome counts as `log.fail` (and so affects the exit code) or `log.ok`; (f) how `end` "today" is computed (UTC versus New York date; the input regex is `YYYY-MM-DD`); (g) whether `capital` and `rules` are sent or left to their defaults (`100_000`, `{}` → the lesson preset); (h) the exact log line texts; (i) whether the summary line counts academy groups.
* **Reuse:** Generalise `requestInstant` and `runInstant` (and `ComparedSchema`/`TimingSchema`, which already parse the academy `comparison` shape `{groupId, reused, error}`). Do not write a parallel path.
* **Recommendation:** Specify (a) to (i), and name the reused helpers.

### 6. 🟡 Major: the driver test cases are not enumerated

* **Affected:** line 171 (`driver.test.ts`: "Academy phase with claim waits and log lines").
* **Recommendation:** List the cases. Both academy requests are queued and claimed in order, and the second request is sent only after the first is claimed. A claim timeout. A superseded run. A reused group. Comparison off (`comparison` absent). A queue error (`error` set, `groupId` null). A 404 on missing bars. A 403. The academy phase is skipped or kept after an instant-phase stop. The exit code with academy failures. The exact request bodies (`slug`, `ticker`, `start`, `end`).

### 7. 🟡 Major: spread handler failure modes and model-input edge cases are unspecified

* **Affected:** lines 155-159 (and line 106 in FeatureRange).
* **Code facts:**
  * The existing `chain` handler (`server/options-chain.ts:320-338`) maps source failures with `mapFailure` to `UPSTREAM_ERROR`/`UNAVAILABLE` and throws `NOT_FOUND` when `read.expiry === null`. The spread design says only that each part "may be null with a reason". It does not say whether an unlisted expiry or a failed chain read throws, as `chain` does, or returns both parts null.
  * `OptionContractSchema` has nullable `bid`/`ask`. The code comment says Quant Data alone can serve the chain without bid and ask. A present leg with no two-sided quote is a distinct reason, and it is missing from the reason list (missing leg, crossed quotes, no model, missing IV index or spot, expiry today).
  * `context.repositories.marketDailySeries` is optional (`openbb.ts:94-103` checks for `undefined`). The behaviour when the store is absent is not stated.
  * `latestPoints` returns the point on `last_date` with no age limit. The runner refuses IV and rate values older than `MAX_FILL_DAYS = 5` (`options-engine/portfolio.ts`; `qc_ports/data.py`). The design sets no staleness rule for VXN or IRX, so a model value from a stale index would be presented as current.
  * "No model for the symbol" is undefined. The working-tree `priceVerticalFromModel` refuses a symbol without `SKEW`. `atmIv` also needs an `ATM_FACTOR` for the index, and `STRATEGY_IV_INDEX` must map the symbol. `halfSpread` throws for a symbol without `HALF_SPREAD_PCT`, and `DIVIDEND_YIELD` defaults to 0.
  * The model uses integer chain `dte`/365. The chain's own Greeks use fractional years to 16:00 New York (`yearsToExpiry`). This difference affects `modelVsMidPct`, and the design does not acknowledge it.
* **Recommendation:** Give the error map for the handler, reusing `mapFailure` and the `NOT_FOUND` behaviour of `chain`. Add the reasons "no bid/ask on leg", "series store not wired" and "IV index/IRX older than 5 sessions". Define "model available" as `STRATEGY_IV_INDEX[symbol]` and `SKEW` and `HALF_SPREAD_PCT` all present. State the time basis.

### 8. 🟡 Major: the spec markdown format that both test suites parse is undefined

* **Affected:** lines 169-170, 168 (and line 122).
* **Gap:** Python checks that the definitions equal the spec JSON, and TypeScript checks that the spec JSON parses with `StrategyDefinitionSchema` and runs. Both suites parse `docs/specs/strategies/bearish-put-spread.md`, but the plan never fixes how a definition is found in the file: the heading text, the fenced-code language tag and the key. The worktree uses "Spec heading -> definition" with the keys `RULE_EXIT3`, …, which are not the design's names. The comparison must also apply schema defaults: `test_qc_ports_definitions.py` adds `SCHEMA_DEFAULTS` (`exit`, `sizing`, `stopLoss`, `takeProfit`) before comparing parsed definitions.
* **Recommendation:** Fix the exact markdown layout, for example `### <CONSTANT>` followed by one ```` ```json ```` block. State whether the comparison is raw JSON or schema-normalised.

### 9. 🟡 Major: the fixture data and runner entry for the new tests are unspecified; existing helpers are not named

* **Affected:** line 168 (`test_qc_ports_bearish_put.py`) and line 170 (`bearish-put-spread-spec.test.ts`).
* **Code facts:** The options runner needs the SPY calendar bars, the traded ETF bars, its IV index, IRX and every filter series. Python (`portfolio.dataset_from_rows`, line 183) refuses rows without SPY bars (`The market calendar needs SPY bars`). `qc_ports.data.load_context` refuses `NYSE_UPVOL_PCT` (`Unknown series id`, `data.py:194`), so a test that goes through file-backed loading fails. Existing reusable infrastructure: `portfolio.dataset_from_rows` and `run_spec_json` (Python), `optionsDatasetFromRows` and `runOptionsDefinition` (`options-engine/index.ts`, TypeScript), and `services/research/tests/qc_ports_synthetic.py` (`trading_days`, `market`, `VIX_FOR_20`).
* **Recommendation:** State that both tests build store-shaped rows (SPY, QQQ, VXN, IRX, NYSE_UPVOL_PCT) and run them through `dataset_from_rows`/`run_definition(nautilus=False)` and `optionsDatasetFromRows`/`runOptionsDefinition`. Give the signal day, the expected long and short strikes (or the deltas used to derive them) and the expected trade counts for the rule and the baseline. State that the breadth filter blocks an entry when `NYSE_UPVOL_PCT ≤ 20`.

### 10. 🟡 Major: the CI suite manifest path and lane are imprecise

* **Affected:** lines 166 and 168.
* **Code facts:** The design names "tests/ci-suites.txt". That file does not exist at the repository root. The real file is `services/research/tests/ci-suites.txt`; the worktree diff adds "tests/test_series_ids_parity.py" there. `scripts/ci/research-python.sh` fails the run if a `test_*.py` file is not listed. It also has separate lanes (`ci-suites-nautilus.txt` with `VERTEX_REQUIRE_NAUTILUS=1`, and others). The design does not say whether `test_qc_ports_bearish_put.py` runs with `nautilus=True`, which needs the nautilus lane, or with `nautilus=False`, which runs in the base lane.
* **Recommendation:** Use the exact repository-relative path. Name the lane or lanes for each new suite.

### 11. 🟡 Major: virtual-id write shadowing is not addressed

* **Affected:** lines 161-163 (and line 110).
* **Code facts:** In the worktree, `loadSeries` serves a virtual id from `breadth90_days` and skips `market_daily_series` for it. However, `replaceSeries`/`upsertPoints` (validated only by `MARKET_DAILY_SERIES_ID_PATTERN`, which `NYSE_UPVOL_PCT` matches) would still accept a stored `NYSE_UPVOL_PCT` that is then invisible to reads. `listSeries` and `latestPoints` do not report the virtual id.
* **Recommendation:** Decide and state the behaviour: either refuse writes of virtual ids in `validateMarketDailySeries`, or document that writes are ignored on read. Also state that `listSeries`/`latestPoints` exclude virtual ids, and add a test for each.

### 12. 🟢 Nit: the test infrastructure for the registry is not listed

* **Affected:** lines 161-163.
* **Detail:** The worktree adds `packages/db/src/server/virtual-daily-series.test.ts`, but the table lists no test file for the new module, although line 179 requires 100% coverage on new TypeScript files.
* **Recommendation:** Add the file to the table.

### 13. 🟢 Nit: the verification commands are incomplete

* **Affected:** line 179.
* **Detail:** `bun run check` is format, lint and typecheck only (`package.json:56`). The regenerated `packages/api/openapi.json` is gated by `bun run openapi:check`; the generator is `bun run openapi:generate`. New docs fall under `docs:check` (both are part of `verify:core`). OpenAPI also changes for the series id, not only for the new procedure, because `STRATEGY_SERIES_REFS` is a `z.enum` in the DSL schema.
* **Recommendation:** List `bun run openapi:generate`, `openapi:check` and `docs:check`, and name the focused vitest files.

### 14. 🟢 Nit: side effects of the new series id are not mentioned

* **Affected:** line 164.
* **Detail:** `apps/web/src/components/portal/strategy-builder-workspace.tsx:433` lists `STRATEGY_SERIES_REFS` in the builder picker, so the id appears in the web UI automatically. It has no data before 2022-11-10, so a definition with an earlier `from` relies on the 5-session fill and then has no value.
* **Recommendation:** State that this is intended, or out of scope.

### 15. 🟢 Nit: the "length 33" wording

* **Affected:** line 164.
* **Detail:** This is correct: HEAD has 32 ids, and the worktree test asserts `toHaveLength(33)`. The design should say this is an assertion in `strategy-dsl.test.ts`, and that `test_series_ids_parity.py` also asserts 33 and equal order, not just set equality ("equal" on line 112 is ambiguous).

### 16. 🟢 Nit: comments and documentation that the driver change makes stale

* **Affected:** line 172.
* **Detail:** The procedure list is repeated in the driver header comment (`driver.ts:6-8`), in `infra/engine-comparison-driver/README.md` lines 3 and 56 (feature list `instant`, `sweep`, `autopilotGate`) and in the header of `infra/engine-comparison-driver/vertex-engine-comparison-driver-run`. The table names only the README.
* **Recommendation:** Add the header comment and the run script to the table.

### 17. 🟢 Nit: the event-study script path and inputs are unnamed

* **Affected:** line 124 (FeatureRange) and lines 151-173.
* **Detail:** The script is outside the repository write set. The plan still gives no path, input export names or command, and D4/D5 parameters (blocks of 20, 10,000 resamples, 95%) are not tied to an executable step.
* **Recommendation:** Name the path and the read-only export queries, or state explicitly that they are outside this plan.

## Claims verified as accurate (no action)

* `loadSeries` returns `Map<id, MarketDailyColumns>` in request order, with unknown ids absent (`market-daily-series.ts:87-95`). Worktree routing: virtual ids are served from `breadth90_days` with `final = true`, ordered by date; `close = up_pct`, and the other columns are null. A virtual series is absent when the range has no rows. `up_pct` lies between 0 and 100 (`schema/index.ts:3062`, `breadth90_days_values_check`).
* Options runs load series through `optionsDefinitionSeriesIds` (`options-engine/portfolio.ts:836`), which includes filter refs. The claim rows flow to the worker's `run_spec_json(spec, rows)` (`nautilus_backtest/__main__.py:81-86`). Python's `_rows_view` accepts non-ETF rows with null OHLC.
* `readChain` caches reads per symbol and expiry for 60 s (`CACHE_TTL_MS = 60_000`, `server/options-chain.ts`). It is module-private, so the spread handler belongs in the same file, as planned. `setOptionsChainForTesting` is the injection seam.
* `signals.SERIES_IDS` (`signals.py:115`) feeds `SERIES_REFS`, which `normalize_definition` validates (`signals.py:954, 1183`). Older workers therefore refuse the new id, as line 136 says.
* `qc_ports.data.SERIES_IDS` is used by `load_context`, which loads every id from a CSV file (`data.py:192-196`). Leaving it unchanged is correct (line 111).
* The `academy/backtest` input is `{slug, ticker, start, end, capital=100000, rules={}}`. Both slugs exist (`packages/academy/src/lessons/specs/*.json`, with QQQ in `tickers`). QQQ uses the realized-volatility model (`realizedVol(...) × ivMult`; only SPY reads VIX), which matches line 189. `academy` is an `ENGINE_COMPARISON_FEATURES` member, and later academy requests supersede earlier queued ones, which justifies one request at a time.
* The runner places the short leg at `widthSigma × ATM × √t × spot` (`book.ts:413`). `exitDte` compares calendar `daysLeft` (`book.ts:524, 657`). The default portfolio is `flat`/`daily` when a definition has no portfolio block (`portfolio.ts:351-365`). A signal at bar i trades at the close of bar i + 1.
* The model constants in the Limitations are correct for QQQ: `ATM_FACTOR` VXN 0.9, `SKEW` QQQ -0.25, `HALF_SPREAD_PCT` QQQ 0.015, commission $0.65, `DIVIDEND_YIELD` QQQ 0.007.
* `FLOW_RETENTION_DAYS.flow_gex = 14` (`flow-collect.ts:159`; it is a per-table map). The driver timer is `06:15 America/New_York`. `infra/quantvps/restart-when-idle.sh` exists.
