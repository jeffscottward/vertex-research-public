#!/usr/bin/env bash
# Creates or repairs the research-only Python 3.12 NautilusTrader virtual environment used by
# vertex-nautilus-worker.service from the hash-pinned lock
# services/research/requirements-nautilus-linux-py312.lock.
# Research host only (never the live trading node); never starts, stops or restarts trading units.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checkout="${VERTEX_CHECKOUT:-$(cd "$script_dir/../.." && pwd)}"
venv="${VERTEX_NAUTILUS_VENV:-${XDG_DATA_HOME:-$HOME/.local/share}/vertex/nautilus-venv}"
lock=""
python_bin="${VERTEX_RESEARCH_PYTHON:-}"

usage() {
  cat <<'EOF'
Usage: setup-nautilus-venv.sh [options]

Create or repair the hash-pinned Python 3.12 NautilusTrader venv for
vertex-nautilus-worker.service (research host only).

Options:
  --venv <dir>       Target venv directory (default: ~/.local/share/vertex/nautilus-venv)
  --checkout <dir>   Vertex repository checkout (default: inferred from this script)
  --lock <file>      Hash-pinned lock file (default: <checkout>/services/research/requirements-nautilus-linux-py312.lock)
  --python <path>    Explicit CPython 3.12 interpreter (default: uv-managed 3.12 or python3.12 on PATH)
  -h, --help         Show this help and exit
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "setup-nautilus-venv: $1 requires a value" >&2
    exit 64
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv)
      require_value "$@"
      venv="$2"
      shift 2
      ;;
    --checkout)
      require_value "$@"
      checkout="$2"
      shift 2
      ;;
    --lock)
      require_value "$@"
      lock="$2"
      shift 2
      ;;
    --python)
      require_value "$@"
      python_bin="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "setup-nautilus-venv: unknown argument $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

research_dir="$checkout/services/research"
if [[ -z "$lock" ]]; then
  lock="$research_dir/requirements-nautilus-linux-py312.lock"
fi

if [[ ! -f "$lock" ]]; then
  echo "setup-nautilus-venv: missing lock file $lock" >&2
  exit 64
fi
if [[ ! -d "$research_dir/nautilus_backtest" ]]; then
  echo "setup-nautilus-venv: missing $research_dir/nautilus_backtest (check --checkout)" >&2
  exit 64
fi

expected_nautilus="$(sed -n 's/^nautilus-trader==\([^[:space:]]*\).*/\1/p' "$lock" | head -n 1)"
if [[ -z "$expected_nautilus" ]]; then
  echo "setup-nautilus-venv: $lock does not pin nautilus-trader==<version>" >&2
  exit 64
fi

python_minor() {
  "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true
}

venv_python="$venv/bin/python"
needs_venv=0
if [[ ! -f "$venv_python" || ! -x "$venv_python" ]]; then
  needs_venv=1
elif [[ "$(python_minor "$venv_python")" != "3.12" ]]; then
  needs_venv=1
fi

mkdir -p "$(dirname "$venv")"

if [[ "${VERTEX_NAUTILUS_SETUP_NO_UV:-0}" != "1" ]] && command -v uv >/dev/null 2>&1; then
  uv_python="3.12"
  if [[ -n "$python_bin" ]]; then
    if [[ ! -f "$python_bin" || ! -x "$python_bin" ]]; then
      echo "setup-nautilus-venv: --python $python_bin is missing or not executable" >&2
      exit 64
    fi
    py_ver="$(python_minor "$python_bin")"
    if [[ "$py_ver" != "3.12" ]]; then
      echo "setup-nautilus-venv: $python_bin is Python ${py_ver:-unknown}; the Nautilus lock requires 3.12" >&2
      exit 64
    fi
    uv_python="$python_bin"
  fi
  if [[ "$needs_venv" -eq 1 ]]; then
    uv venv --clear --quiet --no-config --python "$uv_python" "$venv"
  fi
  VIRTUAL_ENV="$venv" uv pip sync --quiet --require-hashes --only-binary :all: --no-config "$lock"
else
  if [[ -z "$python_bin" ]]; then
    python_bin="$(command -v python3.12 || true)"
  fi
  if [[ -z "$python_bin" || ! -f "$python_bin" || ! -x "$python_bin" ]]; then
    echo "setup-nautilus-venv: CPython 3.12 is required (install uv, set --python, or put python3.12 on PATH)" >&2
    exit 64
  fi
  py_ver="$(python_minor "$python_bin")"
  if [[ "$py_ver" != "3.12" ]]; then
    echo "setup-nautilus-venv: $python_bin is Python ${py_ver:-unknown}; the Nautilus lock requires 3.12" >&2
    exit 64
  fi
  if [[ "$needs_venv" -eq 1 ]]; then
    "$python_bin" -m venv --clear "$venv"
  fi
  "$venv_python" -m pip install --quiet --disable-pip-version-check \
    --no-deps --require-hashes --only-binary=:all: -r "$lock"
fi

if [[ ! -f "$venv_python" || ! -x "$venv_python" ]]; then
  echo "setup-nautilus-venv: expected executable $venv_python after install" >&2
  exit 1
fi

PYTHONPATH="$research_dir" PYTHONDONTWRITEBYTECODE=1 \
  VERTEX_EXPECTED_NAUTILUS_VERSION="$expected_nautilus" \
  "$venv_python" -c '
import os, sys, nautilus_trader, nautilus_backtest
expected = os.environ["VERTEX_EXPECTED_NAUTILUS_VERSION"]
if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"expected Python 3.12, got {sys.version_info[0]}.{sys.version_info[1]}")
if nautilus_trader.__version__ != expected:
    raise SystemExit(f"expected nautilus-trader {expected}, got {nautilus_trader.__version__}")
'

echo "nautilus-venv ready: $venv_python (nautilus-trader $expected_nautilus)"
