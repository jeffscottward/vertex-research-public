# Comprehension Goldfish — REVIEW report

![EGM review overview: 9 goldfish reviewers, 15 consolidated actions; this comprehension review's undefined-term findings folded into action A13 (Terms expansion) shown in the consolidated flow](review-overview.png)

## What this proposes

While Cboe's delayed-quotes endpoint keeps returning HTTP 403, the daily `cboe-option-iv` job should stop producing empty, blocked runs for the seven ETFs (SPY, QQQ, DIA, IWM, GLD, SLV, USO) and instead fall back, per symbol, to Yahoo's option chain via the already-pinned `yfinance==0.2.66` client. Yahoo supplies its own implied-volatility column, open interest and volume; delta and gamma are computed locally with Black-Scholes-Merton (rate fixed at 4%, Yahoo's trailing dividend yield, ACT/365), matching the web app's existing greeks conventions. The fallback writes the same two tables with no schema change, emits a fixed-text warning ("used the Yahoo option chain") that forces run status `partial`, and surfaces a one-line source note on the Markets panel so readers know the newest IV rows come from a different model (~0.5 vol points above the mid-based method). The implementation adds the dependency pin, a pure `bsm_delta_gamma` function, a new `yahoo_chains.py` module, the fallback branch in the job, a mirrored contract constant and panel note in TypeScript, recorded/replayed offline test fixtures, and a docs update — deployed by a rig install script and revertible by reverting the merge and reinstalling the previous SHA.

## How the existing system works, per this document

A scheduled job (`cboe-option-iv`, window Mon–Fri 16:20–21:00 with hourly retry while blocked, 240 s job budget inside a 420 s "step" timeout) fetches each Core 7 symbol's full option chain from Cboe and reduces it, via `options_math.summarize`, to one `openbb_option_iv_daily` row plus one `openbb_option_iv_term` row per expiration; those rows feed the IV percentile, 25-delta IV, GEX, gamma flip and walls shown on the Markets page. Since before 2026-11-19 Cboe answers 403, so runs record `blocked_upstream`, write nothing, and the panel shows a blocked notice over stale rows. A "tick client" stores each run's warnings in a run ledger and `openbb.status` serves them to the web page; a sibling job (`cboe-vx-curve`) already has a "CFE settlement file" fallback pattern this plan copies. Separately, an `infra/option-chain` research snapshot runs twice daily on the same rig using the same pinned yfinance client and computes IV itself via Black-76 on parity-forward mids; its CSVs are off-limits to the app under an owner rule. Tests never touch the network: an upstream wrapper records real payloads into fixtures that a replay layer serves back, raising on any unrecorded call.

---

## Findings

**🟡 Major — "the rig" (lines 9, 11, 15, 68, 78, 187, 190, 312–317)**
The single most load-bearing noun in the document is never defined. A new reader cannot tell what the rig is (a dedicated machine? a VM? where does it live, who can access it, how do I run something "from the rig"?), yet the problem statement, all measurements, the acceptance check and the entire deploy section depend on operating it. *Suggested change:* one sentence in Terms ("the rig: the dedicated research/ingest host at …, accessed via …") plus a link to its setup doc.

**🟡 Major — "Card" / "the card" (lines 5–6, 44, 73, 134, 204)**
`vertex-openbb-option-iv-fallback` is cited as the authority for goals and rejections ("rejected by the card", "the card's acceptance reads…"), but the document never says what system holds cards, how to open one, or what "DarkFactory" (branch name, line 7) is. The goals are paraphrased inline, which helps, but a reader cannot verify the acceptance criteria against the source of truth. *Suggested change:* link the card ID to its tracker URL and state in one clause what the card system is.

**🟡 Major — "tick client" / "the tick" / "tick-runner run lock" / "run ledger" (lines 38–39, 98, 132, 223–224, 312)**
The scheduler/storage layer that runs jobs, stores warnings with runs, applies "blocked backoff", and holds a "run lock" during install is never introduced. Its behavior is asserted at four decision points (partial-status marking, retry volume bound, no-retry-storm mitigation, install safety) with no definition or link. Related: the two timeouts — "default 240 s budget" vs "step timeout (420 s)" (lines 173–175) — assume the reader knows what a "step" is in this scheduling model and why there are two nested limits. *Suggested change:* a Terms entry for the tick client (what it schedules, where run status/warnings live, what a step is, what the backoff does) or a link to its doc.

**🟡 Major — "the CFE pattern" / "CFE settlement file" / `cboe-vx-curve` / `_settlement_fallback` (lines 46–47, 126, 160–161, 247, 288, 304)**
The precedent is invoked six times as the justification for the design (trigger condition, warning marker, docs paragraph, test expectations), but CFE is never expanded, `cboe-vx-curve` is never described, and the pattern itself is only hinted at ("runs on every non-empty failure"). A fresh reader cannot say what is being copied. The architecture section does make the new mechanics reconstructible, so this is not a blocker — but the repeated appeals to an unexplained precedent are hand-waving. *Suggested change:* two sentences in Goals or Terms: what the VX-curve job's settlement-file fallback does and where it lives (file path or predecessor-plan section link).

**🟡 Major — "fetcher" / "fetcher document" / "document rows" / "document fixture" (lines 30, 38, 127, 195, 207, 316)**
The core data artifact — the "fetcher document" with its `warnings` array, `blocked` key (lines 294, 296) and rows — is never defined. Is it a JSON file, a database record, an API response? Where does it live and what is its shape? The Terms entry for "Run warning" references it as if already known. *Suggested change:* a Terms entry describing the fetcher document (producer, storage, top-level keys: rows, warnings, blocked, status).

**🟡 Major — record/replay test machinery: "upstream wrapper", "helper call", `ctx.up.helper`, `ReplayUpstream`, `_trim_chain` (lines 168–172, 193–195, 250–252, 270–272, 293–298)**
Goal 5 and all of Phase 4 rest on an offline replay architecture that is never explained: what the upstream wrapper is, what a "helper" call means versus a normal upstream call, why the fixture key `helper:yahoo:options_chain:<symbol>` is shaped that way, and what `ReplayUpstream` is (it appears only inside a test description, line 298). A newcomer cannot record or replay a fixture from this document alone. *Suggested change:* a short paragraph (or link to `services/openbb/tests/record.py` docs) describing the record→trim→replay flow and the helper-call convention before first use at line 168.

**🟡 Major — job context API: `ctx.failed`, `ctx.warn`, `ctx.take` (lines 156, 234, 271–273)**
The framework primitives the implementation is written against are used without definition. "The `ctx.take` pattern" (line 234) is cited as the mitigation for payload drift, but nothing says what `ctx.take` does (presumably: record a per-source failure without failing the job — the reader must guess). *Suggested change:* one-line definitions of `ctx.warn` / `ctx.failed` / `ctx.take` semantics, or a link to the context module's doc.

**🟡 Major — "the portal" / Vertex `optionsChain` / "portal adapter" / "control-plane" (lines 72, 99, 202–205)**
The web application and its `optionsChain` read are the main rejected alternative and the source of the greeks conventions this plan must match (line 118), yet neither "Vertex" nor "the portal" is introduced as the project's web app, and `optionsChain` is only characterized by table cells. "Adds a control-plane dependency to a rig timer" (line 72) assumes a control-plane/data-plane split that is never described. *Suggested change:* one sentence in Terms: "Vertex is the web app (apps/web + packages/api); `optionsChain` is its options-chain API read, sourcing Quant Data or IBKR."

**🟡 Major — "Quant Data" (lines 58, 72, 100, 202)**
A named paid provider whose quota is a hard constraint ("no Quant Data quota spend") is never identified beyond "paid quota shared with the portal". A new reader cannot tell what service this is or where the quota is managed. *Suggested change:* expand once ("Quant Data, the paid options-data vendor the portal's `optionsChain` uses") with a link.

**🟡 Major — "owner rule: no JSON/file data path" (lines 211–212) and "rig rule" (lines 11, 59, 206)**
Two institutional rules are cited as decisive authority with no link to where they are recorded. The rig rule's content is at least stated inline (no proxy/exit node/browser impersonation against the Cboe block); the owner rule's scope ("the app must not read local data directories") is only inferable from one alternative's rejection. *Suggested change:* link both rules to their canonical document (or the predecessor plan section that records them).

**🟡 Major — "agent viewer account" / headless-Chrome verification (line 317)**
Deploy step 3's verification assumes the reader knows what the agent viewer account is, how to authenticate as it, and how headless Chrome on the rig is driven. No setup step or link is given; this is an assumed workflow prerequisite in the one section a new operator must execute literally. *Suggested change:* link the rig verification runbook or name the tool/command used for the headless check.

**🟢 Nit — net GEX, "the gamma flip", "the walls" (lines 24, 120, 210, 215)**
Project-specific derived metrics are named as the reason gamma and OI are required, and their preservation is a rejection criterion for alternative 5, but they are never defined or linked. GEX is semi-standard jargon; "flip" and "walls" as computed panel features are not. *Suggested change:* a one-line gloss or link to the `summarize` docs.

**🟢 Nit — OCC symbol / "OCC parse via the existing regex" (lines 74, 153, 268)**
OCC is never expanded (Options Clearing Corporation contract symbology), and "the existing regex" has no file reference, unlike most other code pointers in the plan. *Suggested change:* expand the acronym once and name the module holding the regex.

**🟢 Nit — "flow" (line 72)**
Listed as a field the Quant Data read gives ("IV, delta, OI, flow") without definition; it is a project metric, not a standard chain field. *Suggested change:* one-word gloss (e.g., order-flow aggregates) or drop it from the comparison.

**🟢 Nit — "Black-76 on parity-forward mids" / "the full parity machinery" (lines 112, 213–214)**
Black-76 is a standard model, but the research snapshot's "parity-forward mid" method is project-specific and unlinked, yet it is the baseline for the headline "~0.5 vol points" claim. The `infra/option-chain` path is given, which partially mitigates. *Suggested change:* link the research snapshot's method description.

**🟢 Nit — IV percentile (lines 26, 52, 135–139)**
The continuity of this metric motivates the whole feature, but its computation (lookback window, where it is computed) is never stated, so the reader cannot judge the claim that a 0.5-point level shift is "small against the day-to-day IV range". *Suggested change:* state the window/method or link it.

**🟢 Nit — run-status vocabulary and the `blocked` key (lines 19, 132–133, 197, 294–296)**
`ok` / `partial` / `blocked_upstream` are explained piecemeal in context, but never enumerated as the status taxonomy, and the document-level `blocked` key (asserted present/absent in tests) is distinct from the `blocked_upstream` status with no explanation of the relationship. *Suggested change:* one sentence in Terms listing the statuses and the `blocked` key's meaning.

**🟢 Nit — "documented `uv pip compile` command" / `--exclude-newer 2026-11-08` (lines 178–179, 230)**
"Documented" where? The regeneration command is a required Phase 1 step but its documentation is not linked, and the significance of the 2026-11-08 cutoff date is unstated. *Suggested change:* link the doc that holds the command and say why that date is held.

**🟢 Nit — `scripts/merge-pr`, "CI green on the reviewed head", "openbb ingest unit, not a trading engine unit" (lines 311–314)**
The merge workflow script and the deployment-unit taxonomy ("ingest unit" vs "trading engine unit") are institutional shorthand with no description or link; the reader cannot know what merge-pr enforces or why the unit distinction matters for install safety. *Suggested change:* brief parenthetical for each, or a link to the deploy runbook.

**🟢 Nit — "cookie/crumb" (lines 97, 205)**
Yahoo's session-auth mechanism is referenced as known. A one-clause gloss ("Yahoo's cookie+crumb request-token handshake") or link would make the raw-endpoint rejection legible to everyone.

**🟢 Nit — schedule timezone and configuration location (line 98)**
`mon-fri@16:20-21:00` gives no timezone (New York is only implied later at line 140) and no pointer to where the schedule is configured. *Suggested change:* append "ET" and the config location.

**Not flagged (verified self-contained):** Core 7, Chain, Snapshot, Yahoo IV column, BSM greeks, Run warning (Terms, lines 29–39); the ATM rule (defined inline, lines 108–109); `--warm` (behavior stated, line 176); `asOf` derivation (lines 140–141); the greeks formulas and conventions (lines 116–118); request-count arithmetic (lines 96–99); predecessor-plan linkage for the non-goal claim (lines 5–6). No section resisted paraphrase, so there are no 🔴 Blockers; the document's internal flow (problem → measured source choice → method delta → marking → architecture → acceptance → phases → deploy/revert) connects coherently. The dominant gap pattern is a dense ring of undefined institutional infrastructure — rig, tick, card, CFE precedent, fetcher document, replay harness, portal — around an otherwise well-specified change.
