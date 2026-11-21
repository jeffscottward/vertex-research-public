# EGM Drift Report — 2026-11-21

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

**Result: Two infographic issues were found and corrected during review. Post-fix result: No remaining drift detected.** The first diagram connected selected verification lanes directly to a mergeable state. The final diagram separates CI verification success from branch-protection merge eligibility. A later exact-head review also found that the before-panel wrongly said the push trigger was absent; the base documentation already listed pull requests, manual dispatch, and live-branch pushes, but not nightly CI. The before-panel now reflects that trigger set.

## Documents compared

- `plan.md` — accepted triggers, planner behavior, four verification checks, deployment evidence, scope, and acceptance criteria.
- `resolution_report.md` and `consolidated_review_report.md` — accepted findings and the source-backed contest of the stale five-lane recommendation.
- `AGENTS.md` — work-sequence step 9 and lifecycle gates.
- `ARCHITECTURE.md` — CI lanes summary, trigger diagram, and ADR-011.

## Source evidence

- `.github/workflows/ci.yml` defines pull-request events (`opened`, `synchronize`, `reopened`, and `ready_for_review`), push to `vertex/rebuild-darkfactory-20260921`, the daily `23 7 * * *` schedule, manual dispatch, and the browser input. The workflow names the manual aggregate `ci-gate (manual)`.
- `scripts/ci/ci-changes.sh` always selects core; uses changed paths for PR and push events; selects full for code changes outside draft PRs and for schedule/manual runs; and fails closed to full on failed, unknown, or empty path discovery. Browser joins only a full run when the repository variable or manual input enables it. The acceptance and debate-five-turn coverage shards are conditional on event and changed paths.
- `package.json` defines the four full-verification scripts and composes `verify` from core, coverage, integration, and browser. `docs/deploy.md` requires exact-head full CI evidence for release and names all four verification checks.

## Drift checks

- The target sections state the four current verification checks; they do not retain the obsolete five-lane or graph-lane requirement.
- The target sections state PR, push, nightly, and manual triggers and account for code-changing pushes when describing full-lane selection.
- The target sections distinguish conditional coverage shards and browser selection from the four verification check names.
- The deployment paragraph preserves the manual ref-to-SHA, observed `head_sha`, four-check success, and browser-input requirements.
- The diagram states that passing selected verification lanes does not alone make a PR mergeable; all eight branch-protection checks remain required.
- The before-panel shows the base documentation's pull-request, manual-dispatch, and live-branch push triggers and notes that nightly CI was not listed.
- The policy changes stay inside the sections named in `plan.md`. The only other task files are the supporting plan, infographic, EGM reports, resolution, and this drift report.

Graphify was deferred as planned. This documentation-only change does not alter code, contracts, symbols, database relationships, or architecture behavior. No graph freshness or query claim is made.
