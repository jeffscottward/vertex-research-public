# EGM Review Resolution

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

**Mode:** Auto accept, as required by the standing resolution rule. Apply each evidence-supported PROPOSE FIX. Keep CONTEST and DECLINE findings recorded. **Owner escalation:** none; workflow and script sources resolve the open questions.

## Findings resolved

### Accepted — apply to plan and implementation

1. **Stage 6 Nit, Stage 8 Nit, Stage 9 readiness Nit, Stage 9 codebase Nit, Stage 9 style Nit:** name `bun run docs:check`; link Graphify to the repository guidance and define it as codebase-graph tooling.
2. **Stage 7 design Major, Stage 7 style Nit, Stage 9 readiness Major:** name `.github/workflows/ci.yml` and list its four PR event types, protected-branch push, daily schedule, and manual dispatch. State exact manual browser-input behavior.
3. **Stage 7 structural Nit and Major, Stage 9 design/readiness Major, Stage 9 codebase Major:** explain core always runs; docs-only and draft PRs can be core-only; manual/nightly runs take the full lane; code runs take the full lane unless the PR is a draft. Explain fail-closed changed-file discovery. Distinguish the four verification lanes from coverage shard work: the baseline shards run in the full coverage lane, with acceptance and debate-five-turn shards selected conditionally by event and changed paths.
4. **Stage 7 design Major, Stage 9 readiness Major, Stage 9 codebase Nit:** state that deployment evidence is a manual dispatch against a branch/tag resolving to the intended deployment SHA, the run's observed `head_sha` must equal that SHA, and all four named verification checks must pass. Require `browser_tests: on` when the repository variable does not enable browser checks. Preserve that the manual gate label is distinct from the required PR gate.
5. **Stage 7 design Nit, Stage 9 readiness/style Major, Stage 9 codebase Nit:** define executable source-consistency, check, and diff-boundary acceptance criteria. Name the exact `AGENTS.md` and `ARCHITECTURE.md` sections. Keep the change documentation-only and defer codebase-graph generation for the reason given in repository guidance.
6. **Stage 7 structural Major, Stage 9 style Major:** map trigger and lane claims to `.github/workflows/ci.yml`, `scripts/ci/ci-changes.sh`, and `package.json`; deployment claims also cite `docs/deploy.md`.

### Contested — preserve with evidence

- **Stage 7 `egm-style` Major:** recommendation to preserve five verification lanes and separate them from the four root scripts. **CONTEST.** The implementation evidence contradicts this recommendation: `package.json` defines `verify` as `verify:core`, `verify:coverage`, `verify:integration`, and `verify:browser`; `.github/workflows/ci.yml` exposes the matching four verification lane checks; and `docs/deploy.md` lines 47 and 60–63 names the same four required CI lanes. The legacy five-lane text is the defect under repair. Retain four verification lanes and explain coverage shards separately.

## Review totals

- Stage 5: two reviewers, no findings.
- Stages 6–9: 20 raw findings — 8 Major and 12 Nits; one Major is contested above. Duplicate recommendations are consolidated in the accepted actions.
- **Accepted:** all remaining evidence-supported recommendations.
- **Contested:** one source-conflicting five-lane recommendation.
- **Declined:** none.
- **Escalated to owner:** none.

## Follow-up verification

The original documentation and source checks passed before the exact-head review. The review below found and resolved one infographic label error. Run the formatting, documentation, source, and diff checks again and obtain a fresh-context review on the corrected commit before PR CI.

## Post-resolution corrections and exact-head review

An earlier exact-head correction relied on the eight-check branch-protection example in `docs/deploy.md`. The final review found that example configures `jeffscottward/darkfactory/main`, not the Vertex branch. The current Vertex rule is corrected in the dated post-resolution note below; this change is separate from the EGM findings and their totals.

A fresh-context review of exact head `f90be11764683a8d5020fae08d5253db80bf4156` found one P2 infographic error: the before-panel indicated that no push trigger existed, although the base `ARCHITECTURE.md` already documented the live-branch push trigger. The base CI section did not list nightly CI. **Accepted and fixed:** the before-panel now shows pull-request and `Push + manual` triggers, with the note `Nightly not listed`. These labels match the base documentation.

### 2026-11-21 exact-head corrections

A review of intermediate head `58131d4abf5b641be0f36967771bad20347aa4ea` found a P2: the docs said failed, unknown, or empty path discovery always selects the full lane. `scripts/ci/ci-changes.sh` sets `kind=code` on discovery failure or an empty path list, but a `draft_now()` result confirmed as `true` keeps `heavy=false`. The docs now state that a pull request confirmed by GitHub to remain a draft stays core-only; unconfirmed draft status is treated as non-draft.

The final review of `8d4a62cdd3e1317f49125abad2e4f3165f63fc38` found a P2 in the merge-gate description. `docs/deploy.md` configures eight checks for `jeffscottward/darkfactory/main`. A live GitHub query on 2026-11-21 found strict required status `ci-gate` for `vertex/rebuild-darkfactory-20260921` and no applicable rulesets. The updated docs show that current observation and tell readers to inspect live rules before every merge.

A fresh-context review of the follow-up diff found one P2: the infographic label `Docs/draft PR: core only` failed to distinguish docs-only changes from code changes in pull requests whose draft status GitHub confirms. The label now reads `Docs-only / GitHub-confirmed draft PR: core only`, matching `scripts/ci/ci-changes.sh`, which treats unconfirmed draft status as non-draft and selects full verification.

The post-resolution note and traceability row in `consolidated_review_report.md` now match the live Vertex `ci-gate` evidence. The original stage-specific EGM finding reports remain unchanged as historical evidence, and the post-resolution corrections do not change EGM finding totals.
