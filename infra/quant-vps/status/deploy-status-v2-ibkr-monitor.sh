#!/usr/bin/env bash
# Deploy collect.py (2.4.0: status-v2 positions, orders, fills & equity from ibkr-monitor.service)
# on QuantVPS and retire any transitional vertex-ibkr-open-orders-refresh.{service,timer} units.
# Run as root on QuantVPS outside market hours (after 16:00 ET or before 08:30 ET).
# Installs collect.py only and retires only the transitional open-orders timer AFTER verifying
# live status-v2 positions, orders, fills, and equity from ibkr-monitor.service. Never touches
# trading units, ibkr-monitor.service, Nautilus, IB Gateway, watchdog, compose, Caddy, or vertex-web.
set -euo pipefail
SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
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

[ -f "$SRC_DIR/collect.py" ] || { echo "missing required file: $SRC_DIR/collect.py"; exit 2; }

# Preflight: dry-run the candidate collector against live ibkr-monitor.service into a temp directory.
# If ibkr-monitor is unreachable, disconnected, or stale, abort before installing or retiring anything.
STAGE=$(mktemp -d /tmp/vx-status-ibkr-monitor-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pub" "$STAGE/priv"
if ! python3 "$SRC_DIR/collect.py" --v2 --out "$STAGE/pub" --v2-out "$STAGE/priv" --verify-ibkr-monitor; then
  echo "preflight dry-run failed (ibkr-monitor positions/orders/fills/equity not fresh); nothing changed"
  exit 4
fi

# Record protected container start times before touching anything (same list as deploy-status-v2-alert.sh).
protected_starts() {
  for c in ibkr-nautilus-exec-node-ib-gateway-1 ibkr-nautilus-exec-node-nautilus-trader-1 \
           ibkr-nautilus-exec-node-watchdog-1 ibkr-nautilus-exec-node-portfolio-ui-1 \
           ibkr-nautilus-exec-node-caddy-1 vertex-postgres vertex-web-tailnet; do
    printf '%s=%s\n' "$c" "$(docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null || echo absent)"
  done
}
BEFORE_STARTS=$(protected_starts)

# Back up the previous collector and any installed transitional open-orders units before modifying live state.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BAK_DIR="/opt/vertex-status/rollback-${STAMP}-ibkr-monitor"
mkdir -p "$BAK_DIR"
[ -f /opt/vertex-status/collect.py ] && cp -p /opt/vertex-status/collect.py "$BAK_DIR/collect.py.before"
for u in vertex-ibkr-open-orders-refresh.service vertex-ibkr-open-orders-refresh.timer; do
  [ -f "/etc/systemd/system/$u" ] && cp -p "/etc/systemd/system/$u" "$BAK_DIR/$u"
done
echo "backup=$BAK_DIR"

# Install the updated collector and trigger one live run before retiring the transitional timer.
# If either the live run or verification fails, roll back collect.py before exiting.
install -m 700 "$SRC_DIR/collect.py" /opt/vertex-status/collect.py
if ! systemctl start vertex-status-collect.service \
  || ! python3 /opt/vertex-status/collect.py --check-v2-dir /opt/vertex-status/private-v2 --check-public-dir /opt/vertex-status/public; then
  echo "live collector verification failed; restoring previous collect.py and leaving transitional timer untouched"
  if [ -f "$BAK_DIR/collect.py.before" ]; then
    install -m 700 "$BAK_DIR/collect.py.before" /opt/vertex-status/collect.py
    systemctl start vertex-status-collect.service || true
  fi
  exit 5
fi

# Retire the transitional open-orders refresh timer and service (idempotent if already absent).
systemctl disable --now vertex-ibkr-open-orders-refresh.timer 2>/dev/null || true
rm -f /etc/systemd/system/vertex-ibkr-open-orders-refresh.service \
      /etc/systemd/system/vertex-ibkr-open-orders-refresh.timer
systemctl daemon-reload
systemctl reset-failed vertex-ibkr-open-orders-refresh.service 2>/dev/null || true

if [ -e /etc/systemd/system/vertex-ibkr-open-orders-refresh.service ] \
  || [ -e /etc/systemd/system/vertex-ibkr-open-orders-refresh.timer ] \
  || [ "$(systemctl is-active vertex-ibkr-open-orders-refresh.timer 2>/dev/null || true)" = "active" ] \
  || [ "$(systemctl is-enabled vertex-ibkr-open-orders-refresh.timer 2>/dev/null || true)" = "enabled" ]; then
  echo "transitional timer retirement check failed"
  exit 5
fi
echo "retired_timer=ok"

AFTER_STARTS=$(protected_starts)
[ "$BEFORE_STARTS" = "$AFTER_STARTS" ] || { echo "PROTECTED CONTAINER START TIME CHANGED"; exit 6; }
echo "protected_containers=unchanged"
