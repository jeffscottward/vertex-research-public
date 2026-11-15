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
# Steps on QuantVPS (as root), full mode (the default):
#   1. check the committed Caddyfile with `caddy validate` in a throwaway container (nothing changed on failure);
#   2. install the drop-in to /etc/systemd/system/tailscaled.service.d/ and run `systemctl daemon-reload`
#      (tailscaled is NOT restarted);
#   3. install the checked Caddyfile and recreate both containers with the read-only directory mounts
#      (same image, flags and other mounts as before);
#   4. check that each container sees the host socket inode.
# Host values (public repository, 2026-11-05): the committed Caddyfile names no host. vertex-web-tailnet
# reads VERTEX_TAILNET_HOST and VERTEX_TAILNET_IPV4 from the host-local /etc/vertex/hosts.env (not in git);
# the script refuses to run when either value is missing or malformed.
# Proxy file (2026-11-15): this script is the only writer of the installed vertex-web-tailnet Caddyfile.
#   /opt/vertex-web-tailnet/caddy/Caddyfile   copy of the committed infra/quantvps/Caddyfile; the directory
#                                             is mounted read-only at /etc/caddy and holds nothing else, so a
#                                             replaced file is visible in the container
#   /opt/vertex-web-tailnet/staging/          the new copy while it is checked; removed when the script ends
#   /opt/vertex-web-tailnet/Caddyfile.prev    --caddyfile-only: the replaced file, until the reload has passed
#   /opt/vertex-web-tailnet/Caddyfile.bak-*   files of the old single-file mount (literal host values),
#                                             outside the mounted directory
# --caddyfile-only installs a changed Caddyfile with `caddy reload`: no container is removed, the proxy keeps
# its listeners, and a run with the committed file already installed changes nothing (it only repeats the
# reload, which Caddy ignores for a config that it already runs).
# It never touches tailscaled itself, vertex-web, Nautilus, the IB gateway, the exec node, the recovery
# bridge or any trading container.
#
# Usage: infra/quantvps/recreate-tailnet-proxies.sh [--caddyfile-only] [--dry-run]
#   --caddyfile-only  install the committed Caddyfile and reload vertex-web-tailnet; recreate nothing.
#   --dry-run         print the remote program only; change nothing.
# Exit codes: 0 done (full mode: the inodes match); 2 usage error; 3 a precondition failed (nothing changed);
#   4 a container does not see the host socket inode after the recreate; 5 the drop-in was written but
#   systemd does not report it (containers unchanged); 6 a `docker run` failed or vertex-web-tailnet did not stay up: that proxy is down;
#   7 (--caddyfile-only) `caddy reload` failed: Caddy keeps the old config and its file is back.
# Test hooks: VERTEX_TAILNET_SSH replaces the ssh command (it receives the program on stdin);
#   VERTEX_TAILNET_SETTLE_SECONDS (remote side) replaces the 3 s wait before the stay-up check.
set -euo pipefail

DRY=0
MODE=full
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --caddyfile-only) MODE=caddyfile ;;
    *) echo "usage: $0 [--caddyfile-only] [--dry-run]" >&2; exit 2 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
DROPIN_B64=$(base64 -w0 "$HERE/tailscaled-preserve-runtime-dir.conf")
CADDYFILE_B64=$(base64 -w0 "$HERE/Caddyfile")

