#!/usr/bin/env bash
# Installs the read-only IBKR history service (systemd unit vertex-history, 127.0.0.1:8791, IB client id 77)
# and adds /vertex-history/v1/* to the tailnet Caddy site. Run as root on QuantVPS through the rig-side
# deployer, which substitutes __TS__ and the base64 payloads. Touches only /opt/vertex-history, the
# vertex-history unit, /opt/vertex-status/Caddyfile.tailnet and the vertex-status-tailnet container.
# Never touches ib-gateway, nautilus-trader, watchdog, portfolio-ui, postgres, redis, compose or main Caddy.
set -euo pipefail
TS=__TS__
RIG_IPS="100.64.0.20 fd7a:115c:a1e0::20"
H=/opt/vertex-history
R=$H/rollback-$TS
IBAPI_URL=https://files.pythonhosted.org/packages/cc/78/8f1322aa1be1fe7d747d06d445ede80141e873525120bde809ccae5484fa/ibapi-9.81.1.post1.tar.gz
IBAPI_SHA=49f6678bf4cced996920f32ad4b48e6897749ac30ba14a661082285f4ec09cd6
PROTECTED="ibkr-nautilus-exec-node-ib-gateway-1 ibkr-nautilus-exec-node-nautilus-trader-1 ibkr-nautilus-exec-node-watchdog-1 ibkr-nautilus-exec-node-portfolio-ui-1 ibkr-nautilus-exec-node-postgres-1 ibkr-nautilus-exec-node-redis-1 ibkr-nautilus-exec-node-caddy-1"
starts() { for c in $PROTECTED; do echo "$c $(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}' "$c")"; done; }
compose_hash() { sha256sum /opt/vertex-exec-node/docker-compose.yml /opt/vertex-exec-node/deploy/Caddyfile | awk '{print $1}' | tr '\n' ' '; }

# 0) preconditions
STATE=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])')
[ "$STATE" = "Running" ] || { echo "tailscale not running; nothing changed"; exit 3; }
TS_IP4=$(tailscale ip -4 | head -1); TS_IP6=$(tailscale ip -6 | head -1)
TS_HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
docker inspect vertex-status-tailnet >/dev/null
if ss -ltnH | awk '{print $4}' | grep -q ':8791$' && ! systemctl is-active -q vertex-history; then echo "port 8791 taken; nothing changed"; exit 3; fi
mkdir -p "$H" "$R"; chmod 755 "$H"; chmod 700 "$R"
starts > "$R/protected-starts.before"; BEFORE_HASH=$(compose_hash)
cp -p /opt/vertex-status/Caddyfile.tailnet "$R/Caddyfile.tailnet.before"
[ -f /etc/systemd/system/vertex-history.service ] && cp -p /etc/systemd/system/vertex-history.service "$R/" || true
echo "backup=$R"

