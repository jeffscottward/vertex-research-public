# Stage 6 — Comprehension Test

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

## What this proposes

The plan changes only CI documentation in `AGENTS.md` and `ARCHITECTURE.md`. It names the observed triggers and four verification lanes, explains when runs are core-only or full, and preserves exact-SHA deployment evidence. It excludes workflow, branch-protection, security-workflow, and deployment-behavior changes.

## How the existing system works, per this document

CI runs for pull requests, pushes to a named branch, a daily schedule, and manual dispatch. The planner always runs core; docs-only and draft pull requests can run core-only. Full runs add coverage and integration, with browser checks controlled by a repository variable or manual input. Deployment requires a manual full run on the intended branch or tag, an exact `head_sha` match, and successful results for all four lanes.

## Prioritized findings

### Finding 1 — Nit

- **Affected scope:** Lines 22–24, “Verification and limits.”
- **Discrepancy:** “Repository documentation check” does not name the command, so a new contributor cannot run the stated check without searching the repository.
- **Recommendation:** Name `bun run docs:check`.

### Finding 2 — Nit

- **Affected scope:** Lines 22–24, “Verification and limits.”
- **Discrepancy:** “Graphify” is a project-specific tool name without a definition or link.
- **Recommendation:** Define it inline as the codebase-graph tooling and link to the relevant `AGENTS.md` guidance.
