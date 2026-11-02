#!/bin/sh
# Forced command for the ibkr-monitor 2FA key. Only two fixed actions.
case "$SSH_ORIGINAL_COMMAND" in
  cooldown)
    cat /opt/vertex-exec-node/data/watchdog/ib-gateway-restart.timestamp 2>/dev/null; echo; date +%s ;;
  trigger)
    cd /opt/vertex-exec-node || exit 1
    IBKR_2FA_NOTIFY_ENABLED=0 IBKR_2FA_MAX_ATTEMPTS=1 IBKR_2FA_APPROVAL_TIMEOUT_SECONDS=180 \
      exec scripts/request-ibkr-2fa-until-ready.sh ;;
  *) echo "ibkr-monitor 2fa key: denied" >&2; exit 1 ;;
esac
