# Goldfish Annotated Review Report

![Resolution gate Auto accept: 13 PROPOSE FIX applied to plan v2, 1 CONTEST, 2 DECLINE recorded, 0 ESCALATE; blockers A1-A3 and their fixes; measured boundary jump](review-overview.png)

**Target:** `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md` (full file, 319 lines)

Resolution gate: **Auto accept** — chosen by the Elephant without an ask menu per the standing
owner rule (2026-11-13, owner Discord message (private), card egm-resolve Auto accept). Every
PROPOSE FIX below is applied to the plan; CONTEST and DECLINE items stay recorded here. No
ESCALATE finding exists (no fact only the owner has is missing).

The consolidated, deduplicated action items A1–A15 with the full traceability matrix are in
`consolidated_review_report.md`; this report annotates each with its disposition and edit.

## Prioritized Findings & AI Suggestions

### A1 [design-critic, zoom-out, catalyst, readiness, style] - Severity: Blocker

* **Affected Scope:** Architecture deadline bullet, Acceptance degradation bullet, Risks first bullet, Tests.
* **Discrepancy Description:** One helper call per symbol wraps up to 30 sequential fetches; 7 × 90 s per-call cap = 630 s > the 240 s job deadline. A slow Yahoo hits the job deadline with no source ok → exit 3 → `failed` run hourly, no backoff — worse than today.
* **Rationale:** Verified against `upstream.py:38`, `cli.py:33,340–350`, `tick.ts` backoff/escalation keys.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** The guarantee "never worse than today" must hold for slowness, not only refusal.
* ***Proposed Edit:** Cumulative fallback budget: `YAHOO_FALLBACK_BUDGET_S = 150` in `jobs/cboe.py`; `option_iv` tracks monotonic time spent in Yahoo fallback; once the budget is spent, remaining blocked symbols skip the fetch and take `ctx.failed(source, cboe_error)` with a budget warning. Worst case 150 + 90 + 7 fast probes < 240 s. Delete "even with retries per symbol"; state the envelope; add the slow-Yahoo replay test (delay_s) asserting exit 0 + `blocked`, and update the existing deadline test's recordings.
* ***Applied edit (amended by scope-review advisory, 2026-11-21):*** the cumulative budget alone left the guarantee false — each Cboe probe also carries the 90 s cap and runs before its symbol's fallback, so a slow first Cboe call plus a Yahoo helper could cross the deadline before the budget check. Applied instead: a deadline-aware gate, `YAHOO_FALLBACK_RESERVE_S = 100`; a Yahoo helper starts only when ≥ 100 s remain to the job deadline (`ctx.deadline_at`, set by `cli.run` from `OPENBB_DEADLINE_S`), counting ALL elapsed job time including slow Cboe probes. Guarantee narrowed explicitly: fast Cboe refusals + any Yahoo slowness → never the deadline `failed` path (last fallback starts ≤ 140 s, ends ≤ 230 s). Second advisory amendment (2026-11-21): the 'never made worse' claim for slow Cboe was also false — a started Yahoo fallback can consume time a later Cboe success would have used (90+90+70 counterexample). Reserving for all remaining probes (7×90 s) would forbid every fallback, so the mixed slow-Cboe case is explicitly ACCEPTED as a documented regression (outcome = pre-existing deadline behavior, never fake rows) and pinned by test_option_iv_slow_cboe_mixed_regression. Tests: slow-Yahoo, slow-Cboe gate, and the mixed regression sequence.

### A2 [codebase-details, readiness, zoom-out, catalyst, style] - Severity: Blocker

