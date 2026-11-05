from __future__ import annotations

import base64
import copy
import hmac
import json
import os
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, model_validator
import yaml

from nautilus import arm_gate
from nautilus.risk import RiskLimits, normalize_instruments
from nautilus.strategies.example_strategy import (
    SafeExampleStrategy,
    live_gate_errors,
    normalize_account_allowlist,
)
from nautilus.watchlist import parse_watchlist
from nautilus.ibkr_synthetic_stops import IbkrSyntheticStopBroker, SyntheticStopDaemon
from nautilus.ibkr_staged_protection import (
    IbkrStagedProtectionBroker,
    StagedProtectionDaemon,
)
from nautilus.synthetic_stops import AdaptiveExecutionConfig


class SafetyError(RuntimeError):
    pass


DEFAULT_EVENT_TABLES = {
    "strategy": "strategy_events",
    "order": "order_events",
    "execution": "execution_events",
    "health": "health_events",
    "risk": "risk_events",
}
SENSITIVE_KEY_RE = re.compile(
    r"(^|[_-])(password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?key|session|account[_-]?id|username|userid|user[_-]?id)$",
    re.IGNORECASE,
)
URL_CREDENTIAL_RE = re.compile(r"\b((?:postgres(?:ql)?|redis)://)[^/@\s]+@")
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b([a-z0-9_.-]*(?:account|auth|key|password|passwd|pwd|secret|token|username|userid|user[_-]?id)[a-z0-9_.-]*\s*[:=]\s*)([^,\s;]+)"
)
# IBKR emits these as connection-status or accepted-order warning callbacks; they
# should not turn a Submitted/PreSubmitted order into a failed transmit.
NON_FATAL_IBKR_ERROR_CODES = {399, 2104, 2106, 2107, 2108, 2119, 2158}
WHAT_IF_PENDING_IBKR_ERROR_RE = re.compile(
    r"^1106:\s*Pending to create \d+ what-if orders?: \d+\s*$", re.IGNORECASE
)
def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def parse_account_allowlist(value: str) -> list[str]:
    return normalize_account_allowlist(value.split(","))


def parse_float(value: str) -> float:
    try:
        return float(value)
    except ValueError as exc:
        raise SafetyError(f"invalid numeric value: {value}") from exc


class ConfigModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class TradingConfig(ConfigModel):
    mode: str = Field(min_length=1)
    enable_live_trading: bool
    require_ibkr_credentials: bool
    account_allowlist: list[str] = Field(default_factory=list)
    live_risk_acknowledged: bool = False


class RunnerConfig(ConfigModel):
    heartbeat_interval_seconds: int = Field(ge=1)
    health_host: str = Field(min_length=1)
    health_port: int = Field(ge=1, le=65535)
    log_dir: str = Field(min_length=1)
    health_file: str = Field(default="./data/nautilus/health.json", min_length=1)
    event_log_file: str = Field(min_length=1)
    kill_switch_path: str = Field(min_length=1)


class RedisConfig(ConfigModel):
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    db: int = Field(ge=0)
    url: str = Field(min_length=1)
    heartbeat_key: str = Field(min_length=1)


class PostgresConfig(ConfigModel):
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    database: str = Field(min_length=1)
    user: str = Field(min_length=1)
    password_env: str = Field(min_length=1)
    url_env: str = Field(min_length=1)
    events_table: str = Field(min_length=1)
    event_tables: dict[str, str] = Field(
        default_factory=lambda: DEFAULT_EVENT_TABLES.copy()
    )
    url: str = ""


class RiskConfig(ConfigModel):
    orders_enabled: bool = False
    dry_run: bool = False
    max_position_notional_usd: float = Field(ge=0)
    max_daily_loss_usd: float = Field(ge=0)
    max_order_quantity: float = Field(ge=0)
    max_order_premium_usd: float = Field(default=0.0, ge=0)
    allowed_instruments: list[str] = Field(default_factory=list)
    denied_instruments: list[str] = Field(default_factory=list)
    market_hours_only: bool = False
    market_open: str = "09:30"
    market_close: str = "16:00"
    market_timezone: str = "America/New_York"


class IbkrConfig(ConfigModel):
    adapter: str = Field(min_length=1)
    required: bool
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    client_id: int = Field(ge=0)
    account_id_env: str = Field(min_length=1)
    account_id: str = ""


class StrategyConfig(ConfigModel):
    module: str = Field(min_length=1)
    class_name: str = Field(alias="class", min_length=1)
    watchlist: list[str] = Field(min_length=1)
    observation_only: bool
    sample_orders_enabled: bool
    sample_orders_enabled_env: str = Field(min_length=1)


class SyntheticStopsConfig(ConfigModel):
    enabled: bool = False
    mode: Literal["disabled", "observe", "live"] = "disabled"
    plan_path: str = Field(
        default="./data/nautilus/reports/current/synthetic-stop-plan.json",
        min_length=1,
    )
    plan_schema: Literal[
        "auto",
        "synthetic-stop-plan/v1",
        "staged-protection-plan/v1",
    ] = "auto"
    approval_hmac_key: SecretStr = Field(
        default_factory=lambda: SecretStr(""),
        exclude=True,
        repr=False,
    )
    reviewer_public_key: SecretStr = Field(
        default_factory=lambda: SecretStr(""),
        exclude=True,
        repr=False,
    )
    reviewer_key_id: str = Field(default="", exclude=True, repr=False)
    state_hmac_key: SecretStr = Field(
        default_factory=lambda: SecretStr(""),
        exclude=True,
        repr=False,
    )
    stop_atr_multiplier: float = Field(default=1.0, gt=0)
    round_handle_buffer_atr: float = Field(default=1.0, ge=0)
    initial_limit_offset_atr: float = Field(default=0.10, ge=0)
    reprice_interval_seconds: float = Field(default=0.35, ge=0.25, le=0.50)
    maximum_execution_time_seconds: float = Field(default=10.0, gt=0)
    market_escalation_atr: float = Field(default=0.5, ge=0)
    final_market_order_enabled: bool = True
    execution_hours: str = Field(default="regular", pattern=r"^(regular|extended)$")
    plan_max_age_hours: float = Field(default=24.0, gt=0)
    client_id: int = Field(default=0, ge=0)
    max_order_quantity: float = Field(default=13_000.0, gt=0)
    connect_timeout_seconds: float = Field(default=10.0, gt=0)
    cancel_confirmation_timeout_seconds: float = Field(default=0.5, gt=0)
    poll_interval_seconds: float = Field(default=0.10, gt=0)
    quote_max_age_seconds: float = Field(default=5.0, gt=0, le=5.0)


def _staged_protection_hmac_keys(
    settings: SyntheticStopsConfig,
) -> tuple[str, str, str, str]:
    approval_key = settings.approval_hmac_key.get_secret_value()
    state_key = settings.state_hmac_key.get_secret_value()
    reviewer_public_key = settings.reviewer_public_key.get_secret_value()
    reviewer_key_id = settings.reviewer_key_id
    named_keys = (
        ("SYNTHETIC_STOP_APPROVAL_HMAC_KEY", approval_key),
        ("SYNTHETIC_STOP_STATE_HMAC_KEY", state_key),
    )
    for name, value in named_keys:
        if not value:
            raise SafetyError(
                f"{name} must be supplied externally when staged protection is enabled"
            )
        if len(value.encode("utf-8")) < 32:
            raise SafetyError(f"{name} must be at least 32 bytes")
    if hmac.compare_digest(
        approval_key.encode("utf-8"),
        state_key.encode("utf-8"),
    ):
        raise SafetyError(
            "staged protection approval and state HMAC keys must be distinct"
        )
    try:
        public_key_bytes = base64.b64decode(reviewer_public_key, validate=True)
    except (ValueError, TypeError) as exc:
        raise SafetyError(
            "SYNTHETIC_STOP_REVIEWER_PUBLIC_KEY must be valid base64"
        ) from exc
    if len(public_key_bytes) != 32:
        raise SafetyError("SYNTHETIC_STOP_REVIEWER_PUBLIC_KEY must decode to 32 bytes")
    if (
        not reviewer_key_id
        or len(reviewer_key_id) > 128
        or re.fullmatch(r"[A-Za-z0-9_.:@-]+", reviewer_key_id) is None
    ):
        raise SafetyError(
            "SYNTHETIC_STOP_REVIEWER_KEY_ID must identify the trusted reviewer key"
        )
    return approval_key, state_key, reviewer_public_key, reviewer_key_id


