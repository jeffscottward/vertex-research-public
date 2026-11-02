#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CHECK_ONLY=false

usage() {
  cat <<'USAGE'
Usage: scripts/request-ibkr-2fa-until-ready.sh [--check-only]

Checks whether IBKR account-summary access is ready. Without --check-only, sends one
cooldown-gated Gateway login request by default, then polls readiness passively.

IBKR readiness is the account-summary snapshot only. Nautilus health is printed
as a separate signal and never decides readiness.
USAGE
}

apply_local_defaults() {
  : "${TRADING_MODE:=paper}"
  : "${ENABLE_LIVE_TRADING:=false}"
  : "${I_UNDERSTAND_LIVE_TRADING_RISK:=false}"
  : "${LIVE_TRADING_ACCOUNT_ALLOWLIST:=}"
  : "${IBKR_TRADING_MODE:=paper}"
  : "${IBKR_2FA_NOTIFY_EMAIL:=owner@example.com}"
  : "${IBKR_2FA_RETRY_INTERVAL_SECONDS:=15}"
  : "${IBKR_2FA_MAX_ATTEMPTS:=1}"
  : "${IBKR_2FA_APPROVAL_TIMEOUT_SECONDS:=900}"
  : "${IBKR_2FA_GATEWAY_PROFILE:=ibkr}"
  : "${IBKR_2FA_GATEWAY_SERVICE:=ib-gateway}"
  : "${IBKR_2FA_NOTIFY_ENABLED:=1}"
  : "${IBKR_2FA_RESTART_STATE_DIR:=./data/watchdog}"
  : "${IBKR_2FA_RESTART_TIMESTAMP_FILE:=${IBKR_2FA_RESTART_STATE_DIR}/ib-gateway-restart.timestamp}"
  : "${IBKR_2FA_RESTART_COOLDOWN_SECONDS:=${WATCHDOG_RESTART_COOLDOWN_SECONDS:-300}}"
  : "${IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT:=1}"
  : "${IBKR_2FA_VERIFY_SERVICE:=nautilus-trader}"
  : "${IBKR_2FA_NAUTILUS_HEALTH_FILE:=data/nautilus/health.json}"
  : "${IBKR_2FA_VERIFY_HOST:=${IB_GATEWAY_HOST:-${IBKR_HOST:-ib-gateway}}}"
  : "${IBKR_2FA_VERIFY_PORT:=${IB_GATEWAY_PORT:-${IBKR_PORT:-4004}}}"
  : "${IBKR_2FA_VERIFY_CLIENT_ID:=98}"
  : "${IBKR_2FA_VERIFY_TIMEOUT_SECONDS:=20}"
  # Optional updatePortfolio market values; the readiness result does not need them.
  : "${IBKR_2FA_MARKET_VALUES_TIMEOUT_SECONDS:=5}"
  # Dedicated to the snapshot check: it stages a nautilus/ package that must not
  # shadow /app/nautilus for the other tools under data/nautilus/transmit-tmp.
  : "${IBKR_2FA_SNAPSHOT_STAGE_DIR:=data/nautilus/ibkr-snapshot-stage}"
  : "${IBKR_2FA_SNAPSHOT_OUTPUT_DIR:=/app/data/nautilus/reports}"
}

force_gateway_required_env() {
  export IBKR_GATEWAY_ENABLED=true
  export IB_GATEWAY_REQUIRED=true
  export WATCHDOG_REQUIRE_IB_GATEWAY=true
}

validate_non_negative_integer() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} must be a non-negative integer"
}

validate_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || die "${name} must be a positive integer"
}

request_subject() {
  printf 'IBKR 2FA login requested on %s\n' "$(hostname)"
}

request_body() {
  cat <<EOF
IBKR Gateway login is being requested by Vertex Quant.

Host: $(hostname)
Profile: ${IBKR_2FA_GATEWAY_PROFILE}
Service: ${IBKR_2FA_GATEWAY_SERVICE}
Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

If this was expected, approve the IBKR 2FA prompt on your phone.
If this was not expected, treat it as suspicious and do not approve it.
EOF
}

