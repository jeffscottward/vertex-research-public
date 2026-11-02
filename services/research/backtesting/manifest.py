# Authorized first-party Gamma source port; see QuantReplayBuild-v1.json.
# Original: forge/src/options_alpha/backtesting/manifest.py
# SHA256: 6fb902ecac548957914bd60b660994e8d6037b9865e7c128ec24bf2b819ca143
"""Immutable, date-indexed replay provenance contracts."""

from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import ConfigDict, Field, field_validator, model_validator

from gamma.schemas.base import SchemaModel, artifact_hash

REPLAY_MANIFEST_SCHEMA_VERSION = 2
REPLAY_OUTCOME_ARTIFACT_TYPE = "options_alpha.replay_outcome_observation"
REPLAY_OUTCOME_ARTIFACT_VERSION = 2
MAX_REPLAY_SNAPSHOTS = 512
MAX_REPLAY_OUTCOMES = 256
MAX_REPLAY_IDS = 256
MARKET_TIME_ZONE = ZoneInfo("America/New_York")

ReplaySourceProvider = Literal[
    "quantdata",
    "financial_datasets",
    "trade_artifact",
    "strategy_intent",
    "execution_intent",
    "outcome",
]

_SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_SAFE_MANIFEST_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,15}$")


class ReplaySourceSnapshot(SchemaModel):
    """Hash and point-in-time identity for one replay input bundle."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    ticker: str
    provider: ReplaySourceProvider
    snapshot_date: date | None = None
    source_timestamp: datetime | None = None
    payload_hash: str | None = None
    manifest_key: str

    @field_validator("source_timestamp")
    @classmethod
    def normalize_source_timestamp(cls, value: datetime | None) -> datetime | None:
        return _normalize_optional_datetime(value, "source_timestamp")

    @model_validator(mode="after")
    def validate_snapshot(self) -> ReplaySourceSnapshot:
        _validate_ticker(self.ticker)
        _validate_manifest_key(self.manifest_key)
        if self.snapshot_date is None:
            raise ValueError("date-indexed replay snapshot required")
        if self.source_timestamp is None or self.payload_hash is None:
            raise ValueError(
                "replay snapshot source_timestamp and payload_hash required"
            )
        _validate_hash(self.payload_hash, "payload_hash")
        if self.source_timestamp.date() != self.snapshot_date:
            raise ValueError(
                "replay snapshot date must match source_timestamp UTC date"
            )
        return self


class ReplayHorizon(SchemaModel):
    """Explicit replay entry and exactly one deterministic exit choice."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    entry_at: datetime
    exit_at: datetime | None = None
    holding_period_sessions: int | None = Field(default=None, ge=1, le=2520)
    exit_policy: str
    horizon_end_at: datetime | None = None

    @field_validator("entry_at", "exit_at", "horizon_end_at")
    @classmethod
    def normalize_timestamps(cls, value: datetime | None) -> datetime | None:
        return _normalize_optional_datetime(value, "replay horizon timestamp")

    @model_validator(mode="after")
    def resolve_horizon_end(self) -> ReplayHorizon:
        _validate_label(self.exit_policy, "exit_policy", max_length=64)
        if (self.exit_at is None) == (self.holding_period_sessions is None):
            raise ValueError(
                "replay horizon requires exactly one of exit_at or "
                "holding_period_sessions"
            )
        resolved = (
            self.exit_at
            if self.exit_at is not None
            else _add_market_sessions(self.entry_at, self.holding_period_sessions or 0)
        )
        if resolved <= self.entry_at:
            raise ValueError("replay horizon_end_at must be after entry_at")
        if self.horizon_end_at is not None and self.horizon_end_at != resolved:
            raise ValueError("replay horizon_end_at does not match the exit choice")
        object.__setattr__(self, "horizon_end_at", resolved)
        return self


