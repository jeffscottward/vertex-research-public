# Stage 9 — Codebase Details Review

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

**Status: completed.** A fresh-context `egm-codebase-details` reviewer checked DetailedRange 18–24 against the named workflow, planner, and root scripts.

## Prioritized findings

### Finding 1 — Major — `egm-codebase-details`

- **Affected scope:** Plan lines 11–14; `.github/workflows/ci.yml` and `scripts/ci/ci-changes.sh`.
- **Discrepancy:** Full runs include 14 baseline coverage shards and may include conditional `acceptance` and `debate-five-turn` shards. Changed-file listing failure, unknown input, or an empty list selects the full lane. The plan risks implying that the four verification lanes exhaust all work in a full run.
- **Guidance:** State the conditional shards and fallback behavior, or clearly bound the plan's use of “four verification lanes” so it does not imply those lanes exhaust the full run.

### Finding 2 — Nit — `egm-codebase-details`

- **Affected scope:** Plan line 20.
- **Discrepancy:** The plan lists document sections but does not identify exact repository-relative write paths. It also does not name the docs-check command.
- **Guidance:** State the exact files to modify and name `bun run docs:check`.

### Finding 3 — Nit — `egm-codebase-details`

- **Affected scope:** Plan line 24; `.github/workflows/ci.yml` manual and PR gates.
- **Discrepancy:** The plan lacks a precise pass criterion for source consistency and diff scope. Manual `ci-gate` and required PR `ci-gate` check different results based on lane selection.
- **Guidance:** Require documented trigger, lane-selection, and deployment-evidence claims to match the cited sources and keep edits inside the declared documentation-only boundary.
