"""Authored-only coordinator tests with synthetic ports, no network/processes.

The recorder below is NOT a public schema validator or production authorization
adapter. These exercise delegation/coordination; integration must separately run
real @darkfactory/api/vertex validation and durable server/edge adapter tests.
"""
from contextlib import contextmanager
from dataclasses import asdict, replace
from hashlib import sha256
import json
from threading import Lock
import unittest

from vertex_gateway.models import (
    Dimension, DimensionAssessment, Environment, EvidenceState, GatewayProtocol,
    GatewayTarget, HostTrust, ReadinessAssessment, RecoveryOperation, RecoveryPhase,
)
from vertex_gateway.ports import (
    DispatchDisposition, DispatchReceipt, HumanAdmission, ReconciliationProof,
    SafetyLease, ServerSession,
)
from vertex_gateway.recovery import RecoveryCoordinator, RecoveryPolicy


NOW = 1_000_000_000_000
TARGET = GatewayTarget("gateway-fixture", "acctref-" + "a" * 64,
                       Environment.PAPER, GatewayProtocol.TWS_SOCKET)
REQUESTED = "2026-09-22T12:00:00.000000001Z"
CONFIRMED = "2026-09-22T12:00:00.000000000Z"
EXPIRES = "2026-09-22T12:00:30.000000000Z"
OBSERVED = "2026-09-22T11:59:59.999999999Z"
TIMES = {REQUESTED: NOW - 1, CONFIRMED: NOW - 2,
         EXPIRES: NOW + 30_000_000_000, OBSERVED: NOW - 3}


def request_fixture():
    return {
        "schemaVersion": "1.0.0", "requestId": "request-fixture",
        "idempotencyKey": "idempotency-fixture", "correlationId": "correlation-fixture",
        "gatewayId": TARGET.gateway_id, "expectedStatusId": "status-fixture",
        "environment": "paper", "action": "request-human-recovery",
        "requestedAt": REQUESTED, "expiresAt": EXPIRES, "executionAuthorized": False,
        "confirmation": {"kind": "human", "actorId": "actor-fixture", "challengeId": "challenge-fixture",
                         "confirmedAt": CONFIRMED, "statement": "opaque-authoritative-test-fixture"},
    }


def status_fixture():
    return {"schemaVersion": "1.0.0", "statusId": "status-fixture", "gatewayId": TARGET.gateway_id,
            "environment": "paper", "observedAt": OBSERVED, "infrastructure": "observed",
            "brokerHandshake": "unknown", "recovery": "human-required", "trading": "disabled",
            "reasonCodes": ["fixture-only"], "lastHumanRequestId": None}


