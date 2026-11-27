# Goldfish Annotated Review Report

**Status:** resolved
**Target:** `docs/vertex-rebuild/designs/vertex-public-main-node-modules-dangling/plan.md` (`full file`)
**Review mode:** Consolidated report with all review rubrics (`egm-zoom-out` + `egm-inventive-catalyst`, `egm-comprehension`, `egm-design` + `egm-structural` + `egm-style`, `egm-implementation-readiness`).
**Resolution mode:** Auto accept (standing rule: apply all `PROPOSE FIX` edits; record `CONTEST` and `DECLINE`; 0 `ESCALATE` findings).
**Counts:** 13 `PROPOSE FIX` applied (2 Blockers, 9 Majors, 2 Nits), 1 `CONTEST`, 1 `DECLINE`, 0 `ESCALATE`.

## Prioritized Findings & AI Suggestions

### [Issue 1] [`egm-implementation-readiness`, `egm-design`, `egm-style`] - Severity: Blocker
* **Affected Scope:** `plan.md` Acceptance criteria #4 vs `scripts/janitor/weekly.ts:416-446`
* **Discrepancy Description:** `vertex-janitor-run --dry-run` returns at line 416 before creating a worktree, running `pnpm install`, or cleaning up in `finally`, so it does not exercise any changed line.
* **Rationale:** Live verification must exercise real worktree creation, isolated `pnpm install`, and cleanup, then verify `main/node_modules/.modules.yaml` and `/tmp/.pnpm-store` absence.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid blocker. `--dry-run` only proves launcher fetch and busy-file listing.
* ***Proposed Edit:***
  * Location: `plan.md` Acceptance criteria and Execution order
  * Change: Keep `vertex-janitor-run --dry-run` specifically for verifying that the launcher pulls the merged commit from `origin/vertex/rebuild-darkfactory-20260921`, and add a real-worktree isolated `pnpm install` + teardown live verification step plus post-check of `main/node_modules/.modules.yaml` (`virtualStoreDir` and `storeDir`) and `/tmp/.pnpm-store` absence.

### [Issue 2] [`egm-implementation-readiness`, `egm-design`, `egm-zoom-out`] - Severity: Blocker
* **Affected Scope:** `plan.md` Root cause, Scope §2, Risks and mitigations; `before-after.svg`
* **Discrepancy Description:** Keeping `${wt}` on `/tmp` (`tmpfs`, cross-filesystem from `/home`) forces full 1.4 GB file copies into RAM, requires custom `pnpm store path` + `/v<n>` stripping, and falling back to omitting `--config.store-dir` silently reintroduces `/tmp/.pnpm-store/v11`. Child `pnpm` commands run by `omp` in `/tmp` also lack `--config.store-dir`.
* **Rationale:** Moving the ephemeral worktree onto the XDG cache directory on the host filesystem (`${XDG_CACHE_HOME:-$HOME/.cache}/vertex-research-janitor/<stamp>`, ignoring relative `XDG_CACHE_HOME`, falling back to `/tmp/vertex-research-janitor-<stamp>` only when neither is set) keeps `${wt}` on the same `btrfs` filesystem as `~/.local/share/pnpm/store/v11`, allowing native hardlinks (~0 RAM, ~9 s) and ensuring every child `pnpm` command inside `omp` uses the host store without creating `/tmp/.pnpm-store`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid blocker and superior design that removes the cross-filesystem contradiction and eliminates the store-dir helper and fail-open fallback entirely.
* ***Proposed Edit:***
  * Location: `plan.md` Scope §2, Risks and mitigations, and `before-after.svg`
  * Change: Specify `resolveWorktreePath(env, stamp)` placing `${wt}` in `${XDG_CACHE_HOME:-$HOME/.cache}/vertex-research-janitor/<stamp>` (absolute paths only, `/tmp` fallback only when neither `XDG_CACHE_HOME` nor `HOME` is set), installing isolated dependencies with `pnpm install --frozen-lockfile --prefer-offline --config.virtual-store-dir=node_modules/.pnpm --config.confirm-modules-purge=false` (`inherit: true`).

### [Issue 3] [`egm-implementation-readiness`, `egm-design`, `egm-structural`] - Severity: Major
* **Affected Scope:** `plan.md` Scope §1, Risks and mitigations, Acceptance criteria #1
* **Discrepancy Description:** Missing rollback/recovery steps, missing execution ordering, missing verification of `storeDir` (not just `virtualStoreDir`) in repaired `main/node_modules/.modules.yaml`, missing post-claim re-verification before running `pnpm install` (TOCTOU), and missing exact claim/release and verification commands.
* **Rationale:** Without explicit claim/release commands, post-claim re-checks, `storeDir` verification, and rollback steps, an operator could race against another process or leave `main/node_modules` purged or locked.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid major gap.
* ***Proposed Edit:***
  * Location: `plan.md` Execution order, Verification, and Rollback sections
  * Change: Add dedicated Execution Order, Verification, and Rollback sections with exact `fm claim` / `fm release` commands, post-claim re-check, absolute path `/home/jeffscottward/Github/trading/vertex-research-public`, `storeDir` + `virtualStoreDir` verification, and rollback procedures (pause `vertex-janitor.timer` instead of reverting to `ln -s`).

