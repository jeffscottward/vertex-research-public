# Implementation Readiness Report — `openbb-option-iv-second-source/plan.md`, DetailedRange (lines 236–319)

![EGM review overview: 9 goldfish reviewers, 3 blockers; this readiness review raised A3 (web deploy missing), A4 (blocked-path tests) and the fetch-path/quote-mapping majors shown here](review-overview.png)

Mode: REVIEW. Persona and standard applied verbatim. Baseline verified against the repo at the working tree: `jobs/cboe.py`, `options_math.py`, `context.py`, `upstream.py`, `cli.py`, `values.py`, `services/openbb/tests/record.py`, `services/openbb/tests/test_jobs.py`, `contracts/openbb.ts`, `options-chain-greeks.ts`, `view-model.ts`, `openbb-panels.tsx`, `openbb-server.test.ts`, `requirements-openbb.in`/lock, `infra/openbb/rig/install.sh`, `scripts/merge-pr`, the predecessor plan, and the pinned yfinance 0.2.66 source in the local uv cache.

Verdict: **not ready**. The file list and warning/marker contract are precise, but three blockers and several majors leave concrete design decisions and test-breaking consequences to the implementer.

---

## 🔴 Blockers

**B1. Deploy order never deploys the web/API change; the live check cannot pass as written.**

- Scope: lines 309–319 (Deploy order and revert), Phase 3 (lines 275–278), files `packages/api/src/contracts/openbb.ts`, `apps/web/src/features/openbb/*`.
- Problem: Steps are merge → rig install → verify "the Markets panel note". The Markets page runs on the QuantVPS `vertex-web` service, not on the rig. The predecessor plan's deploy step 1 explicitly deploys `vertex-web` via `infra/quantvps/restart-when-idle.sh` (predecessor lines 339–342); this plan drops that step entirely. Without it, `ivSourceNotice` never reaches the page and acceptance item 1 ("the Markets panel shows the source note") fails. The revert step (318–319) likewise reverts only the rig, leaving the new web code deployed against reverted data — undefined ordering.
- Suggested change: Add an explicit step "Deploy `vertex-web` on the QuantVPS with `infra/quantvps/restart-when-idle.sh` (no migration in this change; operator rule: outside market hours)" before or after the rig install, state the safe ordering (no schema change here, so either order works — say which), and extend step 4 to revert/redeploy the web commit as well.

**B2. The existing blocked-path tests break, and the plan asserts the opposite; `_yahoo_fallback`'s exception-catch scope is undecided.**

- Scope: lines 270–273 (step 4), 306–307 ("The existing deadline test … still passes"), file-table row 251.
- Problem: `test_jobs.py` already contains four tests that feed blocked/failed Cboe records for all `CORE7_CHAINS` with **no Yahoo recordings**: `test_every_source_blocked_upstream_is_exit_0_with_the_host` (~line 461), `test_blocked_sources_with_another_failure_still_exit_3` (~467), `test_a_blocked_error_without_a_host_is_a_plain_failure` (~450), `test_deadline_with_only_blocked_sources_exits_3` (~548). After the change, each blocked Cboe call triggers `ctx.up.helper("helper:yahoo:options_chain:<sym>", …)`. `ReplayUpstream._call` raises a **raw `LookupError`** for an unrecorded key — it does not wrap it in `UpstreamError` (that wrapping happens only in the live `Upstream._call`). If `_yahoo_fallback` catches only `UpstreamError` (the CFE pattern catches `UpstreamError, ValueError, csv.Error`), the `LookupError` escapes the job and the run exits 1 — all four tests fail, including the deadline test the plan explicitly promises still passes. If it catches broad `Exception`, the tests may pass but unrecorded-call detection is silently swallowed in every replay test. Either way this is an undecided design choice with test-visible consequences, and the plan lists no update to these tests.
- Suggested change: (a) State the catch rule explicitly, e.g. "`_yahoo_fallback` catches `UpstreamError` only; live `ctx.up.helper` always classifies, so this is sufficient." (b) Add to the file table / Phase 4: "update the four existing blocked-path tests to append `error(f"helper:yahoo:options_chain:{sym}", "error", …)` records after each blocked Cboe record, and extend the warning assertions to name both errors." (c) Correct or qualify the claim on lines 306–307.

**B3. `bsm_delta_gamma` parity tolerance 1e-9 is unachievable against the baseline TS formula; the erf implementation and out-of-domain return convention are unspecified.**

