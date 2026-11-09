#!/usr/bin/env bash
# Run one OpenBB ingest job (card vertex-openbb; research only, no orders). Installed by install.sh as
# ~/.local/bin/vertex-openbb-run. Usage: vertex-openbb-run <job> [tick.ts options], e.g.
#   vertex-openbb-run cboe-vol-indices --since 1990-01-01      (backfill)
#   vertex-openbb-run sec-filings --dry-run                     (fetch + validate, store nothing)
# Reads ~/.config/vertex/openbb.env (VERTEX_ORIGIN, VERTEX_RESEARCH_CONTACT_EMAIL, optional
# OPENBB_STOCK_UNIVERSE) and the operator agent write key from ~/.config/vertex/openbb-key (both 0600).
# The key goes to the tick client through the environment only; nothing prints it. sec-* jobs hold
# ~/.cache/vertex-openbb/sec.lock, so a manual SEC backfill never overlaps the timer's SEC stages
# (SEC fair access is per host).
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
export VERTEX_AGENT_API_KEY
export OPENBB_PYTHON="$base/venv/bin/python"
export OPENBB_SERVICE_DIR="$base/checkout/services/openbb"

bun_bin="$(command -v bun || true)"
if [[ -z "$bun_bin" ]]; then bun_bin="$HOME/.local/share/mise/shims/bun"; fi

cd "$base/checkout"
if [[ "${1:-}" == sec-* ]]; then
  mkdir -p "$HOME/.cache/vertex-openbb"
  exec flock "$HOME/.cache/vertex-openbb/sec.lock" "$bun_bin" run vertex:openbb:tick "$@"
fi
exec "$bun_bin" run vertex:openbb:tick "$@"
