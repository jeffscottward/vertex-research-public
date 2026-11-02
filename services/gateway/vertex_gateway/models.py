"""Private native gateway values, never replacements for the public API schemas.

Only opaque account references cross this boundary. No endpoint, account number,
credential, browser content, or free-form provider response belongs in a value.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
import json
import re
from typing import Any, Mapping
from types import MappingProxyType


class EvidenceState(str, Enum):
    YES = "yes"
    NO = "no"
    UNKNOWN = "unknown"


class Environment(str, Enum):
    PAPER = "paper"
    LIVE = "live"


class GatewayProtocol(str, Enum):
    TWS_SOCKET = "tws-socket"
    CLIENT_PORTAL_HTTP = "client-portal-http"


class Dimension(str, Enum):
    PROCESS = "process-present"
    REACHABLE = "gateway-reachable"
    AUTHENTICATED = "broker-authenticated"
    ACCOUNT = "account-identity"
    ENVIRONMENT = "environment-identity"
    READ_ONLY = "read-only-probe"
    RECONCILED = "execution-reconciled"


class RecoveryOperation(str, Enum):
    HUMAN_HANDOFF = "human-handoff"
    RESTART_GATEWAY = "restart-gateway"
    RESCAN_READ_ONLY = "rescan-read-only"


class RecoveryPhase(str, Enum):
    PLANNED = "planned"
    BLOCKED = "blocked"
    HUMAN_REQUIRED = "human-required"
    IN_PROGRESS = "in-progress"
    RECONCILIATION_REQUIRED = "reconciliation-required"
    NOT_ATTEMPTED = "not-attempted"
    UNKNOWN = "unknown"
    COMPLETED = "completed"


def reference(value: str) -> str:
    """Internal identifiers are registry references, never arbitrary text."""
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is None:
        raise ValueError("invalid_reference")
    return value


def account_reference(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"acctref-[0-9a-f]{64}", value) is None:
        raise ValueError("opaque_account_reference_required")
    return value


def nanoseconds(value: int) -> int:
    if type(value) is not int:
        raise ValueError("integer_nanoseconds_required")
    return value


def freeze(value: Any) -> Any:
    """Take ownership of a validated JSON value, retaining original timestamps."""
    if isinstance(value, Mapping):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(freeze(item) for item in value)
    if value is None or type(value) in (str, bool, int):
        return value
    raise ValueError("non_json_contract_value")


@dataclass(frozen=True)
class GatewayTarget:
    gateway_id: str
    account_ref: str = field(repr=False)
    environment: Environment
    protocol: GatewayProtocol

    def __post_init__(self) -> None:
        reference(self.gateway_id)
        account_reference(self.account_ref)
        if not isinstance(self.environment, Environment) or not isinstance(self.protocol, GatewayProtocol):
            raise ValueError("invalid_target")

    @property
    def digest(self) -> str:
        encoded = json.dumps([self.gateway_id, self.account_ref, self.environment.value,
                              self.protocol.value], separators=(",", ":"))
        return sha256(encoded.encode()).hexdigest()


@dataclass(frozen=True)
class Observation:
    dimension: Dimension
    state: EvidenceState
    source_ref: str
    evidence_ref: str
    observed_ns: int
    received_ns: int
    expires_ns: int
    account_ref: str | None = field(default=None, repr=False)
    environment: Environment | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.dimension, Dimension) or not isinstance(self.state, EvidenceState):
            raise ValueError("invalid_observation")
        reference(self.source_ref)
        reference(self.evidence_ref)
        for value in (self.observed_ns, self.received_ns, self.expires_ns):
            nanoseconds(value)
        if self.account_ref is not None:
            account_reference(self.account_ref)
        if self.environment is not None and not isinstance(self.environment, Environment):
            raise ValueError("invalid_environment")


@dataclass(frozen=True)
class ObservationSnapshot:
    target: GatewayTarget
    generation_ref: str
    observations: tuple[Observation, ...] = ()

    def __post_init__(self) -> None:
        reference(self.generation_ref)
        if not isinstance(self.target, GatewayTarget) or type(self.observations) is not tuple:
            raise ValueError("immutable_observations_required")
        if len(self.observations) > 64 or any(not isinstance(row, Observation) for row in self.observations):
            raise ValueError("invalid_observations")


@dataclass(frozen=True)
class HostTrust:
    """External verifier's scoped receipt; no fingerprints/hostnames stored here.

    Verifier must check provider-console fingerprint against the pinned host key,
    strict transport host verification, and TLS verification for HTTP. A receipt
    cannot establish login, account identity, or broker readiness.
    """
    target_digest: str
    state: EvidenceState
    evidence_ref: str
    verified_ns: int
    expires_ns: int
    strict_verification: bool

    def __post_init__(self) -> None:
        reference(self.evidence_ref)
        if re.fullmatch(r"[0-9a-f]{64}", self.target_digest) is None:
            raise ValueError("invalid_target_digest")
        nanoseconds(self.verified_ns)
        nanoseconds(self.expires_ns)
        if not isinstance(self.state, EvidenceState) or type(self.strict_verification) is not bool:
            raise ValueError("invalid_host_trust")

    def current(self, target: GatewayTarget, now_ns: int) -> bool:
        return (self.target_digest == target.digest and self.state is EvidenceState.YES
                and self.strict_verification and self.verified_ns <= now_ns < self.expires_ns)


@dataclass(frozen=True)
class DimensionAssessment:
    dimension: Dimension
    state: EvidenceState
    reason: str
    evidence_ref: str | None = None


@dataclass(frozen=True)
class ReadinessAssessment:
    target: GatewayTarget
    generation_ref: str
    assessed_ns: int
    dimensions: tuple[DimensionAssessment, ...]
    host_trust: EvidenceState
    read_only_ready: EvidenceState
    reason_codes: tuple[str, ...]

    def state(self, dimension: Dimension) -> EvidenceState:
        return next(row.state for row in self.dimensions if row.dimension is dimension)


@dataclass(frozen=True)
class RecoveryBinding:
    """Private server challenge binding, not a public RecoveryRequest schema."""
    target: GatewayTarget
    operation: RecoveryOperation
    request_id: str
    idempotency_key: str
    expected_status_id: str
    actor_id: str = field(repr=False)
    challenge_id: str = field(repr=False)
    requested_ns: int
    confirmed_ns: int
    expires_ns: int
    request_digest: str

    def __post_init__(self) -> None:
        for value in (self.request_id, self.idempotency_key, self.expected_status_id,
                      self.actor_id, self.challenge_id):
            reference(value)
        for value in (self.requested_ns, self.confirmed_ns, self.expires_ns):
            nanoseconds(value)
        if not isinstance(self.operation, RecoveryOperation):
            raise ValueError("invalid_recovery_operation")
        if re.fullmatch(r"[0-9a-f]{64}", self.request_digest) is None:
            raise ValueError("invalid_request_digest")

    @property
    def digest(self) -> str:
        # Includes exact contract content plus the server-selected target/action.
        values = [self.target.digest, self.operation.value, self.request_digest,
                  self.expected_status_id, self.actor_id, self.challenge_id]
        return sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class RecoveryPlan:
    binding: RecoveryBinding | None
    phase: RecoveryPhase
    reason_codes: tuple[str, ...]
    prerequisite_codes: tuple[str, ...] = ()
    executable: bool = False
    trading: str = "disabled"
    kill_switch_reset: bool = False


@dataclass(frozen=True)
class RecoveryResult:
    phase: RecoveryPhase
    reason_codes: tuple[str, ...]
    attempt_ref: str | None = None
    retry_allowed: bool = False
    trading: str = "disabled"
    kill_switch_reset: bool = False
