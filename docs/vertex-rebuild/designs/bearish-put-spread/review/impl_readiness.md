# Implementation Readiness Review — bearish put-spread design

- **Stage:** 9, Implementation Readiness Test (EGM, Mode: REVIEW)
- **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`
- **DetailedRange:** lines 149–189 (Detailed Implementation, Testing and acceptance, Limitations); FeatureRange 1–148 read for context
- **Standard:** `resources/document_standards/implementation-readiness-standard.md` (Zero-Decision Rule, phasing, exact file boundary, actionable steps, test plan)
- **Repo state checked:** worktree at `17fe7095` plus uncommitted work in progress (`vertical-spread.ts`, `virtual-daily-series.ts`, `strategy-dsl.ts`, `signals.py`, parity test, ci-suites). Claims were verified against the code.

## Verdict

**Not ready (1 Blocker, 7 Major, 6 Nit).** The breadth-series and series-id work is concrete enough to build, and most named files and functions exist. The pricing procedure contract, the driver academy phase, the spec-JSON format and the event study leave design decisions to the implementer; the live acceptance check for `optionsChain.spread` cannot pass with the listed files; and the plan has no implementation phases.

## Verified claims (no finding)

- Exist and are named correctly: `packages/api/src/options-engine/pricing.ts` exports `atmIv`, `smileIv`, `bsPrice`, `bsDelta`, `halfSpread`; `packages/api/src/options-chain-greeks.ts` exports `blackScholes`; `server/options-chain.ts` has `readChain` (private, 60 s cache), `mergeOptionsChain`, `requireOperator`; `MarketDailySeriesRepository.latestPoints` and `loadSeries` exist; `STRATEGY_IV_INDEX` exists (QQQ → VXN); `runOptionsDefinition` (`options-engine/portfolio.ts`) and `StrategyDefinitionSchema` (`strategy-dsl.ts`) exist; `services/research/strategies/qc_ports/book.py`, `ideas.py`, `infra/quantvps/restart-when-idle.sh`, `scripts/engine-comparison-driver/driver.ts`/`driver.test.ts`, `infra/engine-comparison-driver/README.md`, `tests/integration/database/market-daily-series.test.ts` exist.
- `STRATEGY_SERIES_IDS` has 32 ids and `strategy-dsl.test.ts:372` asserts length 32, so "length 33" is correct. `signals.py` `SERIES_IDS` mirrors it; qc_ports `data.SERIES_IDS` is separate.
- The DSL supports indicator `offset` (for `sma(20)[1]`), `crossesAbove`, series filters (`ideas.series_filter`), `putDebitVertical`, `longDelta`, `widthSigma`, `maxLossPct`, `exitDte`.
- `academy/backtest` exists (POST, input `{capital, end, rules, slug, start, ticker}`), both lesson slugs exist (`packages/academy/src/lessons/specs/itm-cash-secured-put.json`, `iron-condor-implied-move.json`), and the output carries `comparison.groupId` for the existing `waitClaimed` loop. `"academy"` is an engine-comparison feature.
- `backtestRuns.submit` keeps history before `from` for warm-up (`strategy-series.ts` comment), so SMA200 is defined from the first window day.

## Findings

### 🔴 Blocker

**B1 — Live acceptance for `optionsChain.spread` needs an unlisted read-key permission change (lines 181, 162; G1 line 49).**
"Live (agent read key): … `optionsChain.spread` on QQQ returns both parts" cannot pass. `requireOperator` rejects a read key for any procedure not in `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts:28`), and that set holds no `optionsChain.*` procedure (`optionsChain.chain` is write-key only today). The file table does not list `operator-access.ts`. Whether read keys may call `optionsChain.spread` (and, for consistency, `optionsChain.chain`/`expiries`) is a security-boundary decision.
*Recommendation:* decide it in the design. Either add `"optionsChain.spread"` to `AGENT_API_KEY_READ_PROCEDURES`, list `operator-access.ts` and an access test (read key allowed / rejected) in the table, or change the acceptance line to a write key and say G1's "agent" means a write-key agent.

### 🟡 Major

**M1 — `OptionsSpreadOutputSchema` sub-shapes and units are not defined (line 155; Technical Plan lines 107–108).**
The table names top-level fields only: `quotes | null`, `quotesUnavailable | null`, `model | null`, `modelUnavailable | null`. The implementer must invent: the fields of `quotes` and `model` (per-leg rows? `netMid`, `netWorst`, max loss/gain per share or per contract, breakeven, cost % of width, reward-to-risk); whether `*Unavailable` is a free string or an enum (the reasons in line 108 — missing leg, crossed quotes, no model for the symbol, missing IV index or spot, expiry today — should be enum values with fixed messages); Greek units (the chain's `OptionGreeksSchema` says "per contract" while `blackScholes` is per share; per share or ×100?); sign convention for credit spreads; what "worse side" means for the model (the WIP `vertical-spread.ts` chose "model half-spread on both legs, commissions excluded" — a choice the design never made; D6 adds $0.65/leg for engine costs); the formula of `modelVsMidPct` ((model − mid)/mid × 100, as D6's −2.3% implies). The in-progress `vertical-spread.ts` header documents these choices, which shows they were made at implementation time.
*Recommendation:* write the full zod shape of `quotes`, `model` and the two reason fields into the design (field names, per-share vs per-contract, sign, units, reason enum), and state whether commissions are in the worse-side number.

**M2 — Model input staleness and failure handling of the handler are undecided (lines 108, 158).**
"The latest stored close of the symbol's IV index and IRX" via `latestPoints` has no age limit: a VXN close weeks old would still price the model. The runner itself carries IV at most 5 trading days (`MAX_FILL_DAYS`). Also unstated: behaviour when `context.repositories.marketDailySeries` is undefined (other handlers check this, e.g. `server/openbb.ts:97`), whether `readChain` errors (`NOT_FOUND`, `UPSTREAM_ERROR`, `UNAVAILABLE`) propagate unchanged from `optionsChain.chain`, and validation errors (strikes equal, strikes not listed, expiry not listed → `BAD_REQUEST` vs `quotesUnavailable`).
*Recommendation:* fix a maximum point age (e.g. 5 trading days, matching `MAX_FILL_DAYS`) and its reason code; state that a missing series repository yields `modelUnavailable` with a named reason; state that chain errors reuse `OPTIONS_CHAIN_ERRORS` unchanged and which input faults are 400s.

**M3 — Spec-JSON embedding format is unspecified (lines 122, 166, 168–169).**
Both the pytest ("Definitions equal the spec JSON") and the TypeScript test ("Spec JSON parses with `StrategyDefinitionSchema`") must extract five definitions from `docs/specs/strategies/bearish-put-spread.md`. No existing spec in `docs/specs/strategies/` embeds JSON (e.g. `qc-iv-rank-gate.md` has zero ```json blocks), so there is no convention to copy. The implementer must choose the block delimiter and how a block maps to `BEAR_PUT_EXIT3` etc.
*Recommendation:* specify, e.g., "one fenced```json block per definition, each preceded by a heading `### BEAR_PUT_EXIT3` (the `ideas.py` constant name); tests collect blocks by heading", and the exact definition `name` strings (D1 requires "SMA20 proxy", variant and window in names; line 124 says names carry them but gives no strings).

