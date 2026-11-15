#!/usr/bin/env bash
# Run one OpenBB ingest job (card vertex-openbb; research only, no orders). Installed by install.sh as
# ~/.local/bin/vertex-openbb-run. Usage: vertex-openbb-run <job> [tick.ts options], e.g.
#   vertex-openbb-run cboe-vol-indices --since 1990-01-01      (backfill)
#   vertex-openbb-run sec-filings --dry-run                     (fetch + validate, store nothing)
# Reads ~/.config/vertex/openbb.env (VERTEX_ORIGIN, VERTEX_RESEARCH_CONTACT_EMAIL, optional
# OPENBB_STOCK_UNIVERSE) and the operator agent write key from ~/.config/vertex/openbb-key (both 0600).
# The key goes to the tick client through the environment only; nothing prints it. sec-* jobs hold
# ~/.cache/vertex-openbb/sec.lock, so a manual SEC backfill never overlaps the timer's SEC stages
# (SEC fair access is per host): a manual run waits for the lock; a timer run (vertex-openbb.service
# sets VERTEX_OPENBB_TIMER=1; INVOCATION_ID is no marker, desktop session shells set it too) waits
# 20 s, then skips with exit 0.
set -euo pipefail

base="$HOME/.local/share/vertex-openbb"
env_file="$HOME/.config/vertex/openbb.env"
key_file="$HOME/.config/vertex/openbb-key"

for f in "$env_file" "$key_file"; do
  if [[ ! -r "$f" ]]; then
    echo "vertex-openbb-run: missing $f (see infra/openbb/rig/install.sh)" >&2
    exit 2
  fi
done

set -a
# shellcheck source=/dev/null
. "$env_file"
set +a
VERTEX_AGENT_API_KEY="$(tr -d '\r\n' <"$key_file")"
if [[ -z "$VERTEX_AGENT_API_KEY" ]]; then
  echo "vertex-openbb-run: $key_file is empty" >&2
  exit 2
fi
export VERTEX_AGENT_API_KEY
export OPENBB_PYTHON="$base/venv/bin/python"
export OPENBB_SERVICE_DIR="$base/checkout/services/openbb"
# Step timeouts in vertex-openbb.steps are sized for the fetcher's default deadline (240 s); an
# override from openbb.env or the calling shell would let a step overrun its budget.
unset OPENBB_DEADLINE_S

bun_bin="$(command -v bun || true)"
if [[ -z "$bun_bin" ]]; then bun_bin="$HOME/.local/share/mise/shims/bun"; fi

cd "$base/checkout"
if [[ "${1:-}" == sec-* ]]; then
  sec_lock="$HOME/.cache/vertex-openbb/sec.lock"
  mkdir -p "$HOME/.cache/vertex-openbb"
  if [[ "${VERTEX_OPENBB_TIMER:-}" != "1" ]]; then
    # Manual run: wait for the timer's SEC step to finish.
    exec flock "$sec_lock" "$bun_bin" run vertex:openbb:tick "$@"
  fi
  # Timer run: a manual SEC run holds the lock; skip this step instead of waiting it out.
  status=0
  flock -w 20 -E 75 "$sec_lock" "$bun_bin" run vertex:openbb:tick "$@" || status=$?
  if [[ "$status" -eq 75 ]]; then
    echo "skip: SEC lock held (manual run in progress)"
    exit 0
  fi
  exit "$status"
fi
exec "$bun_bin" run vertex:openbb:tick "$@"