class ReplayOutcomeObservation(SchemaModel):
    """Timestamped outcome bound to one strategy and execution."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    ticker: str
    strategy_intent_id: str
    execution_id: str
    observed_at: datetime
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0
    position_state: Literal["closed", "open"]
    entry_at: datetime
    horizon_end_at: datetime
    exit_policy: str

    @field_validator("observed_at", "entry_at", "horizon_end_at")
    @classmethod
    def normalize_timestamps(cls, value: datetime) -> datetime:
        normalized = _normalize_optional_datetime(value, "replay outcome timestamp")
        if normalized is None:  # pragma: no cover - Pydantic rejects None first
            raise ValueError("replay outcome timestamp is required")
        return normalized

    @model_validator(mode="after")
    def validate_outcome(self) -> ReplayOutcomeObservation:
        _validate_ticker(self.ticker)
        _validate_id(self.strategy_intent_id, "strategy_intent_id")
        _validate_id(self.execution_id, "execution_id")
        _validate_label(self.exit_policy, "exit_policy", max_length=64)
        for field_name, value in (
            ("realized_pnl", self.realized_pnl),
            ("unrealized_pnl", self.unrealized_pnl),
        ):
            if not math.isfinite(value):
                raise ValueError(f"{field_name} must be finite")
        if self.position_state == "closed" and self.unrealized_pnl != 0:
            raise ValueError("closed replay outcome cannot retain unrealized PnL")
        if self.position_state == "open" and self.realized_pnl != 0:
            raise ValueError("open replay outcome cannot realize PnL")
        if self.horizon_end_at <= self.entry_at:
            raise ValueError("replay outcome horizon_end_at must be after entry_at")
        if self.observed_at < self.horizon_end_at:
            raise ValueError(
                "replay outcome observed_at must be at or after horizon_end_at"
            )
        return self


class ReplayOutcomeArtifact(SchemaModel):
    """Separately persisted timestamped outcome-observation artifact."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    artifact_type: Literal["options_alpha.replay_outcome_observation"] = (
        REPLAY_OUTCOME_ARTIFACT_TYPE
    )
    version: Literal[2] = REPLAY_OUTCOME_ARTIFACT_VERSION
    artifact_id: str
    source_trade_run_id: str
    persisted_at: datetime
    outcomes: tuple[ReplayOutcomeObservation, ...] = Field(
        min_length=1,
        max_length=MAX_REPLAY_OUTCOMES,
    )

    @field_validator("persisted_at")
    @classmethod
    def normalize_persisted_at(cls, value: datetime) -> datetime:
        normalized = _normalize_optional_datetime(value, "persisted_at")
        if normalized is None:  # pragma: no cover - Pydantic rejects None first
            raise ValueError("persisted_at is required")
        return normalized

    @model_validator(mode="after")
    def validate_artifact(self) -> ReplayOutcomeArtifact:
        _validate_id(self.artifact_id, "artifact_id")
        _validate_id(self.source_trade_run_id, "source_trade_run_id")
        execution_ids = [item.execution_id for item in self.outcomes]
        if len(execution_ids) != len(set(execution_ids)):
            raise ValueError("outcome artifact execution IDs must be unique")
        if self.persisted_at < max(item.observed_at for item in self.outcomes):
            raise ValueError("outcome artifact persisted_at precedes observed_at")
        return self


