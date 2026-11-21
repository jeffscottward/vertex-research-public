# Audit Report — Codebase Details Goldfish (Mode: REVIEW)

![EGM review overview: 9 goldfish reviewers, 3 blockers; this codebase audit raised A2 (impossible 1e-9 parity) and verified every file/symbol claim against the baseline, as summarized here](review-overview.png)

**Target:** `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md`, DetailedRange lines 236–320 (file is 320 lines; "Deploy order and revert" ends at 320, not 319).
**Standard:** implementation-readiness (zero-decision rule). **Baseline verified:** HEAD is exactly `3a9a353d` on branch `ws/second-source-for-the-core-7`; every "today" claim below was checked against that tree.

**Verdict: FAIL the zero-decision bar.** The skeleton is accurate — nearly every named file, symbol and mechanism exists and matches — but one test requirement is mathematically impossible as written, and several Phase-2/4 steps leave concrete implementation decisions open.

---

## Findings

### 🔴 1. BSM parity "to 1e-9" against the TypeScript `blackScholes` is impossible

- **Scope:** plan lines 262–263 (Phase 1 step 2) and 301–302 (`test_bsm_delta_gamma` "parity with the TypeScript formula's outputs").
- **Problem:** The TS reference uses the Abramowitz–Stegun 7.1.26 erf approximation with **documented absolute error below 1.5e-7**; delta is `carry * normalCdf(d1)` built on it. A Python implementation using `math.erf` (correct to ~1e-16) will disagree with the TS delta by up to ~1.5e-7 — three orders of magnitude above the mandated 1e-9 tolerance. The test as specified cannot pass, and an implementer who "fixes" it by copying the approximation into Python silently degrades the production greeks.
- **Evidence:** `packages/api/src/options-chain-greeks.ts:36` ("absolute error below 1.5e-7"), `:37-49` (erf polynomial), `:51` (`normalCdf`), `:84-100` (delta uses `normalCdf`).
- **Suggested change:** State that Python uses exact `math.erf`/`erfc`; pin cross-language parity at ≤ 2e-7 (the TS approximation bound), and keep the 1e-9 tolerance only for the known-value checks against an independent high-precision reference. Name where the TS comparison values come from (a checked-in table of `blackScholes` outputs, since Python tests cannot call TS).

### 🟡 2. "On Yahoo failure `ctx.failed` with the Cboe error" + "warning names both errors" — mechanism unspecified and contradicts the claimed CFE pattern

- **Scope:** plan lines 247, 272–273 (Phase 2 step 4), 295–296 (`test_option_iv_yahoo_failure_keeps_blocked` expects "warning names both errors").
- **Problem:** `ctx.failed(source, error)` emits exactly one warning containing only the passed error's message. Passing the Cboe error (required to keep the `blocked` classification) therefore never names the Yahoo error. The CFE precedent the plan claims to copy handles this with an **explicit extra `ctx.warn` naming the fallback failure before `ctx.failed(source, first)`**. The plan omits that step, so the promised test fails as specified and the implementer must invent the warning text and call sequence.
- **Evidence:** `services/openbb/vertex_openbb/context.py:73-80` (`failed` warns only `error.message`, appends to `blocked` only for kind `blocked` with host+status); `services/openbb/vertex_openbb/jobs/cboe.py:141-148` (`_settlement_fallback` warns the CFE read error, then `ctx.failed(source, first)`).
- **Suggested change:** Specify the exact sequence: `ctx.warn(f"cboe chain {symbol}: yahoo fallback: {yahoo_exc.message}")` (or equivalent fixed text) then `ctx.failed(source, cboe_exc)`; state that the Yahoo error must NOT be passed to `ctx.failed` (a Yahoo `error`-kind failure would flip the run from `blocked_upstream` to `failed`, exit 3).

### 🟡 3. `asOf` from Yahoo `regularMarketTime` "the same rule as `last_trade_time`" is a silent no-op with the existing helper