- Scope: lines 245, 262–263 (Phase 1 step 2), 301–302 (`test_bsm_delta_gamma`).
- Problem: `packages/api/src/options-chain-greeks.ts` computes `normalCdf` from the Abramowitz–Stegun 7.1.26 erf approximation with **absolute error up to 1.5e-7** (comment at line ~36). Python's `math.erf` is near-exact. Delta = carry·N(d1) therefore differs between the two implementations by up to ~7.5e-8 — orders of magnitude above the stated 1e-9 parity. The implementer must choose: reimplement the same A&S polynomial in Python (a fidelity decision the plan never states), or loosen the tolerance. Additionally, the function's return shape and domain guards are undecided: TS `blackScholes` returns `null` for spot/strike/years/volatility ≤ 0; the Python signature `bsm_delta_gamma(spot, strike, years, iv, rate, dividend_yield, is_call)` says nothing about what it returns for `iv <= 0` or `years <= 0`. This matters concretely: `contracts_of` runs before `summarize` excludes 0-DTE contracts, so `years = 0` reaches the function and would divide by zero.
- Suggested change: Pin the decision, e.g. "use `math.erf`; parity test tolerance 1e-7 (the TS erf approximation's bound), documented in the test" — or "port the A&S polynomial for bit-level parity, tolerance 1e-9". Specify the return: `(delta, gamma)` tuple, `(None, None)` when any of spot/strike/years/iv is non-positive or non-finite, matching the TS domain rule; state that contracts with `iv is None` keep `delta=gamma=None` as in the Cboe path.

---

## 🟡 Majors

**M1. The yfinance access path is undecided, and the naive public-API path contradicts the documented request budget.**

- Scope: lines 267–269 (step 3), FeatureRange request-count table and architecture diagram.
- Problem: Verified in the pinned yfinance 0.2.66 (`ticker.py`): `Ticker.options` calls `_download_options()` (1 request) and **discards the returned first chain**; `Ticker.option_chain(expiry)` then issues a fresh `_download_options(date)` request for *every* expiry, including the first. So `.options` + `.option_chain(e)` for all e = 1 + n requests per symbol = **186 total, not the documented 179** ("the first expiration comes with the list call"). Honoring the stated budget requires using the private `_download_options()` return value (or equivalent) for the first chain — a real design decision the plan leaves open. Also unspecified: how the DataFrames become the JSON payload (`df.to_dict("records")`? which columns kept?), and what to do when `option_chain` returns `calls=None/puts=None` or `_download_options` returns `{}` (Yahoo does this for an empty/expired expiry) — skip that expiry with a warning, or fail the symbol?
- Suggested change: Specify the exact fetch sequence (e.g. "call `t._download_options()` once; keep its `calls`/`puts` records and `underlying` for the first expiry; `t.option_chain(e)` for the rest; convert frames with `to_dict('records')` restricted to `contractSymbol, strike, impliedVolatility, openInterest, volume`"), or switch to the public API and correct the request table to 186. State the empty-chain rule (recommend: skip the expiry, `ctx.warn` once per symbol with a count).

**M2. Quote-field mapping and the `regularMarketTime` conversion are unspecified; naive reuse of the Cboe `asOf` rule silently produces the wrong date.**

- Scope: lines 268–269 ("spot and quote time from the quote object"), FeatureRange `asOf` bullet.
- Problem: The plan never names the quote fields. Spot must come from `regularMarketPrice` (not stated; `regularMarketPreviousClose` etc. are plausible wrong picks). More critically, the raw v7 quote inside `_download_options` carries `regularMarketTime` as **epoch seconds (int)**; `values.iso_date()` accepts only date/datetime/ISO/`YYYYMMDD` and returns `None` for an int, so piping it into the existing `_as_of()` falls back to `ctx.today` silently — on a Saturday manual run that stamps Friday's chain as Saturday, breaking the stated "same rule as the Cboe `last_trade_time`" and the session semantics. The epoch→America/New_York-date conversion (which helper, `zoneinfo` usage, missing-field fallback) is a decision the implementer must make.
- Suggested change: Document: "spot = `num(quote.get('regularMarketPrice'))`, fail the symbol when absent/≤0 (mirror `chain_rows`); `as_of` = NY date of `datetime.fromtimestamp(quote['regularMarketTime'], ZoneInfo('America/New_York'))`, capped at `ctx.today`, defaulting to `ctx.today` when absent." Name the dividend field default (`trailingAnnualDividendYield`, 0 when absent — already in FeatureRange; repeat in step 3) and the per-contract field names (`contractSymbol`, `impliedVolatility`, `openInterest`, `volume`).

**M3. The exact panel note text is never written down, yet tests must pin it.**