class ReplayExecutionBinding(SchemaModel):
    """Immutable execution-to-strategy identity recorded by the source run."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    execution_id: str
    strategy_intent_id: str
    ticker: str
    replay_execution_id: str
    replay_payload_hash: str

    @model_validator(mode="after")
    def validate_binding(self) -> ReplayExecutionBinding:
        _validate_id(self.execution_id, "execution_id")
        _validate_id(self.strategy_intent_id, "strategy_intent_id")
        _validate_id(self.replay_execution_id, "replay_execution_id")
        _validate_hash(self.replay_payload_hash, "replay_payload_hash")
        _validate_ticker(self.ticker)
        return self


class ReplaySourceManifest(SchemaModel):
    """Immutable manifest binding replay inputs, horizon, and outcomes."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    schema_version: Literal[2] = REPLAY_MANIFEST_SCHEMA_VERSION
    manifest_id: str | None = None
    manifest_hash: str | None = None
    source_trade_run_id: str
    artifact_generated_at: datetime
    decision_at: datetime
    snapshots: tuple[ReplaySourceSnapshot, ...] = Field(
        min_length=0,
        max_length=MAX_REPLAY_SNAPSHOTS,
    )
    outcomes: tuple[ReplayOutcomeObservation, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REPLAY_OUTCOMES,
    )
    horizon: ReplayHorizon | None
    strategy_intent_ids: tuple[str, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REPLAY_IDS,
    )
    execution_bindings: tuple[ReplayExecutionBinding, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REPLAY_IDS,
    )
    execution_ids: tuple[str, ...] = Field(
        default_factory=tuple,
        max_length=MAX_REPLAY_IDS,
    )
    outcome_artifact_hash: str | None = None

    @field_validator("artifact_generated_at", "decision_at")
    @classmethod
    def normalize_timestamps(cls, value: datetime) -> datetime:
        normalized = _normalize_optional_datetime(value, "manifest timestamp")
        if normalized is None:  # pragma: no cover - Pydantic rejects None first
            raise ValueError("manifest timestamp is required")
        return normalized

    @model_validator(mode="after")
    def validate_and_hash_manifest(self) -> ReplaySourceManifest:
        _validate_id(self.source_trade_run_id, "source_trade_run_id")
        if self.artifact_generated_at != self.decision_at:
            raise ValueError("manifest decision_at must match artifact generated_at")
        if not self.snapshots:
            raise ValueError("date-indexed replay snapshot required")
        if not self.outcomes or self.outcome_artifact_hash is None:
            raise ValueError("outcome observation artifact required")
        _validate_hash(self.outcome_artifact_hash, "outcome_artifact_hash")
        if self.horizon is None or not self.horizon.exit_policy:
            raise ValueError("explicit replay horizon and exit policy required")
        if self.horizon.entry_at < self.decision_at:
            raise ValueError("replay horizon entry_at precedes decision_at")

        _validate_unique_ids(self.strategy_intent_ids, "strategy_intent_ids")
        _validate_unique_ids(self.execution_ids, "execution_ids")
        execution_bindings_by_id: dict[str, ReplayExecutionBinding] = {}
        replay_execution_ids: set[str] = set()
        for binding in self.execution_bindings:
            if binding.execution_id in execution_bindings_by_id:
                raise ValueError("execution bindings must be unique")
            if binding.strategy_intent_id not in self.strategy_intent_ids:
                raise ValueError(
                    "execution binding strategy is not declared by the manifest"
                )
            execution_bindings_by_id[binding.execution_id] = binding
            if binding.replay_execution_id in replay_execution_ids:
                raise ValueError("replay execution bindings must be unique")
            replay_execution_ids.add(binding.replay_execution_id)
        if set(execution_bindings_by_id) != set(self.execution_ids):
            raise ValueError(
                "execution bindings must cover every declared execution"
            )
        snapshot_keys: set[str] = set()
        providers: set[str] = set()
        for snapshot in self.snapshots:
            if snapshot.manifest_key in snapshot_keys:
                raise ValueError("replay snapshot manifest_key must be unique")
            snapshot_keys.add(snapshot.manifest_key)
            providers.add(snapshot.provider)
            if snapshot.source_timestamp is None:  # validated by snapshot model
                raise ValueError(
                    "replay snapshot source_timestamp and payload_hash required"
                )
            if snapshot.source_timestamp > self.decision_at and (
                snapshot.provider != "outcome"
            ):
                raise ValueError("replay snapshot occurs after decision_at")

        required_providers = {
            "quantdata",
            "trade_artifact",
            "strategy_intent",
            "execution_intent",
            "outcome",
        }
        if not required_providers.issubset(providers):
            raise ValueError("date-indexed replay snapshot required")
        trade_snapshots = [
            snapshot
            for snapshot in self.snapshots
            if snapshot.provider == "trade_artifact"
            and snapshot.manifest_key
            == f"trade_artifact:{self.source_trade_run_id}"
        ]
        if (
            len(trade_snapshots) != 1
            or trade_snapshots[0].source_timestamp
            != self.artifact_generated_at
        ):
            raise ValueError(
                "trade artifact snapshot does not match the source run"
            )
        outcome_snapshots = [
            snapshot
            for snapshot in self.snapshots
            if snapshot.provider == "outcome"
        ]
        if (
            len(outcome_snapshots) != 1
            or outcome_snapshots[0].payload_hash
            != self.outcome_artifact_hash
        ):
            raise ValueError(
                "outcome snapshot hash does not match the outcome artifact"
            )
        if outcome_snapshots[0].source_timestamp != max(
            outcome.observed_at for outcome in self.outcomes
        ):
            raise ValueError(
                "outcome snapshot timestamp does not match observations"
            )
        for intent_id in self.strategy_intent_ids:
            if not any(
                snapshot.provider == "strategy_intent"
                and snapshot.manifest_key == f"strategy_intent:{intent_id}"
                for snapshot in self.snapshots
            ):
                raise ValueError(
                    "date-indexed replay snapshot required for strategy_intent"
                )
        for execution_id in self.execution_ids:
            if not any(
                snapshot.provider == "execution_intent"
                and snapshot.manifest_key == f"execution_intent:{execution_id}"
                for snapshot in self.snapshots
            ):
                raise ValueError(
                    "date-indexed replay snapshot required for execution_intent"
                )

        outcome_execution_ids: set[str] = set()
        for outcome in self.outcomes:
            if outcome.execution_id not in self.execution_ids:
                raise ValueError("outcome execution_id is not declared by the manifest")
            if outcome.strategy_intent_id not in self.strategy_intent_ids:
                raise ValueError(
                    "outcome strategy_intent_id is not declared by the manifest"
                )
            binding = execution_bindings_by_id[outcome.execution_id]
            if (
                outcome.strategy_intent_id != binding.strategy_intent_id
                or outcome.ticker != binding.ticker
            ):
                raise ValueError(
                    "outcome execution binding does not match strategy and ticker"
                )
            if outcome.execution_id in outcome_execution_ids:
                raise ValueError("manifest outcomes must have unique execution IDs")
            outcome_execution_ids.add(outcome.execution_id)
            if (
                outcome.entry_at != self.horizon.entry_at
                or outcome.horizon_end_at != self.horizon.horizon_end_at
                or outcome.exit_policy != self.horizon.exit_policy
            ):
                raise ValueError("replay outcome does not match the declared horizon")
            if outcome.observed_at < self.horizon.horizon_end_at:
                raise ValueError(
                    "replay outcome observed_at must be at or after horizon_end_at"
                )
        if outcome_execution_ids != set(self.execution_ids):
            raise ValueError(
                "replay outcomes must cover every declared execution"
            )

        hash_payload = self.model_dump(
            mode="json",
            round_trip=True,
            exclude={"manifest_id", "manifest_hash"},
        )
        expected_hash = artifact_hash(hash_payload)
        expected_id = f"replay-manifest-{expected_hash[:24]}"
        if self.manifest_hash is not None and self.manifest_hash != expected_hash:
            raise ValueError("replay manifest hash does not match content")
        if self.manifest_id is not None and self.manifest_id != expected_id:
            raise ValueError("replay manifest ID does not match content")
        object.__setattr__(self, "manifest_hash", expected_hash)
        object.__setattr__(self, "manifest_id", expected_id)
        return self


