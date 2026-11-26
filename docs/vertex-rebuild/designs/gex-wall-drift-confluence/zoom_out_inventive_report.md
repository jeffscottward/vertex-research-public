# Zoom-out inventive review (Stage 5, TRIZ lens): GEX wall x net drift read

- Reviewer: Inventive Catalyst Goldfish (Mode: REVIEW)
- Target: `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md` (lines 1-190), companion spec
  `docs/specs/strategies/gex-wall-drift-confluence.md`
- Repository state read: worktree `ws/vertex-gex-drift` on baseline `d86d57d9` (implementation files already present,
  uncommitted); `packages/api/src/contracts/flow.ts`, `packages/api/src/server/flow-control.ts`,
  `packages/api/src/gex-wall-drift-rules.ts`.

## Verdict

The core architecture is balanced: one pure, versioned rule in `packages/api`, called by the browser now and by the
study runner later, with stored rows as the reproducibility record. Rejecting server-side computation (line 148) is
not a false compromise; Segmentation via the shared pure module already resolves "no schema bump" against
"reproducible reads". Forward accrual on `flow_gex` only (Q3, line 68) is a measurement-purity invariant, not a false
compromise.

Four false compromises remain. In each, the live badge and the future study read the same rule but feed it, or count
it, differently. The design accepts that divergence without examining it. There is also one coupling nit and one
failure-handling nit. No Blocker: the badge is research context, carries "Unvalidated", and cannot place orders.

| # | Severity | Scope | One line |
| --- | --- | --- | --- |
| 1 | Major | Rule module vs. spec Event (design 86-114; spec 96-104) | The badge grades every in-band minute; the study tests only qualifying touches. The touch qualifier is not in the shared module. |
| 2 | Major | Drift input normalization (design 77; spec 36-37, 135) | The live and study series are built differently, and the spec's fallback cannot be computed from the stored parts. |
| 3 | Major | `/stock` levels source (design 71, 90, 118-120, 144) | The same graded labels come from an untested gamma source; the only mitigation is a tooltip. |
| 4 | Major | Study runner deferral (design 56, 163-165; spec 116-121, 131) | The runner waits until the stopping rule "can be met", but nothing measures accrual. |
| 5 | Nit | Frozen rules vs. ops metadata (design 97; `gex-wall-drift-rules.ts:28-38`) | The frozen v1 values are computed from mutable collector staleness config. |
| 6 | Nit | `/flow` failure handling (design 120, 156) | Refetch state "loading" counts as no-data, so the badge can flicker. |

---

## Finding 1 (Major): the live grade and the tested event share a rule but not an event definition

- **Affected scope:** Technical Plan, Rule (lines 86-114); Pages (lines 116-126); spec "Event" (spec lines 96-104).
- **False compromise:** The design treats "one pure rule" as enough for live and study parity. But the spec tests a
  narrower object than the rule produces. A study event is a touch: the first non-no-data read from the inside
  approach (the put wall from above, the call wall from below). The same wall then gets a 30-minute cooldown, and
  touches before 09:45 or after 15:25 do not count. The badge grades every minute that price sits in the 0.25% band,
  including:
  - re-tests during the cooldown;
  - approaches from the outside, for example price coming back up to the put wall after a break;
  - minutes after 15:25.

  Even after the study passes, a "hold-A" badge will often describe a state the study never measured. The
  "Unvalidated" label (line 139) hides this today. It will mislead once the label is dropped. The coupling is also a
  parity risk: the touch qualifier, the inside approach and the cooldown will be written separately in the future
  runner.
- **Proposed resolution:** Extraction plus Segmentation. Put the event qualifier in the same pure module as
  `gradeGexWallDrift`, for example `classifyWallTouch(points, levels, rules)`. It would return `touch`, `retest`,
  `outside_approach` or `outside_session`. Freeze it in the same rules version. Both the browser and the runner call
  it. The badge then shows whether the current read is a tested event ("first touch") or an untested state
  ("re-test: not the studied event"). Add the touch qualifier to the spec-equality test so the event cannot drift from
  the spec.
- **Secondary liabilities:**
  - The rule needs the previous minute's price and up to 30 minutes of in-band history. The session-cumulative
    `flow.control` points already carry `underlyingPrice`, so no new request is needed. The helper still adds state
    logic to a "pure" module.
  - The truth-table test surface grows. The qualifier constants (cooldown 30, 09:45 to 15:25) become frozen rules
    values: changing them needs a new rules version.
  - The badge gains one more qualifier line, so watch the `line-clamp-2` reason budget.

