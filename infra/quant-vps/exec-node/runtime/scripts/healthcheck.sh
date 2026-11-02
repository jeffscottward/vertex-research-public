#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

GATEWAY_SERVICE="ib-gateway"
GATEWAY_PROFILE="ibkr"
GATEWAY_CHECK_SERVICE="nautilus-trader"
CORE_SERVICES=(redis postgres nautilus-trader watchdog)
OPTIONAL_STATUS_SERVICES=(uptime-kuma netdata)
CRITICAL_FAILURES=0

critical_failure() {
  warn "$*"
  CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
}

gateway_required() {
  truthy "${IBKR_GATEWAY_ENABLED}" || truthy "${IB_GATEWAY_REQUIRED}" || truthy "${WATCHDOG_REQUIRE_IB_GATEWAY}"
}

apply_force_gateway_required() {
  if truthy "${FORCE_IBKR_GATEWAY_REQUIRED:-false}"; then
    export IBKR_GATEWAY_ENABLED=true
    export IB_GATEWAY_REQUIRED=true
    export WATCHDOG_REQUIRE_IB_GATEWAY=true
  fi
}

gateway_running() {
  local services

  services="$(compose --profile "${GATEWAY_PROFILE}" ps --services --status running "${GATEWAY_SERVICE}" 2>/dev/null || true)"
  grep -Fxq "${GATEWAY_SERVICE}" <<<"${services}"
}

print_gateway_status() {
  compose --profile "${GATEWAY_PROFILE}" ps "${GATEWAY_SERVICE}" 2>&1 | redact_stream || warn "Unable to read IB Gateway container status"
}

check_gateway_socket_from_compose() {
  compose exec -T "${GATEWAY_CHECK_SERVICE}" python -c 'import socket, sys; host = sys.argv[1]; port = int(sys.argv[2]); checker = sys.argv[3]; socket.create_connection((host, port), timeout=2).close(); print(f"TWS API socket reachable from {checker} to {host}:{port}")' "${IB_GATEWAY_HOST}" "${IB_GATEWAY_PORT}" "${GATEWAY_CHECK_SERVICE}" 2>&1 | redact_stream
}

print_watchdog_status() {
  compose exec -T watchdog python - <<'PY' 2>&1 | redact_stream
import json
import os
import urllib.request

port = os.getenv("WATCHDOG_HEALTH_PORT", "8081")
with urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=2) as response:
    payload = json.load(response)

recent = payload.get("recent_status") or {}
failures = recent.get("required_failures") or []
if isinstance(failures, (list, tuple)):
    failures_text = ",".join(str(item) for item in failures) or "none"
else:
    failures_text = str(failures) or "none"

print(
    "status={status} safe_mode={safe_mode} orders_enabled={orders_enabled} "
    "required_failures={failures} last_checked_at={last_checked_at}".format(
        status=payload.get("status", "unknown"),
        safe_mode=payload.get("safe_mode", "unknown"),
        orders_enabled=payload.get("orders_enabled", "unknown"),
        failures=failures_text,
        last_checked_at=recent.get("last_checked_at") or "unknown",
    )
)

restart_attempts = payload.get("restart_attempts") or {}
if restart_attempts:
    print(
        "restart_attempts="
        + ",".join(f"{service}:{restart_attempts[service]}" for service in sorted(restart_attempts))
    )

for name, check in sorted((payload.get("checks") or {}).items()):
    check = check or {}
    print(
        "check={name} ok={ok} required={required} failures={failures} detail={detail}".format(
            name=name,
            ok=str(check.get("ok", "unknown")).lower(),
            required=str(check.get("required", "unknown")).lower(),
            failures=check.get("consecutive_failures", "unknown"),
            detail=check.get("detail", ""),
        )
    )
PY
}

