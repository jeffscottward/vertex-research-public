# OpenBB IV history caveat

![Dark infographic showing per-row source, sample membership, and the audit-only timestamp rule](openbb-iv-history-caveat.svg)

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-22
* **Status:** Implementation and focused checks pass on base `cc58ad77eb94cae02b655dd1a5492d9854233fcc`. Full `bun run verify` passed before the final exact-suffix correction; after that fix, 22 DB unit tests and 15 Postgres tests pass, including the `rate 4x` near-miss exclusion. Final full verification remains pending. Responsive E2E checks pass, and the EGM drift recheck found no drift. Fresh-context review is pending because this session's agent preflight points to a removed release path. PR #408 remains open and behind with a competing migration 0092; renumber after a protected-base update if needed.

## Problem

The newest-run source note is temporary. After Cboe recovers, it can disappear while Yahoo-derived observations remain in the per-underlying 252-row IV percentile sample.

## Pre-implementation baseline evidence

The seven fresh lenses reviewed merged HEAD `c38ca07ff878e096bfc06ec7410595b9c8fcfc72` before this task's implementation. These findings describe the pre-change baseline, not the current worktree.

* Before this task added row-level provenance, a same-key upsert could replace a Yahoo observation without preserving its source. This change stores source with the daily IV row and updates it atomically; the run ledger still cannot identify the source of legacy rows.
* `optionIvDaily` ranks rows per underlying by descending `asOf` and takes the newest 252. `volContext` computes percentile from those selected rows. Reuse that exact selected sample for membership; do not create a separate query/cutoff or calendar-age approximation. Row membership is defined by the ranked sample, including rows with null IV; the percentile's non-null comparison population is a distinct existing detail.
* The newest-run source note and `volContext` data are read independently, so status and membership can be stale, disagree, or fail separately. Missing metadata means unknown, not clean; preserve numeric IV values.
* The existing source note describes the newest run/newest IV rows, not historical source composition or the live quote source. Its skip-marker behavior remains independent of the new audit and history predicates.

The Cboe job emits the successful Yahoo-row warning only after it builds a daily row. The run ledger stores `rowsReceived`, `rowsWritten`, and `finishedAt`. A non-empty run with the successful-row suffix and `rowsReceived === rowsWritten` proves that at least one Yahoo row in that run's document was written. It does not prove that the row remains stored after a later same-key upsert, or that it remains in the current 252-row sample. The carry-forward skip warning does not contain the successful-row suffix.

## Goals and non-goals

### Goals

* Show whether a Yahoo-derived row remains in each displayed underlying's exact 252-row percentile sample.
* Keep IV rows visible when status or membership metadata is unavailable; never represent unknown membership as clean.
* Define `lastFallbackAt` as the latest fully written, non-empty `cboe-option-iv` run completion with the successful Yahoo-row warning and status `ok` or `partial`. Keep it separate from sample membership.

### Non-goals

* Change source selection, IV values, percentile math, risk, orders, arming, or live services.
* Do not add a sidecar table or append-only event ledger; keep source on the existing daily row unless review finds that insufficient.

## Concept synthesis

### Three separate facts and predicates

1. **Newest-run source note:** describes the newest run/newest IV rows. A Cboe recovery may clear it; this is not proof that history is clean.
2. **`lastFallbackAt`:** latest fully written, non-empty `cboe-option-iv` run completion with the exact successful Yahoo-row suffix, positive `rowsReceived`, equal `rowsWritten`, and status `ok` or `partial`. It is audit-only; a later Cboe recovery does not erase it, and it does not control history membership.
3. **History membership:** for each displayed underlying, whether a currently stored Yahoo-derived observation belongs to the exact same 252-row ranked sample used for its percentile. The caveat remains visible when at least one such row is known.

The current daily row source, not the run ledger, establishes current sample membership. Keep legacy rows `unknown` because the run ledger has no row-specific mapping. A `null` audit timestamp means that no qualifying run is in the ledger, not that Yahoo history is absent or the sample is clean.

### User-facing state and behavior

* **Affected:** evidence establishes that at least one Yahoo-fallback row remains in the active sample. Keep the caveat visible even if another selected row is unknown.
* **Clean:** every row in the non-empty sample is known to be Cboe-derived.
* **Source unverified:** no Yahoo row is known and the returned, non-empty sample has at least one row with unproven source. An empty sample produces no IV row or history state.

