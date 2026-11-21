# CI trigger documentation correction

![The docs change from an outdated PR/manual summary to the observed CI triggers and lanes.](./ci-trigger-before-after.svg)

## Problem

`AGENTS.md` and `ARCHITECTURE.md` describe an older CI lifecycle. `.github/workflows/ci.yml` defines pull-request, protected-branch push, nightly, and manual triggers. The policy text also names a graph verification lane that the current workflow and root verification scripts do not define.

## Observed behavior

- `.github/workflows/ci.yml` runs for pull requests with types `opened`, `synchronize`, `reopened`, and `ready_for_review`; pushes to `vertex/rebuild-darkfactory-20260921`; the daily schedule at 07:23 UTC; and `workflow_dispatch`.
- The planner always runs core. Docs-only changes and draft pull requests can use a core-only run. Code changes on pushes or non-draft pull requests, nightly runs, and manual dispatches select the full lane. If changed-file discovery fails, returns an empty list, or provides unknown input, the planner fails closed to the full lane.
- The four verification checks are `Verification (core)`, `Verification (coverage)`, `Verification (integration)`, and `Verification (browser)`. `package.json` defines matching `verify:core`, `verify:coverage`, `verify:integration`, and `verify:browser` scripts. Full coverage runs baseline shards; `acceptance` and `debate-five-turn` shards are conditional on the event and changed paths, so full runs do not all run an identical shard set.
- Browser verification joins the full lane when repository variable `BROWSER_TESTS` is `on`, or when a manual dispatch sets `browser_tests: on`. The manual input can enable browser checks even if the repository variable is off.
- Deployment evidence requires a manual dispatch on a branch or tag that resolves to the intended deployment SHA. The observed run `head_sha` must equal that SHA, and all four verification checks above must succeed. Set `browser_tests: on` when the repository variable does not enable that check. The manual aggregate gate is named `ci-gate (manual)`; it is distinct from the required pull-request `ci-gate`.
Sources: [CI workflow](../../../../.github/workflows/ci.yml), [lane planner](../../../../scripts/ci/ci-changes.sh), [root scripts](../../../../package.json), [deployment checklist](../../../../docs/deploy.md), [AGENTS.md](../../../../AGENTS.md), and [ARCHITECTURE.md](../../../../ARCHITECTURE.md).

## Implementation Plan

Modify only these policy sections: `AGENTS.md` work-sequence step 9 and lifecycle gates (the canonical lifecycle, CI script/trigger paragraph, and exact-SHA deployment paragraph); `ARCHITECTURE.md` “CI lanes” summary and trigger diagram, plus ADR-011. Update them to match the triggers and lane behavior above. Keep the four verification checks distinct from conditional coverage shards, and show that passing those verification checks alone does not satisfy branch protection. Do not change workflow code, branch protection, security workflows, or deployment behavior.

## Verification and limits

Pass when `bun run docs:check` succeeds; every documented trigger, lane-selection rule, and deployment-evidence claim matches `.github/workflows/ci.yml`, `scripts/ci/ci-changes.sh`, `package.json`, and `docs/deploy.md`; the diagram does not imply verification success alone makes a PR mergeable while branch protection requires eight checks; and the policy diff stays within the named sections. Keep all task design and review artifacts inside this directory. This is documentation-only, so no artificial test is needed. Defer Graphify, the repository's codebase-graph tool, because this change alters no code, contracts, symbols, database relationships, or architecture behavior ([AGENTS.md work sequence](../../../../AGENTS.md#work-sequence)).