class ReplayManifestQualification(SchemaModel):
    """Bounded qualification outcome carried with every replay result."""

    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        frozen=True,
        revalidate_instances="always",
    )

    qualifying: bool
    failure_reasons: tuple[str, ...] = Field(default_factory=tuple, max_length=8)
    manifest_id: str | None = None
    manifest_hash: str | None = None

    @model_validator(mode="after")
    def validate_qualification(self) -> ReplayManifestQualification:
        if self.qualifying:
            if (
                self.failure_reasons
                or self.manifest_id is None
                or self.manifest_hash is None
            ):
                raise ValueError(
                    "qualifying replay manifest requires stable ID and hash"
                )
            _validate_id(self.manifest_id, "manifest_id")
            _validate_hash(self.manifest_hash, "manifest_hash")
        elif not self.failure_reasons:
            raise ValueError("non-qualifying replay manifest requires failure reasons")
        for reason in self.failure_reasons:
            _validate_label(reason, "failure_reason", max_length=120)
        return self

    @classmethod
    def missing_manifest(cls) -> ReplayManifestQualification:
        return cls(
            qualifying=False,
            failure_reasons=[
                "date-indexed replay snapshot required",
                "outcome observation artifact required",
                "explicit replay horizon and exit policy required",
            ],
        )

    @classmethod
    def from_manifest(
        cls,
        manifest: ReplaySourceManifest,
    ) -> ReplayManifestQualification:
        return cls(
            qualifying=True,
            manifest_id=manifest.manifest_id,
            manifest_hash=manifest.manifest_hash,
        )


