#!/usr/bin/env bash
# Owner CLI for the Nautilus arm gate on QuantVPS. Run it on the rig.
#
#   scripts/nautilus-arm.sh status
#   scripts/nautilus-arm.sh disarm [--reason TEXT]
#   scripts/nautilus-arm.sh arm --reason TEXT
#
# status and disarm run directly. arm never runs directly: it sends the exact
# command to omp-approve, and the command runs only after the owner presses
# Approve. Without omp-approve the script refuses to arm.
set -Eeuo pipefail

HOST="${NAUTILUS_ARM_SSH_HOST:-quantvps}"
ACTOR="${NAUTILUS_ARM_ACTOR:-owner-cli}"
OMP_APPROVE="${NAUTILUS_ARM_OMP_APPROVE:-omp-approve}"
FIND_CONTAINER='docker ps -q --filter label=com.docker.compose.project=ibkr-nautilus-exec-node --filter label=com.docker.compose.service=nautilus-trader --filter label=com.docker.compose.oneoff=False'
# Host fallback for disarm when the container is stopped or restarting.
HOST_ARMED='/opt/vertex-exec-node/data/nautilus/ARMED'
HOST_AUDIT='/opt/vertex-exec-node/data/nautilus/arm-audit.jsonl'

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
}

remote_cli() {
  local args=""
  local arg
  for arg in "$@"; do
    args+=" $(printf '%q' "${arg}")"
  done
  printf 'docker exec "$(%s)" python -m nautilus.arm_cli%s' "${FIND_CONTAINER}" "${args}"
}

command="${1:-}"
[[ -n "${command}" ]] || {
  usage
  exit 2
}
shift

reason=""
while (($#)); do
  case "$1" in
    --reason)
      [[ $# -ge 2 ]] || {
        usage
        exit 2
      }
      reason="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

case "${command}" in
  status)
    ssh "${HOST}" "$(remote_cli status --json)"
    ;;
  disarm)
    if ! ssh "${HOST}" "$(remote_cli disarm --by "${ACTOR}" --reason "${reason}" --json)"; then
      printf 'Container disarm failed; removing the arm record on the host instead.\n' >&2
      ssh "${HOST}" "rm -f ${HOST_ARMED} && printf '%s\\n' '{\"schema\":\"nautilus-arm-audit-v1\",\"event\":\"disarmed\",\"actor\":\"${ACTOR}\",\"via\":\"host-fallback\"}' >> ${HOST_AUDIT} && { chown 10001:10001 ${HOST_AUDIT} 2>/dev/null || true; } && test ! -e ${HOST_ARMED}"
      printf '{"state":"disarmed","detail":"host_fallback"}\n'
    fi
    ;;
  arm)
    [[ -n "${reason}" ]] || {
      printf 'arm needs --reason TEXT (10..280 characters)\n' >&2
      exit 2
    }
    status_json="$(ssh "${HOST}" "$(remote_cli status --json)")"
    version="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["image_version"])' <<<"${status_json}")"
    remote="$(remote_cli arm --by "${ACTOR}" --reason "${reason}" --confirm-image-version "${version}" --json)"
    exact="ssh ${HOST} $(printf '%q' "${remote}")"
    if ! command -v "${OMP_APPROVE}" >/dev/null 2>&1; then
      printf 'Refused: omp-approve is not available here. Arming needs the owner Approve button.\n' >&2
      printf 'Exact command for omp-approve:\n%s\n' "${exact}" >&2
      exit 2
    fi
    "${OMP_APPROVE}" --reason "Arm the Nautilus node (it may submit live orders). Version ${version}. Reason: ${reason}" --wait -- "${exact}"
    ;;
  *)
    usage
    exit 2
    ;;
esac
