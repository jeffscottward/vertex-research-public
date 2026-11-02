"""Optional gateway adapter. It neither recovers gateways nor authorizes actions.

A lease only proves this PAPER simulator owner is quiescent. It is NOT a live
execution guard. Recovery still needs gateway's separate point-of-risk human
admission. New-risk pause persists after every exit, success or failure.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Callable, Iterator, Protocol

from vertex_gateway.models import Environment, EvidenceState, RecoveryBinding, RecoveryOperation
from vertex_gateway.ports import SafetyLease

from .exact import units
from .owner import PaperExecutionOwner
from .ports import ExecutionError


class GatewayBindingVerifier(Protocol):
    """Bounded trusted local attestation, never cloud IO or arbitrary hashes.

    Privately map registry-issued opaque account_ref to exact local owner alias.
    Match expected_status_id to current attested gateway/session generation,
    protocol/gateway/account/environment and pinned owner epoch + journal sequence.
    Stale, revoked, unknown or absent mappings must deny. No account is returned.
    """
    def verify_binding(self, binding: RecoveryBinding, *, account_alias: str,
                       environment: str, owner_epoch: int, journal_sequence: int,
                       now_ns: int) -> bool: ...


class FencedExecutionSafetyPort:
    def __init__(self, owner: PaperExecutionOwner, *, clock_ns: Callable[[], int],
                 verifier: GatewayBindingVerifier, maximum_lease_ns: int) -> None:
        if type(maximum_lease_ns) is not int or maximum_lease_ns <= 0:
            raise ExecutionError("explicit-disruption-lease-policy-required")
        self.owner, self.clock_ns, self.verifier = owner, clock_ns, verifier
        self.maximum_lease_ns = maximum_lease_ns
        self._active: tuple[str, int, int, int, str] | None = None

    @contextmanager
    def hold(self, binding: RecoveryBinding) -> Iterator[SafetyLease]:
        owner, journal = self.owner, self.owner.journal
        with journal.mutex:
            if self._active is not None or owner._disruption_held:
                raise ExecutionError("disruption-lease-already-held")
            now_ns = self.clock_ns()
            if (binding.target.environment is not Environment.PAPER
                    or binding.operation not in {RecoveryOperation.RESTART_GATEWAY, RecoveryOperation.RESCAN_READ_ONLY}
                    or not (binding.confirmed_ns <= now_ns < binding.expires_ns)):
                raise ExecutionError("disruption-scope-or-expiry-invalid")
            owner._fresh_observation(now_ns)
            state = journal.state
            # This implementation has no live protection transport. It therefore
            # grants only VACUOUS continuity: zero unsettled/open obligations and
            # zero positions. Never invent a positive protection attestation.
            if (not state["reconciled"] or state["invalidQualifications"]
                    or state["unsettledCredits"] or state["unsettledPositions"]
                    or any(units(value) != 0 for value in state["positions"].values())
                    or any(o["reservationState"] != "released" or not o["finalityProven"] for o in state["orders"].values())):
                raise ExecutionError("disruption-has-unresolved-protection-obligations")
            owner.pause_new_risk("gateway-disruption-fence", now_ns=now_ns)
            epoch, sequence = owner.epoch, journal.sequence
            if self.verifier.verify_binding(binding, account_alias=state["accountAlias"], environment="paper",
                                            owner_epoch=epoch, journal_sequence=sequence, now_ns=now_ns) is not True:
                raise ExecutionError("gateway-binding-not-current-under-fence")
            expiry = min(binding.expires_ns, now_ns + self.maximum_lease_ns,
                         int(journal.state["observation"]["validUntilNs"]))
            guard_ref = "guard-" + owner.authority.digest({"bindingDigest": binding.digest,
                        "ownerEpoch": str(epoch), "journalSequence": str(sequence), "expiresNs": str(expiry)})
            lease = SafetyLease(guard_ref, binding.digest, expiry, EvidenceState.YES, EvidenceState.YES,
                                EvidenceState.YES, EvidenceState.YES, EvidenceState.YES, EvidenceState.YES)
            # Persisted pause commits BEFORE holding this writer transaction. No
            # remote action is implemented here. The admin recovery executor must
            # check lease.permits at actual effect time and never outlive context.
            with journal.transaction():
                owner._disruption_held = True
                self._active = (binding.digest, epoch, sequence, expiry, guard_ref)
                try:
                    yield lease
                finally:
                    self._active = None
                    owner._disruption_held = False
            # Deliberately no reset/rearm, including successful recovery.

    def lease_valid(self, binding: RecoveryBinding, lease: SafetyLease) -> bool:
        with self.owner.journal.mutex:
            if self._active is None:
                return False
            digest, epoch, sequence, expiry, guard_ref = self._active
            return (digest == binding.digest and self.owner._disruption_held
                    and epoch == self.owner.epoch == self.owner.journal.epoch
                    and sequence == self.owner.journal.sequence
                    and guard_ref == lease.guard_ref
                    and expiry == lease.expires_ns and lease.permits(binding, self.clock_ns()))
