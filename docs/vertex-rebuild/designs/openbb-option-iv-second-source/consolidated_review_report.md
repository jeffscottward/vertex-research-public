# Consolidated EGM review report — openbb-option-iv-second-source/plan.md

![Nine goldfish reviewers, 3 blockers and 12 majors consolidated into 15 actions; 13 PROPOSE FIX applied, 1 CONTEST, 2 DECLINE, 0 ESCALATE; the three blockers and their fixes; the measured boundary jump per symbol](review-overview.png)

Preset: Consolidated report with all review rubrics (full flow, no stops) — chosen by the Elephant
per the standing owner rule (2026-11-15, made permanent 2026-11-18). Nine goldfish reviewers ran in
fresh contexts: zoom-out, inventive-catalyst, comprehension, design-critic, structural, style ×2,
implementation-readiness, codebase-details. Individual reports are in this folder:
`zoom_out_report.md`, `catalyst_report.md`, `comprehension_report.md`, `design_critic_report.md`,
`structural_report.md`, `style_feature_report.md`, `readiness_report.md`,
`codebase_details_report.md`, `style_impl_report.md`.

The architecture spine passed every reviewer: per-symbol CFE-pattern fallback, `ctx.failed` with the
Cboe error preserving `blocked_upstream`, `options_math.summarize` unchanged, warning marker →
`partial` status → panel note, record/replay fixtures, revert path. No reviewer asked for a redesign.
The findings below are corrections to claims, undecided mechanics, and two real failure modes.

## Consolidated action items (deduplicated)

Priority: 🔴 Blocker, 🟡 Major, 🟢 Nit. "Sources" lists the raw findings folded into each item.

### A1 🔴 Slow-Yahoo deadline regression: the job can record `failed` hourly, worse than today

Sources: design-critic B1; zoom-out Major 1; catalyst 6; readiness M6; style-feature N11.
Fact: one helper call per symbol wraps up to 30 sequential HTTP fetches; `CALL_TIMEOUT_S = 90` per
call, 7 × 90 = 630 s > the 240 s job deadline. A slow (not refusing) Yahoo hits the job-level
deadline with `sources_ok == 0` → exit 3 → run `failed` → unit fails hourly with no blocked backoff.
Resolution (PROPOSE FIX, amended by the scope-review advisory 2026-11-21): a deadline-aware
fallback gate inside `option_iv`: `YAHOO_FALLBACK_RESERVE_S = 100`; a Yahoo helper call starts
only when at least 100 s remain to the job deadline (`ctx.deadline_at`, set by `cli.run` from
`OPENBB_DEADLINE_S`), counting ALL elapsed job time — slow Cboe probes (each also capped at
90 s) consume the same clock. Otherwise the symbol skips the fetch and takes
`ctx.failed(source, cboe_error)` with the gate warning. Guarantee, narrowed explicitly: with
fast Cboe refusals, no Yahoo slowness reaches the deadline `failed` path (last fallback starts
≤ 140 s, ends ≤ 230 s < 240 s); hanging Cboe calls keep today's pre-existing deadline behavior. Second advisory amendment: the slow-Cboe mixed case (a started fallback consumes time a later Cboe success would have used) is explicitly accepted as a documented regression and pinned by a replay test; reserving for every remaining probe would forbid every fallback.
The first draft's cumulative 150 s budget was rejected by the advisory because a slow first
Cboe call plus a Yahoo helper could cross the deadline before the budget check. Delete the
undefined "retries per symbol" claim; state the envelope arithmetic; add slow-Yahoo and
slow-Cboe-then-Yahoo replay tests proving `blocked_upstream`, never a fallback started inside
the reserve.

### A2 🔴 Cross-language greeks parity 1e-9 is impossible; domain guards unspecified

