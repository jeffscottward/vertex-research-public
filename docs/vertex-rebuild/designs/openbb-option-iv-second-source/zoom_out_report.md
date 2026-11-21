# Zoom-Out Review: `openbb-option-iv-second-source/plan.md`

![EGM review overview: 9 goldfish reviewers, 3 blockers and 12 majors consolidated to 15 actions; this zoom-out review verified the plan's YAGNI spine and raised the deadline-envelope, greeks-parity and fixture-trim majors shown here](review-overview.png)

**Reviewer:** Skeptical Architect (Zoom Out Goldfish) · **Mode:** REVIEW · **Standard:** zoom-out-standard.md · Full 319 lines reviewed against all 8 baseline files.

## Verdict

**Pass with revisions — no redesign needed.** This is a disciplined, YAGNI-compliant plan. It solves the root problem (holes in the daily IV history during a weeks-long Cboe block), reuses the established CFE fallback pattern end-to-end, adds no schema, no config knobs, no speculative abstractions, and stays at the right altitude (module boundaries and data flow, not pseudocode). Context sufficiency is excellent: objective, motivation, measured load, and measured method discontinuity are all stated. Three Major findings are bounded corrections to claims the plan makes that the baseline code contradicts — none invalidate the architecture.

## Findings

### 🟡 Major 1 — Deadline math ignores the per-call timeout envelope; a slow Yahoo can resurrect the unit-failure the predecessor plan removed

**Lines 173–175, 196–198, 221–224, 306–307.**
The plan justifies the 240 s budget with the healthy-path measurement ("≈ 20 s … even with retries per symbol it stays far inside the budget"). Two problems:

- The design makes **one helper call per symbol** (lines 168–172), and `Upstream._call` wraps each call in `CALL_TIMEOUT_S = 90 s` (`upstream.py:38`). Worst case is 7 × 90 = 630 s, not 20 s. A Yahoo that *hangs* (throttling by delay, not instant 429 — plausible for the host that already 429s the plain client) burns 90 s per symbol; the 240 s deadline then hits with `sources_ok == 0`, which is **exit 3 → run `failed` → unit failed → unitheal** (`cli.py:348–350`; predecessor plan's outcome table). That directly contradicts the plan's degradation claims ("the run stays blocked", line 223; "degrades to today's behavior", lines 196–198) and reintroduces the exact fault `openbb-blocked-upstream` was built to remove.
- "even with retries per symbol" (line 174) references a retry mechanism that exists nowhere in the design. Speculative wording.

**Suggested change:** State the budget in terms of the timeout envelope, not the healthy measurement, and pick one cheap mitigation: e.g. a shorter timeout for the Yahoo helper call, or preserve the blocked classification when the deadline cuts a run whose Cboe sources were all blocked (one rule in the deadline path). Delete the undefined "retries" phrase. Also re-verify the claim that the existing deadline test "still passes" (lines 306–307): with the fallback in the loop, the slow-replay test now also issues Yahoo calls that are unrecorded (`ReplayUpstream` raises `LookupError`, `upstream.py:332`) — warning counts and per-call delay totals change, so the test needs re-recording, not just inherited.

### 🟡 Major 2 — The 1e-9 TS-parity acceptance criterion is unachievable and incentivizes porting a worse algorithm

**Lines 262–263, 301–302.**
Phase 1 requires `bsm_delta_gamma` outputs to match the TypeScript `blackScholes` "to 1e-9". But the TS implementation uses the Abramowitz–Stegun 7.1.26 erf approximation with **absolute error below 1.5e-7** (`options-chain-greeks.ts:36–48`). Python's natural implementation (`math.erf`) is near-exact; the two cannot agree to 1e-9. The only way to satisfy the criterion as written is to replicate the inferior approximation in Python — over-engineering driven by a bad test spec.
**Suggested change:** Pin Python against known analytic values at tight tolerance, and against the TS formula at 1e-6 (the TS approximation's own error bound), or compare against shared recorded vectors with the looser bound. One-line fix; keeps the simpler Python implementation.

### 🟡 Major 3 — Fixture trim contradicts the replay test's expectation

**Line 283 vs lines 293–294.**
Phase 4 trims the recorded fallback fixture to "**2 symbols** × ~5 expirations", but `test_option_iv_uses_yahoo_when_cboe_is_blocked` expects "rows for **every symbol**". With only 2 symbols recorded, the other 5 symbols' helper calls are unrecorded and raise — the test as specified cannot pass.
**Suggested change:** Keep all 7 symbols in the recording (trim expirations/strikes only — `_trim_chain` in `record.py:100` already shows the pattern), or run the replay test with `--symbols` limited to the recorded two and state that explicitly.

### 🟢 Nit 1 — `YAHOO_RATE = 0.04` names a model assumption after a source

**Lines 117–119, 246.**
This becomes the third copy of the fixed 4% rate (TS: `OPTIONS_CHAIN_RISK_FREE_RATE`, `options-chain-merge.ts:62`). Cross-language duplication is unavoidable, but naming it after Yahoo couples a shared model convention to one fallback source; a future source would mint a fourth constant. **Change:** name it neutrally (e.g. `RISK_FREE_RATE` in `options_math.py`, next to the other model conventions) and cross-reference the TS constant in a comment, exactly as the CFE marker constants cross-reference each other (`cboe.py:26–28`, `contracts/openbb.ts:120–123`).

### 🟢 Nit 2 — "Source recoverable from the run ledger" overstates precision under same-session upserts

**Lines 130–139.**
`openbb_option_iv_daily` upserts on `(asOf, underlying)` (`schema/openbb.ts:187`, `server/openbb.ts:1196`). With hourly runs in the window, a later run overwrites the same session's rows; and a later all-blocked run (empty tables) leaves earlier Yahoo rows stored while the newest run carries no marker, so the panel shows no source note over Yahoo-sourced rows. This matches the accepted CFE precedent (`vxSourceNotice` reads only the newest run), so no design change is warranted — but soften the claim to "recoverable from the newest row-writing run for that session" and accept the stale-row edge explicitly, as the predecessor plan did for VX.

### 🟢 Nit 3 — Load bound and "one upgrade decision" claims are slightly off

**Lines 97–100, 230–232.**
The window `mon-fri@16:20-21:00` with a 3600 s step (`vertex-openbb.steps:15`) admits **5** hourly runs (16:20…20:20), not "~4"; on fallback-success days there is no blocked backoff, so the bound is ~895 requests/day, not ~716. Still trivially below existing volume — just fix the number. Also, the openbb lock compiles with `--exclude-newer 2026-11-08` while the research runner uses `2026-11-11` (`vertex-option-chain-run:13`), so transitive pins can differ between the two environments; "one upgrade decision covers both" holds for the yfinance pin only. Say that.

### 🟢 Nit 4 — Missing alternative: the `openbb-yfinance` provider

**Lines 66–80, 200–217.**
The service already accesses every other upstream through OpenBB provider fetchers; a reader will ask why not `openbb-yfinance`. I verified it is the wrong choice — latest 2.1.0 requires `yfinance>=1.3` (conflicts with the proven 0.2.66 pin) plus `openbb-charting`, `pywry`, `fastmcp`, `openbb-platform-api` (GUI/router deps the lock's header explicitly excludes). One sentence in Alternatives Considered recording this rejection would close the reuse question permanently and defend the bespoke `yahoo_chains.py` module.

## What is over-built

**Nothing material.** No row-level source column, no backfill, no caching, no new status, no config surface, no retry framework — all correctly declined. The only speculative elements are wording, not code: the undefined "retries per symbol" (Major 1) and the impossible 1e-9 parity target that would force an erf approximation port (Major 2). The per-symbol trigger on *any* Cboe failure (line 160) is broader than Goal 1's "every chain blocked", but it is the simpler rule (CFE precedent) and the plan justifies it — correct call.

## What is reusable (verified in code)

- **CFE fallback pattern, end to end:** marker constant + pinned tests (`cboe.py:28`, `contracts/openbb.ts:123`), warning → `partial` status (`tick.ts:529–532` — the plan's "never ok" claim is correct), `vxSourceNotice` → `ivSourceNotice` (`view-model.ts:72–79`), one-line `notices` addition (`openbb-panels.tsx:339`). All exist as claimed.
- **`options_math.summarize` unchanged:** the `Contract` dataclass fields (iv/delta/gamma/OI/volume) are exactly what the Yahoo conversion will produce; gamma units match; 0-DTE exclusion and IV≤0 dropping already in place. Verified.
- **Record/replay machinery:** `ctx.up.helper` + `RecordingUpstream`/`ReplayUpstream` (`upstream.py`) and `_trim_chain` (`record.py:100`) cover the new fixture with zero new infrastructure. The one-helper-call-per-symbol granularity is the right simplicity trade for stable fixture keys — its only cost is the timeout envelope of Major 1.
- **OCC regex** (`options_math.py:33`), **`_as_of` capping rule** (`cboe.py:209–213`), **`--warm`** mechanism (`cli.py:228`), **hash-locked dep closure**: the plan's claim that only multitasking/frozendict/peewee/protobuf/pytz are new pins checks out against the lock and yfinance 0.2.66's actual metadata; the 0.2.66 release (2025-09-17) predates `--exclude-newer 2026-11-08`, so the regen resolves.
- **No existing Python BSM/scipy** in `services/openbb` (searched) — the new pure `bsm_delta_gamma` is justified, not reinvention; the TS `blackScholes` is the correct reference, at the correct tolerance (Major 2).

No architectural dead-ends: the warning-marker mechanism does not block a future source column, and deferring that column is the right YAGNI decision for this card.
