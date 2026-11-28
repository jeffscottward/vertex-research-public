# Goldfish review resolution (egm-resolve, auto accept)

Target: `research/backtests/stoploss-premium/design.md`. Reports: `zoom_out_report.md` (stage 5),
`comprehension_report.md` (stage 6), `critic_report.md` (stage 7), `implementation_readiness_report.md` (stage 9),
`intermediate_zoom_out_report.md` (stage 8). Resolution gate: "Auto accept" (owner rule 2026-11-13): every PROPOSE FIX
was applied to the document, and where the finding showed a code defect, to the code as well. No finding needed a fact
that only the owner has, so there is no ESCALATE.

Counts: 58 findings after deduplication (49 from stages 5-7 and 9, 9 from stage 8): PROPOSE FIX 50, CONTEST 3,
DECLINE 5.

## Prioritized Findings & AI Suggestions

### [Issue 1] [`egm-codebase-details`] - Severity: Blocker

* **Finding:** `report.METHOD_HTML` said option books commit 100% of capital to premium; the code uses 25%. It also
    left out the 2% ETF spread and the 20/60-day volatility split.
* ***AI Suggestion:*** PROPOSE FIX. Method text rewritten from the document (code).

### [Issue 2] [`egm-design`, `egm-structural`] - Severity: Blocker

* **Finding:** no "Alternatives considered" section; rejections attributed to the owner without a link.
* ***AI Suggestion:*** PROPOSE FIX. Added the section (11 rows with rejection reasons); the vendor decision links
    `research/backtests/151-strategies/harness-evaluation.md`.

### [Issue 3] [`egm-implementation-readiness`, `egm-codebase-details`] - Severity: Blocker

* **Finding:** incomplete file list (no `__init__.py`, `run.py`, `ci-suites.txt`, outputs), no test plan, decisions
    only in code (D/F parameters, ladder details, G/H constants, sample starts), output list wrong, `results.json`
    schema missing, Crown inputs not hashed.
* ***AI Suggestion:*** PROPOSE FIX. Phased plan with files and named tests, test details section, types, CLI,
    output schema; Crown inputs and `intro.html` now hashed (code).

### [Issue 4] [`egm-codebase-details`] - Severity: Blocker

* **Finding:** test E presented as a backtest; its verdict is hard-coded and its count is level notes.
* ***AI Suggestion:*** PROPOSE FIX. Document states E is a data count only with a fixed "not enough data".

### [Issue 5] [`egm-design`, `egm-codebase-details`] - Severity: Major

* **Finding:** comparison rows without a threshold check could pass "adds return" (own Δμ used as the check).
* ***AI Suggestion:*** PROPOSE FIX. `premium.verdict(s, None)` can no longer pass "adds return" (code, test).

### [Issue 6] [`egm-zoom-out`, `egm-codebase-details`] - Severity: Major

* **Finding:** second conventions beside existing code: loaders, ATR, SMA, z-score, realized volatility,
    drawdown, expiries without NYSE holidays, a copied skew function, strike grid, unlimited IV-index carry.
* ***AI Suggestion:*** PROPOSE FIX. Now reuses `qc_ports.data.load_bars/load_series`, `indicators.core`,
    `qc_ports.metrics.max_drawdown`, `qc_ports.calendar.monthly_expiration`, `qc_ports.options.smile_iv /
    strike_step / intrinsic / MIN_HALF_SPREAD` and the 5-session carry limit of `qc_ports.data` (code, tests).

### [Issue 7] [`egm-zoom-out`, `egm-implementation-readiness`, `egm-codebase-details`] - Severity: Major

* **Finding:** ported live rules have no pinned source.
* ***AI Suggestion:*** PROPOSE FIX. "Ported rules" table, `study.PORTED_FROM` written to `results.json`.

### [Issue 8] [`egm-inventive-catalyst`] - Severity: Major

* **Finding:** the drawdown test depends on the 25% premium share.
* ***AI Suggestion:*** PROPOSE FIX. Each option row reports its result at 6%, 25% and 100% (code).

### [Issue 9] [`egm-inventive-catalyst`, `egm-design`] - Severity: Major

* **Finding:** the fixed half-spread can set the sign of Δμ; stock IV has no dynamics; IV indexes unused.
* ***AI Suggestion:*** PROPOSE FIX. Half-spread sensitivity row for C; IV-index ETF rows in B, C and D (code).

### [Issue 10] [`egm-inventive-catalyst`] - Severity: Major

* **Finding:** verdicts rest on substitute entries without an entry-dependence control.
* ***AI Suggestion:*** PROPOSE FIX. Random-entry control row in B (code).

### [Issue 11] [`egm-zoom-out`, `egm-design`] - Severity: Major

* **Finding:** owner routing ignores model-price and bias labels; live/not-live undefined.
* ***AI Suggestion:*** PROPOSE FIX. "Live?" column, "Owner questions" section (model-price results are evidence
    gaps), bias notes on A-D (code and document).

