#!/usr/bin/env bash
# Deploy the scheduled IBKR open-orders report refresh units on QuantVPS.
# Run as root on QuantVPS outside market hours (after 16:00 ET or before 08:30 ET).
# Installs two systemd unit files only; never touches trading units, Nautilus,
# IB Gateway, watchdog, compose, Caddy, or vertex-web.
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

SERVICE_NAME="vertex-ibkr-open-orders-refresh.service"
TIMER_NAME="vertex-ibkr-open-orders-refresh.timer"
CONTAINER_NAME="ibkr-nautilus-exec-node-portfolio-ui-1"

for req in "$SERVICE_NAME" "$TIMER_NAME"; do
  [ -f "$SRC_DIR/$req" ] || { echo "missing required file: $SRC_DIR/$req"; exit 2; }
done

# Preflight: confirm the portfolio-ui container, frozen writer, Python venv, and timeout exist.
if ! docker exec "$CONTAINER_NAME" test -f /app/scripts/ibkr_open_orders.py \
  || ! docker exec "$CONTAINER_NAME" test -x /opt/ibkr-snapshot-venv/bin/python3 \
  || ! docker exec "$CONTAINER_NAME" test -x /usr/bin/timeout; then
  echo "preflight failed ($CONTAINER_NAME or frozen writer/runtime missing); nothing changed"
  exit 4
fi

# Record protected container start times before installing units (same list as deploy-status-v2-alert.sh).
protected_starts() {
  for c in ibkr-nautilus-exec-node-ib-gateway-1 ibkr-nautilus-exec-node-nautilus-trader-1 \
           ibkr-nautilus-exec-node-watchdog-1 ibkr-nautilus-exec-node-portfolio-ui-1 \
           ibkr-nautilus-exec-node-caddy-1 vertex-postgres vertex-web-tailnet; do
    printf '%s=%s\n' "$c" "$(docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null || echo absent)"
  done
}
BEFORE_STARTS=$(protected_starts)

# Back up any pre-existing unit files before overwriting.
if [ -f "/etc/systemd/system/$SERVICE_NAME" ] || [ -f "/etc/systemd/system/$TIMER_NAME" ]; then
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BAK_DIR="/opt/vertex-status/rollback-${STAMP}-open-orders-refresh"
  mkdir -p "$BAK_DIR"
  for u in "$SERVICE_NAME" "$TIMER_NAME"; do
    [ -f "/etc/systemd/system/$u" ] && cp -p "/etc/systemd/system/$u" "$BAK_DIR/$u"
  done
  echo "backup=$BAK_DIR"
fi

install -m 644 "$SRC_DIR/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
install -m 644 "$SRC_DIR/$TIMER_NAME" "/etc/systemd/system/$TIMER_NAME"
systemctl daemon-reload

# Run the service once before enabling the timer (avoids racing OnBootSec=2min on a booted host).
START_RC=0
systemctl start vertex-ibkr-open-orders-refresh.service || START_RC=$?
journalctl -u "$SERVICE_NAME" -n 5 --no-pager || true
RESULT=$(systemctl show -p Result --value "$SERVICE_NAME")
STATUS=$(systemctl show -p ExecMainStatus --value "$SERVICE_NAME")
echo "first_run: result=${RESULT} exit_status=${STATUS} start_rc=${START_RC}"
[ "$START_RC" = "0" ] && [ "$RESULT" = "success" ] && [ "$STATUS" = "0" ] || { echo "first run failed"; exit 5; }

systemctl enable --now vertex-ibkr-open-orders-refresh.timer

AFTER_STARTS=$(protected_starts)
[ "$BEFORE_STARTS" = "$AFTER_STARTS" ] || { echo "PROTECTED CONTAINER START TIME CHANGED"; exit 6; }
echo "protected_containers=unchanged"