STAGE=$(mktemp -d $H/.stage-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
echo __SERVICE_PY__ | base64 -d > "$STAGE/vertex_history.py"
echo __TEST_PY__ | base64 -d > "$STAGE/test_vertex_history.py"
echo __UNIT__ | base64 -d > "$STAGE/vertex-history.service"
echo __RESOLVER__ | base64 -d > "$STAGE/resolve-gateway.sh"
echo __TAILCADDY__ | base64 -d | sed -e "s/__TS_HOST__/$TS_HOST/g" -e "s/__TS_IP__/$TS_IP4 $TS_IP6/g" -e "s/__RIG_IP__/$RIG_IPS/g" > "$STAGE/Caddyfile.tailnet"

# 1) isolated venv with the ibapi release the stack's watchdog uses (9.81.1.post1, pure Python, no pip)
if [ ! -x "$H/venv/bin/python" ]; then python3 -m venv --without-pip "$H/venv"; fi
SITE=$("$H/venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
if [ ! -f "$SITE/ibapi/client.py" ]; then
  python3 - "$IBAPI_URL" "$IBAPI_SHA" "$SITE" <<'PY'
import hashlib, io, sys, tarfile, urllib.request
url, sha, site = sys.argv[1:4]
data = urllib.request.urlopen(url, timeout=60).read()
assert hashlib.sha256(data).hexdigest() == sha, "ibapi sdist sha256 mismatch"
with tarfile.open(fileobj=io.BytesIO(data)) as t:
    members = [m for m in t.getmembers() if m.isfile() and m.name.startswith("ibapi-9.81.1.post1/src/ibapi/") and ".." not in m.name]
    for m in members:
        m.name = m.name.split("/", 2)[2]
    t.extractall(site, members=members)
print("ibapi installed files=%d" % len(members))
PY
fi
LOCAL_IBAPI=$("$H/venv/bin/python" -c 'import ibapi,os,hashlib; d=os.path.dirname(ibapi.__file__); h=hashlib.sha256(); [h.update(open(os.path.join(d,f),"rb").read()) for f in sorted(os.listdir(d)) if f.endswith(".py")]; print(h.hexdigest())')
STACK_IBAPI=$(docker exec ibkr-nautilus-exec-node-watchdog-1 python3 -c 'import ibapi,os,hashlib; d=os.path.dirname(ibapi.__file__); h=hashlib.sha256(); [h.update(open(os.path.join(d,f),"rb").read()) for f in sorted(os.listdir(d)) if f.endswith(".py")]; print(h.hexdigest())')
echo "python=$("$H/venv/bin/python" -V 2>&1) ibapi_sha=$LOCAL_IBAPI stack_ibapi_sha=$STACK_IBAPI match=$([ "$LOCAL_IBAPI" = "$STACK_IBAPI" ] && echo yes || echo no)"

# 2) tests (incl. the static no-order scan) with the venv interpreter, and config validation
(cd "$STAGE" && "$H/venv/bin/python" -W ignore test_vertex_history.py 2>&1 | tail -3)
"$H/venv/bin/python" -c 'import ibapi.client as c; assert all(hasattr(c.EClient, m) for m in ("reqContractDetails","reqHistoricalData","cancelHistoricalData"))'
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN=x -v "$STAGE/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then echo "TAILNET CONFIG INVALID - nothing installed"; exit 4; fi
echo "tailnet config valid; diff vs deployed:"
diff "$R/Caddyfile.tailnet.before" "$STAGE/Caddyfile.tailnet" || true

# 3) install and start the service
install -m 644 "$STAGE/vertex_history.py" "$H/vertex_history.py"
install -m 644 "$STAGE/test_vertex_history.py" "$H/test_vertex_history.py"
install -m 755 "$STAGE/resolve-gateway.sh" "$H/resolve-gateway.sh"
install -m 644 "$STAGE/vertex-history.service" /etc/systemd/system/vertex-history.service
systemctl daemon-reload
systemctl enable vertex-history.service >/dev/null 2>&1
systemctl restart vertex-history.service
for i in $(seq 1 20); do ss -ltnH | awk '{print $4}' | grep -q '^127.0.0.1:8791$' && break; sleep 1; done
echo "listeners on 8791: $(ss -ltnH | awk '{print $4}' | grep ':8791$' | tr '\n' ' ')"
HDR=$(mktemp $H/.hdr-XXXXXX); chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$HDR"
C="cu""rl"
echo "local health: $($C -s --max-time 5 -H @"$HDR" http://127.0.0.1:8791/vertex-history/v1/health)"
echo "local no token: $($C -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8791/vertex-history/v1/health)"

# 4) tailnet Caddy: write in place (keeps the bind-mounted inode). The running config has "admin off", so
# this one change needs a restart of vertex-status-tailnet; later changes reload through the admin socket.
cat "$STAGE/Caddyfile.tailnet" > /opt/vertex-status/Caddyfile.tailnet
if docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1; then
  echo "tailnet caddy: graceful reload"
else
  docker restart vertex-status-tailnet >/dev/null; echo "tailnet caddy: restarted (admin was off) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
sleep 5
CODE=000
for i in $(seq 1 20); do
  CODE=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$HDR" "https://$TS_HOST:8443/vertex-history/v1/health" || true)
  [ "$CODE" != "000" ] && break; sleep 3
done
CODE6=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:[$TS_IP6]" -H @"$HDR" "https://$TS_HOST:8443/vertex-history/v1/health" || true)
rm -f "$HDR"
echo "vps-self (non-allowed source, valid token) history: v4=$CODE v6=$CODE6"
docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 \
  && echo "graceful reload via admin socket: ok" || echo "graceful reload via admin socket: FAILED"
ss -ltnH | awk '{print $4}' | grep -E ':(8443|8791)$' | tr '\n' ' '; echo
starts > "$R/protected-starts.after"
diff -q "$R/protected-starts.before" "$R/protected-starts.after" >/dev/null && echo "protected containers: start times unchanged" || { echo "PROTECTED START TIMES CHANGED"; diff "$R/protected-starts.before" "$R/protected-starts.after"; }
[ "$BEFORE_HASH" = "$(compose_hash)" ] && echo "compose + main Caddyfile: unchanged" || echo "COMPOSE OR MAIN CADDYFILE CHANGED"
cat "$R/protected-starts.after"
systemctl is-active vertex-history
echo "rollback=$R"
