#!/bin/sh
# ExecStartPre (root): write "<ib-gateway bridge IP> 4003" for the 0DTE quote collector. Read-only docker inspect;
# the same lookup as /opt/vertex-history/resolve-gateway.sh, into this unit's own runtime folder.
set -eu
IP=$(docker inspect -f '{{with index .NetworkSettings.Networks "ibkr-nautilus-exec-node_prototype"}}{{.IPAddress}}{{end}}' ibkr-nautilus-exec-node-ib-gateway-1)
case "$IP" in 172.*) ;; *) echo "ib-gateway bridge IP not found" >&2; exit 1 ;; esac
printf '%s 4003\n' "$IP" > /run/vertex-odte-quotes/gateway