* **Affected Scope:** Phase 1 step 2, Tests `test_bsm_delta_gamma`.
* **Discrepancy Description:** 1e-9 parity with TS `blackScholes` is impossible (A&S erf error < 1.5e-7); domain guards and 0-DTE `years=0` unspecified; put/call "symmetry" imprecise.
* **Rationale:** Verified `options-chain-greeks.ts:36–51,57–70`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Keeps exact `math.erf` in Python; no approximation port.
* ***Proposed Edit:** Python uses `math.erf`; checked-in JSON table of `blackScholes` outputs (recorded from the TS function) as the parity fixture, tolerance 2e-7; known-value checks at 1e-9; `(None, None)` when spot/strike/years/iv non-positive or non-finite; negative dividend → 0; call delta − put delta = e^(−q·T), equal gamma; tests in `test_units.py`; 5 fixed known-value rows in the plan.

### A3 [readiness] - Severity: Blocker

* **Affected Scope:** Deploy order and revert.
* **Discrepancy Description:** The web/API change is never deployed; the Markets panel acceptance cannot pass; revert covers only the rig.
* **Rationale:** The Markets page runs on QuantVPS `vertex-web` (predecessor plan deploy step 1).
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Without the web deploy the feature's visible half never ships.
* ***Proposed Edit:** Deploy section: merge → build merged SHA on the rig (`pnpm install --frozen-lockfile && bun run build`, DEPLOYED_SHA) → copy dist + config, `stage-runtime.sh`, `restart-when-idle.sh` (outside market hours, per `infra/quantvps/README.md`) → rig install `infra/openbb/rig/install.sh <sha>` → live checks. Revert: rig install of the earlier SHA, then web revert + redeploy of the earlier build. No migration.

### A4 [readiness, style-impl, zoom-out] - Severity: Major

* **Affected Scope:** Phase 2 step 4, Files table, Tests.
* **Discrepancy Description:** Four existing blocked-path tests feed no Yahoo recordings; `ReplayUpstream` raises raw `LookupError`; catch scope undecided; `test_option_iv_rows_are_consistent` asserts the Cboe-only OCC-skip warning.
* **Rationale:** Verified `test_jobs.py:450–550`, `upstream.py:330–332`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Catch `UpstreamError` only in `_yahoo_fallback`; update the four tests with per-symbol Yahoo error records and both-error warning assertions; update `test_option_iv_rows_are_consistent` (Yahoo marker assertion; one non-OCC row kept in `_trim_yahoo`); fixtures re-recorded in the same phase as the behavior change.

### A5 [readiness, design-critic, codebase-details] - Severity: Major

* **Affected Scope:** Architecture fetch diagram, Phase 2 step 3, request table.
* **Discrepancy Description:** `.options` discards the first chain; the depicted sequence costs 186 requests; payload construction and empty-chain rule undecided.
* **Rationale:** Verified pinned `yfinance/ticker.py:46–110,309–312`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Pin `t.option_chain()` (no date) once → quote + `_expirations` + first chain; `t.option_chain(e)` for the rest → 179 requests (measured). Payload schema pinned field-by-field; `to_dict("records")` whitelist; empty expiration skipped with a per-symbol count warning; no spot or no chains fails the symbol; 0.1 s inter-request spacing (measured 30.7 s full snapshot).

### A6 [design-critic, codebase-details, readiness] - Severity: Major

* **Affected Scope:** `asOf` bullet, Phase 2 step 3.
* **Discrepancy Description:** `regularMarketTime` is epoch seconds; `_as_of`/`iso_date` returns None → silent today; weekend manual run stamps the wrong session.
* **Rationale:** Verified `values.py:58–74`, TS adapter `*1000`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Epoch → NY date conversion in `yahoo_chains` (`datetime.fromtimestamp(ts, NEW_YORK)`), cap at today; missing/unparseable time fails the symbol; spot from `regularMarketPrice` (fail when absent/≤0); dividend `trailingAnnualDividendYield` default 0 (presence verified live: SPY 0.0079, QQQ 0.0027, IWM 0.0076); Friday-quote-on-Saturday test.

### A7 [design-critic] - Severity: Major