Label newest IV-row source separately from the history caveat; do not imply either is the user's live quote source. If status and `volContext` are combined in the UI, acknowledge that they are independent reads and may not represent one atomic snapshot. Keep the audit timestamp separate from membership.

### Inventive tension and resolution

| Tension | Resolution |
| --- | --- |
| Minimal run-level metadata is cheap, but generic warnings and aggregate counts do not prove current row membership or individual writes after partial failures. | Use the exact successful Yahoo-row suffix with a non-empty complete write only for the separate audit timestamp. Keep current row provenance on the daily row and derive membership from the selected sample. |
| A global audit time is simple, while sample membership changes per underlying. | Define an audit-only timestamp from the latest qualifying fully written run; do not use it to clear or classify the sample. |
| Source-less daily upserts are minimal, but same-key replacement erases source history. | Add a source field to each daily row so later Cboe writes replace Yahoo provenance atomically with the value. |
| Separate endpoint reads preserve existing boundaries but can fail or differ in freshness. | Keep membership with the percentile result; define `affected`, `clean`, and `unknown` while preserving numeric IV data. |

## Resolved method and remaining verification

1. **KB route and evidence:** the owner approved the current OMP default and only the QuantFinanceToGo and DeepEdge Intelligence origins. Spreads Trading remains excluded; no allowlist change or separate task claim was added. Both KB answers lacked relevant source-backed evidence. The private method report contains provenance and source references.
2. **Legacy mapping:** keep legacy rows `unknown`. The old run ledger has no row-specific source mapping; do not use a calendar cutoff, warning absence, or aggregate count.
3. **Storage and data model:** use source on `openbb_option_iv_daily`, updated atomically with the same-key IV row. Do not add a sidecar or event ledger.
4. **API/UI contract:** derive `historyState` from the exact sample used for percentile. Keep raw source private. Show `affected`, `clean`, or `source_unverified`; keep numeric values visible and the latest-run note separate.
5. **Audit timestamp:** `lastFallbackAt` uses the exact successful Yahoo-row suffix, `rowsReceived > 0`, `rowsWritten === rowsReceived`, and status `ok` or `partial`, ordered by `finishedAt`, `startedAt`, and run id. It is audit-only; `null` is not clean evidence.
6. **Verification:** Before rebasing from `7409a24195ae096a62041a2c9d504f6a35ca26e8`, 77 Vitest tests, 162 OpenBB Python tests, and 15 Postgres integration tests passed. On base `cc58ad77eb94cae02b655dd1a5492d9854233fcc`, the full repository verify passed before the final exact-suffix correction. After that fix, the DB unit suite passed 22 tests and the Postgres integration suite passed 15 tests, including rejection of the `rate 4x` near miss; final full verification remains pending. Earlier build, Graphify (five queries), Drizzle generation, DB/OpenAPI checks, responsive E2E at 375, 768, 1024, and 1440 px, and the six-suite Python run passed. EGM drift was rechecked with no drift. Fresh-context review and hosted PR CI remain pending; this session's agent preflight points to a removed release path. PR #408 remains open with the competing migration 0092; if it merges first, update from the remote base, renumber, confirm no Drizzle schema changes, and rerun tests.

## Historical pre-merge review findings (archival; superseded)

These earlier observations were made against pre-merge code and are not current-base evidence. Retain only as historical context; revalidate before relying on any source-specific statement.

* The early design emphasized proving persisted writes, using sample membership rather than a global timestamp for caveat expiry, handling independent status/context reads, and keeping contracts additive. The exact success suffix plus complete non-empty write counts can support the audit event only; they still do not prove current sample membership.

## Lens execution status

All seven fresh EGM brainstorm lenses completed against merged HEAD `c38ca07ff878e096bfc06ec7410595b9c8fcfc72`.

| Reviewer lens | Status |
| --- | --- |
| `egm-design` | completed on post-merge base |
| `egm-codebase-details` | completed on post-merge base |
| `egm-zoom-out` | completed on post-merge base |
| `egm-comprehension` | completed on post-merge base |
| `egm-implementation-readiness` | completed on post-merge base |
| `egm-structural` | completed on post-merge base |
| `egm-inventive-catalyst` | completed on post-merge base |
