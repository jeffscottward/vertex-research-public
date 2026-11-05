#!/usr/bin/env bash
# Recreate the two tailnet Caddy proxies on QuantVPS so that they survive a tailscaled restart.
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias.
#
#   vertex-web-tailnet     https://<host>.ts.net:3451  -> vertex-web (127.0.0.1:3450)
#   vertex-status-tailnet  https://<host>.ts.net:8443  -> status/history/portfolio/recovery routes
#
# Both get their TLS certificate from tailscaled over /var/run/tailscale/tailscaled.sock. A bind mount
# of the socket FILE keeps the old inode after tailscaled re-creates the socket, and TLS then fails.
# So the containers mount the DIRECTORY /var/run/tailscale, and the tailscaled drop-in
# `RuntimeDirectoryPreserve=yes` keeps that directory across tailscaled restarts.
#
# Steps on QuantVPS (as root):
#   1. install the drop-in to /etc/systemd/system/tailscaled.service.d/ and run `systemctl daemon-reload`
#      (tailscaled is NOT restarted);
#   2. recreate both containers with the read-only directory mount (same image, flags and other mounts as before);
#   3. check that each container sees the host socket inode.
# Host values (public repository, 2026-11-05): the committed Caddyfile names no host. vertex-web-tailnet
# reads VERTEX_TAILNET_HOST and VERTEX_TAILNET_IPV4 from the host-local /etc/vertex/hosts.env (not in git);
# the script refuses to run when either value is missing or malformed.
# It never touches tailscaled itself, vertex-web, Nautilus, the IB gateway, the exec node, the recovery
# bridge or any trading container.
#
# Usage: infra/quantvps/recreate-tailnet-proxies.sh [--dry-run]
#   --dry-run  print the remote program only; change nothing.
# Exit codes: 0 done and the inodes match; 2 usage error; 3 a precondition failed (nothing changed);
#   4 a container does not see the host socket inode after the recreate; 5 the drop-in was written but
#   systemd does not report it (containers unchanged); 6 a `docker run` failed and that proxy is down.
# Test hook: VERTEX_TAILNET_SSH replaces the ssh command (it receives the program on stdin).
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)
DROPIN_B64=$(base64 -w0 "$HERE/tailscaled-preserve-runtime-dir.conf")

remote_program() {
  printf 'DROPIN_B64=%q\n' "$DROPIN_B64"
  cat <<'REMOTE'
set -euo pipefail
ROOT=${VERTEX_TAILNET_ROOT:-}
SOCK_DIR=/var/run/tailscale
DROPIN_DIR=$ROOT/etc/systemd/system/tailscaled.service.d
DROPIN=$DROPIN_DIR/10-vertex-preserve-runtime-dir.conf
for f in "$ROOT/opt/vertex-web-tailnet/Caddyfile" "$ROOT/opt/vertex-status/Caddyfile.tailnet" "$ROOT/opt/vertex-status/token.env"; do
  [ -s "$f" ] || { echo "missing $f; nothing changed"; exit 3; }
done
[ -d "$ROOT/opt/vertex-status/private-v2" ] || { echo "missing private-v2; nothing changed"; exit 3; }
[ -S "$ROOT$SOCK_DIR/tailscaled.sock" ] || { echo "no tailscaled socket; nothing changed"; exit 3; }
HOSTS_ENV=/etc/vertex/hosts.env
host_value() { sed -n "s/^$1=//p" "$ROOT$HOSTS_ENV" 2>/dev/null | tail -1 || true; }
TS_HOST=$(host_value VERTEX_TAILNET_HOST); TS_IP4=$(host_value VERTEX_TAILNET_IPV4)
[[ "$TS_HOST" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || { echo "VERTEX_TAILNET_HOST missing or malformed in $HOSTS_ENV; nothing changed"; exit 3; }
[[ "$TS_IP4" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "VERTEX_TAILNET_IPV4 missing or malformed in $HOSTS_ENV; nothing changed"; exit 3; }

# 1) drop-in: keep /run/tailscale across tailscaled restarts
mkdir -p "$DROPIN_DIR"
echo "$DROPIN_B64" | base64 -d > "$DROPIN.tmp"
mv "$DROPIN.tmp" "$DROPIN"; chmod 644 "$DROPIN"
systemctl daemon-reload
[ "$(systemctl show -p RuntimeDirectoryPreserve --value tailscaled)" = "yes" ] || { echo "drop-in written but not active; containers unchanged"; exit 5; }
echo "drop-in ok: RuntimeDirectoryPreserve=yes"

# 2) recreate both proxies with the directory mount
docker rm -f vertex-web-tailnet >/dev/null 2>&1 || true
docker run -d --name vertex-web-tailnet --restart unless-stopped --network host --read-only \
  --tmpfs /tmp --tmpfs /config --tmpfs /data --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --env-file "$HOSTS_ENV" \
  -v /opt/vertex-web-tailnet/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v "$SOCK_DIR:$SOCK_DIR:ro" caddy:2-alpine >/dev/null \
  || { echo "CONTAINER RUN FAILED; proxy is down"; exit 6; }
docker rm -f vertex-status-tailnet >/dev/null 2>&1 || true
docker run -d --name vertex-status-tailnet --restart unless-stopped --network host --read-only \
  --tmpfs /tmp --tmpfs /config --tmpfs /data --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --memory 64m \
  --env-file /opt/vertex-status/token.env \
  -v /opt/vertex-status/Caddyfile.tailnet:/etc/caddy/Caddyfile:ro -v /opt/vertex-status/private-v2:/srv:ro \
  -v "$SOCK_DIR:$SOCK_DIR:ro" caddy:2-alpine >/dev/null \
  || { echo "CONTAINER RUN FAILED; proxy is down"; exit 6; }
echo "recreated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 3) each container must see the host socket inode
HOST_INODE=$(stat -c %i "$ROOT$SOCK_DIR/tailscaled.sock")
rc=0
for c in vertex-web-tailnet vertex-status-tailnet; do
  CI=$(docker exec "$c" stat -c %i "$SOCK_DIR/tailscaled.sock" 2>/dev/null || echo none)
  if [ "$CI" = "$HOST_INODE" ]; then echo "$c inode ok ($CI)"; else echo "$c inode MISMATCH host=$HOST_INODE ctr=$CI"; rc=4; fi
done
exit $rc
REMOTE
}

if [ "$DRY" = 1 ]; then remote_program; exit 0; fi
read -r -a SSH_CMD <<<"${VERTEX_TAILNET_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 quantvps sudo -n bash -s}"
remote_program | "${SSH_CMD[@]}"
