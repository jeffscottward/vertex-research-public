# Stage 7 — Critic Review

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

**Status: completed.** Three fresh-context reviewers examined FeatureRange 1–17.

## Prioritized findings

### Finding 1 — Major — `egm-design`

- **Affected scope:** Lines 11–14 and 20, “Observed behavior” and “Implementation Plan.”
- **Discrepancy:** The plan omits the `pull_request` event types, the planner's full-lane fallback when changed-file listing fails, and the fact that acceptance and debate coverage shards are selected conditionally. This could make “full run” sound like one fixed set of shards.
- **Recommendation:** Clarify the trigger and fallback details that matter to the policy edits, and avoid implying that every full run executes the same shard set.

### Finding 2 — Major — `egm-design`

- **Affected scope:** Lines 14 and 20, deployment evidence.
- **Discrepancy:** The plan says all four lanes must pass, but it does not state explicitly that the manual run must target the branch or tag resolving to the intended deployment SHA and that the observed `head_sha` must equal that SHA.
- **Recommendation:** State the ref and SHA relationship directly, and require successful results for all four lanes.

### Finding 3 — Nit — `egm-design`

- **Affected scope:** Lines 22–24, “Verification and limits.”
- **Discrepancy:** The plan lists checks but does not define their success criterion.
- **Recommendation:** State that each corrected claim must match the referenced workflow, planner, and package scripts, and that no change may fall outside the declared documentation scope.

### Finding 4 — Major — `egm-structural`

- **Affected scope:** Lines 11–17, “Observed behavior.”
- **Discrepancy:** The manual-dispatch browser input description could be read as if every manual dispatch sets `browser_tests` to `on`.
- **Recommendation:** Say that the browser lane runs on manual dispatch only when the `browser_tests` input is set to `on`.

### Finding 5 — Nit — `egm-structural`

- **Affected scope:** Line 12.
- **Discrepancy:** “Docs-only and draft pull requests can use the core-only lane” does not state directly that core always runs and the planner excludes heavy lanes for those cases.
- **Recommendation:** Name the always-run core lane and describe which lanes are excluded.

### Finding 6 — Major — `egm-style` (contested during resolution)

- **Affected scope:** Lines 13–14, deployment lane count.
- **Discrepancy:** The reviewer says the plan's four-lane deployment check conflicts with `AGENTS.md`'s five-lane requirement.
- **Recommendation:** The reviewer recommends keeping five lanes and separating them from four package scripts. This recommendation is pending evidence review; the plan cites the live workflow and package scripts, and the stale `AGENTS.md` wording is the defect being corrected.

### Finding 7 — Nit — `egm-style`

- **Affected scope:** Line 7, “Problem.”
- **Discrepancy:** “The workflow now runs” does not name the workflow file that defines the observed triggers.
- **Recommendation:** State that `.github/workflows/ci.yml` defines the listed triggers.

## Reviewer status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-structural` | completed |
| `egm-style` | completed |
