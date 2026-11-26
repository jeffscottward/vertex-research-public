#!/usr/bin/env bash
# Installs the OpenBB and Smart Money source-overdue check on QuantVPS (research data alerting
# only; no broker, order, or deployment calls). See docs/vertex-rebuild/designs/smart-money/plan-pr6.md.
#
# Run on the rig from a clean checkout of the commit to deploy (dependencies installed):
#   infra/openbb-overdue/quantvps/install.sh                 build, copy, and install on QuantVPS
#   infra/openbb-overdue/quantvps/install.sh --build-only DIR build staged files into DIR only (no ssh)
#
# QuantVPS has no bun and no source checkout. This script bundles scripts/vertex-openbb-overdue-tick.ts
# with `bun build --target=node --format=esm`, installs it with SOURCE_SHA in /opt/vertex-openbb-overdue
# (keeping *.prev for rollback), installs the systemd units and conditional drop-ins, and enables the timer.
#
# Optional files on QuantVPS (never written by this script; validated mode 0600, regular non-symlink):
#   /etc/vertex-openbb-overdue/agent-key.env  (VERTEX_AGENT_API_KEY=...)
#   /etc/vertex-openbb-overdue/alert.env      (VERTEX_ALERT_POST_URL=..., VERTEX_ALERT_CHANNEL=...)
# When either file is absent, its systemd drop-in is removed symmetrically.
#
# Environment:
#   VERTEX_OPENBB_OVERDUE_SSH          remote command prefix (default: ssh to `quantvps`)
#   VERTEX_OPENBB_OVERDUE_ALLOW_DIRTY  1 = allow uncommitted changes (SOURCE_SHA gets "-dirty")
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
bundle=vertex-openbb-overdue-tick.mjs

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '6,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,3\}//' >&2
  exit 2
}

stage() {
  local out sha
  sha="$(git -C "$root" rev-parse HEAD)"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    [ "${VERTEX_OPENBB_OVERDUE_ALLOW_DIRTY:-}" = 1 ] || fail "uncommitted changes in $root; commit first"
    sha="$sha-dirty"
  fi
  mkdir -p "$1/vertex-openbb-overdue.service.d"
  out="$(cd "$1" && pwd)"
  (cd "$root" && bun build scripts/vertex-openbb-overdue-tick.ts --target=node --format=esm \
    --outfile "$out/$bundle" >/dev/null) || fail "bun build failed"
  printf '%s\n' "$sha" >"$out/SOURCE_SHA"
  cp "$here/vertex-openbb-overdue.service" "$here/vertex-openbb-overdue.timer" "$out/"
  cp "$here/vertex-openbb-overdue.service.d/agent-key.conf" \
    "$here/vertex-openbb-overdue.service.d/alert-route.conf" "$out/vertex-openbb-overdue.service.d/"
  remote_step >"$out/remote-install.sh"
}

remote_step() {
  cat <<'REMOTE'
set -euo pipefail
src="$1"
prefix="${VERTEX_INSTALL_ROOT:-}"
read -r -a systemctl_cmd <<<"${VERTEX_SYSTEMCTL:-systemctl}"
fail() { echo "remote install: $*" >&2; exit 1; }
node="$prefix/opt/vertex-autopilot/bin/node"
app="$prefix/opt/vertex-openbb-overdue"
units="$prefix/etc/systemd/system"
bundle=vertex-openbb-overdue-tick.mjs
[ -x "$node" ] || fail "missing $node (install the Autopilot tick first)"
[ -f "$prefix/etc/vertex-autopilot/autopilot.env" ] || fail "missing /etc/vertex-autopilot/autopilot.env"

check_env_file() {
  local path="$1" display="$2"
  shift 2
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%a %u' "$path")" = "600 $(id -u)" ] ||
    fail "$display must be a regular file with mode 0600 owned by $(id -un)"
  for key in "$@"; do
    grep -q "^${key}=[^[:space:]]" "$path" || fail "$display has no ${key} value"
  done
}

key_env="$prefix/etc/vertex-openbb-overdue/agent-key.env"
if [ -e "$key_env" ] || [ -L "$key_env" ]; then
  check_env_file "$key_env" "/etc/vertex-openbb-overdue/agent-key.env" VERTEX_AGENT_API_KEY
fi

alert_env="$prefix/etc/vertex-openbb-overdue/alert.env"
if [ -e "$alert_env" ] || [ -L "$alert_env" ]; then
  check_env_file "$alert_env" "/etc/vertex-openbb-overdue/alert.env" VERTEX_ALERT_POST_URL VERTEX_ALERT_CHANNEL
fi

"$node" --check "$src/$bundle" || fail "the bundle does not parse with $node"
install -d -m 0755 "$app"
if [ -f "$app/$bundle" ] && ! cmp -s "$src/$bundle" "$app/$bundle"; then
  for file in "$bundle" SOURCE_SHA; do
    if [ -f "$app/$file" ]; then cp -p "$app/$file" "$app/$file.prev"; fi
  done
fi
for file in "$bundle" SOURCE_SHA; do
  install -m 0644 "$src/$file" "$app/$file"
done
install -d -m 0755 "$units"
install -m 0644 "$src/vertex-openbb-overdue.service" "$src/vertex-openbb-overdue.timer" "$units/"

if [ -f "$key_env" ]; then
  install -d -m 0755 "$units/vertex-openbb-overdue.service.d"
  install -m 0644 "$src/vertex-openbb-overdue.service.d/agent-key.conf" "$units/vertex-openbb-overdue.service.d/"
else
  rm -f "$units/vertex-openbb-overdue.service.d/agent-key.conf"
  echo "note: no /etc/vertex-openbb-overdue/agent-key.env; the service uses the Autopilot key"
fi

if [ -f "$alert_env" ]; then
  install -d -m 0755 "$units/vertex-openbb-overdue.service.d"
  install -m 0644 "$src/vertex-openbb-overdue.service.d/alert-route.conf" "$units/vertex-openbb-overdue.service.d/"
else
  rm -f "$units/vertex-openbb-overdue.service.d/alert-route.conf"
  echo "note: no /etc/vertex-openbb-overdue/alert.env; chat fallback route not installed"
fi

"${systemctl_cmd[@]}" daemon-reload
"${systemctl_cmd[@]}" enable --now vertex-openbb-overdue.timer
"${systemctl_cmd[@]}" is-active --quiet vertex-openbb-overdue.timer || fail "timer is not active"
echo "installed $(cat "$app/SOURCE_SHA") ($(sha256sum "$app/$bundle" | cut -d' ' -f1))"
REMOTE
}

case "${1:-}" in
  --build-only)
    [ $# -eq 2 ] || usage
    stage "$2"
    echo "built $(cat "$2/SOURCE_SHA") in $2"
    ;;
  "")
    read -r -a ssh_cmd <<<"${VERTEX_OPENBB_OVERDUE_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 quantvps}"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    stage "$work"
    tar -C "$work" -czf - . | "${ssh_cmd[@]}" \
      'set -e; t="$(mktemp -d)"; trap "rm -rf \"$t\"" EXIT; tar -xzf - -C "$t"; bash "$t/remote-install.sh" "$t"'
    ;;
  *) usage ;;
esac