## Finding 2 (Major): live and study drift series are normalized differently; the spec fallback cannot be computed

- **Affected scope:** Decisions, M8 (line 77); spec Data (spec lines 36-37) and "Reported" (spec line 135); contract
  `FLOW_EXPIRY_PARTS = ["total", "zero_dte"]` (`contracts/flow.ts:86-87`, "longer = total - zero_dte on read").
- **False compromise:** The design accepts "vendor total for live reads, derived total reported in the study" as two
  coexisting input paths.
  - **Live path:** `flow-control.ts:222-231` builds points only from `total` rows. A minute without a `total` row is
    absent; it is not filled.
  - **Study path:** the spec says a missing `total` minute "uses `zero_dte` plus `longer` where both exist". The store
    keeps only `total` and `zero_dte`, and `longer` is defined as `total - zero_dte`. So `longer` cannot exist when
    `total` is missing, and the fallback can never fire.

  As written, the covariate "minutes that used the derived total" is always zero. If someone later "fixes" the
  fallback, for example by treating `zero_dte` alone as total, the study would grade minutes the badge never showed.
  Then the window, `thin_window` and gross values diverge between live and study. That is the M9 parity problem the
  brainstorm meant to close (brief line 340), reopened in the input layer.
- **Proposed resolution:** Extraction. Move the input normalizer into the rule module: one exported
  `toDriftSeries(rows)` that builds settled cumulative points from stored rows. `flow.control` already does this
  server-side, so share or port that logic, and let the runner call the same function. Then decide once for both
  paths. Either there is no fallback (a missing `total` minute stays a gap, counted by `window_gap`/`thin_window`),
  which matches today's live behaviour, or there is a fallback defined only on parts that exist. Correct spec
  line 37 and the line 135 covariate to match, or drop them. The runner's parity golden test (brief line 340) should
  pin the normalizer, not only the grade.
- **Secondary liabilities:**
  - `flow-control.ts` and the rule module must not keep two copies of the folding logic. Either `flow.control`
    imports the shared normalizer (a small refactor of server code that this design calls "web-only", line 161) or
    a parity test pins them.
  - Removing the fallback lowers study coverage on collector-gap days; the no-data code counts make that visible.

## Finding 3 (Major): the `/stock` badge shows tested labels from an untested gamma source

- **Affected scope:** Decisions Q6 (line 71); Rule inputs (line 90, `source: "flow_gex" | "options_analytics"`);
  Pages, `/stock` (lines 118-120); Risks (line 144).
- **False compromise:** "Ship `/stock` now" is traded against "only `flow_gex` is tested". The trade is settled with a
  tooltip that names the source. The badge vocabulary (`hold-A`, `break-risk`) is the same on both pages, and the
  `/stock` levels (`options_analytics`, an on-demand estimate) are not stored as a study series. The same label then
  means two things, and one of them can never be validated. Non-Goals line 52 even notes that the gamma sources are
  not reconciled. This is a vocabulary contradiction, not a data limit.
- **Proposed resolution:** pick one of two patterns.
  - **(a) Intermediary on the input.** `/stock` sources its walls from the same `flow_gex` levels that `/flow` uses
    (the `flow.snapshot` `gex` block for the paired view: SPY, ES for SPX, QQQ, NQ for NDX). The `options_analytics`
    answer stays a separate panel, and every graded read has one tested source.
  - **(b) Segmentation of the output.** Keep `options_analytics` on `/stock`, but the rule returns a distinct status
    for untested sources, for example `read: "context"` with the would-be grade shown as plain description. The
    `hold-A`/`break-risk` labels are reserved for `flow_gex`.

  Option (a) also removes the "A new analytics answer reloads the drift" coupling (line 120).
- **Secondary liabilities:**
  - (a) adds one `flow.snapshot` request for operators on four tickers, which conflicts with the "one `flow.control`
    request" NFR (line 155). `/stock` may then show levels that differ from its own analytics panel next to it, so
    the source must be labelled.
  - (b) adds a fifth badge state to design, test and explain, and the badge still repeats a number the study
    ignores.

## Finding 4 (Major): the runner is deferred until the stopping rule "can be met", but nothing measures accrual

- **Affected scope:** Non-Goals (line 56); Future Improvements (lines 163-165); spec stopping rule (spec lines
  116-121) and QQQ flip note (spec line 131).
