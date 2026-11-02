#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd_repo_root() {
  cd "${REPO_ROOT}"
}

section() {
  printf '\n==> %s\n' "$*"
}

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

lower() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

truthy() {
  case "$(lower "${1:-}")" in
    1 | true | yes | y | on) return 0 ;;
    *) return 1 ;;
  esac
}

absolute_path() {
  case "${1:-}" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "${REPO_ROOT}" "${1#./}" ;;
  esac
}

load_env() {
  cd_repo_root

  if [[ -f ".env.example" ]]; then
    set -a
    # shellcheck source=/dev/null
    source ".env.example"
    set +a
  else
    warn ".env.example not found; using built-in prototype defaults"
  fi

  if [[ -f ".env" ]]; then
    ENV_SOURCE=".env"
    set -a
    # shellcheck source=/dev/null
    source ".env"
    set +a
  else
    ENV_SOURCE=".env.example"
  fi

  export ENV_SOURCE
  : "${TRADING_MODE:=paper}"
  : "${ENABLE_LIVE_TRADING:=false}"
  : "${I_UNDERSTAND_LIVE_TRADING_RISK:=false}"
  : "${LIVE_TRADING_ACCOUNT_ALLOWLIST:=}"
  : "${IBKR_TRADING_MODE:=paper}"
  : "${IBKR_GATEWAY_ENABLED:=false}"
  : "${IB_GATEWAY_REQUIRED:=false}"
  : "${WATCHDOG_REQUIRE_IB_GATEWAY:=false}"
  : "${IB_GATEWAY_HOST:=${IBKR_HOST:-ib-gateway}}"
  : "${IB_GATEWAY_PORT:=${IBKR_PORT:-4004}}"
  : "${IBKR_HOST:=${IB_GATEWAY_HOST}}"
  : "${IBKR_PORT:=${IB_GATEWAY_PORT}}"
  if truthy "${IBKR_GATEWAY_ENABLED}" || truthy "${IB_GATEWAY_REQUIRED}" || truthy "${WATCHDOG_REQUIRE_IB_GATEWAY}"; then
    IB_GATEWAY_REQUIRED=true
    WATCHDOG_REQUIRE_IB_GATEWAY=true
  fi
  : "${POSTGRES_DB:=vertex_quant}"
  : "${POSTGRES_USER:=vertex_quant}"
  : "${BACKUP_DIR:=./backups}"
  : "${KILL_SWITCH_PATH:=./data/KILL_SWITCH}"
}

validate_safe_prototype() {
  local trading_mode
  trading_mode="$(lower "${TRADING_MODE}")"

  case "${trading_mode}" in
    paper)
      truthy "${ENABLE_LIVE_TRADING}" && die "ENABLE_LIVE_TRADING=${ENABLE_LIVE_TRADING} requires TRADING_MODE=live"
      [[ "$(lower "${IBKR_TRADING_MODE}")" != "live" ]] || die "IBKR_TRADING_MODE=live requires TRADING_MODE=live"
      ;;
    live)
      require_live_trading_gates
      ;;
    *)
      die "TRADING_MODE=${TRADING_MODE} is refused; expected paper or live"
      ;;
  esac
}

allowlist_contains_account() {
  local account
  local entry
  local -a entries
  local normalized_entry
  account="$(lower "$(printf '%s' "${1:-}" | tr -d '[:space:]')")"

  IFS=',' read -r -a entries <<< "${2:-}"
  for entry in "${entries[@]}"; do
    normalized_entry="$(lower "$(printf '%s' "${entry}" | tr -d '[:space:]')")"
    if [[ -n "${normalized_entry}" && "${normalized_entry}" == "${account}" ]]; then
      return 0
    fi
  done
  return 1
}

require_live_trading_gates() {
  truthy "${ENABLE_LIVE_TRADING}" || die "TRADING_MODE=live requires ENABLE_LIVE_TRADING=true"
  truthy "${I_UNDERSTAND_LIVE_TRADING_RISK}" || die "TRADING_MODE=live requires I_UNDERSTAND_LIVE_TRADING_RISK=true"
  [[ -n "${IBKR_ACCOUNT_ID:-}" ]] || die "TRADING_MODE=live requires IBKR_ACCOUNT_ID"
  [[ -n "${LIVE_TRADING_ACCOUNT_ALLOWLIST:-}" ]] || die "TRADING_MODE=live requires LIVE_TRADING_ACCOUNT_ALLOWLIST"
  allowlist_contains_account "${IBKR_ACCOUNT_ID}" "${LIVE_TRADING_ACCOUNT_ALLOWLIST}" \
    || die "IBKR_ACCOUNT_ID must match LIVE_TRADING_ACCOUNT_ALLOWLIST before TRADING_MODE=live startup"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"
}

nested_compose_guard_required() {
  if truthy "${VERTEX_QUANT_ASSUME_NESTED_COMPOSE:-false}"; then
    return 0
  fi

  [[ -f "/.dockerenv" ]] || {
    if [[ -r "/proc/1/cgroup" ]]; then
      local cgroup_line
      while IFS= read -r cgroup_line; do
        case "${cgroup_line}" in
          *docker* | *kubepods* | *containerd* | *libpod*)
            case "${REPO_ROOT}" in
              /app | /app/*) return 0 ;;
              *) return 1 ;;
            esac
            ;;
        esac
      done <"/proc/1/cgroup"
    fi
    return 1
  }

  case "${REPO_ROOT}" in
    /app | /app/*) return 0 ;;
    *) return 1 ;;
  esac
}

require_absolute_host_root_for_nested_compose() {
  nested_compose_guard_required || return 0

  case "${VERTEX_QUANT_HOST_ROOT:-}" in
    /*) return 0 ;;
    *)
      die "VERTEX_QUANT_HOST_ROOT must be an absolute host path when running Docker Compose from inside the app container; set it to the host repo root before retrying"
      ;;
  esac
}

compose() {
  require_absolute_host_root_for_nested_compose
  docker compose "$@"
}

kill_switch_file() {
  absolute_path "${KILL_SWITCH_PATH}"
}

redact_stream() {
  sed -E \
    -e 's#(postgres(ql)?://)[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's#(redis://)[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's#(/api/push/)[^/?[:space:]]+#\1[REDACTED]#g' \
    -e 's#((password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?key|username|account[_-]?id)[=:])[^[:space:]&]+#\1[REDACTED]#g' \
    -e 's#((PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|AUTH[_-]?KEY|USERNAME|ACCOUNT[_-]?ID)[=:])[^[:space:]&]+#\1[REDACTED]#g'
}
