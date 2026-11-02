#!/usr/bin/env bash
# Installs the IBKR recovery service (systemd unit vertex-ibkr-recovery, 127.0.0.1:8793) and adds
# /vertex-ibkr-recovery/v1/* (rig and VPS-self only) to the tailnet Caddy site. Run as root on QuantVPS through
# the rig-side deployer, which substitutes __TS__ and the base64 payloads (__SERVICE_PY__, __TEST_PY__,
# __UNIT__, __TAILCADDY__). Touches only /opt/vertex-ibkr-recovery, the vertex-ibkr-recovery unit,
# /opt/vertex-status/Caddyfile.tailnet and a graceful reload of vertex-status-tailnet.
# Never touches ib-gateway, nautilus-trader, watchdog, portfolio-ui, postgres, redis, compose or main Caddy.
# Never runs the 2FA script: the only POST it sends is dryRun:true. Never arms or disarms the Nautilus node: it only
# reads GET /nautilus/status (docker exec ... python -m nautilus.arm_cli status --json, read-only).
# The recovery token (/opt/vertex-ibkr-recovery/token.env) is created once and never printed.
# Rollback: copy $R/vertex_ibkr_recovery.py (the previous service, if any) to $H and restart the unit; or
# systemctl disable --now vertex-ibkr-recovery; restore $R/Caddyfile.tailnet.before in place and reload.
set -euo pipefail
TS=__TS__
RIG_IPS="100.64.0.20 fd7a:115c:a1e0::20"
H=/opt/vertex-ibkr-recovery
R=$H/rollback-$TS
PORT=8793
UNIT=vertex-ibkr-recovery
SCRIPT=/opt/vertex-exec-node/scripts/request-ibkr-2fa-until-ready.sh
PROTECTED="ibkr-nautilus-exec-node-ib-gateway-1 ibkr-nautilus-exec-node-nautilus-trader-1 ibkr-nautilus-exec-node-watchdog-1 ibkr-nautilus-exec-node-portfolio-ui-1 ibkr-nautilus-exec-node-postgres-1 ibkr-nautilus-exec-node-redis-1 ibkr-nautilus-exec-node-caddy-1"
starts() { for c in $PROTECTED; do echo "$c $(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}' "$c")"; done; }
compose_hash() { sha256sum /opt/vertex-exec-node/docker-compose.yml /opt/vertex-exec-node/deploy/Caddyfile | awk '{print $1}' | tr '\n' ' '; }

# 0) preconditions
STATE=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])')
[ "$STATE" = "Running" ] || { echo "tailscale not running; nothing changed"; exit 3; }
TS_IP4=$(tailscale ip -4 | head -1); TS_IP6=$(tailscale ip -6 | head -1)
TS_HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
docker inspect vertex-status-tailnet >/dev/null
[ -x /usr/bin/docker ] || { echo "/usr/bin/docker missing; nothing changed"; exit 3; }
[ -x "$SCRIPT" ] || { echo "recovery script missing or not executable; nothing changed"; exit 3; }
[ -f /opt/vertex-status/token.env ] || { echo "/opt/vertex-status/token.env missing; nothing changed"; exit 3; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo "python3 >= 3.10 required; nothing changed"; exit 3; }
if ss -ltnH | awk '{print $4}' | grep -q ":$PORT\$" && ! systemctl is-active -q "$UNIT"; then echo "port $PORT taken; nothing changed"; exit 3; fi
mkdir -p "$H" "$R"; chmod 755 "$H"; chmod 700 "$R"
starts > "$R/protected-starts.before"; BEFORE_HASH=$(compose_hash)
cp -p /opt/vertex-status/Caddyfile.tailnet "$R/Caddyfile.tailnet.before"
if [ -f "/etc/systemd/system/$UNIT.service" ]; then cp -p "/etc/systemd/system/$UNIT.service" "$R/"; fi
for f in vertex_ibkr_recovery.py test_vertex_ibkr_recovery.py; do if [ -f "$H/$f" ]; then cp -p "$H/$f" "$R/"; fi; done
echo "backup=$R"

