"""Authored-only synthetic gateway host regressions; no real hosts or accounts.

These scenarios have not been run during source-only implementation. Temporary
SQLite fixtures below are created ONLY when a future test runner executes them.
The contract recorder is not a public-schema implementation or readiness proof.
"""
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import stat
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
import unittest
from unittest.mock import patch

from vertex_gateway.adapters import GatewayObservationService
from vertex_gateway.models import (
    Dimension, Environment, EvidenceState, GatewayProtocol, GatewayTarget,
    RecoveryBinding, RecoveryOperation,
)
from vertex_gateway.ports import DispatchDisposition, HumanAdmission, SafetyLease
from vertex_gateway.readiness import ObservationPolicy
from vertex_host.gateway import (
    DisabledHumanRecoveryExecutor, GatewayHostSelection, GatewayHostUnavailable,
    HostGatewayStatusAdapter, HostObservationAdapter, ObservationLimits,
    ReviewedHostTrustAdapter, ReviewedHostTrustRecord, SelectedObservationSource,
    SQLiteDisabledRecoveryClaims,
)
from vertex_host.gateway_composition import create_gateway_ports, timestamp


NOW = 1_000_000
TARGET = GatewayTarget("fixture-gateway", "acctref-" + "a" * 64,
                       Environment.PAPER, GatewayProtocol.TWS_SOCKET)
ENDPOINT = "fixture-endpoint"
GENERATION = "fixture-session-1"
SOURCE = "fixture-observation-source"
EVIDENCE = "fixture-observation-evidence"
STAMP = "fixture-authority-timestamp"
LIMITS = ObservationLimits(65_536, 1.0, 1_000, 100)


class Clock:
    def __init__(self):
        self.now = NOW
        self.elapsed = 10.0

    def now_ns(self):
        return self.now

    def monotonic(self):
        return self.elapsed


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def observation_envelope(target=TARGET):
    return {
        "kind": "vertex-host-gateway-observation", "sourceRef": SOURCE,
        "evidenceRef": EVIDENCE, "endpointRef": ENDPOINT, "targetDigest": target.digest,
        "gatewayId": target.gateway_id, "accountRef": target.account_ref,
        "environment": target.environment.value, "protocol": target.protocol.value,
        "generationRef": GENERATION,
        "observations": [{"dimension": dimension.value, "state": "yes",
                          "observedNs": NOW - 100, "receivedNs": NOW - 50,
                          "expiresNs": NOW + 1_000} for dimension in Dimension],
    }


def selection_for(raw, target=TARGET):
    source = SelectedObservationSource(SOURCE, EVIDENCE, sha256(raw).hexdigest(), tuple(Dimension))
    return GatewayHostSelection(target, ENDPOINT, GENERATION, (source,))


class Provider:
    def __init__(self, raw):
        self.raw, self.calls, self.callback = raw, [], None

    def read_once(self, source_ref, **scope):
        self.calls.append((source_ref, scope))
        if self.callback is not None:
            self.callback()
        return self.raw


def observation_adapter(raw=None, *, clock=None, selection=None):
    raw = encoded(observation_envelope()) if raw is None else raw
    clock = Clock() if clock is None else clock
    selection = selection_for(raw) if selection is None else selection
    provider = Provider(raw)
    return HostObservationAdapter(selection=selection, provider=provider, clock=clock, limits=LIMITS), provider


def trust_envelope(target=TARGET):
    return {
        "kind": "vertex-host-gateway-trust", "targetDigest": target.digest,
        "endpointRef": ENDPOINT, "evidenceRef": "fixture-trust-evidence",
        "verifiedNs": NOW - 100, "expiresNs": NOW + 1_000, "state": "yes",
        "providerConsoleVerified": True, "pinnedHostVerified": True,
        "strictVerification": True, "tlsVerified": True,
    }


def reviewed_trust(value=None, *, target=TARGET):
    value = trust_envelope(target) if value is None else value
    raw = encoded(value)
    return ReviewedHostTrustRecord(target.digest, ENDPOINT, "fixture-trust-evidence",
                                   sha256(raw).hexdigest(), raw, "fixture-reviewer", NOW - 50, NOW + 900)


class ContractRecorder:
    def __init__(self):
        self.calls = []
        self.result = True
        self.epoch = NOW

    def epoch_ns(self, value):
        if value != STAMP:
            raise ValueError("fixture-private-authority-rejection")
        return self.epoch

    def validate(self, name, payload, schema_version="1.0.0"):
        self.calls.append((name, payload, schema_version))
        return self.result


def status_adapter(clock=None, *, formatter=lambda ns: STAMP):
    clock = Clock() if clock is None else clock
    raw = encoded(observation_envelope())
    selection = selection_for(raw)
    observations, provider = observation_adapter(raw, clock=clock, selection=selection)
    trust = ReviewedHostTrustAdapter(selection=selection, records=(reviewed_trust(),), clock=clock)
    policy = ObservationPolicy(tuple((dimension, frozenset({SOURCE})) for dimension in Dimension), 1_000, 100)
    service = GatewayObservationService(clock=clock, policy=policy, trust=trust,
                                        observations=observations, enabled=True)
    contracts = ContractRecorder()
    status = HostGatewayStatusAdapter(selection=selection, observations=service,
                                      contracts=contracts, clock=clock, format_timestamp=formatter)
    return status, contracts, provider


