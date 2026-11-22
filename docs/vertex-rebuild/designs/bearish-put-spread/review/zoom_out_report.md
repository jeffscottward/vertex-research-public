# Zoom Out review: Bearish put-spread rule design

* **Stage:** 5 (initial zoom out)
* **Reviewer:** Skeptical Architect (Zoom Out Goldfish), Mode REVIEW
* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md` (FeatureRange lines 1-148, DetailedRange lines 149-189)
* **Standard:** `resources/document_standards/zoom-out-standard.md`
* **Date:** 2026-11-22

## Verdict

Context is sufficient (§0 passes): the objective, the motivation (the 2026-11-19 consult) and the limits of the data are clear. No blockers. Four major findings: the scope bundles unrelated work, the decisive test does not test the consult's rule, the breadth series is built across both engines for a descriptive-only consumer, and the load-bearing event study is placed outside the codebase while the descriptive runs go into a module scoped to a different study. Four nits on reuse, altitude and references.

Claims checked against the code: `STRATEGY_SERIES_IDS` has 32 ids today (`strategy-dsl.test.ts:372`), `readChain` caches 60 s (`options-chain.ts:37`), `STRATEGY_IV_INDEX` exists, `loadSeries` is the single loader entry (`strategy-series.ts:145`, `backtest-run-engine.ts`), academy runs already feed the engine comparison (`engine-comparison.ts`, `academy.ts` `queueAcademyComparison`). These match the design.

## Findings

### 🟡 Major Z1. Four independent deliverables in one design, coupled by one deploy order

* **Affected lines:** 1, 13-20, 47-53, 126-136.
* **Description:** G1 (spread pricing procedure), G2 (breadth series), G3 (rule study) and G4 (academy phase in the comparison driver) share no data path except G1 → D7/D9 and G2 → window-A runs. G4 answers "gap 9 of the consult" and has no dependency on G1-G3, yet the deploy order (lines 132-134) puts the driver after the worker, and the worker step exists only because G2's series id is roll-forward only (line 136). One design and one PR (concepts brief: "one PR with focused commits") ties an unrelated driver change to the only irreversible step.
* **Recommendation:** Split G4 into its own card or at least its own design section with its own rollout and acceptance, independent of the worker deploy. Consider the same for G1: it is a general agent tool whose acceptance (consult quotes) does not depend on the study. Keep this design about the rule study.

### 🟡 Major Z2. The decisive test measures a different rule from the consult's; the framing overstates it

* **Affected lines:** 19, 31-35, 51, 53, 69-73, 77, 79-84.
* **Description:** D5 decides pass or fail on window B only. In window B: conditions 1-2 are replaced by the SMA20 proxy (D1, which all four knowledge bases say is not a flip), condition 3 is absent (breadth starts 2022-11, D2), condition 4 is untestable (D9), and the engine runs enter one session late (line 185). What window B tests is "QQQ dips through yesterday's 20-day SMA by at most 2%, buy a put debit spread". None of the consult's distinctive filters is in the decisive test. The design is honest in Limitations and D1, but the Overview (line 19 "The consult's rule as strategy definitions"), G3 ("runs of the rule") and G5 ("the pathway to proving the rule") present it as a test of the consult's rule. The root blocker, flip history, is a non-goal (line 57) and the real test is a forward test from 2027-11 at the earliest (line 81).
* **Recommendation:** Name the hypothesis under test as the SMA20 proxy rule in the Overview and in G3, and state up front that a pass or fail says nothing about the consult's gamma-flip rule. State why the proxy study is worth its cost now, given that the root blocker is data collection (card vertex-gamma-flip-sources). If the answer is "a cheap baseline for the later forward test", say so and size the work to that.

### 🟡 Major Z3. G2 adds a cross-engine series contract for a consumer whose result is descriptive only

* **Affected lines:** 18, 50, 70, 73, 108-112, 116-119, 136, 160-165.
* **Description:** The only consumer of `NYSE_UPVOL_PCT` in this design is the window-A rule definitions (`BEAR_PUT_EXIT3`, `BEAR_PUT_EXPIRY`). D5 makes window A descriptive. The edge test (D4) runs in Python on read-only database exports and can join `breadth90_days.up_pct` directly. For a descriptive result, G2 adds: a new registry module in `packages/db`, a routing branch in `loadSeries`, a 33rd id in two hand-synced language lists, a new cross-language parity test, a CI suite entry, and the design's only roll-forward-only deploy constraint ("older worker code refuses runs that read it", line 136). The five live engine runs themselves (line 123) cannot express the owner exit (D8, line 186) or same-session entry (line 185) and give about 18 trades (line 143), so they add no evidence to the decision either.
* **Recommendation:** Either name a concrete second consumer that needs breadth in the DSL now (another strategy, an Autopilot filter, an agent request) and keep G2 with that justification in Goals, or defer G2: apply the breadth filter inside the event study from the `breadth90_days` export and run window-A engine runs without it (or not at all). The registry design itself (in-place read, no copy) is sound if G2 stays; the finding is about need, not shape.

### 🟡 Major Z4. Load-bearing analysis lives outside the codebase; descriptive definitions go into an unrelated pre-registered module

* **Affected lines:** 72-73, 114-124, 167-168.
* **Description:** The event study decides pass or fail (D4, D5) but is "a script in the job report folder ... It is analysis, not product code" (line 124): untested, not in CI, not reproducible from the repo. Meanwhile the descriptive definitions get full product treatment in `services/research/strategies/qc_ports/ideas.py`, whose docstring scopes it to "The 11 QuantConnect idea ports as strategy DSL definitions and pre-registered runs", fixed 2026-11-08, with `study.py` counting `n_trials = 32`. Adding five bearish definitions there dilutes a closed pre-registered set. The codebase has an established pattern for exactly this kind of pre-registered study: one package per study under `services/research/strategies/<name>/` with `study.py` (and often `definition.py`, `metrics.py`, `rules.py`), the pre-registered spec at `docs/specs/strategies/<name>.md`, and a `ResearchStudyDocument` imported with `bun run vertex:research-studies:import`. Examples: `volspike/` (which already reads the qc-ports daily VXN, T-bill and QQQ files), `ld34/`, `imom/`, `trend_trio/`, `triple_rsi/`, `leveraged_etf/`, `flow_control/`.
* **Recommendation:** Create "services/research/strategies/bearish_put_spread/" holding the definitions and a `study.py` that runs the event study (pricing through `qc_ports` `book.py`), the baseline, the bootstrap and the D5 verdict, with a pytest on a fixture dataset and a study document as output. Keep `qc_ports/ideas.py` unchanged. The spec file stays at `docs/specs/strategies/bearish-put-spread.md`, matching the pattern.

### 🟢 Nit Z5. Block bootstrap is specified fresh; two block bootstraps already exist

* **Affected lines:** 72 (D4).
* **Description:** D4 fixes "blocks of 20 sessions, 10,000 resamples". The repo has `strategies/noise_band_futures_run.bootstrap_ci` (day-block bootstrap 95% interval of the mean, reused by `trend_trio/study.py` for its T2 test) and `packages/api/src/quant-significance.ts` `stationaryBootstrap` (Politis-Romano, geometric blocks with a mean length).
* **Recommendation:** Reuse one of them (or name why fixed 20-session blocks are required, e.g. overlap of 45-60 day holds) so the study method matches other studies' intervals.

### 🟢 Nit Z6. Third Black-Scholes path and a 1e-9 agreement test signal duplication

* **Affected lines:** 105, 152 (detailed table, `vertical-spread.test.ts`).
* **Description:** Price and delta come from `options-engine/pricing.ts` (`bsPrice`, `bsDelta`), Greeks from `options-chain-greeks.ts` `blackScholes`, and a test asserts the two deltas agree within 1e-9. `@darkfactory/academy` (already an api dependency, used in `pick-list-proposal.ts`) also exports `blackScholes` returning price and all Greeks, plus `payoffSummary` (breakevens, max profit, max loss). Using the golden-pinned runner pricing for price and delta is justified (parity with the backtest model); the second Greek source is the part that needs a reason.
* **Recommendation:** One sentence in Alternatives: why net Greeks do not come from the same function as price, and why academy position math is not used (closed-form vertical payoff is simpler than its numeric scan, which is a fine reason).

### 🟢 Nit Z7. Code-level detail in the FeatureRange

* **Affected lines:** 88-101, 105, 110, 117.
* **Description:** The Technical Plan names private helper functions (`verticalPayoff`, `priceVerticalFromQuotes`, `priceVerticalFromModel`), embeds SQL text (line 110) and a cache TTL. The DSL entry expressions (line 117) are acceptable as the rule's specification.
* **Recommendation:** Keep components, interfaces and data flow in the Technical Plan; move function names and SQL to the Detailed Implementation table.

### 🟢 Nit Z8. Unresolved references and a self-contradiction

* **Affected lines:** 7, 9, 28, 63-77, 84, 111-112.
* **Description:** `before-after.png` and `data-flow.png` are referenced but absent from the design folder. Brainstorm ids (B1-B3, M11-M13, N5), "gap 9 of the consult", "DeltaTrend wisdom 7" and the consult itself are cited without a link; a fresh reader cannot resolve them from this document. Pathway item 4 (line 84) lists "The decision rule D5 on window B" as still missing, although D5 on window B is in scope of this job.
* **Recommendation:** Link `brainstorm_review.md`, `concepts_brief.md` and the consult; add or remove the images; reword item 4 (for example "D5 on window B gives the proxy verdict only; the flip rule needs item 1").

## Summary table

|#|Severity|Lines|Topic|
|---|---|---|---|
|Z1|🟡 Major|1, 13-20, 47-53, 126-136|Unrelated deliverables bundled; G4 tied to G2's roll-forward deploy|
|Z2|🟡 Major|19, 31-35, 51, 53, 69-84|Decisive window-B test omits every consult-specific condition; framing overstates|
|Z3|🟡 Major|18, 50, 108-112, 116-119, 136|Cross-engine breadth series and engine runs serve only descriptive results|
|Z4|🟡 Major|72-73, 114-124, 167-168|Event study outside the repo; definitions in the closed qc_ports pre-registered module; ignores the per-study package pattern|
|Z5|🟢 Nit|72|Existing block bootstraps not reused|
|Z6|🟢 Nit|105, 152|Two Black-Scholes sources for one spread|
|Z7|🟢 Nit|88-117|Function names and SQL in the Technical Plan|
|Z8|🟢 Nit|7, 9, 28, 63-84|Missing images, unlinked references, pathway item 4 contradiction|
