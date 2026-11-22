#!/usr/bin/env bash
# Installs the read-only IBKR history service (bars, ticks, depth, tape; systemd unit vertex-history, 127.0.0.1:8791, IB client id 77)
# and adds /vertex-history/v1/* to the tailnet Caddy site. Run as root on QuantVPS through the rig-side
# deployer, which substitutes __TS__ and the base64 payloads. Touches only /opt/vertex-history, the
# vertex-history unit, /opt/vertex-status/Caddyfile.tailnet and the vertex-status-tailnet container.
# Never touches ib-gateway, nautilus-trader, watchdog, portfolio-ui, postgres, redis, compose or main Caddy.
set -euo pipefail
TS=__TS__
# The rig's tailnet IPv4 and IPv6 are host config on QuantVPS (VERTEX_RIG_IPS in /etc/vertex/hosts.env,
# not in git; public repository 2026-11-05). Missing or malformed: stop before any change.
RIG_IPS=$(sed -n 's/^VERTEX_RIG_IPS=//p' /etc/vertex/hosts.env 2>/dev/null | tail -1 || true)
[[ "$RIG_IPS" =~ ^[0-9a-f.:]*[0-9][0-9a-f.:]*( [0-9a-f.:]*[0-9][0-9a-f.:]*)*$ ]] || { echo "VERTEX_RIG_IPS missing or malformed in /etc/vertex/hosts.env; nothing changed"; exit 3; }
# market-hours-guard:start
# Owner rule 2026-11-16: no QuantVPS deploy during market hours. This script refuses on Monday to
# Friday from 08:30 to 16:00 New York time, and when the time cannot be read: GNU date falls back to
# UTC without an error when the zone data is missing, so the zone name must be EST or EDT. Market
# holidays count as trading days. There is no override: run it after 16:00 or before 08:30.
# VERTEX_DEPLOY_NY_TIME is a test hook ("<day 1-7> <HHMM> <zone>"); a set hook is printed.
[ -z "${VERTEX_DEPLOY_NY_TIME:-}" ] || echo "market hours guard: test hook VERTEX_DEPLOY_NY_TIME replaces the clock"
read -r NY_DOW NY_HM NY_Z _ <<<"${VERTEX_DEPLOY_NY_TIME:-$(TZ=America/New_York date +'%u %H%M %Z' 2>/dev/null || true)}" || true
if ! { [[ "${NY_DOW:-}" =~ ^[1-7]$ ]] && [[ "${NY_HM:-}" =~ ^([01][0-9]|2[0-3])[0-5][0-9]$ ]] && [[ "${NY_Z:-}" =~ ^E[SD]T$ ]] &&
  { [ "$NY_DOW" -gt 5 ] || [ $((10#$NY_HM)) -lt 830 ] || [ $((10#$NY_HM)) -ge 1600 ]; }; }; then
  echo "market hours (08:30-16:00 New York time on a weekday) or unknown time: no QuantVPS deploy now; nothing changed"
  exit 3
fi
# market-hours-guard:end
H=/opt/vertex-history
R=$H/rollback-$TS
# ibapi 10.30.1 (API 187; 163 is the minimum this service accepts), pure Python, no dependencies. IBAPI_TREE: SHA-256 over the bytes of the
# top-level ibapi/*.py files in sorted name order.
IBAPI_URL=https://files.pythonhosted.org/packages/42/cf/0ac25403435030814e8c60ef20d476acdc27140738f871c8d7f944e033e7/nautilus_ibapi-10.30.1-py3-none-any.whl
IBAPI_SHA=2aa0df654de46b469962f504541c388a099486c3e9aa5edb55a40e849ca00ed8
IBAPI_TREE=bb1de64dac66e6406dfbe0aeb9596405df4211e43ae09dc8fa48c2e3c9364dcc
VENV=$H/venv-${IBAPI_TREE:0:12}
TREE_PY='import ibapi,os,hashlib; d=os.path.dirname(ibapi.__file__); h=hashlib.sha256(); [h.update(open(os.path.join(d,f),"rb").read()) for f in sorted(os.listdir(d)) if f.endswith(".py")]; print(h.hexdigest())'
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
# What this install replaces; $H/rollback-history.sh $TS puts it back.
for f in vertex_history.py test_vertex_history.py resolve-gateway.sh; do [ -f "$H/$f" ] && cp -p "$H/$f" "$R/$f" || true; done
# The venv link target that runs now (the first run moves today's venv folder to venv-legacy-9.81.1 below).
if [ -L "$H/venv" ]; then readlink -f "$H/venv" > "$R/venv.previous"
elif [ -d "$H/venv" ]; then echo "$H/venv-legacy-9.81.1" > "$R/venv.previous"; fi
echo "backup=$R"

STAGE=$(mktemp -d $H/.stage-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
echo __SERVICE_PY__ | base64 -d > "$STAGE/vertex_history.py"
echo __TEST_PY__ | base64 -d > "$STAGE/test_vertex_history.py"
echo __UNIT__ | base64 -d > "$STAGE/vertex-history.service"
echo __RESOLVER__ | base64 -d > "$STAGE/resolve-gateway.sh"
echo __TAILCADDY__ | base64 -d | sed -e "s/__TS_HOST__/$TS_HOST/g" -e "s/__TS_IP__/$TS_IP4 $TS_IP6/g" -e "s/__RIG_IP__/$RIG_IPS/g" > "$STAGE/Caddyfile.tailnet"

# 1) isolated venv with ibapi 10.30.1 (no pip), built once per tree hash; nothing live changes here
if [ ! -x "$VENV/bin/python" ]; then
  rm -rf "$VENV.tmp"
  python3 -m venv --without-pip "$VENV.tmp"
  SITE=$("$VENV.tmp/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
  python3 - "$IBAPI_URL" "$IBAPI_SHA" "$SITE" <<'PY'
import hashlib, io, os, sys, urllib.request, zipfile
url, sha, site = sys.argv[1:4]
data = urllib.request.urlopen(url, timeout=60).read()
assert hashlib.sha256(data).hexdigest() == sha, "ibapi wheel sha256 mismatch"
z = zipfile.ZipFile(io.BytesIO(data))
names = z.namelist()
dist = {n.split("/", 1)[0] for n in names if n.split("/", 1)[0].endswith(".dist-info")}
assert len(dist) == 1, "wheel must hold one dist-info folder"
tops = {n.split("/", 1)[0] for n in names}
assert tops == dist | {"ibapi"}, "wheel holds more than ibapi/ and its dist-info: %s" % sorted(tops)
assert not any(n.endswith(".pth") for n in names), "wheel holds a .pth file"
meta = z.read(dist.pop() + "/METADATA").decode("utf-8", "replace")
assert not any(line.startswith("Requires-Dist:") for line in meta.splitlines()), "wheel has dependencies"
root = os.path.realpath(site)
files = [n for n in names if n.startswith("ibapi/") and n.count("/") == 1 and n.endswith(".py")]
for n in files:
    target = os.path.realpath(os.path.join(root, n))
    assert target.startswith(root + os.sep) and ".." not in n.split("/"), "unsafe path " + n
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(z.read(n))
print("ibapi installed files=%d" % len(files))
PY
  mv -T "$VENV.tmp" "$VENV"
fi
TREE=$("$VENV/bin/python" -c "$TREE_PY")
[ "$TREE" = "$IBAPI_TREE" ] || { echo "ibapi tree hash $TREE != $IBAPI_TREE; nothing installed"; exit 4; }
"$VENV/bin/python" -c 'import sys; from ibapi.server_versions import MAX_CLIENT_VER as v; sys.exit(0 if v >= 163 else 1)' \
  || { echo "ibapi MAX_CLIENT_VER below 163; nothing installed"; exit 4; }
echo "python=$("$VENV/bin/python" -V 2>&1) ibapi=$("$VENV/bin/python" -c 'import ibapi; print(ibapi.get_version_string())') tree=$TREE venv=$VENV"

# 2) tests (incl. the static no-order scan) with the new interpreter, and config validation
if ! (cd "$STAGE" && "$VENV/bin/python" -W ignore test_vertex_history.py > "$STAGE/test.log" 2>&1); then
  tail -30 "$STAGE/test.log"; echo "TESTS FAILED - nothing installed"; exit 4
fi
tail -3 "$STAGE/test.log"
"$VENV/bin/python" -c 'import ibapi.client as c; assert all(hasattr(c.EClient, m) for m in ("reqContractDetails","reqHistoricalData","cancelHistoricalData","reqHistoricalTicks","reqMktDepth","cancelMktDepth","reqTickByTickData","cancelTickByTickData"))' \
  || { echo "ibapi client lacks a needed call - nothing installed"; exit 4; }
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN=x -v "$STAGE/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then echo "TAILNET CONFIG INVALID - nothing installed"; exit 4; fi
echo "tailnet config valid; diff vs deployed:"
diff "$R/Caddyfile.tailnet.before" "$STAGE/Caddyfile.tailnet" || true

# Rollback script (static): $H/rollback-history.sh <ts> restores the files and the venv link of rollback-<ts>.
cat > "$H/rollback-history.sh.new" <<'ROLLBACK'
#!/usr/bin/env bash
# Restores /opt/vertex-history from rollback-<ts> (written by install-history.sh) and restarts vertex-history.
set -euo pipefail
TS=${1:?usage: rollback-history.sh <ts>}
H=/opt/vertex-history
R=$H/rollback-$TS
[ -d "$R" ] || { echo "no backup $R"; exit 2; }
systemctl stop vertex-history.service || true
[ -f "$R/vertex_history.py" ] && install -m 644 "$R/vertex_history.py" "$H/vertex_history.py"
[ -f "$R/test_vertex_history.py" ] && install -m 644 "$R/test_vertex_history.py" "$H/test_vertex_history.py"
[ -f "$R/resolve-gateway.sh" ] && install -m 755 "$R/resolve-gateway.sh" "$H/resolve-gateway.sh"
[ -f "$R/vertex-history.service" ] && install -m 644 "$R/vertex-history.service" /etc/systemd/system/vertex-history.service
if [ -f "$R/venv.previous" ]; then
  P=$(cat "$R/venv.previous")
  if [ ! -x "$P/bin/python" ]; then echo "venv target $P missing; venv unchanged"
  elif [ -L "$H/venv" ] || [ ! -e "$H/venv" ]; then ln -sfn "$P" "$H/.venv-link"; mv -T "$H/.venv-link" "$H/venv"; echo "venv -> $P"
  else echo "venv is still the folder from before the switch; venv unchanged"; fi
fi
if [ -f "$R/Caddyfile.tailnet.before" ] && ! cmp -s "$R/Caddyfile.tailnet.before" /opt/vertex-status/Caddyfile.tailnet; then
  cat "$R/Caddyfile.tailnet.before" > /opt/vertex-status/Caddyfile.tailnet
  docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 \
    || docker restart vertex-status-tailnet >/dev/null
  echo "tailnet caddy: restored"
fi
systemctl daemon-reload
systemctl start vertex-history.service
for i in $(seq 1 20); do ss -ltnH | awk '{print $4}' | grep -q '^127.0.0.1:8791$' && break; sleep 1; done
HDR=$(mktemp $H/.hdr-XXXXXX); chmod 600 "$HDR"; trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$HDR"
C="cu""rl"
echo "rolled back to rollback-$TS; health: $($C -s --max-time 5 -H @"$HDR" http://127.0.0.1:8791/vertex-history/v1/health || true)"
systemctl is-active vertex-history
ROLLBACK
chmod 755 "$H/rollback-history.sh.new"; mv -f "$H/rollback-history.sh.new" "$H/rollback-history.sh"

# 3) switch: stop, install, point the venv link at the new venv, start. From the stop until the smoke checks
# pass, any failing command runs rollback-history.sh (ERR trap), so the service is never left stopped.
if [ -d "$H/venv" ] && [ ! -L "$H/venv" ] && [ -e "$H/venv-legacy-9.81.1" ]; then
  echo "venv-legacy-9.81.1 exists and venv is a folder; nothing changed"; exit 4
fi
HDR=""; SMOKE=""
trap 'rm -rf "$STAGE" "$SMOKE" "$HDR"' EXIT
trap 'echo "SWITCH FAILED - rolling back"; "$H/rollback-history.sh" "$TS" || true' ERR
systemctl stop vertex-history.service 2>/dev/null || true
install -m 644 "$STAGE/vertex_history.py" "$H/vertex_history.py"
install -m 644 "$STAGE/test_vertex_history.py" "$H/test_vertex_history.py"
install -m 755 "$STAGE/resolve-gateway.sh" "$H/resolve-gateway.sh"
install -m 644 "$STAGE/vertex-history.service" /etc/systemd/system/vertex-history.service
if [ -d "$H/venv" ] && [ ! -L "$H/venv" ]; then mv -T "$H/venv" "$H/venv-legacy-9.81.1"; fi
ln -sfn "$VENV" "$H/.venv-link"; mv -T "$H/.venv-link" "$H/venv"
systemctl daemon-reload
systemctl enable vertex-history.service >/dev/null 2>&1
systemctl start vertex-history.service
for i in $(seq 1 20); do ss -ltnH | awk '{print $4}' | grep -q '^127.0.0.1:8791$' && break; sleep 1; done
echo "listeners on 8791: $(ss -ltnH | awk '{print $4}' | grep ':8791$' | tr '\n' ' ')"
HDR=$(mktemp $H/.hdr-XXXXXX); chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$HDR"
C="cu""rl"
echo "local health: $($C -s --max-time 5 -H @"$HDR" http://127.0.0.1:8791/vertex-history/v1/health)"
echo "local no token: $($C -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8791/vertex-history/v1/health)"

# Smoke checks: any failure rolls back to rollback-$TS and stops the install.
SMOKE=$(mktemp $H/.smoke-XXXXXX); chmod 600 "$SMOKE"
smoke_fail() { echo "SMOKE CHECK FAILED: $1 - rolling back"; "$H/rollback-history.sh" "$TS" || true; exit 5; }
fetch() { $C -s -o "$SMOKE" -w '%{http_code}' --max-time 90 -H @"$HDR" "http://127.0.0.1:8791/vertex-history/v1/$1" || true; }
# smoke <name> <path> <python test on the JSON body b>; on HTTP 429 waits retry_after (at most 60 s) once
smoke() {
  local code wait
  code=$(fetch "$2")
  if [ "$code" = 429 ]; then
    wait=$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); print(max(1, min(60, int(b.get("retry_after_seconds") or 10))))' "$SMOKE" 2>/dev/null || echo 10)
    echo "smoke $1: 429, waiting ${wait}s"; sleep "$wait"
    code=$(fetch "$2")
  fi
  [ "$code" = 200 ] || smoke_fail "$1 http=$code"
  python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); sys.exit(0 if eval(sys.argv[2], {}, {"b": b}) else 1)' "$SMOKE" "$3" \
    || smoke_fail "$1 answer: $(head -c 300 "$SMOKE")"
  echo "smoke $1: ok"
}
smoke health-ibapi "health" 'b.get("ibapi") == "10.30.1"'
smoke spy-shares "bars?symbol=SPY&barSize=1%20day&duration=1%20M" \
  'b["schema"] == "vertex-history-bars-v2" and b["volume_unit"] == "shares" and len(b["bars"]) > 0'
smoke es-contracts "bars?symbol=ES&secType=CONTFUT&exchange=CME&barSize=1%20day&duration=1%20M" \
  'b["schema"] == "vertex-history-bars-v2" and b["volume_unit"] == "contracts" and len(b["bars"]) > 0'
smoke eur-usd "bars?symbol=EUR&secType=CASH&exchange=IDEALPRO&whatToShow=MIDPOINT&barSize=1%20day&duration=1%20M" \
  'b["schema"] == "vertex-history-bars-v2" and len(b["bars"]) > 0'
smoke gbp-usd "bars?symbol=GBP&secType=CASH&exchange=IDEALPRO&whatToShow=MIDPOINT&barSize=1%20day&duration=1%20M" \
  'b["schema"] == "vertex-history-bars-v2" and len(b["bars"]) > 0'
smoke health-connected "health" 'b.get("connected") is True and b.get("ibapi") == "10.30.1"'

trap - ERR
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