send_login_email() {
  local subject
  subject="$(request_subject)"

  if ! truthy "${IBKR_2FA_NOTIFY_ENABLED}"; then
    warn "IBKR 2FA email notification disabled"
    return 0
  fi

  if truthy "${IBKR_2FA_TEST_MODE:-false}" && [[ -n "${IBKR_2FA_NOTIFY_COMMAND:-}" ]]; then
    if ! request_body | bash -lc "${IBKR_2FA_NOTIFY_COMMAND}"; then
      warn "IBKR 2FA email notification failed; continuing with Gateway login request"
    fi
    return 0
  fi

  if ! command -v mutt >/dev/null 2>&1; then
    warn "mutt is required but was not found on PATH; continuing with Gateway login request"
    return 0
  fi

  if ! request_body | mutt -s "${subject}" "${IBKR_2FA_NOTIFY_EMAIL}"; then
    warn "IBKR 2FA email notification failed; continuing with Gateway login request"
  fi
}

trigger_gateway_login() {
  if truthy "${IBKR_2FA_TEST_MODE:-false}" && [[ -n "${IBKR_2FA_TRIGGER_COMMAND:-}" ]]; then
    bash -lc "${IBKR_2FA_TRIGGER_COMMAND}"
    return 0
  fi

  require_command docker
  compose --profile "${IBKR_2FA_GATEWAY_PROFILE}" up -d "${IBKR_2FA_GATEWAY_SERVICE}" 2>&1 | redact_stream
  compose --profile "${IBKR_2FA_GATEWAY_PROFILE}" restart "${IBKR_2FA_GATEWAY_SERVICE}" 2>&1 | redact_stream
}

restart_cooldown_remaining() {
  local cooldown_seconds="${IBKR_2FA_RESTART_COOLDOWN_SECONDS}"
  local elapsed
  local last_restart_at
  local now

  [[ "${cooldown_seconds}" =~ ^[0-9]+$ ]] || die "IBKR_2FA_RESTART_COOLDOWN_SECONDS must be a non-negative integer"
  [[ -f "${IBKR_2FA_RESTART_TIMESTAMP_FILE}" ]] || {
    printf '0\n'
    return 0
  }

  last_restart_at="$(<"${IBKR_2FA_RESTART_TIMESTAMP_FILE}")"
  [[ "${last_restart_at}" =~ ^[0-9]+$ ]] || {
    printf '0\n'
    return 0
  }

  now="$(date +%s)"
  elapsed=$((now - last_restart_at))
  if ((elapsed >= 0 && elapsed < cooldown_seconds)); then
    printf '%s\n' $((cooldown_seconds - elapsed))
    return 0
  fi

  printf '0\n'
}

gateway_login_request_due() {
  local remaining
  remaining="$(restart_cooldown_remaining)"
  if ((remaining > 0)); then
    warn "IBKR Gateway restart cooldown active; ${remaining}s until the next email/restart attempt"
    return 1
  fi

  return 0
}

record_gateway_login_request() {
  local timestamp_dir
  timestamp_dir="$(dirname "${IBKR_2FA_RESTART_TIMESTAMP_FILE}")"
  if [[ "${timestamp_dir}" != "." ]]; then
    mkdir -p "${timestamp_dir}"
  fi
  date +%s >"${IBKR_2FA_RESTART_TIMESTAMP_FILE}"
}