def thaw(value):
    if hasattr(value, "items"):
        return {key: thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [thaw(item) for item in value]
    return value


class ContractRecorder:
    def __init__(self):
        self.calls = []
        self.reject = None
        self.times = dict(TIMES)
        self.result = True
        self.versions = []

    def validate(self, contract_name, value, schema_version="1.0.0"):
        self.calls.append(contract_name)
        self.versions.append(schema_version)
        if contract_name == self.reject:
            raise ValueError("private-provider-text-must-not-escape")
        return self.result

    def epoch_ns(self, timestamp):
        return self.times[timestamp]


class Codec:
    def encode(self, value):
        # Fixture identity only; production uses authoritative canonical codec.
        return json.dumps(thaw(value), sort_keys=True).encode()


class Clock:
    now = NOW

    def now_ns(self):
        return self.now


class Status:
    def __init__(self):
        self.value = status_fixture()

    def current(self, target):
        return self.value


class Trust:
    def __init__(self):
        self.calls = 0
        self.value = HostTrust(TARGET.digest, EvidenceState.YES, "trust-fixture",
                               NOW - 10, NOW + 300_000_000_000, True)

    def inspect(self, target):
        self.calls += 1
        return self.value


class Guard:
    def __init__(self):
        self.calls = 0
        self.active = False
        self.change = {}
        self.on_enter = None

    @contextmanager
    def hold(self, binding):
        self.calls += 1
        self.active = True
        try:
            if self.on_enter is not None:
                self.on_enter()
            yield replace(SafetyLease("guard-fixture", binding.digest, NOW + 300_000_000_000,
                                      *([EvidenceState.YES] * 6)), **self.change)
        finally:
            self.active = False


class Authorization:
    """Single-test atomic fixture only. Never shipped as a durable server adapter."""
    def __init__(self, guard, shared=None):
        self.calls = 0
        self.guard = guard
        self.shared = shared if shared is not None else {"lock": Lock(), "claimed": False}
        self.approved_digest = None
        self.change = {}
        self.fail_after_claim = False
        self.last = None

    def admit_once(self, session, binding, now_ns, guard_ref):
        self.calls += 1
        if (not self.guard.active or guard_ref != "guard-fixture"
                or session.session_ref != "session-fixture" or binding.digest != self.approved_digest):
            return None
        with self.shared["lock"]:
            if self.shared["claimed"]:
                return None
            self.shared["claimed"] = True
            self.shared["state"] = "admitted-unknown"
        if self.fail_after_claim:
            raise TimeoutError("private-server-session-detail")
        self.last = replace(HumanAdmission("attempt-fixture", binding.digest, NOW - 2,
                                          binding.confirmed_ns, binding.expires_ns,
                                          EvidenceState.YES, EvidenceState.YES), **self.change)
        return self.last


class Journal:
    def __init__(self, authorization):
        self.authorization = authorization
        self.calls = []
        self.dispatch_ok = True
        self.outcome_ok = True
        self.reconciled_ok = True

    def mark_dispatching(self, binding, admission, now_ns):
        self.calls.append("dispatching")
        if not self.dispatch_ok:
            return False
        if self.authorization.shared.get("state") != "admitted-unknown":
            return False
        self.authorization.shared["state"] = "dispatching-unknown"
        self.authorization.shared["dispatch_ns"] = now_ns
        return True

    def mark_outcome(self, binding, admission, phase, now_ns):
        self.calls.append(phase)
        if phase is RecoveryPhase.COMPLETED:
            raise AssertionError("completion requires separate proof-aware CAS")
        if self.outcome_ok:
            self.authorization.shared["state"] = phase
        return self.outcome_ok

    def mark_reconciled(self, binding, admission, proof, now_ns):
        self.calls.append("reconciled")
        return (self.reconciled_ok and proof.observed_after_ns > self.authorization.shared["dispatch_ns"]
                and proof.attempt_ref == admission.attempt_ref and proof.binding_digest == binding.digest)


class Audit:
    def __init__(self):
        self.events = []
        self.reject_number = 0
        self.on_append = None

    def append(self, event):
        self.events.append(event)
        if self.on_append is not None:
            self.on_append()
        return len(self.events) != self.reject_number


class Executor:
    def __init__(self, guard, authorization):
        self.guard = guard
        self.authorization = authorization
        self.calls = 0
        self.fail = False
        self.disposition = DispatchDisposition.ACCEPTED
        self.change = {}

    def dispatch_once(self, binding, admission, lease):
        self.calls += 1
        if not self.guard.active or self.authorization.shared.get("state") != "dispatching-unknown":
            raise AssertionError("dispatch escaped fence or durable journal")
        if self.fail:
            raise TimeoutError("private-route-or-account-must-not-escape")
        return replace(DispatchReceipt(admission.attempt_ref, binding.digest, self.disposition), **self.change)


class Reconciliation:
    proof = None

    def inspect(self, binding, admission):
        return self.proof


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.contracts = ContractRecorder()
        self.clock = Clock()
        self.status = Status()
        self.trust = Trust()
        self.guard = Guard()
        self.auth = Authorization(self.guard)
        self.journal = Journal(self.auth)
        self.audit = Audit()
        self.executor = Executor(self.guard, self.auth)
        self.reconciliation = Reconciliation()
        self.request = request_fixture()
        self.policy = RecoveryPolicy(dispatch_enabled=True, allowed_operations=frozenset({RecoveryOperation.RESTART_GATEWAY,
                                                                                      RecoveryOperation.RESCAN_READ_ONLY}))
        self.service = self.make_service()
        self.session = ServerSession("session-fixture")
        self.operation = RecoveryOperation.RESTART_GATEWAY
        self.binding = self.service.plan(self.request, TARGET, self.operation).binding
        self.auth.approved_digest = self.binding.digest

    def make_service(self, **changes):
        kwargs = dict(contracts=self.contracts, codec=Codec(), clock=self.clock, status=self.status, policy=self.policy,
                      trust=self.trust, authorization=self.auth, safety=self.guard, journal=self.journal,
                      audit=self.audit, executor=self.executor, reconciliation=self.reconciliation)
        kwargs.update(changes)
        return RecoveryCoordinator(**kwargs)

    def attempt(self, **changes):
        kwargs = dict(request=self.request, target=TARGET, operation=self.operation, session=self.session)
        kwargs.update(changes)
        return self.service.attempt(**kwargs)

    def test_plan_is_pure_nonexecutable_and_delegates_both_public_schemas(self):
        plan = self.service.plan(self.request, TARGET, self.operation)
        self.assertEqual(plan.phase, RecoveryPhase.PLANNED)
        self.assertFalse(plan.executable)
        self.assertEqual(self.contracts.calls[-2:], ["BrokerRecoveryStatus", "RecoveryRequest"])
        self.assertEqual(self.contracts.versions[-2:], ["1.0.0", "1.0.0"])
        self.assertEqual((self.trust.calls, self.guard.calls, self.auth.calls, self.executor.calls), (0, 0, 0, 0))
        self.assertEqual(self.audit.events, [])
        self.assertIn("separate-local-kill-reset-authority", plan.prerequisite_codes)

    def test_only_literal_true_from_authoritative_validator_is_accepted(self):
        for verdict in (False, None, 1, "true", {}, {"valid": True}, self.request):
            with self.subTest(verdict=verdict):
                self.contracts.result = verdict
                self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)

    def test_request_digest_hashes_exact_injected_canonical_utf8_bytes(self):
        encoded = b'{"fixture":"exact-canonical-bytes"}'

        class ExactCodec:
            def encode(self, value):
                return encoded

        service = self.make_service(codec=ExactCodec())
        self.assertEqual(service.plan(self.request, TARGET, self.operation).binding.request_digest,
                         sha256(encoded).hexdigest())

        class InvalidCodec:
            def encode(self, value):
                return encoded.decode()

        self.assertEqual(self.make_service(codec=InvalidCodec()).plan(self.request, TARGET).phase,
                         RecoveryPhase.BLOCKED)

    def test_import_and_default_configuration_do_not_dispatch(self):
        service = self.make_service(policy=RecoveryPolicy())
        result = service.attempt(self.request, TARGET, self.operation, self.session)
        self.assertEqual(result.reason_codes, ("recovery-dispatch-disabled",))
        self.assertEqual((self.trust.calls, self.auth.calls, self.executor.calls), (0, 0, 0))

    def test_confirmation_text_without_actual_server_grant_cannot_authorize(self):
        self.auth.approved_digest = None
        result = self.attempt()
        self.assertEqual(result.phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)

    def test_missing_ports_and_nonserver_session_fail_closed(self):
        for name in ("authorization", "safety", "journal", "audit", "executor", "trust"):
            with self.subTest(name=name):
                service = self.make_service(**{name: None})
                result = service.attempt(self.request, TARGET, self.operation, self.session)
                self.assertEqual(result.phase, RecoveryPhase.BLOCKED)
        result = self.attempt(session={"kind": "human", "confirmed": True})
        self.assertEqual(result.reason_codes, ("server-session-required",))
        self.assertEqual(self.executor.calls, 0)

    def test_human_login_is_external_and_never_calls_auth_or_executor(self):
        result = self.attempt(operation=RecoveryOperation.HUMAN_HANDOFF)
        self.assertEqual(result.phase, RecoveryPhase.HUMAN_REQUIRED)
        self.assertEqual((self.trust.calls, self.guard.calls, self.auth.calls, self.executor.calls), (0, 0, 0, 0))

    def test_request_shape_and_status_failures_are_sanitized(self):
        for name in ("RecoveryRequest", "BrokerRecoveryStatus"):
            with self.subTest(name=name):
                self.contracts.reject = name
                result = self.attempt()
                self.assertEqual(result.phase, RecoveryPhase.BLOCKED)
                self.assertNotIn("private", repr(result))
        self.assertEqual(self.executor.calls, 0)

    def test_binding_includes_account_environment_protocol_and_exact_operation(self):
        cases = [dict(target=replace(TARGET, account_ref="acctref-" + "b" * 64)),
                 dict(target=replace(TARGET, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)),
                 dict(operation=RecoveryOperation.RESCAN_READ_ONLY)]
        for changes in cases:
            with self.subTest(changes=changes):
                result = self.attempt(**changes)
                self.assertEqual(result.phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)
        self.assertNotEqual(self.binding.digest, replace(self.binding, target=replace(TARGET, environment=Environment.LIVE)).digest)

    def test_changed_request_idempotency_challenge_actor_and_body_are_denied(self):
        for key in ("requestId", "idempotencyKey", "correlationId"):
            with self.subTest(key=key):
                changed = {**self.request, key: "changed"}
                self.assertEqual(self.attempt(request=changed).phase, RecoveryPhase.BLOCKED)
        for key in ("actorId", "challengeId", "statement"):
            changed = {**self.request, "confirmation": {**self.request["confirmation"], key: "changed"}}
            self.assertEqual(self.attempt(request=changed).phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)

    def test_status_revision_environment_and_time_must_be_current(self):
        for changes, reason in [({"statusId": "new-status"}, "recovery-status-changed"),
                                ({"environment": "live"}, "recovery-target-mismatch"),
                                ({"gatewayId": "other-gateway"}, "recovery-target-mismatch")]:
            with self.subTest(changes=changes):
                self.status.value = {**status_fixture(), **changes}
                self.assertEqual(self.attempt().reason_codes, (reason,))
        self.status.value = status_fixture()
        self.contracts.times[OBSERVED] = NOW - self.policy.max_status_age_ns - 1
        self.assertEqual(self.attempt().reason_codes, ("recovery-status-stale",))
        self.contracts.times[OBSERVED] = NOW + 1
        self.assertEqual(self.attempt().reason_codes, ("recovery-status-stale",))

    def test_one_nanosecond_expiry_and_future_confirmation_fail_closed(self):
        self.contracts.times[EXPIRES] = NOW
        self.assertEqual(self.attempt().reason_codes, ("recovery-challenge-not-current",))
        self.contracts.times[EXPIRES] = TIMES[EXPIRES]
        self.contracts.times[CONFIRMED] = NOW + 1
        self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.auth.calls, 0)

    def test_unknown_untrusted_or_expired_host_blocks_before_guard(self):
        for change in ({"state": EvidenceState.UNKNOWN}, {"state": EvidenceState.NO},
                       {"strict_verification": False}, {"expires_ns": NOW},
                       {"verified_ns": NOW + 1}, {"target_digest": "b" * 64}):
            with self.subTest(change=change):
                self.trust.value = replace(Trust().value, **change)
                self.assertEqual(self.attempt().reason_codes, ("host-trust-unverified",))
        self.assertEqual((self.guard.calls, self.auth.calls, self.executor.calls), (0, 0, 0))

    def test_every_execution_guard_dimension_must_be_known_safe(self):
        for field in ("owner_fenced", "new_risk_paused", "submission_journal_reconciled", "no_inflight_mutations",
                      "protection_continuity_proven", "disruption_safe"):
            for state in (EvidenceState.UNKNOWN, EvidenceState.NO):
                with self.subTest(field=field, state=state):
                    self.guard.change = {field: state}
                    self.assertEqual(self.attempt().reason_codes, ("execution-safety-guard-denied",))
        self.assertEqual(self.auth.calls, 0)

    def test_status_checked_again_by_guard_and_expiry_rechecked_after_wait(self):
        self.guard.on_enter = lambda: setattr(self.clock, "now", TIMES[EXPIRES])
        self.assertEqual(self.attempt().reason_codes, ("recovery-prerequisite-expired",))
        self.assertEqual(self.auth.calls, 0)

    def test_authenticated_session_identity_is_server_verified(self):
        self.assertEqual(self.attempt(session=ServerSession("other-session")).phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)

    def test_mismatched_stale_unknown_or_non_durable_human_receipt_is_uncertain(self):
        cases = [{"binding_digest": "b" * 64}, {"authenticated_ns": NOW - 300_000_000_001},
                 {"authenticated_ns": NOW + 1}, {"challenge_verified_ns": NOW - 3},
                 {"human_verified": EvidenceState.UNKNOWN}, {"durable_claim": EvidenceState.NO},
                 {"expires_ns": NOW}, {"expires_ns": TIMES[EXPIRES] + 1}]
        for change in cases:
            with self.subTest(change=change):
                self.auth.shared["claimed"] = False
                self.auth.change = change
                result = self.attempt()
                self.assertEqual(result.phase, RecoveryPhase.UNKNOWN)
        self.assertEqual(self.executor.calls, 0)

    def test_acknowledgement_needs_reconciliation_and_does_not_rearm(self):
        result = self.attempt()
        self.assertEqual(result.phase, RecoveryPhase.RECONCILIATION_REQUIRED)
        self.assertEqual(self.executor.calls, 1)
        self.assertEqual(self.journal.calls, ["dispatching", RecoveryPhase.RECONCILIATION_REQUIRED])
        self.assertFalse(self.guard.active)
        self.assertFalse(result.retry_allowed)
        self.assertFalse(result.kill_switch_reset)
        self.assertEqual(result.trading, "disabled")

    def test_challenge_and_idempotency_replay_never_dispatch_twice(self):
        self.assertEqual(self.attempt().phase, RecoveryPhase.RECONCILIATION_REQUIRED)
        self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 1)

    def test_recreated_coordinator_cannot_retry_unresolved_claim(self):
        self.executor.fail = True
        self.assertEqual(self.attempt().phase, RecoveryPhase.UNKNOWN)
        self.service = self.make_service()
        self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 1)

    def test_admission_lost_ack_never_dispatches_or_blindly_retries(self):
        self.auth.fail_after_claim = True
        result = self.attempt()
        self.assertEqual(result.phase, RecoveryPhase.UNKNOWN)
        self.assertNotIn("private", repr(result))
        self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)
        self.assertEqual(self.executor.calls, 0)

    def test_audit_and_journal_must_be_durable_before_dispatch(self):
        self.audit.reject_number = 1
        self.assertEqual(self.attempt().reason_codes, ("recovery-audit-unavailable",))
        self.assertEqual(self.executor.calls, 0)
        self.auth.shared["claimed"] = False
        self.audit.reject_number = 0
        self.journal.dispatch_ok = False
        self.assertEqual(self.attempt().reason_codes, ("recovery-journal-unavailable",))
        self.assertEqual(self.executor.calls, 0)

    def test_authority_expiry_during_audit_burns_claim_but_does_not_dispatch(self):
        self.audit.on_append = lambda: setattr(self.clock, "now", TIMES[EXPIRES])
        result = self.attempt()
        self.assertEqual(result.phase, RecoveryPhase.UNKNOWN)
        self.assertEqual(self.executor.calls, 0)

    def test_post_dispatch_persistence_failure_is_unknown_not_success(self):
        self.journal.outcome_ok = False
        self.assertEqual(self.attempt().reason_codes, ("recovery-outcome-not-durable",))
        self.assertEqual(self.executor.calls, 1)

    def test_post_dispatch_audit_failure_is_unknown(self):
        self.audit.reject_number = 2
        self.assertEqual(self.attempt().reason_codes, ("recovery-outcome-audit-unavailable",))
        self.assertEqual(self.executor.calls, 1)

    def test_timeout_partial_unknown_or_mismatched_ack_never_completes(self):
        for change in ({"attempt_ref": "other-attempt"}, {"binding_digest": "b" * 64},
                       {"disposition": DispatchDisposition.UNKNOWN}):
            with self.subTest(change=change):
                self.auth.shared["claimed"] = False
                self.executor.change = change
                self.assertEqual(self.attempt().phase, RecoveryPhase.UNKNOWN)
        self.auth.shared["claimed"] = False
        self.executor.fail = True
        self.assertEqual(self.attempt().phase, RecoveryPhase.UNKNOWN)
        self.assertNotIn("private", repr(self.audit.events))

    def test_definite_no_attempt_is_not_a_retry_permission(self):
        self.executor.disposition = DispatchDisposition.DEFINITELY_NOT_ATTEMPTED
        result = self.attempt()
        self.assertEqual(result.phase, RecoveryPhase.NOT_ATTEMPTED)
        self.assertFalse(result.retry_allowed)
        self.assertEqual(self.attempt().phase, RecoveryPhase.BLOCKED)

    def test_audit_allowlist_excludes_account_actor_session_challenge_and_raw_request(self):
        self.attempt()
        encoded = json.dumps([asdict(event) for event in self.audit.events])
        for value in (TARGET.account_ref, TARGET.gateway_id, "actor-fixture", "challenge-fixture", "session-fixture",
                      "request-fixture", "opaque-authoritative-test-fixture"):
            self.assertNotIn(value, encoded)
        self.assertEqual(set(asdict(self.audit.events[0])), {"event_code", "target_digest", "binding_digest",
                                                          "operation", "environment", "occurred_ns"})

    def valid_proof(self):
        dimensions = tuple(DimensionAssessment(d, EvidenceState.YES, "observed", "evidence-fixture") for d in Dimension)
        assessment = ReadinessAssessment(TARGET, "post-restart-generation", NOW + 1, dimensions,
                                         EvidenceState.YES, EvidenceState.YES, ("trading-disabled",))
        return ReconciliationProof("attempt-fixture", self.binding.digest, NOW + 1, NOW + 2,
                                   NOW + 30_000_000_000, EvidenceState.YES, EvidenceState.YES, assessment)

    def test_explicit_post_attempt_reconciliation_can_complete_without_rearm(self):
        self.attempt()
        self.reconciliation.proof = self.valid_proof()
        self.clock.now = NOW + 2
        result = self.service.reconcile(self.binding, self.auth.last)
        self.assertEqual(result.phase, RecoveryPhase.COMPLETED)
        self.assertEqual(result.trading, "disabled")
        self.assertFalse(result.kill_switch_reset)
        self.assertEqual(self.executor.calls, 1)
        self.assertEqual(self.journal.calls[-1], "reconciled")

    def test_reconciliation_must_prove_human_review_bound_identity_freshness_and_post_dispatch(self):
        self.attempt()
        self.clock.now = NOW + 2
        proof = self.valid_proof()
        cases = [{"human_reviewed": EvidenceState.UNKNOWN}, {"recovery_complete": EvidenceState.UNKNOWN},
                 {"attempt_ref": "wrong"}, {"binding_digest": "b" * 64}, {"expires_ns": NOW + 2},
                 {"observed_after_ns": NOW - 1}, {"reviewed_ns": NOW + 3},
                 {"assessment": replace(proof.assessment, read_only_ready=EvidenceState.UNKNOWN)},
                 {"assessment": replace(proof.assessment, target=replace(TARGET, environment=Environment.LIVE))}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.reconciliation.proof = replace(proof, **changes)
                self.assertEqual(self.service.reconcile(self.binding, self.auth.last).phase, RecoveryPhase.UNKNOWN)
        self.reconciliation.proof = replace(proof, observed_after_ns=NOW)
        self.assertEqual(self.service.reconcile(self.binding, self.auth.last).reason_codes,
                         ("recovery-completion-not-durable",))
        self.assertEqual(self.executor.calls, 1)

    def test_policy_cannot_expand_five_minute_human_window_or_coerce_flags(self):
        for changes in ({"max_challenge_age_ns": 300_000_000_001}, {"dispatch_enabled": "true"},
                       {"max_status_age_ns": True}, {"allowed_operations": {self.operation}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                RecoveryPolicy(**changes)


if __name__ == "__main__":
    unittest.main()
