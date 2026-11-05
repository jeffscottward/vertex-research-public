#!/usr/bin/env bash
# Run the research tooling Python tests in services/research.
#
# The suites to run are listed in services/research/tests/ci-suites.txt (one
# path per line, relative to services/research). The script makes a private
# virtual environment from the hash-pinned lock
# services/research/requirements-linux-py312.lock and runs pytest on those
# suites. Nothing is installed outside the temporary virtual environment, and
# the tests use fakes only: no network, model or broker call.
#
# Second run: the suites in services/research/tests/ci-suites-nautilus.txt run
# in a separate virtual environment from
# services/research/requirements-nautilus-linux-py312.lock (base pins plus
# nautilus-trader 1.227.0, glibc >= 2.35) with VERTEX_REQUIRE_NAUTILUS=1, so a
# missing engine fails instead of skipping. The base run does not change.
#
# Interpreter: VERTEX_RESEARCH_PYTHON, else python3.12 on PATH. The lock holds
# CPython 3.12 Linux x86_64 wheels only, so any other version stops the run.
#
# Local use: VERTEX_RESEARCH_PYTHON="$(uv python find 3.12)" bash scripts/ci/research-python.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
research="${root}/services/research"

python="${VERTEX_RESEARCH_PYTHON:-$(command -v python3.12 || true)}"
if [[ -z "${python}" || ! -x "${python}" ]]; then
  echo "::error::CPython 3.12 is required (set VERTEX_RESEARCH_PYTHON or put python3.12 on PATH)." >&2
  exit 1
fi
version="$("${python}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [[ "${version}" != "3.12" ]]; then
  echo "::error::${python} is Python ${version}; the research lock needs 3.12." >&2
  exit 1
fi

pythonpath=""
for p in research control-client market-data execution contracts/python/src host; do
  pythonpath="${pythonpath:+${pythonpath}:}${root}/services/${p}"
done

venvs=()
trap 'rm -rf "${venvs[@]}"' EXIT

# run_suites <manifest relative to services/research> <lock> [VAR=value ...]
run_suites() {
  local manifest="$1" lock="$2"
  shift 2
  local suites=() line
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    [[ -z "${line}" ]] && continue
    if [[ ! -f "${research}/${line}" ]]; then
      echo "::error::Suite ${line} in ${manifest} does not exist." >&2
      exit 1
    fi
    suites+=("${line}")
  done <"${research}/${manifest}"
  if [[ "${#suites[@]}" -eq 0 ]]; then
    echo "::error::${manifest} lists no suites." >&2
    exit 1
  fi

  local venv
  venv="$(mktemp -d)"
  venvs+=("${venv}")
  "${python}" -m venv "${venv}"
  "${venv}/bin/python" -m pip install --quiet --disable-pip-version-check \
    --no-deps --require-hashes --only-binary=:all: -r "${lock}"

  (cd "${research}" && env PYTHONPATH="${pythonpath}" PYTHONDONTWRITEBYTECODE=1 "$@" \
    "${venv}/bin/python" -B -m pytest -q -p no:cacheprovider "${suites[@]}")
}

run_suites tests/ci-suites.txt "${research}/requirements-linux-py312.lock"
run_suites tests/ci-suites-nautilus.txt "${research}/requirements-nautilus-linux-py312.lock" \
  VERTEX_REQUIRE_NAUTILUS=1