class AppConfig(ConfigModel):
    environment: str = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def _drop_removed_signal_section(cls, data: Any) -> Any:
        # Owner 2026-11-04: signal intake removed; ignore the legacy section.
        legacy = "charan"
        if isinstance(data, dict) and legacy in data:
            data = {key: value for key, value in data.items() if key != legacy}
        return data
    trading: TradingConfig
    runner: RunnerConfig
    redis: RedisConfig
    postgres: PostgresConfig
    risk: RiskConfig
    ibkr: IbkrConfig
    strategy: StrategyConfig
    synthetic_stops: SyntheticStopsConfig = Field(default_factory=SyntheticStopsConfig)
    live_mode_gates_required: list[str] = Field(default_factory=list)


def _validate_resolved_synthetic_stop_runtime(
    config: AppConfig,
    plan_schema: str,
) -> tuple[str, str, str, str] | None:
    settings = config.synthetic_stops
    staged_hmac_keys: tuple[str, str, str, str] | None = None
    if plan_schema == "staged-protection-plan/v1":
        staged_hmac_keys = _staged_protection_hmac_keys(settings)
        if settings.client_id <= 0:
            raise SafetyError(
                "staged protection requires a dedicated nonzero IBKR client ID"
            )
        if settings.execution_hours != "regular":
            raise SafetyError(
                "completed-bar staged protection requires regular execution hours; "
                "extended-hours execution is rejected"
            )
    elif plan_schema == "synthetic-stop-plan/v1":
        if (
            settings.approval_hmac_key.get_secret_value()
            or settings.state_hmac_key.get_secret_value()
            or settings.reviewer_public_key.get_secret_value()
            or settings.reviewer_key_id
            or Path(settings.plan_path).name == "staged-protection-plan.json"
        ):
            raise SafetyError(
                "staged HMAC keys require explicit "
                "staged-protection-plan/v1 configuration"
            )
        if (
            settings.execution_hours == "extended"
            and settings.final_market_order_enabled
        ):
            raise SafetyError(
                "extended-hours synthetic stops cannot use final market escalation"
            )
        if settings.client_id != 0:
            raise SafetyError(
                "synthetic stops require IBKR client ID 0 to bind manual and "
                "cross-client open orders"
            )
    else:
        raise SafetyError(
            f"unsupported synthetic-stop plan schema refused: {plan_schema}"
        )
    if settings.client_id == config.ibkr.client_id:
        raise SafetyError("protection and primary IBKR client IDs must be distinct")
    return staged_hmac_keys


def _validate_safe_model(config: AppConfig) -> None:
    mode = config.trading.mode.strip().lower()
    if mode not in {"paper", "live"}:
        raise SafetyError(f"unsafe trading mode refused: {mode}")
    if config.ibkr.adapter.strip().lower() != "tws_api":
        raise SafetyError(f"unsupported IBKR adapter refused: {config.ibkr.adapter}")
    if mode == "live":
        errors = live_gate_errors(
            enable_live_trading=config.trading.enable_live_trading,
            account_id=config.ibkr.account_id,
            account_allowlist=config.trading.account_allowlist,
            live_risk_acknowledged=config.trading.live_risk_acknowledged,
        )
        if errors:
            raise SafetyError(f"live trading gates refused: {'; '.join(errors)}")
    elif config.trading.enable_live_trading:
        raise SafetyError("ENABLE_LIVE_TRADING=true requires TRADING_MODE=live")
    if config.risk.orders_enabled and not config.risk.dry_run:
        if config.risk.max_order_quantity <= 0:
            raise SafetyError(
                "risk.orders_enabled=true requires risk.max_order_quantity > 0"
            )
        if config.risk.max_position_notional_usd <= 0:
            raise SafetyError(
                "risk.orders_enabled=true requires risk.max_position_notional_usd > 0"
            )
        if config.risk.max_daily_loss_usd <= 0:
            raise SafetyError(
                "risk.orders_enabled=true requires risk.max_daily_loss_usd > 0"
            )
        if not normalize_instruments(config.risk.allowed_instruments):
            raise SafetyError(
                "risk.orders_enabled=true requires risk.allowed_instruments"
            )
    if config.strategy.sample_orders_enabled and mode == "live":
        raise SafetyError("sample orders are paper-only")
    protection_mode = config.synthetic_stops.mode
    protection_enabled = config.synthetic_stops.enabled
    if protection_enabled != (protection_mode != "disabled"):
        raise SafetyError(
            "synthetic-stop enabled state and explicit disabled/observe/live mode disagree"
        )
    if protection_enabled:
        if mode != "live":
            raise SafetyError(
                "synthetic-stop observation or transmission requires "
                "TRADING_MODE=live and all live account gates"
            )
        if not (config.ibkr.required or config.trading.require_ibkr_credentials):
            raise SafetyError("synthetic stops require the IBKR Gateway")
        if not config.ibkr.account_id.strip():
            raise SafetyError("synthetic stops require an explicit IBKR account ID")
        if config.ibkr.client_id <= 0:
            raise SafetyError(
                "synthetic stops require the primary IBKR client ID to be nonzero"
            )
        if protection_mode == "live":
            if not config.risk.orders_enabled:
                raise SafetyError(
                    "live synthetic stops require risk.orders_enabled=true"
                )
            if config.risk.dry_run:
                raise SafetyError(
                    "live synthetic stops cannot run with risk.dry_run=true"
                )
        if config.synthetic_stops.plan_schema == "auto":
            if config.synthetic_stops.client_id == config.ibkr.client_id:
                raise SafetyError(
                    "protection and primary IBKR client IDs must be distinct"
                )
        else:
            _validate_resolved_synthetic_stop_runtime(
                config,
                config.synthetic_stops.plan_schema,
            )


def _parse_config(data: dict[str, Any], *, enforce_safe: bool = True) -> AppConfig:
    try:
        config = AppConfig.model_validate(data)
    except ValidationError as exc:
        raise SafetyError(f"invalid Nautilus config: {exc}") from exc
    if enforce_safe:
        _validate_safe_model(config)
    return config


def _config_data(config: AppConfig | dict[str, Any]) -> dict[str, Any]:
    if isinstance(config, AppConfig):
        return config.model_dump(mode="python", by_alias=True)
    if isinstance(config, dict):
        return copy.deepcopy(config)
    raise SafetyError("config must be an AppConfig or mapping")


def load_config(path: str | Path) -> AppConfig:
    with Path(path).open("r", encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle) or {}
    if not isinstance(loaded, dict):
        raise SafetyError("config root must be a mapping")
    synthetic_stops = loaded.get("synthetic_stops")
    if isinstance(synthetic_stops, dict) and {
        "approval_hmac_key",
        "state_hmac_key",
        "reviewer_public_key",
        "reviewer_key_id",
    }.intersection(synthetic_stops):
        raise SafetyError(
            "staged protection approval, state, and reviewer trust values must be "
            "supplied through environment variables, never persisted in config files"
        )
    return _parse_config(loaded)


def _section(config: dict[str, Any], key: str) -> dict[str, Any]:
    value = config.setdefault(key, {})
    if not isinstance(value, dict):
        raise SafetyError(f"config section {key!r} must be a mapping")
    return value


def _populate_postgres_url(
    postgres_config: dict[str, Any], env: dict[str, str]
) -> None:
    if postgres_config.get("url"):
        return
    password = env.get(str(postgres_config.get("password_env", "POSTGRES_PASSWORD")))
    if not password:
        return
    user = str(postgres_config.get("user", ""))
    host = str(postgres_config.get("host", ""))
    port = int(postgres_config.get("port", 5432))
    database = str(postgres_config.get("database", ""))
    if user and host and database:
        postgres_config["url"] = (
            f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
            f"@{host}:{port}/{quote(database, safe='')}"
        )


