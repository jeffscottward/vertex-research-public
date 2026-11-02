"""Recovery is a separately authorized workflow, never trading rearm.

No default executor, network transport, startup action, authentication automation,
or retry is implemented. The public request asks for human recovery; a separate
server challenge must approve the EXACT disruptive operation before dispatch.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any

from .models import (
    Dimension, EvidenceState, GatewayTarget, HostTrust, RecoveryBinding,
    RecoveryOperation, RecoveryPhase, RecoveryPlan, RecoveryResult, freeze,
    nanoseconds, reference,
)
from .ports import (
    AuditEvent, AuditPort, CanonicalCodecPort, ClockPort, DispatchDisposition, DispatchReceipt,
    ExecutionSafetyPort, GatewayStatusPort, HostTrustPort, HumanAdmission,
    PublicContractPort, ReconciliationPort, RecoveryExecutorPort,
    RecoveryJournalPort, SafetyLease, ServerAuthorizationPort, ServerSession,
)


@dataclass(frozen=True)
class RecoveryPolicy:
    max_status_age_ns: int = 30_000_000_000
    max_challenge_age_ns: int = 300_000_000_000
    max_reconciliation_age_ns: int = 30_000_000_000
    dispatch_enabled: bool = False
    allowed_operations: frozenset[RecoveryOperation] = frozenset()

    def __post_init__(self) -> None:
        for value in (self.max_status_age_ns, self.max_challenge_age_ns,
                      self.max_reconciliation_age_ns):
            if nanoseconds(value) <= 0:
                raise ValueError("invalid_recovery_policy")
        if self.max_challenge_age_ns > 300_000_000_000:
            raise ValueError("challenge_window_cannot_be_relaxed")
        if (type(self.dispatch_enabled) is not bool or type(self.allowed_operations) is not frozenset
                or any(not isinstance(op, RecoveryOperation) for op in self.allowed_operations)):
            raise ValueError("invalid_recovery_policy")


class RecoveryCoordinator:
    def __init__(self, *, contracts: PublicContractPort, codec: CanonicalCodecPort, clock: ClockPort,
                 status: GatewayStatusPort, policy: RecoveryPolicy = RecoveryPolicy(),
                 trust: HostTrustPort | None = None,
                 authorization: ServerAuthorizationPort | None = None,
                 safety: ExecutionSafetyPort | None = None,
                 journal: RecoveryJournalPort | None = None,
                 audit: AuditPort | None = None,
                 executor: RecoveryExecutorPort | None = None,
                 reconciliation: ReconciliationPort | None = None) -> None:
        self._contracts = contracts
        self._codec = codec
        self._clock = clock
        self._status = status
        self._policy = policy
        self._trust = trust
        self._authorization = authorization
        self._safety = safety
        self._journal = journal
        self._audit = audit
        self._executor = executor
        self._reconciliation = reconciliation

    def _now(self) -> int:
        return nanoseconds(self._clock.now_ns())

    def _fresh(self, binding: RecoveryBinding, now: int) -> bool:
        return (binding.confirmed_ns <= binding.requested_ns <= now < binding.expires_ns
                and now - binding.confirmed_ns <= self._policy.max_challenge_age_ns
                and binding.expires_ns - binding.confirmed_ns <= self._policy.max_challenge_age_ns)

    def plan(self, request: Any, target: GatewayTarget,
             operation: RecoveryOperation = RecoveryOperation.HUMAN_HANDOFF) -> RecoveryPlan:
        """Read-only/dry-run. No trust transport, audit, challenge consume or effect.

        A plan is explicitly non-executable and is recomputed at dispatch. Status
        comes only from the server-owned current-status port, not from the user.
        Contract-validator failures are sanitized and fail closed.
        """
        try:
            if not isinstance(operation, RecoveryOperation):
                raise ValueError("invalid_operation")
            current_payload = self._status.current(target)
            if self._contracts.validate("BrokerRecoveryStatus", current_payload, schema_version="1.0.0") is not True:
                raise ValueError("status_contract_rejected")
            current = freeze(current_payload)
            if self._contracts.validate("RecoveryRequest", request, schema_version="1.0.0") is not True:
                raise ValueError("request_contract_rejected")
            value = freeze(request)
            canonical_bytes = self._codec.encode(value)
            if type(canonical_bytes) is not bytes:
                raise ValueError("canonical_bytes_required")
            now = self._now()
            status_ns = nanoseconds(self._contracts.epoch_ns(current["observedAt"]))
            if (value["gatewayId"] != target.gateway_id or current["gatewayId"] != target.gateway_id
                    or value["environment"] != target.environment.value
                    or current["environment"] != target.environment.value):
                return RecoveryPlan(None, RecoveryPhase.BLOCKED, ("recovery-target-mismatch",))
            if value["expectedStatusId"] != current["statusId"]:
                return RecoveryPlan(None, RecoveryPhase.BLOCKED, ("recovery-status-changed",))
            if not 0 <= now - status_ns <= self._policy.max_status_age_ns:
                return RecoveryPlan(None, RecoveryPhase.BLOCKED, ("recovery-status-stale",))
            binding = RecoveryBinding(
                target, operation, value["requestId"], value["idempotencyKey"], current["statusId"],
                value["confirmation"]["actorId"], value["confirmation"]["challengeId"],
                nanoseconds(self._contracts.epoch_ns(value["requestedAt"])),
                nanoseconds(self._contracts.epoch_ns(value["confirmation"]["confirmedAt"])),
                nanoseconds(self._contracts.epoch_ns(value["expiresAt"])),
                sha256(canonical_bytes).hexdigest(),
            )
            if not self._fresh(binding, now):
                return RecoveryPlan(None, RecoveryPhase.BLOCKED, ("recovery-challenge-not-current",))
            prerequisites = (
                "provider-console-host-trust", "fresh-server-human-challenge",
                "exact-account-environment-operation", "durable-one-time-admission",
                "local-execution-safety-fence", "human-login-and-2fa-if-required",
                "post-attempt-broker-reconciliation", "separate-trading-rearm-authority",
                "separate-local-kill-reset-authority",
            )
            codes = ("dry-run-only", "confirmation-text-is-not-authorization", "trading-disabled")
            return RecoveryPlan(binding, RecoveryPhase.PLANNED, codes, prerequisites)
        except Exception:
            return RecoveryPlan(None, RecoveryPhase.BLOCKED, ("recovery-contract-or-status-unavailable",))

    def _audit_event(self, code: str, binding: RecoveryBinding, now: int) -> AuditEvent:
        return AuditEvent(code, binding.target.digest, binding.digest, binding.operation.value,
                          binding.target.environment.value, now)

    def _valid_admission(self, admission: HumanAdmission, binding: RecoveryBinding, now: int) -> bool:
        try:
            reference(admission.attempt_ref)
            for value in (admission.authenticated_ns, admission.challenge_verified_ns, admission.expires_ns):
                nanoseconds(value)
            return (admission.binding_digest == binding.digest
                    and admission.human_verified is EvidenceState.YES
                    and admission.durable_claim is EvidenceState.YES
                    and admission.challenge_verified_ns == binding.confirmed_ns
                    and 0 <= now - admission.authenticated_ns <= self._policy.max_challenge_age_ns
                    and 0 <= now - admission.challenge_verified_ns <= self._policy.max_challenge_age_ns
                    and now < admission.expires_ns <= binding.expires_ns)
        except Exception:
            return False

    def attempt(self, request: Any, target: GatewayTarget, operation: RecoveryOperation,
                session: ServerSession) -> RecoveryResult:
        """Opt-in future dispatch. Never retry any port or executor call.

        Admission is durable UNKNOWN before dispatch. Once admission may have
        happened, every ambiguous failure stays UNKNOWN, including audit/journal
        failures. An ACK is reconciliation-required, never completed.
        """
        plan = self.plan(request, target, operation)
        if plan.binding is None:
            return RecoveryResult(RecoveryPhase.BLOCKED, plan.reason_codes)
        binding = plan.binding
        if operation is RecoveryOperation.HUMAN_HANDOFF:
            return RecoveryResult(RecoveryPhase.HUMAN_REQUIRED, ("login-and-2fa-human-only",))
        if not self._policy.dispatch_enabled or operation not in self._policy.allowed_operations:
            return RecoveryResult(RecoveryPhase.BLOCKED, ("recovery-dispatch-disabled",))
        if not isinstance(session, ServerSession):
            return RecoveryResult(RecoveryPhase.BLOCKED, ("server-session-required",))
        if any(port is None for port in (self._trust, self._authorization, self._safety,
                                         self._journal, self._audit, self._executor)):
            return RecoveryResult(RecoveryPhase.BLOCKED, ("recovery-ports-unavailable",))
        admission = None
        admission_started = False
        try:
            trust = self._trust.inspect(target)
            now = self._now()
            if not isinstance(trust, HostTrust) or not trust.current(target, now):
                return RecoveryResult(RecoveryPhase.BLOCKED, ("host-trust-unverified",))
            with self._safety.hold(binding) as lease:
                now = self._now()
                if not isinstance(lease, SafetyLease) or not lease.permits(binding, now):
                    return RecoveryResult(RecoveryPhase.BLOCKED, ("execution-safety-guard-denied",))
                reference(lease.guard_ref)
                if not self._fresh(binding, now) or not trust.current(target, now):
                    return RecoveryResult(RecoveryPhase.BLOCKED, ("recovery-prerequisite-expired",))
                # Point-of-risk verification/consume and account+gateway claim are
                # one server transaction; never trust public confirmation alone.
                admission_started = True
                admission = self._authorization.admit_once(session, binding, now, lease.guard_ref)
                if admission is None:
                    admission_started = False
                    return RecoveryResult(RecoveryPhase.BLOCKED, ("human-challenge-or-replay-denied",))
                now = self._now()
                if not isinstance(admission, HumanAdmission) or not self._valid_admission(admission, binding, now):
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("human-admission-unverifiable",))
                if self._audit.append(self._audit_event("recovery-dispatch-admitted", binding, now)) is not True:
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-audit-unavailable",), admission.attempt_ref)
                if self._journal.mark_dispatching(binding, admission, now) is not True:
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-journal-unavailable",), admission.attempt_ref)
                now = self._now()
                if (not self._fresh(binding, now) or not self._valid_admission(admission, binding, now)
                        or not lease.permits(binding, now) or not trust.current(target, now)):
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-fence-or-authority-expired",), admission.attempt_ref)
                receipt = self._executor.dispatch_once(binding, admission, lease)
                if (not isinstance(receipt, DispatchReceipt) or receipt.attempt_ref != admission.attempt_ref
                        or receipt.binding_digest != binding.digest):
                    phase = RecoveryPhase.UNKNOWN
                elif receipt.disposition is DispatchDisposition.ACCEPTED:
                    phase = RecoveryPhase.RECONCILIATION_REQUIRED
                elif receipt.disposition is DispatchDisposition.DEFINITELY_NOT_ATTEMPTED:
                    phase = RecoveryPhase.NOT_ATTEMPTED
                else:
                    phase = RecoveryPhase.UNKNOWN
                now = self._now()
                if self._journal.mark_outcome(binding, admission, phase, now) is not True:
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-outcome-not-durable",), admission.attempt_ref)
                if self._audit.append(self._audit_event("recovery-" + phase.value, binding, now)) is not True:
                    return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-outcome-audit-unavailable",), admission.attempt_ref)
                return RecoveryResult(phase, ("recovery-" + phase.value, "no-automatic-retry", "trading-disabled"), admission.attempt_ref)
        except Exception:
            # Even an executor exception raised before sending cannot establish
            # no-send; retain the durable claim for manual reconciliation.
            phase = RecoveryPhase.UNKNOWN if admission_started else RecoveryPhase.BLOCKED
            attempt_ref = admission.attempt_ref if isinstance(admission, HumanAdmission) else None
            return RecoveryResult(phase, ("recovery-unavailable-or-uncertain", "no-automatic-retry"), attempt_ref)

    def reconcile(self, binding: RecoveryBinding, admission: HumanAdmission) -> RecoveryResult:
        """Explicit operator-driven evidence review, never an automatic retry.

        Journal adapter must CAS an unresolved attempt and verify that the proof
        is later than its actual dispatch, not merely the initial request time.
        No execution/authentication/rearm/kill-switch-reset port is invoked.
        """
        if self._reconciliation is None or self._journal is None or self._audit is None:
            return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-reconciliation-unavailable",))
        try:
            if admission.binding_digest != binding.digest:
                return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-reconciliation-mismatch",))
            proof = self._reconciliation.inspect(binding, admission)
            now = self._now()
            if (proof is None or proof.attempt_ref != admission.attempt_ref
                    or any(type(value) is not int for value in (
                        proof.observed_after_ns, proof.reviewed_ns, proof.expires_ns, proof.assessment.assessed_ns))
                    or proof.binding_digest != binding.digest
                    or proof.human_reviewed is not EvidenceState.YES
                    or proof.recovery_complete is not EvidenceState.YES
                    or not (binding.requested_ns < proof.observed_after_ns <= proof.reviewed_ns <= now < proof.expires_ns)
                    or now - proof.observed_after_ns > self._policy.max_reconciliation_age_ns
                    or proof.assessment.assessed_ns < proof.observed_after_ns
                    or not 0 <= now - proof.assessment.assessed_ns <= self._policy.max_reconciliation_age_ns
                    or proof.assessment.target != binding.target
                    or proof.assessment.host_trust is not EvidenceState.YES
                    or proof.assessment.read_only_ready is not EvidenceState.YES
                    or proof.assessment.state(Dimension.RECONCILED) is not EvidenceState.YES):
                return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-reconciliation-unproven",), admission.attempt_ref)
            if self._audit.append(self._audit_event("recovery-reconciliation-reviewed", binding, now)) is not True:
                return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-audit-unavailable",), admission.attempt_ref)
            if self._journal.mark_reconciled(binding, admission, proof, now) is not True:
                return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-completion-not-durable",), admission.attempt_ref)
            return RecoveryResult(RecoveryPhase.COMPLETED,
                                  ("connectivity-reconciled", "trading-disabled", "kill-switch-unchanged"), admission.attempt_ref)
        except Exception:
            return RecoveryResult(RecoveryPhase.UNKNOWN, ("recovery-reconciliation-unavailable", "no-automatic-retry"))