def recovery_fixture(**changes):
    binding = RecoveryBinding(TARGET, RecoveryOperation.HUMAN_HANDOFF, "fixture-request", "fixture-idempotency",
                              "fixture-status", "fixture-actor", "fixture-challenge", NOW - 20,
                              NOW - 30, NOW + 500, "b" * 64)
    binding = replace(binding, **changes)
    admission = HumanAdmission("fixture-attempt", binding.digest, NOW - 40,
                               binding.confirmed_ns, binding.expires_ns, EvidenceState.YES, EvidenceState.YES)
    lease = SafetyLease("fixture-guard", binding.digest, binding.expires_ns, *([EvidenceState.YES] * 6))
    return binding, admission, lease


class Guard:
    def __init__(self, expected):
        self.expected, self.active, self.calls = expected, True, 0

    def lease_valid(self, binding, lease):
        self.calls += 1
        return self.active and (binding, lease) == self.expected


class ClaimsRecorder:
    def __init__(self, result=True):
        self.result, self.calls, self.error = result, [], None

    def consume_once(self, binding, admission, lease, *, now_ns):
        self.calls.append((binding, admission, lease, now_ns))
        if self.error:
            raise RuntimeError(self.error)
        return self.result


class ObservationAdapterTests(unittest.TestCase):
    def test_exact_selected_source_and_original_bytes_produce_all_dimensions(self):
        adapter, provider = observation_adapter()
        result = adapter.collect(TARGET)
        self.assertEqual(result.target, TARGET)
        self.assertEqual(result.generation_ref, GENERATION)
        self.assertEqual(tuple(row.dimension for row in result.observations), tuple(Dimension))
        self.assertTrue(all(row.account_ref == TARGET.account_ref for row in result.observations))
        self.assertEqual(provider.calls, [(SOURCE, {
            "endpoint_ref": ENDPOINT, "target_digest": TARGET.digest,
            "generation_ref": GENERATION, "maximum_bytes": LIMITS.maximum_bytes,
            "deadline_monotonic": 11.0,
        })])

    def test_missing_selection_or_provider_never_discovers_a_host(self):
        raw = encoded(observation_envelope())
        provider = Provider(raw)
        for selection, port in ((None, provider), (selection_for(raw), None)):
            with self.subTest(selection=selection is None):
                adapter = HostObservationAdapter(selection=selection, provider=port, clock=Clock(), limits=LIMITS)
                with self.assertRaisesRegex(GatewayHostUnavailable, "^gateway-host-unavailable$"):
                    adapter.collect(TARGET)
        self.assertEqual(provider.calls, [])

    def test_mismatched_requested_target_never_calls_provider(self):
        adapter, provider = observation_adapter()
        with self.assertRaises(GatewayHostUnavailable):
            adapter.collect(replace(TARGET, environment=Environment.LIVE))
        self.assertEqual(provider.calls, [])

    def test_every_envelope_identity_is_checked_even_when_hash_is_repinned(self):
        changes = {
            "kind": "other", "sourceRef": "other-source", "evidenceRef": "other-evidence",
            "endpointRef": "other-endpoint", "targetDigest": "f" * 64,
            "gatewayId": "other-gateway", "accountRef": "acctref-" + "c" * 64,
            "environment": "live", "protocol": "client-portal-http", "generationRef": "other-session",
        }
        for key, value in changes.items():
            with self.subTest(key=key):
                envelope = observation_envelope()
                envelope[key] = value
                adapter, provider = observation_adapter(encoded(envelope))
                with self.assertRaises(GatewayHostUnavailable):
                    adapter.collect(TARGET)
                self.assertEqual(len(provider.calls), 1)

    def test_hash_checks_original_bytes_not_reserialized_json(self):
        raw = encoded(observation_envelope())
        adapter, provider = observation_adapter(raw)
        provider.raw = raw + b" "
        with self.assertRaises(GatewayHostUnavailable):
            adapter.collect(TARGET)
        self.assertEqual(len(provider.calls), 1)
        repinned, _ = observation_adapter(provider.raw)
        self.assertEqual(len(repinned.collect(TARGET).observations), len(Dimension))

    def test_deadline_overrun_rollback_and_provider_error_are_sanitized_without_retry(self):
        for elapsed in (11.0, 9.0, float("nan")):
            with self.subTest(elapsed=elapsed):
                clock = Clock()
                adapter, provider = observation_adapter(clock=clock)
                provider.callback = lambda value=elapsed: setattr(clock, "elapsed", value)
                with self.assertRaisesRegex(GatewayHostUnavailable, "^gateway-host-unavailable$"):
                    adapter.collect(TARGET)
                self.assertEqual(len(provider.calls), 1)
        adapter, provider = observation_adapter()
        def fail():
            raise RuntimeError("private-provider-response")
        provider.callback = fail
        with self.assertRaisesRegex(GatewayHostUnavailable, "^gateway-host-unavailable$"):
            adapter.collect(TARGET)
        self.assertEqual(len(provider.calls), 1)

    def test_invalid_chronology_types_and_stale_rows_fail_whole_collection(self):
        cases = ({"observedNs": True}, {"observedNs": 1.0}, {"observedNs": -1},
                 {"observedNs": NOW - 1_001}, {"observedNs": NOW + 1},
                 {"receivedNs": NOW + 1}, {"receivedNs": NOW - 200},
                 {"expiresNs": NOW}, {"observedNs": NOW - 500, "receivedNs": NOW - 50})
        for changes in cases:
            with self.subTest(changes=changes):
                value = observation_envelope()
                value["observations"][0].update(changes)
                adapter, _ = observation_adapter(encoded(value))
                with self.assertRaises(GatewayHostUnavailable):
                    adapter.collect(TARGET)

    def test_duplicates_unknown_fields_and_oversized_missing_bytes_fail_closed(self):
        base = observation_envelope()
        duplicate = deepcopy(base)
        duplicate["observations"][1] = duplicate["observations"][0]
        extra = deepcopy(base)
        extra["endpointAddress"] = "not-allowed"
        missing = deepcopy(base)
        missing["observations"].pop()
        duplicate_key = encoded(base).replace(b'"sourceRef":', b'"sourceRef":"duplicate","sourceRef":')
        for raw in (encoded(duplicate), encoded(extra), encoded(missing), duplicate_key,
                    b"{" + b" " * 65_536 + b"}", b"\xff"):
            with self.subTest(length=len(raw)):
                adapter, _ = observation_adapter(raw)
                with self.assertRaises(GatewayHostUnavailable):
                    adapter.collect(TARGET)
        adapter, provider = observation_adapter()
        provider.raw = None
        with self.assertRaises(GatewayHostUnavailable):
            adapter.collect(TARGET)

    def test_missing_dimension_is_not_inferred_from_process_or_socket(self):
        value = observation_envelope()
        value["observations"] = value["observations"][:1]
        raw = encoded(value)
        selected = selection_for(raw)
        selected = replace(selected, sources=(replace(selected.sources[0], dimensions=(Dimension.PROCESS,)),))
        adapter, _ = observation_adapter(raw, selection=selected)
        self.assertEqual(tuple(row.dimension for row in adapter.collect(TARGET).observations), (Dimension.PROCESS,))


class TrustAdapterTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.selection = selection_for(encoded(observation_envelope()))

    def adapter(self, records, selection=None):
        return ReviewedHostTrustAdapter(selection=self.selection if selection is None else selection,
                                        records=records, clock=self.clock)

    def test_only_reviewed_exact_target_original_hash_with_current_chronology_is_trusted(self):
        result = self.adapter((reviewed_trust(),)).inspect(TARGET)
        self.assertTrue(result.current(TARGET, NOW))
        self.assertEqual(result.expires_ns, NOW + 900)
        self.assertNotIn("fixture-reviewer", repr(result))

    def test_absent_ambiguous_stale_future_and_hash_mismatched_reviews_are_unavailable(self):
        record = reviewed_trust()
        variants = ((), (record, record), (replace(record, reviewed_ns=NOW + 1),),
                    (replace(record, expires_ns=NOW),), (replace(record, sha256="c" * 64),),
                    (replace(record, target_digest="d" * 64),),
                    (replace(record, endpoint_ref="other-endpoint"),))
        for records in variants:
            with self.subTest(records=len(records)):
                with self.assertRaises(GatewayHostUnavailable):
                    self.adapter(records).inspect(TARGET)

    def test_new_rejected_or_stale_record_never_falls_back_to_older_good_record(self):
        old = reviewed_trust()
        rejected = trust_envelope()
        rejected["strictVerification"] = False
        fresh_bad = reviewed_trust(rejected)
        with self.assertRaises(GatewayHostUnavailable):
            self.adapter((old, fresh_bad)).inspect(TARGET)
        with self.assertRaises(GatewayHostUnavailable):
            self.adapter((fresh_bad,)).inspect(TARGET)

    def test_console_pin_and_strict_flags_must_be_literal_true(self):
        for flag in ("providerConsoleVerified", "pinnedHostVerified", "strictVerification"):
            for value in (False, 1, "true"):
                with self.subTest(flag=flag, value=value):
                    envelope = trust_envelope()
                    envelope[flag] = value
                    with self.assertRaises(GatewayHostUnavailable):
                        self.adapter((reviewed_trust(envelope),)).inspect(TARGET)

    def test_http_requires_tls_and_never_reuses_socket_target(self):
        target = replace(TARGET, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)
        selected = selection_for(encoded(observation_envelope(target)), target)
        envelope = trust_envelope(target)
        envelope["tlsVerified"] = False
        adapter = self.adapter((reviewed_trust(envelope, target=target),), selection=selected)
        with self.assertRaises(GatewayHostUnavailable):
            adapter.inspect(target)
        with self.assertRaises(GatewayHostUnavailable):
            self.adapter((reviewed_trust(),)).inspect(target)

    def test_explicit_negative_is_not_promoted_to_trust(self):
        envelope = trust_envelope()
        envelope["state"] = "no"
        result = self.adapter((reviewed_trust(envelope),)).inspect(TARGET)
        self.assertIs(result.state, EvidenceState.NO)
        self.assertFalse(result.current(TARGET, NOW))


