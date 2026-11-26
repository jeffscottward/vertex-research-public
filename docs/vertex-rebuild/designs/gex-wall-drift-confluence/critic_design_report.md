# Critic design report: GEX wall x net drift read

- **Reviewer:** Design Critic Goldfish (EGM Stage 7, Mode: REVIEW)
- **Date:** 2026-11-25
- **Target:** `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md`, FeatureRange lines 1-167 (Detailed
  Implementation Plan lines 168-190 read for context)
- **Companion spec checked:** `docs/specs/strategies/gex-wall-drift-confluence.md` (rules, event, outcomes, pass/fail rule)
- **Standard:** `resources/document_standards/feature-spec-standard.md`
- **Note:** both documents changed while this review ran (the spec dropped the derived-total fallback and renamed the
  flip-side value `unknown` to `no_flip`). Findings below are against the versions on disk at the end of the review.

## Verdict

The design meets the structural bar of the standard: problem (lines 33-38), goals (40-47), non-goals (49-56),
architecture (84-126), alternatives (146-152) and risks (136-144) are all present, and the operator-only gate is real
(`flow.control` is in the server operator list, `packages/api/src/server/operator-access.ts` lines 76-77). The UI part
is low risk.

The pre-registered study is not ready to freeze. Its two hypotheses compare classes that differ by construction in
flip side, and the stopping rule gives roughly 14% power for the 10-point effect it names. Because the spec says it is
frozen by the commit that adds it and is never edited, these must be fixed before that commit, not after.

Count: 2 Blocker, 9 Major, 7 Nit.

## Blockers

### B1. H2 (and partly H1) is confounded by flip side and ticker

- **Severity:** Blocker
- **Affected scope:** spec lines 17-18 and 122-125; design truth table lines 104-110.
- **Finding:** `hold-A` exists only above the flip, but the control class `flat` pools all flip sides. The reel's own
  premise (above the flip walls hold, below it they break) predicts that `hold-A` touches hold more often than `flat`
  touches even if the drift carries no information at all. H2 can therefore pass on the flip-side effect alone, which
  is not the question the study asks ("does the drift, together with the flip side, separate..."). The same
  composition problem exists by ticker: QQQ flips sit 8-11% above spot (spec line 132), so `hold-A` will be almost all
  SPX while `flat` mixes SPX and QQQ. H1 is exposed in a weaker way (`break-risk` and `flat` can have different
  flip-side and ticker mixes).
- **Recommendation:** pre-register stratified comparisons. For H2, compare `hold-A` with `flat` touches above the flip
  only. For H1, either compare within flip side or use a stratified test (Cochran-Mantel-Haenszel over flip side x
  ticker). Report the flip-side-only baseline (hold rate above vs below the flip, ignoring drift) so the drift's added
  value is visible.

### B2. The stopping rule cannot detect the effect it names

- **Severity:** Blocker
- **Affected scope:** spec lines 117-125.
- **Finding:** with 40 touches per class out of sample, a one-sided two-proportion z-test at p < 0.025 needs an observed
  difference of about 22 percentage points to pass (at a 50% base rate). For a true 10-point difference the power is
  about 14-15%; for 15 points about 27%. The 10-point minimum is therefore never the binding condition, and a
  `not-supported` verdict will be close to uninformative, while the badge keeps showing `hold-A` / `break-risk` for the
  whole accrual period. About 400 touches per class are needed for 80% power at 10 points.
- **Recommendation:** add a written power calculation to the spec. Either raise the per-class minimum to the size the
  calculation requires, or state a larger minimum effect with a reason, or use a design that ends honestly (for example
  a sequential test with a futility bound). Add a final date after which the study ends as `not-run` and the badge's
  grade wording is reconsidered.

## Major

### M1. The z-test treats clustered touches as independent

- **Severity:** Major
- **Affected scope:** spec lines 117-125 (test), 97-106 (event).
- **Finding:** SPX and QQQ move together on the same day, one session can give several touches (both walls, re-armed
  walls), and outcomes in one session share volatility. The pooled two-proportion z-test understates variance, so p
  values are too small.
- **Recommendation:** pre-register a session-clustered test (cluster-robust standard errors or a block bootstrap by
  session), or aggregate to one outcome per ticker and session per class.

### M2. No accrual estimate, no end date