def apply_env_overrides(
    config: AppConfig | dict[str, Any],
    env: dict[str, str] | None = None,
) -> AppConfig:
    env = os.environ if env is None else env
    config = _config_data(config)

    trading = _section(config, "trading")
    runner = _section(config, "runner")
    redis_config = _section(config, "redis")
    postgres_config = _section(config, "postgres")
    risk_config = _section(config, "risk")
    ibkr_config = _section(config, "ibkr")
    strategy_config = _section(config, "strategy")
    synthetic_stops_config = _section(config, "synthetic_stops")

    if env.get("TRADING_MODE"):
        trading["mode"] = env["TRADING_MODE"]
    if env.get("ENABLE_LIVE_TRADING") is not None:
        trading["enable_live_trading"] = parse_bool(env["ENABLE_LIVE_TRADING"])
    if env.get("LIVE_TRADING_ACCOUNT_ALLOWLIST") is not None:
        trading["account_allowlist"] = parse_account_allowlist(
            env["LIVE_TRADING_ACCOUNT_ALLOWLIST"]
        )
    if env.get("I_UNDERSTAND_LIVE_TRADING_RISK") is not None:
        trading["live_risk_acknowledged"] = parse_bool(
            env["I_UNDERSTAND_LIVE_TRADING_RISK"]
        )
    if env.get("NAUTILUS_LOG_DIR"):
        runner["log_dir"] = env["NAUTILUS_LOG_DIR"]
    if env.get("NAUTILUS_HEALTH_FILE"):
        runner["health_file"] = env["NAUTILUS_HEALTH_FILE"]
    if env.get("NAUTILUS_HEALTH_HOST"):
        runner["health_host"] = env["NAUTILUS_HEALTH_HOST"]
    if env.get("NAUTILUS_HEALTH_PORT"):
        runner["health_port"] = int(env["NAUTILUS_HEALTH_PORT"])
    if env.get("KILL_SWITCH_PATH"):
        runner["kill_switch_path"] = env["KILL_SWITCH_PATH"]
    if env.get("REDIS_HOST"):
        redis_config["host"] = env["REDIS_HOST"]
    if env.get("REDIS_PORT"):
        redis_config["port"] = int(env["REDIS_PORT"])
    if env.get("REDIS_DB"):
        redis_config["db"] = int(env["REDIS_DB"])
    if env.get("REDIS_URL"):
        redis_config["url"] = env["REDIS_URL"]
    if env.get("POSTGRES_HOST"):
        postgres_config["host"] = env["POSTGRES_HOST"]
    if env.get("POSTGRES_PORT"):
        postgres_config["port"] = int(env["POSTGRES_PORT"])
    if env.get("POSTGRES_DB") or env.get("POSTGRES_DATABASE"):
        postgres_config["database"] = env.get(
            "POSTGRES_DB", env.get("POSTGRES_DATABASE", "")
        )
    if env.get("POSTGRES_USER"):
        postgres_config["user"] = env["POSTGRES_USER"]
    if env.get("POSTGRES_URL"):
        postgres_config["url"] = env["POSTGRES_URL"]
    else:
        _populate_postgres_url(postgres_config, env)
    if env.get("NAUTILUS_RISK_ORDERS_ENABLED") is not None:
        risk_config["orders_enabled"] = parse_bool(env["NAUTILUS_RISK_ORDERS_ENABLED"])
    if env.get("NAUTILUS_RISK_DRY_RUN") is not None:
        risk_config["dry_run"] = parse_bool(env["NAUTILUS_RISK_DRY_RUN"])
    if env.get("NAUTILUS_RISK_MAX_ORDER_QUANTITY"):
        risk_config["max_order_quantity"] = parse_float(
            env["NAUTILUS_RISK_MAX_ORDER_QUANTITY"]
        )
    if env.get("NAUTILUS_RISK_MAX_POSITION_NOTIONAL_USD"):
        risk_config["max_position_notional_usd"] = parse_float(
            env["NAUTILUS_RISK_MAX_POSITION_NOTIONAL_USD"]
        )
    if env.get("NAUTILUS_RISK_MAX_DAILY_LOSS_USD"):
        risk_config["max_daily_loss_usd"] = parse_float(
            env["NAUTILUS_RISK_MAX_DAILY_LOSS_USD"]
        )
    if env.get("NAUTILUS_RISK_ALLOWED_INSTRUMENTS"):
        risk_config["allowed_instruments"] = parse_watchlist(
            env["NAUTILUS_RISK_ALLOWED_INSTRUMENTS"]
        )
    if env.get("NAUTILUS_RISK_MAX_ORDER_PREMIUM_USD"):
        risk_config["max_order_premium_usd"] = parse_float(
            env["NAUTILUS_RISK_MAX_ORDER_PREMIUM_USD"]
        )
    if env.get("RISK_DENIED_INSTRUMENTS"):
        risk_config["denied_instruments"] = parse_watchlist(
            env["RISK_DENIED_INSTRUMENTS"]
        )
    if env.get("NAUTILUS_RISK_MARKET_HOURS_ONLY") is not None:
        risk_config["market_hours_only"] = parse_bool(
            env["NAUTILUS_RISK_MARKET_HOURS_ONLY"]
        )
    gateway_required = env.get("IB_GATEWAY_REQUIRED")
    gateway_enabled = env.get("IBKR_GATEWAY_ENABLED")
    if gateway_required is not None or gateway_enabled is not None:
        ibkr_config["required"] = parse_bool(gateway_required) or parse_bool(
            gateway_enabled
        )
    if env.get("IB_GATEWAY_HOST") or env.get("IBKR_HOST"):
        ibkr_config["host"] = env.get(
            "IB_GATEWAY_HOST", env.get("IBKR_HOST", "ib-gateway")
        )
    if env.get("IB_GATEWAY_PORT") or env.get("IBKR_PORT"):
        ibkr_config["port"] = int(
            env.get("IB_GATEWAY_PORT", env.get("IBKR_PORT", 4004))
        )
    if env.get("IBKR_CLIENT_ID"):
        ibkr_config["client_id"] = int(env["IBKR_CLIENT_ID"])
    if env.get("IBKR_ACCOUNT_ID"):
        ibkr_config["account_id"] = env["IBKR_ACCOUNT_ID"]
    if env.get("NAUTILUS_WATCHLIST"):
        strategy_config["watchlist"] = parse_watchlist(env["NAUTILUS_WATCHLIST"])
    if env.get("NAUTILUS_SAMPLE_ORDERS_ENABLED") is not None:
        sample_orders_enabled = parse_bool(env["NAUTILUS_SAMPLE_ORDERS_ENABLED"])
        strategy_config["sample_orders_enabled"] = sample_orders_enabled
        if sample_orders_enabled:
            strategy_config["observation_only"] = False
    if env.get("SYNTHETIC_STOPS_ENABLED") is not None:
        synthetic_stops_config["enabled"] = parse_bool(env["SYNTHETIC_STOPS_ENABLED"])
    if env.get("SYNTHETIC_STOP_MODE"):
        synthetic_stops_config["mode"] = env["SYNTHETIC_STOP_MODE"].strip().lower()
    if env.get("SYNTHETIC_STOP_PLAN_PATH"):
        synthetic_stops_config["plan_path"] = env["SYNTHETIC_STOP_PLAN_PATH"]
    if env.get("SYNTHETIC_STOP_PLAN_SCHEMA"):
        synthetic_stops_config["plan_schema"] = env["SYNTHETIC_STOP_PLAN_SCHEMA"]
    if env.get("SYNTHETIC_STOP_APPROVAL_HMAC_KEY") is not None:
        synthetic_stops_config["approval_hmac_key"] = env[
            "SYNTHETIC_STOP_APPROVAL_HMAC_KEY"
        ]
    if env.get("SYNTHETIC_STOP_REVIEWER_PUBLIC_KEY") is not None:
        synthetic_stops_config["reviewer_public_key"] = env[
            "SYNTHETIC_STOP_REVIEWER_PUBLIC_KEY"
        ]
    if env.get("SYNTHETIC_STOP_REVIEWER_KEY_ID") is not None:
        synthetic_stops_config["reviewer_key_id"] = env[
            "SYNTHETIC_STOP_REVIEWER_KEY_ID"
        ]
    if env.get("SYNTHETIC_STOP_STATE_HMAC_KEY") is not None:
        synthetic_stops_config["state_hmac_key"] = env["SYNTHETIC_STOP_STATE_HMAC_KEY"]
    if env.get("SYNTHETIC_STOP_ATR_MULTIPLIER"):
        synthetic_stops_config["stop_atr_multiplier"] = parse_float(
            env["SYNTHETIC_STOP_ATR_MULTIPLIER"]
        )
    if env.get("SYNTHETIC_STOP_ROUND_HANDLE_BUFFER_ATR"):
        synthetic_stops_config["round_handle_buffer_atr"] = parse_float(
            env["SYNTHETIC_STOP_ROUND_HANDLE_BUFFER_ATR"]
        )
    if env.get("SYNTHETIC_STOP_INITIAL_LIMIT_OFFSET_ATR"):
        synthetic_stops_config["initial_limit_offset_atr"] = parse_float(
            env["SYNTHETIC_STOP_INITIAL_LIMIT_OFFSET_ATR"]
        )
    if env.get("SYNTHETIC_STOP_REPRICE_INTERVAL_SECONDS"):
        synthetic_stops_config["reprice_interval_seconds"] = parse_float(
            env["SYNTHETIC_STOP_REPRICE_INTERVAL_SECONDS"]
        )
    if env.get("SYNTHETIC_STOP_MAXIMUM_EXECUTION_TIME_SECONDS"):
        synthetic_stops_config["maximum_execution_time_seconds"] = parse_float(
            env["SYNTHETIC_STOP_MAXIMUM_EXECUTION_TIME_SECONDS"]
        )
    if env.get("SYNTHETIC_STOP_MARKET_ESCALATION_ATR"):
        synthetic_stops_config["market_escalation_atr"] = parse_float(
            env["SYNTHETIC_STOP_MARKET_ESCALATION_ATR"]
        )
    if env.get("SYNTHETIC_STOP_FINAL_MARKET_ORDER_ENABLED") is not None:
        synthetic_stops_config["final_market_order_enabled"] = parse_bool(
            env["SYNTHETIC_STOP_FINAL_MARKET_ORDER_ENABLED"]
        )
    if env.get("SYNTHETIC_STOP_EXECUTION_HOURS"):
        synthetic_stops_config["execution_hours"] = (
            env["SYNTHETIC_STOP_EXECUTION_HOURS"].strip().lower()
        )
    if env.get("SYNTHETIC_STOP_PLAN_MAX_AGE_HOURS"):
        synthetic_stops_config["plan_max_age_hours"] = parse_float(
            env["SYNTHETIC_STOP_PLAN_MAX_AGE_HOURS"]
        )
    if env.get("SYNTHETIC_STOP_CLIENT_ID"):
        synthetic_stops_config["client_id"] = int(env["SYNTHETIC_STOP_CLIENT_ID"])
    if env.get("SYNTHETIC_STOP_MAX_ORDER_QUANTITY"):
        synthetic_stops_config["max_order_quantity"] = parse_float(
            env["SYNTHETIC_STOP_MAX_ORDER_QUANTITY"]
        )
    if env.get("SYNTHETIC_STOP_CONNECT_TIMEOUT_SECONDS"):
        synthetic_stops_config["connect_timeout_seconds"] = parse_float(
            env["SYNTHETIC_STOP_CONNECT_TIMEOUT_SECONDS"]
        )
    if env.get("SYNTHETIC_STOP_CANCEL_CONFIRMATION_TIMEOUT_SECONDS"):
        synthetic_stops_config["cancel_confirmation_timeout_seconds"] = parse_float(
            env["SYNTHETIC_STOP_CANCEL_CONFIRMATION_TIMEOUT_SECONDS"]
        )
    if env.get("SYNTHETIC_STOP_POLL_INTERVAL_SECONDS"):
        synthetic_stops_config["poll_interval_seconds"] = parse_float(
            env["SYNTHETIC_STOP_POLL_INTERVAL_SECONDS"]
        )
    if env.get("SYNTHETIC_STOP_QUOTE_MAX_AGE_SECONDS"):
        synthetic_stops_config["quote_max_age_seconds"] = parse_float(
            env["SYNTHETIC_STOP_QUOTE_MAX_AGE_SECONDS"]
        )

    return _parse_config(config)