Sources: codebase-details 1; readiness B3; zoom-out Major 2; catalyst 4; style-impl M4/N8.
Fact: TS `blackScholes` uses the A&S 7.1.26 erf approximation (error < 1.5e-7); Python `math.erf` is
near-exact; deltas differ by up to ~7.5e-8. `years = 0` (0-DTE) reaches the function before
`summarize` excludes it.
Resolution (PROPOSE FIX): Python uses `math.erf`; known-value checks at 1e-9 against a checked-in
table of `blackScholes` outputs recorded from the TS function (fixture JSON), cross-language
tolerance 2e-7 (the TS bound), documented in the test. `bsm_delta_gamma` returns `(None, None)` when
spot/strike/years/iv is non-positive or non-finite; negative dividend clamps to 0. Known-value rows
added to the plan (readiness N4). Put/call relation tested as call delta − put delta = e^(−q·T),
equal gamma (style-impl M4).

### A3 🔴 Deploy order omits the web deploy; the panel acceptance cannot pass

Sources: readiness B1.
Fact: the Markets page runs on QuantVPS `vertex-web`; the plan only installs the rig fetcher.
Resolution (PROPOSE FIX): deploy section rewritten to the predecessor's order: merge → build the
merged SHA on the rig and deploy `vertex-web` per `infra/quantvps/README.md`
(`stage-runtime.sh` + `restart-when-idle.sh`, outside market hours) → rig install
`infra/openbb/rig/install.sh <sha>` → live checks. Revert covers both sides. No migration in this
change.

### A4 🟡 Existing blocked-path tests break; catch scope undecided

Sources: readiness B2/M4; style-impl M5; zoom-out Major 1 (test part); codebase-details (verified).
Fact: four existing tests feed blocked Cboe records with no Yahoo recordings; `ReplayUpstream`
raises raw `LookupError` on an unrecorded key. `test_option_iv_rows_are_consistent` asserts the
Cboe-only OCC-skip warning.
Resolution (PROPOSE FIX): `_yahoo_fallback` catches `UpstreamError` only (live `ctx.up.helper`
always classifies). Update the four blocked-path tests to append a Yahoo error record per blocked
symbol and assert both warnings; update `test_option_iv_rows_are_consistent` (keep SPY/GLD and
OI/volume assertions; assert the Yahoo marker; keep one non-OCC row in `_trim_yahoo` for the skip
path). Fixture re-recording moves into the same phase as the behavior change (one CI landing).

### A5 🟡 yfinance fetch path undecided; public `.options` path costs 186 requests, not 179

Sources: readiness M1; design-critic N1; codebase-details 4a.
Fact (verified in the pinned source): `.options` discards the first chain; `option_chain(date)`
re-fetches every expiration. `option_chain()` (no date) returns the first chain AND fills
`_expirations` in one request.
Resolution (PROPOSE FIX): fetch sequence pinned: `t.option_chain()` once (quote + expirations +
first chain), then `t.option_chain(e)` for each remaining expiration → 179 requests per snapshot,
as measured. Payload built as plain JSON in `fetch_symbol`: quote keys `regularMarketPrice`,
`regularMarketTime`, `trailingAnnualDividendYield`; contract rows via `to_dict("records")`
restricted to `contractSymbol`, `strike`, `impliedVolatility`, `openInterest`, `volume`; expirations
as ISO strings. Empty chain (`calls is None`) for one expiration: skip it, count it, one warning per
symbol; no chains at all or no spot: fail the symbol. 0.1 s spacing between expiration requests
(measured full snapshot 30.7 s with spacing).

### A6 🟡 `asOf`: Yahoo `regularMarketTime` is epoch seconds; `_as_of` silently falls back to today

Sources: design-critic M5; codebase-details 3; readiness M2.
Resolution (PROPOSE FIX): `yahoo_chains` converts epoch seconds → America/New_York date
(`datetime.fromtimestamp(ts, NEW_YORK)`), then the existing cap-at-today rule; missing/unparseable
quote time fails the symbol (no silent today). Weekend test: Friday quote replayed on Saturday
stamps Friday. Spot = `regularMarketPrice`, fail when absent/≤0. Dividend =
`trailingAnnualDividendYield`, 0 when absent (field verified present in the live payload for
SPY 0.0079, QQQ 0.0027, IWM 0.0076; 0/absent for DIA GLD SLV USO).

