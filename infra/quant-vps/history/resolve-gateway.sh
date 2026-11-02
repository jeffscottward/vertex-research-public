#!/bin/sh
# ExecStartPre (root): write "<ib-gateway bridge IP> 4003" for the history service. Read-only docker inspect.
# 4003 is the gateway container's socat port to the live API (the watchdog uses the same port).
set -eu
IP=$(docker inspect -f '{{with index .NetworkSettings.Networks "ibkr-nautilus-exec-node_prototype"}}{{.IPAddress}}{{end}}' ibkr-nautilus-exec-node-ib-gateway-1)
case "$IP" in 172.*) ;; *) echo "ib-gateway bridge IP not found" >&2; exit 1 ;; esac
printf '%s 4003\n' "$IP" > /run/vertex-history/gateway
