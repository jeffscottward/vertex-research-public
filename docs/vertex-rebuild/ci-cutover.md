# Vertex CI cutover to GitHub-hosted runners

Card: `vertex-ci-github-hosted`. Date: 2026-11-04.

## Decision

Owner pick 2026-11-04 (owner Discord message, private): mechanism (a), work directly in the public repository.

- `vertex-research-public` is the development repository. Pull requests open there. CI runs there on GitHub-hosted `ubuntu-latest` runners, which are free for public repositories.
- `vertex-research` (private) is a read-only backup. Archive it later. Never delete it on GitHub.
- The two repositories have unrelated histories (the public copy started as one sanitized snapshot; owner choice 2026-11-02, "Fresh copy without history"). A rebase or merge between them is not possible. Changes move as sanitized tree snapshots or patches.

## Why

On 2026-11-04 Vertex PR CI ran on four rig runners with one job each. One PR needs about 15 jobs, and 9 or more runs were queued. PRs waited more than 1 hour, and other stacks waited behind them.

## Workflow changes

- Every job in `ci.yml`, `codeql.yml` and `dependency-review.yml` runs on `ubuntu-latest`. No job uses a self-hosted runner. `scripts/ci/workflow-invariants.test.ts` fails when a job names `self-hosted` or `rig`.
- Coverage shard reports and Playwright failure evidence move through run artifacts in place of the rig-local store `/var/lib/gh-runner/_shared`. Artifact storage is free for public repositories.
- Gates are unchanged: the same lanes, the same 100% coverage thresholds and ratchet, `ci-gate` as the required check.

## Moving private work to the public repository

Each private change goes through these steps before it reaches the public repository:

1. Export the tree (`git archive`) or the branch diff.
2. Run `~/Documents/reports/vertex-public-audit/sanitize.py` (hosts, tailnet names and addresses, owner e-mail, paid newsletter text).
3. Run `gitleaks` on the result and `~/Documents/reports/vertex-public-audit/scan_tree.py` (IBKR account ids, account snapshots, `private/` paths, keys). A hit blocks the push and is reported.
4. Open the change as a draft PR on the public repository; mark it ready when done; `ci-gate` must be green.

## Runners

The rig runners `rig-vertex` to `rig-vertex-4` stay registered to the private repository. They get no new Vertex jobs because the workflows no longer request them. Runner counts and other repositories are unchanged.

## Open items

- Browser lane: the first hosted run with `BROWSER_TESTS=on` failed 37 of 135 tests (run 41930652852). The lane was also off on the private repository, so no recent green baseline exists. `BROWSER_TESTS` stays `off` until card `vertex-browser-lane-hosted` fixes the suite.

- Deploy: the public tree has placeholder hosts. A deploy from a public checkout needs the real hosts from a private local file (cutover plan blocker 1, `~/Documents/reports/vertex-public-cutover-plan-1102.md`). Until that exists, deploys build from the private checkout at the tree that matches the public head.