### [Issue 4] [`egm-implementation-readiness`, `egm-design`] - Severity: Major
* **Affected Scope:** `plan.md` Scope §2; `scripts/janitor/weekly.ts:12-16, 303-306, 416-446, 496-506`
* **Discrepancy Description:** Helper signatures, `must()` label, `RunOptions.inherit`, execution point relative to `worktree = true`, and worktree removal failure fallback (`git worktree remove --force --force` + `rm -rf` + `git worktree prune`) were underspecified.
* **Rationale:** Leaving contracts and failure cleanup underspecified causes implementation drift and leaves orphaned worktrees if a nested `.git` folder exists in `node_modules`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid major gap.
* ***Proposed Edit:***
  * Location: `plan.md` Scope §2
  * Change: Specify exported `resolveWorktreePath(env, stamp)`, exact `pnpm install` arguments and `inherit: true` with `must(..., "pnpm install")` immediately after `worktree = true` and `git rev-parse HEAD`, and `finally` cleanup using `git worktree remove --force --force` with `rm -rf` + `git worktree prune` fallback when removal exits non-zero.

### [Issue 5] [`egm-implementation-readiness`, `egm-zoom-out`, `egm-design`] - Severity: Major
* **Affected Scope:** `plan.md` Scope §2; `scripts/janitor/weekly.ts:308-325, 499-500`; `scripts/janitor/weekly.test.ts:45-74, 416-447, 556-628`
* **Discrepancy Description:** Test plan omitted `cwd === WT` assertions, explicit ordering assertions (`worktree add` < `pnpm install` < `omp` < `git commit` < `worktree remove`), install-failure cleanup assertions (`omp` not called + worktree removed + branch deleted), real-git tests for real `node_modules/` + nested `apps/*/node_modules/` directories and `git worktree remove --force --force`, and updating stale symlink comments in `weekly.ts` and `weekly.test.ts`.
* **Rationale:** Real-directory behavior and `cwd` invariants must be tested explicitly and comments must match the code.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid major gap.
* ***Proposed Edit:***
  * Location: `plan.md` Scope §2 and Acceptance criteria
  * Change: Add explicit unit-test and real-git test requirements plus updating `weekly.ts` JSDoc/comments and specifying the exact Vitest coverage command (`pnpm exec vitest run --coverage scripts/janitor/weekly.test.ts`).

### [Issue 6] [`egm-comprehension`] - Severity: Major
* **Affected Scope:** `plan.md` throughout (terminology, branch name, execution chain, gates)
* **Discrepancy Description:** Undefined terms and links: `fm claim`/`fm release`, `vertex-janitor.timer` -> `~/.local/bin/vertex-janitor-run` -> `scripts/vertex-janitor.ts` -> `scripts/janitor/weekly.ts`, `origin/vertex/rebuild-darkfactory-20260921` base branch, EGM/public-names/`ci-gate`/`scripts/merge-pr`, `omarchy-rig`, inline isolation rule, and `stagePass` role.
* **Rationale:** Fresh readers need self-contained context to execute and audit the plan without institutional memory.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid comprehension gaps; never contest comprehension gaps.
* ***Proposed Edit:***
  * Location: `plan.md` Problem, Root cause, Scope, Execution order, Acceptance criteria
  * Change: Define each term briefly inline on first use and introduce `origin/vertex/rebuild-darkfactory-20260921` in the context section.

### [Issue 7] [`egm-structural`, `egm-style`] - Severity: Major
* **Affected Scope:** `plan.md` lines 35, 38, 47-50, 56; `before-after.svg` lines 48, 58, 73-74, 110, 130, 141, 154
* **Discrepancy Description:** Malformed nested backticks in inline code spans; `before-after.svg` text overflow and flag/path mismatches (`main/.modules.yaml`, `--frozen`, `--store-dir`); undated audit counts and uncalibrated pre-verified claims; unrelated trading disclaimer in Out of scope.
* **Rationale:** Broken Markdown and mismatched SVG labels confuse readers; claims must be dated and calibrated.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Valid structural and style defects.
* ***Proposed Edit:***
  * Location: `plan.md` and `before-after.svg`
  * Change: Use fenced code blocks for shell commands and clean inline spans without nested backticks; redraw `before-after.svg` to fit every label cleanly and reflect the XDG cache hardlink design with exact flags; date the 2026-11-27 audit snapshot; drop the unrelated trading-paths bullet and `fm-spawn` parenthetical.

### [Issue 8] [`egm-zoom-out`] - Severity: Nit
* **Affected Scope:** `plan.md` Scope §2 (`--config.virtual-store-dir=node_modules/.pnpm`)
* **Discrepancy Description:** Explicitly passing `--config.virtual-store-dir=node_modules/.pnpm` on a fresh real directory is redundant because it is pnpm's default.
* **Rationale:** Harmless defense-in-depth flag, minor config noise.
* ***AI Suggestion:*** CONTEST
* ***Justification:*** Keeping `--config.virtual-store-dir=node_modules/.pnpm` protects the janitor worktree against any host/env pnpm config override (such as `npm_config_virtual_store_dir` or global virtual store settings) and matches the repo's documented repair command.

### [Issue 9] [`egm-zoom-out`] - Severity: Nit
* **Affected Scope:** `plan.md` Scope §2 (granularity of helper/test details)
* **Discrepancy Description:** Plan includes function signatures and unit-test case lists.
* **Rationale:** High-level contracts are more resilient to refactoring.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** This is a one-page bug-fix plan with a 100% coverage gate; `egm-implementation-readiness` explicitly required concrete helper contracts, error labels, and test invariants to prevent drift.
