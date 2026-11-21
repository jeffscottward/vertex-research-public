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

The plan and target policy sections are updated. Run the final documentation check and source/diff checks, confirm no remaining drift, and complete a fresh-context technical review before commit and PR CI.

## Post-resolution correction

A final review check found that the trigger diagram could imply selected CI verification lanes alone made a PR mergeable. `docs/deploy.md` requires eight branch-protection checks. The diagram and plan now state that lane success is only CI verification evidence and that all eight checks still gate mergeability. This in-scope correction is separate from the EGM findings and the finding totals above.