### A7 🟡 Sentinel IV ≈ 1e-5 passes every stated filter (9.9–12% of contracts measured)

Sources: design-critic M4.
Fact: 220/2,225 contracts in the rig's stored Yahoo payload carry IV = 1e-5; the live full snapshot
had 4,793/40,057 (12%). A near-ATM sentinel halves ATM IV; BSM gamma diverges as σ→0.
Resolution (PROPOSE FIX): per-contract IV floor 0.01 in the Yahoo conversion (below → `iv=None`,
contract kept for OI/volume with `delta=gamma=None`, mirroring `parse_contracts`); fixture contains
a sentinel-IV contract near ATM proving exclusion; risk bullet corrected ("dropped as today" was
wrong: the Cboe parser keeps IV≤0 contracts with `iv=None`).

### A8 🟡 Load story wrong in the operating regime; hourly full re-fetches of a closed session

Sources: design-critic M1/M2; catalyst 3; style-feature M2/M3; zoom-out Nit 3; structural 7.
Facts: the research snapshot sends ~14 chain requests/day (1 expiration × 7 symbols × 2 runs), not
a full-chain volume; a successful fallback run is `partial`, so no blocked backoff applies and the
hourly window (5 slots) re-fetches ~179 requests each time (~895/day).
Resolution (PROPOSE FIX): (a) correct the comparison and the bound in the plan (≤5 snapshots,
≤895 requests/day worst case, full-chain burst tolerance unproven, one measured pass); (b) add a
once-per-session guard: the tick passes the newest run's summary (status, startedAt, warnings) to
`cboe-option-iv` via the existing `--state-stdin` mechanism (extended from sec-form4 to this job);
when the newest run already wrote Yahoo rows for the current NY session (marker in warnings,
`rowsWritten > 0`, startedAt's NY date == today), the job still probes Cboe (7 requests) but skips
the Yahoo re-fetch and re-emits nothing new — it records an ok run with a "session already stored"
warning-free path… → simpler: skip the Yahoo fetch and mark the source ok with no rows and one
info warning naming the stored session (run `partial`, rows unchanged). Manual runs (no state)
always fetch. This cuts the steady-state load to ~179 + 4×7 ≈ 207 requests/day.
CONTEST note: catalyst's "quote time advanced" guard is dropped (post-close quotes are frozen; the
session date is the correct key). The guard lives in the fetcher (not the tick) so a manual run and
the replay tests stay simple.

### A9 🟡 Panel note text never specified; mixed-run note implies all symbols

Sources: structural 4; codebase-details 7; readiness M3; design-critic N4.
Resolution (PROPOSE FIX): exact sentence pinned in the plan and both TS tests:
`"Source of the newest rows: Yahoo option chain for <symbols> (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary."`
`ivSourceNotice` derives `<symbols>` from the per-symbol warnings (`cboe chain <SYM>: … marker`),
sorted, comma-separated. Marker constant `OPENBB_YAHOO_FALLBACK_NOTE` unchanged. Status-language
gate: the note names state, reason and consequence (predecessor argument); no allowlist entry
expected — verified by running the gate.

### A10 🟡 Post-recovery history mix is unmarked; 7-day escalation alarm goes silent

Sources: catalyst 1; design-critic M3/M6; zoom-out Nit 2.
Facts: the percentile window is 252 sessions; the note vanishes on the first Cboe-ok day while
Yahoo rows stay in the window; the blocked-streak escalation never fires while the fallback works.
Resolution (PROPOSE FIX, partial) + documented limit: (a) the plan states the boundary numbers
measured against the last stored Cboe session (2026-11-19 → 2026-11-20 quotes, see below) instead
of "small against the day-to-day range"; (b) the panel note already says the percentile mixes
methods; the plan documents the post-recovery silent mix as a known limit, with the run ledger as
the durable provenance record (every fallback run is `partial` with the marker; recoverable per
session); (c) the lost 7-day escalation is listed in Risks with the mitigation that the panel note
and the `partial` status make the degradation visible, and the Cboe probe continues hourly so
recovery is automatic. DECLINE the ledger-derived `lastFallbackAt` caveat and the recovery-day
calibration snapshot: both add contract/server surface beyond this card's scope (the card's
acceptance is the newest-run note); filed as a follow-up card instead.

