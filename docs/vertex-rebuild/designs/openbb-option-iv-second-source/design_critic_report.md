# Design Critic Report — `openbb-option-iv-second-source/plan.md`, FeatureRange (lines 1–235)

Mode: REVIEW. Standard: feature-spec-standard. Persona applied verbatim. All findings verified against baseline code, the pinned `yfinance==0.2.66` source in the uv cache, and the real research-snapshot store on this rig. Read-only; no files touched.

## Standard compliance summary

Problem statement, goals/non-goals, architecture, alternatives (5, with concrete trade-offs, no unlinked maintainer attributions), and risks sections are all present. The spec passes the Alternatives Rule structurally. The failures below are factual/behavioral: several load-bearing claims are contradicted by the baseline code or by measured data, and two failure modes degrade *worse* than today contrary to the plan's central guarantee.

---

## 🔴 Blocker

### B1. Yahoo slowness (not refusal) breaks the "degrades to today's behavior" guarantee: job deadline → `failed` unit every hour, no backoff

- **Scope**: plan.md:173–175 ("even with retries per symbol it stays far inside the budget"), 196–198, 221–224; `services/openbb/vertex_openbb/upstream.py:38` (`CALL_TIMEOUT_S = 90.0`), `cli.py:33` (`DEFAULT_DEADLINE_S = 240.0`), `cli.py:340–344` (deadline with `sources_ok == 0` → `EXIT_UPSTREAM`, no `blocked` key), `scripts/openbb/tick.ts:670` (records `failed`), `infra/openbb/rig/vertex-openbb.steps:15` (hourly, 420 s step).
- **Problem**: The plan budgets only the measured Saturday case (20 s). The architecture wraps **one helper call per symbol** containing up to 30 sequential HTTP fetches. Each helper has a 90 s cap; 7 × 90 s = **630 s > 240 s job deadline**. yfinance's own path makes slowness likely under degradation: every HTTP ≥ 400 triggers a cookie-strategy switch plus a fresh cookie/crumb round-trip and a full request retry (`yfinance/data.py:419–427`), and each request has a 30 s default timeout (`data.py:370`). If Yahoo is slow rather than refusing, the job-level `asyncio.wait_for` fires before any source completes → exit 3, run recorded `failed` (not `blocked_upstream`), **no blocked backoff applies** (backoff keys off `blocked` only, tick.ts:324–343), and the unit fails hourly — precisely the fault the predecessor design (`openbb-blocked-upstream/plan.md`, Goals 1/5) was built to remove. The acceptance case at 196–198 covers only clean 429 refusal; the risk bullet at 221–224 claims "On failure the run stays blocked (today's state)" which is false for the timeout path. Note the CFE-pattern `ctx.failed(source, cboe_error)` *does* preserve blocked for in-job helper failures (verified: `context.py:72–77` appends the Cboe error's host/status; `cboe.py:127–156`) — the hole is exclusively the job-level deadline, which bypasses per-source accounting.
- **Suggested change**: Add an explicit cumulative Yahoo-fallback time budget (e.g. abort remaining Yahoo work after ~120–150 s and mark those symbols `ctx.failed(source, cboe_error)` so the run stays `blocked_upstream`), or a dedicated shorter per-helper timeout for the Yahoo call. State the worst-case arithmetic (per-request timeout × retries × expirations vs the 90 s helper cap and 240 s deadline) in the plan, and add a replay test with `ReplayUpstream(delay_s=…)` proving a slow-Yahoo run still records `blocked_upstream`, never `failed`.

---

## 🟡 Major

### M1. The rate-limit risk rests on a false volume equivalence: the "proven" research pattern is ~1 expiration per symbol, not the full chain