* **Affected Scope:** Risks Yahoo-IV bullet, conversion spec.
* **Discrepancy Description:** Sentinel IV = 1e-5 passes `iv > 0`; 220/2,225 (9.9%) in the stored payload, 4,793/40,057 (12%) in the live full snapshot; near-ATM sentinel halves ATM IV and explodes BSM gamma.
* **Rationale:** Measured on the rig's own recorded Yahoo data.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** IV floor 0.01 in the Yahoo conversion → `iv=None`, contract kept for OI/volume, `delta=gamma=None` (mirrors `parse_contracts`); sentinel-near-ATM fixture row; correct the "dropped as today" wording (Cboe parser keeps them with `iv=None`).

### A8 [design-critic, catalyst, style-feature, zoom-out, structural] - Severity: Major

* **Affected Scope:** Request budget paragraph, Risks rate-limit bullet.
* **Discrepancy Description:** Research snapshot sends ~14 chain requests/day, not full-chain volume; a `partial` fallback run gets no backoff → up to 5 full snapshots/day (~895 requests); "far below" comparison unproven.
* **Rationale:** Verified store contents (14 CSVs/run), `tick.ts` backoff keys, steps file (5 slots).
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Correct the numbers and drop the unproven comparison; once-per-session guard via `--state-stdin` extended to `cboe-option-iv` (tick passes the newest run's status/startedAt/warnings/rowsWritten); when the newest run wrote Yahoo rows for the current NY session, probe Cboe but skip the Yahoo re-fetch (one warning naming the stored session); manual runs always fetch; steady state ≈ 207 requests/day. CONTEST sub-item: catalyst's "quote time advanced" guard dropped — post-close quotes are frozen; the session date is the key.

### A9 [structural, codebase-details, readiness, design-critic] - Severity: Major

* **Affected Scope:** Marking section, Phase 3, web tests.
* **Discrepancy Description:** The panel note sentence is never written; mixed-run note implies all symbols are Yahoo.
* **Rationale:** `vxSourceNotice` precedent pins a full literal; tests pin exact strings.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Exact note pinned (see plan): "Source of the newest rows: Yahoo option chain for <symbols> (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary." `<symbols>` derived from the per-symbol warnings, sorted. Status-language gate run; no allowlist entry expected (note names state, reason, consequence).

### A10 [catalyst, design-critic, zoom-out] - Severity: Major

* **Affected Scope:** Marking section, percentile claim, Risks.
* **Discrepancy Description:** Note is transient while the 252-session percentile mix persists; the 7-day blocked escalation goes silent while the fallback works; "small against day-to-day range" unbacked; Yahoo-vs-Cboe gap unmeasured.
* **Rationale:** Verified `OPENBB_IV_PERCENTILE_SESSIONS = 252`, escalation keys, stored rows.
* ***AI Suggestion:*** PROPOSE FIX (partial) + DECLINE (ledger caveat, calibration snapshot)
* ***Justification:** The card's acceptance is the newest-run note; a `lastFallbackAt` contract field + ledger query + recovery-day calibration snapshot exceed this card's scope. The mix is real but bounded and marked while it forms; the percentile shows null below 20 sessions (today: 9).
* ***Proposed Edit:** State the measured boundary table (Cboe 11-19 vs Yahoo-method 11-20: +4.2 to +8.4 vol points, market move + method mixed, not decomposable while blocked); drop "small"; document the post-recovery silent mix as a known limit with the run ledger as durable provenance; list the lost 7-day escalation in Risks (panel note + `partial` status keep it visible; hourly Cboe probe recovers automatically). Follow-up card for the ledger-derived history caveat (`fm add … --why-not-fixed "too-large: contract+server surface beyond this card"`).

### A11 [design-critic] - Severity: Major

* **Affected Scope:** Scope line, Non-goals, Alternative 3.
* **Discrepancy Description:** Rig rule re-scoped without citation; yfinance itself impersonates Chrome (curl_cffi), so the impersonation-based rejection of Alternative 3 is inconsistent.
* **Rationale:** Task file rule text: "no proxy or browser impersonation to pass the Cboe block"; `yfinance/data.py:81`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Quote the task-file rule verbatim; Alternative 3 rejected for hand-maintained cookie/crumb code + measured 429 of the plain client, vs the pinned hash-locked library the owner's option-chain timer already runs; state plainly that yfinance uses curl_cffi Chrome impersonation against Yahoo (not Cboe).

### A12 [codebase-details, readiness, design-critic, zoom-out, style-impl] - Severity: Major

* **Affected Scope:** Phase 4, Files table, Tests.
* **Discrepancy Description:** No trim dispatch branch → multi-MB fixtures; recording depends on Cboe staying blocked; "re-record" of the Cboe-ok path impossible; 2-symbol fixture vs "every symbol" assertion.
* **Rationale:** Verified `record.py` dispatch, ARGV `--symbols SPY,GLD`, one-upstream-fixture-per-job test.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** `_trim_yahoo` + dispatch branch (expiration rule of `_trim_chain`, 4% strike filter, field whitelist, quote intact, one non-OCC row); copy the current trimmed Cboe calls into the Cboe-ok test as inline records before re-recording; contingency recording via `RecordingUpstream` + `fetch_symbol` with blocked Cboe error records if Cboe answers 200; replay test asserts SPY and GLD.

### A13 [comprehension, structural, style-feature, zoom-out] - Severity: Major

* **Affected Scope:** Terms, Source choice vs Alternatives, Acceptance.
* **Discrepancy Description:** Undefined institutional terms (rig, card, tick, fetcher document, CFE precedent, replay harness, ctx API, portal, Quant Data, viewer account); duplicated divergent alternatives; goal→acceptance gaps; table-name layers.
* **Rationale:** Comprehension paraphrase passed; the gap ring is around infrastructure, not the change.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:** Terms expanded (one line each); Source-choice Verdict column points to the canonical 6-entry Alternatives list (adds the openbb-yfinance provider rejection: needs yfinance>=1.3 + GUI/router deps the lock excludes); Acceptance gains the request-bound bullet, mixed-run bullet, term table, imperative phrasing; table-name layers stated.

### A14 [style ×2, structural, zoom-out, catalyst, design-critic, readiness, codebase-details] - Severity: Nit (batch)

* **Affected Scope:** Whole document.
* **Discrepancy Description:** ~40 wording/precision nits (calibrations, paths, units, naming, formatting, per-phase commands, known-value table, test-file placement, CHANGELOG row, `--warm` edit site, T convention, two exclude-newer anchors, empty-kind branch, redundant disclaimer).
* ***AI Suggestion:*** PROPOSE FIX (batch; each rewrite is in the style/structural reports)
* ***Proposed Edit:** Apply all rewrites as listed in `style_feature_report.md`, `style_impl_report.md`, `structural_report.md` and the nit items of the other reports; `RISK_FREE_RATE` named neutrally in `options_math.py`; unit tests in `test_units.py`; per-phase check commands; CHANGELOG.md row; `PROVIDER_MODULES` + yfinance import in `warm()`.

### A15 [catalyst] - Severity: Major

* **Affected Scope:** Alternatives #5, IV method section.
* **Discrepancy Description:** IV fidelity vs coverage framed as binary; a composite chain (parity-mid IV near spot, Yahoo column far strikes) or ATM-only correction would remove the compromise.
* **Rationale:** Real separation exists in `summarize`'s consumers.
* ***AI Suggestion:*** DECLINE (recorded)
* ***Justification:** The card asks for a marked second source, not a new IV method. The parity-forward machinery in the ingest job, a second method inside one chain, and the delta-consistency invariant exceed the card's scope; the method gap is measured, documented and marked. Recorded in Alternatives Considered as a future refinement with its cost. No follow-up card (speculative, no current requirement).

## Resolution counts

PROPOSE FIX applied: A1–A9, A11–A14 (13 items, covering every 🔴 and all 🟡 except A10's declined
part and A15). CONTEST: 1 sub-item (A8 quote-time guard). DECLINE: 2 (A10 ledger caveat +
calibration → follow-up card; A15 composite chain → recorded alternative). ESCALATE: 0.
