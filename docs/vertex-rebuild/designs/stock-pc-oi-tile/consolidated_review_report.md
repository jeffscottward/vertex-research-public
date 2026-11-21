# Consolidated Review Report — `/stock` Put/call OI KPI

![Dark before-and-after UI diagram; mock](before-after.svg)

**Target:** `docs/vertex-rebuild/designs/stock-pc-oi-tile/plan.md`
**Review flow:** Stages 5–9
**Current state:** Implementation, post-rebase Graphify, focused tests, build, E2E, and full pre-push verification passed. Post-change drift, fresh-context review, PR checks, and merge are pending.

## Review results

| Stage | Review | Main finding | Resolution in the plan |
| --- | --- | --- | --- |
| 5 | Zoom-out and Inventive Catalyst | The large value needed explicit behavior for loading, timeout, and errors. The compact value/detail approach preserves missing-data meaning. | All non-ready states use `—` with their existing status message in muted detail. The scope stays within the stock-detail tile. |
| 6 | Comprehension | The plan lacked a state-to-message map and did not define “selected expiry.” | The plan defines selected expiry as the expiry chosen in the options-chain control and specifies a value/detail for every state. |
| 7 | Design, structure, and style | The plan needed alternatives, returned-chain coverage limits, explicit risk assessment, measurable state and responsive checks, and clear treatment of mock evidence. | The plan documents the alternatives, first-page coverage limit, unchanged security/scalability surface, state tests, tile geometry checks, and source behavior without presenting mock counts as production observations. |
| 8 | Intermediate zoom-out | Acceptance testing could expand beyond the UI-only change. | The plan preserves API, provider, pagination, order, and risk behavior without adding broad tests for untouched systems. |
| 9 | Implementation readiness | The initial plan lacked actionable per-file operations, exact state rules, and testable phases. The one permitted re-audit also found an omitted zero-put ratio case, under-specified browser fixture/geometry checks, and missing exact PR/merge evidence steps. | The plan now lists exact Modify/Delete/Read-only paths, all value/detail cases, deterministic mock data and DOM checks, phase checkpoints, PR graphic steps, eight required checks, exact reviewed-SHA handling, and `scripts/merge-pr`. |

## Traceability

- **Data semantics:** The API selects Quant Data then Yahoo for OI. Quant Data derives OI from order-flow prints in the last 24 hours; a contract with no qualifying print has no OI value. The merge preserves `null` when neither source reports a value, and the table renders null as `no OI` with a source-missing title. The KPI never turns null into zero. Counts describe the returned chain only.
- **Display contract:** A complete chain with positive call OI may show a ratio, including `0.00` when put OI is zero. Other ready states and every non-ready state use `—` with a distinct detail.
- **Verification contract:** Unit tests cover each table row and existing `StatCard` slots. The E2E test uses deterministic mock data, checks the null-cell label, tile containment at 375, 768, 1024, and 1440 px, and wrapping at 375 px. It does not claim page-wide overflow is fixed: at 1024 px, the existing options-chain table produced a document width of 1179 px and remains outside this tile task.
- **Delivery contract:** The PR must include a dark mock before/after graphic and review evidence. All eight required checks must pass on the reviewed head before the repo merge script runs.

## Stage 9 resolution note

The standing EGM resolve decision requires automatic acceptance of every PROPOSE FIX. All Stage 9 proposals were accepted. The codebase reviewer reported no findings; the style reviewer reported no findings. The single permitted readiness/codebase re-audit identified three remaining readiness findings, which were then fixed in the plan. The Stage 9 limit allows no further re-audit; the primary agent checked that each accepted fix appears in the plan. This is not a claim that Goldfish re-reviewed the final post-audit edits.

## Implementation and verification

- The KPI keeps the numeric ratio or `—` in the value slot and shows state and returned-chain coverage in muted detail. The API, nullable OI semantics, provider requests, pagination, and trading behavior remain unchanged.
- Post-rebase checks passed: stock-detail unit test (19/19), `bun run build`, stock-detail E2E file (4/4, including partial-OI responsive coverage), and Graphify update/check/verify.
- Full `bun run verify:prepush` passed on the rebased tree: 151 files passed, 3 skipped; 3,419 tests passed, 6 skipped.

## Remaining work

Obtain fresh-context review at the final SHA, then follow the PR, CI, and merge procedure in `plan.md`. No PR or merge is claimed yet.
