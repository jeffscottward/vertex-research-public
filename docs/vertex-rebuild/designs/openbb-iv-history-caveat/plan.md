# OpenBB IV history caveat — plan

![Dark infographic showing exact-sample states and the separate fully written-run audit timestamp](openbb-iv-history-caveat.svg)

- **Status:** Source-tagged history/status/API/UI implementation is complete on base `cc58ad77eb94cae02b655dd1a5492d9854233fcc`. Full `bun run verify` passed after the exact-suffix correction. A fresh-context review found four issues; all are fixed. The method and timestamp policy stay **provisional** until the claimed KB consultation runs (see the merge decision below).
- **Merge decision (2026-11-25, card `orphan-pr-vertex-research-public-411`):** the merge hold is lifted. The claim of card `kbchat-default-omp-vertex` is a local commit on no remote branch, so the claimed consultation cannot run yet. Both earlier KB answers found no source on this subject, the method follows the repository contract and code, and the change is research-only. Card `kbchat-vertex-claim-ship-and-iv-consult` ships the claim and runs the consultation; if the KB answers differ, a new PR changes the policy.

## Goal

Keep the newest-run source note separate from provenance of rows in the exact sample used by Vol Context. Preserve IV values. Unverified source history must never appear clean.

## Evidence and fixed behavior

- The worktree now stores source atomically on each daily IV row. Existing rows remain `unknown` unless exact row-level evidence proves their source.
- `optionIvDaily` selects the newest 252 rows per underlying and `volContext` uses those same rows. Preserve the query's inclusive `asOf` bound, ranking, output ordering, 252nd row, and null-IV behavior. Strip the internal `session` field from API output.
- The run ledger can support `lastFallbackAt` only when the exact successful Yahoo-row warning is present and a non-empty run wrote every received row. This run-level fact does not prove current row membership or a surviving row's source.
- Do not use a date cutoff, warning absence, or aggregate counts to classify legacy rows. Keep a row unknown unless exact row-level evidence proves its source.
- Keep raw source private. The public history state is `affected`, `clean`, or `source_unverified`, computed from the same ranked sample as the percentile.

## Method and route decision (provisional)

- The owner approved the current OMP default and the fixed QuantFinanceToGo / DeepEdge Intelligence origins. Spreads Trading remains excluded and the allowlist is unchanged. The required consultation waits for a server-issued one-task claim from card `kbchat-default-omp-vertex`.
- Two earlier KB threads ran before that claim. Live kb-chat health then reported the current OMP route as Claude over OMP, and both threads' provenance metadata showed only the approved origin. These threads do not count as the required consultation. The private report records route evidence and both answers.
- Both KB answers said their retrieved sources did not cover Vertex, OpenBB, Yahoo fallback, or IV-history provenance. Their suggestions are assumptions, not source-backed rules. Use the repository contract and code to resolve the method.
- Keep legacy rows `unknown`; the current ledger has no row-specific mapping to prove their source.
- Define `lastFallbackAt` as the `finishedAt` of the latest `cboe-option-iv` run with status `ok` or `partial`, `rowsReceived > 0`, `rowsWritten === rowsReceived`, and a warning that contains the exact successful Yahoo-row suffix. The skip/carry-forward warning does not match. This is an audit event only and cannot clear the sample caveat.

## Phases

1. Add the source column with the `unknown` default, the backward-compatible ingest contract, and v1/v2 fixtures. The sample-derived history query ships in the same change as the source column (see the canonical design, Phase 1).
2. Add producer source tags and validation. Keep rollout order migration → compatible API → producer; this task does not deploy or restart services.
3. Use the already-approved current-default route with only QuantFinanceToGo and DeepEdge; keep Spreads Trading excluded and do not change allowlists. The owner selected the fixed two-origin boundary, so no task-specific server claim is added.
4. Record both KB answers, their provenance, and the route in the private method report. Treat their lack of relevant evidence as a limit, not as a rule.
5. Apply the code-backed source mapping, history-state rules, and fully-written fallback timestamp semantics. Update the canonical design, implement the sample-derived history/status fields and UI, and keep legacy source unknown.
6. Run focused tests and generated-artifact checks, then Graphify, drift, full repository verification, and fresh-context review. Do not deploy or restart a service.
7. Follow the task's PR-only flow and required CI, review, and merge gates.