def _normalize_optional_datetime(
    value: datetime | None,
    field_name: str,
) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value.astimezone(UTC)


def _add_market_sessions(entry_at: datetime, sessions: int) -> datetime:
    current = entry_at.astimezone(MARKET_TIME_ZONE)
    remaining = sessions
    while remaining:
        current += timedelta(days=1)
        if _is_replay_market_session(current.date()):
            remaining -= 1
    return current.astimezone(UTC)


def _is_replay_market_session(day: date) -> bool:
    # Keep replay horizon semantics aligned with SetupEngine's US market calendar.
    return day.weekday() < 5 and day not in _replay_market_holidays(day.year)


def _replay_market_holidays(year: int) -> set[date]:
    holidays: set[date] = set()
    for holiday_year in (year - 1, year, year + 1):
        holidays.update(
            {
                _observed_market_date(date(holiday_year, 1, 1)),
                _nth_weekday(holiday_year, 1, 0, 3),
                _nth_weekday(holiday_year, 2, 0, 3),
                _easter_date(holiday_year) - timedelta(days=2),
                _last_weekday(holiday_year, 5, 0),
                _observed_market_date(date(holiday_year, 6, 19)),
                _observed_market_date(date(holiday_year, 7, 4)),
                _nth_weekday(holiday_year, 9, 0, 1),
                _nth_weekday(holiday_year, 11, 3, 4),
                _observed_market_date(date(holiday_year, 12, 25)),
            }
        )
    return holidays


def _observed_market_date(day: date) -> date:
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    day = date(year, month, 1)
    while day.weekday() != weekday:
        day += timedelta(days=1)
    return day + timedelta(days=7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    first_of_next_month = (
        date(year + 1, 1, 1)
        if month == 12
        else date(year, month + 1, 1)
    )
    day = first_of_next_month - timedelta(days=1)
    while day.weekday() != weekday:
        day -= timedelta(days=1)
    return day


def _easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l_value = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_value) // 451
    month = (h + l_value - 7 * m + 114) // 31
    day = ((h + l_value - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _validate_id(value: str, field_name: str) -> None:
    if not _SAFE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field_name} contains unsupported path characters")


def _validate_manifest_key(value: str) -> None:
    if not _SAFE_MANIFEST_KEY_PATTERN.fullmatch(value):
        raise ValueError("manifest_key contains unsupported path characters")


def _validate_hash(value: str, field_name: str) -> None:
    if not _HASH_PATTERN.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256 hash")


def _validate_ticker(value: str) -> None:
    if not _TICKER_PATTERN.fullmatch(value):
        raise ValueError("replay snapshot ticker is invalid")


def _validate_label(value: str, field_name: str, *, max_length: int) -> None:
    if not value or value != value.strip() or len(value) > max_length:
        raise ValueError(f"{field_name} is invalid")
    if any(character in value for character in ("/", "\\", "\x00", "\n", "\r")):
        raise ValueError(f"{field_name} is invalid")


def _validate_unique_ids(values: tuple[str, ...], field_name: str) -> None:
    if not values:
        raise ValueError(f"{field_name} must not be empty")
    if len(values) != len(set(values)):
        raise ValueError(f"{field_name} must be unique")
    for value in values:
        _validate_id(value, field_name)


__all__ = [
    "MAX_REPLAY_IDS",
    "MAX_REPLAY_OUTCOMES",
    "MAX_REPLAY_SNAPSHOTS",
    "REPLAY_MANIFEST_SCHEMA_VERSION",
    "REPLAY_OUTCOME_ARTIFACT_TYPE",
    "REPLAY_OUTCOME_ARTIFACT_VERSION",
    "ReplayExecutionBinding",
    "ReplayHorizon",
    "ReplayManifestQualification",
    "ReplayOutcomeArtifact",
    "ReplayOutcomeObservation",
    "ReplaySourceManifest",
    "ReplaySourceSnapshot",
]