print_container_runtime_status() {
  local service="$1"
  local profile="${2:-}"
  local container_ids=()
  local container_id

  if [[ -n "${profile}" ]]; then
    while IFS= read -r container_id; do
      [[ -n "${container_id}" ]] && container_ids+=("${container_id}")
    done < <(compose --profile "${profile}" ps -q "${service}" 2>/dev/null || true)
  else
    while IFS= read -r container_id; do
      [[ -n "${container_id}" ]] && container_ids+=("${container_id}")
    done < <(compose ps -q "${service}" 2>/dev/null || true)
  fi

  if [[ ${#container_ids[@]} -eq 0 ]]; then
    info "No container found for ${service}"
    return 0
  fi

  docker inspect --format '{{.Name}} service={{index .Config.Labels "com.docker.compose.service"}} restart_count={{.RestartCount}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_ids[@]}" 2>&1 | redact_stream || warn "Unable to inspect ${service} container"
}

print_container_runtime_statuses() {
  local gateway_is_running="${1:-false}"
  local service

  for service in "${CORE_SERVICES[@]}"; do
    print_container_runtime_status "${service}"
  done

  for service in "${OPTIONAL_STATUS_SERVICES[@]}"; do
    print_container_runtime_status "${service}"
  done

  if gateway_required || [[ "${gateway_is_running}" == "true" ]]; then
    print_container_runtime_status "${GATEWAY_SERVICE}" "${GATEWAY_PROFILE}"
  else
    info "IB Gateway disabled in prototype mode; no Gateway container runtime status requested"
  fi
}

print_service_logs() {
  local service="$1"
  local label="${service}"
  local -a compose_args=()

  if [[ "${service}" == "${GATEWAY_SERVICE}" ]]; then
    label="IB Gateway"
    compose_args=(--profile "${GATEWAY_PROFILE}")
  fi

  section "Last 20 ${label} log lines"
  if [[ ${#compose_args[@]} -gt 0 ]]; then
    compose "${compose_args[@]}" logs --tail=20 "${service}" 2>&1 | redact_stream || warn "Unable to read ${service} logs"
  else
    compose logs --tail=20 "${service}" 2>&1 | redact_stream || warn "Unable to read ${service} logs"
  fi
}

print_nautilus_health() {
  local health_file

  if compose exec -T nautilus-trader python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2).read().decode().strip())' 2>&1 | redact_stream; then
    return 0
  fi

  health_file="${NAUTILUS_HEALTH_FILE:-./data/nautilus/health.json}"
  if [[ -f "${health_file}" ]]; then
    redact_stream <"${health_file}"
    return 0
  fi

  return 1
}

print_kill_switch_state() {
  local path
  path="$(kill_switch_file)"

  if [[ -e "${path}" ]]; then
    info "Kill switch active: ${path}"
    if [[ -s "${path}" ]]; then
      redact_stream <"${path}"
    fi
  else
    info "Kill switch inactive: ${path}"
  fi
}

main() {
  cd_repo_root
  load_env
  apply_force_gateway_required
  validate_safe_prototype

  local gateway_is_running=false
  if command -v docker >/dev/null 2>&1 && gateway_running; then
    gateway_is_running=true
  fi

  section "Docker status"
  if command -v docker >/dev/null 2>&1; then
    docker info --format 'Docker server {{.ServerVersion}}' 2>/dev/null || critical_failure "Docker daemon is not reachable"
  else
    critical_failure "docker is not installed"
  fi

  section "Compose project status"
  if command -v docker >/dev/null 2>&1; then
    compose ps 2>&1 | redact_stream || critical_failure "Unable to read Compose project status"
  else
    warn "docker is not installed"
  fi

  section "Container restart counts and health"
  if command -v docker >/dev/null 2>&1; then
    print_container_runtime_statuses "${gateway_is_running}"
  else
    warn "docker is not installed"
  fi

  section "Redis ping"
  if command -v docker >/dev/null 2>&1 && compose exec -T redis redis-cli ping 2>&1 | redact_stream; then
    :
  else
    critical_failure "Redis ping failed or Redis is not running"
  fi

  section "Postgres readiness"
  if command -v docker >/dev/null 2>&1 && compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" 2>&1 | redact_stream; then
    :
  else
    critical_failure "Postgres readiness check failed or Postgres is not running"
  fi

  section "IB Gateway container"
  if command -v docker >/dev/null 2>&1; then
    print_gateway_status
    if [[ "${gateway_is_running}" == "true" ]]; then
      info "IBKR profile/service active: ${GATEWAY_SERVICE} is running"
    else
      info "IBKR profile/service inactive: no running ${GATEWAY_SERVICE} container"
      if gateway_required; then
        critical_failure "Required IB Gateway service is not running"
      fi
    fi
  else
    warn "docker is not installed"
  fi

  section "IB Gateway socket"
  if gateway_required || [[ "${gateway_is_running}" == "true" ]]; then
    if command -v docker >/dev/null 2>&1 && check_gateway_socket_from_compose; then
      :
    else
      critical_failure "IB Gateway socket not reachable from ${GATEWAY_CHECK_SERVICE} to ${IB_GATEWAY_HOST}:${IB_GATEWAY_PORT}"
    fi
  else
    info "IB Gateway disabled in prototype mode; skipping socket check"
  fi

  section "Nautilus health"
  if command -v docker >/dev/null 2>&1 && print_nautilus_health; then
    :
  else
    critical_failure "Nautilus health endpoint/file unavailable"
  fi

  section "Watchdog status"
  if command -v docker >/dev/null 2>&1 && print_watchdog_status; then
    :
  else
    critical_failure "Watchdog /status unavailable"
  fi

  section "Kill-switch state"
  print_kill_switch_state

  section "Disk usage"
  df -h . data backups 2>/dev/null || df -h .

  section "Memory usage"
  if command -v free >/dev/null 2>&1; then
    free -h
  elif command -v vm_stat >/dev/null 2>&1; then
    vm_stat | awk 'NR <= 20 {print}'
  else
    warn "No memory status command found"
  fi

  if command -v docker >/dev/null 2>&1; then
    print_service_logs nautilus-trader
    if gateway_required || [[ "${gateway_is_running}" == "true" ]]; then
      print_service_logs "${GATEWAY_SERVICE}"
    else
      section "Last 20 IB Gateway log lines"
      info "IB Gateway disabled in prototype mode; no Gateway logs requested"
    fi
    print_service_logs watchdog
    print_service_logs redis
    print_service_logs postgres
  else
    warn "docker is not installed"
  fi

  if ((CRITICAL_FAILURES > 0)); then
    warn "${CRITICAL_FAILURES} critical healthcheck failure(s)"
    return 1
  fi
}

main "$@"
