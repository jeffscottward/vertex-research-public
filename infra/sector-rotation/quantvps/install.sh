#!/usr/bin/env bash
# Installs the sector rotation collection on QuantVPS (research only: public daily bars, stored
# points, alert lines; no broker, order or deployment calls). See docs/vertex-rebuild/sector-rotation.md.
#
# Run it on the rig from a clean checkout of the commit to deploy (dependencies installed):
#   infra/sector-rotation/quantvps/install.sh                 build, copy and install on QuantVPS
#   infra/sector-rotation/quantvps/install.sh --build-only DIR build the files into DIR only (no ssh)
#
# QuantVPS has no bun and no source checkout. The script bundles scripts/vertex-sector-rotation-tick.ts
# with `bun build --target=node` into one file, then installs it with SOURCE_SHA in
# /opt/vertex-sector-rotation, where the Autopilot Node (/opt/vertex-autopilot/bin/node) runs it. It
# installs the units in this folder to /etc/systemd/system and enables the timer. The previous bundle
# stays as *.prev for rollback.
#
# It never writes secrets. It requires the existing 0600 environment file
# /etc/vertex-autopilot/autopilot.env (VERTEX_ORIGIN, VERTEX_AGENT_API_KEY). It installs the chat route
# drop-in only when /etc/vertex-sector-rotation/alert.env exists (VERTEX_ALERT_POST_URL,
# VERTEX_ALERT_CHANNEL).
#
# Environment:
#   VERTEX_SECTOR_ROTATION_SSH          remote command prefix (default: ssh to the `quantvps` alias)
#   VERTEX_SECTOR_ROTATION_ALLOW_DIRTY  1 = allow uncommitted changes (SOURCE_SHA gets "-dirty")
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
bundle=vertex-sector-rotation-tick.mjs

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '6,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,3\}//' >&2
  exit 2
}

# Writes the bundle, SOURCE_SHA, the units and the remote install step into $1.
stage() {
  local out sha
  sha="$(git -C "$root" rev-parse HEAD)"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    [ "${VERTEX_SECTOR_ROTATION_ALLOW_DIRTY:-}" = 1 ] || fail "uncommitted changes in $root; commit first"
    sha="$sha-dirty"
  fi
  mkdir -p "$1/vertex-sector-rotation.service.d"
  # Absolute, because the build below runs from the repository root.
  out="$(cd "$1" && pwd)"
  # Build from the repository root, so the bundle's module comments are repository-relative.
  (cd "$root" && bun build scripts/vertex-sector-rotation-tick.ts --target=node --format=esm \
    --outfile "$out/$bundle" >/dev/null) || fail "bun build failed"
  printf '%s\n' "$sha" >"$out/SOURCE_SHA"
  cp "$here/vertex-sector-rotation.service" "$here/vertex-sector-rotation.timer" "$out/"
  cp "$here/vertex-sector-rotation.service.d/alert-route.conf" "$out/vertex-sector-rotation.service.d/"
  remote_step >"$out/remote-install.sh"
}

# The step that runs on QuantVPS (as root) with the staged folder as $1.
# VERTEX_INSTALL_ROOT and VERTEX_SYSTEMCTL exist for the test, which runs this step in a temp folder.
remote_step() {
  cat <<'REMOTE'
set -euo pipefail
src="$1"
prefix="${VERTEX_INSTALL_ROOT:-}"
read -r -a systemctl_cmd <<<"${VERTEX_SYSTEMCTL:-systemctl}"
fail() { echo "remote install: $*" >&2; exit 1; }
node="$prefix/opt/vertex-autopilot/bin/node"
app="$prefix/opt/vertex-sector-rotation"
units="$prefix/etc/systemd/system"
bundle=vertex-sector-rotation-tick.mjs
[ -x "$node" ] || fail "missing $node (install the Autopilot tick first)"
[ -f "$prefix/etc/vertex-autopilot/autopilot.env" ] || fail "missing /etc/vertex-autopilot/autopilot.env"
"$node" --check "$src/$bundle" || fail "the bundle does not parse with $node"
install -d -m 0755 "$app"
# Keep the replaced pair as *.prev for rollback, only when the bundle changes, so a repeated
# install of the same build never overwrites the earlier version.
if [ -f "$app/$bundle" ] && ! cmp -s "$src/$bundle" "$app/$bundle"; then
  for file in "$bundle" SOURCE_SHA; do
    if [ -f "$app/$file" ]; then cp -p "$app/$file" "$app/$file.prev"; fi
  done
fi
for file in "$bundle" SOURCE_SHA; do
  install -m 0644 "$src/$file" "$app/$file"
done
install -d -m 0755 "$units"
install -m 0644 "$src/vertex-sector-rotation.service" "$src/vertex-sector-rotation.timer" "$units/"
if [ -f "$prefix/etc/vertex-sector-rotation/alert.env" ]; then
  install -d -m 0755 "$units/vertex-sector-rotation.service.d"
  install -m 0600 "$src/vertex-sector-rotation.service.d/alert-route.conf" "$units/vertex-sector-rotation.service.d/"
else
  echo "note: no /etc/vertex-sector-rotation/alert.env; chat alert route not installed"
fi
"${systemctl_cmd[@]}" daemon-reload
"${systemctl_cmd[@]}" enable --now vertex-sector-rotation.timer
"${systemctl_cmd[@]}" is-active --quiet vertex-sector-rotation.timer || fail "timer is not active"
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
    read -r -a ssh_cmd <<<"${VERTEX_SECTOR_ROTATION_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 quantvps}"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    stage "$work"
    # One connection: the staged folder goes over stdin, the remote step unpacks and runs it.
    tar -C "$work" -czf - . | "${ssh_cmd[@]}" \
      'set -e; t="$(mktemp -d)"; trap "rm -rf \"$t\"" EXIT; tar -xzf - -C "$t"; bash "$t/remote-install.sh" "$t"'
    ;;
  *) usage ;;
esac