**M4 — The five definitions are ambiguous on baseline content (lines 115–121).**
"Baseline: entry always true, same options block and exit" does not say (a) whether `BEAR_PUT_BASELINE` (window A) keeps the `NYSE_UPVOL_PCT > 20` filter, and (b) which options block the baselines use — with `exitDte 3` or without. Window A has two rule variants but one baseline; window B has only the exitDte-3 variant. Also unstated: whether the new constants join `ideas.__all__` and stay outside `IDEAS` (so `test_qc_ports_ideas.py` counts of 32/37 runs are unchanged), and whether to extend `ideas.indicator()` with an `offset` argument or write the offset dict inline.
*Recommendation:* write the five definitions out in full JSON in the design (or a table with entry, filters, exit, options per constant), state that baselines have no breadth filter (or do), state `exitDte: 3` for both baselines, and state that the constants are added to `__all__` only.

**M5 — Driver academy phase behaviour is underspecified (lines 128, 171).**
Undecided: the request body (`capital` default 100,000? `rules: {}`?); the `end` date — "today" conflicts with the instant runs, which end yesterday UTC so each day is a new group (`driver.ts:86`, test "ends the sweep yesterday (UTC)…"); handling of `comparison` absent or `groupId: null` (comparison off or queue error), `reused`, `superseded`, claim timeout and HTTP 403/400/5xx; whether the phase shares `INSTANT_PHASE_MAX_MS`; where it sits relative to the sweep and campaign ticks; whether its failures count in `log.failures`/the exit code; the exact log line text. The header comment (`driver.ts:6–8`) lists the only procedures the client may call and must gain `academy.backtest`; the README deploy note content is not given. `driver.test.ts` cases are not listed.
*Recommendation:* specify a `DRIVER_ACADEMY_SET` constant (slug, ticker, start, end rule, capital, rules), the end-date rule (yesterday UTC, like instants), the outcome→log-line table (claimed / reused / superseded / timeout / no group / HTTP error), budget and ordering, and the driver test cases.

