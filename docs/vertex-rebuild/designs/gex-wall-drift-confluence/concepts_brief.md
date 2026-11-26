# GEX wall × net drift confluence read

- **Author:** Jeff Scott Ward
- **Date:** 2026-11-25
- **Mode:** EGM BRAINSTORM (concept brief; no production code is changed by this document)

## Overview

The read grades a price touch of a dealer GEX wall. The call wall is the strike with the largest positive GEX, and the put wall is the strike with the most negative GEX. The grade uses two inputs:

- The gamma regime: spot above or below the gamma flip.
- The session net options premium drift over the last 15 minutes: QuantData one-minute signed net call premium and net put premium, cumulative since 09:30 New York.

The output is:

- `wall`: `call`, `put` or `none`.
- `regime`: `above`, `below` or `unknown`.
- `read`: `hold-A`, `break-risk`, `no-read` or `no-data`.
- `reason`: a text that says why.

Missing or stale inputs show `no-data`; they are never blank.

The read appears as a compact badge in two places:

- `/flow`: `flow.snapshot` GEX plus `flow.control` net drift.
- `/stock/[symbol]`: options analytics GEX plus `flow.control` net drift. Net drift is available only for SPY, SPX, QQQ and NDX, and only to operators.

A pre-registered study under `docs/specs/strategies/` will test hold and break rates at the walls by drift and regime. Its rules are frozen before any run.

Research only: nothing here places, changes or cancels an order.

> State of the worktree when this brief was written (branch `ws/vertex-gex-drift`, 2026-11-25 about 18:45). An implementation had already started before the brainstorm:
>
> - Untracked: `packages/api/src/gex-wall-drift-rules.ts` (+ test), `apps/web/src/features/flow/wall-drift-view-model.ts` (+ test), `apps/web/src/components/portal/wall-drift-badge.tsx`.
> - Modified: `flow-workspace.tsx`, `options-analytics-panel.tsx`, `options-analytics-client.ts`, `packages/api/src/index.ts`.
>
> The findings below were checked against that draft. Several of them change its input contract, so they must be settled before the rules are stamped `v1` and frozen.

## Reviewer Status

| Reviewer | Role title | Status |
| --- | --- | --- |
| `egm-design` | Skeptical Design Critic Brainstormer | completed |
| `egm-codebase-details` | Observability & SRE Brainstormer | completed |
| `egm-zoom-out` | Skeptical Architect Brainstormer | completed |
| `egm-comprehension` | UX & Ergonomics Brainstormer | completed |
| `egm-implementation-readiness` | Migration & Rollout Brainstormer | completed |
| `egm-structural` | Maintainability Brainstormer | completed |
| `egm-inventive-catalyst` | Inventive Catalyst Brainstormer | completed |

How the lenses ran:

- **No subagents.** This harness does not allow subagents. Two spawn attempts were refused at preflight with "spawns disabled for this agent".
- **Separate model calls instead.** Each lens ran as its own call with no tools and no history (`completion`, tier `slow`), with its persona file from `agents/` as the system prompt.
- **Shared evidence.** Because the lenses had no tools, the synthesizer read the repository first. It gave every lens the same 12 verified facts (E1–E12, listed in [Appendix A](#appendix-a-evidence-given-to-every-lens)) and the full text of the draft rule file.
- **Checking.** The synthesizer checked each lens claim against the code. Two claims were wrong; they are corrected in [Synthesizer corrections](#synthesizer-corrections).
- **Raw reports.** The raw lens reports were kept outside the repository and were temporary.

## Analysis

All seven lenses returned findings. Merged and deduplicated, there are 4 Blockers, 11 Majors and 4 Nits.

| Severity | Count | Findings |
| --- | --- | --- |
| 🔴 Blocker | 4 | B1 to B4 |
| 🟡 Major | 11 | M1 to M11 |
| 🟢 Nit | 4 | N1 to N4 |

### 🔴 B1. The touch is judged on a GEX snapshot price that can be 30 minutes old

**Raised by:** all 7 lenses.

**Problem:**

- `gradeGexWallDrift` uses `levels.spot` both to test nearness to a wall and to set the regime.
- On `/flow`, that value is `FlowGexSchema.spot`: the underlying price at the GEX snapshot (`contracts/flow.ts:555-556`).
- GEX is collected about every 14 minutes (`flow-pipeline.md:20`), and the draft accepts levels up to 30 minutes old.
- The near-wall band is 0.25%, which is about ±15 to 17 SPX points. Price often moves more than that in 15 to 30 minutes.
- The result: the badge can say "at the put wall" after price has left the wall, and it can miss a live touch.
- Meanwhile, the drift is judged on the newest settled minute, so the two halves of the read describe different moments.

**Resolution:**

- **Separate "where the walls are" from "where price is now".**
  - Walls and flip come from GEX, with its own `at`.
  - Price comes from the newest settled `underlyingPrice` of the same ticker's net drift series (`flow.control` `netDrift[].points`). The stored column is `flow_net_drift.underlying_price`. The vendor history carries `stockPrice` per minute back to 2025-01-02.
  - Touch, regime and drift are then judged at one settled minute, on one ticker and one price scale. No new data is needed.
- **Keep GEX `spot` as a scale check only.** Return `no-data` when |price − GEX spot| is larger than a frozen limit.
- **Return the inputs with the read:** `price`, `priceAt`, `levelsAt`, the wall strike, the signed distance in %, the flip used, and the ticker.

This changes the draft input contract (`GexWallLevelsInput`, `GexDriftPoint`), so it must be settled before the freeze.

### 🔴 B2. The study does not have enough GEX history for a verdict

**Raised by:** design, zoom-out, implementation-readiness, inventive, comprehension.

**Problem:**

- **Stored intraday walls are recent.** `flow_gex` starts 2026-11-08 for SPY and ES (migration 0052) and 2026-11-15 for QQQ and NQ (migration 0077). That is about 13 and 8 sessions as of 2026-11-25.
- **They are two series, not four.** SPY/SPX and QQQ/NDX are the same underlyings, so they give two clusters.
- **The sample is far too small.** Touches inside the band that also have a full drift window will number in the tens. Split by 2 walls × 2 regimes × the read, most cells will be close to empty.
- **The house method cannot run on it.** That method is a 60/20/20 split with 5-session gaps and a deflated Sharpe bar of 0.95. The earlier study (`flow-control-continuation.md`) used 463 sessions and still ended `no-edge`.
- **The long drift history does not help.** It cannot be joined to walls:
  - The OpenBB daily table starts about 2026-11-09, and its QQQ flip is empty.
  - The option-chain store holds Yahoo 30 to 75 DTE snapshots from 2026-11-11.
  - `/stock` GEX is fetched on demand and never stored.

**Resolution:**

- **Accrue forward.** The spec starts with status `accruing`. It sets an event-count stopping rule (a minimum number of touches per reported cell) and an earliest run date.
- **Add a distinct verdict.** `needs-more-data` is separate from `no-edge`, as in the earlier spec.
- **Use one source.** The study uses `flow_gex` levels only. Swapping in OpenBB, market-watch-bot or on-demand flips is forbidden, because they are different estimates.
- **The stored rows are already the ledger.** `flow_gex` and `flow_net_drift` are both kept for 730 days. Every `/flow` read can therefore be recomputed offline from stored rows, so no new read-log table is needed for the study.
- **Possible backfill (owner question Q3).** If the QuantData archive holds historical chain and open interest, walls could be rebuilt with `buildGexContext` for 2025 onward and checked against the live `flow_gex` weeks. This is not verified.

### 🔴 B3. Pre-registration is weakened before the spec exists

**Raised by:** design, codebase-details, structural, implementation-readiness, inventive, comprehension.

**Problem:**

- **Rules came before the spec.** The rule constants were written before any spec. The draft cites a design document and a spec, and neither exists yet.
- **Two constants come from the failed study:**
  - `windowMinutes: 15` is variant V1 of `flow-control-continuation`. V1 was positive over the whole period but did not count. Its window was chosen on 13 sessions that came with a selection-bias warning.
  - `risingShare: 0.3` equals that study's enter threshold.
- **The freeze misses the rules.** The earlier freeze (`SPEC_SHA256` of the spec text) does not cover TypeScript constants. Editing `risingShare` or `nearWallPct` would not stop the runner.
- **No outcomes are defined.** Nothing defines what a "touch" event is, or what "hold" and "break" mean. A definition needs a horizon, a tolerance and a close-through rule.

**Resolution:**

- **Embed and enforce the rules.** The spec embeds the full rules object as JSON. A unit test and the study runner both check that it equals `GEX_WALL_DRIFT_RULES` exactly, and the runner refuses to run on any difference.
- **Version on change.** Any change to a constant bumps the version and needs a new spec.
- **Record provenance.** The spec has a provenance table for every constant, including the V1 origin of the 15-minute window.
- **Count earlier trials.** The 10 trials of the earlier study count toward the deflation.
- **Define the event and the outcomes.** The touch event (first entry into the band, side of approach, cooldown) and the hold and break outcomes are frozen in the spec.
- **Version timing.** The draft is treated as pre-v1. The label `gex-wall-drift-rules.v1` is applied only in the commit that freezes the spec. The rules, the design document and the spec are committed together.

### 🔴 B4. On `/stock`, members would see a permanent `no-data` that looks like an outage

**Raised by:** all 7 lenses. Confirmed in the in-progress code.

**Problem:**

- **Access mismatch.** `/stock/[symbol]` is open to all members, but `flow.control` is `.use(requireOperator)` (`server/flow.ts:770-771`).
- **The draft gates on symbol only.** The in-progress `StockWallDrift` checks the symbol (`wallDriftGroupOf`) but not the account. A member viewing SPY therefore makes a request that always gets 403, and the badge renders `no-data` with the text "net drift not loaded: Forbidden".
- **Wrong text for non-operators.** Other symbols get "net drift is collected for SPY, SPX, QQQ and NDX only", which is the wrong cause for a non-operator.
- **Members must not receive drift-derived reads.** Net drift is vendor data for personal use (`flow-control-continuation.md`, Source). Putting a drift-derived read into a member-visible server response would leak operator-only data.

**Resolution:**

- **Render only where it applies.** Show the `/stock` badge only for an operator viewing SPY, SPX, QQQ or NDX. The web already knows operator status (`apps/web/src/lib/navigation.ts:399-457`, `server-session.ts` `operatorEmails`). Pass it to the page and do not call `flow.control` otherwise.
- **Keep "not applicable" apart from `no-data`.** Either hide the badge or show a fixed "not available for this account or symbol" state that is not styled as a failure. `no-data` is kept for inputs that should exist but are missing or stale. The "never blank" rule applies only where the read applies.
- **No extra fetches.** The badge reuses the panel's options-analytics response.
- **Rate limits get their own reason.** A rate-limited response (`rateLimited`, `retryAfterSeconds`) maps to `rate_limited`, with the retry time shown.

### 🟡 M1. No-data reasons are free text, and the freshness limits disagree with the source contract

**Raised by:** all 7 lenses.

**Problem:**

- **Free text loses the cause.** The draft returns free-text reasons. `flow.control` already has typed reasons with labels:
  - `market_closed`
  - `source_unavailable`, which is the QuantData 401 case
  - `storage_failed`
  - `stale`
  - `session_start`
  - `gap`

  These are in `flow-control.ts:181-204` and `describeSide`. With free text, a 401 outage, a storage failure and the 09:30 to 09:45 start look the same. After the close, the badge says "older than 10 minutes" instead of "market closed".
- **The drift age limit is twice the contract.** The draft uses `maxDriftAgeMinutes: 10`, while the contract `net_drift.maxAgeSeconds` is 300 (`contracts/flow.ts:60-63`). Between 5 and 10 minutes, the control panel says "stale" while the badge next to it still grades a read.
- **The GEX limit matches only by copy.** `maxGexAgeMinutes: 30` equals `gex.maxAgeSeconds` 1800 because it was copied by hand.

**Resolution:**

- **One typed code per read.** Add a `noDataCode` enum. It reuses the `flow.control` reasons word for word and adds:
  - `gex_missing`
  - `gex_stale`
  - `gex_no_spot`
  - `price_scale_mismatch`
  - `window_gap`
  - `zero_premium`
  - `rate_limited`
  - `not_entitled`
  - `unsupported_symbol`

  The reason text is built from the code.
- **Pass through the panel's status.** When the `flow.control` freshness row for the ticker is not `fresh`, the badge passes its reason through and does not recompute it.
- **Take the age limits from the contract.** Derive them from `FLOW_SOURCE_METADATA`, or freeze them in the rules with a test that checks how they relate to the contract.

### 🟡 M2. The drift window can span more than 15 minutes and does not match the slope already on the page

**Raised by:** all 7 lenses (one claim corrected below).

**Problem:**

- **The baseline can be older than 15 minutes.** `gexDriftWindow` takes the last point at or before newest − 15 min. After a 401 gap, that point can be 30 to 60 minutes old, but the reason text still says "in 15 min".
- **`buckets` counts points, not minutes.** A stretched window still passes `minBuckets: 10`.
- **Two "15-minute drift" numbers on one page.** The existing `slopeUsdPerMinute` (`flow-control.ts:399-419`) is one call-minus-put number divided by a fixed 15. The new read uses a share of gross premium for each side. The two can disagree on the same screen.
- **What is justified.** A separate call and put window is justified: the combined slope cannot tell put buying from call selling.

**Resolution:**

- **Return the window's extent.** The window returns `baselineMinute`, `newestMinute` and `actualSpanMinutes`.
- **Reject stretched windows.** A span over `windowMinutes` plus a frozen tolerance returns `no-data` with code `window_gap`.
- **Report the real span.** The reason text gives the actual span, not the nominal 15.
- **One window helper.** Put the helper next to the existing slope in `flow-control-rules.ts`. The server, the badge adapter and the study runner all import it.
- **Pin it with a golden test.** A golden-fixture test pins the live and study outputs.
- **Name it differently in the UI.** For example, "call / put premium, last 15 min", not "slope".

### 🟡 M3. The regime depends on which flip source is used, which is often far from spot

**Raised by:** all 7 lenses.

**Problem:**

- **The three flip sources disagree, by design.** On 2026-11-20, QQQ at 608.45 had flips of:

  | Source | Flip |
  | --- | --- |
  | OpenBB | 655.20 |
  | `flow_gex` | 674.34 |
  | market-watch-bot | 659.56 |

  All three are 8 to 11% above spot (`gamma-flip-sources/design.md`). `spot >= flip` then reads `below` almost all the time.
- **The two pages use different estimates.** `/flow` uses the stored `flow_gex` row, and `/stock` uses an on-demand `buildGexContext`. The same ticker at the same minute can read `above` on one page and `below` on the other.
- **"Regime" already means something else.** `/flow` already has `FlowGexSchema.regime` (`positive`, `negative`, `no_data`, `zero`) and a "GEX regime" factor in the confluence block. A third meaning of the same word would sit on the same screen.
- **It touches an existing non-goal.** The gamma-flip-sources design lists "any use of a gamma level as a trade trigger" as a non-goal.

**Resolution:**

- **Rename the field** to `flipSide` (`above`, `below`, `unknown`). The UI label is "vs gamma flip".
- **The study pins one source.** It uses `flow_gex` (S8).
- **Name the source.** The read carries `levelsSource` (`flow_gex` or `options_analytics`) and `levelsAt`. The `/stock` tooltip says it uses a source the study does not test.
- **Report regime reachability.** The spec reports the regime distribution for each ticker before any rate, and flags cells that cannot be reached.
- **Optional (Q2):** return `unknown` when |price − flip| is more than a frozen % of spot. Every added threshold counts as a trial.
- **Restate the scope.** The design document says the read is descriptive research context and not a trigger, consistent with the non-goal.

### 🟡 M4. The "mirror" rule is ambiguous, and the draft's choice makes the two walls asymmetric

**Raised by:** comprehension, zoom-out, inventive. The domain point was added by the synthesizer.

**Problem:**

- **The mirror is not spelled out.** The concept says "at the put wall, call drift rising above the flip = hold-A; mirror at the call wall".
  - A literal mirror at the call wall is "put drift rising **below** the flip".
  - The draft instead requires `above` at both walls.
- **The draft makes the walls unequal (synthesizer inference).**
  - The put wall usually lies below the flip. So "price at the put wall and above the flip" needs a flip below the put wall, and that cell will be rare.
  - "At the call wall and above the flip" is the ordinary positive-gamma case.
  - Under the draft, `hold-A` is therefore common at the call wall and rare at the put wall.
- **Simultaneous buying is decided by code order.** When both sides rise at once (calls and puts bought together, for example in a volatility burst), `break-risk` wins only because it is checked first.

**Resolution:**

- **Freeze a full truth table** before any run: wall × flip side × drift case. The drift cases are push-side rising, hold-side rising, both rising, flat, and thin. A draft is in [Proposed truth table](#proposed-truth-table-for-owner-decision).
- **Give "both rising" its own outcome**, `no-read` with the reason "both sides rising", unless the owner decides otherwise.

### 🟡 M5. Wall geometry is assumed, not checked

**Raised by:** design, codebase-details, structural, implementation-readiness, inventive, zoom-out.

**Problem:**

- **Walls can be adjacent or inverted.** The test fixtures include call wall 752 with put wall 753.
- **Ties go to the call wall.** `nearestWall` uses `<=`, so when both walls are inside the band it picks `call` without saying so.
- **Approach direction is never checked.** "Push through the put wall" assumes the wall is below price.
- **The walls describe a different set of options than the drift.** Walls sum open interest over all expiries (per-expiry pricing is a known gap in `flow_gex`), while intraday drift is mostly same-day options.
- **The dealer sign is assumed.** The GEX signs assume customers sell calls and buy puts (`gex-context.ts:491`).

**Resolution:**

- **Add a `wallGeometry` field:** `normal`, `adjacent`, `inverted` or `both_in_band`. Any value other than `normal` returns `no-read` with a code.
- **Count a touch only from the approach side:** the put wall from above, the call wall from below. This uses the per-minute price from B1.
- **Record the limits.** The all-expiry walls and the dealer-sign assumption are written down as limits in the rules header and the spec.
- **Covariates, not inputs.** `zeroDteShare` and the same-day drift part are recorded as study covariates, not rule inputs.
- **Test the edge cases.** The 752/753 fixture and an exact tie get tests.

### 🟡 M6. "Rising strongly" has no dollar floor

**Raised by:** design, inventive, structural, codebase-details.

**Problem:**

- **Shares ignore size.** `share = change / gross` is the same at any size. A quiet window with $200k gross reaches 0.3 just as easily as a $200M window, so `break-risk` can fire on noise.
- **Zero premium reads as "flat".** When `gross === 0`, both shares are set to 0 and the read is `no-read`, "drift is flat". A vendor feed that returns zeros would look like quiet trading.

**Resolution:**

- **Add a minimum gross per ticker (`minGrossUsd`).** Below it, the read is `no-read` with the reason "thin". The value is frozen in the spec, for example a time-of-day quantile from the drift history since 2025, recorded with its hash.
- **Treat zero gross as missing data.** `gross === 0` with enough buckets returns `no-data`, `zero_premium`, with shares `null`.

### 🟡 M7. Price scale and ticker pairing are not enforced

**Raised by:** zoom-out, structural, comprehension, implementation-readiness, inventive.

**Problem:**

- **The two documents use different keys.** `/flow` is keyed by flow symbol (SPY, ES, QQQ, NQ), and `flow.control` is keyed by group, with option tickers as primary or check.
- **ES has two sets of levels.** ES uses SPX GEX, and `symbolLevels` are those levels shifted by the basis.
- **The draft pairs them correctly today, but nothing enforces it.** The in-progress `flowWallDriftView` uses `gex.ticker` with the unshifted `levels`. Nothing in the types stops a later call site from pairing SPY levels with SPX drift, or ES `symbolLevels` with an SPX price.

**Resolution:**

- **Both inputs carry a `ticker`** from `FLOW_OPTION_TICKERS`. A mismatch returns `no-data`.
- **Shifted levels are excluded by type.** `symbolLevels` cannot be passed in.
- **Write the mapping into the design document and the spec:** ES → SPX, NQ → NDX, SPY → SPY, QQQ → QQQ.
- **Label the badge with the options ticker,** for example "SPX" on the ES view.
- **Decide whether the check ticker gets its own read:** SPY next to SPX, NDX next to QQQ. See Q5.

### 🟡 M8. The live drift total is not built the same way as the history total

**Raised by:** structural and implementation-readiness. Verified by the synthesizer.

**Problem:**

- **Live reads use the vendor total.** The live series reads the vendor `total` part (`flow-control.ts:222`). The collector fetches `total` and `zero_dte` (`flow-pipeline.md:18`).
- **History has only the derived total.** Every usable session of the history had only `zero_dte` plus `longer`, so the study used a derived total (`flow-control-continuation.md` Results).

**Resolution:**

- **Freeze one derivation.** The spec names one, vendor `total` or `zero_dte` + `longer`.
- **Parity test.** Where both exist, the live total must match the derived total on stored sessions.
- **Missing parts.** The read returns `no-data` when the frozen derivation cannot be formed.
- **Data manifest.** The spec records a manifest (file hashes and date range) for the vendor data kept outside the repository.

### 🟡 M9. Reads cannot be traced or audited

**Raised by:** codebase-details, inventive, design.

**Problem:**

- **The output cannot explain itself.** It has no price, timestamps, wall strike, distance, flip or source, so nobody can reconstruct why a read appeared.
- **Nothing is counted.** No-data causes are not counted, so a QuantData 401 streak is invisible except as a badge.
- **Parity cannot be checked.** Live and study reads cannot be compared.

**Resolution:**

- **Return the inputs with the read** (see B1) and the `rulesVersion`. The tooltip shows the levels age and the price age separately.
- **Parity test.** The study runner recomputes the reads from stored `flow_gex` and `flow_net_drift` rows. A golden test pins the browser adapter's result to the runner's for the same minute (see B2).
- **Live coverage is a required statistic.** The spec reports the share of no-data minutes by code for each ticker. A dashboard counter is optional, and nothing pages anyone.

### 🟡 M10. Labels and reason text read like trade instructions

**Raised by:** all 7 lenses.

**Problem:**

- **The wording is advice.** "Do not catch it", "the wall tends to hold", "the wall may break" and "wait" are advice or predictions.
- **The rule has no evidence yet.** It has no study result, and the previous drift rule failed (`no-edge`, −$25,923 out of sample).
- **"A" suggests a grading ladder that does not exist.**

**Resolution:**

- **Describe, do not advise.** Reason text says what was observed, with numbers and times, for example "put wall 5,900 · −0.12% · above flip · put +$4.1M / call −$0.8M (15 min)". No predictions and no instructions.
- **Show the study status on the badge,** as the control panel already does with `describeStudy`. Until a verdict exists, the badge shows "unvalidated: study accruing", which later links to the spec's Results.
- **Decide the names (Q1).** Keep `hold-A` and `break-risk` and define "A" in the tooltip, or rename to descriptive values such as `flow-against-wall` and `flow-through-wall`.

### 🟡 M11. Placement: schema contracts and the confluence block

**Raised by:** implementation-readiness, zoom-out, structural.

**Problem:**

- **Adding the read to a server document forces a version bump.** `flow.snapshot` and `flow-control.v1` are `.strict()` documents with a literal `schemaVersion`. Adding the read to either one needs a new version and a deploy order.
- **Confluence would change meaning.** In the confluence block, GEX is context only and not a directional vote. Adding the read there would change that.

**Resolution (matches the in-progress approach):**

- **Compute the read in the browser.** Use the pure rule from `packages/api` and the two responses `/flow` already fetches with `Promise.allSettled`.
- **No wire change.** There is no schema change, and rollback is a web revert.
- **Never a confluence vote.** The read stays out of the confluence block.
- **Map failures.** A rejected promise maps to a typed no-data reason that includes the HTTP status.
- **Server-side persistence is not needed,** because the stored rows already make every `/flow` read reproducible (see B2).

### 🟢 N1. Dangling references and hygiene

- The draft header cites `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md` and `docs/specs/strategies/gex-wall-drift-confluence.md`. Neither exists yet.
- Commit the rules, design document and spec together (see B3).

### 🟢 N2. Text defects

- `usd()` prints zero as `+$0`.
- The shares are `0` instead of `null` when the drift is not read (see M6).

### 🟢 N3. The `/stock` levels time understates staleness

- The in-progress `stockWallDriftView` uses `analytics.receivedAt` as the levels time.
- The chain and open interest behind the GEX numbers can be cached for up to 5 minutes (`gex-context.ts:535-537`, `fetchedAt`).
- Expose the oldest fetch time and use that as `levelsAt`.

### 🟢 N4. No counters

- No metrics are emitted for each read.
- A counter keyed by surface, ticker, read and `noDataCode` is optional (dashboard only).
- The required coverage statistic belongs in the study (see M9).

## Synthesizer corrections

Three claims from the lenses were checked against the code.

1. **"Net drift is collected every 2 minutes" is correct, not a contradiction.**
   - Four lenses called the draft comment wrong.
   - `flow-pipeline.md:18` says net drift is fetched every 120 s per ticker (sp500 on even minutes, nasdaq100 on odd minutes), and each fetch upserts one-minute buckets for the whole session.
   - So `minBuckets: 10` in a 15-minute window can be reached.
   - The newest settled bucket is normally 1 to 3 minutes old. That fits inside the 300 s contract limit, so the 300 s limit from M1 is usable.
2. **The open minute does not leak in through the current caller.**
   - `flow.control` builds `netDrift[].points` from `fold.settled`, which drops the open minute while the session is open (`flow-control.ts:224-226, 376`).
   - The draft window is therefore fed settled minutes today.
   - What remains of M2 is that the rule function does not state or enforce this, and the gap handling.
3. **The live versus history total (M8) is real.** It was verified against `flow-control.ts:222` and the Results section of the earlier spec.

## Inventive contradictions and pattern resolutions

Each row below is a real trade-off in the concept and a pattern that removes it.

| # | Contradiction | Pattern | Resolution | Secondary trade-off |
| --- | --- | --- | --- | --- |
| I1 | Fresh levels vs. an accurate touch | Segmentation | Walls and flip from GEX; price from the newest settled drift minute of the same ticker (B1). | Touch detection now depends on the drift feed. A 401 hides price and drift together, but the read is `no-data` then anyway. Contract change before v1. |
| I2 | Frozen rules vs. statistical power | Preliminary action | (a) Forward accrual on stored rows with an event-count stopping rule. (b) If the vendor archive allows, rebuild walls offline for 2025 onward (Q3). | (a) Months of waiting with an unvalidated badge. (b) Compute cost, dependence on vendor data, and the per-expiry gap. |
| I3 | Regime precision vs. unreliable flip | Segmentation | `unknown` when the flip is far from price, or a sign-based regime (Q2). | Fewer reads; one more frozen parameter that counts as a trial. |
| I4 | A separate rule vs. consistency with `flow.control` | Extraction | One window and freshness helper next to the existing slope; `flow.control` reasons passed through (M1, M2). | The new read's release is tied to the control rules module. |
| I5 | Comparing tickers vs. significance of size | Preliminary action | Per-ticker gross floor from a time-of-day baseline in the drift history (M6). | Another frozen artifact whose hash must be recorded; the baseline ages. |
| I6 | Showing the badge everywhere vs. entitlement and consistency | Intermediary (light) | One pure adapter used by both pages; `/stock` renders only for an operator on a covered ticker (B4). | `/stock` walls may differ from `/flow` walls; the badge names its source. |
| I7 | No-data as a passive label vs. an evaluated property | Blessing in disguise | Typed no-data codes counted as live coverage in the study (M1, M9). | The enum becomes part of the contract; coverage figures may push for looser limits, so the limits are frozen. |
| I8 | A research-only claim vs. labels that sound like trades | Inversion | Badge describes what was observed; only the study's outcome definitions say hold or break (M10). | Less instant meaning for the operator. |

**Ideal final result:** one read per ticker per settled minute, computed from stored inputs, the same wherever it appears, shown only where the viewer is entitled to it. Only the frozen study states what the read means.

## Proposed truth table (for owner decision)

All reads assume valid inputs: fresh levels and drift, at least 10 buckets, a span within tolerance, gross at or above the floor, and normal wall geometry. Anything else is `no-data` or `no-read` with a code.

- The "push" side is put drift at the put wall and call drift at the call wall.
- The "hold" side is the other side.
- "Rising" means share ≥ `risingShare`.

| Wall | Flip side | Push side rising only | Hold side rising only | Both rising | Neither (flat) |
| --- | --- | --- | --- | --- | --- |
| put | above | break-risk | **hold** (concept) | no-read (both) | no-read |
| put | below | break-risk | no-read (concept: graded only above) | no-read (both) | no-read |
| call | above | break-risk | **hold**? (draft) | no-read (both) | no-read |
| call | below | break-risk | **hold**? (literal mirror of the concept) | no-read (both) | no-read |

The draft grades the call-wall hold only `above`, and the concept's literal mirror grades it only `below`. The table must say which, or both, before the freeze (Q4).

## Goals vs. Non-Goals

**In-scope goals:**

- A pure, versioned rule. Its inputs are levels with ticker, `at` and source, plus price and drift window from one settled minute of the same ticker. Its output is `wall`, `flipSide`, `read`, a typed `noDataCode`, a descriptive reason and the input values used.
- A badge on `/flow` for the group's option tickers, computed in the browser from the documents already fetched.
- A badge on `/stock` for operators on SPY, SPX, QQQ and NDX, using the panel's existing response.
- A pre-registered study spec with embedded rules, a provenance table, touch and outcome definitions, a forward accrual and stopping rule, and a `needs-more-data` verdict.

**Out-of-scope non-goals:**

- Any order, arming, sizing or risk change. No trade instructions in the copy.
- New paid data, and changes to the `flow_gex` collection, including per-expiry walls.
- Making the three gamma sources agree.
- Adding the read to `flow-snapshot.v1`, `flow-control.v1` or the confluence vote.
- Showing drift-derived reads to members who are not operators.

## Alternatives Weighed

- **Ship the badge and the study together on today's data.** Rejected: there are about 13 and about 8 sessions of walls, so a verdict now would be noise (B2).
- **Spec and pure rule only; no UI until the study passes.** This is the zoom-out position. It is the simplest and the safest. It is weighed against the operator's wish to watch the read live. Middle path: the `/flow` badge ships with the "unvalidated: study accruing" marker and descriptive text, and the `/stock` badge waits (Q6).
- **Use the GEX snapshot `spot` for the touch.** Rejected: it can be 30 minutes old (B1).
- **Backfill walls from OpenBB daily or market-watch-bot.** Rejected: these are different estimates, the history is short, and the QQQ flip is empty (B2, M3).
- **Compute the read on the server inside `flow.snapshot` or `flow.control`.** Rejected for v1: it needs a strict schema bump, and stored rows already make reads reproducible (M11). Reconsider if an agent tool needs the read.
- **Use the existing combined `slopeUsdPerMinute`.** Rejected: it cannot tell put buying from call selling. The per-side window is kept and shares one helper with the slope (M2).
- **Drop the flip regime and use the wall × drift read only.** Kept as an option (Q2). It halves the cells and avoids the flip-source problem, but it drops part of the concept.

## Key Decisions & Staging for Next Steps

1. **Contract before freeze.** Make the B1, M1, M2, M5, M6 and M7 changes to the draft rule's inputs and outputs while it is still pre-v1: price from the drift minute, ticker on both inputs, typed codes, a span check, a geometry check, a gross floor, and zero premium as no-data.
2. **Truth table and outcomes.** The owner answers Q1, Q2 and Q4. The design document then records the full table, the touch event and the hold and break outcome definitions.
3. **Spec.** Write `docs/specs/strategies/gex-wall-drift-confluence.md` with the embedded rules, provenance, the M8 drift derivation, the `flow_gex`-only source, the per-ticker regime distribution, live coverage, and the `accruing` status with its stopping rule. It is committed with the rules and the design document, which stamps v1.
4. **`/flow` badge.** Computed in the browser and labelled with the options ticker. Descriptive copy, a study-status marker, and the input values in the tooltip.
5. **`/stock` badge.** Behind the operator flag and the ticker check, with no 403 request, a `rate_limited` code and the GEX fetch time (B4, N3). Alternatively deferred (Q6).
6. **Tests.** The truth table, the 752/753 fixture and the exact tie, the gap span, zero gross, the age limits against the contract, the live versus study golden fixture, and the live versus derived total check.

## Open questions for the owner

These go to the owner one at a time, in this order:

1. **Q1 (labels):** keep `hold-A` and `break-risk` with "A" defined, or use descriptive values such as `flow-against-wall` and `flow-through-wall`?
2. **Q2 (regime):** keep spot versus flip with `unknown` beyond a frozen distance, switch to the sign-based `gex.regime`, or drop the regime for v1?
3. **Q3 (history):** does the QuantData archive on the research machine hold historical chain and open interest? If so, walls could be rebuilt for 2025 onward.
4. **Q4 (mirror):** which flip sides grade a hold at the call wall?
5. **Q5 (check ticker):** one badge for each group's primary ticker, or one for each option ticker?
6. **Q6 (`/stock`):** ship the operator-only `/stock` badge now, or wait for the study?

## Appendix A: evidence given to every lens

- **E1.** Flow symbols are SPY, ES, QQQ and NQ. Option tickers are SPY, SPX, QQQ and NDX. The groups are sp500 (primary SPX, check SPY, future ES) and nasdaq100 (primary QQQ, check NDX, future NQ). ES uses SPX GEX, shifted by the basis.
- **E2.** `FlowGexSchema` contains `spot` (at the snapshot), `regime`, `levels {flip, callWall, putWall, maxPain}` and `symbolLevels`. The document is `.strict()`.
- **E3.** The age limits are `gex` 1800 s and `net_drift` 300 s. GEX is collected about every 14 minutes. `flow_gex` dates from 2026-11-08 (SPY/ES) and 2026-11-15 (QQQ/NQ). Retention is 730 days.
- **E4.** Walls are computed in `gex-context.ts:155-166`. The signs assume customers sell calls and buy puts. Open interest is summed over all expiries. The fixtures include walls at 752 and 753.
- **E5.** Three flip sources disagree, and QQQ flips were 8 to 11% above spot. The gamma-flip-sources non-goals exclude using a gamma level as a trade trigger.
- **E6.** `/stock` options analytics fetches on demand with rate limits and uses the same `buildGexContext`. The page is open to all members.
- **E7.** `flow.control` is operator-only and keyed by group. It returns `netDrift` series (primary and check) with cumulative points, `underlyingPrice` and `slopeUsdPerMinute` over 15 minutes.
- **E8.** The slope formula (`flow-control.ts:399-419`) uses combined call minus put over a fixed 15 and settled minutes only.
- **E9.** The typed no-data reasons of the options side are `market_closed`, `source_unavailable`, `storage_failed`, `stale`, `session_start` and `gap`.
- **E10.** The `/flow` GEX confluence factor is context only. `/flow` fetches the snapshot and control documents with `Promise.allSettled`.
- **E11.** `flow-control-continuation`: 463 sessions, 10 trials, deflated Sharpe bar 0.95, verdict `no-edge`. V1 (15 minutes) was positive over the whole period. The window-choice sessions are flagged. The history total is derived.
- **E12.** Full text of the untracked draft `packages/api/src/gex-wall-drift-rules.ts`.
