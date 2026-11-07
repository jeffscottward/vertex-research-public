#!/usr/bin/env bash
# Run the packages/api native-evidence suite with the real research SDK (CI job "Native evidence").
#
# Usage: bash scripts/ci/native-evidence.sh
#
# Owner decision 2026-11-06 (card vertex-native-evidence-ci-job): one dedicated CI job runs
# these Python-child cases on its own and fails when any of them is skipped, so they cannot
# turn into a green skip unseen.
#
# scripts/ci/test-python.sh makes a temporary venv from the hash-pinned
# services/research/requirements-sdk-linux-py312.lock (CPython 3.12: VERTEX_RESEARCH_PYTHON,
# else python3.12 on PATH). VERTEX_TEST_PYTHON points the suite at it. With the variable set,
# research-python.test-support.ts never skips, and the report check below fails the job when any
# case is skipped, so a missing or broken interpreter is a failure, never a green skip.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vertex-native-evidence"
rm -rf "${work}"
mkdir -p "${work}"

python="$(bash "${root}/scripts/ci/test-python.sh" "${work}/venv" | tail -n 1)"
"${python}" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

report="${work}/native-evidence.json"
cd "${root}/packages/api"
VERTEX_TEST_PYTHON="${python}" pnpm exec vitest run --config ../../vitest.config.ts \
  --project unit --reporter=default --reporter=json --outputFile.json="${report}" \
  src/server/vertex-research-chat-native-evidence.test.ts

node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const line = `native-evidence: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, ${r.numTodoTests} todo of ${r.numTotalTests}`;
console.log(line);
if (r.numTotalTests === 0 || r.numPassedTests !== r.numTotalTests) process.exit(1);
' "${report}"
