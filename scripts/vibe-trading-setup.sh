#!/usr/bin/env bash
# Installs Vibe-Trading (https://github.com/HKUDS/Vibe-Trading, MIT) at a pinned commit, outside this
# repository, for the Vertex framework benchmark (services/vibe-trading, docs/agent-benchmark.md).
#
#   scripts/vibe-trading-setup.sh [target-dir]     default: ~/Github/tools/vibe-trading
#
# The clone gets its own .venv. Dependencies come from upstream's hash-pinned lock
# (requirements-lock.txt, installed with --require-hashes, as upstream's Dockerfile does). The
# package itself is then installed without dependencies and without build isolation, with a
# hash-pinned setuptools as its build backend, so nothing unpinned is downloaded. A clone with local
# changes is refused; the venv is rebuilt whenever the pinned commit changes. No upstream code
# enters this repository. Afterwards: export VERTEX_VT_DIR=<target-dir>.
set -euo pipefail

readonly REPO_URL="https://github.com/HKUDS/Vibe-Trading.git"
readonly TAG="v0.1.18"
readonly COMMIT="66eb57634f16344b326d85fd1fe10029c7f348bb"
readonly TARGET="${1:-$HOME/Github/tools/vibe-trading}"
readonly PYTHON="${VT_PYTHON:-python3}"
# Build backend for the editable install (upstream's pyproject.toml names none, so pip would fetch
# the newest setuptools unpinned). setuptools 84.2.1, py3-none-any wheel, sha256 from PyPI.
readonly BACKEND="setuptools==84.2.1 --hash=sha256:ca140b45d5325a9478f880e351484f62fef15f336462e449ca0c03c873d589c2"

die() {
  echo "vibe-trading-setup: $*" >&2
  exit 1
}

"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' ||
  die "Vibe-Trading $TAG needs Python 3.11 or newer (set VT_PYTHON)"

if [[ -e "$TARGET" && ! -d "$TARGET/.git" ]]; then
  die "$TARGET exists and is not a git clone"
fi

# Local changes or untracked files would survive a checkout and run as if they were upstream code.
require_clean() {
  local changes
  changes="$(git -C "$TARGET" status --porcelain --untracked-files=all)"
  [[ -z "$changes" ]] || die "$TARGET has local changes or untracked files; remove them or use a fresh folder"
}

if [[ -d "$TARGET/.git" ]]; then
  origin="$(git -C "$TARGET" config --get remote.origin.url || true)"
  [[ "$origin" == "$REPO_URL" ]] || die "$TARGET clones ${origin:-nothing}, expected $REPO_URL"
  require_clean
else
  mkdir -p "$(dirname "$TARGET")"
  git clone --quiet --no-checkout "$REPO_URL" "$TARGET"
fi
if [[ -e "$TARGET/agent/.env" ]]; then
  die "$TARGET/agent/.env exists; Vertex runs pass settings by environment only (remove it)"
fi

git -C "$TARGET" fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG"
tag_commit="$(git -C "$TARGET" rev-parse "$TAG^{commit}")"
[[ "$tag_commit" == "$COMMIT" ]] || die "tag $TAG points at $tag_commit, expected $COMMIT"
git -C "$TARGET" -c advice.detachedHead=false checkout --quiet "$COMMIT"
[[ "$(git -C "$TARGET" rev-parse HEAD)" == "$COMMIT" ]] || die "checkout did not reach $COMMIT"
require_clean
[[ -f "$TARGET/requirements-lock.txt" ]] || die "requirements-lock.txt is missing at $COMMIT"

venv="$TARGET/.venv"
marker="$venv/.vertex-commit"
if [[ -d "$venv" && "$(cat "$marker" 2>/dev/null || true)" != "$COMMIT" ]]; then
  echo "vibe-trading-setup: rebuilding $venv for $COMMIT" >&2
  rm -rf "$venv"
fi
if [[ ! -x "$venv/bin/python" ]]; then
  "$PYTHON" -m venv "$venv"
fi
backend_lock="$(mktemp)"
trap 'rm -f "$backend_lock"' EXIT
printf '%s\n' "$BACKEND" >"$backend_lock"
"$venv/bin/python" -m pip install --quiet --require-hashes -r "$TARGET/requirements-lock.txt"
"$venv/bin/python" -m pip install --quiet --require-hashes --only-binary :all: -r "$backend_lock"
"$venv/bin/python" -m pip install --quiet --no-deps --no-build-isolation -e "$TARGET"
printf '%s\n' "$COMMIT" >"$marker"

version="$("$venv/bin/python" -c 'import importlib.metadata as m; print(m.version("vibe-trading-ai"))')"
echo "Vibe-Trading $version at $COMMIT in $TARGET"
echo "Next: export VERTEX_VT_DIR=$TARGET"