- **Severity:** Major
- **Affected scope:** spec lines 117-119; design Q3 (line 68) and Future Improvements (163-166).
- **Finding:** nothing estimates how many touches per class per session to expect. `hold-A` needs price above the flip,
  hold-side share >= 0.30 and push side below 0.30 at a first approach; QQQ above-flip reads may be near zero. Reaching
  80 `hold-A` touches (40 out of sample after a 50% split) could take many months or never happen.
- **Recommendation:** count read classes (not outcomes) on the stored rows since 2026-11-08 to estimate accrual rates;
  this does not use up the test. Put the estimate and an end date in the spec and the design.

### M3. The event and outcome are ambiguous where it matters

- **Severity:** Major
- **Affected scope:** spec lines 99-113.
- **Finding:**
  1. "A touch is the first read time of a session at which..." reads as one touch per session, which conflicts with
     the re-arm rule in the next bullet.
  2. Walls change at each GEX row (about every 14 minutes). The approach test ("previous minute's price was above the
     put wall plus the band") does not say whether it uses the wall of the previous minute or of the touch minute, so a
     wall that jumps onto price can create a touch without price moving.
  3. The break test does not say whether it uses the wall strike at the touch or the current wall during the horizon.
  4. A one-minute move straight through the band is never a touch, so the fastest breaks are excluded: this biases the
     sample toward holds.
  5. Whether a `no-data` minute in the band consumes or blocks the re-arm is not stated.
  6. The outcome uses a "minute close", but the price is the vendor bucket's `stockPrice` (`flow-net-drift.ts`); what
     that value is (close, last sample, average) is not established.
- **Recommendation:** define each point exactly, with a worked example per case, before the freeze. Fix the wall at the
  touch for the whole horizon, evaluate the approach against the touch-minute wall, and record (and report) one-minute
  crossings as their own category.

### M4. Falling drift is ignored, so `flat` is not neutral

- **Severity:** Major
- **Affected scope:** design Terms lines 22-31, truth table 104-110; spec line 70.
- **Finding:** only a rising line counts. Put selling at the put wall or call selling at the call wall (the put or call
  line falling hard) is flow against the wall in the reel's sense, yet it grades `flat`. Heavy selling toward the far
  side is also dropped. The `flat` control class thus mixes quiet tape with strong one-sided selling, which dilutes both
  H1 and H2 and makes their results hard to read.
- **Recommendation:** either state why sold premium is out of scope (with a source), or split `flat` into "quiet" (both
  shares small in absolute value) and "falling" codes and use only "quiet" as the control.

### M5. The study grades revised data; the badge graded provisional data

- **Severity:** Major
- **Affected scope:** design Risks lines 136-144; spec Data lines 31-43.
- **Finding:** `upsertNetDrift` (`packages/db/src/server/flow.ts` around line 1444) overwrites a stored bucket whenever
  the vendor answer changes, and `flow.control` treats every bucket except the newest as settled. A bucket can be
  revised after the badge has graded it. The study will grade final values, so even a passing study does not validate
  the read operators actually saw.
- **Recommendation:** add this risk. Either log the live read and its inputs at each refresh, or keep first-seen bucket
  values, or at least measure and report how often and how much settled buckets change after first storage.

### M6. The spec check guards the numbers, not the rule

- **Severity:** Major
- **Affected scope:** design Goals lines 46-47 and Acceptance line 185; `packages/api/src/gex-wall-drift-spec.test.ts`.
- **Finding:** the test only compares the JSON values and the version string. The truth table, check order, share
  formula, flip-side tie (`>=`), event and outcome prose can all change without a version bump. During this review
  the spec's flip-side value and fallback rule changed and the test was unaffected.
- **Recommendation:** commit golden input/output vectors per rules version and have the test (and the future runner)
  check them; also hash the spec's Rules, Event, Outcomes and Pass/fail sections and refuse a run when the hash
  differs.

### M7. `/stock` shows a graded read that is untested and can go stale

- **Severity:** Major
- **Affected scope:** design Q6 line 71, Pages lines 121-123, Risks line 144, NFR line 156.
- **Finding:** `/stock` uses `options_analytics` levels, which the study never tests (spec line 33 excludes them), yet
  the badge uses the same `hold-A` / `break-risk` labels; a tooltip is the only marker. The panel has no polling: the
  read is computed once per analytics answer (`StockWallDrift` sets `checkedAt` only on load), so a `Hold` pill can
  stay on screen long after the drift is older than 5 minutes.
- **Recommendation:** re-evaluate the read against a ticking clock (so it drops to `drift_stale` / `gex_stale`), and
  either show no grade on `/stock` (descriptive only) or mark it visibly "levels: on-demand analytics, not studied".

### M8. A viable alternative is missing; one rejection rests on an unlinked request

- **Severity:** Major (Alternatives Rule of the standard)
- **Affected scope:** design lines 146-152 and Q1 line 66.
- **Finding:** the obvious middle option, a descriptive badge (wall proximity, flip side, the two drift shares) with no
  hold/break grade until the study passes, is not considered, although it removes the advice risk named first in the
  risk table. "Spec and rule only" is rejected because "the task asks for the badge" and Q1 keeps the labels because
  "the task names these values", but the task file is not linked.
- **Recommendation:** add the descriptive-only alternative with a concrete trade-off, and link the task file (or the
  owner request) that requires the graded labels.

### M9. Peeking and the freeze boundary are not controlled

- **Severity:** Major
- **Affected scope:** spec lines 4-8 and 117-121; design Q3 line 68.
- **Finding:** stored rows from 2026-11-08 to the freeze were already looked at (the QQQ flip note of 2026-11-20). The
  50% split is by touch count, so the split point moves as data accrues and is not tied to the freeze commit. A run
  before the stopping rule "does not use up the test", but nothing stops it from showing rates, which invites optional
  stopping.
- **Recommendation:** define out of sample as touches after the freeze commit only (pre-freeze touches are discovery
  regardless of the 50% rule), and require the runner to print class counts only, never rates, until the stopping rule
  is met.

## Nits

### N1. Stale statements in the design

- **Severity:** Nit
- **Affected scope:** design lines 77 and 96-97.
- **Finding:** line 77 still says "the derived total reported in the study (M8)", but the spec now says a missing
  `total` minute is a gap (the collector stores only `total` and `zero_dte`, so no derived total exists). Lines 96-97
  say the age limits come "from `FLOW_SOURCE_METADATA`", but the spec and the code now freeze them as numbers.
- **Recommendation:** update both lines to match the spec and code.

### N2. The touch band is justified for SPY and QQQ, not for SPX

- **Severity:** Nit
- **Affected scope:** spec line 90; design line 96.
- **Finding:** SPX is a verdict ticker; 0.25% of about 6000 is about 15 points, three 5-point strikes, against one to
  two strikes on QQQ. Touch and break rates will differ by ticker for this reason alone.
- **Recommendation:** state the band in strikes for SPX and NDX too, and report rates per ticker.

### N3. Horizon edges

- **Severity:** Nit
- **Affected scope:** spec lines 104 and 110.
- **Finding:** touches up to 15:25 have no full 60-minute horizon for the reported 60-minute rates; early-close sessions
  have no stated cutoff.
- **Recommendation:** add a 15:00 cutoff for the 60-minute report and a close-minus-30 rule for early closes.

### N4. "Counts the earlier trials" has no effect

- **Severity:** Nit
- **Affected scope:** spec line 95.
- **Finding:** Holm runs over H1 and H2 only, so the 10 earlier trials change nothing.
- **Recommendation:** say plainly that they are disclosed but not corrected for, or include them in the correction.

### N5. Decision provenance is not reproducible

- **Severity:** Nit
- **Affected scope:** design lines 60-62.
- **Finding:** the knowledge-base answers are "saved with the job report" and decisions "posted once in the job
  channel", with no link or path.
- **Recommendation:** link the report and the post.

### N6. Touch price can lag the read time

- **Severity:** Nit
- **Affected scope:** spec line 71; design Risks line 141.
- **Finding:** price is "the newest underlying price in the window", which may be several minutes older than `m`;
  nothing checks or records the lag.
- **Recommendation:** record `priceAt - m` per touch, or require the price minute to equal `m`.

### N7. Rollout wording

- **Severity:** Nit
- **Affected scope:** design line 161.
- **Finding:** "Web-only change" while `packages/api` gains an exported module; rollback needs a full deploy and there
  is no switch to hide the badge.
- **Recommendation:** say "no server behaviour or schema change", and consider a flag to hide the badge without a
  deploy.

## Standard compliance summary

| Requirement | Status |
| --- | --- |
| Problem statement | Present (lines 33-38) |
| Goals and non-goals | Present (lines 40-56) |
| Proposed architecture | Present (lines 84-126) |
| Alternatives considered | Present, but a viable alternative is missing and one rejection is unlinked (M8) |
| Risks and mitigations | Present; missing revision bias (M5), stale `/stock` read (M7), accrual and power (B2, M2) |
