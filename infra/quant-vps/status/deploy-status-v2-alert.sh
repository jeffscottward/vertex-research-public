#!/usr/bin/env bash
# Deploy updated Caddyfile.tailnet (@status_v2_caller for rig + VPS self) and the
# vertex-status-v2-alert.{service,timer} probe on QuantVPS. Run as root on QuantVPS outside
# market hours (after 16:00 ET or before 08:30 ET). Never touches trading units, Nautilus,
# IB Gateway, watchdog, compose, main Caddy, or vertex-web.
set -euo pipefail
SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
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

for req in Caddyfile.tailnet status_v2_alert.py vertex-status-v2-alert.service vertex-status-v2-alert.timer; do
  [ -f "$SRC_DIR/$req" ] || { echo "missing required file: $SRC_DIR/$req"; exit 2; }
done

TS_HOST=$(sed -n 's/^VERTEX_TAILNET_HOST=//p' /etc/vertex/hosts.env 2>/dev/null | tail -1 || true)
[[ "$TS_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "VERTEX_TAILNET_HOST missing or malformed in /etc/vertex/hosts.env; nothing changed"; exit 3; }
TS_IP4=$(tailscale ip -4 | head -1)
TS_IP6=$(tailscale ip -6 | head -1)
[ -n "$TS_IP4" ] && [ -n "$TS_IP6" ] || { echo "tailscale ip missing; nothing changed"; exit 3; }

STAGE=$(mktemp -d /tmp/vx-status-v2-deploy-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
sed -e "s/__TS_HOST__/$TS_HOST/g" \
    -e "s/__TS_IP__/$TS_IP4 $TS_IP6/g" \
    -e "s/__RIG_IP__/$RIG_IPS/g" \
    "$SRC_DIR/Caddyfile.tailnet" > "$STAGE/Caddyfile.tailnet"

# Validate rendered Caddyfile in an isolated container before touching live state.
if ! docker run --rm --network none -e VERTEX_STATUS_TOKEN=x \
  -v "$STAGE/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  echo "TAILNET CONFIG INVALID - nothing installed"
  exit 4
fi

# Record protected trading container start times before touching Caddy.
protected_starts() {
  for c in ibkr-nautilus-exec-node-ib-gateway-1 ibkr-nautilus-exec-node-nautilus-trader-1 \
           ibkr-nautilus-exec-node-watchdog-1 ibkr-nautilus-exec-node-portfolio-ui-1 \
           ibkr-nautilus-exec-node-caddy-1 vertex-postgres vertex-web-tailnet; do
    printf '%s=%s\n' "$c" "$(docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null || echo absent)"
  done
}
BEFORE_STARTS=$(protected_starts)

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BAK="/opt/vertex-status/Caddyfile.tailnet.bak-${STAMP}-v2alert"
cp -p /opt/vertex-status/Caddyfile.tailnet "$BAK"
echo "backup=$BAK"

# Write in place (preserve inode for the Docker single-file bind mount) and reload gracefully.
cat "$STAGE/Caddyfile.tailnet" > /opt/vertex-status/Caddyfile.tailnet
docker exec vertex-status-tailnet caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock
echo "caddy_reloaded=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Install alert probe script (0755 so DynamicUser=yes can read/execute) and systemd units.
chmod 755 /opt/vertex-status
install -m 755 "$SRC_DIR/status_v2_alert.py" /opt/vertex-status/status_v2_alert.py
install -m 644 "$SRC_DIR/vertex-status-v2-alert.service" /etc/systemd/system/vertex-status-v2-alert.service
install -m 644 "$SRC_DIR/vertex-status-v2-alert.timer" /etc/systemd/system/vertex-status-v2-alert.timer
systemctl daemon-reload
systemctl enable --now vertex-status-v2-alert.timer
systemctl start vertex-status-v2-alert.service
journalctl -u vertex-status-v2-alert.service -n 5 --no-pager

# Verify VPS-self access matrix: /vertex-status/v2 valid=200, no-token=403, wrong-token=403;
# /vertex-history and /vertex-portfolio remain rig-only (403 from VPS).
H=$(mktemp /opt/vertex-status/.hdr-XXXXXX)
chmod 600 "$H"
trap 'rm -rf "$STAGE" "$H"' EXIT
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^VERTEX_STATUS_TOKEN=//p' /opt/vertex-status/token.env)" > "$H"
C="cu""rl"
V2_OK=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$H" "https://$TS_HOST:8443/vertex-status/v2" || true)
V2_NO=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" "https://$TS_HOST:8443/vertex-status/v2" || true)
V2_BAD=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H "Authorization: Bearer invalid-probe" "https://$TS_HOST:8443/vertex-status/v2" || true)
HIST=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$H" "https://$TS_HOST:8443/vertex-history/v1/health" || true)
PORT=$($C -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TS_HOST:8443:$TS_IP4" -H @"$H" "https://$TS_HOST:8443/vertex-portfolio/v1/health" || true)
echo "probes: v2_valid=$V2_OK v2_notoken=$V2_NO v2_wrongtoken=$V2_BAD history=$HIST portfolio=$PORT"
[ "$V2_OK" = "200" ] && [ "$V2_NO" = "403" ] && [ "$V2_BAD" = "403" ] && [ "$HIST" = "403" ] && [ "$PORT" = "403" ] || { echo "post-deploy probe check failed"; exit 5; }

AFTER_STARTS=$(protected_starts)
[ "$BEFORE_STARTS" = "$AFTER_STARTS" ] || { echo "PROTECTED CONTAINER START TIME CHANGED"; exit 6; }
echo "protected_containers=unchanged"