### A11 🟡 Rig-rule scoping and Alternative 3 rationale inconsistent (yfinance impersonates Chrome)

Sources: design-critic M7.
Fact: the task file's rig rule reads "no proxy or browser impersonation to pass the Cboe block" —
scoped to the Cboe block. yfinance's curl_cffi Chrome impersonation targets Yahoo, the same client
the owner's own `infra/option-chain` timer runs twice per trading day.
Resolution (PROPOSE FIX): quote the task-file rule verbatim in the plan; rewrite Alternative 3's
rejection honestly: same TLS impersonation, but hand-maintained cookie/crumb code vs the pinned,
hash-locked library already deployed on this rig; the raw `requests` client measured 429.

### A12 🟡 Fixture recording: trim dispatch, contingency, preserved Cboe payload

Sources: codebase-details 5; readiness M5/N2; design-critic N5; zoom-out Major 3; style-impl M2/M3/M6.
Resolution (PROPOSE FIX): `record.py` gains the `helper:yahoo:options_chain:` dispatch branch →
`_trim_yahoo` (reuses `_trim_chain`'s expiration rule: 2 nearest + bracket-30 + near-60; 4%-of-spot
strike filter; field whitelist from A5; quote intact; one non-OCC row kept). Recording universe is
the existing `--symbols SPY,GLD`; the replay test asserts both recorded symbols. Before
re-recording, copy the current trimmed Cboe calls into the Cboe-ok test as inline `call()` records.
Contingency: if Cboe answers 200 at recording time, record the Yahoo payloads directly via
`RecordingUpstream` + `yahoo_chains.fetch_symbol` and assemble the fixture with blocked Cboe error
records.

### A13 🟡 Terms/comprehension gaps and structural symmetry

Sources: comprehension (11 major, 10 nit); structural 1/2/3/5; style-feature N2/N3/N5/N6/N9.
Resolution (PROPOSE FIX): Terms gains one-line entries: the rig, the card tracker, tick client /
run ledger / step, fetcher document (+ status taxonomy and the `blocked` key), CFE fallback
precedent (with file path), Vertex portal / `optionsChain` / Quant Data, record→trim→replay
harness, `ctx.warn/failed/take`, table-name layers, OCC, GEX/flip/walls gloss, vol point unit,
agent viewer account. Source-choice table Verdict column points to the canonical Alternatives
list (5 entries + the openbb-yfinance provider rejection, zoom-out Nit 4). Acceptance gains the
request-bound bullet, the mixed-run bullet, `openbb_option_iv_term`, and imperative phrasing.

### A14 🟢 Claim calibrations and wording (all style/structural nits)

Sources: style-feature M1/M4/M5/M6 + N1–N12; style-impl N1–N15; structural 6/8/9/10/11/12;
zoom-out Nits 1/3; catalyst 5/6; design-critic N2/N3/N6; readiness N5/M7.
Resolution (PROPOSE FIX): apply the rewrites — duration claim calibrated; T convention stated as
whole-day approximation of the portal's to-close ACT/365; `RISK_FREE_RATE` named neutrally in
`options_math.py` (zoom-out Nit 1) with a comment cross-referencing `OPTIONS_CHAIN_RISK_FREE_RATE`;
two `--exclude-newer` anchors noted; `empty`-kind branch stated (no fallback on `empty`, CFE
pattern); fetch-time total marked ≈; full paths everywhere; expiration/expiry unified; alt text
split; CHANGELOG.md row added; per-phase check commands added
(`bash scripts/ci/research-python.sh`, `pnpm exec vitest run --config vitest.config.ts --project unit …`);
known-value greeks table added; unit tests moved to `test_units.py`; panel test extension named;
`--warm` edit site named (`PROVIDER_MODULES` + import); redundant disclaimer dropped.