- **False compromise:** The design accepts "no runner now" to avoid premature analysis, and it ties the runner's
  start to an event-count condition: at least 40 out-of-sample touches per class for pooled SPX and QQQ, which is
  about 80 per class in total. No component counts those touches, so the condition can only be checked by writing
  the runner, which the design defers.

  The class most likely to starve is `hold-A`, which needs price above the flip. The spec notes that QQQ flips were 8
  to 11% above spot, so QQQ may contribute close to zero `hold-A` touches. The pooled H2 verdict could then wait
  indefinitely on SPX alone, unseen until someone runs the analysis. The same gap hides live coverage. The spec
  reports the share of no-data codes per ticker (spec line 133), but no one sees it until the end. A collector
  regression, such as the HTTP 401 named in line 37, could quietly erode the sample for weeks.
- **Proposed resolution:** Self-Service plus Blessing in Disguise. Ship a blind accrual counter now:
  - It runs the frozen rule and the touch qualifier from Finding 1 over stored rows and counts touches per read
    class, flip side and no-data code per ticker.
  - It computes no hold or break outcomes, so it does not spend the out-of-sample test. Pre-registration stays
    intact because outcomes stay unseen.
  - It publishes counts and a projected date to reach 40/40/40, using the observed rate, to the job channel or the
    spec's Results section on a schedule.

  The counter becomes the first half of the runner, and the rule-mismatch refusal (line 165) can be tested now, not
  later.
- **Secondary liabilities:**
  - A scheduled job and its failure alerts must be maintained, plus one more artifact that must refuse mismatched
    rules.
  - Counts by class are a mild form of peeking. Keep them outcome-free and say so in the spec, or the
    pre-registration claim weakens.
  - A projection that shows `hold-A` cannot reach 40 will pressure people to change the pooling or the flip rule.
    That change must follow the spec's own path: a new rules version, never an edit to the v1 spec.

## Finding 5 (Nit): frozen rule values are computed from mutable operational config

- **Affected scope:** Rule values (line 97: "both from `FLOW_SOURCE_METADATA`"); implementation
  `packages/api/src/gex-wall-drift-rules.ts:28-38` (`maxGexAgeMinutes: FLOW_SOURCE_METADATA.gex.maxAgeSeconds / 60`).
- **False compromise:** "Single source of truth" is traded against "frozen pre-registered values". The frozen
  `gex-wall-drift-rules.v1` object is computed from `FLOW_SOURCE_METADATA`, which is operational collector config
  ("single source of truth" for staleness, `contracts/flow.ts:35`). Tuning a collector's staleness for an ops reason
  would change the frozen research rules. The spec-equality test then fails and forces a new rules version for a
  change unrelated to the study. If the test is "fixed" by editing the spec block, the pre-registration breaks
  instead.
- **Proposed resolution:** Extraction. Write the literal values (30, 5) into `GEX_WALL_DRIFT_RULES`. Add a separate
  guard test: rule age limits must be at most the matching `FLOW_SOURCE_METADATA` limit. That keeps the intent ("never
  looser than the collector") without binding the frozen object to ops config.
- **Secondary liabilities:** two numbers to keep in step by hand. The guard test makes a mismatch visible instead of
  silent.

## Finding 6 (Nit): a refetch counts as "no data", so the badge can flicker

- **Affected scope:** Pages, `/flow` (line 120: "`flow.control` loading or failed is a no-data reason"); NFR "no
  layout shift" (line 156).
- **False compromise:** The design removes layout shift (`min-h-20`) but accepts state flicker. If "loading" includes
  background refetches, the badge flips graded to No data to graded every refresh cycle. That would teach operators
  to ignore the No data state the Problem section (line 37) wants to make meaningful.
- **Proposed resolution:** Beforehand Cushioning. Only the initial load and an error count as no-data. During a
  background refetch, keep the last series. The rule's own `drift_stale` check (5 minutes) is the honest bound on
  staleness, so held-over data can never be shown as fresh.
- **Secondary liabilities:** a previous read may be shown for up to one refetch interval after the data changed.
  This is bounded by `maxDriftAgeMinutes` and acceptable for research context. The loading-state test matrix needs
  one more case.

---

## Checked and not raised

- **Browser vs. server computation** (line 148): resolved by the shared pure module and stored-row reproducibility.
  Reconsider only if an agent or alert consumer needs the read.
- **No backfill** (Q3, line 68): a deliberate measurement-purity choice that keeps one estimate. Future Improvements
  already keep a labelled backfill as a separate test.
- **No gross-premium floor in v1** (line 80): declined explicitly with a reason (an extra trial); gross is a reported
  covariate. This is a stated trade, not an unexamined one.
- **The `no-data` taxonomy as active mitigation:** typed codes plus the collector message make failures visible, not
  hidden. That counts as active handling for a non-trading research surface.
