"""Trusted server integration ports. There are no production implementations here.

Port implementations are security boundaries, not client-supplied callbacks. In
particular, a confirmed checkbox, actor string, schema parse, or signed-in UI is
not a server-verified fresh human recovery challenge.
"""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol

from .models import (
    EvidenceState, GatewayTarget, HostTrust, ObservationSnapshot,
    ReadinessAssessment, RecoveryBinding, RecoveryPhase, reference,
)


class PublicContractPort(Protocol):
    """Bridge to @darkfactory/api/vertex, exact published schema version only.

    validate must invoke the authoritative named schema, preserve all values and
    reject unknown keys/invalid chronology. Only literal True signals success;
    do not hand-code a Python schema or accept truthy/returned-payload fallbacks.
    epoch_ns uses authoritative exact nanosecond Gregorian semantics from
    @darkfactory/shared/vertex, including offsets and year-zero behavior.
    No generated validator is shipped or claimed verified by this package.
    """
    def validate(self, contract_name: str, payload: Any,
                 schema_version: str = "1.0.0") -> bool: ...

    def epoch_ns(self, timestamp: str) -> int: ...


class CanonicalCodecPort(Protocol):
    """Authoritative canonical JSON UTF-8 bytes; SHA256 is applied to those bytes.

    Exact public canonicalArtifactJson profile, no float/time/decimal coercion.
    Original source-byte hashes are distinct and must not be re-encoded.
    """
    def encode(self, value: Any) -> bytes: ...


class ClockPort(Protocol):
    def now_ns(self) -> int: ...


class GatewayStatusPort(Protocol):
    """Server-owned current status, not a caller-supplied stale snapshot.

    The guard/admission implementation rechecks this revision under its fence.
    No account data can be inferred from the public status; target is resolved
    by the server's authorized account/gateway registry before this call.
    """
    def current(self, target: GatewayTarget) -> Mapping[str, Any]: ...


class HostTrustPort(Protocol):
    """Read-only external provider-console/pinned-host/TLS verification.

    No trust-on-first-use, key addition, warning suppression, trust downgrade,
    password prompt, or automatic provider safety approval is permitted.
    """
    def inspect(self, target: GatewayTarget) -> HostTrust: ...


class ObservationPort(Protocol):
    """One bounded read-only collection; no startup collection or retry loop.

    Adapter verifies exact protocol, endpoint registry identity, account reference,
    environment, source and broker session generation. TWS socket handshake and
    Client Portal authentication are different protocols. A socket or HTTP 200
    alone is never an authenticated/account/reconciliation observation. Raw
    accounts must be mapped to opaque registry references inside this port; raw
    API payloads/errors, account values and authentication pages never escape.
    Read-only probes require configured/entitled endpoints and finite deadlines.
    No login, keepalive/reauth mutation, orders, cancellations or rescan here.
    """
    def collect(self, target: GatewayTarget) -> ObservationSnapshot: ...


@dataclass(frozen=True)
class ServerSession:
    """Opaque server session lookup handle, not a bearer token or user assertion.

    Construct only in an authenticated/CSRF-protected server handler. The
    authorization port must resolve it independently and verify current session,
    principal, human interactive challenge, permissions and revocation.
    """
    session_ref: str = field(repr=False)

    def __post_init__(self) -> None:
        reference(self.session_ref)


@dataclass(frozen=True)
class HumanAdmission:
    attempt_ref: str
    binding_digest: str
    authenticated_ns: int
    challenge_verified_ns: int
    expires_ns: int
    human_verified: EvidenceState
    durable_claim: EvidenceState


class ServerAuthorizationPort(Protocol):
    """Atomic, durable verify + challenge consume + recovery admission.

    In one transaction: resolve active server session; verify authenticated human
    actor and fresh interactive approval; exact-match the complete binding,
    session, request content digest, account, environment, protocol, gateway,
    action, expected status, request/idempotency and challenge identifiers; enforce
    expiry using trusted server time; reject revoked authority, CSRF failures,
    replay, changed idempotency content and ANY unresolved gateway/account attempt.
    Store a durable UNKNOWN/pre-dispatch attempt before returning. Uniqueness must
    cover challenge globally, request/idempotency identity, gateway and account;
    crash/restart must not allow another dispatcher to steal an unresolved claim.
    The public request action requests human recovery only: restart or rescan
    needs separate exact-operation point-of-risk approval in this challenge.
    Neither a client confirmation statement nor model confidence is evidence.

    Duplicate/rejected authorization returns None. An exception is uncertain and
    must never be automatically retried. Do not log the request/session/challenge.
    No in-memory default implementation is supplied.
    """
    def admit_once(self, session: ServerSession, binding: RecoveryBinding,
                   now_ns: int, guard_ref: str) -> HumanAdmission | None: ...


