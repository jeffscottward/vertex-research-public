#!/usr/bin/env bash
# Install or update the OpenBB ingest on the rig (card vertex-openbb; research only, no orders).
# Usage: infra/openbb/rig/install.sh <deployed-sha> [--enable]
# Run this script from a rig checkout of vertex-research-public that contains <deployed-sha> (git fetch
# first); the repository is the one this script lives in, whatever the current directory.
# It makes ~/.local/share/vertex-openbb/{checkout,venv,vertex-openbb.steps}: a detached worktree at
# the SHA with its node modules, a Python 3.12 venv from the hash-locked OpenBB lock file, and the steps
# file; it copies the run wrapper to ~/.local/bin and the units to ~/.config/systemd/user.
# --enable also enables and starts vertex-openbb.timer. Needs ~/.config/vertex/openbb.env and
# ~/.config/vertex/openbb-key (mode 0600); the script checks they exist and never reads the key.
# Also needs tick-runner (self-healing-harness) and user lingering, so the user timer runs without a
# login session (`loginctl enable-linger "$(id -un)"`). The whole install holds tick-runner's run lock
# for vertex-openbb (waits up to 600 s), so a timer run never starts on a half-installed checkout.
set -euo pipefail

usage() {
  echo "usage: $0 <deployed-sha> [--enable]" >&2
  exit 2
}
sha="${1:-}"
enable="${2:-}"
if [[ -z "$sha" || "$sha" == -* || $# -gt 2 ]]; then usage; fi
if [[ -n "$enable" && "$enable" != "--enable" ]]; then usage; fi
user="$(id -un)"

repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
base="$HOME/.local/share/vertex-openbb"
tick_runner="$HOME/Github/tools/self-healing-harness/bin/tick-runner"
lock="services/openbb/requirements-openbb-linux-py312.lock"

for f in "$HOME/.config/vertex/openbb.env" "$HOME/.config/vertex/openbb-key"; do
  if [[ ! -f "$f" ]]; then
    echo "install: missing $f" >&2
    exit 2
  fi
  if [[ "$(stat -c %a "$f")" != "600" ]]; then
    echo "install: $f must be mode 0600" >&2
    exit 2
  fi
done

if [[ ! -x "$tick_runner" ]]; then
  echo "install: missing $tick_runner (install self-healing-harness first)" >&2
  exit 2
fi
if [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  echo "install: user lingering is off; run: loginctl enable-linger $user" >&2
  exit 2
fi

# tick-runner takes ~/.local/state/tick-runner/<name>/run.lock (flock -n) for each run; hold it here.
run_lock_dir="$HOME/.local/state/tick-runner/vertex-openbb"
mkdir -p "$run_lock_dir"
exec 9>"$run_lock_dir/run.lock"
if ! flock -w 600 9; then
  echo "install: a vertex-openbb run still holds $run_lock_dir/run.lock after 600 s" >&2
  exit 75
fi

git -C "$repo" cat-file -e "$sha^{commit}"
mkdir -p "$base"
if [[ -d "$base/checkout/.git" || -f "$base/checkout/.git" ]]; then
  git -C "$base/checkout" checkout --detach --quiet "$sha"
else
  # A checkout folder deleted by hand leaves a stale worktree entry; prune it first.
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --detach "$base/checkout" "$sha"
fi
(cd "$base/checkout" && pnpm install --frozen-lockfile --silent)

if [[ ! -x "$base/venv/bin/python" ]]; then
  uv venv --quiet --no-config --python 3.12 "$base/venv"
fi
# sync makes the venv exactly the lock (hash-checked, removes strays); the package itself adds
# nothing: no dependencies, and setuptools comes from the lock (no build isolation download).
VIRTUAL_ENV="$base/venv" uv pip sync --quiet --require-hashes --only-binary :all: --no-config "$base/checkout/$lock"
VIRTUAL_ENV="$base/venv" uv pip install --quiet --no-config --no-deps --no-build-isolation "$base/checkout/services/openbb"
# Import every module the jobs use once, so a broken venv fails the install, not a timed step.
"$base/venv/bin/python" -I -m vertex_openbb --warm

install -m 0644 "$base/checkout/infra/openbb/rig/vertex-openbb.steps" "$base/vertex-openbb.steps"
install -D -m 0700 "$base/checkout/infra/openbb/rig/vertex-openbb-run.sh" "$HOME/.local/bin/vertex-openbb-run"
install -D -m 0644 "$base/checkout/infra/openbb/rig/vertex-openbb.service" "$HOME/.config/systemd/user/vertex-openbb.service"
install -D -m 0644 "$base/checkout/infra/openbb/rig/vertex-openbb.timer" "$HOME/.config/systemd/user/vertex-openbb.timer"
# The new files are in place: let timer runs start again before touching systemd.
exec 9>&-
systemctl --user daemon-reload
if [[ "$enable" == "--enable" ]]; then
  systemctl --user enable --now vertex-openbb.timer
fi
echo "vertex-openbb installed at $sha ($base)"