class StatusAdapterTests(unittest.TestCase):
    def test_status_uses_authoritative_contract_and_stable_evidence_revision(self):
        clock = Clock()
        adapter, contracts, provider = status_adapter(clock)
        first = adapter.current(TARGET)
        clock.now += 1
        contracts.epoch = clock.now
        second = adapter.current(TARGET)
        self.assertEqual(first["statusId"], second["statusId"])
        self.assertEqual(second["trading"], "disabled")
        self.assertEqual(second["recovery"], "disabled")
        self.assertEqual(second["brokerHandshake"], "authenticated")
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual([(name, version) for name, _, version in contracts.calls],
                         [("BrokerRecoveryStatus", "1.0.0")] * 2)
        with self.assertRaises(TypeError):
            second["trading"] = "enabled"

    def test_stale_or_wrong_evidence_assessment_cannot_be_projected(self):
        adapter, _, _ = status_adapter()
        original = adapter._observations.observe(TARGET)
        wrong_evidence = replace(original.dimensions[0], evidence_ref="unselected-evidence")
        class FixedAssessment:
            def __init__(self, assessment):
                self.assessment = assessment

            def observe(self, target):
                return self.assessment
        for assessment in (
            replace(original, assessed_ns=NOW - 1),
            replace(original, generation_ref="different-generation"),
            replace(original, dimensions=(wrong_evidence, *original.dimensions[1:])),
            replace(original, dimensions=(*original.dimensions[:-1], original.dimensions[0])),
        ):
            adapter._observations = FixedAssessment(assessment)
            with self.assertRaises(GatewayHostUnavailable):
                adapter.current(TARGET)

    def test_formatter_missing_mismatched_authoritative_time_or_truthy_validation_fails(self):
        adapter, _, provider = status_adapter(formatter=None)
        with self.assertRaises(GatewayHostUnavailable):
            adapter.current(TARGET)
        self.assertEqual(provider.calls, [])
        for result in (False, 1, {"accepted": True}):
            adapter, contracts, _ = status_adapter()
            contracts.result = result
            with self.assertRaises(GatewayHostUnavailable):
                adapter.current(TARGET)
        adapter, contracts, _ = status_adapter()
        contracts.epoch = NOW + 1
        with self.assertRaises(GatewayHostUnavailable):
            adapter.current(TARGET)

    def test_failed_latest_source_or_expired_trust_never_serves_previous_status(self):
        clock = Clock()
        adapter, _, provider = status_adapter(clock)
        adapter.current(TARGET)
        provider.raw = b"changed"
        with self.assertRaises(GatewayHostUnavailable):
            adapter.current(TARGET)
        clock.now = NOW + 901
        calls = len(provider.calls)
        with self.assertRaises(GatewayHostUnavailable):
            adapter.current(TARGET)
        self.assertEqual(len(provider.calls), calls)