- **Scope**: plan.md:98–99 ("~716 requests/day, far below what the twice-daily research snapshot plus portal reads already send"), 221–223 ("same … request pattern as the twice-daily research snapshot, at a lower daily volume"); evidence: `~/.local/share/vertex/option-chain/2026-11-20/{173000Z,203002Z}/` each contain exactly **14 CSVs = 7 symbols × 1 expiration (2027-01-15) × 2 sides**; the plan's own Alternative 4 (line 213) concedes the research snapshot "only covers monthly expirations 30–75 DTE".
- **Problem**: The research snapshot sends ~14 chain requests/day (plus quote calls); the fallback sends ~179–186 per snapshot, up to ~5 snapshots/day (see M2) ≈ **900 requests/day — roughly 30–60× the proven pattern**, not "lower daily volume". The "portal reads" comparison is also void as headroom evidence: the plan itself measured the portal's raw-v7 method getting **429** (line 75), i.e. Yahoo is *already* refusing that access class from this rig. The chosen client's tolerance at 179-request bursts is unmeasured; the single Saturday pass (line 80–93) is one sample against a host that actively rate-limits this IP.
- **Suggested change**: Correct the comparison to the real research volume; state that full-chain burst tolerance is unproven; add a concrete throttle (inter-request spacing or per-snapshot request cap) and define the 429-during-snapshot behavior (partial chain → drop symbol vs summarize incomplete chain — an incomplete chain silently corrupts GEX/walls because they are sums over contracts).

### M2. While the fallback *succeeds*, no backoff exists: hourly full snapshots re-fetch the same closed session, and the plan's load math mislabels the regime

- **Scope**: plan.md:97–99 ("hourly retry while blocked … at most ~4 snapshots a day"), 223–224 ("no retry storm (the blocked backoff of the tick client applies)"); `scripts/openbb/tick.ts:526–532` (`statusOf`: warnings → `partial`), `tick.ts:324–343` (backoff only for `blocked` streaks), `infra/openbb/rig/vertex-openbb.steps:15` (`every_s 3600`, window 16:20–21:00 → up to **5** attempts: 16:20…20:20).
- **Problem**: The blocked backoff applies only when the run is `blocked_upstream` — i.e. when Yahoo *also* fails and no Yahoo load happens anyway. In the operating regime the feature exists for (Cboe blocked, Yahoo working), every run is `partial`, so **every hourly timer run performs a full ~180-request snapshot**, ~5/day, ~900/day, for weeks. After the first post-close snapshot these repeat runs upsert essentially identical rows (OI/volume are settled; quotes are frozen at the 16:00 close) — pure repeated load against a host that already 429s this rig. "~4 snapshots" is also off by one against the steps file.
- **Suggested change**: Skip the Yahoo fetch when a `partial` run already stored rows for the current session (the tick already reads `openbb.status` before running), or reduce the fallback cadence to once per session with hourly runs only re-checking Cboe. Restate Goal 3's bound for the *success* regime, which is the one that generates load.

### M3. A working fallback permanently silences the 7-day blocked-escalation alarm, masking our-side faults

- **Scope**: plan.md:131–133 (fallback run is always `partial`), 220–224; predecessor `openbb-blocked-upstream/plan.md` Goal 5 and its Risks ("a wrong URL or a lasting block does not stay silent"); `scripts/openbb/tick.ts:13–15, 350–351` (escalation fires only on `blocked_upstream` streaks).
- **Problem**: The predecessor design's only automated signal for a persistent Cboe outage — including a self-inflicted 403 (wrong URL, bad agent) — is the 7-day blocked-streak exit 1. With the fallback healthy, runs are `partial` forever; the streak never forms; the unit stays green while Cboe has been broken for months. The panel note says "Yahoo" but nothing escalates, and the plan does not list this lost signal as a risk.
- **Suggested change**: Add a persistent-degradation signal: e.g. the panel note names the fallback streak duration ("since <date>"), and/or the tick escalates once after N consecutive fallback days. At minimum, document the loss of the escalation guarantee in Risks & Mitigations.

### M4. Yahoo's sentinel IV ≈ 1e-5 passes every stated filter and can corrupt ATM IV, GEX, flip and walls while the row looks real