**M6 — Event study is the pass/fail test (D4/D5) but has no implementable spec (line 125; D4–D6 lines 72–74).**
"A script in the job report folder … reads read-only database exports" leaves open: the folder path; which tables/columns are exported, how and to what format; how to price a single signal as its own spread with `book.py` (the per-event pricer `_price_event` and `_Pricing` are private; `build_book` applies the runner's exits, not the owner rule); the owner exit at "3 trading days before expiry" — compare the model mark against the entry debit (mid or worse side? after costs?) on which close; whether the SMA200 invalidation exit also applies in the study; the definition of "return on risk" (P&L after costs ÷ debit paid incl. costs?); how the block bootstrap pairs rule and baseline (resample 20-session blocks of entry dates and recompute both means on the same blocks?); the 95% interval method (percentile?); the random seed; the D6 sensitivity grid outputs. These choices decide the D5 verdict, so leaving them to the implementer breaks the pre-registration the design claims (G5).
*Recommendation:* either specify the algorithm step by step (inputs, exits, metric, bootstrap pairing, seed, output table) or declare the study script in scope with a file path, an interface (public helpers it may add to `book.py`, if any) and tests on a fixture.

**M7 — No implementation phases or checkpoints (lines 149–177).**
The standard requires incremental phases, each buildable and testable. The design has a deploy order (lines 132–136) but no build order. Dependencies exist: the series id must land in `strategy-dsl.ts`, `signals.py` and the db registry before the definitions test can run; the contract must exist before the handler; `openapi.json` regeneration (`pnpm openapi:generate`, checked by `openapi:check`) must follow both the contract change and the `STRATEGY_SERIES_IDS` change (the series enum appears in `openapi.json` via `StrategyDefinitionSchema`); live runs and the event study follow the merge and deploy.
*Recommendation:* add phases, e.g. P1 breadth series + id parity (db, dsl, signals, tests); P2 pricing function + contract + handler + openapi; P3 definitions, spec, Python/TS tests; P4 driver academy phase; P5 deploy, live runs, event study, report — each with its check command.

### 🟢 Nit

**N1 — Wrong or ambiguous paths in the file table (lines 159, 165).** `packages/api/src/server/options-chain.test.ts` does not exist; the router tests live in `packages/api/src/options-chain.test.ts` (`describe("optionsChain procedures")`, `setOptionsChainForTesting`). Say "extend `packages/api/src/options-chain.test.ts`" or mark the server file "(new)". `tests/ci-suites.txt` (lines 165, 167) should be `services/research/tests/ci-suites.txt`; the root path does not exist.

**N2 — Missing files in the write allowlist (lines 151–173).** `packages/db/src/server/virtual-daily-series.test.ts` (already created in the worktree) is not listed; `docs/vertex-rebuild/strategy-definitions.md:200` lists every DSL series id and will be stale without `NYSE_UPVOL_PCT`; `packages/api/src/server/operator-access.ts` (see B1). Add them or state they are out of scope.

**N3 — Live-run `from`/`to` not stated per run (line 124).** `backtestRuns.submit` requires `from` and `to`; D2 gives the windows but line 124 lists every other submit field. State them per run (A: 2022-11-10 → 2026-11-20; B: 2001-11-01 → 2026-11-20) to avoid a later `to`.

**N4 — Time to expiry for the model (line 108).** "The chain's `dte`" is an integer day count; the chain's own assumptions run time to 16:00 New York (ACT/365) and the consult priced at about 15:45. State that the model uses `dte/365` (integer days, matching the runner's `dte / DAYS_PER_YEAR`) so the 5% tolerance check is reproducible.

**N5 — Coverage gate and test commands (line 180).** "Focused vitest" and `VERTEX_RESEARCH_PYTHON=…` leave the exact command to the implementer; give the vitest file list with `--coverage` and the Python interpreter path or env, and name the files the 100% coverage applies to (`vertical-spread.ts`, `options-spread.ts`, `virtual-daily-series.ts`).

**N6 — Parity test source parsing (line 165).** The Python test reads `STRATEGY_SERIES_IDS` "from `strategy-dsl.ts`"; state the extraction method (regex over the `as const` array literal) so a TS reformat does not silently break it. (The WIP `test_series_ids_parity.py` already exists; align the text with it.)

## Summary table

|#|Severity|Lines|Topic|
|---|---|---|---|
|B1|🔴 Blocker|181, 162, 49|Read key cannot call `optionsChain.spread`; `operator-access.ts` unlisted|
|M1|🟡 Major|155, 107–108|Spread output sub-shapes, units, reason enum, worse-side/commission choice|
|M2|🟡 Major|108, 158|IV/IRX staleness limit, missing repository, error mapping|
|M3|🟡 Major|122, 166, 168–169|Spec JSON embedding format and definition names|
|M4|🟡 Major|115–121|Baseline filter and exitDte; `__all__`/`IDEAS`; offset builder|
|M5|🟡 Major|128, 171|Academy phase body, end date, outcomes, budget, tests|
|M6|🟡 Major|125, 72–74|Event study algorithm, data exports, location|
|M7|🟡 Major|149–177|No implementation phases; openapi regeneration ordering|
|N1|🟢 Nit|159, 165, 167|Nonexistent test path; `ci-suites.txt` path|
|N2|🟢 Nit|151–173|Allowlist omissions|
|N3|🟢 Nit|124|Per-run `from`/`to`|
|N4|🟢 Nit|108|Model time convention|
|N5|🟢 Nit|180|Exact test/coverage commands|
|N6|🟢 Nit|165|Parity parsing method|
