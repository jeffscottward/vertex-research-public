#!/usr/bin/env bash
# Decide which CI lanes a run needs (card vertex-ci-queue-pathfilter, 2026-11-02).
#
#   ci-changes.sh classify   Read changed paths on stdin; print "docs" or "code".
#   ci-changes.sh plan       Used by the `changes` job in ci.yml. Writes the outputs
#                            heavy=true|false, draft=true|false and
#                            exclude=<matrix exclude JSON> to GITHUB_OUTPUT.
#
# The light lane (core) always runs. The full lane (coverage shards, coverage merge,
# integration, browser) runs when code changed, except on a pull request that is a
# draft when the run plans its lanes. A manual run always takes the full lane. Any
# error or unknown input means "code" and "not a draft".
set -euo pipefail

# A path is documentation when it is a Markdown file anywhere, or a non-code file
# under docs/, research/ or plans/. Code and data files under those folders
# (for example research/master-rules/*.mjs or research/baskets/*.json, which tests
# read) still count as code.
classify() {
  local path any=0
  while IFS= read -r path || [[ -n "${path}" ]]; do
    [[ -z "${path}" ]] && continue
    any=1
    # Agent instruction files are checked by unit tests (agent-docs-invariants), and the
    # root README by the operations test readme-invariants.
    case "${path}" in
      .agents/* | .claude/* | AGENTS.md | */AGENTS.md | CLAUDE.md | */CLAUDE.md | README.md) echo code; return 0 ;;
      *.md) continue ;;
    esac
    case "${path}" in
      docs/* | research/* | plans/*)
        case "${path}" in
          # Any JSON format (rule 13 gate), matched without regard to case.
          *.*[jJ][sS][oO][nN]*) ;;
          *.ts | *.tsx | *.js | *.mjs | *.cjs | *.mts | *.cts | *.civet | *.py | *.rs | *.yml | *.yaml | *.toml | *.sql | *.sh) ;;
          *) continue ;;
        esac
        ;;
    esac
    echo code
    return 0
  done
  # No changed paths is unknown, so take the full lane.
  if ((any == 0)); then echo code; else echo docs; fi
}

changed_paths() {
  case "${EVENT}" in
    pull_request)
      # The files API lists at most 3000 files. Compare with the PR's own count so
      # a cut list is never read as docs-only. A rename counts both names.
      local total listed
      total="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.changed_files')" || return 1
      listed="$(gh api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/files" --jq '.[] | [.filename, .previous_filename // empty] | @tsv')" || return 1
      if (($(grep -c . <<<"${listed}") < total)); then return 1; fi
      tr '\t' '\n' <<<"${listed}"
      ;;
    push)
      if [[ -z "${BEFORE:-}" || "${BEFORE}" =~ ^0+$ ]]; then return 1; fi
      local out count
      out="$(gh api "repos/${REPO}/compare/${BEFORE}...${AFTER}")" || return 1
      count="$(jq '.files | length' <<<"${out}")"
      # The compare API lists at most 300 files; a longer list may be incomplete.
      if ((count >= 300)); then return 1; fi
      jq -r '.files[] | .filename, (.previous_filename // empty)' <<<"${out}"
      ;;
    *) return 1 ;;
  esac
}

# Print "true" when this run is for a pull request that is a draft now, else "false".
# The draft flag in the event (DRAFT) can be stale. `gh pr ready` one second after
# `gh pr create --draft` starts two runs, and the run for the draft event can cancel
# the run for the ready event (PR #84, card vertex-ci-draft-ready-race). So a run for
# a draft event asks GitHub for the state now. Only the answer "true" keeps the light
# lane. A run for a ready event never asks: it always counts as not a draft.
draft_now() {
  local live
  if [[ "${EVENT}" != "pull_request" || "${DRAFT:-false}" != "true" ]]; then
    echo false
    return 0
  fi
  live="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.draft')" || live=unknown
  if [[ "${live}" == "true" ]]; then echo true; else echo false; fi
}

plan() {
  local kind heavy exclude draft
  if [[ "${EVENT}" == "workflow_dispatch" ]]; then
    kind=code
  elif paths="$(changed_paths)"; then
    kind="$(classify <<<"${paths}")"
  else
    echo "Could not list the changed files; taking the full lane."
    kind=code
  fi
  draft="$(draft_now)"
  heavy=false
  if [[ "${kind}" == "code" && "${draft}" != "true" ]]; then heavy=true; fi

  local lanes=()
  if [[ "${heavy}" != "true" ]]; then lanes+=('{"lane":"integration"}'); fi
  if [[ "${heavy}" != "true" || "${BROWSER_TESTS:-}" != "on" ]]; then lanes+=('{"lane":"browser"}'); fi
  exclude="[$(IFS=,; echo "${lanes[*]}")]"

  echo "Event ${EVENT}, draft in the event ${DRAFT:-false}, draft now ${draft}, changes ${kind}: heavy=${heavy}, exclude=${exclude}"
  {
    echo "kind=${kind}"
    echo "heavy=${heavy}"
    echo "draft=${draft}"
    echo "exclude=${exclude}"
  } >>"${GITHUB_OUTPUT}"
}

case "${1:-}" in
  classify) classify ;;
  plan) plan ;;
  *) echo "usage: $0 classify|plan" >&2; exit 2 ;;
esac
