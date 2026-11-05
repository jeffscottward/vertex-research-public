#!/usr/bin/env bash
# Run the Python research and execution test suites.
#
# The suites to run are listed in services/research/tests/ci-suites.txt (one
# path per line, relative to services/research). The script makes a private
# virtual environment from the hash-pinned lock
# services/research/requirements-linux-py312.lock and runs pytest on those
# suites. Nothing is installed outside the temporary virtual environment, and
# the tests use fakes only: no network, model or broker call.
#
# Completeness: ci-suites.txt must list every test_*.py file in a tests/
# folder under services/research and in services/execution/tests. A test file
# that is not listed stops the run, so a new suite cannot silently stay out of
# CI.
#
# Second run: the suites in services/research/tests/ci-suites-numeric.txt run
# in a separate virtual environment from
# services/research/requirements-numeric-linux-py312.lock (base pins plus
# numpy 2.4.6 and scipy 1.18.1) with VERTEX_REQUIRE_NUMERIC=1, so a missing
# numeric backend fails instead of skipping. The base run skips only those
# optional-backend tests.
#
# Third run: the suites in services/research/tests/ci-suites-nautilus.txt run
# in a separate virtual environment from
# services/research/requirements-nautilus-linux-py312.lock (base pins plus
# nautilus-trader 1.227.0 and pandas, glibc >= 2.35) with
# VERTEX_REQUIRE_NAUTILUS=1, so a missing engine fails instead of skipping (the
# pandas suites use importorskip; pandas is pinned in that lock). The base run
# also lists tests/test_quantlab_nautilus.py, so without
# nautilus-trader it runs that file's error-path tests (missing engine, wrong
# version, CLI exit 2) and skips its parity tests.
#
# Fourth run: the suites in services/research/tests/ci-suites-gsquant.txt run
# in a separate virtual environment from
# services/research/requirements-gsquant-linux-py312.lock (base pins plus
# gs-quant 2.2.4, pandas 3.1.1, scipy and statsmodels) with
# VERTEX_REQUIRE_GSQUANT=1, so a missing gs-quant fails instead of skipping. The
# base run also lists tests/test_gs_quant.py and skips it there. The tests block
# network sockets and use no GsSession: no Goldman Sachs Marquee access.
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
for p in research control-client market-data execution contracts/python/src host gateway; do
  pythonpath="${pythonpath:+${pythonpath}:}${root}/services/${p}"
done

venvs=()
trap 'rm -rf "${venvs[@]}"' EXIT

# manifest_lines <manifest relative to services/research>: one suite per line,
# comments and blanks removed.
manifest_lines() {
  local line
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    [[ -z "${line}" ]] || printf '%s\n' "${line}"
  done <"${research}/$1"
  return 0
}

# Every test file must be listed in the base manifest.
listed="$(manifest_lines tests/ci-suites.txt)"
missing=0
while IFS= read -r suite; do
  if ! grep -qxF "${suite}" <<<"${listed}"; then
    echo "::error::${suite} is not listed in services/research/tests/ci-suites.txt." >&2
    missing=1
  fi
done < <(cd "${research}" && find . ../execution/tests -name 'test_*.py' -path '*/tests/*' | sed 's#^\./##' | sort)
if [[ "${missing}" -ne 0 ]]; then
  exit 1
fi

# run_suites <manifest relative to services/research> <lock> [VAR=value ...]
run_suites() {
  local manifest="$1" lock="$2"
  shift 2
  local suites=() line
  while IFS= read -r line; do
    if [[ ! -f "${research}/${line}" ]]; then
      echo "::error::Suite ${line} in ${manifest} does not exist." >&2
      exit 1
    fi
    suites+=("${line}")
  done < <(manifest_lines "${manifest}")
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
run_suites tests/ci-suites-numeric.txt "${research}/requirements-numeric-linux-py312.lock" \
  VERTEX_REQUIRE_NUMERIC=1
run_suites tests/ci-suites-nautilus.txt "${research}/requirements-nautilus-linux-py312.lock" \
  VERTEX_REQUIRE_NAUTILUS=1
run_suites tests/ci-suites-gsquant.txt "${research}/requirements-gsquant-linux-py312.lock" \
  VERTEX_REQUIRE_GSQUANT=1
