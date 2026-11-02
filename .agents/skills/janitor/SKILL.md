---
name: janitor
description: Use for a structure-only cleanup pass on Vertex Research (names, file names, module layout). Never changes behavior.
---

# Janitor

Keep the repository structure clean so agents copy good patterns. Source idea: Geoffrey Huntley ("janitorial Roomba").

## Scope

- Allowed: rename or move files, rename local identifiers, align test file names with the module they test, fix inconsistent naming (kebab-case files), group stray files into the folder that already holds their siblings, and update the imports and path references that a move requires.
- Forbidden: behavior changes, dependency changes, formatting sweeps, and deletion of tracked source (propose deletions in the PR body instead).
- Never rename, move or edit order, broker, gate, risk, master-rule, live-config or trading code paths: any path that contains `order`, `broker`, `gate`, `risk`, `master-rule`, `live`, `crown` or `config`.

## Conflict rule

The runner (`bun run vertex:janitor`) computes the busy-file list against the repository default branch and gives its path in the prompt. The list holds every file changed by open PRs to the default branch and by `origin/ws/*` branches that share history with it. Do not touch a file on that list, and do not move a file to a path on that list. Do not compute busy files against `main`: that branch has unrelated history.

## Procedure

1. Collect candidates. For each one write one line: `old -> new: rationale`.
2. Keep at most 10 moves per pass. Prefer the moves with the clearest rationale.
3. Use `git mv`. Update every reference (`git grep -n <old basename>`).
4. Verify: `bun run check`, then `pnpm exec vitest run <moved test files>`. Revert any move that breaks a check.
5. Write the list of moves into `JANITOR-REPORT.md` (not committed) for the PR body.
6. If no candidate is safe, change nothing and report "no safe moves" with the reason.

## Runner

`scripts/vertex-janitor.ts` makes a worktree from `origin/<default branch>`, runs one pass and opens a DRAFT PR to the default branch. `--dry-run` prints the base and the busy-file count only. `--no-pr` runs the pass and prints the report without a commit or push. After the pass, the runner checks the staged changes itself: only renames and edits are allowed, and no path may be busy or contain a forbidden word. A violation stops the run before any commit or push. The rig timer `vertex-janitor.timer` runs it every Sunday from the default branch.