- Scope: lines 253, 277–278, 303–305; FeatureRange "the note says this in one sentence".
- Problem: The predecessor gave the CFE notice verbatim and pinned it; here only the *marker* constant `OPENBB_YAHOO_FALLBACK_NOTE = "used the Yahoo option chain"` is fixed. `ivSourceNotice` must return a full user-facing sentence (naming the source, the reason, and the method discontinuity for the percentile), and `view-model.test.ts`/`openbb-panels.test.tsx` "pin the note" — but the string to pin does not exist in the plan. Writing user-facing copy is a design choice under the zero-decision rule; the `status-language.test.ts` gate also depends on the exact wording.
- Suggested change: Add the literal, e.g. `"Source of the newest rows: Yahoo option chain (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ slightly from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary."` and state that the tests pin this exact string built from `OPENBB_YAHOO_FALLBACK_NOTE`.

**M4. Phase ordering leaves CI red between Phases 2 and 4, and one existing fixture test's assertion is invalidated without an instruction.**

- Scope: lines 258–289 (Phases 1–4), 250–251; standard's "each phase leaves the codebase stable, buildable, testable".
- Problem: Phase 2 changes `option_iv` behavior, but the fixtures are re-recorded only in Phase 4. Between them, the parametrized `test_fixture_replay_matches_shared_fixture[cboe-option-iv]`, `test_shared_fixture_is_a_valid_batch_document`, and the four blocked-path tests (B2) fail. Separately, `test_option_iv_rows_are_consistent` (test_jobs.py ~73) asserts `any("non-standard" in w or "OCC" in w …)` — the B1SPY skip-warning that only the Cboe payload produces. The re-recorded Yahoo fixture has clean OCC symbols, so this assertion fails; the plan never says to update it.
- Suggested change: Move fixture re-recording + existing-test updates into Phase 2 (or declare Phases 2–4 one CI landing), and add an explicit instruction: "update `test_option_iv_rows_are_consistent`: keep the {SPY, GLD} and OI/volume-consistency assertions; replace the OCC-skip-warning assertion with the Yahoo marker assertion (or keep a trimmed non-OCC row in `_trim_yahoo` for the skip path — decide which)."

**M5. Fixture recording depends on Cboe still being blocked, with no contingency.**

- Scope: lines 282–285 (steps 6–7).
- Problem: Step 6's premise is "Cboe is blocked now, so the recording is the fallback path itself." If Cboe unblocks before Phase 4 executes, `record.py cboe-option-iv` captures the ok path and **no real Yahoo payload ever gets recorded**, violating Goal 5 ("tests replay recorded real payloads"). The predecessor plan handled exactly this contingency in its acceptance check 8; this plan does not. Also, step 7's "second upstream fixture variant kept inline in the test (the existing trimmed Cboe payload)" is ambiguous: `test_every_job_has_fixtures` enforces exactly one upstream fixture per job, so "variant" must mean inline `call()` records — say so, and say where the old payload is preserved before the re-record overwrites it (it exists only in git history after step 6).
- Suggested change: Add: "If Cboe answers 200 at recording time, record the Yahoo helper payloads directly via `RecordingUpstream` calling `yahoo_chains.fetch_symbol(sym)` for SPY and GLD and assemble the upstream fixture with synthetic blocked Cboe records (real Yahoo results, real blocked-error shape)." And: "before re-recording, copy the current trimmed Cboe calls into `test_option_iv_cboe_ok_never_calls_yahoo` as inline `call()` records."

**M6. "Even with retries per symbol" — no retry policy exists or is specified, and the 90 s per-call timeout vs 30 sequential requests is unexamined.**

- Scope: lines 267–271; FeatureRange deadline bullet ("even with retries per symbol it stays far inside the budget").
- Problem: Nothing in the plan adds retries, and yfinance's internal retry behavior is not stated. Meanwhile the whole symbol (up to 30 sequential HTTP requests for SPY) now runs inside **one** `ctx.up.helper` call, which `Upstream._call` caps at `CALL_TIMEOUT_S = 90`. At ~3 s/request Yahoo latency, SPY alone times out and the symbol fails — acceptable degradation, but the plan's safety claim rests on measured happy-path numbers only, and the implementer must decide whether to keep 90 s, raise it for this helper, or add per-expiry resilience.
- Suggested change: Either delete the retry claim, or specify the policy. State explicitly: "keep `CALL_TIMEOUT_S = 90` per symbol helper; a slow symbol times out, `ctx.failed(source, cboe_error)` keeps it blocked; no per-expiry retry is added."

**M7. No per-phase check commands.**

