# Zoom-out review (Stage 5, inventive lens): bearish put-spread design

* **Reviewer:** Inventive Catalyst Goldfish (TRIZ lens), mode REVIEW
* **Target:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`, full file (FeatureRange 1-148, DetailedRange 149-189)
* **Date:** 2026-11-22
* **Severity breakdown:** 🔴 0 Blockers, 🟡 3 Majors, 🟢 4 Nits

All findings are advisory. Claims were checked against the worktree; file references are given with each finding.

## Summary

The design resolves most of its real contradictions well (breadth without a copy, statistical power without one-at-a-time trades, partial answers from the spread procedure). The main false compromise is temporal: three missing evidence streams (real QQQ flips, the 15:45 breadth value, live spread cost per width) are treated as "not testable until another card ships", although the system already observes each of them every session and then deletes or overwrites it. The second is that the decisive verdict (D5) comes from the least-verified component, an event-study script outside CI, while the parity-gated engine runs are only approximations.

## Findings

### 🟡 F1. Real QQQ flips are collected daily and then pruned, while the forward test waits for an unscheduled card

* **Affected lines:** 41, 58, 79-81 (pathway item 1), 136 (deploy order).
* **False compromise:** "QQQ flips exist only in `flow_gex` ... keeps 14 days" (line 41) and "A historical gamma-flip data set or new flip collection" as a non-goal (line 58) lead to "after card vertex-gamma-flip-sources fills `openbb_option_iv_daily.gamma_flip` ... the real-flip rule is a forward test" (line 81). The design accepts that real flips cannot accumulate until that card ships. Meanwhile `flow_gex` keeps writing a QQQ flip every collector run and deletes it after 14 days; each session of delay destroys one session of the forward test's only real input.
* **Evidence:**
  * `packages/api/src/server/flow-collect.ts:159-169`: `FLOW_RETENTION_DAYS` is already a per-table map; `flow_gex: 14`, while `flow_minutes`, `flow_large_trades` and `flow_net_drift` were raised to 730 by single-key edits (flow-control-signals plan-pr1, flow-streaming-tape plan).
  * `packages/db/src/schema/flow.ts:243-262`: a `flow_gex` row is one timestamp, symbol, ticker and about ten numerics (flip, walls, totals), keyed by (symbol, at).
  * No document for card `vertex-gamma-flip-sources` exists in the repository; it is referenced only by this design. The forward-test start date therefore has no owner or schedule.
  * Brainstorm M14 / C5 already asked for a prospective flip record; the design kept it out of scope.
* **Proposed resolution (Preliminary Action):** Keep the flips the system already computes. Either raise `flow_gex` to 730 days in the existing map (one key, the same pattern as `flow_minutes`), or persist one QQQ row per session at the 15:45 snapshot. Register the forward test against that source now, named as the vendor GEX flip (QuantData estimate), and switch to or compare with `openbb_option_iv_daily.gamma_flip` when the other card ships. This can be a separate one-line pull request so it does not widen this design's deploy set.
* **Secondary liabilities:** Storage growth in the flow database (small rows, but per collector run). Two flip definitions (vendor GEX estimate and the future OpenBB flip) must be tagged by source and never pooled in one test. Rolling the collector back to a 14-day version prunes the older rows (the same caveat already documented for `flow_minutes`). The change touches the flow collector, which is outside this card's subsystem.

### 🟡 F2. The 15:45 decision values are observed live and then overwritten or never stored, so conditions 3 and 4 stay untestable by choice

* **Affected lines:** 30-34 (rule checked near 15:45), 59 (non-goal: chain storage, calibration), 77 (D9), 82-83 (pathway items 2 and 3), 106-107 (spread procedure), 185.
* **False compromise:** D9 accepts condition 4 as "not testable" and pathway item 2 waits for "real option quotes for the backtest period (none stored)". D9 is correct for the model: the runner places both legs by delta and `widthSigma` × ATM IV × √T, so cost per width is close to invariant by construction (a structural property, not a contradiction). But the conclusion that condition 4 must wait for chain storage is a false compromise. The design builds `optionsChain.spread`, which prices exactly the rule's spread from live quotes at any time, and stores none of its answers. Similarly, the rule reads breadth at 15:45, but the breadth tick that runs at 15:45 writes an intraday row that the 16:20 final push replaces, so the 15:45 value of condition 3 is lost every day.
* **Evidence:**
  * `docs/vertex-rebuild/breadth-90.md:43`: intraday ticks at 15:30 and 15:45, final at 16:20 and 17:00; `packages/db/src/server/breadth-90.ts:20, 287-288`: a final push replaces the intraday row for that date.
  * `packages/api/src/server/options-chain.ts:37, 260-286`: the chain read is cached 60 s, so one extra read per day costs almost no quota.
  * The design's output schema (line 155) already contains everything a daily record needs: quotes, model, `modelVsMidPct`, `quoteTime`, `spot`.
* **Proposed resolution (Preliminary Action plus Self-Service):** A daily 15:45 forward-evidence row for QQQ (one row per session, not chain storage): the rule's spread re-struck by `optionsChain.spread` (debit at mids and worse sides, width, cost per width, `modelVsMidPct`, leg quote times), the intraday `up_pct` with its `sourceAsOf`, and the flip from F1. This turns D9 and pathway items 2 and 3 from "blocked by another card" into evidence that accumulates from tomorrow: condition 4 gets a real distribution, `modelVsMidPct` per day is calibration input for card vertex-option-model-calibration, and the gap between 15:45 values and final closes measures the cost of the engine's next-session entry (item 3). The recorder can be a timer step next to the existing 15:45 breadth tick; it needs no change to either engine.
* **Secondary liabilities:** One more scheduled job on a host to monitor; a silent failure leaves gaps that look like "no signal", so it needs a staleness check. Results take months. Quotes recorded at 15:45 carry the vendor's quote quality (crossed or stale legs must be stored with their reasons, not dropped). It edges toward the "option chain storage" non-goal; keep it to one structured spread row per session to stay clear of it.

### 🟡 F3. The authoritative verdict comes from the least-verified component

* **Affected lines:** 72-73 (D4, D5), 76 (D8), 124 (event study), 142-143 (alternatives), 175 (tolerances), 178-180 (testing), 186-187 (limitations).
* **False compromise:** The design splits evaluation from execution (good, it resolves the power problem of brainstorm B2). But it then accepts that exactness and verifiability cannot coexist: the engine runs are parity-gated (1e-6 between the Nautilus and TypeScript runners), CI-tested and stored, yet approximate the rule (next-session entry, `exitDte` in calendar days, one spread at a time, and hold-to-expiry settles at intrinsic without closing costs per `packages/api/src/options-engine/book.ts:6-14`, whereas the owner rule closes at 15:45 on expiry day). The event study is exact and carries the D5 verdict, but it is "a script in the job report folder ... analysis, not product code" that reads database exports. The Detailed Implementation table and the tolerance line list no test or tolerance for it. A bug in the event study changes the pass or fail decision without tripping any gate.
* **Proposed resolution (Extraction, with a reconciliation gate):** Keep the event study out of product code, but bind it to the verified engine before it is allowed to produce D5. Give the script an engine-emulation configuration (next-session entry, `exitDte` 3 in calendar days, one spread at a time, expiry settlement as the engine does it) and require per-trade agreement with the stored `BEAR_PUT_EXIT3` / `BEAR_PUT_LONG_EXIT3` ledgers (same entry dates, strikes and expiries; prices within a fixed tolerance stated next to line 175) before switching to the owner configuration (same-session pricing, trading-day exit, 15:45 expiry-day close with costs, overlap allowed). The owner rule then sits a few named toggles away from a configuration that matches a parity-gated ledger, which is the "derived view over stored marks" idea of brainstorm C1 made checkable. Record the script's commit, the export digests (the runs already carry `seriesSha256`) and the reconciliation result in the job report.
* **Secondary liabilities:** More harness code and a second pass over the data. The reconciliation will expose benign differences (calendar edge cases, rounding) that need triage before the verdict can be issued. It is still not a CI gate; it raises confidence for this one study only.

### 🟢 F4. Roll-forward-only deploy is accepted as a consequence of a duplicated allow-list

* **Affected lines:** 111-112, 136, 164-166.
* **False compromise:** "The series id is roll-forward only: older worker code refuses runs that read it" is presented as a fixed law. It follows from the worker re-validating series ids against its own hardcoded tuple (`services/research/nautilus_backtest/signals.py:115-122, 954, 1183`) even though the API is the validator of record and already ships the series rows with the claim (`packages/api/src/server/backtest-runs.ts:284-293`). The planned pytest keeps the lists equal but does not remove the deploy coupling.
* **Proposed resolution (Inversion):** Make the worker's list derived rather than parallel: a manifest generated from `STRATEGY_SERIES_IDS` and committed, or have the worker accept any id that is present in the claim's series payload and matches the id syntax, keeping its strict checks for expression shape. A new virtual series then needs no worker-first deploy.
* **Secondary liabilities:** The Python mirror loses part of its independent check of TypeScript-side mistakes; a generated artifact must be kept fresh by CI. qc_ports `data.SERIES_IDS` stays separate either way (brainstorm B3). Rated a Nit because the deploy order is documented and the parity test is planned.

### 🟢 F5. The academy phase inherits blocking claim waits without its own budget or skip rule

* **Affected lines:** 100, 128.
* **False compromise:** Serializing academy requests is forced by the API ("a new one replaces the older queued Academy runs of this user", `packages/api/src/server/academy.ts:256-257`), and the design accepts it correctly. What is left open is failure: each wait can last `CLAIM_WAIT_MAX_MS` (15 minutes, `scripts/engine-comparison-driver/driver.ts:97`), the instant phase has a 45-minute budget and stops on its first timeout, but the academy phase has no stated budget or skip rule. With the research worker down, two academy waits add up to 30 minutes before the sweep and campaign phases.
* **Proposed resolution (Beforehand Cushioning):** Give the academy phase its own deadline and skip the remaining academy requests after the first claim timeout, with one log line naming the reason.
* **Secondary liabilities:** Some days have no academy comparisons, so G4 ("after its next daily run") can slip by a day when the worker is down.

### 🟢 F6. The spread procedure mixes a live spot with a stored IV close without saying how old the IV is

* **Affected lines:** 106-107, 155.
* **False compromise:** Using "the latest stored close of the symbol's IV index" keeps the model identical to the backtest model, which is the point of the model part; at 15:45 that close is the previous session's. The trade-off (parity with the backtest model versus a live model) is real, but the output schema does not echo the as-of dates of the IV index and IRX, so a reader cannot tell a one-day-old input from a week-old one (for example after a missed daily load).
* **Proposed resolution:** Keep the parity model, and add `ivIndexDate` and `rateDate` (or one `modelInputsAsOf`) to `OptionsSpreadOutputSchema`, with a `modelUnavailable` reason when the stored close is older than a stated limit. `modelVsMidPct` then reads as a calibration signal with a known input age.
* **Secondary liabilities:** Two more fields in the contract and the OpenAPI artifact; a staleness limit to choose and test.

### 🟢 F7. Name what the D5 verdict can prove

* **Affected lines:** 70, 73, 84.
* **Observation (not a false compromise):** Window B drops condition 3 because breadth starts in 2022-11; conditions 1 and 2 use the SMA20 proxy; condition 4 cannot move in the model. These are data invariants, not compromises to eliminate. The D5 "pass" therefore proves at most the price-proxy core of the rule (SMA20 cross plus the SMA200 exit), not the consult's rule.
* **Recommendation:** State the verdict's scope with that name ("price-proxy core") in D5 and in the run names, next to "SMA20 proxy". No pattern change needed.

## Checked, no false compromise detected

* **Breadth without a copy (lines 108-112, 140-141):** the virtual registry in the package that owns both tables is an Intermediary that already resolves "single source of truth versus one series contract". `packages/db/src/server/virtual-daily-series.ts` reads final rows in place.
* **Statistical power versus one spread at a time (lines 72, 143):** separating the event study (edge) from the ledger (equity and drawdown) resolves it; the block bootstrap is the right cost to pay.
* **`widthSigma` instead of `shortDelta` (lines 120, 142):** with σ√T-scaled widths and constant skew, the short leg's delta stays close to 0.25 across regimes, so no fidelity is given up in the model.
* **Partial answers from `optionsChain.spread` (line 107):** each part may be null with a reason while the other returns; this is Beforehand Cushioning already in place.
* **Not submitting the definition daily (line 147):** the 1e-6 gate checks each submitted run; a daily resubmission would add stored runs without new information.

## Ideal Final Result

The design delivers its four items unchanged in scope, and the system starts collecting the evidence the rule needs as a side effect of work it already does: the collector keeps the QQQ flips it computes, a 15:45 row records the re-struck spread and the intraday breadth, and the event study issues its verdict only after it reproduces a parity-gated engine ledger. The real-flip forward test then needs no further design, and the calibration card starts with months of `modelVsMidPct` data.