report_nautilus_health() {
  # Separate, non-blocking signal. It never changes the readiness result.
  local rc=0
  if truthy "${IBKR_2FA_TEST_MODE:-false}" && [[ -n "${IBKR_2FA_HEALTHCHECK_COMMAND:-}" ]]; then
    bash -lc "${IBKR_2FA_HEALTHCHECK_COMMAND}" || rc=$?
  elif [[ -f "${IBKR_2FA_NAUTILUS_HEALTH_FILE}" ]] && command -v python3 >/dev/null 2>&1; then
    python3 - "${IBKR_2FA_NAUTILUS_HEALTH_FILE}" <<'NAUTILUS_HEALTH' || rc=$?
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        payload = json.load(handle)
except (OSError, ValueError) as exc:
    print(f"Nautilus health unreadable: {type(exc).__name__}")
    raise SystemExit(1)
arm = payload.get("arm") if isinstance(payload.get("arm"), dict) else {}
print(
    "Nautilus health: status={status} arm={arm} arm_detail={detail} last_heartbeat_at={beat}".format(
        status=payload.get("status", "unknown"),
        arm=arm.get("state", "unknown"),
        detail=arm.get("detail", "unknown"),
        beat=payload.get("last_heartbeat_at") or "unknown",
    )
)
raise SystemExit(0 if payload.get("status") == "ok" else 1)
NAUTILUS_HEALTH
  else
    rc=1
    info "Nautilus health file not found: ${IBKR_2FA_NAUTILUS_HEALTH_FILE}"
  fi
  if ((rc != 0)); then
    warn "Nautilus health is not OK (non-blocking; IBKR readiness uses the account-summary snapshot only)"
  fi
  return 0
}

account_snapshot_ready() {
  if ! truthy "${IBKR_2FA_VERIFY_ACCOUNT_SNAPSHOT}"; then
    warn "IBKR account-summary verification is disabled; readiness is unknown and counts as not ready"
    return 1
  fi

  if truthy "${IBKR_2FA_TEST_MODE:-false}"; then
    if [[ -n "${IBKR_2FA_ACCOUNT_SNAPSHOT_COMMAND:-}" ]]; then
      bash -lc "${IBKR_2FA_ACCOUNT_SNAPSHOT_COMMAND}"
      return $?
    fi
    die "IBKR_2FA_TEST_MODE requires IBKR_2FA_ACCOUNT_SNAPSHOT_COMMAND"
  fi

  require_command docker
  mkdir -p "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/scripts" "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/nautilus"
  cp scripts/ibkr_account_snapshot.py "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/scripts/"
  # The Nautilus image bakes /app/nautilus at build time; only /app/data is mounted.
  # Stage the snapshot module next to the script (the script puts the stage dir
  # first on sys.path) so the check uses this checkout's reader, not the image copy.
  # Nothing else imports from this stage dir.
  cp nautilus/__init__.py nautilus/ibkr_account.py "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/nautilus/"
  if [[ -f ".env" ]]; then
    cp .env "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/.env"
  else
    cp .env.example "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/.env"
  fi
  chmod 600 "${IBKR_2FA_SNAPSHOT_STAGE_DIR}/.env"

  # A one-off container from the Nautilus image runs the read-only snapshot.
  # It does not start, stop or depend on the running Nautilus node.
  compose --profile "${IBKR_2FA_GATEWAY_PROFILE}" run --rm --no-deps -T \
    -e PYTHONPATH=/app \
    --entrypoint python \
    "${IBKR_2FA_VERIFY_SERVICE}" \
    "/app/${IBKR_2FA_SNAPSHOT_STAGE_DIR}/scripts/ibkr_account_snapshot.py" \
      --env-file "/app/${IBKR_2FA_SNAPSHOT_STAGE_DIR}/.env" \
      --client-id "${IBKR_2FA_VERIFY_CLIENT_ID}" \
      --timeout-seconds "${IBKR_2FA_VERIFY_TIMEOUT_SECONDS}" \
      --market-values-timeout-seconds "${IBKR_2FA_MARKET_VALUES_TIMEOUT_SECONDS}" \
      --output-dir "${IBKR_2FA_SNAPSHOT_OUTPUT_DIR}" 2>&1 | redact_stream
}

gateway_ready() {
  report_nautilus_health
  account_snapshot_ready
}

