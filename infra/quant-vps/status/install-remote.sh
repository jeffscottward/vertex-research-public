#!/usr/bin/env bash
# QuantVPS status v2 ENABLE script (run as root on QuantVPS). DISABLED 2026-10-03: v2 carries account
# blocks and the user's condition is token + source-IP allow-list; no stable source exists yet. Run only
# after the allow-list decision, with VERTEX_STATUS_ENABLE_V2=1 and the unit set to VERTEX_STATUS_V2=1.
# The rig-side deployer substitutes the timestamp and base64 payload placeholders (TS, COLLECT,
# STATUSCADDY=Caddyfile.status.v2, SERVICE, TIMER). Touches only /opt/vertex-status, the collector
# systemd units and the vertex-status container. Never touches the trading stack or the main Caddyfile.
set -euo pipefail
[ "${VERTEX_STATUS_ENABLE_V2:-0}" = 1 ] || { echo "v2 serving is disabled pending the allow-list decision; nothing changed"; exit 5; }
TS=__TS__
R=/opt/vertex-status/rollback-$TS
C=/opt/vertex-exec-node/deploy/Caddyfile
mkdir -p "$R" /opt/vertex-status/state; chmod 700 "$R" /opt/vertex-status/state
cp -p "$C" "$R/Caddyfile.before"
cp -p /opt/vertex-status/collect.py "$R/collect.py.before"
cp -p /opt/vertex-status/Caddyfile "$R/status-Caddyfile.before"
cp -p /etc/systemd/system/vertex-status-collect.service "$R/vertex-status-collect.service.before"
cp -p /etc/systemd/system/vertex-status-collect.timer "$R/vertex-status-collect.timer.before"
echo "backup=$R"

STAGE=$(mktemp -d /opt/vertex-status/.stage-XXXXXX)
trap 'rm -rf "$STAGE"; docker rm -f vertex-status-candidate >/dev/null 2>&1 || true' EXIT
echo __COLLECT__ | base64 -d > "$STAGE/collect.py"
echo __STATUSCADDY__ | base64 -d > "$STAGE/Caddyfile"
echo __SERVICE__ | base64 -d > "$STAGE/vertex-status-collect.service"
echo __TIMER__ | base64 -d > "$STAGE/vertex-status-collect.timer"
python3 -m py_compile "$STAGE/collect.py"

# 1) dry run of the new collector into the stage dir (live inputs, read-only)
python3 "$STAGE/collect.py" --v2 --out "$STAGE/out" >/dev/null
python3 - "$STAGE" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1]); import collect
v1 = json.load(open(sys.argv[1] + "/out/status.json")); t = open(sys.argv[1] + "/out/status-v2.json").read(); v2 = json.loads(t)
assert v1["schema"] == "vertex-deploy-status-v1" and set(v1) == {"schema", "host", "generatedAt", "readOnly", "services"}
assert v2["schema"] == "vertex-deploy-status-v2" and len(t.encode()) <= collect.HARD_MAX_BYTES
assert not collect.find_leaks(t, collect.LiveInputs().token()), "leak guard"
print("dry-run ok v2_bytes=%d" % len(t.encode()))
PY

# 2) validate + exercise the new status-server config in a throwaway candidate container (random test token)
CT=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN="$CT" -v "$STAGE/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then echo "CANDIDATE CONFIG INVALID - nothing installed"; exit 3; fi
echo "candidate config valid"
docker run -d --name vertex-status-candidate --network none --read-only --tmpfs /tmp --tmpfs /config --tmpfs /data \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --memory 64m -e VERTEX_STATUS_TOKEN="$CT" \
  -v "$STAGE/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$STAGE/out:/srv:ro" caddy:2-alpine >/dev/null
sleep 2
G="w""get"
cget() { docker exec vertex-status-candidate $G -q -O- "$@" 2>/dev/null || echo "FAILED"; }
schema() { python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t)["schema"] if t.startswith("{") else t.strip()[:40])'; }
A=$(docker exec vertex-status-candidate $G -qS -O- http://127.0.0.1:8080/ 2>&1 | grep -m1 -o 'HTTP/1.1 [0-9]*' || true)
B=$(cget --header "Authorization: Bearer wrong-$CT" http://127.0.0.1:8080/vertex-status/v1 | schema)
D=$(cget --header "Authorization: Bearer $CT" http://127.0.0.1:8080/vertex-status/v1 | schema)
Q=$(cget --header "Authorization: Bearer $CT" 'http://127.0.0.1:8080/vertex-status/v1?schema=v2' | schema)
H=$(cget --header "Authorization: Bearer $CT" --header 'Accept: application/vnd.vertex.deploy-status-v2+json' http://127.0.0.1:8080/vertex-status/v1 | schema)
echo "candidate no-token=[$A] wrong-token=[$B] default=[$D] query-v2=[$Q] accept-v2=[$H]"
docker rm -f vertex-status-candidate >/dev/null
if [ "$A" != "HTTP/1.1 401" ] || [ "$B" != "FAILED" ] || [ "$D" != "vertex-deploy-status-v1" ] || [ "$Q" != "vertex-deploy-status-v2" ] || [ "$H" != "vertex-deploy-status-v2" ]; then
  echo "CANDIDATE BEHAVIOUR WRONG - nothing installed"; exit 4
fi

# 3) install: collector + units first (the old server keeps serving status.json meanwhile)
install -m 700 "$STAGE/collect.py" /opt/vertex-status/collect.py
install -m 644 "$STAGE/vertex-status-collect.service" /etc/systemd/system/vertex-status-collect.service
install -m 644 "$STAGE/vertex-status-collect.timer" /etc/systemd/system/vertex-status-collect.timer
systemctl daemon-reload
systemctl start vertex-status-collect.service
test -s /opt/vertex-status/public/status.json && test -s /opt/vertex-status/public/status-v2.json && echo "collector v2 ran ok"
# keep the bind-mounted inode: overwrite in place, then restart only the status container (admin API is off)
cat "$STAGE/Caddyfile" > /opt/vertex-status/Caddyfile
docker restart vertex-status >/dev/null
sleep 3
CADDY=ibkr-nautilus-exec-node-caddy-1
T=$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)
echo "inner no-token: $(docker exec $CADDY $G -qS -O- http://vertex-status:8080/ 2>&1 | grep -m1 -o 'HTTP/1.1 [0-9]*' || true)"
echo "inner default: $(docker exec $CADDY $G -q -O- --header "Authorization: Bearer $T" http://vertex-status:8080/vertex-status/v1 | schema)"
echo "inner v2: $(docker exec $CADDY $G -q -O- --header "Authorization: Bearer $T" 'http://vertex-status:8080/vertex-status/v1?schema=v2' | schema)"
systemctl is-active vertex-status-collect.timer
echo "rollback=$R"