@dataclass(frozen=True)
class SafetyLease:
    guard_ref: str
    binding_digest: str
    expires_ns: int
    owner_fenced: EvidenceState
    new_risk_paused: EvidenceState
    submission_journal_reconciled: EvidenceState
    no_inflight_mutations: EvidenceState
    protection_continuity_proven: EvidenceState
    disruption_safe: EvidenceState

    def permits(self, binding: RecoveryBinding, now_ns: int) -> bool:
        states = (self.owner_fenced, self.new_risk_paused,
                  self.submission_journal_reconciled, self.no_inflight_mutations,
                  self.protection_continuity_proven, self.disruption_safe)
        return (self.binding_digest == binding.digest and type(self.expires_ns) is int
                and self.expires_ns > now_ns
                and all(value is EvidenceState.YES for value in states))


class ExecutionSafetyPort(Protocol):
    """Local execution authority owns and fences this guard, not cloud/UI code.

    hold locks/pauses the single owner and establishes a durable admission fence
    through dispatch, including external fills/protection and reconnect races.
    It must revalidate the status/generation/account under that fence. Lease loss
    must prevent dispatch, including inside the executor; a boolean snapshot is
    insufficient. Scope exit NEVER rearms trading or resets the local kill switch.
    No open obligation may silently lose protection during a restart.
    """
    def hold(self, binding: RecoveryBinding) -> AbstractContextManager[SafetyLease]: ...


class DispatchDisposition(str, Enum):
    ACCEPTED = "accepted"
    DEFINITELY_NOT_ATTEMPTED = "definitely-not-attempted"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class DispatchReceipt:
    attempt_ref: str
    binding_digest: str
    disposition: DispatchDisposition


class RecoveryExecutorPort(Protocol):
    """Future injected executor; absent and disabled by default.

    Honor the still-live local guard and exact durable admission immediately at
    effect time. Use one bounded attempt, no transport retry or restart/rescan
    startup behavior. An acknowledgement is not recovery success. Interrupted,
    partial, timed-out or lost acknowledgements are UNKNOWN. No credential input,
    login/2FA automation, orders, rearm or kill-reset method is available here.
    Implementations must distinguish restart-gateway from rescan-read-only and
    must not interpret request-human-recovery as authority for either operation.
    """
    def dispatch_once(self, binding: RecoveryBinding, admission: HumanAdmission,
                      lease: SafetyLease) -> DispatchReceipt: ...


class RecoveryJournalPort(Protocol):
    """Same durable attempt store admitted by ServerAuthorizationPort.

    mark_dispatching must compare-and-set the exact admission to durable UNKNOWN
    before any transport call. mark_outcome stores acknowledgement/uncertainty,
    never COMPLETED and never releases a claim on timeout or failed write.
    mark_reconciled must atomically CAS this unresolved attempt with its exact
    server-reviewed proof, verify proof is after stored dispatch time and broker
    generation transition, and retain audit lineage. No recovery outcome can
    authorize trading or kill reset. Return False on conflict, never overwrite.
    """
    def mark_dispatching(self, binding: RecoveryBinding, admission: HumanAdmission,
                         now_ns: int) -> bool: ...

    def mark_outcome(self, binding: RecoveryBinding, admission: HumanAdmission,
                     phase: RecoveryPhase, now_ns: int) -> bool: ...

    def mark_reconciled(self, binding: RecoveryBinding, admission: HumanAdmission,
                        proof: ReconciliationProof, now_ns: int) -> bool: ...


@dataclass(frozen=True)
class AuditEvent:
    """Allowlisted nonsecret audit projection; never arbitrary exception text."""
    event_code: str
    target_digest: str
    binding_digest: str
    operation: str
    environment: str
    occurred_ns: int


class AuditPort(Protocol):
    """Durably acknowledge pre-dispatch audit; failure blocks all effects."""
    def append(self, event: AuditEvent) -> bool: ...


@dataclass(frozen=True)
class ReconciliationProof:
    attempt_ref: str
    binding_digest: str
    observed_after_ns: int
    reviewed_ns: int
    expires_ns: int
    human_reviewed: EvidenceState
    recovery_complete: EvidenceState
    assessment: ReadinessAssessment


class ReconciliationPort(Protocol):
    """Read-only resolution evidence from broker truth plus server human review.

    Evidence must concern this exact attempt and a broker session generation
    observed AFTER the attempt, with position/cash/order reconciliation at the
    execution owner. This is not authorization to retry or rearm. A fresh human
    challenge is required for any later operation, including after known failure.
    """
    def inspect(self, binding: RecoveryBinding, admission: HumanAdmission) -> ReconciliationProof | None: ...
