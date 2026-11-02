"""Pure source-bound observations; process/socket/authentication are not synonyms."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .models import (
    Dimension, DimensionAssessment, EvidenceState, GatewayTarget, HostTrust,
    ObservationSnapshot, ReadinessAssessment, RecoveryPhase, freeze, nanoseconds,
    reference,
)
from .ports import PublicContractPort


@dataclass(frozen=True)
class ObservationPolicy:
    """Server-owned source allowlist and per-snapshot finite freshness limits."""
    sources: tuple[tuple[Dimension, frozenset[str]], ...]
    max_age_ns: int
    max_delivery_ns: int

    def __post_init__(self) -> None:
        nanoseconds(self.max_age_ns)
        nanoseconds(self.max_delivery_ns)
        if self.max_age_ns <= 0 or self.max_delivery_ns < 0 or type(self.sources) is not tuple:
            raise ValueError("invalid_observation_policy")
        seen = set()
        for dimension, sources in self.sources:
            if (not isinstance(dimension, Dimension) or dimension in seen
                    or type(sources) is not frozenset):
                raise ValueError("invalid_source_policy")
            seen.add(dimension)
            for source in sources:
                reference(source)

    def allows(self, dimension: Dimension, source_ref: str) -> bool:
        return any(key is dimension and source_ref in sources for key, sources in self.sources)


def assess_readiness(target: GatewayTarget, snapshot: ObservationSnapshot | None,
                     trust: HostTrust | None, policy: ObservationPolicy,
                     now_ns: int) -> ReadinessAssessment:
    """Unknown, stale, untrusted, duplicate or mismatched evidence never upgrades.

    All broker dimensions belong to one adapter-verified session generation.
    No cross-generation merge, auto-rescan, inference from process state, or
    prerequisite inspection occurs in this pure evaluator.
    """
    nanoseconds(now_ns)
    trusted = trust is not None and trust.current(target, now_ns)
    host_state = EvidenceState.YES if trusted else EvidenceState.UNKNOWN
    if (trust is not None and trust.target_digest == target.digest and trust.state is EvidenceState.NO
            and trust.verified_ns <= now_ns < trust.expires_ns):
        host_state = EvidenceState.NO
    target_matches = snapshot is not None and snapshot.target == target
    generation = snapshot.generation_ref if target_matches else "unobserved"
    dimensions = []
    for dimension in Dimension:
        rows = tuple(row for row in snapshot.observations if row.dimension is dimension) if target_matches else ()
        reason = "not-observed"
        state = EvidenceState.UNKNOWN
        evidence_ref = None
        if snapshot is not None and not target_matches:
            reason = "target-mismatch"
        elif len(rows) > 1:
            reason = "ambiguous-evidence"
        elif rows:
            row = rows[0]
            if not trusted:
                reason = "host-trust-unverified"
            elif not policy.allows(dimension, row.source_ref):
                reason = "untrusted-source"
            elif not (row.observed_ns <= row.received_ns <= now_ns < row.expires_ns):
                reason = "invalid-evidence-time"
            elif now_ns - row.observed_ns > policy.max_age_ns:
                reason = "stale-evidence"
            elif row.received_ns - row.observed_ns > policy.max_delivery_ns:
                reason = "delayed-evidence"
            elif row.account_ref is not None and row.account_ref != target.account_ref:
                state, reason = EvidenceState.NO, "account-mismatch"
            elif row.environment is not None and row.environment is not target.environment:
                state, reason = EvidenceState.NO, "environment-mismatch"
            elif dimension in (Dimension.ACCOUNT, Dimension.READ_ONLY, Dimension.RECONCILED) and row.account_ref is None:
                reason = "account-unidentified"
            elif dimension in (Dimension.ENVIRONMENT, Dimension.READ_ONLY, Dimension.RECONCILED) and row.environment is None:
                reason = "environment-unidentified"
            else:
                state, reason, evidence_ref = row.state, "observed", row.evidence_ref
        dimensions.append(DimensionAssessment(dimension, state, reason, evidence_ref))
    # Reconciliation remains separately visible and is not required to READ data.
    required = tuple(row.state for row in dimensions if row.dimension is not Dimension.RECONCILED)
    if host_state is EvidenceState.NO or EvidenceState.NO in required:
        ready = EvidenceState.NO
    elif host_state is EvidenceState.YES and all(state is EvidenceState.YES for state in required):
        ready = EvidenceState.YES
    else:
        ready = EvidenceState.UNKNOWN
    codes = [f"{row.dimension.value}-{row.reason}" for row in dimensions if row.state is not EvidenceState.YES]
    if not trusted:
        codes.insert(0, "host-trust-unverified")
    codes.append("read-only-ready" if ready is EvidenceState.YES else "read-only-not-ready")
    codes.append("trading-disabled")
    return ReadinessAssessment(target, generation, now_ns, tuple(dimensions), host_state, ready, tuple(codes))


def project_public_status(contracts: PublicContractPort, assessment: ReadinessAssessment,
                          *, status_id: str, observed_at: str,
                          recovery_phase: RecoveryPhase = RecoveryPhase.BLOCKED,
                          last_human_request_id: str | None = None) -> Mapping[str, Any]:
    """Lossy public projection: detailed dimensions stay private and read-only.

    The existing public contract does not contain account identity, protocol or
    readiness; no lookalike schema is added. Infrastructure observed or handshake
    authenticated must never be interpreted as read-only readiness by consumers.
    """
    if nanoseconds(contracts.epoch_ns(observed_at)) != assessment.assessed_ns:
        raise ValueError("status_time_mismatch")
    if assessment.host_trust is EvidenceState.NO:
        infrastructure = "blocked"
    elif assessment.state(Dimension.REACHABLE) is EvidenceState.NO:
        infrastructure = "failed"
    elif assessment.state(Dimension.PROCESS) is EvidenceState.YES:
        infrastructure = "observed"
    else:
        infrastructure = "unknown"
    authentication = assessment.state(Dimension.AUTHENTICATED)
    handshake = {EvidenceState.YES: "authenticated", EvidenceState.NO: "disconnected",
                 EvidenceState.UNKNOWN: "unknown"}[authentication]
    recovery = {
        RecoveryPhase.PLANNED: "disabled", RecoveryPhase.BLOCKED: "disabled",
        RecoveryPhase.NOT_ATTEMPTED: "failed", RecoveryPhase.HUMAN_REQUIRED: "human-required",
        RecoveryPhase.IN_PROGRESS: "in-progress", RecoveryPhase.RECONCILIATION_REQUIRED: "in-progress",
        RecoveryPhase.UNKNOWN: "unknown", RecoveryPhase.COMPLETED: "completed",
    }[recovery_phase]
    payload = {
        "schemaVersion": "1.0.0", "statusId": status_id,
        "gatewayId": assessment.target.gateway_id, "environment": assessment.target.environment.value,
        "observedAt": observed_at, "infrastructure": infrastructure, "brokerHandshake": handshake,
        "recovery": recovery, "trading": "disabled", "reasonCodes": list(assessment.reason_codes),
        "lastHumanRequestId": last_human_request_id,
    }
    if contracts.validate("BrokerRecoveryStatus", payload, schema_version="1.0.0") is not True:
        raise ValueError("status_contract_rejected")
    return freeze(payload)