The Create/Modify file list, exact implementation steps, generated commands, and test cases are in the [canonical EGM-resolved design](openbb-iv-history-caveat.md#detailed-implementation-plan). Generate migrations with `bun run db:generate`; use `bun run openapi:generate` and `bun run openapi:check` for OpenAPI.

## Acceptance checks

- The history state and percentile use the exact same newest-252-row sample. Test the inclusive `asOf` boundary, null-IV rows, and the 252nd row.
- A known Yahoo row in the sample keeps the state `affected`, even when another row is unverified. `clean` requires a non-empty sample whose source is known to be Cboe. A returned row with no Yahoo proof and at least one unverified source is `source_unverified`; an empty sample produces no `ivDaily` row or history state.
- A same-key source replacement is atomic with the IV row. Public results omit raw source and preserve numeric values.
- The cross-version fixture proves that a legacy producer payload without `source` is accepted as `unknown`, and that a tagged payload preserves its valid source.
- Legacy source is assigned only from exact row-level evidence. Run-level counts, warning absence, and date cutoffs cannot establish it.
- Test the audit timestamp predicate: exact successful Yahoo-row warning, non-empty fully written run, eligible statuses, zero rows, skipped fallback, incomplete writes, failed/blocked runs, later Cboe recovery, multiple underlyings, the `finishedAt DESC, startedAt DESC, id DESC` order (a DB unit test checks the order terms; runs with equal `finishedAt` return the same timestamp, so a tie cannot change the result), and `null`. `null` means that no qualifying run exists; it does not prove clean or no Yahoo history.
- Missing status or source evidence cannot hide IV values or present an unverified history as clean. A returned row with unverified source uses `source_unverified`.

## Verification and delivery

- Pre-rebase verification on `7409a24195ae096a62041a2c9d504f6a35ca26e8`: 77 Vitest tests, 162 OpenBB Python tests (one deprecation warning), and 15 Postgres integration tests passed; database/OpenAPI checks and Graphify passed. A 7,000-row query comparison on that base measured p95 6.626→6.967 ms (+5.15%) and shared hits 128→135 (+5.5%) with the same sequential-scan/incremental-sort plan; the 20% threshold did not trigger, so no index was added.
- On current base `cc58ad77eb94cae02b655dd1a5492d9854233fcc`, the build, Graphify update/check/verify (five queries), Drizzle generation (no schema changes), `db:check`, `openapi:check`, `git diff --check`, and focused headless Markets E2E passed. The E2E uses synthetic rows in the disposable test database and mocks only the unrelated `ibkrMonitor.volatility` call.
- The canonical `scripts/ci/research-python.sh` run passed all six locked suites; the OpenBB suite passed 266 tests with one warning. Full `bun run verify` passed before the final suffix correction. After the correction, DB unit (22 tests) and Postgres integration (15 tests) pass, including the `rate 4x` near-miss exclusion. A fresh-context EGM drift rerun at `4edd340515348808512d9fbf7fe0720b970a047d` found no drift. Full `bun run verify` passed after the exact-suffix correction (20,062 unit/contract, 684 integration, 197 browser tests). A fresh-context review found four issues; all are fixed. Hosted PR CI is pending.
- PR #408 merged first with migration `0092_price_freshness_state`; this branch was updated from the remote base and its migration renumbered to `0096_common_mikhail_rasputin` with `bun run db:renumber`. `bun run db:generate` reports no schema changes.
- This is a research-only change. Do not deploy or restart a service.
