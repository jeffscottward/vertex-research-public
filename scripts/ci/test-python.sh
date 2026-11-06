#!/usr/bin/env bash
# Make the Python interpreter for the TS-side Python tests (VERTEX_TEST_PYTHON).
#
# Usage: bash scripts/ci/test-python.sh <venv directory>
#
# The script makes a virtual environment from the hash-pinned lock
# services/research/requirements-sdk-linux-py312.lock (base pins, ada-url,
# cryptography and the research SDK stack) and prints the interpreter path. In
# GitHub Actions it also writes VERTEX_TEST_PYTHON to GITHUB_ENV, so later steps
# run the packages/api Python child tests instead of skipping them
# (packages/api/src/server/research-python.test-support.ts).
#
# Interpreter: VERTEX_RESEARCH_PYTHON, else python3.12 on PATH (CPython 3.12 only).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
venv="${1:?usage: test-python.sh <venv directory>}"

python="${VERTEX_RESEARCH_PYTHON:-$(command -v python3.12 || true)}"
if [[ -z "${python}" || ! -x "${python}" ]]; then
  echo "::error::CPython 3.12 is required (set VERTEX_RESEARCH_PYTHON or put python3.12 on PATH)." >&2
  exit 1
fi
version="$("${python}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [[ "${version}" != "3.12" ]]; then
  echo "::error::${python} is Python ${version}; the lock needs 3.12." >&2
  exit 1
fi

"${python}" -m venv "${venv}"
"${venv}/bin/python" -m pip install --quiet --disable-pip-version-check \
  --no-deps --require-hashes --only-binary=:all: \
  -r "${root}/services/research/requirements-sdk-linux-py312.lock"

interpreter="$(cd "${venv}" && pwd)/bin/python"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "VERTEX_TEST_PYTHON=${interpreter}" >>"${GITHUB_ENV}"
fi
echo "${interpreter}"