- **Scope:** plan line 269 ("spot and quote time from the quote object"); depends on feature-range claim (line ~143) that `asOf` uses the Cboe `_as_of` rule.
- **Problem:** Yahoo's `regularMarketTime` is **epoch seconds** (the repo's own Yahoo adapter multiplies by 1000). The existing `_as_of` → `iso_date` accepts only date/datetime/ISO-string/`YYYYMMDD`; given an epoch integer it returns `None` and `_as_of` silently falls back to `today`. On the normal 16:20 window that happens to be right, but on a weekend/holiday manual run (exactly the deploy-check scenario at line 315, and the plan's own Saturday measurement) it stamps the wrong session. No conversion step is specified anywhere in the plan.
- **Evidence:** `packages/api/src/server/options-chain-yahoo.ts:57,147-149` (`regularMarketTime * 1000`); `services/openbb/vertex_openbb/values.py:58-72` (`iso_date`); `services/openbb/vertex_openbb/jobs/cboe.py:208-213` (`_as_of` falls back to `today`).
- **Suggested change:** Mandate epoch-seconds → America/New_York date conversion inside `yahoo_chains.fetch_symbol`/`contracts_of` (mirror the TS adapter), then apply the existing cap-at-today rule; add a test with a stale Friday quote run on Saturday.

### 🟡 4. `fetch_symbol` payload construction and `contracts_of` edge behavior are undecided (zero-decision violations)

- **Scope:** plan lines 246, 267–269 (Phase 2 step 3).
- **Problem:** (a) `ctx.up.helper` JSON-ifies the return via `jsonable`, which **stringifies anything it doesn't recognize** — yfinance returns pandas DataFrames for chains and a tuple for expirations; a naive `fetch_symbol` returning Ticker internals records `"   contractSymbol ..."` table text into the fixture. The plan never says `fetch_symbol` must build the plain `{quote: {...}, expirations: [...], chains: {...}}` shape itself (e.g. `df.to_dict("records")`, ISO expiry strings, which quote fields to keep). (b) `bsm_delta_gamma`'s behavior on invalid inputs (iv ≤ 0, years ≤ 0, negative dividend) is unspecified — the TS twin returns `null` and clamps negative dividend upstream. (c) The feature range says "contracts with IV ≤ 0 are dropped as today", but the Cboe parser **keeps** them with `iv=None` (they still count for OI/volume/GEX); `contracts_of` must decide drop-vs-keep and the plan gives contradictory guidance. (d) Who computes `as_of` — the job (via `_as_of`) or `contracts_of(payload, as_of)` — while step 3 also says quote time comes from the quote object.
- **Evidence:** `services/openbb/vertex_openbb/upstream.py:126-150` (`jsonable`, `return str(value)` at :150), `:231-240` (`helper`); `packages/api/src/options-chain-greeks.ts:61-70` (null on invalid, `dividendYield >= 0`); `packages/api/src/server/options-chain-yahoo.ts:138-142` (negative dividend → null); `services/openbb/vertex_openbb/options_math.py:63-75` (`iv if iv is not None and iv > 0 else None`, contract still appended).
- **Suggested change:** Pin the payload schema field-by-field (quote keys: `regularMarketPrice`, `regularMarketTime`, `trailingAnnualDividendYield`; contract keys: `contractSymbol`, `impliedVolatility`, `openInterest`, `volume`), specify DataFrame→records conversion in `fetch_symbol`, define `bsm_delta_gamma` → `(None, None)` on invalid inputs, negative dividend → 0, and iv ≤ 0 → keep contract with `iv=None` and `delta=gamma=None` (mirroring `parse_contracts`). Reuse opportunity: `options-chain-yahoo.ts` already encodes all these normalization rules; cite it as the conversion reference.

### 🟡 5. `record.py` change underspecified: without a new `trim()` dispatch branch the Yahoo payloads are never trimmed

- **Scope:** plan lines 249, 282–283 (Phase 4 step 6).
- **Problem:** `trim()` dispatches by key prefix; only `helper:cboe:options_chain:` routes to `_trim_chain`. A new `helper:yahoo:options_chain:<symbol>` key falls through to the generic list/dict passthrough — the full live payload (SPY alone ≈ 9,930 contracts × 30 expirations) lands in the fixture untrimmed, contradicting "2 symbols × ~5 expirations × strikes within 4% of spot". The plan names `_trim_yahoo` but never says to add the dispatch branch, which expirations to keep, or which fields to slim. Expiration choice is not cosmetic: `summarize`'s 30-day constant-maturity interpolation needs points bracketing 30 DTE — `_trim_chain` deliberately keeps the two nearest + both around 30 + one near 60; "~5 expirations" leaves that decision open and a wrong pick changes the fixture's `atmIv30d` semantics.
- **Evidence:** `services/openbb/tests/record.py:154-179` (`trim` dispatch), `:100-126` (`_trim_chain` expiration/strike selection), `:46` (ARGV records `--symbols SPY,GLD` — the "2 symbols" is already the recording universe, no new mechanism needed).
- **Suggested change:** Add explicit step: branch `key.startswith("helper:yahoo:options_chain:")` → `_trim_yahoo`; reuse `_trim_chain`'s expiration selection (2 nearest, bracket-30, near-60) and 4%-of-spot strike filter; whitelist the payload fields from finding 4; keep `quote` intact.

### 🟡 6. `test_bsm_delta_gamma` placed in `test_jobs.py` contradicts the repo's test layout

- **Scope:** plan lines 251, 262, 301.
- **Problem:** All `options_math` unit tests live in `services/openbb/tests/test_units.py` ("Unit tests: option math, value cleaning, row rules…", e.g. `test_iv_at_delta_and_atm`, `test_gex_flip_and_walls`); `test_jobs.py` is the fixture-replay/job suite. The Files table assigns the greeks math unit tests to `test_jobs.py`, and no home is named for `yahoo_chains.contracts_of` unit tests at all. A fresh implementer follows the table and splits the math suite across two files.
- **Evidence:** `services/openbb/tests/test_units.py:1,23-89`; `services/openbb/tests/test_jobs.py:1` ("Every job replayed from recorded real upstream payloads").
- **Suggested change:** Move `test_bsm_delta_gamma` (and add `contracts_of` conversion tests) to `test_units.py` in the Files table; keep only the four replay/behavior tests in `test_jobs.py`.

### 🟡 7. The exact `ivSourceNotice` panel sentence is never given

- **Scope:** plan lines 253, 277–278, 303–305.
- **Problem:** The marker constant text is pinned (`used the Yahoo option chain`), but the panel note is a separate, longer sentence (the `vxSourceNotice` precedent is a full literal explaining source, reason and method difference). The feature range only says "the note says this in one sentence"; tests must "pin the note" — pin which string? The implementer must invent user-facing copy, a design choice the standard forbids.
- **Evidence:** `apps/web/src/features/openbb/view-model.ts:71-77` (vx note literal); `apps/web/src/features/openbb/view-model.test.ts:346-356` (test pins the literal); `apps/web/src/features/openbb/openbb-panels.test.tsx:448-450` (exact-string assertion).
- **Suggested change:** Write the exact sentence in the plan (it must mention the Yahoo IV column, BSM greeks and that the percentile history mixes methods, per the feature range), and pin it in both TS tests.

### 🟢 8. "rows for every symbol" in the fallback replay test vs the 2-symbol recording universe

- **Scope:** plan lines 293–294.
- **Problem:** The recorded fixture runs `--symbols SPY,GLD`; "every symbol" could be misread as Core 7 (the acceptance at line 315 is the live 7-symbol check). Existing replay tests assert `{SPY, GLD}`.
- **Evidence:** `services/openbb/tests/record.py:46`; `services/openbb/tests/test_jobs.py:73-83`; fixture `tests/fixtures/upstream/cboe-option-iv.json` (argv `--symbols SPY,GLD`, 2 calls).
- **Suggested change:** Say "rows for both recorded symbols (SPY, GLD)".

### 🟢 9. Existing exact-array panel test not called out

- **Scope:** plan lines 254–255, 305.
- **Problem:** `openbb-panels.test.tsx:445-447` asserts the iv block's notices equal exactly `[blockedNotice]` for a `blocked_upstream` run. Appending `ivSourceNotice(runs)` keeps that green (null filtered), but the plan should say the test is **extended** with a partial-run case (and that ordering — blocked first, source second — is pinned by the array equality), not merely "renders the note".
- **Evidence:** `apps/web/src/features/openbb/openbb-panels.test.tsx:406-457`; null-filtering at `openbb-panels.tsx:226-227`.
- **Suggested change:** Name the extension of the existing test and the expected two-element array on a blocked-then-fallback sequence.

### 🟢 10. `--warm` edit site unnamed; exclude-newer dates differ between the two rigs' pins

- **Scope:** plan lines 248, 260–261; feature-range "same `--exclude-newer 2026-11-08`".
- **Problem/Evidence:** (a) The mechanism is verified — `warm()` imports `PROVIDER_MODULES` (`cli.py:102-124,228-246`), install runs `--warm` (`infra/openbb/rig/install.sh:79`), and `test_warm_reports_version` (`test_jobs.py:288-290`) covers it — but the plan should name the one-line edit: add `"yfinance"` to `PROVIDER_MODULES`. (b) The research runner pins `yfinance==0.2.66` with `--exclude-newer 2026-11-11` (`infra/option-chain/vertex-option-chain-run:13`), while the openbb lock regenerates at `2026-11-08` (`requirements-openbb.in:4-7`). The yfinance pin matches, but transitive closures can differ; "one upgrade decision covers both" is true only for the top-level pin. Worth one sentence.
- **Suggested change:** Name the `PROVIDER_MODULES` edit; note the two exclude-newer dates.

---

## Verified claims (all checked against the tree at `3a9a353d`)

| Plan line(s) | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 242–244 | `requirements-openbb.in`, `.lock`, `pyproject.toml` exist; lock regen command documented; `dependencies` list exists | ✅ | `services/openbb/requirements-openbb.in:4-7` (full `uv pip compile --generate-hashes --only-binary :all: --python-version 3.12 --python-platform x86_64-manylinux_2_28 --exclude-newer 2026-11-08T00:00:00Z …` command), lock header line 2, `pyproject.toml:9-20` |
| feature/246 | Heavy deps already locked; new pins = yfinance + multitasking, frozendict, peewee, protobuf, pytz | ✅ | lock: beautifulsoup4:225, curl-cffi:752, numpy:1401, pandas:1549, platformdirs:1708, requests:2227, websockets:2514; none of yfinance/multitasking/frozendict/peewee/protobuf/pytz present |
| 245 | `options_math.py` pure-math home; proposed `bsm_delta_gamma` signature fits module style | ✅ (proposed) | `options_math.py:1-4,174` |
| 247 | CFE pattern exists: `CFE_FALLBACK_NOTE` + `_settlement_fallback` on non-empty failure | ✅ | `jobs/cboe.py:28,99-103,127-152` |
| 252 | `OPENBB_CFE_FALLBACK_NOTE` mirror pattern in API contract; exported via barrel | ✅ | `packages/api/src/contracts/openbb.ts:118-123`; `packages/api/src/index.ts:124`; import in `view-model.ts:1-9` (`@darkfactory/api`) |
| 253 | `vxSourceNotice(runs)` pattern (newest run of job, `.warnings.some(includes(marker))`) | ✅ | `apps/web/src/features/openbb/view-model.ts:71-77` |
| 254, 277–278 | iv Block has a `notices` array; blocked notice null on partial run; null entries filtered | ✅ | `openbb-panels.tsx:338-340,226-227`; `view-model.ts:63-66` (`run.blocked === null → null`); `packages/api/src/server/openbb.ts:356-361` (blocked nulled unless status `blocked_upstream`) |
| 268 | OCC parse "via the existing regex" | ✅ | `options_math.py:31` (`OCC`), `:48-77` (`parse_contracts`) |
| 271–272 | `ctx.up.helper(f"yahoo:options_chain:{symbol}", ...)` key format matches convention; records as `helper:<key>` | ✅ | `jobs/cboe.py:194` (`cboe:options_chain:{symbol}`); `upstream.py:231-240` |
| 272 | Rows via unchanged `options_math.summarize`; gamma unit compatible | ✅ | `options_math.py:174` signature `(underlying, as_of, spot, contracts)`; `:145` gex uses gamma per 1 point × 100 × S² × 0.01; TS gamma "per $1" (`options-chain-greeks.ts:26-28`); 0-DTE exclusion `:180` |
| 284–285 | "existing trimmed Cboe payload" exists today for the offline Cboe-ok test | ✅ | `tests/fixtures/upstream/cboe-option-iv.json`: today 2026-11-08, argv `--symbols SPY,GLD`, two successful `helper:cboe:options_chain:*` results; document fixture 2 daily + 10 term rows |
| 249–250 | `record.py` writes both fixture files; trim hooks are the extension point | ✅ (hook location; see finding 5) | `tests/record.py:154-179,236-243` |
| 286 | TS fixture parse requires one document per job — re-recorded doc flows in automatically; inline variant avoids extra files | ✅ | `packages/api/src/openbb-server.test.ts:239-247,266-289` ("accepts every fetcher fixture document (one per job)"); Python side `test_jobs.py:48-51` (`test_every_job_has_fixtures`) and parametrized shared-fixture tests; per-table TS fixtures (`packages/api/src/fixtures/openbb/option_iv_daily.json` etc., consumed by `scripts/openbb/tick.test.ts:21-23`) are unaffected |
| 294, 316 | Fallback run status `partial` (warnings present), never ok | ✅ | `scripts/openbb/tick.ts:529-532` (`warnings > 0 → "partial"`) |
| 295–296 | All-blocked → exit 0, empty tables, `blocked` key | ✅ (given finding 2's error-kind caveat) | `cli.py` `document()` (blocked key iff `all_blocked`), `context.py:121-129`; `scripts/openbb/tick.test.ts:889-909` ("records blocked_upstream and exits 0") |
| 297–298 | ReplayUpstream raises on unrecorded call | ✅ | `upstream.py:330-332` (`LookupError`, wrapped to `UpstreamError` by `_call`/`classify`) |
| 303–304 | "null for the CFE marker" mirrors existing vx test shape | ✅ | `view-model.test.ts:346-356` |
| 306–307 | Existing deadline test survives: fallback inside per-symbol loop, deadline still cuts | ✅ | `test_jobs.py:548-550` (deadline 0.05 s, delay 0.02 s/call, 7 blocked Cboe keys → exit 3, empty stdout; with fallback the third call still crosses 0.05 s with `sources_ok == 0`, `cli.py:347-351`); default 240 s / `OPENBB_DEADLINE_S` at `cli.py:32-33`; 420 s step at `docs/vertex-rebuild/openbb.md:113` |
| 311 | `scripts/merge-pr` exists | ✅ | `scripts/merge-pr` |
| 312–314 | `install.sh <SHA>` holds tick-runner run lock; `uv pip sync` from lock; `--warm` at install | ✅ | `infra/openbb/rig/install.sh:3,20-28` (flock -w 600 on `~/.local/state/tick-runner/vertex-openbb/run.lock`), sync command ("removes strays"), `:79` (`--warm`) |
| 315 | `vertex-openbb-run` wrapper exists/installed | ✅ | `infra/openbb/rig/vertex-openbb-run.sh`; install.sh installs it to `~/.local/bin` |
| 318–320 | Revert: sync removes yfinance; blocked state returns; stored rows untouched | ✅ | sync-exact-lock semantics (install.sh comment + command); no schema change proposed |
| 288–289 | `openbb.md` has the CFE paragraph, UI paragraph and job-table row to mirror | ✅ | `docs/vertex-rebuild/openbb.md:44-51,113,387-390` |
| feature (risk) | Row validator bounds IV to [0,10] | ✅ | `services/openbb/vertex_openbb/rows.py:127,143-151` |
| feature | `num` tolerates jsonable's `"NaN"` strings (conversion reuse) | ✅ | `values.py:24-41` |

**Non-existent references:** none found — every file, symbol and command the plan cites as current state exists at the baseline. All new files (`yahoo_chains.py`, `_trim_yahoo`, `bsm_delta_gamma`, `ivSourceNotice`, `OPENBB_YAHOO_FALLBACK_NOTE`) are clearly marked as additions; not flagged.

**Summary:** 1 🔴 (impossible 1e-9 TS parity), 7 🟡 (fallback-failure warning mechanics, epoch `regularMarketTime`, payload/edge-case decisions, trim dispatch, test-file placement, unpinned panel copy), 3 🟢. Fixing findings 1–7 makes the plan executable without independent design choices.
