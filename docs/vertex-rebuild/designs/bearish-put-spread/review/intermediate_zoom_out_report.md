# Intermediate zoom-out report: bearish put-spread design (Stage 8)

- **Target:** [design.md](../design.md) (revised 2026-11-22, 279 lines), read in full.
- **Mode:** REVIEW, zoom-out standard (`resources/document_standards/zoom-out-standard.md`), fresh context.
- **Focus:** additions and mitigations recorded in [goldfish_review_report.md](../goldfish_review_report.md) after the Comprehension and Critic stages, checked against the design, the committed code on this branch (`e4de63e5`..`f4c3fd0d`) and the spec `docs/specs/strategies/bearish-put-spread.md`.
- **Prior pass:** [zoom_out_report.md](zoom_out_report.md) (Z1-Z8).

## Verdict

Context is sufficient: the objective (price verticals, make breadth readable, test the consult's bearish rule under a fixed decision rule, add option runs to the engine comparison, keep real flips) and its motivation are clear. Most mitigations are sound and proportionate: the event study is now in the repo with tests, the 60-session blocks and independent-signal gate fix the leniency (C1), the Technical Plan is back at architecture altitude (Z7 resolved), the 730-day `flow_gex` retention matches the sibling flow tables already kept 730 days, and the virtual series registry is a small, well-placed read-in-place module.

One blocker remains: the pre-registration document (the spec) was not updated with the mitigations and now contradicts the design on the forward test. Four Major findings concern where the decisive method and result live (outside the established spec / `research_studies` pipeline), framing that resolution #25 says was fixed but was not, images that resolution #10 says were added but are absent, and the study module's placement in the worker's runtime package.

## Findings

### 🔴 I1. The spec, the pre-registration, contradicts the design's forward test and still describes the old data

- **Affected lines:** 64 (G6), 96 (pathway item 1); spec `docs/specs/strategies/bearish-put-spread.md` lines 30, 53-58.
- **Description:** G6 says the forward test "is registered in the spec", and pathway item 1 registers it "on the stored QuantData flip (never pooled with the OpenBB flip) ... when 30 independent signals exist". The spec's "Forward test (registered 2026-11-22)" section registers the opposite source, `openbb_option_iv_daily.gamma_flip` (card vertex-gamma-flip-sources), counts "30 signals" (not independent signals), and line 30 still says "`flow_gex` keeps 14 days". The 730-day retention (Phase 3, G6) exists only to serve the QuantData forward test, so its justification is absent from the document a future evaluator will read. Resolution #21 and #1 were applied to the design and code, not to the spec.
- **Recommendation:** Make the spec the single source: update its Forward test section to the QuantData flip from `flow_gex`, independent signals, and the full decision rule text (see I2); fix line 30. In the design, reference the spec section rather than restating the forward-test terms, so the two cannot drift again.

### 🟡 I2. The pre-registered method and its amendment live in the design, not in the spec; the amendment overclaims

- **Affected lines:** 76-92 (decision record, amendment record), 96; spec lines 28-58.
- **Description:** The repository's pre-registration pattern puts the method in the spec, with dated sections ("Backtest design (fixed ... before the first run)", "Pass/fail rule", "Deviations", "Code and tests", "Results"; for example `market-intraday-momentum.md`, and 23 strategy specs carry a Results section). This spec only says "the decision rule D5 of the design", so the binding rule lives in a design document that is not versioned as a research artifact. The amendment record (line 92) also records a study result and timestamp inside the design and asserts that "the stricter rule cannot turn that into a pass". The independent-signal gate can only demote, but a 60-session block bootstrap produces a different interval from a 20-session one and is not guaranteed to be wider, so "cannot" is an argument, not an observation. The design is being used as a lab notebook.
- **Recommendation:** Move D4-D6 (blocks, resamples, seed, gate, verdict wording, sensitivity) into the spec as "Backtest design" and "Pass/fail rule", move the amendment record into a "Deviations" section there, and record the actual re-run verdict under the amended rule in the spec's Results. The design keeps a one-line pointer.

### 🟡 I3. The decisive result bypasses the established study pipeline: off-repo job report, ad hoc input export

- **Affected lines:** 65 (G7), 78, 117, 253-256 (Phase 6).
- **Description:** Every other pre-registered study prints a `ResearchStudyDocument`, is stored in `research_studies` through `bun run vertex:research-studies:import` (`scripts/research-studies/import.ts`), and summarizes its run in the spec's Results with commit, data hash and verdict (imom, ld34, trend_trio, triple_rsi, the qc-ports ideas). Here the study "prints one JSON document" with an ad hoc shape (`run_study` in `bearish_put_study.py`), and the verdict, knowledge-base answers and run ids go only to a job report on the rig (`~/Documents/reports/web/...`). The study input is "the series rows exported read-only" (line 256) with no named command and no recorded digest, while the stored runs pin their input with `seriesSha256` (line 279). The one artifact that decides pass/fail (D5) is therefore the least reproducible and is invisible to Vertex users who read studies in the library.
- **Recommendation:** Emit a `ResearchStudyDocument` (or state why the schema cannot hold an event study) and import it; record the verdict with commit and input digest in the spec's Results. For the input, either read the rows the same way the runs do and record their `seriesSha256`, or name the export command and record the export digest in the study output. Keep the rig job report for the knowledge-base transcripts only.

### 🟡 I4. Framing fix (resolution #25) not applied: the Overview and G3 still present proxy runs as "the rule"; "why now" unanswered

- **Affected lines:** 19 (Overview item 3), 61 (G3), 1 (title).
- **Description:** Resolution #25 says the Overview names the proxy rule. Line 19 still reads "The rule as strategy definitions, stored backtest runs, and an event study". G3 calls the window-A runs "the rule" and only the window-B runs "the proxy rule", although both windows replace conditions 1 and 2 with the SMA20 proxy (the definitions are named "SMA20 proxy, breadth" and "SMA20 proxy, no breadth" in `bearish_put.py`). A reader of the Goals concludes window A tests the consult's rule. The second half of Z2 (state why a proxy study is worth its cost now, given the root blocker is flip data) is also still unanswered in the document.
- **Recommendation:** Overview item 3: "The SMA20 proxy of the rule as strategy definitions ...". G3: "the proxy rule with breadth (exitDte 3 and to expiry) and the baseline on window A; the proxy rule without breadth and the baseline on window B". One sentence of motivation, for example "a cheap proxy result now and the baseline for the forward test".

### 🟡 I5. The two images resolution #10 says were added are absent

- **Affected lines:** 7, 9.
- **Description:** `before-after.png` and `data-flow.png` are not in `docs/vertex-rebuild/designs/bearish-put-spread/` (the folder holds only markdown and `review/`); other designs in `docs/vertex-rebuild/designs/` do ship `before-after.png`. The first thing a reader sees is two broken images, and the resolution record states a fix that did not happen, which lowers trust in the other 95 "applied" entries.
- **Recommendation:** Add both images or remove the two lines (the ASCII diagram at lines 103-119 already covers the data flow), and correct resolution #10.

### 🟡 I6. The study sits in the worker's runtime package and patches its module state (residual half of Z4)

- **Affected lines:** 132, 236-244 (Phase 4); `services/research/strategies/qc_ports/bearish_put_study.py` (`shifted_skew`).
- **Description:** Z4 asked for a per-study package (`services/research/strategies/<name>/` with definition and study, the pattern of `volspike/`, `ld34/`, `imom/`, `trend_trio/`). The resolution moved the study into the repo with tests (good) but placed it in `qc_ports`, which is no longer only a set of idea ports: `nautilus_backtest/__main__.py` imports `strategies.qc_ports.portfolio` as the production options runner of the research worker. The study's IV-skew sensitivity works by mutating the runner's module global `om.SKEW` in a context manager. A one-off study now ships with, and reaches into, the runtime the worker deploys. The resolution record does not mention the placement half of Z4.
- **Recommendation:** Move `bearish_put.py`, `bearish_put_study.py` and the CLI entry into `strategies/bearish_put_spread/` (importing `qc_ports` book, options and portfolio like `volspike` does). Pass the skew shift as a parameter to the pricing call, or document why the global patch is safe (single-threaded offline process only).

### 🟢 I7. New TypeScript spec test hand-copies Python results instead of using the golden fixture mechanism

- **Affected lines:** 32 (Gate parity term), 244 (`bearish-put-spread-spec.test.ts`).
- **Description:** The test checks that `runOptionsDefinition` gives "the Python trades to the cent" using values "printed by that fixture" and copied into TypeScript. The repository already has a generated cross-language fixture for this runner (`services/research/tests/qc_ports_golden.py` writes `fixtures/qc_ports/options_golden.json`, replayed by `packages/api/src/options-engine/golden.test.ts`), and every stored run is parity-gated on completion (line 32). Hand-copied numbers drift silently when the Python fixture changes.
- **Recommendation:** Keep the schema-parse check; drop the copied-trade comparison or add the bearish definitions as a case of the existing golden fixture.

### 🟢 I8. Contested items leave their justification outside the design

- **Affected lines:** 60 (G2), 59 and 73 (G1, non-goal).
- **Description:** Resolution #28 justifies G2 by a second consumer (the regime view card) that the design never names; G2 still reads as serving only the window-A runs. G1's consumer is "an agent with an operator session", which depends on an access arrangement stated only as a non-goal.
- **Recommendation:** Add the regime-view consumer to G2. State G1's consumer as "an operator (or an agent acting with an operator session)".

### 🟢 I9. A stated knowledge-base requirement is neither adopted nor declined

- **Affected lines:** 78, 85-87.
- **Description:** The KB summary says DeltaTrend and QuantFinanceToGo require Monte Carlo drawdowns; D4-D6 adopt the other requirements but no decision covers drawdown resampling (G3 reports only the single-path max drawdown).
- **Recommendation:** Add it to D5/D6 or say in one clause why the per-contract event study does not need it.

### 🟢 I10. Minor document hygiene

- **Affected lines:** 4, 188-205.
- **Description:** Status reads "Approved after EGM review" while this Stage 8 pass is still open. Two alternatives add little: "Other proxies" lists a non-pro as its pro ("none is better grounded"), and "Submit the bearish definition daily" is a straw option.
- **Recommendation:** Set status after Stage 8; fold the two alternatives into one line each or drop them.

## Mitigations checked and accepted

| Resolution | Check |
| --- | --- |
| #1 blocks 60, independent-signal gate | Sound and proportionate; `BLOCK`, `MIN_SIGNALS`, `independent()` in code. Placement of the record: I2. |
| #8, #20 event study in repo with tests | Accepted; reuses `book.build_book`, so no second pricing path. Placement: I6; output pipeline: I3. |
| #9 id only in the worker list | Accepted; avoids breaking file-backed qc_ports runs. |
| #21 `flow_gex` 730 days | Accepted; matches `flow_large_trades`, `flow_minutes`, `flow_net_drift` already at 730 (`FLOW_RETENTION_DAYS`). Spec drift: I1. |
| #23 writes to the virtual id refused | Accepted. |
| #24 academy phase serialized with claim wait | Accepted; bounded by the existing 15-minute wait. |
| #27 Z1 contest (one PR) | Accepted: G5 closes consult gap 9, and the decisive window-B test no longer depends on the G2 deploy. |
| #29 registry in `packages/db` | Accepted; one file, read in place, no copy; no existing view mechanism (`market-daily-views.ts` is pure post-load views) covers it. |
| #35 Z5 bootstraps not reused | Accepted: the paired rule-and-baseline bootstrap keyed by signal bar is not what `bootstrap_ci` or `stationaryBootstrap` provide. |
| Z7 altitude | Resolved: Technical Plan describes components and data flow; function names and SQL moved to Detailed Implementation. |

## Summary table

| # | Severity | Lines | Topic |
| --- | --- | --- | --- |
| I1 | 🔴 Blocker | 64, 96; spec 30, 53-58 | Spec forward test contradicts design (OpenBB vs QuantData flip, signal count); spec still says 14 days |
| I2 | 🟡 Major | 76-92, 96 | Method and amendment live in the design, not the spec; "cannot turn into a pass" overclaims |
| I3 | 🟡 Major | 65, 78, 117, 253-256 | Decisive result off the `research_studies` pipeline; study input export unspecified and unpinned |
| I4 | 🟡 Major | 1, 19, 61 | Overview and G3 still call proxy runs "the rule"; why-now missing |
| I5 | 🟡 Major | 7, 9 | Images absent although recorded as added |
| I6 | 🟡 Major | 132, 236-244 | Study in the worker's runtime package; mutates `om.SKEW` |
| I7 | 🟢 Nit | 32, 244 | TS spec test copies Python numbers; golden fixture exists |
| I8 | 🟢 Nit | 59-60, 73 | G2 second consumer and G1 access model not stated in the design |
| I9 | 🟢 Nit | 78, 85-87 | Monte Carlo drawdown requirement not decided |
| I10 | 🟢 Nit | 4, 188-205 | Status premature; weak alternatives |
