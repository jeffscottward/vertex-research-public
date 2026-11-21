#!/usr/bin/env bash
# Decide which CI lanes a run needs (card vertex-ci-queue-pathfilter, 2026-11-02).
#
#   ci-changes.sh classify   Read changed paths on stdin; print "docs" or "code".
#   ci-changes.sh plan       Used by the `changes` job in ci.yml. Writes the outputs
#                            heavy=true|false, draft=true|false,
#                            exclude=<matrix exclude JSON>, acceptance=true|false,
#                            debate=true|false, skip_shards=<matrix exclude JSON> and
#                            shard_reports=<number of planned shards> to GITHUB_OUTPUT.
#   ci-changes.sh debate-misses
#                            Read paths on stdin, one per line; print each path that is
#                            not a debate file (touches_debate). Used by the test
#                            scripts/ci/debate-path-closure.test.ts.
#
# The light lane (core) always runs. The full lane (coverage shards, coverage merge,
# integration, browser) runs when code changed, except on a pull request that is a
# draft when the run plans its lanes. A manual run and the nightly run always take the
# full lane. Any error or unknown input means "code" and "not a draft".
#
# The template init acceptance shard (scripts/init/init.acceptance.test.ts, the longest
# job) is part of the full lane only on the nightly run, on a manual run, when a changed
# path is scripts/init.ts, under scripts/init/ or scripts/lib/git-env.ts (init and its
# acceptance test import it), and when the changed files are unknown or the list is empty
# (owner 2026-11-11, card vertex-code-stewardship).
#
# The five-turn debate shard (debate-five-turn in scripts/lib/coverage-shards.ts, one
# test of 10 to 15 minutes) follows the same rule with its own paths: the nightly run, a
# manual run (the exact-SHA run before a deploy), a change to a debate file (see
# touches_debate), and an unknown or empty list of changed files (owner 2026-11-15, card
# vertex-debate-5turn-ci-speed).
set -euo pipefail

# The coverage shards that every full lane runs: twelve hashed Vitest shards and the two
# native-evidence shards. The acceptance and debate-five-turn shards add one each.
BASE_SHARD_REPORTS=14

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

# Succeeds when a changed path on stdin belongs to the template init command.
touches_init() {
  grep -q -E '^scripts/(init(\.ts$|/)|lib/git-env\.ts$)'
}

# Succeeds when a changed path on stdin is a debate file: a research-chat file (the debate
# stores, runtimes, contracts and tests), a Python package that the native consumer of
# the test loads when it starts (services/research adapters, agents, providers and
# knowledge, the control client, the market-data package), the script and the three
# lock files that build its interpreter (the sdk lock includes the services lock, which
# includes the base lock), a shared module that the five-turn test spends most of its
# time in (authorization, persistence core, policy store, transaction read cache,
# predecessor walk, the canonical encoder), another module that the test file imports
# (worker contract, Python test support, timeout scale), or a file that defines or plans
# the shard (this script, the shard list, the coverage lane, the Vitest config, the
# workflow). The first group is not anchored on purpose: each research-chat file counts,
# in any package.
# The rule is a chosen subset, not the import closure of the test: Python modules that
# the consumer's modules import inside a function, other transitive TypeScript imports
# and package.json are left to the nightly run, the manual run before a deploy, and the
# pre-push hook of a machine that has a parity interpreter (the test skips locally
# without one). The first-party Python files that importing the consumer
# (services/research/adapters/tests/chat_debate_bridge.py) loads at module level must
# all match: the test scripts/ci/debate-path-closure.test.ts imports it in the test
# interpreter and names each loaded file that does not (card
# vertex-debate-path-rule-closure-check).
touches_debate() {
  grep -q -E '(research-chat|chat_debate|chat-copies)|^packages/db/src/server/vertex-(authorization|persistence-core|policy-store|transaction-read-cache)\.ts$|^packages/shared/src/vertex/index\.ts$|^packages/api/src/(contracts/vertex-worker|server/research-python\.test-support)\.ts$|^scripts/lib/(coverage-shards|coverage-lane|test-timeout-scale|test-timeout-setup)\.ts$|^services/research/((adapters|agents|providers|knowledge)/|requirements-((sdk|services)-)?linux-py312\.lock$)|^services/(control-client/vertex_control|market-data/vertex_market_data)/|^scripts/coverage-lane\.ts$|^scripts/ci/(ci-changes|test-python)\.sh$|^vitest\.config\.ts$|^\.github/workflows/ci\.yml$'
}

# Prints each path on stdin that touches_debate does not match.
debate_misses() {
  local path
  while IFS= read -r path || [[ -n "${path}" ]]; do
    touches_debate <<<"${path}" || printf '%s\n' "${path}"
  done
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
  local kind heavy exclude draft paths acceptance=true debate=true skip_shards shard_reports
  if [[ "${EVENT}" == "workflow_dispatch" || "${EVENT}" == "schedule" ]]; then
    kind=code
  elif paths="$(changed_paths)"; then
    kind="$(classify <<<"${paths}")"
    # An empty list is unknown input (classify reads it as code): keep the shard.
    if [[ -n "${paths//[[:space:]]/}" ]] && ! touches_init <<<"${paths}"; then acceptance=false; fi
    if [[ -n "${paths//[[:space:]]/}" ]] && ! touches_debate <<<"${paths}"; then debate=false; fi
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

  # No shard runs outside the full lane, so the two path-planned shards are not planned there.
  if [[ "${heavy}" != "true" ]]; then
    acceptance=false
    debate=false
  fi
  local skipped=()
  shard_reports="${BASE_SHARD_REPORTS}"
  if [[ "${acceptance}" == "true" ]]; then shard_reports=$((shard_reports + 1)); else skipped+=('{"shard":"acceptance"}'); fi
  if [[ "${debate}" == "true" ]]; then shard_reports=$((shard_reports + 1)); else skipped+=('{"shard":"debate-five-turn"}'); fi
  skip_shards="[$(IFS=,; echo "${skipped[*]}")]"

  echo "Event ${EVENT}, draft in the event ${DRAFT:-false}, draft now ${draft}, changes ${kind}: heavy=${heavy}, exclude=${exclude}, acceptance=${acceptance}, debate=${debate}"
  {
    echo "kind=${kind}"
    echo "heavy=${heavy}"
    echo "draft=${draft}"
    echo "exclude=${exclude}"
    echo "acceptance=${acceptance}"
    echo "debate=${debate}"
    echo "skip_shards=${skip_shards}"
    echo "shard_reports=${shard_reports}"
  } >>"${GITHUB_OUTPUT}"
}

case "${1:-}" in
  classify) classify ;;
  plan) plan ;;
  debate-misses) debate_misses ;;
  *) echo "usage: $0 classify|plan|debate-misses" >&2; exit 2 ;;
esac