- **Scope**: plan.md:226–229 ("contracts with IV ≤ 0 are dropped as today", "the row validator bounds IV to [0, 10]"), 198 ("never to fake rows"); `options_math.py:70` (`iv > 0` is the only filter), `rows.py:127` (bounds apply to the *summary row*, not per-contract IV); measured in the rig's own recorded Yahoo payload `~/.local/share/vertex/option-chain/2026-11-20/203002Z/`: **220 of 2,225 contracts (9.9%) carry IV = 1.0000000000000003e-05**, including SPY 2027-01-15 P780 with OI 5,634, QQQ P740 OI 4,953, SLV P195 OI 3,920.
- **Problem**: The plan's stated mitigations do not touch these values: 1e-5 > 0 survives the drop rule, and [0, 10] bounds the output row, not the input. Mechanism: (a) if a sentinel lands on the nearest strike with both sides quoted, `atm()` (options_math.py:82–99) averages it with the real side and roughly **halves** that expiration's ATM IV, propagating into `atmIv30d` and the percentile history; (b) BSM gamma = carry·φ(d1)/(S·σ·√T) diverges as σ→0 for strikes near the forward — a single near-ATM sentinel with OI in the thousands produces a GEX/wall/flip value orders of magnitude off, stored as a normal `partial` row. In the measured sample the sentinels sit far from spot (where gamma underflows to 0 and delta pegs to ±1, polluting the `iv_at_delta` point set), but nothing in the design prevents case (a)/(b) on another session — and the plan explicitly claims the quirk is mitigated.
- **Suggested change**: Add a per-contract IV floor (e.g. drop IV < 0.01 as a quote placeholder, mirroring the existing ≤0 rule) in the Yahoo conversion, and state it in the risk bullet; add a replay fixture containing a sentinel-IV contract near ATM proving it is excluded. Optionally bound per-contract gamma as a second guard.

### M5. `asOf` from `regularMarketTime` is not "the same rule as Cboe": the shared date parser cannot read Yahoo's epoch integer, and silently falls back to today

- **Scope**: plan.md:140–141; `values.py:58–74` (`iso_date` accepts date/datetime/ISO/`YYYYMMDD` only — an epoch int like `1763672400` matches neither pattern → `None`), `cboe.py:208–212` (`_as_of` returns `today` on `None`); Yahoo v7 options `quote.regularMarketTime` is epoch seconds (yfinance converts it only in its fast-info path, `utils.py:865`, not in the options quote).
- **Problem**: Cboe's `last_trade_time` is an ISO string; Yahoo's field is an integer. Reusing `_as_of` unchanged silently stamps every fallback row with `ctx.today`. On the normal weekday window that coincides with the session, but on a holiday or weekend manual run (the acceptance run itself is planned "with Cboe still blocked", possibly any day) Friday's quote gets stamped as a non-session date, inserting phantom sessions into the percentile history — directly undermining Goal 4. The failure is silent because the `None → today` fallback is by design.
- **Suggested change**: Specify an explicit epoch→America/New_York conversion before `_as_of`, and a test pinning `asOf` to the quote's NY session date (not run date) for a weekend/holiday replay. State that a missing/unparseable quote time fails the symbol rather than defaulting to today.

### M6. The Cboe-vs-Yahoo level difference is unmeasured, and the "small against day-to-day range" claim is unbacked; after recovery the mix is unmarked

- **Scope**: plan.md:111–115 (comparison is against the *research Black-76 method*, "Against the Cboe exchange series … it cannot be measured exactly"), 135–138 ("~0.5-point level difference is small against the day-to-day IV range"), Goal 2 (note only while newest run used Yahoo), Goal 4.
- **Problem**: Two gaps. (1) The 0.5–0.6 vol-point figure is Yahoo-vs-Black-76, a third method; the Yahoo-vs-Cboe gap — the one the stored history actually mixes — is asserted "of the same order" with no evidence, while the stored Cboe rows through 2026-11-18 exist in `openbb_option_iv_daily` and would at least bound the session-over-session jump at the boundary. A persistent +0.5-point bias is *not* obviously small: SPY 30-day ATM IV frequently moves less than that per day, so a weeks-long fallback segment shifts percentile ranks systematically, not just adds noise. (2) The source note exists only while the *newest* run is fallback; once Cboe recovers, the panel shows nothing, yet the percentile keeps mixing the two segments indefinitely. "Recoverable from the run ledger" (131–133) is true in principle but no reader or query joins the ledger to the percentile.
- **Suggested change**: Measure the boundary jump against the last stored Cboe session and state it; replace "small against the day-to-day range" with the measured number or drop the claim. Decide explicitly how a post-recovery reader learns which dates are Yahoo (e.g. the note lists the fallback date range from the ledger even after recovery, or accept and document the permanent silent mix as a known limit).

### M7. The rig-rule scoping is an unverified authority assumption, and Alternative 3's rationale is internally inconsistent: the chosen client *does* impersonate a browser