class DisabledExecutorTests(unittest.TestCase):
    def test_valid_request_consumes_exact_binding_guard_and_stays_disabled(self):
        for operation in RecoveryOperation:
            binding, admission, lease = recovery_fixture(operation=operation)
            claims = ClaimsRecorder()
            executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=claims, guard=Guard((binding, lease)))
            with patch("subprocess.Popen", side_effect=AssertionError("no-process")), \
                    patch("socket.socket", side_effect=AssertionError("no-connection")):
                result = executor.dispatch_once(binding, admission, lease)
            self.assertIs(result.disposition, DispatchDisposition.DEFINITELY_NOT_ATTEMPTED)
            self.assertEqual(result.attempt_ref, admission.attempt_ref)
            self.assertEqual(result.binding_digest, binding.digest)
            self.assertEqual(claims.calls, [(binding, admission, lease, NOW)])
            self.assertFalse(hasattr(executor, "enable"))
            self.assertFalse(hasattr(executor, "rearm"))

    def test_missing_store_guard_or_revoked_live_guard_never_claims_consumption(self):
        binding, admission, lease = recovery_fixture()
        claims, guard = ClaimsRecorder(), Guard((binding, lease))
        for store, current_guard in ((None, guard), (claims, None)):
            result = DisabledHumanRecoveryExecutor(clock=Clock(), claims=store, guard=current_guard).dispatch_once(
                binding, admission, lease)
            self.assertIs(result.disposition, DispatchDisposition.UNKNOWN)
        guard.active = False
        result = DisabledHumanRecoveryExecutor(clock=Clock(), claims=claims, guard=guard).dispatch_once(
            binding, admission, lease)
        self.assertIs(result.disposition, DispatchDisposition.UNKNOWN)
        self.assertEqual(claims.calls, [])

    def test_changed_or_expired_binding_admission_and_guard_never_reaches_store(self):
        binding, admission, lease = recovery_fixture()
        scenarios = (
            (replace(binding, expires_ns=NOW), admission, lease),
            (replace(binding, request_digest="d" * 64), admission, lease),
            (binding, replace(admission, binding_digest="c" * 64), lease),
            (binding, replace(admission, challenge_verified_ns=NOW - 29), lease),
            (binding, replace(admission, human_verified=EvidenceState.NO), lease),
            (binding, replace(admission, durable_claim=EvidenceState.UNKNOWN), lease),
            (binding, admission, replace(lease, guard_ref="other-guard")),
            (binding, admission, replace(lease, expires_ns=NOW)),
            (binding, admission, replace(lease, owner_fenced=EvidenceState.NO)),
        )
        for current_binding, current_admission, current_lease in scenarios:
            with self.subTest(admission=current_admission.attempt_ref):
                claims = ClaimsRecorder()
                executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=claims, guard=Guard((binding, lease)))
                result = executor.dispatch_once(current_binding, current_admission, current_lease)
                self.assertIs(result.disposition, DispatchDisposition.UNKNOWN)
                self.assertEqual(claims.calls, [])

    def test_failed_truthy_duplicate_or_uncertain_consumption_never_retries(self):
        binding, admission, lease = recovery_fixture()
        for accepted in (False, 1, "yes"):
            claims = ClaimsRecorder(accepted)
            executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=claims, guard=Guard((binding, lease)))
            self.assertIs(executor.dispatch_once(binding, admission, lease).disposition, DispatchDisposition.UNKNOWN)
            self.assertEqual(len(claims.calls), 1)
        claims = ClaimsRecorder()
        claims.error = "private-storage-error"
        executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=claims, guard=Guard((binding, lease)))
        self.assertIs(executor.dispatch_once(binding, admission, lease).disposition, DispatchDisposition.UNKNOWN)
        self.assertEqual(len(claims.calls), 1)


