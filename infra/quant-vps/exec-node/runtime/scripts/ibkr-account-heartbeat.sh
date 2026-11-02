#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ONCE=false

usage() {
  cat <<'USAGE'
Usage: scripts/ibkr-account-heartbeat.sh [--once]

Runs a passive IBKR account-summary access check during the configured market-hours window.
USAGE
}

apply_local_defaults() {
  : "${TRADING_MODE:=paper}"
  : "${ENABLE_LIVE_TRADING:=false}"
  : "${I_UNDERSTAND_LIVE_TRADING_RISK:=false}"
  : "${LIVE_TRADING_ACCOUNT_ALLOWLIST:=}"
  : "${IBKR_TRADING_MODE:=paper}"
  : "${IBKR_HEARTBEAT_ENABLED:=1}"
  : "${IBKR_HEARTBEAT_INTERVAL_SECONDS:=30}"
  : "${IBKR_HEARTBEAT_TIMEZONE:=America/New_York}"
  : "${IBKR_HEARTBEAT_START_TIME:=09:15}"
  : "${IBKR_HEARTBEAT_END_TIME:=16:15}"
  : "${IBKR_HEARTBEAT_COMMAND:=scripts/request-ibkr-2fa-until-ready.sh --check-only}"
}

validate_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || die "${name} must be a positive integer"
}

time_to_minutes() {
  local value="$1"
  [[ "${value}" =~ ^([0-9]{2}):([0-9]{2})$ ]] || die "invalid HH:MM time: ${value}"
  local hour="${BASH_REMATCH[1]}"
  local minute="${BASH_REMATCH[2]}"
  ((10#${hour} < 24 && 10#${minute} < 60)) || die "invalid HH:MM time: ${value}"
  printf '%s\n' $((10#${hour} * 60 + 10#${minute}))
}

current_minutes() {
  if [[ -n "${IBKR_HEARTBEAT_NOW:-}" ]]; then
    time_to_minutes "${IBKR_HEARTBEAT_NOW}"
    return 0
  fi

  TZ="${IBKR_HEARTBEAT_TIMEZONE}" date '+%H:%M' | {
    read -r now
    time_to_minutes "${now}"
  }
}

within_window() {
  local now="$1"
  local start="$2"
  local end="$3"

  if ((start <= end)); then
    ((now >= start && now <= end))
  else
    ((now >= start || now <= end))
  fi
}

run_cycle() {
  section "IBKR account heartbeat passive access check"
  if bash -lc "${IBKR_HEARTBEAT_COMMAND}"; then
    info "IBKR account heartbeat passive access check passed"
    return 0
  fi

  warn "IBKR account heartbeat check failed; manual IBKR 2FA recovery may be needed"
  return 0
}

run_once() {
  if ! truthy "${IBKR_HEARTBEAT_ENABLED}"; then
    info "IBKR account heartbeat disabled"
    return 0
  fi

  local now
  local start
  local end
  now="$(current_minutes)"
  start="$(time_to_minutes "${IBKR_HEARTBEAT_START_TIME}")"
  end="$(time_to_minutes "${IBKR_HEARTBEAT_END_TIME}")"

  if ! within_window "${now}" "${start}" "${end}"; then
    info "IBKR account heartbeat outside heartbeat window"
    return 0
  fi

  run_cycle
}

parse_args() {
  while (($#)); do
    case "$1" in
      --once)
        ONCE=true
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  cd_repo_root
  if ! truthy "${IBKR_HEARTBEAT_SKIP_LOAD_ENV:-false}"; then
    load_env
  fi
  apply_local_defaults
  validate_safe_prototype
  validate_positive_integer IBKR_HEARTBEAT_INTERVAL_SECONDS "${IBKR_HEARTBEAT_INTERVAL_SECONDS}"

  if [[ "${ONCE}" == true ]]; then
    run_once
    return 0
  fi

  while true; do
    run_once
    sleep "${IBKR_HEARTBEAT_INTERVAL_SECONDS}"
  done
}

main "$@"
