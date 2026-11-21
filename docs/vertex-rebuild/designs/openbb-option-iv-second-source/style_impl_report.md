# Style Goldfish — REVIEW report (Implementation Plan range)

![EGM review overview: 9 goldfish reviewers, 15 consolidated actions; this style review's test-file, fixture and deploy wording findings folded into A4/A12/A14 shown here](review-overview.png)

**Target:** `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md`, DetailedRange lines 236–319 (`## Implementation Plan`, `### Tests`, `## Deploy order and revert`). Persona applied verbatim; ASD-STE100-style simplified technical English used as the working standard (one instruction per sentence, defined terms, active voice, no vague verbs). All identifiers, paths, numbers and commands below were checked against the baseline files; claims marked verified were confirmed in code.

No 🔴 Blockers. 6 🟡 Major, 15 🟢 Nit.

---

## 🟡 Major

**M1 — Lines 251, 301–302: greeks unit tests assigned to the wrong test file; `test_bsm_delta_gamma` has no home file.**
The Files table puts "greeks math unit tests" in `services/openbb/tests/test_jobs.py`, but the repo keeps `options_math` unit tests in `services/openbb/tests/test_units.py` (verified: `test_iv_at_delta_and_atm`, `test_gex_flip_and_walls`, `test_same_day_expiration_is_left_out` all live there). The Tests bullet `test_bsm_delta_gamma` names no file, so the two statements cannot both be executed as written. The same table cell also compresses five test scenarios into arrow shorthand that duplicates the Tests section.
*Rewrite:* Files row `test_jobs.py` → "add the fallback tests listed under Tests". Add a Files row: `services/openbb/tests/test_units.py` | "add `test_bsm_delta_gamma`". Tests bullet → "`test_units.py`: `test_bsm_delta_gamma` — known-value checks …".

**M2 — Lines 284–285: "Re-record" contradicts the parenthetical and the stated world state.**
"Re-record the Cboe-open path … (the existing trimmed Cboe payload)" gives two incompatible instructions: a fresh live recording versus reuse of an existing payload. A live Cboe-open recording is also impossible under the plan's own premise (Cboe blocked). Uncalibrated instruction — CALIBRATE to the reuse actually intended.
*Rewrite:* "Keep the existing trimmed Cboe payload as an inline upstream fixture variant in the test, so the 'Cboe ok → no Yahoo call' test stays offline."

**M3 — Lines 293–294: "rows for every symbol" conflicts with the two-symbol fixture trim.**
Step 6 (line 283) trims the recorded fixture to 2 symbols, but this test replays that fixture and asserts "rows for every symbol". Read literally against the Terms section ("Core 7"), the assertion demands 7 symbols from a 2-symbol recording; the other 5 helper keys would be unrecorded and `ReplayUpstream` raises on them (verified, `upstream.py:332`).
*Rewrite:* "replay the recorded fallback fixture with the fixture's symbol list; rows for every symbol in the fixture, warning contains the exact marker, status `partial`, no `blocked` key."

**M4 — Line 301: "put/call symmetry" is mathematically imprecise and invites a false assertion.**
BSM deltas are not symmetric: call delta − put delta = e^(−q·T); only gamma is equal across sides. A tester following "symmetry" literally could assert delta_put == delta_call and write a wrong test. Line 302's "the TypeScript formula" should also name the function and tolerance already fixed in Phase 1.
*Rewrite:* "known-value checks (ATM, deep ITM/OTM, the put/call delta relation call delta − put delta = e^(−q·T), equal put/call gamma, the zero-dividend limit) and outputs equal to `blackScholes` within 1e-9."

**M5 — Lines 306–307: "The existing deadline test … still passes" is an unverified prediction about a test whose inputs change under this plan.**
The matching test is `test_deadline_with_only_blocked_sources_exits_3` (`test_jobs.py:548`); it records only blocked Cboe keys. After this change each blocked symbol attempts a Yahoo helper call, which that recording does not contain — `ReplayUpstream` raises `LookupError` on an unrecorded call (verified). "Still passes" outruns the evidence, and "the deadline still cuts it" has an ambiguous "it" (the loop? one symbol's fallback?). CALIBRATE: state a requirement and the required fixture update, not a predicted outcome.
*Rewrite:* "Keep the deadline behavior: update `test_deadline_with_only_blocked_sources_exits_3` to record a Yahoo error for each blocked symbol, and assert the same exit 3 and stderr text. The deadline check must stay ahead of each symbol so the fallback cannot overrun the budget."

**M6 — Line 282: "Cboe is blocked now" is an unanchored time claim in a future-tense step.**
The plan's header defines every "today" statement as baseline commit `3a9a353d`; "now" inside an implementation step instead refers to execution time, which the plan cannot know. CALIBRATE to the measured date. Also "~5 expirations" is an approximate spec for a deterministic fixture.
*Rewrite:* "Record the new `cboe-option-iv` fixture live (Cboe is blocked as of 2026-11-21, so a live recording on that date captures the fallback path); trim to 2 symbols × up to 5 expirations × strikes within 4% of spot."

---

## 🟢 Nit

**N1 — Line 243: "(documented command)" is a dangling reference.**
The command exists (verified: header of `requirements-openbb.in`, `uv pip compile … --exclude-newer 2026-11-08T00:00:00Z`), but the cell does not say where.
*Rewrite:* "regenerate with the `uv pip compile` command in the `requirements-openbb.in` header".

**N2 — Line 245: "(pure)" is undefined jargon for a fresh reader.**
*Rewrite:* "(no I/O)".

**N3 — Line 246: "yfinance access" is vague.**
*Rewrite:* "new module: the yfinance fetch helper and the payload-to-contract conversion; `YAHOO_RATE = 0.04`".

**N4 — Lines 247, 288: "(CFE pattern)" / "(the CFE paragraph's pattern)" name a pattern without a target.**
The precedent is defined in the FeatureRange but the DetailedRange should stand alone; the code symbol exists (verified: `_settlement_fallback`, `jobs/cboe.py:127`).
*Rewrite (247):* "`YAHOO_FALLBACK_NOTE`; `_yahoo_fallback` in `option_iv`, modeled on `_settlement_fallback` in the same file". *Rewrite (288):* "a second-source paragraph modeled on the CFE paragraph".

**N5 — Line 250: second fixture path is relative while every other row uses repo-root paths.**
`tests/fixtures/cboe-option-iv.json` resolves only if the reader guesses the `services/openbb` prefix.
*Rewrite:* "`services/openbb/tests/fixtures/upstream/cboe-option-iv.json`, `services/openbb/tests/fixtures/cboe-option-iv.json`".

**N6 — Line 255: "pin the note and its absence" is compressed and ambiguous ("pin … absence").**
*Rewrite:* "assert the exact note text when the marker is present and no note when it is absent".

**N7 — Lines 260–261: "works" and "passes" are vague success criteria.**
The observable output exists (verified: `cli.py:245` prints `warm: ok <version>`).
*Rewrite:* "Add the pin, regenerate the lock, then verify `uv pip sync` completes in a scratch venv and `--warm` prints `warm: ok <version>`."

**N8 — Lines 262–263: verbless sentence; unscoped parity claim.**
"`bsm_delta_gamma` in `options_math.py` + unit tests …" has no verb, and "same inputs, same outputs to 1e-9" implies all inputs, while `blackScholes` returns null outside its domain (verified: positive spot/strike/years/volatility required, `options-chain-greeks.ts:57–69`). CALIBRATE the parity scope.
*Rewrite:* "Implement `bsm_delta_gamma` in `options_math.py`. Test it against known values and against `blackScholes` in `packages/api/src/options-chain-greeks.ts`: for inputs in the `blackScholes` domain (positive spot, strike, years and IV), outputs must agree within 1e-9."

**N9 — Lines 267–269: two function specs stacked inside parentheticals; "the existing regex" unnamed.**
The regex is `options_math.OCC` (verified, `options_math.py:31`); `jobs/cboe.py` also contains other regexes, so "existing" alone is ambiguous. STE: one instruction per sentence.
*Rewrite:* "`yahoo_chains.py`: add `fetch_symbol(symbol)` — one helper call that returns the JSON payload. Add `contracts_of(payload, as_of)` — parse the OCC symbol with `options_math.OCC`, read the Yahoo IV, compute the BSM greeks, read OI and volume, and take spot and quote time from the quote object."

**N10 — Lines 270–273: one 4-clause procedural sentence; awkward "on a Cboe failure of one symbol".**
*Rewrite:* "In `option_iv`, when the Cboe call for a symbol fails: read Yahoo through `ctx.up.helper(f\"yahoo:options_chain:{symbol}\", ...)`, build rows with `options_math.summarize`, and call `ctx.warn` with the marker. If the Yahoo call also fails, call `ctx.failed` with the Cboe error so the blocked classification is preserved."

**N11 — Lines 294–295: status names in plain text, inconsistent with line 316.**
Line 316 formats `partial` as code; lines 294–295 write "status partial" and "`blocked` present" mixed.
*Rewrite:* "status `partial`" (294); keep `blocked` as code and format "exit 0" consistently; no wording change beyond formatting.

**N12 — Lines 297–298: "the old Cboe payload" and "no Yahoo key requested" are imprecise.**
"Old" does not identify which payload; "key requested" describes an implementation detail loosely. The raise behavior is verified (`upstream.py:332`, `LookupError`).
*Rewrite:* "replay the inline Cboe payload from step 7; no Yahoo helper call is made (`ReplayUpstream` raises `LookupError` on an unrecorded call), and no marker appears in the warnings."

**N13 — Line 303: "iff" is logic jargon; "has the marker" omits where.**
*Rewrite:* "`ivSourceNotice` returns the note only when the newest `cboe-option-iv` run's warnings contain the marker; it returns null for a run with only the CFE marker and for an ok run."

**N14 — Lines 286–287: verbless step 8.**
*Rewrite:* "Run the Python tests (replay and synthetic edge cases), the TypeScript contract fixture test, and the web view-model and panel tests."

**N15 — Lines 312–314, 315, 318–320: deploy-section precision and one defensive caveat.**

- Line 313–314: "This is the openbb ingest unit, not a trading engine unit." — **DROP**. The Scope section already states "research data only … no order, execution, arming or risk path"; this sentence names no operator decision at this step and repeats the disclaimer. Also "`--warm` proves the import" → "`--warm` confirms the import" (plain verb).
- Line 315: "inside the window" — the window is defined only in the FeatureRange; "the document rows" — which document is unstated. *Rewrite:* "Live check: `vertex-openbb-run cboe-option-iv` inside the job window (`mon-fri@16:20-21:00`) or manually after it; verify the rows in the fetcher document, the warning, the stored run status `partial`, and the Markets panel note (headless Chrome on the rig, agent viewer account)."
- Lines 319–320: "the job returns to the blocked state" assumes Cboe is still blocked at revert time — CALIBRATE: "while Cboe remains blocked, the job returns to the blocked state". The "no data loss" clause is **KEEP** (backed by the concrete mechanism in the same sentence: rows stay stored and marked by run warnings); not reported as a finding.

---

## Verified-and-kept claims (no findings)

- Line 278 "the blocked notice, which is null on a partial run" — verified: `blockedNotice` returns null when `run.blocked === null` (`view-model.ts:63–67`); a partial run has no `blocked` key. KEEP.
- Line 295 "exit 0 … `blocked` present" — matches existing behavior (`test_every_source_blocked_upstream_is_exit_0_with_the_host`, `test_jobs.py:457`). KEEP.
- Line 298 `ReplayUpstream` raise-on-unrecorded — verified. KEEP (wording fixed in N12).
- Lines 311–313 `scripts/merge-pr`, `infra/openbb/rig/install.sh`, run-lock hold, venv sync adding/removing yfinance, `--warm` at install — all verified against `install.sh:51–79`. KEEP.
- All identifiers, pins and numbers in range (`yfinance==0.2.66`, `YAHOO_RATE = 0.04`, `bsm_delta_gamma(spot, strike, years, iv, rate, dividend_yield, is_call)`, `OPENBB_YAHOO_FALLBACK_NOTE`, `ivSourceNotice`, 1e-9, 4%, 240 s budget references) are consistent with the FeatureRange and the baseline code; no terminology drift found between the two ranges.