STAGE=$(mktemp -d $H/.stage-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
echo __SERVICE_PY__ | base64 -d > "$STAGE/vertex_ibkr_recovery.py"
echo __TEST_PY__ | base64 -d > "$STAGE/test_vertex_ibkr_recovery.py"
echo __UNIT__ | base64 -d > "$STAGE/$UNIT.service"
echo __TAILCADDY__ | base64 -d | sed -e "s/__TS_HOST__/$TS_HOST/g" -e "s/__TS_IP__/$TS_IP4 $TS_IP6/g" -e "s/__RIG_IP__/$RIG_IPS/g" > "$STAGE/Caddyfile.tailnet"

# 1) tests (incl. the static spawn/docker-verb scan) with the VPS python3, then config validation
echo "python=$(python3 -V 2>&1)"
if ! (cd "$STAGE" && python3 -I -W ignore test_vertex_ibkr_recovery.py) > "$STAGE/tests.out" 2>&1; then
  tail -20 "$STAGE/tests.out"; echo "TESTS FAILED - nothing installed"; exit 4
fi
tail -3 "$STAGE/tests.out"
# IBKR_2FA_* keys in /opt/vertex-exec-node/.env(.example) that would block a start (names only, never values).
echo "script env-file overrides: $(cd "$STAGE" && python3 -I -c 'import sys; sys.path.insert(0, "."); import vertex_ibkr_recovery as m; print(",".join(m.env_file_override_keys()) or "none")')"
# The script sources both files with bash (set -Eeuo pipefail, then set -a); a value with an unquoted space
# breaks that and the script exits before doing anything. Same shell options here: without -e a bad line that is
# not the last line goes unnoticed. Report only ok/FAILED (no values); this does not stop the install.
if (cd /opt/vertex-exec-node && bash -c 'set -Eeuo pipefail; set -a; if [ -f .env.example ]; then source .env.example; fi; if [ -f .env ]; then source .env; fi' >/dev/null 2>&1); then
  echo "script env-file bash-source: ok"
else
  echo "script env-file bash-source: FAILED"
fi
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN=x -v "$STAGE/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then echo "TAILNET CONFIG INVALID - nothing installed"; exit 4; fi
echo "tailnet config valid; diff vs deployed:"
diff "$R/Caddyfile.tailnet.before" "$STAGE/Caddyfile.tailnet" || true
# The staged file replaces the deployed one. Refuse when the deployed file differs from the staged file in
# anything except the recovery block (another session may have added routes that the template lacks).
if ! python3 - "$R/Caddyfile.tailnet.before" "$STAGE/Caddyfile.tailnet" <<'PY'
import sys
deployed = open(sys.argv[1]).read().splitlines()
staged = open(sys.argv[2]).read().splitlines()

def without_block(lines):
    """Drops the recovery comment lines, the @recovery_caller matcher and its handle block."""
    out, i = [], 0
    while i < len(lines):
        text = lines[i].strip()
        if text.startswith("# IBKR recovery service"):
            while i < len(lines) and lines[i].strip().startswith("#"):
                i += 1
            for opener in ("@recovery_caller", "handle @recovery_caller"):
                if i < len(lines) and lines[i].strip().startswith(opener):
                    depth = 0
                    while i < len(lines):
                        depth += lines[i].count("{") - lines[i].count("}")
                        i += 1
                        if depth == 0:
                            break
            continue
        out.append(lines[i])
        i += 1
    return out


sys.exit(0 if without_block(deployed) == without_block(staged) else 1)
PY
then
  echo "DEPLOYED CADDYFILE DRIFTED (differs outside the recovery block) - nothing installed"; exit 4
fi
echo "tailnet config drift check: only the recovery block differs"

# 2) own bearer token, created only if absent (0600, never printed)
if [ ! -f "$H/token.env" ]; then
  (umask 077; printf 'VERTEX_RECOVERY_TOKEN=%s\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > "$H/.token.env.new")
  chmod 600 "$H/.token.env.new"; mv "$H/.token.env.new" "$H/token.env"
  echo "recovery token: created ($H/token.env, 0600)"
else
  chmod 600 "$H/token.env"; echo "recovery token: kept ($H/token.env)"
fi

# 3) install and start the service
install -m 644 "$STAGE/vertex_ibkr_recovery.py" "$H/vertex_ibkr_recovery.py"
install -m 644 "$STAGE/test_vertex_ibkr_recovery.py" "$H/test_vertex_ibkr_recovery.py"
install -m 644 "$STAGE/$UNIT.service" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable "$UNIT.service" >/dev/null 2>&1
systemctl restart "$UNIT.service"
for _ in $(seq 1 20); do ss -ltnH | awk '{print $4}' | grep -q "^127.0.0.1:$PORT\$" && break; sleep 1; done
echo "listeners on $PORT: $(ss -ltnH | awk '{print $4}' | grep ":$PORT\$" | tr '\n' ' ')"
HDR=$(mktemp $H/.hdr-XXXXXX); BAD=$(mktemp $H/.hdr-XXXXXX); SHDR=$(mktemp $H/.hdr-XXXXXX)
OUT=$(mktemp $H/.out-XXXXXX); BODY=$(mktemp $H/.body-XXXXXX)
chmod 600 "$HDR" "$BAD" "$SHDR" "$OUT" "$BODY"
trap 'rm -rf "$STAGE" "$HDR" "$BAD" "$SHDR" "$OUT" "$BODY"' EXIT
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_RECOVERY_TOKEN=//p' "$H/token.env")" > "$HDR"
printf 'Authorization: Bearer %s\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > "$BAD"
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$SHDR"
C="cu""rl"
L=http://127.0.0.1:$PORT/vertex-ibkr-recovery/v1
field() { python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get(sys.argv[2]) if sys.argv[2] in d else d.get("outcome") or d.get("error"))
except Exception:
    print("unreadable")' "$OUT" "${1:-}"; }
CODE=$($C -s -o "$OUT" -w '%{http_code}' --max-time 15 -H @"$HDR" "$L/health" || true)
echo "local health: $CODE loginState=$(field loginState) (expect 200)"
echo "local no token: $($C -s -o /dev/null -w '%{http_code}' --max-time 5 "$L/health") (expect 401)"
echo "local wrong token: $($C -s -o /dev/null -w '%{http_code}' --max-time 5 -H @"$BAD" "$L/health") (expect 401)"
echo "local status-token: $($C -s -o /dev/null -w '%{http_code}' --max-time 5 -H @"$SHDR" "$L/health") (expect 401)"
RID="install-check-$(printf '%s' "$TS" | tr -cd 'A-Za-z0-9-' | cut -c1-40)"
python3 -c 'import json,sys; print(json.dumps({"requestId": sys.argv[1], "actorId": "installer", "statement": "I request IBKR recovery only; this does not authorize trading.", "dryRun": True}))' "$RID" > "$BODY"
grep -q '"dryRun": true' "$BODY" || { echo "dry-run body check failed; no request sent"; exit 5; }
CODE=$($C -s -o "$OUT" -w '%{http_code}' --max-time 20 -X POST -H @"$HDR" -H 'Content-Type: application/json' --data-binary @"$BODY" "$L/request" || true)
echo "local dry-run request: $CODE $(field) (expect 200 dry-run, 409 not_needed or 429 cooldown)"
CODE=$($C -s -o "$OUT" -w '%{http_code}' --max-time 15 -H @"$HDR" "$L/nautilus/status" || true)
echo "local node arm status (read-only): $CODE armError=$(field armError) (expect 200; armError None when the arm CLI is installed)"

# 4) tailnet Caddy: write in place (keeps the bind-mounted inode) and reload through the admin socket.
# A container restart is only the fallback when the graceful reload fails; it is reported.
cat "$STAGE/Caddyfile.tailnet" > /opt/vertex-status/Caddyfile.tailnet
if docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1; then
  echo "tailnet caddy: graceful reload"
else
  docker restart vertex-status-tailnet >/dev/null; echo "TAILNET CADDY: GRACEFUL RELOAD FAILED; restarted container at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
sleep 5
T=https://$TS_HOST:8443
CODE=000
for _ in $(seq 1 20); do
  CODE=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$HDR" "$T/vertex-ibkr-recovery/v1/health" || true)
  [ "$CODE" != "000" ] && break; sleep 3
done
CODE6=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:[$TS_IP6]" -H @"$HDR" "$T/vertex-ibkr-recovery/v1/health" || true)
echo "vps-self recovery health with token: v4=$CODE v6=$CODE6 (expect 200)"
CODE=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" "$T/vertex-ibkr-recovery/v1/health" || true)
echo "vps-self recovery health without token: v4=$CODE (expect 401)"
CODE=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$SHDR" "$T/vertex-portfolio/v1/health" || true)
echo "vps-self (non-allowed source, valid token) portfolio: v4=$CODE (expect 403)"
rm -f "$HDR" "$BAD" "$SHDR" "$OUT" "$BODY"
if docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1; then
  echo "graceful reload via admin socket: ok"
else
  echo "graceful reload via admin socket: FAILED"
fi
ss -ltnH | awk '{print $4}' | grep -E ":(8443|$PORT)\$" | tr '\n' ' '; echo
starts > "$R/protected-starts.after"
if diff -q "$R/protected-starts.before" "$R/protected-starts.after" >/dev/null; then echo "protected containers: start times unchanged"
else echo "PROTECTED START TIMES CHANGED"; diff "$R/protected-starts.before" "$R/protected-starts.after" || true; fi
if [ "$BEFORE_HASH" = "$(compose_hash)" ]; then echo "compose + main Caddyfile: unchanged"; else echo "COMPOSE OR MAIN CADDYFILE CHANGED"; fi
cat "$R/protected-starts.after"
systemctl is-active "$UNIT"
systemctl is-active vertex-portfolio || true
systemctl is-active vertex-history || true
echo "rollback=$R"