parse_args() {
  while (($#)); do
    case "$1" in
      --check-only)
        CHECK_ONLY=true
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

run_check_only() {
  section "IBKR Gateway check-only readiness check"
  if gateway_ready; then
    info "IBKR Gateway check-only readiness check passed"
    return 0
  fi

  warn "IBKR Gateway check-only readiness check failed"
  return 1
}

wait_for_gateway_ready() {
  local attempt="$1"
  local deadline
  local now
  local remaining
  local sleep_for

  if gateway_ready; then
    info "IBKR Gateway readiness checks passed after login request attempt ${attempt}"
    return 0
  fi

  if ((IBKR_2FA_APPROVAL_TIMEOUT_SECONDS <= 0)); then
    return 1
  fi

  deadline=$(($(date +%s) + IBKR_2FA_APPROVAL_TIMEOUT_SECONDS))
  while true; do
    now="$(date +%s)"
    remaining=$((deadline - now))
    if ((remaining <= 0)); then
      return 1
    fi

    sleep_for="${IBKR_2FA_RETRY_INTERVAL_SECONDS}"
    if ((sleep_for > remaining)); then
      sleep_for="${remaining}"
    fi

    info "IBKR Gateway not ready after login request attempt ${attempt}; waiting ${sleep_for}s before the next passive readiness check"
    sleep "${sleep_for}"
    if gateway_ready; then
      info "IBKR Gateway readiness checks passed after login request attempt ${attempt}"
      return 0
    fi
  done
}

main() {
  parse_args "$@"
  cd_repo_root
  if ! truthy "${IBKR_2FA_SKIP_LOAD_ENV:-false}"; then
    load_env
  fi
  apply_local_defaults
  force_gateway_required_env
  validate_safe_prototype
  validate_positive_integer IBKR_2FA_RETRY_INTERVAL_SECONDS "${IBKR_2FA_RETRY_INTERVAL_SECONDS}"
  validate_non_negative_integer IBKR_2FA_MAX_ATTEMPTS "${IBKR_2FA_MAX_ATTEMPTS}"
  validate_non_negative_integer IBKR_2FA_APPROVAL_TIMEOUT_SECONDS "${IBKR_2FA_APPROVAL_TIMEOUT_SECONDS}"
  validate_non_negative_integer IBKR_2FA_RESTART_COOLDOWN_SECONDS "${IBKR_2FA_RESTART_COOLDOWN_SECONDS}"
  validate_non_negative_integer IBKR_2FA_VERIFY_CLIENT_ID "${IBKR_2FA_VERIFY_CLIENT_ID}"
  validate_non_negative_integer IBKR_2FA_VERIFY_TIMEOUT_SECONDS "${IBKR_2FA_VERIFY_TIMEOUT_SECONDS}"

  # One run at a time: two overlapping runs share client id 98 and the second gets IBKR error 326.
  if command -v flock >/dev/null 2>&1; then
    mkdir -p "${IBKR_2FA_RESTART_STATE_DIR}"
    exec 9>"${IBKR_2FA_RESTART_STATE_DIR}/request-ibkr-2fa.lock"
    if ! flock -w "${IBKR_2FA_LOCK_WAIT_SECONDS:-120}" 9; then
      warn "Another IBKR 2FA/check run holds the lock; client id ${IBKR_2FA_VERIFY_CLIENT_ID} is in use by it"
      return 75
    fi
  fi

  if [[ "${CHECK_ONLY}" == true ]]; then
    run_check_only
    return $?
  fi

  local attempt=1
  while true; do
    section "IBKR Gateway readiness check ${attempt}"
    if gateway_ready; then
      info "IBKR Gateway readiness checks already pass; no 2FA request needed"
      return 0
    fi

    section "IBKR 2FA login request attempt ${attempt}"
    if gateway_login_request_due; then
      send_login_email
      record_gateway_login_request
      trigger_gateway_login
    else
      warn "Skipping duplicate IBKR 2FA email/restart while continuing readiness polling"
    fi

    if wait_for_gateway_ready "${attempt}"; then
      return 0
    fi

    warn "IBKR Gateway readiness checks did not pass after login request attempt ${attempt}"
    if ((IBKR_2FA_MAX_ATTEMPTS > 0 && attempt >= IBKR_2FA_MAX_ATTEMPTS)); then
      die "IBKR Gateway did not become ready after ${attempt} login request attempt(s)"
    fi

    info "Sleeping ${IBKR_2FA_RETRY_INTERVAL_SECONDS}s before the next IBKR 2FA login request attempt"
    sleep "${IBKR_2FA_RETRY_INTERVAL_SECONDS}"
    attempt=$((attempt + 1))
  done
}

main "$@"