### A15 🟡 IV fidelity vs coverage: composite parity-mid chain (catalyst 2)

Resolution (DECLINE for this card, documented): the ATM-only parity correction and the full hybrid
add the parity-forward machinery to the ingest job and a second IV method inside one chain. The
card asks for a marked second source, not a new IV method; the measured method gap is documented
(A10) and the marker makes every affected session recoverable. The composite chain is recorded in
Alternatives Considered as a future refinement with its cost. No follow-up card (speculative).

## Boundary measurement (new evidence, 2026-11-21, rig)

Last stored Cboe session 2026-11-19 (live `openbb.volContext` read as the agent viewer) vs the
Yahoo-method values of the 2026-11-20 close (proposed method: `option_chain()` path, IV floor
0.01, BSM greeks, 0.1 s spacing; 179 requests, 30.7 s, 40,057 contracts, 4,793 sentinel IVs
dropped):

| Symbol | Cboe 11-19 atmIv30d | Yahoo-method 11-20 | Δ (vol points) |
| --- | --- | --- | --- |
| SPY | 0.2325 | 0.3056 | +7.3 |
| QQQ | 0.3222 | 0.4058 | +8.4 |
| DIA | 0.2100 | 0.2611 | +5.1 |
| IWM | 0.2514 | 0.3220 | +7.1 |
| GLD | 0.2628 | 0.3205 | +5.8 |
| SLV | 0.4850 | 0.5596 | +7.5 |
| USO | 0.4693 | 0.5113 | +4.2 |

The boundary jump mixes one session of real market move (2026-11-19 → 11-20) with the method
difference; it cannot be decomposed while Cboe is blocked. The jump is larger than the
Yahoo-vs-Black-76 gap (0.5–0.6 points) measured on one expiration: the full-chain 30-day figures
differ more (expiration coverage and the IV model both change). This replaces the "small against
the day-to-day range" claim: the plan states the measured jump, the percentile currently has only
9 stored sessions (below the 20-session minimum, so it shows "n/a" today), and the mix is marked
while the fallback runs. The IV percentile returns null until 20 sessions exist
(`OPENBB_IV_PERCENTILE_MIN_SESSIONS`), so the first weeks of mixed history do not display a
percentile at all.

## Traceability matrix

| Action | Raw findings |
| --- | --- |
| A1 | critic B1, zoom M1, catalyst 6, readiness M6, style-f N11 |
| A2 | codebase 1, readiness B3, zoom M2, catalyst 4, style-i M4/N8, readiness N4 |
| A3 | readiness B1 |
| A4 | readiness B2/M4, style-i M5, zoom M1(tests) |
| A5 | readiness M1, critic N1, codebase 4a |
| A6 | critic M5, codebase 3, readiness M2 |
| A7 | critic M4 |
| A8 | critic M1/M2, catalyst 3, style-f M2/M3, zoom N3, structural 7 |
| A9 | structural 4, codebase 7, readiness M3, critic N4 |
| A10 | catalyst 1, critic M3/M6, zoom N2 |
| A11 | critic M7 |
| A12 | codebase 5, readiness M5/N2, critic N5, zoom M3, style-i M2/M3/M6 |
| A13 | comprehension all, structural 1/2/3/5, style-f N2/N3/N5/N6/N9, zoom N4 |
| A14 | style-f M1/M4/M5/M6+N1–N12, style-i N1–N15, structural 6/8–12, zoom N1/N3, catalyst 5/6, critic N2/N3/N6, readiness N5/M7, codebase 8/9/10 |
| A15 | catalyst 2 |

Counts: 3 🔴, 12 🟡 consolidated items; every raw finding maps to exactly one action. Dispositions:
PROPOSE FIX on A1–A9, A11–A14; A10 partial fix + documented limit + follow-up card; A15 DECLINE
(recorded in Alternatives). No ESCALATE finding: no fact only the owner has is missing (the rig
rule is quoted in the task file; the source choice is a research-method decision covered by the
auto-decider rule and was posted with its evidence).
