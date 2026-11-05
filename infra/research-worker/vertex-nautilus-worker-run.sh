#!/usr/bin/env bash
# Starts the Vertex Nautilus backtest worker (research only, no orders) from a runner checkout.
# Template: copy to ~/.local/bin/vertex-nautilus-worker-run (no .sh, mode 0700) and replace every
# __PLACEHOLDER__. The operator agent WRITE key is read from its own file (mode 0600, the key
# only); the key is never printed.
set -euo pipefail

CHECKOUT="__RUNNER_CHECKOUT__"         # for example $HOME/Github/trading/vertex-research-platform-runner
KEY_FILE="__AGENT_WRITE_KEY_FILE__"    # for example $HOME/.config/vertex/agent-write-key
BUN="__BUN__"                          # absolute path of the bun binary
export VERTEX_ORIGIN="__VERTEX_ORIGIN__"                    # portal origin, https://...
export VERTEX_NAUTILUS_PYTHON="__NAUTILUS_VENV__/bin/python" # venv with the Nautilus lock
# export VERTEX_WORKER_IDLE_MS=3000
# Optional alert route (a loopback chat endpoint that takes {channel, text}); set both to "" for none.
export VERTEX_ALERT_POST_URL="__ALERT_POST_URL__"  # for example http://127.0.0.1:47821/post
export VERTEX_ALERT_CHANNEL="__ALERT_CHANNEL__"    # for example trading-alerts

case "$CHECKOUT$KEY_FILE$BUN$VERTEX_ORIGIN$VERTEX_NAUTILUS_PYTHON$VERTEX_ALERT_POST_URL$VERTEX_ALERT_CHANNEL" in
  *__*) echo "vertex-nautilus-worker-run: replace the __PLACEHOLDER__ values first" >&2; exit 64 ;;
esac
if [ "$(stat -c %a "$KEY_FILE")" != "600" ]; then
  echo "vertex-nautilus-worker-run: $KEY_FILE must have mode 0600" >&2
  exit 64
fi

VERTEX_AGENT_API_KEY="$(<"$KEY_FILE")"
export VERTEX_AGENT_API_KEY
cd "$CHECKOUT"
# exec, so the worker itself receives SIGTERM from systemd (KillMode=mixed).
exec "$BUN" --no-env-file scripts/vertex-backtest-worker-nautilus.ts "$@"