class DurableDisabledClaimsTests(unittest.TestCase):
    def test_construction_does_not_open_sqlite_and_no_default_store_exists(self):
        with patch("vertex_host.gateway.sqlite3.connect", side_effect=AssertionError("explicit-open-only")):
            DisabledHumanRecoveryExecutor(clock=Clock())

    def test_consumption_survives_reopen_and_changed_guard_cannot_replay_request(self):
        binding, admission, lease = recovery_fixture()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "disabled-claims.sqlite"
            store = SQLiteDisabledRecoveryClaims.open(path)
            try:
                executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=store, guard=Guard((binding, lease)))
                self.assertIs(executor.dispatch_once(binding, admission, lease).disposition,
                              DispatchDisposition.DEFINITELY_NOT_ATTEMPTED)
            finally:
                store.close()
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            reopened = SQLiteDisabledRecoveryClaims.open(path)
            try:
                self.assertFalse(reopened.consume_once(binding, admission, lease, now_ns=NOW))
                self.assertFalse(reopened.consume_once(binding, admission, replace(lease, guard_ref="other-guard"),
                                                       now_ns=NOW))
            finally:
                reopened.close()
            with sqlite3.connect(path) as connection:
                rows = connection.execute("SELECT * FROM disabled_claims").fetchall()
            self.assertEqual(len(rows), 1)
            flattened = repr(rows)
            for private in (TARGET.account_ref, binding.actor_id, binding.challenge_id,
                            binding.request_id, admission.attempt_ref, lease.guard_ref):
                self.assertNotIn(private, flattened)
            self.assertEqual(rows[0][-1], "disabled-not-attempted")

    def test_each_request_idempotency_challenge_attempt_guard_key_is_globally_once_only(self):
        binding, admission, lease = recovery_fixture()
        with TemporaryDirectory() as directory:
            store = SQLiteDisabledRecoveryClaims.open(Path(directory) / "claims.sqlite")
            try:
                self.assertTrue(store.consume_once(binding, admission, lease, now_ns=NOW))
                for shared in ("request", "idempotency", "challenge", "attempt", "guard"):
                    other = replace(binding, request_id="other-request", idempotency_key="other-idempotency",
                                    challenge_id="other-challenge", request_digest="c" * 64)
                    if shared == "request":
                        other = replace(other, request_id=binding.request_id)
                    elif shared == "idempotency":
                        other = replace(other, idempotency_key=binding.idempotency_key)
                    elif shared == "challenge":
                        other = replace(other, challenge_id=binding.challenge_id)
                    current_admission = replace(admission, binding_digest=other.digest,
                                                attempt_ref=admission.attempt_ref if shared == "attempt" else "other-attempt")
                    current_lease = replace(lease, binding_digest=other.digest,
                                            guard_ref=lease.guard_ref if shared == "guard" else "other-guard")
                    with self.subTest(shared=shared):
                        self.assertFalse(store.consume_once(other, current_admission, current_lease, now_ns=NOW))
            finally:
                store.close()

    def test_parallel_connections_have_only_one_committed_winner(self):
        binding, admission, lease = recovery_fixture()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "claims.sqlite"
            stores = [SQLiteDisabledRecoveryClaims.open(path), SQLiteDisabledRecoveryClaims.open(path)]
            barrier, results, failures = Barrier(2), [], []
            def consume(store):
                try:
                    barrier.wait(timeout=5)
                    results.append(store.consume_once(binding, admission, lease, now_ns=NOW))
                except Exception as error:
                    failures.append(type(error).__name__)
            threads = [Thread(target=consume, args=(store,)) for store in stores]
            try:
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=5)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(failures, [])
                self.assertEqual(sorted(results), [False, True])
            finally:
                for store in stores:
                    store.close()

    def test_nonprivate_symlink_relative_or_unrelated_database_is_not_reused(self):
        with self.assertRaises(GatewayHostUnavailable):
            SQLiteDisabledRecoveryClaims.open("relative.sqlite")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            unrelated = root / "unrelated.sqlite"
            with sqlite3.connect(unrelated) as connection:
                connection.execute("CREATE TABLE unrelated (value TEXT)")
            unrelated.chmod(0o600)
            with self.assertRaises(GatewayHostUnavailable):
                SQLiteDisabledRecoveryClaims.open(unrelated)
            linked = root / "linked.sqlite"
            linked.symlink_to(unrelated)
            with self.assertRaises(GatewayHostUnavailable):
                SQLiteDisabledRecoveryClaims.open(linked)
            nonprivate = root / "nonprivate"
            nonprivate.mkdir(mode=0o755)
            with self.assertRaises(GatewayHostUnavailable):
                SQLiteDisabledRecoveryClaims.open(nonprivate / "claims.sqlite")
            self.assertFalse((nonprivate / "claims.sqlite").exists())

    def test_weakened_constraints_or_extra_trigger_cannot_claim_durable_once_only(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for kind in ("weakened", "trigger"):
                path = root / (kind + ".sqlite")
                store = SQLiteDisabledRecoveryClaims.open(path)
                store.close()
                with sqlite3.connect(path) as connection:
                    if kind == "weakened":
                        connection.execute("DROP TABLE disabled_claims")
                        connection.execute("CREATE TABLE disabled_claims (full_hash TEXT)")
                    else:
                        connection.execute("CREATE TRIGGER silently_ignore BEFORE INSERT ON disabled_claims "
                                           "BEGIN SELECT RAISE(IGNORE); END")
                with self.subTest(kind=kind):
                    with self.assertRaises(GatewayHostUnavailable):
                        SQLiteDisabledRecoveryClaims.open(path)

    def test_closed_store_is_unavailable_not_a_successful_disabled_claim(self):
        binding, admission, lease = recovery_fixture()
        with TemporaryDirectory() as directory:
            store = SQLiteDisabledRecoveryClaims.open(Path(directory) / "claims.sqlite")
            store.close()
            executor = DisabledHumanRecoveryExecutor(clock=Clock(), claims=store, guard=Guard((binding, lease)))
            result = executor.dispatch_once(binding, admission, lease)
            self.assertIs(result.disposition, DispatchDisposition.UNKNOWN)

    def test_complete_request_and_lease_not_just_binding_digest_are_persisted(self):
        binding, admission, lease = recovery_fixture()
        variants = (
            (binding, admission, lease),
            (replace(binding, request_id="different-request"), admission, lease),
            (replace(binding, idempotency_key="different-idempotency"), admission, lease),
            (replace(binding, requested_ns=binding.requested_ns + 1), admission, lease),
            (binding, replace(admission, authenticated_ns=NOW - 41), lease),
            (binding, replace(admission, attempt_ref="different-attempt"), lease),
            (binding, admission, replace(lease, guard_ref="different-guard")),
            (binding, admission, replace(lease, expires_ns=NOW + 499)),
        )
        hashes = []
        with TemporaryDirectory() as directory:
            for index, (current_binding, current_admission, current_lease) in enumerate(variants):
                self.assertEqual(current_binding.digest, binding.digest)
                path = Path(directory) / f"fixture-{index}.sqlite"
                store = SQLiteDisabledRecoveryClaims.open(path)
                try:
                    self.assertTrue(store.consume_once(current_binding, current_admission, current_lease,
                                                       now_ns=NOW))
                finally:
                    store.close()
                connection = sqlite3.connect(path)
                try:
                    hashes.append(connection.execute("SELECT full_hash FROM disabled_claims").fetchone()[0])
                finally:
                    connection.close()
        self.assertEqual(len(hashes), len(set(hashes)))


class FactoryAuthority(ContractRecorder):
    def __init__(self):
        super().__init__()
        self.times = {
            "fixture-selection-issued": NOW - 200,
            "fixture-selection-expires": NOW + 500,
            "fixture-reviewed": NOW - 50,
            "fixture-review-expires": NOW + 900,
            timestamp(NOW): NOW,
        }

    def epoch_ns(self, value):
        return self.times[value]

    def digest(self, value):
        # Fixture only: production delegates canonical JSON to the authority.
        return sha256(encoded(value)).hexdigest()

    def encode(self, value):
        raise AssertionError("original-evidence-must-not-be-reencoded")


class OriginalCache:
    def __init__(self):
        self.values, self.calls = {}, []

    def pin(self, identity, contract, raw):
        digest = sha256(raw).hexdigest()
        self.values[identity] = (digest, raw)
        return {"artifactId": identity, "artifactSha256": digest,
                "contractName": contract, "schemaVersion": "1.0.0"}

    def private_bytes(self, identity, digest):
        self.calls.append((identity, digest))
        expected, raw = self.values[identity]
        if expected != digest:
            raise ValueError("fixture-exact-pin-unavailable")
        return raw

    def private(self, identity, digest):
        raise AssertionError("decoded-evidence-is-not-original-evidence")


def factory_fixture(change_config=None):
    cache, contracts, clock = OriginalCache(), FactoryAuthority(), Clock()
    observation_pin = cache.pin("fixture-observation", "HostGatewayObservation",
                                encoded(observation_envelope()) + b" ")
    trust_pin = cache.pin("fixture-trust", "HostGatewayTrustEvidence", encoded(trust_envelope()))
    config = {
        "format": "vertex-host-gateway-v1", "accountAlias": "fixture-account-alias",
        "target": {"gatewayId": TARGET.gateway_id, "accountRef": TARGET.account_ref,
                   "environment": "paper", "protocol": "tws-socket"},
        "endpointRef": ENDPOINT, "generationRef": GENERATION,
        "limits": {"maximumBytes": 65_536, "timeoutMilliseconds": 1_000,
                   "maxAgeNs": "1000", "maxDeliveryNs": "100"},
        "sources": [{"sourceRef": SOURCE, "evidenceRef": EVIDENCE,
                     "dimensions": [dimension.value for dimension in Dimension], "artifact": observation_pin}],
        "trustRecords": [{"artifact": trust_pin, "evidenceRef": "fixture-trust-evidence",
                          "reviewerRef": "fixture-reviewer", "reviewedAt": "fixture-reviewed",
                          "expiresAt": "fixture-review-expires"}],
    }
    if change_config:
        change_config(config)
    config_pin = cache.pin("fixture-configuration", "HostGatewayConfiguration", encoded(config))
    unrelated_pin = {"artifactId": "fixture-positions-not-gateway", "artifactSha256": "a" * 64,
                     "contractName": "HostPositionEvidence", "schemaVersion": "1.0.0"}
    selection = {
        "schemaVersion": "1.0.0", "selectionId": "fixture-selection",
        "accountAlias": "fixture-account-alias", "environment": "paper",
        "issuedAt": "fixture-selection-issued", "expiresAt": "fixture-selection-expires",
        "artifacts": [{"role": "broker-observation", "artifact": pin}
                      for pin in (config_pin, observation_pin, trust_pin, unrelated_pin)],
    }
    selection["selectionSha256"] = contracts.digest(selection)
    return selection, cache, contracts, clock


def refresh_fixture_selection(selection, contracts):
    selection["selectionSha256"] = contracts.digest(
        {key: value for key, value in selection.items() if key != "selectionSha256"})


class GatewayCompositionTests(unittest.TestCase):
    def test_factory_uses_only_selected_original_bytes_and_composes_real_status(self):
        selection, cache, contracts, clock = factory_fixture()
        with patch("vertex_host.gateway_composition.SQLiteDisabledRecoveryClaims.open",
                   side_effect=AssertionError("no-default-database")):
            ports = create_gateway_ports(selection, cache, contracts, clock)
        self.assertEqual(ports.target, TARGET)
        self.assertIsNone(ports.claims)
        self.assertEqual([identity for identity, _ in cache.calls],
                         ["fixture-configuration", "fixture-observation", "fixture-trust"])
        before = tuple(cache.calls)
        status = ports.status.current(TARGET)
        self.assertEqual(status["brokerHandshake"], "authenticated")
        self.assertEqual(status["trading"], "disabled")
        self.assertEqual(tuple(cache.calls), before)
        self.assertEqual([name for name, _, _ in contracts.calls],
                         ["RuntimePolicySelection", "BrokerRecoveryStatus"])
        ports.close()

    def test_factory_missing_config_has_no_capabilities_and_ignores_positions_artifact(self):
        selection, cache, contracts, clock = factory_fixture()
        selection["artifacts"] = selection["artifacts"][-1:]
        refresh_fixture_selection(selection, contracts)
        with patch("vertex_host.gateway_composition.SQLiteDisabledRecoveryClaims.open") as opened:
            ports = create_gateway_ports(selection, cache, contracts, clock,
                                         disabled_claims_path="/fixture-local-approved/claims.sqlite")
        opened.assert_not_called()
        self.assertEqual(cache.calls, [])
        self.assertIsNone(ports.target)
        self.assertIsNone(ports.claims)
        with self.assertRaises(GatewayHostUnavailable):
            ports.status.current(TARGET)
        binding, admission, lease = recovery_fixture()
        self.assertIs(ports.recovery.dispatch_once(binding, admission, lease).disposition,
                      DispatchDisposition.UNKNOWN)

    def test_factory_rejects_schema_truthiness_bad_digest_and_expired_selection_before_cache(self):
        for failure in ("truthy", "digest", "expired"):
            selection, cache, contracts, clock = factory_fixture()
            if failure == "truthy":
                contracts.result = 1
            elif failure == "digest":
                selection["selectionSha256"] = "c" * 64
            else:
                contracts.times["fixture-selection-expires"] = NOW
            with self.subTest(failure=failure):
                with self.assertRaises(GatewayHostUnavailable):
                    create_gateway_ports(selection, cache, contracts, clock)
                self.assertEqual(cache.calls, [])

    def test_factory_requires_unique_config_and_every_subordinate_pin_to_be_selected(self):
        for failure in ("duplicate-config", "unselected-source", "unselected-trust"):
            selection, cache, contracts, clock = factory_fixture()
            if failure == "duplicate-config":
                selection["artifacts"].append(deepcopy(selection["artifacts"][0]))
            else:
                index = 1 if failure == "unselected-source" else 2
                selection["artifacts"].pop(index)
            refresh_fixture_selection(selection, contracts)
            with self.subTest(failure=failure):
                with self.assertRaises(GatewayHostUnavailable):
                    create_gateway_ports(selection, cache, contracts, clock)

    def test_factory_rejects_config_trust_toggles_remote_paths_and_scope_changes(self):
        changes = (
            lambda value: value.update(trusted=True),
            lambda value: value.update(enabled=True),
            lambda value: value.update(disabledClaimsPath="/unapproved/path"),
            lambda value: value.update(accountAlias="other-account-alias"),
            lambda value: value["target"].update(environment="live"),
            lambda value: value.update(trustRecords=[]),
            lambda value: value["limits"].update(timeoutMilliseconds=True),
            lambda value: value["limits"].update(maxAgeNs="1000.0"),
        )
        for index, change in enumerate(changes):
            selection, cache, contracts, clock = factory_fixture(change)
            with self.subTest(index=index), \
                    patch("vertex_host.gateway_composition.SQLiteDisabledRecoveryClaims.open") as opened:
                with self.assertRaises(GatewayHostUnavailable):
                    create_gateway_ports(selection, cache, contracts, clock,
                                         disabled_claims_path="/fixture-local-approved/claims.sqlite")
                opened.assert_not_called()

    def test_factory_detects_changed_original_evidence_without_trying_older_cache_entries(self):
        for identity in ("fixture-configuration", "fixture-observation", "fixture-trust"):
            selection, cache, contracts, clock = factory_fixture()
            digest, raw = cache.values[identity]
            cache.values[identity] = (digest, raw + b" ")
            with self.subTest(identity=identity):
                with self.assertRaises(GatewayHostUnavailable):
                    create_gateway_ports(selection, cache, contracts, clock)
                self.assertEqual(sum(item == identity for item, _ in cache.calls), 1)

    def test_selection_expiry_revokes_status_even_when_original_trust_has_longer_expiry(self):
        selection, cache, contracts, clock = factory_fixture()
        ports = create_gateway_ports(selection, cache, contracts, clock)
        ports.status.current(TARGET)
        clock.now = NOW + 501
        with self.assertRaises(GatewayHostUnavailable):
            ports.status.current(TARGET)

    def test_only_explicit_local_store_and_real_guard_can_consume_and_still_never_dispatch(self):
        selection, cache, contracts, clock = factory_fixture()
        binding, admission, lease = recovery_fixture()
        claims = ClaimsRecorder()
        claims.close = lambda: None
        with patch("vertex_host.gateway_composition.SQLiteDisabledRecoveryClaims.open", return_value=claims) as opened:
            ports = create_gateway_ports(selection, cache, contracts, clock,
                                         disabled_claims_path="/fixture-local-approved/claims.sqlite",
                                         guard=Guard((binding, lease)))
        opened.assert_called_once_with("/fixture-local-approved/claims.sqlite")
        result = ports.recovery.dispatch_once(binding, admission, lease)
        self.assertIs(result.disposition, DispatchDisposition.DEFINITELY_NOT_ATTEMPTED)
        self.assertEqual(claims.calls, [(binding, admission, lease, NOW)])
        clock.now = NOW + 501
        result = ports.recovery.dispatch_once(binding, admission, lease)
        self.assertIs(result.disposition, DispatchDisposition.UNKNOWN)
        self.assertEqual(len(claims.calls), 1)
        ports.close()
