#!/usr/bin/env bash
# Push the rig research-lens documents to the QuantVPS tailnet file root (read-only lens data).
# Runs on dev-rig. Sources: vertex-research-public scripts/research-lenses data jobs. No credentials are read or written.
# Target: /opt/vertex-status/private-v2/research-lenses/ (mounted read-only into vertex-status-tailnet
# as /srv/research-lenses and served at :8443/vertex-research-lenses/v1/*).
set -euo pipefail

ROTATION_JSON="${ROTATION_JSON:-$HOME/.local/share/vertex-research-lenses/data/rotation-matrix/latest.json}"
DEEP_VALUE_JSON="${DEEP_VALUE_JSON:-$HOME/.local/share/vertex-research-lenses/data/deep-value/latest.json}"
QUANTVPS_HOST="${QUANTVPS_HOST:-quantvps}"
DEST="${RESEARCH_LENSES_DEST:-/opt/vertex-status/private-v2/research-lenses}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=yes)

ssh "${SSH_OPTS[@]}" "$QUANTVPS_HOST" "install -d -m 0755 '$DEST'"
status=0
for pair in "rotation-matrix.json=$ROTATION_JSON" "deep-value.json=$DEEP_VALUE_JSON"; do
  name="${pair%%=*}"
  source="${pair#*=}"
  if [[ ! -f "$source" ]]; then
    echo "skip $name: $source is missing" >&2
    status=1
    continue
  fi
  # Refuse a truncated or partly written document.
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$source"
  scp -q "${SSH_OPTS[@]}" "$source" "$QUANTVPS_HOST:$DEST/.$name.tmp"
  ssh "${SSH_OPTS[@]}" "$QUANTVPS_HOST" "chmod 0644 '$DEST/.$name.tmp' && mv -f '$DEST/.$name.tmp' '$DEST/$name'"
  echo "pushed $name ($(stat -c %s "$source") bytes)"
done
exit "$status"