- Scope: lines 258–289.
- Problem: The predecessor ended every phase with an executable check (`bash scripts/ci/research-python.sh`, exact `pnpm exec vitest run --config vitest.config.ts --project unit …` invocations, `pnpm db:generate` no-change check). This plan gives only "uv pip sync into a scratch venv … --warm passes" for Phase 1 and nothing for Phases 2–4. The implementer must discover the suite wiring (`ci-suites-openbb.txt`, the vitest project flags, `apps/web/src/status-language.test.ts` which gates new notice text) themselves.
- Suggested change: Add the check line per phase: Phase 1/2/4 Python — `bash scripts/ci/research-python.sh`; Phase 3/4 web/API — `pnpm exec vitest run --config vitest.config.ts --project unit packages/api/src/openbb-server.test.ts apps/web/src/features/openbb apps/web/src/status-language.test.ts`; note whether the new note needs a status-language allowlist entry (predecessor argued none; repeat the argument for the new sentence from M3).

---

## 🟢 Nits

**N1. "Rows for every symbol" vs a 2-symbol fixture.** Lines 293–294 vs 282–283: `record.py`'s ARGV is `--symbols SPY,GLD` and step 6 trims to 2 symbols; the test bullet says "rows for every symbol". Say "every fixture symbol (SPY, GLD)"; the all-7 claim belongs to the live acceptance check only.

**N2. `_trim_yahoo` selection rule is "~5 expirations".** Lines 249, 283: `_trim_chain` has a precise rule (two nearest + the two bracketing 30 d + nearest 60 d). State that `_trim_yahoo` reuses that rule per symbol and also trims the `expirations` list and `chains` keys consistently (and keeps the quote object intact), so the payload stays self-consistent for replay.

**N3. Greeks unit tests placed in the replay suite.** Lines 251, 262: pure-math tests are listed under `test_jobs.py`, whose module docstring is "Every job replayed from recorded real upstream payloads". `services/openbb/tests/test_units.py` exists and the predecessor put unit tests there. Name the intended file; if `test_units.py`, add it to the file allowlist.

**N4. No known-value table for `test_bsm_delta_gamma`.** Lines 301–302: "known-value checks (ATM, deep ITM/OTM, …)" gives categories, not inputs/expected outputs. Provide 3–5 fixed `(spot, strike, years, iv, rate, q, is_call) → (delta, gamma)` rows so the test is writable without the implementer generating their own oracle.

**N5. `CHANGELOG.md` missing from the file list.** Lines 240–256: the predecessor's file table included it; repo convention appears to require an entry per merged change. Add the row or state it is intentionally omitted.

**N6. Step 4 omits the Yahoo-error warning the test demands.** Lines 270–273 vs 295–296: `ctx.failed(source, cboe_error)` warns only the Cboe error; `test_option_iv_yahoo_failure_keeps_blocked` requires "warning names both errors". Make the CFE-pattern explicit: `ctx.warn(f"{source}: yahoo chain: {yahoo_exc.message}")` before `ctx.failed(source, cboe_error)`.

---

## Verified-correct items (no action)

- File paths in the table all exist (or are correctly marked new); `scripts/merge-pr` and `infra/openbb/rig/install.sh <sha>` exist and the installer's `uv pip sync --require-hashes` does add/remove yfinance exactly as the deploy/revert steps claim.
- The lock claim is accurate: pandas 3.1.1, numpy, curl-cffi 0.17.0, beautifulsoup4, websockets, platformdirs, requests are already locked; multitasking/frozendict/peewee/protobuf/pytz are absent and will be new. The documented `uv pip compile` command with `--exclude-newer 2026-11-08` is in `requirements-openbb.in`'s header; wheel-only resolution is satisfiable (peewee ships wheels since 3.19.0/2026-01; latest before cutoff 4.5.3 — same resolution the research runner gets, and its 2026-11-20 runs prove runtime compatibility).
- Marker/warning strings, `YAHOO_RATE = 0.04` (matches `OPTIONS_CHAIN_RISK_FREE_RATE` in `options-chain-merge.ts`), the `ctx.take`/`ctx.failed`/`all_blocked` mechanics, `partial` status via the tick client's existing warnings rule, the `notices` array insertion point (`openbb-panels.tsx:339`), the `vxSourceNotice` pattern, the automatic TS fixture enumeration in `openbb-server.test.ts`, and `num()`'s handling of jsonable `"NaN"` strings are all consistent with the baseline. The `--warm` change is a one-line addition to `warm()` and is sufficiently specified.

**Bottom line:** resolve B1–B3 (web deploy step, existing-test updates + catch scope, erf/tolerance/domain decision) and M1–M3 (fetch path, quote-field/epoch mapping, exact note text) before an implementer starts; the remaining majors are ordering/command completeness fixes that are quick to write but required by the standard's stable-phase and zero-decision rules.
