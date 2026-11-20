# Runner release label pin and canary for Vertex CI

- **Author:** the owner (written by the job agent of card `vertex-timeout-scale-stale-under-load`, batch item `vertex-ci-runner-image-canary`)
- **Date:** 2026-11-20

## Overview

On 2026-11-17 GitHub moved the hosted runner label `ubuntu-latest` from Ubuntu 24.04 to Ubuntu 26.04. The required check `ci-gate` of the public Vertex repository then failed on every pull request with no repository change. The concept: every workflow job names an explicit Ubuntu release label, and a separate workflow that is never required reports when `ubuntu-latest` names a release that no workflow job uses yet. A move of `ubuntu-latest` then becomes a signal to update the label in a reviewed pull request, not an outage of every pull request.

## Analysis

Seven brainstorm reviewers (design, codebase details, zoom out, comprehension, implementation readiness, structural, inventive catalyst) read the concept against commit `952c5aca`. Their main points, deduplicated:

1. A release label does not freeze the image. GitHub rebuilds each label about weekly, so Chrome, rustup, tzdata and glibc packages still change under `ubuntu-26.04`. The pin protects only against a change of the Ubuntu release. (all 7)
2. "The jobs behind `ci-gate`" means every job in `ci.yml`: an existing invariant test makes `ci-gate` need every other job of the file. `coverage-shards` is one of them and stays on `ubuntu-24.04`. So two labels are in use, and "the canary's expected release equals that label" has no single meaning. (6 of 7)
3. The required checks are not fully known from the repository text. Branch protection of the base branch (read on 2026-11-20 with `gh api`) requires only `ci-gate`; no rulesets exist. `docs/deploy.md` and the invariant test still list template check names (`Analyze`, `CodeQL`, `Dependency Review`) that run on `ubuntu-latest`. A flat rule for every workflow avoids depending on that list. (5 of 7)
4. The canary must be its own workflow file: in `ci.yml` the existing invariant would make it part of `ci-gate`. (5 of 7)
5. Issue writing is a state machine: duplicate issues from overlapping runs, a gradual rollout that flips the observed release between runs, search-index lag, comment noise, and a write token on a job that runs on the image it watches. (6 of 7)
6. Scheduled runs are best effort: GitHub delays or drops them, starts them only from the default branch, and turns them off in public repositories after 60 days without activity. The recorded nightly runs started around 16:30 to 17:00 UTC against a `23 7 * * *` cron. (5 of 7)
7. A canary that compares only release names does not say whether the new image works. Probing Chrome, rustup, the time zone name and glibc would. (4 of 7)
8. A pinned label is later retired by GitHub; then a required job waits or fails. (3 of 7)

Inventive catalyst: the contradiction "stable required checks vs. current image" is resolved by separation in time: the required jobs stay on a reviewed label, and the discovery of the next release runs in a job that is never required. The ideal end state brings Chrome and time zone data from the repository too, so the label only provides kernel and glibc.

## Goals vs. Non-Goals

- **In-Scope Goals:**
  - Every job in every workflow file names a literal `ubuntu-NN.NN` label. One primary label (`ubuntu-26.04`). Exceptions are listed in the invariant test with the job, the label, the card and a public exit condition. The only exception now: `ci.yml` `coverage-shards` on `ubuntu-24.04` until `infra/quant-vps/status/test_collect.py` passes on `ubuntu-26.04` (card `vertex-status-collector-legacy-zone-names`).
  - Jobs of the canary workflow use `ubuntu-latest` and no other label; no other workflow uses `ubuntu-latest`.
  - A canary workflow (schedule twice a day and manual dispatch, token permissions `contents: read` only) fails when the release of `ubuntu-latest` is not among the labels used in the repository's workflow files, and writes the observed release, the image version and the labels in use to the step summary.
  - `docs/deploy.md` "Runners" states the policy and the steps to move the label. The comment of `coverage-shards` in `ci.yml` names the primary label as its target.
- **Out-of-Scope Non-Goals:**
  - Freezing Chrome, rustup, tzdata or glibc (needs installs from the repository; separate cards).
  - Probing whether the new image works (the pull request that moves the label runs the full suite on the new image; that is the real test).
  - Opening or updating a GitHub issue (no write token; see Alternatives).
  - Warning about the retirement of a pinned label.
  - A rig-side watcher that turns a red canary into a tracker card.

## Alternatives Weighed

- **Canary opens or updates one GitHub issue (with a label, list lookup, concurrency group, hidden marker).** Rejected by author: it adds a write token to a scheduled job and a small state machine (dedupe, flapping, comments) for an event that happens about every two years. A failed scheduled run already notifies the account that last changed the workflow's cron, and the step summary carries the same facts. Revisit if a red canary goes unnoticed.
- **Canary probes Chrome, rustup, zone names and glibc on `ubuntu-latest`.** Rejected by author for this change: the label-move pull request runs the complete CI on the new image, which covers more than a probe list. A probe list would need its own upkeep.
- **Pin only the jobs behind `ci-gate`.** Rejected: that is every job of `ci.yml`, and the other workflows would still move without review. One flat rule for all workflow files is simpler to state and to test.
- **Canary keeps its own copy of the expected release.** Rejected: two places to change. The canary reads the labels from the checked-out workflow files.
- **Renovate bumps `runs-on` labels.** Rejected by author: a new bot and service; Dependabot cannot do it.
- **Put the canary job in `ci.yml`.** Rejected: the existing invariant makes `ci-gate` need every job of `ci.yml`.

## Key Decisions & Staging for Next Steps

- Auto-decider (owner rule 2026-11-19) made the gate decisions of this brainstorm; no owner question is open.
- One primary label `ubuntu-26.04` and an exception list in `scripts/ci/workflow-invariants.test.ts`.
- Canary file `.github/workflows/runner-image-canary.yml` (no word of the owner-decision path map in the name), job name "Runner image canary", cron twice a day away from 07:23 UTC, `concurrency` without cancel, workflow `permissions: {}`, job `permissions: contents: read`, checkout with `persist-credentials: false`.
- Signal: a failed run plus the step summary. No issue.
- One pull request carries the labels, the invariant, the canary and the docs, because the invariant ties them together.
