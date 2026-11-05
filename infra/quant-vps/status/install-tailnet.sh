#!/usr/bin/env bash
# Phase 2: serve v2 ONLY on the VPS tailnet address, ONLY to the rig. Run as root on QuantVPS after the
# device has been approved in the tailnet. The rig-side deployer substitutes TS, COLLECT, TAILCADDY and
# SERVICE (base64 payloads). Touches only /opt/vertex-status, the collector unit, the
# vertex-status-tailnet container and the tailscaled drop-in RuntimeDirectoryPreserve=yes (daemon-reload
# only; tailscaled is not restarted). Never touches the trading stack, the main Caddyfile or vertex-status.
set -euo pipefail
TS=__TS__
# The rig's tailnet IPv4 and IPv6 are host config on QuantVPS (VERTEX_RIG_IPS in /etc/vertex/hosts.env,
# not in git; public repository 2026-11-05). Missing or malformed: stop before any change.
RIG_IPS=$(sed -n 's/^VERTEX_RIG_IPS=//p' /etc/vertex/hosts.env 2>/dev/null | tail -1 || true)
[[ "$RIG_IPS" =~ ^[0-9a-f.:]*[0-9][0-9a-f.:]*( [0-9a-f.:]*[0-9][0-9a-f.:]*)*$ ]] || { echo "VERTEX_RIG_IPS missing or malformed in /etc/vertex/hosts.env; nothing changed"; exit 3; }
R=/opt/vertex-status/rollback-$TS
B=/opt/vertex-status/net-baseline-20261003T1140Z
P=/opt/vertex-status/private-v2

# 0) preconditions: logged in, no exit node, no accepted routes, default route and DNS unchanged
STATE=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])')
[ "$STATE" = "Running" ] || { echo "tailscale not running (state=$STATE); nothing changed"; exit 3; }
TS_IP4=$(tailscale ip -4 | head -1); TS_IP6=$(tailscale ip -6 | head -1)
TS_HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
case "$TS_IP4" in 100.*) ;; *) echo "unexpected tailnet IPv4"; exit 3;; esac
ip route | diff -q "$B/ip-route" - >/dev/null || { echo "main IPv4 routes differ from baseline; nothing changed"; exit 3; }
diff -q "$B/resolv.conf" /etc/resolv.conf >/dev/null || { echo "resolv.conf differs from baseline; nothing changed"; exit 3; }
if ip route show table 52 2>/dev/null | grep -v -E '^(100\.|throw |local )' | grep -q .; then echo "table 52 has non-tailnet routes; nothing changed"; exit 3; fi
echo "tailnet ok host=$TS_HOST"

# 1) backup
mkdir -p "$R"; chmod 700 "$R"
cp -p /opt/vertex-status/collect.py "$R/collect.py.before"
cp -p /etc/systemd/system/vertex-status-collect.service "$R/vertex-status-collect.service.before"
cp -p /opt/vertex-exec-node/deploy/Caddyfile "$R/Caddyfile.before"
ip route show table 52 > "$R/table52.after-login" 2>&1 || true
echo "backup=$R"

STAGE=$(mktemp -d /opt/vertex-status/.stage-XXXXXX)
trap 'rm -rf "$STAGE"; docker rm -f vertex-status-tailnet-candidate >/dev/null 2>&1 || true' EXIT
echo __COLLECT__ | base64 -d > "$STAGE/collect.py"
echo __TAILCADDY__ | base64 -d | sed -e "s/__TS_HOST__/$TS_HOST/g" -e "s/__TS_IP__/$TS_IP4 $TS_IP6/g" -e "s/__RIG_IP__/$RIG_IPS/g" > "$STAGE/Caddyfile.tailnet"
echo __SERVICE__ | base64 -d > "$STAGE/vertex-status-collect.service"
grep -q '^Environment=VERTEX_STATUS_V2=1$' "$STAGE/vertex-status-collect.service"
grep -q "^Environment=VERTEX_STATUS_V2_DIR=$P$" "$STAGE/vertex-status-collect.service"
python3 -m py_compile "$STAGE/collect.py"

# 2) dry run: v2 must land only in the private dir
mkdir -p "$STAGE/pub" "$STAGE/priv"
python3 "$STAGE/collect.py" --v2 --out "$STAGE/pub" --v2-out "$STAGE/priv" >/dev/null
python3 - "$STAGE" <<'PY'
import json, os, sys
sys.path.insert(0, sys.argv[1]); import collect
assert sorted(os.listdir(sys.argv[1] + "/pub")) == ["status.json"]
t = open(sys.argv[1] + "/priv/status-v2.json").read(); v2 = json.loads(t)
assert v2["schema"] == "vertex-deploy-status-v2" and len(t.encode()) <= collect.HARD_MAX_BYTES
assert not collect.find_leaks(t, collect.LiveInputs().token()), "leak guard"
print("dry-run ok v2_bytes=%d" % len(t.encode()))
PY
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN=x -v "$STAGE/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then echo "TAILNET CONFIG INVALID - nothing installed"; exit 4; fi
echo "tailnet config valid"

# 3) install collector (v2 -> private dir) and the tailnet site
mkdir -p "$P"; chmod 700 "$P"
install -m 700 "$STAGE/collect.py" /opt/vertex-status/collect.py
install -m 644 "$STAGE/vertex-status-collect.service" /etc/systemd/system/vertex-status-collect.service
install -m 644 "$STAGE/Caddyfile.tailnet" /opt/vertex-status/Caddyfile.tailnet
systemctl daemon-reload
systemctl start vertex-status-collect.service
test -s "$P/status-v2.json" && test ! -e /opt/vertex-status/public/status-v2.json && echo "collector ok (v2 private only)"
# Mount the tailscaled socket DIRECTORY, not the socket file: a file mount keeps the old inode when
# tailscaled re-creates the socket, and TLS then fails. The drop-in keeps the directory across
# tailscaled restarts (same path and setting as infra/quantvps/tailscaled-preserve-runtime-dir.conf).
mkdir -p /etc/systemd/system/tailscaled.service.d
printf '[Service]\nRuntimeDirectoryPreserve=yes\n' > /etc/systemd/system/tailscaled.service.d/10-vertex-preserve-runtime-dir.conf
systemctl daemon-reload
docker rm -f vertex-status-tailnet >/dev/null 2>&1 || true
docker run -d --name vertex-status-tailnet --restart unless-stopped --network host --read-only \
  --tmpfs /tmp --tmpfs /config --tmpfs /data --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --memory 64m \
  --env-file /opt/vertex-status/token.env \
  -v /opt/vertex-status/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro -v "$P:/srv:ro" \
  -v /var/run/tailscale:/var/run/tailscale:ro caddy:2-alpine >/dev/null
sleep 6
echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# 4) non-allowed source check from the VPS itself (source = the VPS tailnet IP, not the rig): expect 403
H=$(mktemp /opt/vertex-status/.hdr-XXXXXX); chmod 600 "$H"
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$H"
C="cu""rl"; CODE=000
for i in $(seq 1 20); do
  CODE=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$H" "https://$TS_HOST:8443/vertex-status/v2" || true)
  [ "$CODE" != "000" ] && break; sleep 3
done
rm -f "$H"
echo "vps-self (non-allowed source, valid token): $CODE"
docker ps --filter name=vertex-status-tailnet --format '{{.Names}} {{.Status}}'
ss -ltnH | awk '{print $4}' | grep ':8443' || true
echo "rollback=$R"
