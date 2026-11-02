#!/usr/bin/env bash
# Run the CI browser lane (verify:browser) in a private network namespace.
#
# Chromium fails every in-flight request with net::ERR_NETWORK_CHANGED when a host
# network interface changes. On the shared rig this happens when Wi-Fi drops or
# another job creates or removes a Docker network, and random browser tests then
# failed. On 2026-10-31 all five browser failures of one CI run fell inside one
# 70-second burst of host link changes. Inside the namespace only loopback exists,
# so host changes cannot reach Chromium.
#
# 127.0.0.1 in the namespace is not the host loopback, so the lane starts its own
# PostgreSQL inside the namespace. The binaries install first, outside it, because
# the namespace has no outside network.
#
# BROWSER_SPECS (set by the CI step "Choose browser specs" on pull requests) lists
# the spec files to run, separated by spaces. Empty or unset runs the full suite.
set -euo pipefail

lane() {
  trap 'bash scripts/ci/rig-postgres.sh down' EXIT
  bash scripts/ci/rig-postgres.sh up
  local specs=()
  read -r -a specs <<<"${BROWSER_SPECS:-}"
  bun run verify:browser "${specs[@]}"
}

case "${1:-}" in
  --inside)
    ip link set lo up
    lane
    ;;
  --host)
    lane
    ;;
  "")
    bash scripts/ci/rig-postgres.sh install
    namespace=(unshare --user --map-current-user --net --keep-caps)
    if "${namespace[@]}" true 2>/dev/null; then
      exec "${namespace[@]}" bash "$0" --inside
    fi
    # GitHub-hosted Ubuntu runners restrict unprivileged user namespaces.
    echo "::warning::No private network namespace; the browser lane uses the host network."
    exec bash "$0" --host
    ;;
  *)
    echo "usage: $0" >&2
    exit 2
    ;;
esac