### [Issue 12] [`egm-design`, `egm-inventive-catalyst`] - Severity: Major

* **Finding:** 100 stop events can be a few correlated episodes; "paid insurance" has no uncertainty measure.
* ***AI Suggestion:*** PROPOSE FIX. Stop days and the drawdown cut per half are reported (code, tests).

### [Issue 13] [`egm-design`] - Severity: Major

* **Finding:** no statement on multiple testing.
* ***AI Suggestion:*** PROPOSE FIX. Rows declared exploratory; no correction applied, stated.

### [Issue 14] [`egm-design`, `egm-structural`, `egm-comprehension`] - Severity: Major

* **Finding:** samples and universes missing per test; 10-month rule unit unclear; tests used before defined; no
    problem statement or non-goals; risks without mitigations.
* ***AI Suggestion:*** PROPOSE FIX. Tests table moved up with sample and universe columns; Problem, Goals and
    non-goals; Risks and mitigations table.

### [Issue 15] [`egm-comprehension`, `egm-style`] - Severity: Major

* **Finding:** Δμ, p₀, the sufficient condition, "±25%", fills per test, undefined terms (ATR14, IV, NLV, CSP,
    Crown, KB, L, T−n, the rig), parent report and KB answers without paths, rates 0 and raw prices unstated.
* ***AI Suggestion:*** PROPOSE FIX. All defined or located in the document.

### [Issue 16] [`egm-implementation-readiness`, `egm-codebase-details`] - Severity: Major

* **Finding:** "no new dependency" contradicts the run command; data contract missing.
* ***AI Suggestion:*** PROPOSE FIX. Dependency sentence and data loading rules added.

### [Issue 17] [`egm-inventive-catalyst`] - Severity: Major

* **Finding:** test H is fixed to "not enough data"; pool many equity curves.
* ***AI Suggestion:*** CONTEST. Pooled brake starts fall in the same crises (2000-02, 2008, 2020), so they are not
    independent events and would only appear to pass the 100-event floor. The document states the fixed outcome
    (Alternatives table).

### [Issue 18] [`egm-inventive-catalyst`] - Severity: Major

* **Finding:** add reason codes to "inconclusive" and route dominance cases to the owner.
* ***AI Suggestion:*** CONTEST. Codes defined after a run are post-hoc; the page shows every number of the row, and
    the document states the ordering issue (fixed test 5).

### [Issue 19] [`egm-design`] - Severity: Blocker (part)

* **Finding:** reuse `market_watch/income/backtest.py` for test F.
* ***AI Suggestion:*** CONTEST. It is in another repository (no import across repositories), and it re-enters on
    the next session, so the two legs would not share entries (Alternatives table).

### [Issue 20] [`egm-zoom-out`, stage 8] - Severity: Major

* **Finding:** no named row decides an owner question; random control without a reading rule.
* ***AI Suggestion:*** PROPOSE FIX. Headline rows (★) named before the run (A live 5-rung, B pooled entries, C T−3);
    only they can raise an owner question; the 25% share decides for option books (code, document).

### [Issue 21] [`egm-zoom-out`, stage 8] - Severity: Major

* **Finding:** the zero rate does not cancel between legs (only the stopped leg exits at a model price).
* ***AI Suggestion:*** PROPOSE FIX. The model now prices with the day's IRX yield (code, test, document).

### [Issue 22] [`egm-zoom-out`, stage 8] - Severity: Major

* **Finding:** ports checked only against hand-computed values.
* ***AI Suggestion:*** PROPOSE FIX. Golden values from the live functions at `57a1b3b` in the tests; the port now
    keeps the live rounding, order check, round-handle rule and `spaced_five` (code, tests).

### [Issue 23] [`egm-zoom-out`, stage 8] - Severity: Major

* **Finding:** the document pointed to a missing consolidated report and claimed the review closed early.
* ***AI Suggestion:*** PROPOSE FIX. `consolidated_review_report.md` written; the document points to `review/`.

### Stage 8 Nits

* Data-flow overview, the deciding premium share, the row count, the third method copy: PROPOSE FIX (applied;
    `report.METHOD_HTML` is now a short pointer to this document).
* Remove the Crown reads for test E: DECLINE; the count is the evidence that the sample is too small.

### Nits

* Emoji before LEAPS (`egm-style`, `egm-structural`): DECLINE; it is the owner's required wording.
* Unicode minus mixed with ASCII ranges: DECLINE.
* Placement of the document beside its runner instead of `docs/specs/strategies/`: DECLINE; the runner, data
    notes and review live together, as in other `research/backtests/*` studies.
* Runtime and entry counts are data-dependent: PROPOSE FIX (applied); removed from the method.
* Per-ETF results for the 10-month rule: DECLINE; the aggregate is stated, per-ETF exit counts are below 100.

All other Nits (bold use, threshold wording for D, 15:45 vs close, half-sample definition, test E criteria,
headings for the bootstrap paragraph, links) were PROPOSE FIX and applied.