remote_program() {
  printf 'DROPIN_B64=%q\nCADDYFILE_B64=%q\nMODE=%q\n' "$DROPIN_B64" "$CADDYFILE_B64" "$MODE"
  cat <<'REMOTE'
set -euo pipefail
# Everything runs inside main, so a program that the connection cut short runs nothing.
main() {
ROOT=${VERTEX_TAILNET_ROOT:-}
SOCK_DIR=/var/run/tailscale
DROPIN_DIR=$ROOT/etc/systemd/system/tailscaled.service.d
DROPIN=$DROPIN_DIR/10-vertex-preserve-runtime-dir.conf
WEB_DIR=$ROOT/opt/vertex-web-tailnet
CONF_DIR=$WEB_DIR/caddy
STAGE_DIR=$WEB_DIR/staging
TS=$(date -u +%Y%m%dT%H%M%SZ)
if [ "$MODE" = full ]; then
  for f in "$ROOT/opt/vertex-status/Caddyfile.tailnet" "$ROOT/opt/vertex-status/token.env"; do
    [ -s "$f" ] || { echo "missing $f; nothing changed"; exit 3; }
  done
  [ -d "$ROOT/opt/vertex-status/private-v2" ] || { echo "missing private-v2; nothing changed"; exit 3; }
  [ -S "$ROOT$SOCK_DIR/tailscaled.sock" ] || { echo "no tailscaled socket; nothing changed"; exit 3; }
fi
HOSTS_ENV=/etc/vertex/hosts.env
host_value() { sed -n "s/^$1=//p" "$ROOT$HOSTS_ENV" 2>/dev/null | tail -1 || true; }
TS_HOST=$(host_value VERTEX_TAILNET_HOST); TS_IP4=$(host_value VERTEX_TAILNET_IPV4)
[[ "$TS_HOST" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || { echo "VERTEX_TAILNET_HOST missing or malformed in $HOSTS_ENV; nothing changed"; exit 3; }
[[ "$TS_IP4" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "VERTEX_TAILNET_IPV4 missing or malformed in $HOSTS_ENV; nothing changed"; exit 3; }

# The committed Caddyfile goes to the staging directory and must pass `caddy validate` there (same image, same
# host values, no network) before it can replace the installed file.
trap 'rm -rf "$STAGE_DIR"' EXIT
stage_template() {
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"; chmod 755 "$WEB_DIR" "$STAGE_DIR"
  echo "$CADDYFILE_B64" | base64 -d > "$STAGE_DIR/Caddyfile"; chmod 644 "$STAGE_DIR/Caddyfile"
  docker image inspect caddy:2-alpine >/dev/null 2>&1 \
    || { echo "docker or the caddy:2-alpine image is not available; nothing changed"; exit 3; }
  docker run --rm --network none --env-file "$HOSTS_ENV" \
    -v /opt/vertex-web-tailnet/staging:/etc/caddy:ro caddy:2-alpine \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    || { echo "committed Caddyfile does not validate; nothing changed"; exit 3; }
  echo "caddyfile checked: sha256=$(sha256sum "$STAGE_DIR/Caddyfile" | cut -d' ' -f1)"
}
# A rename inside one filesystem: the container sees the old file or the new file, never a part of one.
install_staged() {
  mkdir -p "$CONF_DIR"; chmod 755 "$CONF_DIR"
  mv "$STAGE_DIR/Caddyfile" "$CONF_DIR/Caddyfile"
}

if [ "$MODE" = caddyfile ]; then
  case "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' vertex-web-tailnet 2>/dev/null || true)" in
    "true "*) ;;
    *) echo "vertex-web-tailnet is not running; run the full recreate; nothing changed"; exit 3 ;;
  esac
  MOUNTS=$(docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' vertex-web-tailnet 2>/dev/null || true)
  case " $MOUNTS" in
    *" /opt/vertex-web-tailnet/caddy:/etc/caddy "*) ;;
    *) echo "vertex-web-tailnet does not mount the caddy directory; run the full recreate; nothing changed"; exit 3 ;;
  esac
  # `caddy reload` reads the variables of the container; they must be the values that the check below uses.
  docker exec vertex-web-tailnet sh -c '[ "${VERTEX_TAILNET_HOST:-}" = "$1" ] && [ "${VERTEX_TAILNET_IPV4:-}" = "$2" ]' sh "$TS_HOST" "$TS_IP4" >/dev/null 2>&1 \
    || { echo "vertex-web-tailnet does not have the host values of $HOSTS_ENV; run the full recreate; nothing changed"; exit 3; }
  [ -s "$CONF_DIR/Caddyfile" ] || { echo "missing $CONF_DIR/Caddyfile; run the full recreate; nothing changed"; exit 3; }
  # An equal file is still reloaded: a run that stopped between the install and the reload left the new file
  # with the old config, and a reload of a config that Caddy already runs changes nothing.
  # Caddyfile.prev is the file of the config that Caddy runs. It stays until a reload has passed, also across
  # a run that stopped, so a failed reload always puts back the file that Caddy still runs.
  PREV=$WEB_DIR/Caddyfile.prev
  CHANGED=0
  if ! echo "$CADDYFILE_B64" | base64 -d | cmp -s - "$CONF_DIR/Caddyfile"; then
    CHANGED=1
    stage_template
    [ -e "$PREV" ] || cp -p "$CONF_DIR/Caddyfile" "$PREV"
    install_staged
  fi
  if ! docker exec vertex-web-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
    --address unix//tmp/caddy-admin.sock >/dev/null 2>&1; then
    if [ -e "$PREV" ]; then mv "$PREV" "$CONF_DIR/Caddyfile"; fi
    echo "RELOAD FAILED; the installed file is the one of the config that still runs (a failed reload keeps the old config)"; exit 7
  fi
  rm -f "$PREV"
  if [ "$CHANGED" = 1 ]; then echo "caddyfile installed and reloaded=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else echo "caddyfile unchanged; reload confirmed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; fi
  exit 0
fi

stage_template

# 1) drop-in: keep /run/tailscale across tailscaled restarts
mkdir -p "$DROPIN_DIR"
echo "$DROPIN_B64" | base64 -d > "$DROPIN.tmp"
mv "$DROPIN.tmp" "$DROPIN"; chmod 644 "$DROPIN"
systemctl daemon-reload
[ "$(systemctl show -p RuntimeDirectoryPreserve --value tailscaled)" = "yes" ] || { echo "drop-in written but not active; containers unchanged"; exit 5; }
echo "drop-in ok: RuntimeDirectoryPreserve=yes"

# 2) recreate both proxies with the directory mounts
install_staged
docker rm -f vertex-web-tailnet >/dev/null 2>&1 || true
docker run -d --name vertex-web-tailnet --restart unless-stopped --network host --read-only \
  --tmpfs /tmp --tmpfs /config --tmpfs /data --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --env-file "$HOSTS_ENV" \
  -v /opt/vertex-web-tailnet/caddy:/etc/caddy:ro \
  -v "$SOCK_DIR:$SOCK_DIR:ro" caddy:2-alpine >/dev/null \
  || { echo "CONTAINER RUN FAILED; proxy is down"; exit 6; }
# `docker run -d` passes even when Caddy stops right after its start (it would then restart in a loop).
sleep "${VERTEX_TAILNET_SETTLE_SECONDS:-3}"
[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' vertex-web-tailnet 2>/dev/null || true)" = "true 0" ] \
  || { echo "vertex-web-tailnet DID NOT STAY UP; proxy is down"; exit 6; }
# The new container runs the installed file, so a Caddyfile.prev of a stopped --caddyfile-only run is stale.
rm -f "$WEB_DIR/Caddyfile.prev"
# The file of the old single-file mount (it had the host values as literal text) becomes a backup.
if [ -e "$WEB_DIR/Caddyfile" ]; then mv "$WEB_DIR/Caddyfile" "$WEB_DIR/Caddyfile.bak-$TS-literal"; fi
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
}
main
REMOTE
}

if [ "$DRY" = 1 ]; then remote_program; exit 0; fi
read -r -a SSH_CMD <<<"${VERTEX_TAILNET_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 quantvps sudo -n bash -s}"
remote_program | "${SSH_CMD[@]}"
