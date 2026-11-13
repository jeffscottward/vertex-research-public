#!/bin/sh
# ExecStartPre (root): write "<ib-gateway bridge IP> 4003" for the portfolio service. Read-only docker inspect.
# 4003 is the gateway container's socat port to the live API (the watchdog uses the same port).
set -eu
IP=$(docker inspect -f '{{with index .NetworkSettings.Networks "ibkr-nautilus-exec-node_prototype"}}{{.IPAddress}}{{end}}' ibkr-nautilus-exec-node-ib-gateway-1)
case "$IP" in 172.*) ;; *) echo "ib-gateway bridge IP not found" >&2; exit 1 ;; esac
printf '%s 4003\n' "$IP" > /run/vertex-portfolio/gateway
# The trading mode the gateway container is configured for (label, else its TRADING_MODE). The service
# reports it as the account mode and checks the managed account list against it. Word only.
C=ibkr-nautilus-exec-node-ib-gateway-1
MODE=$(docker inspect -f '{{index .Config.Labels "com.ibkr-nautilus-exec-node.trading-mode"}}' "$C" 2>/dev/null || true)
case "$MODE" in live|paper) ;; *)
  MODE=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null | sed -n 's/^TRADING_MODE=//p' | head -n 1) ;;
esac
case "$MODE" in live|paper) printf '%s\n' "$MODE" > /run/vertex-portfolio/mode ;; *) rm -f /run/vertex-portfolio/mode ;; esac