- **Scope**: plan.md:10 ("no browser impersonation against the Cboe block (rig rule)"), 59–61, 75, 205–208 ("would need browser impersonation to work, which the rig rule forbids … and which we do not want to maintain"); evidence: `yfinance/data.py:81` — `requests.Session(impersonate="chrome")` via `curl_cffi` is the default session for every request.
- **Problem**: The plan re-scopes a standing rig rule ("no browser impersonation") to "against the Cboe block" without citing the rule's text or an owner decision, then rejects Alternative 3 partly *because* it needs impersonation — while the chosen path performs the same TLS-level Chrome impersonation against Yahoo, just inside a pinned library. The honest differentiator is maintenance burden and the existing pin, not the rule. If the rig rule is in fact host-agnostic, the chosen design violates it and the whole source choice collapses; the document must not rest that on an implicit reading.
- **Suggested change**: Quote the rig rule (or link the owner decision) showing it is scoped to evading the Cboe block, and rewrite Alternative 3's rejection as "same impersonation, but hand-maintained cookie/crumb code in the fetcher vs a pinned, hash-locked library already proven on this rig".

---

## 🟢 Nit

### N1. Request count is 186, not 179: the proposed call sequence re-fetches the first expiration, and `.options` discards the first chain

- **Scope**: plan.md:95–97, 151–152; `yfinance/ticker.py:309–312` (`.options` calls `_download_options()` and returns only the expiration keys — the first chain in the response is dropped), `ticker.py:87–98` (`option_chain(date)` **always** calls `_download_options(date)`, even for the first expiration; nothing caches the first chain).
- **Problem**: "the first expiration comes with the list call" is false for the depicted sequence: `Ticker.options` + `option_chain(expiry)` for every expiry = 1 + n requests per symbol = **186 total**. To actually reuse the first chain the helper must call `option_chain()` (no date) for the first expiry instead of `.options`, or read the raw response itself.
- **Suggested change**: Fix the count and the diagram (use `option_chain()` for expiry #1), or state 186 and keep the simpler loop. Either way the bounded-load goal should carry the correct number.

### N2. "The exact conventions of `optionsChain`" is overstated for T

- **Scope**: plan.md:117–119 (`T = dte/365`); `packages/api/src/options-chain-greeks.ts:134–142` (`yearsToExpiry` measures to **16:00 New York on expiry day**, fractional ACT/365 — at the 16:20 run time T is ~0.014 y shorter than dte/365 for every contract); rate 0.04 verified at `options-chain-merge.ts:62`.
- **Problem**: Whole-day T vs intraday-to-close T changes short-dated delta/gamma slightly (largest at 1–7 DTE, where gamma matters most for walls). Also `trailingAnnualDividendYield` appears nowhere in yfinance's exposed surface (grep of the pinned source: zero hits) — it is a raw quote field the plan assumes is present in the v7 options `quote`; the "(0 when absent)" fallback quietly changes q for the dividend-paying ETFs.
- **Suggested change**: Say "same formula and rate; T uses whole days (dte/365), a stated approximation of the portal's to-close convention", and record whether the measured payload actually contained `trailingAnnualDividendYield` for SPY/QQQ/DIA/IWM.

### N3. `empty`-kind handling unspecified; the cited CFE pattern excludes it

- **Scope**: plan.md:158–160 ("any Cboe failure … `_settlement_fallback` runs on every non-empty failure"); `cboe.py:100–104` (`vx_curve` treats `kind == "empty"` as ok and does **not** fall back), `cboe.py:190–193` (`option_iv` today has no empty branch).
- **Problem**: The architecture's "blocked/failed → Yahoo" is ambiguous for `empty`/`not_found`. Following the CFE pattern literally means no fallback on empty; following "any failure" means falling back when Cboe legitimately reports no data.
- **Suggested change**: State the empty/not_found branch explicitly in the architecture diagram.

### N4. Mixed-run panel note should name the affected symbols

- **Scope**: plan.md:160–162 (mixed runs mark each Yahoo symbol in its own warning), Goal 2; `apps/web/src/features/openbb/view-model.ts:70–76` (the CFE pattern the plan copies is a single panel-wide string triggered by *any* matching warning).
- **Problem**: In a mixed run the panel-wide note implies all Core 7 rows are Yahoo while some are Cboe; the FeatureRange never says the note enumerates symbols.
- **Suggested change**: Specify that the note lists the Yahoo symbols (derivable from the per-symbol warnings) or says "some symbols".

### N5. Full-snapshot fixtures are large; trimming is specified for tests but not for recording

- **Scope**: plan.md:165–170 (one helper call per symbol returns all chains), 192–194 (tests replay trimmed payloads); measured 38,681 contracts × 14 fields ≈ 10+ MB of JSON per recorded snapshot.
- **Problem**: `RecordingUpstream` (`upstream.py:283–296`) records the full helper result; the plan's stable-key design commits multi-MB fixtures to the repo unless trimmed at record time.
- **Suggested change**: State that `tests/record.py` trims the Yahoo helper payload at record time (the `_trim_chain` pattern), not only at replay time.

### N6. "One upgrade decision covers both" hides two different `--exclude-newer` anchors

- **Scope**: plan.md:179–180, 230–232; `services/openbb/requirements-openbb-linux-py312.lock:2` (`--exclude-newer 2026-11-08`), `infra/option-chain/vertex-option-chain-run:13` (`--exclude-newer 2026-11-11`).
- **Problem**: The yfinance pin matches (verified 0.2.66 both sides; shared deps verified at identical versions: pandas 3.1.1, numpy 2.5.4, curl_cffi 0.17.0, requests 2.34.2 in both the lock and the runner env), but a future upgrade must move two different date anchors in two repos; the plan presents it as one decision.
- **Suggested change**: Note the two anchors and that an upgrade updates both compile commands.

---

## Claims verified as correct (no finding)

- **Blocked preservation via the CFE pattern**: `ctx.failed(source, cboe_error)` with the Cboe `UpstreamError(kind="blocked")` appends the Cboe host/status (`context.py:72–77`), so `all_blocked` → `blocked_upstream` holds even when Yahoo's own failure classifies as `error` (`classify`, `upstream.py:103–124`, cannot read yfinance's `YFRateLimitError` — `data.py:432` — but the CFE pattern passes the *Cboe* error, which sidesteps this). The plan's line 156 claim is sound for in-job failures; only the deadline path (B1) breaks it.
- **`partial` derivation**: warnings → `partial` (`scripts/openbb/tick.ts:526–532`); fallback always warns, so "never ok" holds.
- **CFE trigger pattern**: `_settlement_fallback` runs on every non-empty `UpstreamError` (`cboe.py:100–104, 127–156`) — matches plan 158–160 (modulo N3).
- **`summarize` unchanged compatibility**: 0-DTE exclusion (`options_math.py:181`), ATM mean of both sides (:82–99), per-side 25-delta interpolation (:102–119), gamma per $1 units match BSM (`options-chain-greeks.ts:80`), GEX formula (:142–146). OCC format of Yahoo `contractSymbol` matches the existing regex (verified in store CSVs).
- **Dependency claims**: curl_cffi 0.17.0, pandas, numpy, requests, beautifulsoup4, websockets, platformdirs already in the lock at the runner's versions; the five new pins named (multitasking, frozendict, peewee, protobuf, pytz) exactly match the runner env's dist-infos. yfinance 0.2.66 demonstrably runs against pandas 3.1.1/numpy 2.5.4 (2026-11-20 store runs completed, all 7 symbols, two runs that day).
- **Schedule/timeout constants**: `mon-fri@16:20-21:00`, 420 s step, 3600 s interval, 240 s default deadline (`infra/openbb/rig/vertex-openbb.steps:15`, `cli.py:33`); `--warm` exists and imports at install (`cli.py:228–245`).
- **Arithmetic**: 179 expirations and 38,681 contracts sum correctly from the per-symbol table.

**Bottom line**: the design is close to implementable and its core status/marking machinery checks out against the code, but it must not ship as written: B1 (deadline → failed-unit regression under Yahoo slowness) needs a bounded fallback budget, and M1/M2 (the load and rate-limit story is quantitatively wrong in the operating regime) plus M4 (sentinel IV passes every stated filter, with 9.9% incidence measured in the rig's own recorded payload) need concrete mitigations before the "bounded load, never fake rows, never worse than today" guarantees can be believed.