def validate_safe_mode(config: AppConfig | dict[str, Any]) -> AppConfig:
    if isinstance(config, AppConfig):
        parsed = config
    else:
        trading = _section(copy.deepcopy(config), "trading")
        mode = str(trading.get("mode", "paper")).strip().lower()
        if mode not in {"paper", "live"}:
            raise SafetyError(f"unsafe trading mode refused: {mode}")
        parsed = _parse_config(config, enforce_safe=False)
    _validate_safe_model(parsed)
    return parsed


def kill_switch_active(path: str | Path) -> bool:
    return Path(path).exists()


def append_event(log_dir: Path, filename: str, event: dict[str, Any]) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / filename
    safe_event = sanitize_payload(event)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(safe_event, sort_keys=True, separators=(",", ":")) + "\n"
        )
    return path


@dataclass
class BackendStatus:
    ok: bool = False
    detail: str = "not_connected"
    checked_at: str | None = None

    def mark(self, ok: bool, detail: str) -> None:
        self.ok = ok
        self.detail = detail[:240]
        self.checked_at = utc_now()

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "detail": self.detail, "checked_at": self.checked_at}


@dataclass
class RuntimeState:
    service: str
    trading_mode: str
    started_at: str = field(default_factory=utc_now)
    safe_mode: bool = True
    ibkr_required: bool = False
    redis: BackendStatus = field(default_factory=BackendStatus)
    postgres: BackendStatus = field(default_factory=BackendStatus)
    ibkr: BackendStatus = field(default_factory=BackendStatus)
    last_heartbeat_at: str | None = None
    synthetic_stops_required: bool = False
    synthetic_stops_armed: bool = False
    synthetic_stops_detail: str = "disabled"


def arm_health_block() -> dict[str, Any]:
    """Owner arm state for /health. Disarmed is a normal, healthy state."""

    status = arm_gate.current_status().as_dict()
    status.pop("record", None)
    return status


def build_health_payload(
    state: RuntimeState, kill_switch_path: str | Path
) -> tuple[dict[str, Any], int]:
    blocked = kill_switch_active(kill_switch_path)
    degraded = (
        not state.redis.ok
        or not state.postgres.ok
        or (state.ibkr_required and not state.ibkr.ok)
        or (state.synthetic_stops_required and not state.synthetic_stops_armed)
    )
    if blocked:
        status, status_code = "blocked", 503
    elif degraded:
        status, status_code = "degraded", 503
    else:
        status, status_code = "ok", 200

    return (
        {
            "status": status,
            "service": state.service,
            "synthetic_stops": {
                "required": state.synthetic_stops_required,
                "armed": state.synthetic_stops_armed,
                "detail": state.synthetic_stops_detail,
            },
            "trading_mode": state.trading_mode,
            "safe_mode": state.safe_mode,
            "kill_switch_active": blocked,
            "arm": arm_health_block(),
            "started_at": state.started_at,
            "last_heartbeat_at": state.last_heartbeat_at,
            "redis": state.redis.as_dict(),
            "postgres": state.postgres.as_dict(),
            "ibkr": state.ibkr.as_dict(),
        },
        status_code,
    )


def make_health_handler(
    state: RuntimeState, kill_switch_path: Path
) -> type[BaseHTTPRequestHandler]:
    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path not in {"/health", "/ready"}:
                self.send_response(404)
                self.end_headers()
                return

            payload, status_code = build_health_payload(state, kill_switch_path)
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return HealthHandler


def _safe_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise SafetyError(f"unsafe SQL identifier refused: {value!r}")
    return value


def sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized = {}
        for key, nested in value.items():
            if SENSITIVE_KEY_RE.search(str(key)):
                sanitized[key] = "[REDACTED]"
            else:
                sanitized[key] = sanitize_payload(nested)
        return sanitized
    if isinstance(value, list):
        return [sanitize_payload(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_payload(item) for item in value]
    if isinstance(value, str):
        redacted = URL_CREDENTIAL_RE.sub(r"\1[REDACTED]@", value)
        return SECRET_ASSIGNMENT_RE.sub(
            lambda match: f"{match.group(1)}[REDACTED]", redacted
        )
    return value


def event_table_category(event_type: str) -> str:
    if event_type.startswith("strategy_"):
        return "strategy"
    if event_type.startswith(("order_", "sample_order_")):
        return "order"
    if event_type.startswith("execution_"):
        return "execution"
    if event_type.startswith("risk_"):
        return "risk"
    return "health"


class RedisHeartbeatStore:
    def __init__(
        self,
        url: str,
        key: str,
        ttl_seconds: int,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.url = url
        self.key = key
        self.ttl_seconds = ttl_seconds
        self.client_factory = client_factory
        self.client: Any = None

    def connect(self) -> None:
        if self.client is not None:
            self.client.ping()
            return
        if self.client_factory is not None:
            self.client = self.client_factory()
            self.client.ping()
            return

        import redis

        self.client = redis.from_url(
            self.url,
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
        )
        self.client.ping()

    def write(self, event: dict[str, Any]) -> None:
        if self.client is None:
            self.connect()
        payload = sanitize_payload(event)
        self.client.set(
            self.key, json.dumps(payload, sort_keys=True), ex=self.ttl_seconds
        )
        if hasattr(self.client, "hset"):
            self.client.hset(
                f"{self.key}:state",
                mapping={
                    "last_event": str(payload.get("event", "unknown")),
                    "last_timestamp": str(payload.get("timestamp", "")),
                    "service": str(payload.get("service", "")),
                    "trading_mode": str(payload.get("trading_mode", "")),
                },
            )


class PostgresEventStore:
    def __init__(
        self,
        url: str,
        table: str,
        event_tables: dict[str, str] | None = None,
        connection_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.url = url
        self.table = _safe_identifier(table)
        configured_tables = DEFAULT_EVENT_TABLES.copy()
        configured_tables.update(event_tables or {})
        self.event_tables = {
            category: _safe_identifier(table_name)
            for category, table_name in configured_tables.items()
        }
        if self.table not in self.event_tables.values():
            self.event_tables["default"] = self.table
        self.connection_factory = connection_factory
        self.connection: Any = None

    def _connection_closed(self) -> bool:
        return bool(getattr(self.connection, "closed", False))

    def connect(self, force: bool = False) -> None:
        if self.connection is not None and not force and not self._connection_closed():
            return
        self.connection = None
        if self.connection_factory is not None:
            self.connection = self.connection_factory()
        else:
            import psycopg

            self.connection = psycopg.connect(
                self.url, connect_timeout=3, autocommit=True
            )
        with self.connection.cursor() as cursor:
            cursor.execute("SET statement_timeout = '3s'")
            cursor.execute("SET lock_timeout = '3s'")
            for table_name in sorted(set(self.event_tables.values())):
                cursor.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {table_name} (
                        id BIGSERIAL PRIMARY KEY,
                        event_time TIMESTAMPTZ NOT NULL,
                        mode TEXT NOT NULL,
                        service_name TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        payload JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )

    def _write_event(
        self, table_name: str, event_type: str, payload: dict[str, Any]
    ) -> None:
        if self.connection is None:
            self.connect()
        with self.connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO {table_name} (event_time, mode, service_name, event_type, payload)
                VALUES (%s::timestamptz, %s, %s, %s, %s::jsonb)
                """,
                (
                    str(payload.get("timestamp") or utc_now()),
                    str(payload.get("trading_mode", "paper")),
                    str(payload.get("service", "nautilus-trader")),
                    event_type,
                    json.dumps(payload, sort_keys=True),
                ),
            )

    def write(self, event: dict[str, Any]) -> None:
        if self.connection is None or self._connection_closed():
            self.connect()
        event_type = str(event.get("event", "unknown"))
        category = event_table_category(event_type)
        table_name = self.event_tables.get(
            category, self.event_tables.get("default", self.table)
        )
        payload = sanitize_payload(event)
        try:
            self._write_event(table_name, event_type, payload)
        except Exception:
            if not self._connection_closed():
                raise
            self.connect(force=True)
            self._write_event(table_name, event_type, payload)


class IbkrTwsGatewayAdapter:
    def __init__(
        self,
        config: AppConfig,
        emit_event: Callable[[dict[str, Any]], None],
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.config = validate_safe_mode(config)
        self.emit_event = emit_event
        self.client_factory = client_factory or self._default_client
        self.client: Any = None
        self.thread: threading.Thread | None = None

    @property
    def required(self) -> bool:
        return self.config.ibkr.required or self.config.trading.require_ibkr_credentials

    def _event(self, event: str, **extra: Any) -> None:
        payload = {
            "event": event,
            "adapter": self.config.ibkr.adapter,
            "host": self.config.ibkr.host,
            "port": self.config.ibkr.port,
            "client_id": self.config.ibkr.client_id,
            "account_id_configured": bool(self.config.ibkr.account_id),
            "timestamp": utc_now(),
        }
        payload.update(extra)
        self.emit_event(payload)

    def _default_client(self) -> Any:
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        class TwsApiClient(EWrapper, EClient):
            def __init__(self) -> None:
                EWrapper.__init__(self)
                EClient.__init__(self, wrapper=self)

        return TwsApiClient()

    def connect(self) -> tuple[bool, str]:
        if not self.required:
            self._event("ibkr_adapter_skipped", reason="gateway_not_required")
            return True, "gateway_not_required"

        self._event("ibkr_adapter_connect_started")
        try:
            self.client = self.client_factory()
            connected = self.client.connect(
                self.config.ibkr.host,
                self.config.ibkr.port,
                self.config.ibkr.client_id,
            )
            if connected is False:
                raise RuntimeError("ibapi connect returned false")
            self.thread = threading.Thread(
                target=self.client.run, name="ibkr-tws-api", daemon=True
            )
            self.thread.start()
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            detail = f"{type(exc).__name__}: {exc}"
            self._event("ibkr_adapter_connect_failed", detail=detail)
            return False, detail

        self._event("ibkr_adapter_connected")
        return True, "connected"

    def is_connected(self) -> bool:
        if not self.required:
            return False
        if self.client is None:
            return False
        probe = getattr(self.client, "isConnected", None)
        if not callable(probe):
            return False
        return bool(probe())

    def disconnect(self) -> None:
        client = self.client
        thread = self.thread
        self.client = None
        self.thread = None
        if client is None:
            return
        try:
            if hasattr(client, "isConnected") and not client.isConnected():
                return
            client.disconnect()
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            self._event(
                "ibkr_adapter_disconnect_failed", detail=f"{type(exc).__name__}: {exc}"
            )
            return
        finally:
            if (
                thread is not None
                and thread is not threading.current_thread()
                and thread.is_alive()
            ):
                thread.join(timeout=1.0)
        self._event("ibkr_adapter_disconnected")


class PrototypeRunner:
    def __init__(
        self,
        config: AppConfig | dict[str, Any],
        redis_store: Any | None = None,
        postgres_store: Any | None = None,
        ibkr_adapter: Any | None = None,
        synthetic_stop_daemon: Any | None = None,
    ) -> None:
        config = validate_safe_mode(config)
        self.config = config
        self.log_dir = Path(config.runner.log_dir)
        self.health_file = Path(config.runner.health_file)
        self.event_log_file = config.runner.event_log_file
        self.kill_switch_path = Path(config.runner.kill_switch_path)
        self.heartbeat_interval = config.runner.heartbeat_interval_seconds
        self.health_host = config.runner.health_host
        self.health_port = config.runner.health_port
        self.state = RuntimeState(
            service="nautilus-trader",
            trading_mode=config.trading.mode,
            ibkr_required=config.ibkr.required
            or config.trading.require_ibkr_credentials,
            synthetic_stops_required=config.synthetic_stops.enabled,
            synthetic_stops_detail=(
                "starting" if config.synthetic_stops.enabled else "disabled"
            ),
        )
        self.log_lock = threading.Lock()
        self.health_lock = threading.Lock()
        self.postgres_lock = threading.Lock()
        self.risk_limits = RiskLimits(
            orders_enabled=config.risk.orders_enabled,
            dry_run=config.risk.dry_run,
            max_order_quantity=config.risk.max_order_quantity,
            max_position_notional_usd=config.risk.max_position_notional_usd,
            max_daily_loss_usd=config.risk.max_daily_loss_usd,
            max_order_premium_usd=config.risk.max_order_premium_usd,
            allowed_instruments=tuple(config.risk.allowed_instruments),
            denied_instruments=normalize_instruments(config.risk.denied_instruments),
            market_hours_only=config.risk.market_hours_only,
            market_open=config.risk.market_open,
            market_close=config.risk.market_close,
            market_timezone=config.risk.market_timezone,
        ).with_default_allowed(config.strategy.watchlist)
        self.strategy = SafeExampleStrategy(
            self.kill_switch_path,
            watchlist=config.strategy.watchlist,
            observation_only=config.strategy.observation_only,
            sample_orders_enabled=config.strategy.sample_orders_enabled,
            trading_mode=config.trading.mode,
            enable_live_trading=config.trading.enable_live_trading,
            account_id=config.ibkr.account_id,
            account_allowlist=config.trading.account_allowlist,
            live_risk_acknowledged=config.trading.live_risk_acknowledged,
            risk_limits=self.risk_limits,
        )
        self.redis_store = redis_store or RedisHeartbeatStore(
            config.redis.url,
            config.redis.heartbeat_key,
            max(10, self.heartbeat_interval * 3),
        )
        self.postgres_store = postgres_store or PostgresEventStore(
            config.postgres.url,
            config.postgres.events_table,
            config.postgres.event_tables,
        )
        self.ibkr_adapter = ibkr_adapter or IbkrTwsGatewayAdapter(
            config, self.log_event
        )
        self.ibkr_reconnect_last_attempt_at: float | None = None
        self.synthetic_stop_daemon = synthetic_stop_daemon
        self.last_arm_state: dict[str, Any] | None = None
        if (
            self.synthetic_stop_daemon is None
            and config.synthetic_stops.enabled
            and not arm_gate.current_status().armed
        ):
            # Protection daemons place and cancel orders. While disarmed they do
            # not start; arm the node, then restart it to start them.
            self.state.synthetic_stops_required = False
            self.state.synthetic_stops_detail = "disarmed"
        elif self.synthetic_stop_daemon is None and config.synthetic_stops.enabled:
            self.synthetic_stop_daemon = self.build_synthetic_stop_daemon()

    def build_synthetic_stop_daemon(
        self,
    ) -> SyntheticStopDaemon | StagedProtectionDaemon:
        settings = self.config.synthetic_stops
        plan_path = Path(settings.plan_path)
        plan_schema = settings.plan_schema
        if plan_schema == "auto":
            raise SafetyError(
                "enabled protection requires explicit "
                "staged-protection-plan/v1 or synthetic-stop-plan/v1; "
                "automatic plan schema selection is refused"
            )
        if plan_schema != "staged-protection-plan/v1":
            raise SafetyError(
                "legacy synthetic-stop-plan/v1 monitoring is disabled; "
                "completed realtime-bar staged protection is required"
            )
        staged_hmac_keys = _validate_resolved_synthetic_stop_runtime(
            self.config,
            plan_schema,
        )
        broker = IbkrStagedProtectionBroker(
            host=self.config.ibkr.host,
            port=self.config.ibkr.port,
            client_id=settings.client_id,
            account_id=self.config.ibkr.account_id,
            account_fingerprint_key=os.environ.get(
                "SYNTHETIC_STOP_ACCOUNT_FINGERPRINT_KEY",
                "",
            ),
            execution_hours=settings.execution_hours,
            allowed_instruments=self.config.risk.allowed_instruments,
            denied_instruments=self.config.risk.denied_instruments,
            max_order_quantity=settings.max_order_quantity,
            connect_timeout_seconds=settings.connect_timeout_seconds,
            cancel_confirmation_timeout_seconds=settings.cancel_confirmation_timeout_seconds,
            quote_max_age_seconds=settings.quote_max_age_seconds,
            order_transmission_enabled=settings.mode == "live",
        )
        execution_config = AdaptiveExecutionConfig(
            initial_limit_offset_atr=settings.initial_limit_offset_atr,
            reprice_interval_seconds=settings.reprice_interval_seconds,
            maximum_execution_time_seconds=settings.maximum_execution_time_seconds,
            market_escalation_atr=settings.market_escalation_atr,
            final_market_order_enabled=settings.final_market_order_enabled,
        )
        daemon_kwargs = {
            "plan_path": settings.plan_path,
            "broker": broker,
            "execution_config": execution_config,
            "execution_hours": settings.execution_hours,
            "plan_max_age_hours": settings.plan_max_age_hours,
            "poll_interval_seconds": settings.poll_interval_seconds,
            "quote_max_age_seconds": settings.quote_max_age_seconds,
            "emit_event": self.log_event,
            "kill_switch_active": lambda: kill_switch_active(self.kill_switch_path),
            "observe_only": settings.mode == "observe",
        }
        data_root = (
            plan_path.parent.parent.parent
            if plan_path.parent.parent.name == "reports"
            else plan_path.parent.parent
        )
        state_name = (
            "staged-protection-observe-state.json"
            if settings.mode == "observe"
            else "staged-protection-state.json"
        )
        return StagedProtectionDaemon(
            **daemon_kwargs,
            state_path=data_root / "state" / state_name,
            approval_hmac_key=staged_hmac_keys[0],
            reviewer_public_key=staged_hmac_keys[2],
            reviewer_key_id=staged_hmac_keys[3],
            state_hmac_key=staged_hmac_keys[1],
        )

    def enrich_event(self, event: dict[str, Any]) -> dict[str, Any]:
        enriched = copy.deepcopy(event)
        enriched.setdefault("timestamp", utc_now())
        enriched.setdefault("service", self.state.service)
        enriched.setdefault("trading_mode", self.state.trading_mode)
        return enriched

    def log_event(self, event: dict[str, Any], *, write_postgres: bool = True) -> Path:
        enriched = sanitize_payload(self.enrich_event(event))
        with self.log_lock:
            path = append_event(self.log_dir, self.event_log_file, enriched)
        if not write_postgres:
            return path
        try:
            with self.postgres_lock:
                self.postgres_store.write(enriched)
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            self.state.postgres.mark(False, f"{type(exc).__name__}: {exc}")
            with self.log_lock:
                append_event(
                    self.log_dir,
                    self.event_log_file,
                    {
                        "event": "backend_write_failed",
                        "backend": "postgres",
                        "timestamp": utc_now(),
                        "service": self.state.service,
                        "trading_mode": self.state.trading_mode,
                        "detail": self.state.postgres.detail,
                    },
                )
        else:
            self.state.postgres.mark(True, "connected")
        return path

    def log_order_event(self, event: dict[str, Any]) -> Path:
        risk_event = event.get("risk_event")
        if isinstance(risk_event, dict):
            self.log_event(risk_event)
        order_event = copy.deepcopy(event)
        order_event.pop("risk_event", None)
        return self.log_event(order_event)

    def submit_order_intent(self, order_intent: dict[str, Any]) -> dict[str, Any]:
        event = self.strategy.maybe_submit_order(order_intent)
        self.log_order_event(event)
        return event

    def _reset_ibkr_adapter_before_reconnect(self) -> None:
        for method_name in ("reset", "disconnect"):
            method = getattr(self.ibkr_adapter, method_name, None)
            if not callable(method):
                continue
            try:
                method()
            except (
                Exception
            ) as exc:  # pragma: no cover - exercised by integration runtime
                self.state.ibkr.mark(False, f"{type(exc).__name__}: {exc}")
            return

    def _reconnect_ibkr_after_disconnect(self) -> None:
        connect = getattr(self.ibkr_adapter, "connect", None)
        if not callable(connect) or not self.state.ibkr_required:
            return
        now = time.time()
        if (
            self.ibkr_reconnect_last_attempt_at is not None
            and now - self.ibkr_reconnect_last_attempt_at
            < float(self.heartbeat_interval)
        ):
            return
        self.ibkr_reconnect_last_attempt_at = now
        self._reset_ibkr_adapter_before_reconnect()
        ok, detail = connect()
        self.state.ibkr.mark(ok, detail)

    def refresh_ibkr_connection_state(self) -> None:
        is_connected = getattr(self.ibkr_adapter, "is_connected", None)
        if not callable(is_connected):
            return
        try:
            ibkr_connected = bool(is_connected())
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            if self.state.ibkr.ok:
                self.state.ibkr.mark(False, f"{type(exc).__name__}: {exc}")
            self._reconnect_ibkr_after_disconnect()
            return
        state_connected = self.state.ibkr.ok and self.state.ibkr.detail == "connected"
        if ibkr_connected:
            if not state_connected:
                self.state.ibkr.mark(True, "connected")
            return
        if state_connected:
            self.state.ibkr.mark(False, "disconnected")
        self._reconnect_ibkr_after_disconnect()

    def connect_backends(self) -> None:
        for label, status, store in (
            ("redis", self.state.redis, self.redis_store),
            ("postgres", self.state.postgres, self.postgres_store),
        ):
            try:
                store.connect()
            except (
                Exception
            ) as exc:  # pragma: no cover - exercised by integration runtime
                status.mark(False, f"{type(exc).__name__}: {exc}")
                self.log_event(
                    {
                        "event": "backend_connect_failed",
                        "backend": label,
                        "timestamp": utc_now(),
                        "detail": status.detail,
                    },
                    write_postgres=False,
                )
            else:
                status.mark(True, "connected")

    def connect_ibkr(self) -> None:
        ok, detail = self.ibkr_adapter.connect()
        self.state.ibkr.mark(ok, detail)
        ib_data_available = ok and detail == "connected"
        for event in self.strategy.on_start(ib_data_available=ib_data_available):
            event.update(
                {"service": self.state.service, "trading_mode": self.state.trading_mode}
            )
            self.log_event(event)

    def write_health_file(self, *, log_snapshot: bool = True) -> Path:
        payload, _status_code = build_health_payload(self.state, self.kill_switch_path)
        self.health_file.parent.mkdir(parents=True, exist_ok=True)
        body = json.dumps(payload, sort_keys=True) + "\n"
        tmp_path = self.health_file.with_name(f".{self.health_file.name}.tmp")
        with self.health_lock:
            tmp_path.write_text(body, encoding="utf-8")
            tmp_path.replace(self.health_file)
        if log_snapshot:
            self.log_event({"event": "health_snapshot", "payload": payload})
        return self.health_file

    def record_arm_state(self) -> dict[str, Any]:
        """Log one event (file + Postgres) each time the arm state changes."""

        current = arm_health_block()
        key = {k: current.get(k) for k in ("armed", "detail", "image_version", "armed_at")}
        previous = self.last_arm_state
        if previous != key:
            self.last_arm_state = key
            self.log_event(
                {
                    "event": "arm_state_observed" if previous is None else "arm_state_changed",
                    "service": self.state.service,
                    "timestamp": utc_now(),
                    "arm": current,
                    "previous": previous,
                }
            )
        return current

    def emit_heartbeat(self) -> None:
        try:
            self.record_arm_state()
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            self.log_event(
                {
                    "event": "arm_state_log_failed",
                    "timestamp": utc_now(),
                    "detail": f"{type(exc).__name__}: {exc}",
                },
                write_postgres=False,
            )
        event = self.strategy.heartbeat()
        event = self.enrich_event(event)
        self.state.last_heartbeat_at = event["timestamp"]
        self.write_health_file(log_snapshot=False)
        self.log_event(event, write_postgres=False)

        try:
            self.redis_store.write(event)
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            self.state.redis.mark(False, f"{type(exc).__name__}: {exc}")
            self.log_event(
                {
                    "event": "backend_write_failed",
                    "backend": "redis",
                    "timestamp": utc_now(),
                    "detail": self.state.redis.detail,
                },
                write_postgres=False,
            )
        else:
            self.state.redis.mark(True, "connected")
        self.write_health_file(log_snapshot=False)

    def log_heartbeat_failure(self, exc: Exception) -> None:
        try:
            self.log_event(
                {
                    "event": "heartbeat_failed",
                    "timestamp": utc_now(),
                    "detail": f"{type(exc).__name__}: {exc}",
                },
                write_postgres=False,
            )
        except (
            Exception
        ):  # pragma: no cover - last-resort logging must not kill the runner
            return

    def emit_heartbeat_safely(self) -> None:
        try:
            self.emit_heartbeat()
        except Exception as exc:  # pragma: no cover - exercised by integration runtime
            self.log_heartbeat_failure(exc)

    def start_heartbeat_thread(self) -> tuple[threading.Event, threading.Thread]:
        heartbeat_stop = threading.Event()
        self.emit_heartbeat_safely()

        def heartbeat_loop() -> None:
            while not heartbeat_stop.wait(self.heartbeat_interval):
                self.emit_heartbeat_safely()

        thread = threading.Thread(
            target=heartbeat_loop, name="nautilus-heartbeat", daemon=True
        )
        thread.start()
        return heartbeat_stop, thread

    def synthetic_stop_shutdown_timeout(self) -> float:
        settings = self.config.synthetic_stops
        return (
            settings.maximum_execution_time_seconds
            + 2 * settings.connect_timeout_seconds
            + 2 * settings.cancel_confirmation_timeout_seconds
            + 2.0
        )

    def activate_synthetic_stop_kill_switch(self, reason: str) -> None:
        self.state.synthetic_stops_armed = False
        self.state.synthetic_stops_detail = reason[:240]
        self.kill_switch_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.kill_switch_path.exists():
            temporary = self.kill_switch_path.with_name(
                f".{self.kill_switch_path.name}.synthetic-stop-watchdog.tmp"
            )
            temporary.write_text(
                json.dumps(
                    {
                        "reason": reason,
                        "source": "synthetic-stop-watchdog",
                        "timestamp": utc_now(),
                    },
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            temporary.replace(self.kill_switch_path)
        try:
            self.log_event(
                {
                    "event": "synthetic_stop_watchdog_failed",
                    "timestamp": utc_now(),
                    "detail": reason,
                    "kill_switch_path": str(self.kill_switch_path),
                },
                write_postgres=False,
            )
            self.write_health_file(log_snapshot=False)
        except Exception:
            pass

    def start_synthetic_stop_watchdog(
        self,
        synthetic_stop_runtime: tuple[threading.Event, threading.Thread],
        runner_stop: threading.Event,
    ) -> tuple[threading.Event, threading.Thread, list[SafetyError]]:
        watchdog_stop = threading.Event()
        failures: list[SafetyError] = []
        daemon_thread = synthetic_stop_runtime[1]
        interval = min(self.config.synthetic_stops.poll_interval_seconds, 0.1)

        def watchdog_loop() -> None:
            while not watchdog_stop.wait(interval):
                if runner_stop.is_set():
                    return
                daemon_failure = getattr(
                    self.synthetic_stop_daemon,
                    "failure",
                    None,
                )
                if daemon_failure is not None:
                    failure = SafetyError(
                        "synthetic-stop daemon reported failure: "
                        f"{type(daemon_failure).__name__}: {daemon_failure}"
                    )
                elif not daemon_thread.is_alive():
                    failure = SafetyError("synthetic-stop daemon exited unexpectedly")
                elif (
                    self.state.synthetic_stops_required
                    and getattr(self.synthetic_stop_daemon, "armed", False) is not True
                ):
                    failure = SafetyError(
                        "synthetic-stop daemon lost armed state while its "
                        "thread remained alive"
                    )
                else:
                    continue
                if watchdog_stop.is_set() or runner_stop.is_set():
                    return
                try:
                    self.activate_synthetic_stop_kill_switch(str(failure))
                except Exception as exc:
                    failure = SafetyError(
                        f"{failure}; kill-switch activation failed: "
                        f"{type(exc).__name__}: {exc}"
                    )
                failures.append(failure)
                runner_stop.set()
                return

        thread = threading.Thread(
            target=watchdog_loop,
            name="synthetic-stop-watchdog",
            daemon=True,
        )
        thread.start()
        return watchdog_stop, thread, failures

    def start_synthetic_stop_thread(
        self,
    ) -> tuple[threading.Event, threading.Thread] | None:
        if self.synthetic_stop_daemon is None:
            if self.state.synthetic_stops_required:
                raise SafetyError("required synthetic-stop daemon is unavailable")
            return None
        daemon_stop = threading.Event()
        thread = threading.Thread(
            target=self.synthetic_stop_daemon.run,
            args=(daemon_stop,),
            name="synthetic-stop-daemon",
            daemon=False,
        )
        thread.start()
        wait_until_armed = getattr(self.synthetic_stop_daemon, "wait_until_armed", None)
        if callable(wait_until_armed):
            try:
                startup_timeout = (
                    self.config.synthetic_stops.connect_timeout_seconds * 3
                )
                readiness_timeout = getattr(
                    self.synthetic_stop_daemon,
                    "readiness_timeout_seconds",
                    None,
                )
                if callable(readiness_timeout):
                    startup_timeout = max(
                        startup_timeout,
                        float(readiness_timeout()) + 5.0,
                    )
                wait_until_armed(startup_timeout)
            except Exception as exc:
                self.state.synthetic_stops_armed = False
                self.state.synthetic_stops_detail = (
                    f"startup failed: {type(exc).__name__}: {exc}"
                )[:240]
                daemon_stop.set()
                thread.join(timeout=self.synthetic_stop_shutdown_timeout())
                if thread.is_alive():
                    cleanup_failure = SafetyError(
                        "synthetic-stop daemon did not stop after startup failure "
                        "within shutdown timeout"
                    )
                    try:
                        self.activate_synthetic_stop_kill_switch(str(cleanup_failure))
                    except Exception as cleanup_exc:
                        cleanup_failure = SafetyError(
                            f"{cleanup_failure}; kill-switch activation failed: "
                            f"{type(cleanup_exc).__name__}: {cleanup_exc}"
                        )
                    while thread.is_alive():
                        thread.join(timeout=1.0)
                    raise cleanup_failure from exc
                raise
        if not thread.is_alive():
            failure = SafetyError("synthetic-stop daemon exited before readiness")
            try:
                self.activate_synthetic_stop_kill_switch(str(failure))
            except Exception as exc:
                failure = SafetyError(
                    f"{failure}; kill-switch activation failed: "
                    f"{type(exc).__name__}: {exc}"
                )
            raise failure
        self.state.synthetic_stops_armed = True
        self.state.synthetic_stops_detail = "armed"
        return daemon_stop, thread

    def serve_health(self) -> ThreadingHTTPServer:
        server = ThreadingHTTPServer(
            (self.health_host, self.health_port),
            make_health_handler(self.state, self.kill_switch_path),
        )
        thread = threading.Thread(
            target=server.serve_forever, name="health-server", daemon=True
        )
        thread.start()
        return server

    def run(self, stop_event: threading.Event) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.log_event(
            {
                "event": "runner_started",
                "service": self.state.service,
                "timestamp": utc_now(),
                "trading_mode": self.state.trading_mode,
                "orders_enabled": self.config.risk.orders_enabled,
            },
            write_postgres=False,
        )
        cleanup_owned_orders = getattr(
            self.synthetic_stop_daemon,
            "cleanup_owned_orders_before_startup",
            None,
        )
        if callable(cleanup_owned_orders):
            cleanup_owned_orders()
        self.connect_backends()
        self.write_health_file(log_snapshot=False)
        server = self.serve_health()
        heartbeat_stop, heartbeat_thread = self.start_heartbeat_thread()
        synthetic_stop_runtime: tuple[threading.Event, threading.Thread] | None = None
        synthetic_stop_watchdog: (
            tuple[threading.Event, threading.Thread, list[SafetyError]] | None
        ) = None
        try:
            self.connect_ibkr()
            synthetic_stop_runtime = self.start_synthetic_stop_thread()
            if synthetic_stop_runtime is not None:
                synthetic_stop_watchdog = self.start_synthetic_stop_watchdog(
                    synthetic_stop_runtime,
                    stop_event,
                )
            while not stop_event.is_set():
                if synthetic_stop_watchdog is not None and synthetic_stop_watchdog[2]:
                    raise synthetic_stop_watchdog[2][0]
                self.refresh_ibkr_connection_state()
                stop_event.wait(self.heartbeat_interval)
            if synthetic_stop_watchdog is not None and synthetic_stop_watchdog[2]:
                raise synthetic_stop_watchdog[2][0]
        finally:
            synthetic_stop_failure: Exception | None = None
            if synthetic_stop_watchdog is not None:
                synthetic_stop_watchdog[0].set()
            self.state.synthetic_stops_armed = False
            if self.state.synthetic_stops_required:
                self.state.synthetic_stops_detail = "stopped"
            if synthetic_stop_watchdog is not None:
                synthetic_stop_watchdog[1].join(timeout=1.0)
            if synthetic_stop_runtime is not None:
                daemon_stop, daemon_thread = synthetic_stop_runtime
                daemon_stop.set()
                daemon_thread.join(timeout=self.synthetic_stop_shutdown_timeout())
                if daemon_thread.is_alive():
                    synthetic_stop_failure = SafetyError(
                        "synthetic-stop daemon did not reconcile before shutdown timeout"
                    )
                    try:
                        self.activate_synthetic_stop_kill_switch(
                            str(synthetic_stop_failure)
                        )
                    except Exception as exc:
                        synthetic_stop_failure = SafetyError(
                            f"{synthetic_stop_failure}; kill-switch activation failed: "
                            f"{type(exc).__name__}: {exc}"
                        )
                    while daemon_thread.is_alive():
                        daemon_thread.join(timeout=1.0)
                daemon_failure = getattr(
                    self.synthetic_stop_daemon,
                    "failure",
                    None,
                )
                if daemon_failure is not None:
                    if synthetic_stop_failure is None:
                        synthetic_stop_failure = SafetyError(
                            "synthetic-stop daemon failed during shutdown: "
                            f"{daemon_failure}"
                        )
                    else:
                        synthetic_stop_failure = SafetyError(
                            f"{synthetic_stop_failure}; daemon failure: "
                            f"{daemon_failure}"
                        )
            heartbeat_stop.set()
            heartbeat_thread.join(
                timeout=max(1.0, min(float(self.heartbeat_interval), 5.0))
            )
            heartbeat_stopped = not heartbeat_thread.is_alive()
            self.ibkr_adapter.disconnect()
            server.shutdown()
            server.server_close()
            if heartbeat_stopped:
                self.write_health_file(log_snapshot=False)
                self.log_event(
                    {
                        "event": "runner_stopped",
                        "service": self.state.service,
                        "timestamp": utc_now(),
                    },
                    write_postgres=False,
                )
            if synthetic_stop_failure is not None:
                raise synthetic_stop_failure


def resolve_config_path() -> Path:
    configured = Path(os.getenv("NAUTILUS_CONFIG", "nautilus/config/paper.yaml"))
    if configured.exists():
        return configured
    fallback = Path(__file__).resolve().parent / "config" / "paper.yaml"
    return fallback


def main() -> int:
    try:
        gate = arm_gate.gate_from_env()
        arm_gate.invalidate_stale_record(gate)
        arm_gate.configure(gate)
        config = apply_env_overrides(load_config(resolve_config_path()))
        runner = PrototypeRunner(config)
    except Exception as exc:
        print(
            f"nautilus runner refused to start: {sanitize_payload(str(exc))}",
            file=sys.stderr,
        )
        return 1

    stop_event = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    runner.run(stop_event)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
