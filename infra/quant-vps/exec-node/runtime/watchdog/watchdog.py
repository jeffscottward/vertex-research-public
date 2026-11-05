from __future__ import annotations

import json
import os
import re
import signal
import socket
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


SENSITIVE_KEY_PARTS = (
    "account",
    "auth",
    "key",
    "password",
    "secret",
    "token",
    "username",
)
URL_PATTERN = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"<>]+")
UPTIME_PUSH_PATH_PATTERN = re.compile(r"(/api/push/)[^/?\s'\"<>]+")
SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b([a-z0-9_.-]*(?:account|auth|key|password|secret|token|username)[a-z0-9_.-]*\s*[:=]\s*)([^,\s;]+)"
)
AUTH_HEADER_PATTERN = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*")


class SafetyError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def kill_switch_metadata_value(value: Any) -> str:
    return str(value).replace("\r", " ").replace("\n", " ")[:240]


def create_kill_switch_file(path: Path, metadata: dict[str, Any]) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.tmp.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for key, value in metadata.items():
                handle.write(f"{key}={kill_switch_metadata_value(value)}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, 0o600)
        try:
            os.link(tmp_name, path)
        except FileExistsError:
            return False
        return True
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(part in lowered for part in SENSITIVE_KEY_PARTS)


def redact_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return value
    if not parsed.scheme or not parsed.netloc:
        return value

    netloc = parsed.hostname or ""
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    if parsed.username or parsed.password:
        netloc = f"***:***@{netloc}"

    path_parts = parsed.path.split("/")
    if len(path_parts) >= 4 and path_parts[1:3] == ["api", "push"]:
        path_parts[3] = "***"
    query = urlencode(
        [
            (key, "REDACTED" if is_sensitive_key(key) else val)
            for key, val in parse_qsl(parsed.query, keep_blank_values=True)
        ]
    )
    return urlunsplit((parsed.scheme, netloc, "/".join(path_parts), query, parsed.fragment))


def redact_text(value: str) -> str:
    redacted = URL_PATTERN.sub(lambda match: redact_url(match.group(0)), value)
    redacted = UPTIME_PUSH_PATH_PATTERN.sub(r"\1***", redacted)
    redacted = SECRET_ASSIGNMENT_PATTERN.sub(lambda match: f"{match.group(1)}REDACTED", redacted)
    return AUTH_HEADER_PATTERN.sub(lambda match: f"{match.group(1)} REDACTED", redacted)


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("REDACTED" if is_sensitive_key(str(key)) else redact(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    if isinstance(value, str):
        return redact_text(redact_url(value))
    return value


def safe_detail(exc: Exception | str) -> str:
    detail = f"{type(exc).__name__}: {exc}" if isinstance(exc, Exception) else str(exc)
    return str(redact(detail))[:240]


def load_yaml_config(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    config_path = Path(path)
    if not config_path.exists():
        raise SafetyError(f"watchdog config file not found: {config_path}")
    import yaml

    loaded = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise SafetyError("watchdog config root must be a mapping")
    values = loaded.get("watchdog", loaded)
    if not isinstance(values, dict):
        raise SafetyError("watchdog config section must be a mapping")
    normalized = {}
    for key, value in values.items():
        upper_key = str(key).upper()
        normalized[upper_key] = value
        if not upper_key.startswith("WATCHDOG_"):
            normalized[f"WATCHDOG_{upper_key}"] = value
    return normalized


@dataclass(frozen=True)
class WatchdogConfig:
    trading_mode: str = "paper"
    enable_live_trading: bool = False
    live_risk_acknowledged: bool = False
    ibkr_account_id: str = ""
    live_trading_account_allowlist: str = ""
    nautilus_risk_orders_enabled: bool = False
    nautilus_risk_dry_run: bool = False
    charan_trade_intents_enabled: bool = False
    charan_live_transmit_enabled: bool = False
    health_host: str = "0.0.0.0"
    health_port: int = 8081
    check_interval_seconds: int = 30
    failure_threshold: int = 3
    restart_cooldown_seconds: int = 300
    max_restart_count: int = 3
    status_log_interval_seconds: int = 60
    http_timeout_seconds: float = 3.0
    socket_timeout_seconds: float = 3.0
    log_dir: Path = Path("./data/nautilus/logs")
    kill_switch_path: Path = Path("./data/KILL_SWITCH")
    # The Nautilus owner arm record. A kill switch deletes it, so removing the
    # kill switch never re-arms the node without the owner.
    nautilus_armed_path: Path = Path("./data/nautilus/ARMED")
    create_kill_switch_on_critical: bool = False
    kill_switch_failure_threshold: int = 6
    redis_url: str = "redis://redis:6379/0"
    postgres_url: str = "postgresql://vertex_quant:vertex_quant_dev_only@postgres:5432/vertex_quant"
    nautilus_health_url: str = "http://nautilus-trader:8080/health"
    docker_enabled: bool = False
    restart_enabled: bool = False
    redis_container_name: str = "redis"
    postgres_container_name: str = "postgres"
    nautilus_container_name: str = "nautilus-trader"
    ib_gateway_container_name: str = "ib-gateway"
    ib_gateway_enabled: bool = False
    ib_gateway_required: bool = False
    ib_host: str = "ib-gateway"
    ib_port: int = 4004
    ibapi_test_enabled: bool = False
    ibapi_client_id: int = 97
    uptime_kuma_push_url: str = ""

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "WatchdogConfig":
        env = env or os.environ
        file_values = load_yaml_config(env.get("WATCHDOG_CONFIG"))

        def value(name: str, default: Any) -> Any:
            return env.get(name, file_values.get(name, default))

        def gateway_value(name: str, legacy_name: str, default: Any) -> Any:
            return env.get(
                name,
                env.get(legacy_name, file_values.get(name, file_values.get(legacy_name, default))),
            )

        trading_mode = str(value("TRADING_MODE", "paper")).strip().lower()
        live_broker_enabled = trading_mode == "live" and (
            parse_bool(value("ENABLE_LIVE_TRADING", False))
            or parse_bool(value("CHARAN_LIVE_TRANSMIT_ENABLED", False))
            or parse_bool(value("NAUTILUS_RISK_ORDERS_ENABLED", False))
        )
        ib_gateway_enabled = parse_bool(value("IBKR_GATEWAY_ENABLED", False))
        ib_gateway_required = (
            parse_bool(value("IB_GATEWAY_REQUIRED", False))
            or parse_bool(value("WATCHDOG_REQUIRE_IB_GATEWAY", False))
            or ib_gateway_enabled
            or live_broker_enabled
        )
        kill_switch_on_failure = parse_bool(value("WATCHDOG_CREATE_KILL_SWITCH_ON_CRITICAL", False)) or parse_bool(
            value("WATCHDOG_CREATE_KILL_SWITCH_ON_FAILURE", False)
        )
        failure_threshold = max(1, int(value("WATCHDOG_FAILURE_THRESHOLD", 3)))

        config = cls(
            trading_mode=trading_mode,
            enable_live_trading=parse_bool(value("ENABLE_LIVE_TRADING", False)),
            live_risk_acknowledged=parse_bool(value("I_UNDERSTAND_LIVE_TRADING_RISK", False)),
            ibkr_account_id=str(value("IBKR_ACCOUNT_ID", "")),
            live_trading_account_allowlist=str(value("LIVE_TRADING_ACCOUNT_ALLOWLIST", "")),
            nautilus_risk_orders_enabled=parse_bool(value("NAUTILUS_RISK_ORDERS_ENABLED", False)),
            nautilus_risk_dry_run=parse_bool(value("NAUTILUS_RISK_DRY_RUN", False)),
            charan_trade_intents_enabled=parse_bool(value("CHARAN_TRADE_INTENTS_ENABLED", False)),
            charan_live_transmit_enabled=parse_bool(value("CHARAN_LIVE_TRANSMIT_ENABLED", False)),
            health_host=str(value("WATCHDOG_HEALTH_HOST", "0.0.0.0")),
            health_port=int(value("WATCHDOG_HEALTH_PORT", 8081)),
            check_interval_seconds=max(1, int(value("WATCHDOG_CHECK_INTERVAL_SECONDS", 30))),
            failure_threshold=failure_threshold,
            restart_cooldown_seconds=max(0, int(value("WATCHDOG_RESTART_COOLDOWN_SECONDS", 300))),
            max_restart_count=max(0, int(value("WATCHDOG_MAX_RESTARTS", 3))),
            status_log_interval_seconds=max(1, int(value("WATCHDOG_STATUS_LOG_INTERVAL_SECONDS", 60))),
            http_timeout_seconds=max(0.1, float(value("WATCHDOG_HTTP_TIMEOUT_SECONDS", 3))),
            socket_timeout_seconds=max(0.1, float(value("WATCHDOG_SOCKET_TIMEOUT_SECONDS", 3))),
            log_dir=Path(str(value("WATCHDOG_LOG_DIR", value("NAUTILUS_LOG_DIR", "./data/nautilus/logs")))),
            kill_switch_path=Path(str(value("KILL_SWITCH_PATH", "./data/KILL_SWITCH"))),
            nautilus_armed_path=Path(str(value("NAUTILUS_ARMED_PATH", "./data/nautilus/ARMED"))),
            create_kill_switch_on_critical=kill_switch_on_failure,
            kill_switch_failure_threshold=max(
                failure_threshold,
                int(value("WATCHDOG_KILL_SWITCH_FAILURE_THRESHOLD", failure_threshold * 2)),
            ),
            redis_url=str(value("REDIS_URL", "redis://redis:6379/0")),
            postgres_url=str(
                value("POSTGRES_URL", "postgresql://vertex_quant:vertex_quant_dev_only@postgres:5432/vertex_quant")
            ),
            nautilus_health_url=str(value("NAUTILUS_HEALTH_URL", "http://nautilus-trader:8080/health")),
            docker_enabled=parse_bool(value("WATCHDOG_DOCKER_ENABLED", False)),
            restart_enabled=parse_bool(value("WATCHDOG_RESTART_ENABLED", False)),
            redis_container_name=str(value("WATCHDOG_REDIS_CONTAINER", "redis")),
            postgres_container_name=str(value("WATCHDOG_POSTGRES_CONTAINER", "postgres")),
            nautilus_container_name=str(value("WATCHDOG_NAUTILUS_CONTAINER", "nautilus-trader")),
            ib_gateway_container_name=str(value("WATCHDOG_IB_GATEWAY_CONTAINER", "ib-gateway")),
            ib_gateway_enabled=ib_gateway_enabled,
            ib_gateway_required=ib_gateway_required,
            ib_host=str(gateway_value("IB_GATEWAY_HOST", "IBKR_HOST", "ib-gateway")),
            ib_port=int(gateway_value("IB_GATEWAY_PORT", "IBKR_PORT", 4004)),
            ibapi_test_enabled=parse_bool(value("WATCHDOG_IBAPI_TEST_ENABLED", ib_gateway_required)),
            ibapi_client_id=int(value("WATCHDOG_IBAPI_CLIENT_ID", 97)),
            uptime_kuma_push_url=str(value("UPTIME_KUMA_PUSH_URL", "")),
        )
        validate_safe_mode(config)
        return config


def allowlist_contains_account(account: str, allowlist: str) -> bool:
    normalized_account = "".join(str(account or "").split()).lower()
    for entry in str(allowlist or "").split(","):
        if normalized_account and "".join(entry.split()).lower() == normalized_account:
            return True
    return False


def validate_safe_mode(config: WatchdogConfig) -> None:
    trading_mode = config.trading_mode.strip().lower()
    if trading_mode == "paper":
        if config.enable_live_trading:
            raise SafetyError("ENABLE_LIVE_TRADING=true requires TRADING_MODE=live")
        return
    if trading_mode != "live":
        raise SafetyError(f"unsafe trading mode refused: {config.trading_mode}")
    if not config.enable_live_trading:
        raise SafetyError("TRADING_MODE=live requires ENABLE_LIVE_TRADING=true")
    if not config.live_risk_acknowledged:
        raise SafetyError("TRADING_MODE=live requires I_UNDERSTAND_LIVE_TRADING_RISK=true")
    if not config.ibkr_account_id.strip():
        raise SafetyError("TRADING_MODE=live requires IBKR_ACCOUNT_ID")
    if not allowlist_contains_account(config.ibkr_account_id, config.live_trading_account_allowlist):
        raise SafetyError("IBKR_ACCOUNT_ID must match LIVE_TRADING_ACCOUNT_ALLOWLIST")


@dataclass
class CheckStatus:
    name: str
    required: bool
    ok: bool = True
    detail: str = "not_checked"
    consecutive_failures: int = 0
    checked_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "required": self.required,
            "ok": self.ok,
            "detail": self.detail,
            "consecutive_failures": self.consecutive_failures,
            "checked_at": self.checked_at,
        }


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str
    required: bool = True


@dataclass
class WatchdogState:
    service: str = "watchdog"
    started_at: str = field(default_factory=utc_now)
    safe_mode: bool = True
    orders_enabled: bool = False
    nautilus_orders_enabled: bool = False
    watchdog_restart_enabled: bool = False
    live_flags: dict[str, Any] = field(default_factory=dict)
    checks: dict[str, CheckStatus] = field(default_factory=dict)
    last_restart_at: float | None = None
    last_restart_reason: str | None = None
    restart_attempts: dict[str, int] = field(default_factory=dict)
    last_restart_at_by_service: dict[str, float] = field(default_factory=dict)
    kill_switch_created_at: str | None = None
    kill_switch_reason: str | None = None

    def record(self, result: CheckResult) -> None:
        status = self.checks.setdefault(result.name, CheckStatus(name=result.name, required=result.required))
        status.required = result.required
        status.ok = result.ok
        status.detail = str(redact(result.detail))[:240]
        status.checked_at = utc_now()
        status.consecutive_failures = 0 if result.ok else status.consecutive_failures + 1

    def required_failures(self) -> list[CheckStatus]:
        return [status for status in self.checks.values() if status.required and not status.ok]

    def recent_status(self) -> dict[str, Any]:
        failures = self.required_failures()
        checked_times = [status.checked_at for status in self.checks.values() if status.checked_at]
        return {
            "status": "ok" if not failures else "degraded",
            "required_failures": sorted(status.name for status in failures),
            "last_checked_at": max(checked_times) if checked_times else None,
        }

    def as_dict(self) -> dict[str, Any]:
        failures = self.required_failures()
        return {
            "service": self.service,
            "status": "ok" if not failures else "degraded",
            "safe_mode": self.safe_mode,
            "orders_enabled": self.orders_enabled,
            "nautilus_orders_enabled": self.nautilus_orders_enabled,
            "watchdog_restart_enabled": self.watchdog_restart_enabled,
            "live_flags": dict(self.live_flags),
            "started_at": self.started_at,
            "checks": {name: status.as_dict() for name, status in sorted(self.checks.items())},
            "last_restart_reason": self.last_restart_reason,
            "last_restart_at": self.last_restart_at,
            "restart_attempts": dict(sorted(self.restart_attempts.items())),
            "last_restart_at_by_service": dict(sorted(self.last_restart_at_by_service.items())),
            "kill_switch_created_at": self.kill_switch_created_at,
            "kill_switch_reason": self.kill_switch_reason,
            "recent_status": self.recent_status(),
        }


class DockerManager:
    def __init__(self, config: WatchdogConfig) -> None:
        self.config = config
        self.client: Any = None

    def _client(self) -> Any:
        if self.client is None:
            import docker

            self.client = docker.from_env()
            self.client.ping()
        return self.client

    def find_container(self, service_name: str, container_name: str) -> Any:
        client = self._client()
        try:
            return client.containers.get(container_name)
        except Exception:
            containers = client.containers.list(
                all=True,
                filters={"label": f"com.docker.compose.service={service_name}"},
            )
            if not containers:
                raise RuntimeError(f"{service_name} container not found")
            return containers[0]

    def find_nautilus_container(self) -> Any:
        return self.find_container("nautilus-trader", self.config.nautilus_container_name)

    def check_container_state(
        self,
        service_name: str,
        container_name: str,
        check_name: str,
        required: bool = True,
    ) -> CheckResult:
        if not self.config.docker_enabled:
            return CheckResult(check_name, True, "docker_check_disabled", required=False)
        try:
            container = self.find_container(service_name, container_name)
            container.reload()
            state = container.attrs.get("State", {})
            health = state.get("Health", {}).get("Status", "no_healthcheck")
            running = state.get("Status") == "running"
            ok = running and health != "unhealthy"
            detail = f"container_status={state.get('Status', 'unknown')}; health={health}"
            return CheckResult(check_name, ok, detail, required=required)
        except Exception as exc:
            return CheckResult(check_name, False, safe_detail(exc), required=required)

    def check_nautilus_container(self) -> CheckResult:
        return self.check_container_state(
            "nautilus-trader",
            self.config.nautilus_container_name,
            "nautilus_container",
        )

    def restart_container(self, service_name: str, container_name: str) -> str:
        container = self.find_container(service_name, container_name)
        container.restart(timeout=10)
        return "restart_requested"

    def restart_nautilus(self) -> str:
        return self.restart_container("nautilus-trader", self.config.nautilus_container_name)

    def restart_ib_gateway(self) -> str:
        return self.restart_container("ib-gateway", self.config.ib_gateway_container_name)


class WatchdogService:
    def __init__(
        self,
        config: WatchdogConfig,
        docker_manager: DockerManager | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self.state = WatchdogState()
        self.docker_manager = docker_manager or DockerManager(config)
        self.monotonic = monotonic
        self.lock = threading.Lock()
        self.last_status_log_at = 0.0

    def refresh_order_state(self) -> None:
        configured_for_live_orders = (
            self.config.trading_mode.strip().lower() == "live"
            and self.config.enable_live_trading
            and self.config.live_risk_acknowledged
            and bool(self.config.ibkr_account_id.strip())
            and allowlist_contains_account(self.config.ibkr_account_id, self.config.live_trading_account_allowlist)
        )
        required_checks = [status for status in self.state.checks.values() if status.required]
        required_checks_ok = bool(required_checks) and not self.state.required_failures()
        kill_switch_active = self.config.kill_switch_path.exists()

        nautilus_live_capable = (
            configured_for_live_orders
            and self.config.nautilus_risk_orders_enabled
            and not self.config.nautilus_risk_dry_run
        )

        self.state.nautilus_orders_enabled = nautilus_live_capable and required_checks_ok and not kill_switch_active
        self.state.orders_enabled = self.state.nautilus_orders_enabled
        self.state.safe_mode = not self.state.nautilus_orders_enabled
        self.state.watchdog_restart_enabled = self.config.restart_enabled and self.config.docker_enabled
        self.state.live_flags = {
            "trading_mode": self.config.trading_mode,
            "enable_live_trading": self.config.enable_live_trading,
            "live_risk_acknowledged": self.config.live_risk_acknowledged,
            "nautilus_risk_orders_enabled": self.config.nautilus_risk_orders_enabled,
            "nautilus_risk_dry_run": self.config.nautilus_risk_dry_run,
            "charan_trade_intents_enabled": self.config.charan_trade_intents_enabled,
            "charan_live_transmit_enabled": self.config.charan_live_transmit_enabled,
            "kill_switch_active": kill_switch_active,
        }

    def log_event(self, event: dict[str, Any]) -> None:
        self.config.log_dir.mkdir(parents=True, exist_ok=True)
        payload = redact({"timestamp": utc_now(), **event})
        with (self.config.log_dir / "watchdog.log").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
        print(json.dumps(payload, sort_keys=True), flush=True)

    def status_payload(self) -> dict[str, Any]:
        self.refresh_order_state()
        return redact(self.state.as_dict())

    def metrics_text(self) -> str:
        payload = self.status_payload()

        def label(value: Any) -> str:
            return str(redact(value)).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')

        lines = [
            "# HELP watchdog_up 1 when required watchdog checks are passing.",
            "# TYPE watchdog_up gauge",
            f"watchdog_up {1 if payload['status'] == 'ok' else 0}",
            "# HELP watchdog_required_failures Current required check failures.",
            "# TYPE watchdog_required_failures gauge",
            f"watchdog_required_failures {len(payload['recent_status']['required_failures'])}",
            "# HELP watchdog_check_ok 1 when a check is passing.",
            "# TYPE watchdog_check_ok gauge",
        ]
        for name, status in payload["checks"].items():
            required = str(status["required"]).lower()
            lines.append(
                f'watchdog_check_ok{{name="{label(name)}",required="{required}"}} {1 if status["ok"] else 0}'
            )
            lines.append(
                f'watchdog_check_consecutive_failures{{name="{label(name)}"}} {int(status["consecutive_failures"])}'
            )
        for service_name, attempts in payload["restart_attempts"].items():
            lines.append(f'watchdog_restart_attempts_total{{service="{label(service_name)}"}} {int(attempts)}')
        return "\n".join(lines) + "\n"

    def check_redis(self) -> CheckResult:
        try:
            import redis

            client = redis.from_url(
                self.config.redis_url,
                decode_responses=True,
                socket_connect_timeout=self.config.socket_timeout_seconds,
                socket_timeout=self.config.socket_timeout_seconds,
            )
            client.ping()
            return CheckResult("redis", True, "pong")
        except Exception as exc:
            return CheckResult("redis", False, safe_detail(exc))

    def check_postgres(self) -> CheckResult:
        try:
            import psycopg

            with psycopg.connect(
                self.config.postgres_url,
                connect_timeout=int(self.config.socket_timeout_seconds),
                autocommit=True,
            ) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
            return CheckResult("postgres", True, "select_1_ok")
        except Exception as exc:
            return CheckResult("postgres", False, safe_detail(exc))

    def check_nautilus_health(self) -> CheckResult:
        try:
            import requests

            response = requests.get(self.config.nautilus_health_url, timeout=self.config.http_timeout_seconds)
            detail = f"http_status={response.status_code}"
            if response.headers.get("content-type", "").startswith("application/json"):
                payload = response.json()
                detail = f"{detail}; service={payload.get('service', 'unknown')}; status={payload.get('status', 'unknown')}"
            return CheckResult("nautilus_health", response.ok, detail)
        except Exception as exc:
            return CheckResult("nautilus_health", False, safe_detail(exc))

    def check_container_states(self) -> list[CheckResult]:
        ib_gateway_required = self.config.ib_gateway_required or self.config.ib_gateway_enabled
        results = [
            self.docker_manager.check_container_state(
                "redis",
                self.config.redis_container_name,
                "redis_container",
            ),
            self.docker_manager.check_container_state(
                "postgres",
                self.config.postgres_container_name,
                "postgres_container",
            ),
            self.docker_manager.check_nautilus_container(),
        ]
        if ib_gateway_required:
            results.append(
                self.docker_manager.check_container_state(
                    "ib-gateway",
                    self.config.ib_gateway_container_name,
                    "ib_gateway_container",
                    required=self.config.ib_gateway_required,
                )
            )
        else:
            results.append(CheckResult("ib_gateway_container", True, "ib_gateway_not_required", required=False))
        return results

    def run_ibapi_connection_test(self) -> str:
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        ready = threading.Event()

        class Probe(EWrapper, EClient):
            def __init__(self) -> None:
                EClient.__init__(self, self)

            def nextValidId(self, orderId: int) -> None:
                ready.set()

        probe = Probe()
        probe.connect(self.config.ib_host, self.config.ib_port, clientId=self.config.ibapi_client_id)
        thread = threading.Thread(target=probe.run, name="watchdog-ibapi-probe", daemon=True)
        thread.start()
        try:
            if not ready.wait(self.config.socket_timeout_seconds):
                raise RuntimeError("ibapi handshake timeout")
            return "ibapi_connected"
        finally:
            probe.disconnect()
            thread.join(timeout=1)

    def check_ib_gateway(self) -> CheckResult:
        if not self.config.ib_gateway_required and not self.config.ib_gateway_enabled:
            return CheckResult("ib_gateway", True, "ib_gateway_not_required_phase01", required=False)
        try:
            with socket.create_connection(
                (self.config.ib_host, self.config.ib_port),
                timeout=self.config.socket_timeout_seconds,
            ):
                detail = "socket_open"
            if self.config.ibapi_test_enabled:
                detail = f"{detail}; {self.run_ibapi_connection_test()}"
            return CheckResult("ib_gateway", True, detail, required=self.config.ib_gateway_required)
        except Exception as exc:
            return CheckResult("ib_gateway", False, safe_detail(exc), required=self.config.ib_gateway_required)

    def push_uptime_kuma(self) -> CheckResult:
        if not self.config.uptime_kuma_push_url:
            return CheckResult("uptime_kuma", True, "push_url_not_configured", required=False)
        try:
            import requests

            status = "up" if not self.state.required_failures() else "down"
            failures = ",".join(self.status_payload()["recent_status"]["required_failures"]) or "none"
            response = requests.get(
                self.config.uptime_kuma_push_url,
                params={"status": status, "msg": f"watchdog {status}; required_failures={failures}"},
                timeout=self.config.http_timeout_seconds,
            )
            return CheckResult("uptime_kuma", response.ok, f"http_status={response.status_code}", required=False)
        except Exception as exc:
            return CheckResult("uptime_kuma", False, safe_detail(exc), required=False)

    def maybe_restart_service(self, service_name: str, reason: str, restart: Callable[[], str]) -> None:
        if not self.config.restart_enabled or not self.config.docker_enabled:
            return
        attempts = self.state.restart_attempts.get(service_name, 0)
        if attempts >= self.config.max_restart_count:
            self.log_event({"event": "service_restart_skipped", "service": service_name, "reason": reason, "detail": "max_restarts_reached"})
            return
        now = self.monotonic()
        last_restart_at = self.state.last_restart_at_by_service.get(service_name)
        if last_restart_at is not None:
            elapsed = now - last_restart_at
            if elapsed < self.config.restart_cooldown_seconds:
                return
        self.state.restart_attempts[service_name] = attempts + 1
        self.state.last_restart_at_by_service[service_name] = now
        self.state.last_restart_at = now
        self.state.last_restart_reason = reason
        try:
            detail = restart()
        except Exception as exc:
            self.log_event(
                {"event": "service_restart_failed", "service": service_name, "reason": reason, "detail": safe_detail(exc)}
            )
            return
        self.log_event({"event": "service_restart_requested", "service": service_name, "reason": reason, "detail": detail})

    def maybe_restart_nautilus(self, reason: str) -> None:
        self.maybe_restart_service("nautilus-trader", reason, self.docker_manager.restart_nautilus)

    def maybe_restart_ib_gateway(self, reason: str) -> None:
        self.maybe_restart_service("ib-gateway", reason, self.docker_manager.restart_ib_gateway)

    def clear_arm_record_on_kill_switch(self) -> None:
        """While the kill switch exists, the owner arm record must not exist."""
        if not self.config.kill_switch_path.exists():
            return
        try:
            self.config.nautilus_armed_path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            self.log_event({"event": "arm_record_clear_failed", "detail": safe_detail(exc)})
            return
        self.log_event(
            {"event": "arm_record_cleared_by_kill_switch", "path": str(self.config.nautilus_armed_path)}
        )

    def maybe_create_kill_switch(self) -> None:
        if not self.config.create_kill_switch_on_critical:
            return
        critical = [
            status
            for status in self.state.checks.values()
            if status.required
            and not status.ok
            and status.consecutive_failures >= self.config.kill_switch_failure_threshold
        ]
        if not critical or self.config.kill_switch_path.exists():
            return

        reason = ",".join(sorted(status.name for status in critical))
        created_at = utc_now()
        try:
            created = create_kill_switch_file(
                self.config.kill_switch_path,
                {
                    "created_at": created_at,
                    "reason": reason,
                    "source": "watchdog",
                    "threshold": self.config.kill_switch_failure_threshold,
                    "required_failures": reason,
                },
            )
        except Exception as exc:
            self.log_event({"event": "kill_switch_create_failed", "reason": reason, "detail": safe_detail(exc)})
            return
        if not created:
            return

        self.state.kill_switch_created_at = created_at
        self.state.kill_switch_reason = reason
        self.log_event({"event": "kill_switch_created", "reason": reason, "path": str(self.config.kill_switch_path)})

    def run_check_cycle(self) -> dict[str, Any]:
        results = [
            self.check_redis(),
            self.check_postgres(),
            self.check_nautilus_health(),
            *self.check_container_states(),
            self.check_ib_gateway(),
        ]

        with self.lock:
            for result in results:
                self.state.record(result)
            self.state.record(self.push_uptime_kuma())

            for name in ("nautilus_health", "nautilus_container"):
                status = self.state.checks.get(name)
                if (
                    status
                    and not status.ok
                    and status.consecutive_failures >= self.config.failure_threshold
                ):
                    self.maybe_restart_nautilus(f"{name}_failed")
                    break

            gateway_status = self.state.checks.get("ib_gateway")
            if (
                gateway_status
                and gateway_status.required
                and not gateway_status.ok
                and gateway_status.consecutive_failures >= self.config.failure_threshold
            ):
                self.maybe_restart_ib_gateway("ib_gateway_api_failed")

            self.maybe_create_kill_switch()
            self.clear_arm_record_on_kill_switch()

            summary = self.status_payload()
            now = self.monotonic()
            if now - self.last_status_log_at >= self.config.status_log_interval_seconds:
                self.last_status_log_at = now
                self.log_event({"event": "watchdog_status", "summary": summary})
            return summary

    def serve_health(self) -> ThreadingHTTPServer:
        service = self

        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                path = self.path.split("?", 1)[0]
                if path == "/metrics":
                    with service.lock:
                        body = service.metrics_text().encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; version=0.0.4")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                if path not in {"/health", "/ready", "/status"}:
                    self.send_response(404)
                    self.end_headers()
                    return
                with service.lock:
                    payload = service.status_payload()
                status_code = 503 if path == "/ready" and payload["status"] != "ok" else 200
                body = json.dumps(payload, sort_keys=True).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        server = ThreadingHTTPServer((self.config.health_host, self.config.health_port), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, name="watchdog-health-server", daemon=True)
        thread.start()
        return server

    def run(self, stop_event: threading.Event) -> None:
        self.log_event(
            {
                "event": "watchdog_started",
                "trading_mode": self.config.trading_mode,
                "orders_enabled": self.state.orders_enabled,
                "ib_gateway_required": self.config.ib_gateway_required,
                "uptime_kuma_push_url": self.config.uptime_kuma_push_url,
            }
        )
        server = self.serve_health()
        try:
            while not stop_event.is_set():
                self.run_check_cycle()
                stop_event.wait(self.config.check_interval_seconds)
        finally:
            server.shutdown()
            server.server_close()
            self.log_event({"event": "watchdog_stopped"})


def main() -> int:
    try:
        config = WatchdogConfig.from_env()
        service = WatchdogService(config)
    except Exception as exc:
        print(f"watchdog refused to start: {safe_detail(exc)}", file=sys.stderr)
        return 1

    stop_event = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    service.run(stop_event)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
