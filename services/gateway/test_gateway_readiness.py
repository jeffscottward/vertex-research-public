"""Unexecuted unit scenarios with synthetic evidence and opaque account references.

These tests neither contact a broker/host nor establish deployed readiness. The
public-contract recorder below is deliberately NOT a Python schema or timestamp
parser: it records calls to the authoritative-validator boundary and supplies
canned results. Authoritative schema/time conformance belongs to that boundary's
own tests. Collection deadlines belong to ObservationPort implementations; these
scenarios assert the service makes at most one collection and never retries.
"""

from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from itertools import product
import unittest

from vertex_gateway.adapters import GatewayObservationService
from vertex_gateway.models import (
    Dimension,
    Environment,
    EvidenceState,
    GatewayProtocol,
    GatewayTarget,
    HostTrust,
    Observation,
    ObservationSnapshot,
    RecoveryPhase,
)
from vertex_gateway.readiness import (
    ObservationPolicy,
    assess_readiness,
    project_public_status,
)


# Invented fixtures, not broker identifiers, credentials, endpoints, or defaults.
NOW_NS = 1_700_000_000_123_456_789
ACCOUNT_REF = "acctref-" + "a" * 64
OTHER_ACCOUNT_REF = "acctref-" + "b" * 64
SOURCE_REFS = {
    dimension: f"synthetic-source:{dimension.value}" for dimension in Dimension
}
OBSERVED_AT = "2023-11-14T22:13:20.123456789Z"
OFFSET_OBSERVED_AT = "2023-11-15T03:43:20.123456789+05:30"
NEGATIVE_OFFSET_OBSERVED_AT = "2023-11-14T18:13:20.123456789-04:00"
_UNSET = object()


def synthetic_target(**changes):
    target = GatewayTarget(
        gateway_id="synthetic-gateway",
        account_ref=ACCOUNT_REF,
        environment=Environment.PAPER,
        protocol=GatewayProtocol.TWS_SOCKET,
    )
    return replace(target, **changes)


def synthetic_observation(dimension, *, target=None, **changes):
    target = target if target is not None else synthetic_target()
    observation = Observation(
        dimension=dimension,
        state=EvidenceState.YES,
        source_ref=SOURCE_REFS[dimension],
        evidence_ref=f"synthetic-evidence:{dimension.value}",
        observed_ns=NOW_NS - 100,
        received_ns=NOW_NS - 50,
        expires_ns=NOW_NS + 1_000,
        account_ref=target.account_ref if dimension in (
            Dimension.ACCOUNT, Dimension.READ_ONLY, Dimension.RECONCILED
        ) else None,
        environment=target.environment if dimension in (
            Dimension.ENVIRONMENT, Dimension.READ_ONLY, Dimension.RECONCILED
        ) else None,
    )
    return replace(observation, **changes)


def synthetic_snapshot(*, target=None, observations=None, generation_ref="synthetic-generation-1"):
    target = target if target is not None else synthetic_target()
    if observations is None:
        observations = tuple(synthetic_observation(dimension, target=target) for dimension in Dimension)
    return ObservationSnapshot(target, generation_ref, observations)


def synthetic_trust(*, target=None, **changes):
    target = target if target is not None else synthetic_target()
    trust = HostTrust(
        target_digest=target.digest,
        state=EvidenceState.YES,
        evidence_ref="synthetic-host-trust-receipt",
        verified_ns=NOW_NS - 100,
        expires_ns=NOW_NS + 1_000,
        strict_verification=True,
    )
    return replace(trust, **changes)


def synthetic_policy(**changes):
    policy = ObservationPolicy(
        sources=tuple((dimension, frozenset({SOURCE_REFS[dimension]})) for dimension in Dimension),
        max_age_ns=1_000,
        max_delivery_ns=100,
    )
    return replace(policy, **changes)


class SequenceClock:
    """Finite integer-only fixture clock; extra reads cannot hide retry loops."""

    def __init__(self, values, events):
        self.values = tuple(values)
        self.calls = 0
        self.events = events

    def now_ns(self):
        if self.calls >= len(self.values):
            raise AssertionError("unexpected-clock-read")
        value = self.values[self.calls]
        self.calls += 1
        self.events.append(("clock", value))
        return value


class RecordingTrustPort:
    """A synthetic external receipt supplier; performs no verification or I/O."""

    def __init__(self, receipt, events, error=None):
        self.receipt = receipt
        self.events = events
        self.error = error
        self.calls = []

    def inspect(self, target):
        self.calls.append(target)
        self.events.append(("trust", target))
        if self.error is not None:
            raise self.error
        return self.receipt


class RecordingObservationPort:
    """One canned read-only result per call, with no transport or broker SDK."""

    def __init__(self, snapshot, events, error=None):
        self.snapshot = snapshot
        self.events = events
        self.error = error
        self.calls = []

    def collect(self, target):
        self.calls.append(target)
        self.events.append(("collect", target))
        if self.error is not None:
            raise self.error
        return self.snapshot


class FakeAuthoritativeValidatorRecorder:
    """FAKE authoritative-validator port recorder, not a duplicate schema.

    No regexes, key checks, chronology validation, date parsing, hashes, or
    authoritative schema claims are implemented here. The named bridge call and
    exact opaque time/result plumbing are the subjects of these tests only.
    """

    def __init__(self, *, epoch_results=None, epoch_error=None, validation_error=None,
                 validation_result=True):
        self.epoch_results = {OBSERVED_AT: NOW_NS} if epoch_results is None else dict(epoch_results)
        self.epoch_error = epoch_error
        self.validation_error = validation_error
        self.timestamp_calls = []
        self.validation_calls = []
        self.events = []
        self.received_value = None
        self.validation_result = validation_result

    def epoch_ns(self, timestamp):
        self.timestamp_calls.append(timestamp)
        self.events.append(("epoch_ns", timestamp))
        if self.epoch_error is not None:
            raise self.epoch_error
        return self.epoch_results[timestamp]

    def validate(self, contract_name, value, schema_version="1.0.0"):
        self.validation_calls.append((contract_name, deepcopy(value), schema_version))
        self.events.append(("validate", contract_name, schema_version))
        self.received_value = value
        if self.validation_error is not None:
            raise self.validation_error
        return self.validation_result



class GatewayFixtureCase(unittest.TestCase):
    def setUp(self):
        self.target = synthetic_target()
        self.snapshot = synthetic_snapshot(target=self.target)
        self.trust = synthetic_trust(target=self.target)
        self.policy = synthetic_policy()

    def assess(self, **changes):
        arguments = {
            "target": self.target,
            "snapshot": self.snapshot,
            "trust": self.trust,
            "policy": self.policy,
            "now_ns": NOW_NS,
        }
        arguments.update(changes)
        return assess_readiness(**arguments)

    def with_observation(self, dimension, **changes):
        return replace(self.snapshot, observations=tuple(
            replace(row, **changes) if row.dimension is dimension else row
            for row in self.snapshot.observations
        ))

    def assert_dimension(self, assessment, dimension, state, reason):
        row = next(row for row in assessment.dimensions if row.dimension is dimension)
        self.assertIs(assessment.state(dimension), state)
        self.assertEqual(row.reason, reason)
        if reason != "observed":
            self.assertIsNone(row.evidence_ref)
        if state is not EvidenceState.YES:
            self.assertIn(f"{dimension.value}-{reason}", assessment.reason_codes)
        return row

    def assert_unknown_dimensions(self, assessment, reason):
        self.assertEqual(tuple(row.dimension for row in assessment.dimensions), tuple(Dimension))
        for dimension in Dimension:
            self.assert_dimension(assessment, dimension, EvidenceState.UNKNOWN, reason)


class ReadinessEvidenceTests(GatewayFixtureCase):
    def test_complete_fresh_evidence_is_read_only_ready_but_never_trading_authority(self):
        assessment = self.assess()
        self.assertIs(assessment.target, self.target)
        self.assertEqual(assessment.generation_ref, self.snapshot.generation_ref)
        self.assertEqual(assessment.assessed_ns, NOW_NS)
        self.assertIs(assessment.host_trust, EvidenceState.YES)
        self.assertIs(assessment.read_only_ready, EvidenceState.YES)
        self.assertEqual(assessment.reason_codes, ("read-only-ready", "trading-disabled"))
        for dimension in Dimension:
            row = self.assert_dimension(assessment, dimension, EvidenceState.YES, "observed")
            self.assertEqual(row.evidence_ref, f"synthetic-evidence:{dimension.value}")

    def test_each_dimension_retains_all_three_states_without_cross_dimension_inference(self):
        for dimension, state in product(Dimension, EvidenceState):
            with self.subTest(dimension=dimension, state=state):
                assessment = self.assess(snapshot=self.with_observation(dimension, state=state))
                row = self.assert_dimension(assessment, dimension, state, "observed")
                self.assertEqual(row.evidence_ref, f"synthetic-evidence:{dimension.value}")
                expected = EvidenceState.YES if dimension is Dimension.RECONCILED else state
                self.assertIs(assessment.read_only_ready, expected)
                for other in Dimension:
                    if other is not dimension:
                        self.assertIs(assessment.state(other), EvidenceState.YES)
                self.assertIn("trading-disabled", assessment.reason_codes)

    def test_process_reachability_and_authentication_do_not_establish_each_other(self):
        for only_dimension in (Dimension.PROCESS, Dimension.REACHABLE, Dimension.AUTHENTICATED):
            with self.subTest(only_dimension=only_dimension):
                snapshot = synthetic_snapshot(observations=(synthetic_observation(only_dimension),))
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, only_dimension, EvidenceState.YES, "observed")
                for dimension in Dimension:
                    if dimension is not only_dimension:
                        self.assert_dimension(assessment, dimension, EvidenceState.UNKNOWN, "not-observed")
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_process_reachability_and_authentication_accept_independent_contradictory_states(self):
        dimensions = (Dimension.PROCESS, Dimension.REACHABLE, Dimension.AUTHENTICATED)
        for states in product(EvidenceState, repeat=3):
            with self.subTest(states=states):
                replacements = dict(zip(dimensions, states))
                snapshot = replace(self.snapshot, observations=tuple(
                    replace(row, state=replacements[row.dimension]) if row.dimension in replacements else row
                    for row in self.snapshot.observations
                ))
                assessment = self.assess(snapshot=snapshot)
                for dimension, state in replacements.items():
                    self.assert_dimension(assessment, dimension, state, "observed")
                expected = (
                    EvidenceState.NO if EvidenceState.NO in states else
                    EvidenceState.UNKNOWN if EvidenceState.UNKNOWN in states else EvidenceState.YES
                )
                self.assertIs(assessment.read_only_ready, expected)

    def test_reconciliation_is_independent_and_not_required_for_read_only_readiness(self):
        for reconciliation in (None, EvidenceState.UNKNOWN, EvidenceState.NO, EvidenceState.YES):
            with self.subTest(reconciliation=reconciliation):
                rows = tuple(row for row in self.snapshot.observations if row.dimension is not Dimension.RECONCILED)
                if reconciliation is not None:
                    rows += (synthetic_observation(Dimension.RECONCILED, state=reconciliation),)
                assessment = self.assess(snapshot=replace(self.snapshot, observations=rows))
                self.assertIs(assessment.read_only_ready, EvidenceState.YES)
                self.assertIs(assessment.state(Dimension.RECONCILED),
                              EvidenceState.UNKNOWN if reconciliation is None else reconciliation)
                self.assertIn("read-only-ready", assessment.reason_codes)
                self.assertIn("trading-disabled", assessment.reason_codes)

    def test_reconciliation_alone_does_not_supply_readiness_or_authentication(self):
        assessment = self.assess(snapshot=synthetic_snapshot(
            observations=(synthetic_observation(Dimension.RECONCILED),)
        ))
        self.assertIs(assessment.state(Dimension.RECONCILED), EvidenceState.YES)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        for dimension in Dimension:
            if dimension is not Dimension.RECONCILED:
                self.assert_dimension(assessment, dimension, EvidenceState.UNKNOWN, "not-observed")

    def test_missing_snapshot_retains_unknown_dimensions_despite_external_host_trust(self):
        assessment = self.assess(snapshot=None)
        self.assertEqual(assessment.generation_ref, "unobserved")
        self.assertIs(assessment.host_trust, EvidenceState.YES)
        self.assert_unknown_dimensions(assessment, "not-observed")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_empty_snapshot_retains_its_generation_but_supplies_no_evidence(self):
        assessment = self.assess(snapshot=replace(self.snapshot, observations=()))
        self.assertEqual(assessment.generation_ref, self.snapshot.generation_ref)
        self.assert_unknown_dimensions(assessment, "not-observed")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_omitting_any_required_dimension_prevents_read_only_readiness(self):
        for missing in Dimension:
            if missing is Dimension.RECONCILED:
                continue
            with self.subTest(missing=missing):
                snapshot = replace(self.snapshot, observations=tuple(
                    row for row in self.snapshot.observations if row.dimension is not missing
                ))
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, missing, EvidenceState.UNKNOWN, "not-observed")
                self.assertIs(assessment.state(Dimension.RECONCILED), EvidenceState.YES)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_gateway_account_environment_and_protocol_mismatches_reject_whole_snapshot(self):
        targets = (
            replace(self.target, gateway_id="synthetic-other-gateway"),
            replace(self.target, account_ref=OTHER_ACCOUNT_REF),
            replace(self.target, environment=Environment.LIVE),
            replace(self.target, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP),
        )
        for wrong_target in targets:
            with self.subTest(target_digest=wrong_target.digest):
                assessment = self.assess(snapshot=synthetic_snapshot(target=wrong_target))
                self.assert_unknown_dimensions(assessment, "target-mismatch")
                self.assertEqual(assessment.generation_ref, "unobserved")
                self.assertIs(assessment.host_trust, EvidenceState.YES)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_tws_and_client_portal_require_their_own_exact_target_and_trust_receipt(self):
        for protocol in GatewayProtocol:
            with self.subTest(protocol=protocol):
                target = replace(self.target, protocol=protocol)
                assessment = self.assess(target=target, snapshot=synthetic_snapshot(target=target),
                                         trust=synthetic_trust(target=target))
                self.assertIs(assessment.read_only_ready, EvidenceState.YES)
                self.assertIs(assessment.target.protocol, protocol)

    def test_observations_cannot_supply_their_own_missing_host_trust(self):
        assessment = self.assess(trust=None)
        self.assert_unknown_dimensions(assessment, "host-trust-unverified")
        self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        self.assertEqual(assessment.reason_codes[0], "host-trust-unverified")

    def test_host_trust_must_be_positive_strict_fresh_and_bound_to_exact_target(self):
        cases = (
            ("unknown", replace(self.trust, state=EvidenceState.UNKNOWN), EvidenceState.UNKNOWN),
            ("denied", replace(self.trust, state=EvidenceState.NO), EvidenceState.NO),
            ("non-strict", replace(self.trust, strict_verification=False), EvidenceState.UNKNOWN),
            ("expired", replace(self.trust, expires_ns=NOW_NS - 1), EvidenceState.UNKNOWN),
            ("expiry-boundary", replace(self.trust, expires_ns=NOW_NS), EvidenceState.UNKNOWN),
            ("future", replace(self.trust, verified_ns=NOW_NS + 1), EvidenceState.UNKNOWN),
            ("gateway", synthetic_trust(target=replace(self.target, gateway_id="synthetic-other")), EvidenceState.UNKNOWN),
            ("account", synthetic_trust(target=replace(self.target, account_ref=OTHER_ACCOUNT_REF)), EvidenceState.UNKNOWN),
            ("environment", synthetic_trust(target=replace(self.target, environment=Environment.LIVE)), EvidenceState.UNKNOWN),
            ("protocol", synthetic_trust(target=replace(self.target, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)), EvidenceState.UNKNOWN),
        )
        for label, trust, expected in cases:
            with self.subTest(case=label):
                assessment = self.assess(trust=trust)
                self.assert_unknown_dimensions(assessment, "host-trust-unverified")
                self.assertIs(assessment.host_trust, expected)
                self.assertIs(assessment.read_only_ready, expected)

    def test_host_trust_accepts_exact_verification_instant_but_not_expiry_instant(self):
        trust = replace(self.trust, verified_ns=NOW_NS, expires_ns=NOW_NS + 1)
        self.assertTrue(trust.current(self.target, NOW_NS))
        self.assertFalse(trust.current(self.target, NOW_NS - 1))
        self.assertFalse(trust.current(self.target, NOW_NS + 1))
        self.assertIs(self.assess(trust=trust).read_only_ready, EvidenceState.YES)
        self.assertIs(self.assess(trust=trust, now_ns=NOW_NS + 1).read_only_ready, EvidenceState.UNKNOWN)

    def test_negative_trust_for_another_target_does_not_assert_this_target_is_denied(self):
        trust = synthetic_trust(target=replace(self.target, account_ref=OTHER_ACCOUNT_REF), state=EvidenceState.NO)
        assessment = self.assess(trust=trust)
        self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        self.assert_unknown_dimensions(assessment, "host-trust-unverified")

    def test_account_mismatch_is_negative_not_unknown_for_every_supplied_identity(self):
        for dimension in Dimension:
            with self.subTest(dimension=dimension):
                assessment = self.assess(snapshot=self.with_observation(dimension, account_ref=OTHER_ACCOUNT_REF))
                self.assert_dimension(assessment, dimension, EvidenceState.NO, "account-mismatch")
                expected = EvidenceState.YES if dimension is Dimension.RECONCILED else EvidenceState.NO
                self.assertIs(assessment.read_only_ready, expected)
                self.assertNotIn(OTHER_ACCOUNT_REF, repr(assessment))

    def test_environment_mismatch_is_negative_and_never_cross_promotes_paper_and_live(self):
        for environment in Environment:
            target = replace(self.target, environment=environment)
            opposite = Environment.LIVE if environment is Environment.PAPER else Environment.PAPER
            for dimension in Dimension:
                with self.subTest(environment=environment, dimension=dimension):
                    snapshot = synthetic_snapshot(target=target)
                    snapshot = replace(snapshot, observations=tuple(
                        replace(row, environment=opposite) if row.dimension is dimension else row
                        for row in snapshot.observations
                    ))
                    assessment = self.assess(target=target, snapshot=snapshot, trust=synthetic_trust(target=target))
                    self.assert_dimension(assessment, dimension, EvidenceState.NO, "environment-mismatch")
                    expected = EvidenceState.YES if dimension is Dimension.RECONCILED else EvidenceState.NO
                    self.assertIs(assessment.read_only_ready, expected)

    def test_identity_required_dimensions_cannot_use_unscoped_evidence(self):
        cases = (
            (Dimension.ACCOUNT, "account_ref", "account-unidentified"),
            (Dimension.ENVIRONMENT, "environment", "environment-unidentified"),
            (Dimension.READ_ONLY, "account_ref", "account-unidentified"),
            (Dimension.READ_ONLY, "environment", "environment-unidentified"),
            (Dimension.RECONCILED, "account_ref", "account-unidentified"),
            (Dimension.RECONCILED, "environment", "environment-unidentified"),
        )
        for dimension, field, reason in cases:
            with self.subTest(dimension=dimension, field=field):
                assessment = self.assess(snapshot=self.with_observation(dimension, **{field: None}))
                self.assert_dimension(assessment, dimension, EvidenceState.UNKNOWN, reason)
                expected = EvidenceState.YES if dimension is Dimension.RECONCILED else EvidenceState.UNKNOWN
                self.assertIs(assessment.read_only_ready, expected)

    def test_stale_age_boundary_uses_exact_nanoseconds(self):
        for age, expected, reason in (
            (1_000, EvidenceState.YES, "observed"),
            (1_001, EvidenceState.UNKNOWN, "stale-evidence"),
        ):
            with self.subTest(age_ns=age):
                snapshot = self.with_observation(Dimension.AUTHENTICATED,
                    observed_ns=NOW_NS - age, received_ns=NOW_NS - age)
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, Dimension.AUTHENTICATED, expected, reason)
                self.assertIs(assessment.read_only_ready, expected)

    def test_future_reversed_and_expired_timestamps_are_unknown_not_fresh(self):
        cases = (
            ("future-observation", {"observed_ns": NOW_NS + 1, "received_ns": NOW_NS + 1}),
            ("future-receipt", {"observed_ns": NOW_NS, "received_ns": NOW_NS + 1}),
            ("receipt-before-observation", {"observed_ns": NOW_NS - 50, "received_ns": NOW_NS - 51}),
            ("already-expired", {"expires_ns": NOW_NS - 1}),
            ("expiry-boundary", {"expires_ns": NOW_NS}),
            ("expiry-before-observation", {"expires_ns": NOW_NS - 101}),
        )
        for label, changes in cases:
            with self.subTest(case=label):
                assessment = self.assess(snapshot=self.with_observation(Dimension.READ_ONLY, **changes))
                self.assert_dimension(assessment, Dimension.READ_ONLY, EvidenceState.UNKNOWN, "invalid-evidence-time")
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_observation_received_now_with_one_nanosecond_remaining_is_current(self):
        snapshot = self.with_observation(Dimension.READ_ONLY,
            observed_ns=NOW_NS, received_ns=NOW_NS, expires_ns=NOW_NS + 1)
        assessment = self.assess(snapshot=snapshot)
        self.assert_dimension(assessment, Dimension.READ_ONLY, EvidenceState.YES, "observed")
        self.assertIs(assessment.read_only_ready, EvidenceState.YES)

    def test_delivery_delay_boundary_is_independent_of_age(self):
        for delay, expected, reason in (
            (100, EvidenceState.YES, "observed"),
            (101, EvidenceState.UNKNOWN, "delayed-evidence"),
        ):
            with self.subTest(delay_ns=delay):
                snapshot = self.with_observation(Dimension.REACHABLE,
                    observed_ns=NOW_NS - 200, received_ns=NOW_NS - 200 + delay)
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, Dimension.REACHABLE, expected, reason)
                self.assertIs(assessment.state(Dimension.AUTHENTICATED), EvidenceState.YES)
                self.assertIs(assessment.read_only_ready, expected)

    def test_zero_delivery_budget_accepts_only_same_instant_receipt(self):
        for delay, expected in ((0, EvidenceState.YES), (1, EvidenceState.UNKNOWN)):
            with self.subTest(delay_ns=delay):
                snapshot = replace(self.snapshot, observations=tuple(
                    replace(row, received_ns=row.observed_ns + delay) for row in self.snapshot.observations
                ))
                assessment = self.assess(snapshot=snapshot, policy=replace(self.policy, max_delivery_ns=0))
                self.assertIs(assessment.read_only_ready, expected)
                for dimension in Dimension:
                    self.assert_dimension(assessment, dimension, expected,
                                          "observed" if delay == 0 else "delayed-evidence")

    def test_duplicate_identical_conflicting_or_untrusted_rows_are_ambiguous_in_any_order(self):
        original = synthetic_observation(Dimension.AUTHENTICATED)
        alternatives = (
            original,
            replace(original, state=EvidenceState.NO, evidence_ref="synthetic-conflict"),
            replace(original, source_ref="synthetic-untrusted-source", evidence_ref="synthetic-untrusted-evidence"),
            replace(original, observed_ns=NOW_NS - 10, received_ns=NOW_NS - 5, evidence_ref="synthetic-newer"),
        )
        remaining = tuple(row for row in self.snapshot.observations if row.dimension is not Dimension.AUTHENTICATED)
        for alternative in alternatives:
            for duplicates in ((original, alternative), (alternative, original)):
                with self.subTest(evidence=alternative.evidence_ref, first=duplicates[0].evidence_ref):
                    assessment = self.assess(snapshot=replace(self.snapshot, observations=remaining + duplicates))
                    self.assert_dimension(assessment, Dimension.AUTHENTICATED, EvidenceState.UNKNOWN, "ambiguous-evidence")
                    self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                    self.assertIs(assessment.state(Dimension.PROCESS), EvidenceState.YES)

    def test_untrusted_source_cannot_assert_positive_negative_or_unknown_evidence(self):
        for dimension, state in product(Dimension, EvidenceState):
            with self.subTest(dimension=dimension, state=state):
                snapshot = self.with_observation(dimension, state=state, source_ref="synthetic-untrusted-source")
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, dimension, EvidenceState.UNKNOWN, "untrusted-source")
                expected = EvidenceState.YES if dimension is Dimension.RECONCILED else EvidenceState.UNKNOWN
                self.assertIs(assessment.read_only_ready, expected)

    def test_allowlisted_process_source_is_not_an_authentication_source(self):
        snapshot = self.with_observation(Dimension.AUTHENTICATED, source_ref=SOURCE_REFS[Dimension.PROCESS])
        assessment = self.assess(snapshot=snapshot)
        self.assert_dimension(assessment, Dimension.AUTHENTICATED, EvidenceState.UNKNOWN, "untrusted-source")
        self.assertIs(assessment.state(Dimension.PROCESS), EvidenceState.YES)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_missing_or_empty_dimension_allowlist_does_not_trust_a_source(self):
        without_auth = tuple(pair for pair in self.policy.sources if pair[0] is not Dimension.AUTHENTICATED)
        for sources in (without_auth, without_auth + ((Dimension.AUTHENTICATED, frozenset()),)):
            with self.subTest(explicit_empty=len(sources) == len(self.policy.sources)):
                assessment = self.assess(policy=replace(self.policy, sources=sources))
                self.assert_dimension(assessment, Dimension.AUTHENTICATED, EvidenceState.UNKNOWN, "untrusted-source")
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_old_or_untrusted_identity_mismatch_cannot_be_promoted_to_current_negative_identity(self):
        for changes, reason in (
            ({"source_ref": "synthetic-untrusted-source"}, "untrusted-source"),
            ({"observed_ns": NOW_NS - 1_001, "received_ns": NOW_NS - 1_001}, "stale-evidence"),
            ({"expires_ns": NOW_NS}, "invalid-evidence-time"),
        ):
            with self.subTest(reason=reason):
                snapshot = self.with_observation(Dimension.ACCOUNT, account_ref=OTHER_ACCOUNT_REF, **changes)
                assessment = self.assess(snapshot=snapshot)
                self.assert_dimension(assessment, Dimension.ACCOUNT, EvidenceState.UNKNOWN, reason)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_separate_snapshot_assessments_never_merge_generations_or_cache_evidence(self):
        first = self.assess()
        new_snapshot = synthetic_snapshot(generation_ref="synthetic-generation-2",
            observations=(synthetic_observation(Dimension.PROCESS),))
        second = self.assess(snapshot=new_snapshot)
        self.assertIs(first.read_only_ready, EvidenceState.YES)
        self.assertIs(second.read_only_ready, EvidenceState.UNKNOWN)
        self.assertEqual(second.generation_ref, "synthetic-generation-2")
        for dimension in Dimension:
            if dimension is not Dimension.PROCESS:
                self.assert_dimension(second, dimension, EvidenceState.UNKNOWN, "not-observed")
        self.assertEqual(self.assess(), first)

    def test_evaluator_does_not_mutate_inputs_or_sort_observations_in_place(self):
        snapshot = replace(self.snapshot, observations=tuple(reversed(self.snapshot.observations)))
        inputs = (self.target, snapshot, self.trust, self.policy)
        before = deepcopy(inputs)
        original_rows = snapshot.observations
        first = self.assess(snapshot=snapshot)
        second = self.assess(snapshot=snapshot)
        self.assertEqual(inputs, before)
        self.assertIs(snapshot.observations, original_rows)
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertIsNot(first.dimensions, second.dimensions)
        self.assertEqual(tuple(row.dimension for row in first.dimensions), tuple(Dimension))
        with self.assertRaises(FrozenInstanceError):
            first.assessed_ns = NOW_NS + 1

    def test_nanosecond_inputs_reject_boolean_float_or_string_substitutes(self):
        for invalid in (True, False, float(NOW_NS), str(NOW_NS), None):
            with self.subTest(invalid_type=type(invalid).__name__):
                with self.assertRaisesRegex(ValueError, "integer_nanoseconds_required"):
                    self.assess(now_ns=invalid)
                for field in ("observed_ns", "received_ns", "expires_ns"):
                    with self.subTest(field=field):
                        with self.assertRaisesRegex(ValueError, "integer_nanoseconds_required"):
                            synthetic_observation(Dimension.PROCESS, **{field: invalid})

    def test_policy_rejects_invalid_budgets_or_mutable_duplicate_source_definitions(self):
        for changes in (
            {"max_age_ns": 0}, {"max_age_ns": -1}, {"max_delivery_ns": -1},
            {"max_age_ns": True}, {"max_delivery_ns": 0.5},
            {"sources": list(self.policy.sources)},
            {"sources": ((Dimension.PROCESS, {SOURCE_REFS[Dimension.PROCESS]}),)},
            {"sources": (self.policy.sources[0], self.policy.sources[0])},
            {"sources": (("process-present", frozenset({"synthetic-source"})),)},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    replace(self.policy, **changes)


class NegativeTrustFreshnessTests(GatewayFixtureCase):
    def test_stale_or_future_negative_host_trust_is_unknown_not_current_denial(self):
        for changes in (
            {"expires_ns": NOW_NS - 1},
            {"expires_ns": NOW_NS},
            {"verified_ns": NOW_NS + 1},
        ):
            with self.subTest(changes=changes):
                trust = replace(self.trust, state=EvidenceState.NO, **changes)
                assessment = self.assess(trust=trust)
                self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "host-trust-unverified")

    def test_negative_host_trust_requires_current_scope_and_exact_nanosecond_window(self):
        trust = replace(self.trust, state=EvidenceState.NO,
                        verified_ns=NOW_NS, expires_ns=NOW_NS + 1)
        current = self.assess(trust=trust)
        self.assertIs(current.host_trust, EvidenceState.NO)
        self.assertIs(current.read_only_ready, EvidenceState.NO)
        self.assert_unknown_dimensions(current, "host-trust-unverified")
        for now_ns in (NOW_NS - 1, NOW_NS + 1):
            with self.subTest(now_ns=now_ns):
                assessment = self.assess(trust=trust, now_ns=now_ns)
                self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)


class ObservationServiceTests(GatewayFixtureCase):
    def make_service(self, *, receipt=_UNSET, snapshot=_UNSET, enabled=True,
                     trust_error=None, collection_error=None, times=(NOW_NS, NOW_NS, NOW_NS)):
        self.events = []
        self.clock = SequenceClock(times, self.events)
        self.trust_port = RecordingTrustPort(self.trust if receipt is _UNSET else receipt,
                                             self.events, trust_error)
        self.observation_port = RecordingObservationPort(self.snapshot if snapshot is _UNSET else snapshot,
                                                         self.events, collection_error)
        return GatewayObservationService(clock=self.clock, policy=self.policy,
            trust=self.trust_port, observations=self.observation_port, enabled=enabled)

    def test_construction_has_no_clock_trust_or_transport_effects(self):
        self.make_service()
        self.assertEqual(self.events, [])
        self.assertEqual(self.clock.calls, 0)
        self.assertEqual(self.trust_port.calls, [])
        self.assertEqual(self.observation_port.calls, [])

    def test_observation_is_disabled_by_default_without_trust_or_transport_calls(self):
        self.make_service(trust_error=AssertionError("must-not-inspect"),
                          collection_error=AssertionError("must-not-collect"), times=(NOW_NS,))
        service = GatewayObservationService(clock=self.clock, policy=self.policy,
            trust=self.trust_port, observations=self.observation_port)
        assessment = service.observe(self.target)
        self.assertEqual(self.events, [("clock", NOW_NS)])
        self.assertEqual(self.trust_port.calls, [])
        self.assertEqual(self.observation_port.calls, [])
        self.assertEqual(assessment.reason_codes[0], "observation-disabled")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        self.assert_unknown_dimensions(assessment, "not-observed")

    def test_explicit_disabled_mode_ignores_even_available_successful_ports(self):
        service = self.make_service(enabled=False, times=(NOW_NS,))
        assessment = service.observe(self.target)
        self.assertEqual(self.events, [("clock", NOW_NS)])
        self.assertEqual(self.trust_port.calls, [])
        self.assertEqual(self.observation_port.calls, [])
        self.assertEqual(assessment.reason_codes[0], "observation-disabled")
        self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)

    def test_enabled_flag_requires_actual_boolean_without_startup_calls(self):
        for invalid in (0, 1, "true", "false", None):
            with self.subTest(enabled=invalid):
                with self.assertRaisesRegex(ValueError, "explicit_observation_flag_required"):
                    self.make_service(enabled=invalid)
                self.assertEqual(self.events, [])

    def test_missing_either_port_fails_closed_without_partial_trust_or_transport_calls(self):
        for has_trust, has_observations in ((False, False), (False, True), (True, False)):
            with self.subTest(has_trust=has_trust, has_observations=has_observations):
                self.make_service(times=(NOW_NS,))
                service = GatewayObservationService(clock=self.clock, policy=self.policy, enabled=True,
                    trust=self.trust_port if has_trust else None,
                    observations=self.observation_port if has_observations else None)
                assessment = service.observe(self.target)
                self.assertEqual(self.events, [("clock", NOW_NS)])
                self.assertEqual(self.trust_port.calls, [])
                self.assertEqual(self.observation_port.calls, [])
                self.assertEqual(assessment.reason_codes[0], "observation-ports-unavailable")
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "not-observed")

    def test_invalid_untrusted_or_mismatched_host_receipts_never_reach_collection(self):
        receipts = (
            None, object(),
            replace(self.trust, state=EvidenceState.UNKNOWN),
            replace(self.trust, state=EvidenceState.NO),
            replace(self.trust, strict_verification=False),
            replace(self.trust, expires_ns=NOW_NS),
            replace(self.trust, verified_ns=NOW_NS + 1),
            synthetic_trust(target=replace(self.target, gateway_id="synthetic-other")),
            synthetic_trust(target=replace(self.target, account_ref=OTHER_ACCOUNT_REF)),
            synthetic_trust(target=replace(self.target, environment=Environment.LIVE)),
            synthetic_trust(target=replace(self.target, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)),
        )
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                service = self.make_service(receipt=receipt)
                assessment = service.observe(self.target)
                self.assertEqual(self.trust_port.calls, [self.target])
                self.assertEqual(self.observation_port.calls, [])
                self.assertEqual(self.clock.calls, 3)
                self.assertEqual(assessment.reason_codes[0], "host-trust-unverified")
                self.assertIsNot(assessment.read_only_ready, EvidenceState.YES)
                self.assert_unknown_dimensions(assessment, "not-observed")

    def test_trust_exception_is_sanitized_and_never_retried_or_followed_by_collection(self):
        marker = "synthetic-secret=never-real; synthetic-route; synthetic-private-account"
        for error_type in (RuntimeError, TimeoutError, ValueError):
            with self.subTest(error_type=error_type.__name__):
                service = self.make_service(trust_error=error_type(marker), times=(NOW_NS, NOW_NS + 1))
                assessment = service.observe(self.target)
                self.assertEqual(self.trust_port.calls, [self.target])
                self.assertEqual(self.observation_port.calls, [])
                self.assertEqual(self.clock.calls, 2)
                self.assertEqual(assessment.assessed_ns, NOW_NS + 1)
                self.assertEqual(assessment.reason_codes[0], "observation-unavailable")
                self.assertNotIn(marker, repr(assessment))
                self.assertNotIn(error_type.__name__, repr(assessment))
                self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "not-observed")

    def test_collection_exception_is_sanitized_with_one_attempt_and_no_retry(self):
        marker = "synthetic-token=never-real; synthetic-endpoint; synthetic-private-account"
        for error_type in (RuntimeError, TimeoutError, ValueError):
            with self.subTest(error_type=error_type.__name__):
                service = self.make_service(collection_error=error_type(marker))
                assessment = service.observe(self.target)
                self.assertEqual(self.trust_port.calls, [self.target])
                self.assertEqual(self.observation_port.calls, [self.target])
                self.assertEqual(self.clock.calls, 3)
                self.assertEqual(assessment.reason_codes[0], "observation-unavailable")
                self.assertNotIn(marker, repr(assessment))
                self.assertNotIn(error_type.__name__, repr(assessment))
                self.assertIs(assessment.host_trust, EvidenceState.YES)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "not-observed")

    def test_one_collection_follows_external_trust_and_uses_final_exact_clock_time(self):
        service = self.make_service(times=(NOW_NS, NOW_NS + 1, NOW_NS + 2))
        assessment = service.observe(self.target)
        self.assertEqual(self.events, [
            ("clock", NOW_NS), ("trust", self.target), ("clock", NOW_NS + 1),
            ("collect", self.target), ("clock", NOW_NS + 2),
        ])
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [self.target])
        self.assertIs(self.trust_port.calls[0], self.target)
        self.assertIs(self.observation_port.calls[0], self.target)
        self.assertEqual(assessment.assessed_ns, NOW_NS + 2)
        self.assertEqual(assessment.reason_codes[0], "observation-collected")
        self.assertIs(assessment.read_only_ready, EvidenceState.YES)
        self.assertIn("trading-disabled", assessment.reason_codes)

    def test_trust_expiring_during_inspection_prevents_collection_at_expiry_boundary(self):
        service = self.make_service(times=(NOW_NS, NOW_NS + 1_000, NOW_NS + 1_001))
        assessment = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [])
        self.assertEqual(assessment.assessed_ns, NOW_NS + 1_001)
        self.assertEqual(assessment.reason_codes[0], "host-trust-unverified")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_trust_expiring_during_collection_invalidates_otherwise_fresh_result_without_retry(self):
        # The final instant expires trust only; every observation is still fresh.
        trust = replace(self.trust, expires_ns=NOW_NS + 1)
        service = self.make_service(receipt=trust, times=(NOW_NS, NOW_NS, NOW_NS + 1))
        assessment = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [self.target])
        self.assertEqual(self.clock.calls, 3)
        self.assertEqual(assessment.reason_codes[0], "observation-collected")
        self.assertEqual(assessment.assessed_ns, NOW_NS + 1)
        self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        self.assert_unknown_dimensions(assessment, "host-trust-unverified")

    def test_evidence_expiring_during_collection_is_not_assessed_at_start_time(self):
        snapshot = self.with_observation(Dimension.AUTHENTICATED, expires_ns=NOW_NS + 1)
        service = self.make_service(snapshot=snapshot, times=(NOW_NS, NOW_NS, NOW_NS + 1))
        assessment = service.observe(self.target)
        self.assertIs(assessment.host_trust, EvidenceState.YES)
        self.assert_dimension(assessment, Dimension.AUTHENTICATED, EvidenceState.UNKNOWN, "invalid-evidence-time")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
        self.assertEqual(self.observation_port.calls, [self.target])

    def test_wrong_protocol_snapshot_cannot_trigger_rescan_retry_or_readiness(self):
        wrong_target = replace(self.target, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)
        service = self.make_service(snapshot=synthetic_snapshot(target=wrong_target))
        assessment = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [self.target])
        self.assert_unknown_dimensions(assessment, "target-mismatch")
        self.assertEqual(assessment.generation_ref, "unobserved")
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_explicit_second_observe_is_independent_and_never_reuses_previous_generation(self):
        service = self.make_service(times=(NOW_NS,) * 6)
        first = service.observe(self.target)
        self.observation_port.snapshot = synthetic_snapshot(generation_ref="synthetic-generation-2",
            observations=(synthetic_observation(Dimension.PROCESS),))
        second = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target, self.target])
        self.assertEqual(self.observation_port.calls, [self.target, self.target])
        self.assertEqual(self.clock.calls, 6)
        self.assertIs(first.read_only_ready, EvidenceState.YES)
        self.assertIs(second.read_only_ready, EvidenceState.UNKNOWN)
        self.assertEqual(second.generation_ref, "synthetic-generation-2")
        self.assertIs(second.state(Dimension.AUTHENTICATED), EvidenceState.UNKNOWN)
        self.assertIs(second.state(Dimension.RECONCILED), EvidenceState.UNKNOWN)

    def test_collection_preserves_all_native_input_values_and_observation_order(self):
        inputs = (self.target, self.snapshot, self.trust, self.policy)
        before = deepcopy(inputs)
        service = self.make_service()
        service.observe(self.target)
        self.assertEqual(inputs, before)
        self.assertIs(self.observation_port.snapshot, self.snapshot)
        self.assertIs(self.trust_port.receipt, self.trust)

    def test_fresh_scoped_negative_trust_is_preserved_without_any_collection(self):
        service = self.make_service(receipt=replace(self.trust, state=EvidenceState.NO))
        assessment = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [])
        self.assertEqual(self.clock.calls, 3)
        self.assertIs(assessment.host_trust, EvidenceState.NO)
        self.assertIs(assessment.read_only_ready, EvidenceState.NO)
        self.assertEqual(assessment.reason_codes[0], "host-trust-unverified")
        self.assert_unknown_dimensions(assessment, "not-observed")
        result = project_public_status(FakeAuthoritativeValidatorRecorder(), assessment,
                                       status_id="synthetic-status", observed_at=OBSERVED_AT)
        self.assertEqual(result["infrastructure"], "blocked")
        self.assertEqual(result["brokerHandshake"], "unknown")
        self.assertEqual(result["trading"], "disabled")

    def test_stale_future_or_wrong_target_negative_trust_never_collects_or_claims_current_denial(self):
        receipts = (
            replace(self.trust, state=EvidenceState.NO, expires_ns=NOW_NS),
            replace(self.trust, state=EvidenceState.NO, verified_ns=NOW_NS + 1),
            synthetic_trust(target=replace(self.target, account_ref=OTHER_ACCOUNT_REF),
                            state=EvidenceState.NO),
        )
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                service = self.make_service(receipt=receipt)
                assessment = service.observe(self.target)
                self.assertEqual(self.trust_port.calls, [self.target])
                self.assertEqual(self.observation_port.calls, [])
                self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "not-observed")

    def test_negative_trust_that_expires_before_final_assessment_does_not_remain_denied(self):
        receipt = replace(self.trust, state=EvidenceState.NO, expires_ns=NOW_NS + 1)
        service = self.make_service(receipt=receipt, times=(NOW_NS, NOW_NS, NOW_NS + 1))
        assessment = service.observe(self.target)
        self.assertEqual(self.trust_port.calls, [self.target])
        self.assertEqual(self.observation_port.calls, [])
        self.assertEqual(self.clock.calls, 3)
        self.assertEqual(assessment.assessed_ns, NOW_NS + 1)
        self.assertIs(assessment.host_trust, EvidenceState.UNKNOWN)
        self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_malformed_collection_returns_are_sanitized_once_inside_adapter_boundary(self):
        marker = "synthetic-private-return-never-real"
        for malformed in (None, object(), marker, {"synthetic-private": marker}, [self.snapshot]):
            with self.subTest(return_type=type(malformed).__name__):
                service = self.make_service(snapshot=malformed)
                assessment = service.observe(self.target)
                self.assertEqual(self.trust_port.calls, [self.target])
                self.assertEqual(self.observation_port.calls, [self.target])
                self.assertEqual(self.clock.calls, 3)
                self.assertEqual(assessment.reason_codes[0], "observation-unavailable")
                self.assertIs(assessment.host_trust, EvidenceState.YES)
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)
                self.assert_unknown_dimensions(assessment, "not-observed")
                self.assertNotIn(marker, repr(assessment))
                self.assertNotIn("invalid_observation_snapshot", repr(assessment))


class PublicStatusProjectionTests(GatewayFixtureCase):
    def project(self, assessment=None, contracts=None, **changes):
        assessment = self.assess() if assessment is None else assessment
        contracts = FakeAuthoritativeValidatorRecorder() if contracts is None else contracts
        arguments = {"status_id": "synthetic-status", "observed_at": OBSERVED_AT}
        arguments.update(changes)
        return project_public_status(contracts, assessment, **arguments)

    def test_public_only_payload_is_sent_once_to_named_authoritative_validator_port(self):
        assessment = self.assess()
        contracts = FakeAuthoritativeValidatorRecorder()
        result = self.project(assessment, contracts)
        expected = {
            "schemaVersion": "1.0.0",
            "statusId": "synthetic-status",
            "gatewayId": self.target.gateway_id,
            "environment": "paper",
            "observedAt": OBSERVED_AT,
            "infrastructure": "observed",
            "brokerHandshake": "authenticated",
            "recovery": "disabled",
            "trading": "disabled",
            "reasonCodes": list(assessment.reason_codes),
            "lastHumanRequestId": None,
        }
        self.assertEqual(contracts.timestamp_calls, [OBSERVED_AT])
        self.assertEqual(contracts.validation_calls, [("BrokerRecoveryStatus", expected, "1.0.0")])
        self.assertEqual(contracts.events, [
            ("epoch_ns", OBSERVED_AT), ("validate", "BrokerRecoveryStatus", "1.0.0")
        ])
        self.assertEqual(set(result), set(expected))
        self.assertEqual(dict(result), {**expected, "reasonCodes": tuple(expected["reasonCodes"])})

    def test_public_projection_excludes_private_identity_protocol_evidence_and_host_details(self):
        assessment = self.assess()
        contracts = FakeAuthoritativeValidatorRecorder()
        result = self.project(assessment, contracts)
        payload = contracts.validation_calls[0][1]
        forbidden_fields = {
            "account", "accountId", "accountRef", "account_ref", "protocol", "targetDigest",
            "dimensions", "generationRef", "readOnlyReady", "hostTrust", "host", "hostname",
            "endpoint", "fingerprint", "sourceRef", "evidenceRef", "password", "token", "secret",
        }
        self.assertTrue(forbidden_fields.isdisjoint(payload))
        self.assertTrue(forbidden_fields.isdisjoint(result))
        for private_value in (
            ACCOUNT_REF, self.target.digest, self.target.protocol.value,
            self.snapshot.generation_ref, self.trust.evidence_ref,
            *SOURCE_REFS.values(), *(row.evidence_ref for row in self.snapshot.observations),
        ):
            with self.subTest(private_value=private_value):
                self.assertNotIn(private_value, repr(payload))
                self.assertNotIn(private_value, repr(result))

    def test_exact_nanosecond_and_offset_timestamp_strings_are_delegated_unchanged(self):
        for timestamp in (OBSERVED_AT, OFFSET_OBSERVED_AT, NEGATIVE_OFFSET_OBSERVED_AT):
            with self.subTest(timestamp=timestamp):
                contracts = FakeAuthoritativeValidatorRecorder(epoch_results={timestamp: NOW_NS})
                result = self.project(contracts=contracts, observed_at=timestamp)
                self.assertEqual(contracts.timestamp_calls, [timestamp])
                self.assertEqual(contracts.validation_calls[0][1]["observedAt"], timestamp)
                self.assertEqual(result["observedAt"], timestamp)
                self.assertEqual(contracts.events[0], ("epoch_ns", timestamp))
                self.assertEqual(len(contracts.validation_calls), 1)

    def test_one_nanosecond_mismatch_is_rejected_before_public_validation(self):
        for delta in (-1, 1):
            with self.subTest(delta_ns=delta):
                contracts = FakeAuthoritativeValidatorRecorder(epoch_results={OBSERVED_AT: NOW_NS + delta})
                with self.assertRaisesRegex(ValueError, "^status_time_mismatch$"):
                    self.project(contracts=contracts)
                self.assertEqual(contracts.timestamp_calls, [OBSERVED_AT])
                self.assertEqual(contracts.validation_calls, [])

    def test_authoritative_epoch_result_must_be_exact_integer_nanoseconds(self):
        for invalid in (True, False, float(NOW_NS), str(NOW_NS), None):
            with self.subTest(result_type=type(invalid).__name__):
                contracts = FakeAuthoritativeValidatorRecorder(epoch_results={OBSERVED_AT: invalid})
                with self.assertRaisesRegex(ValueError, "^integer_nanoseconds_required$"):
                    self.project(contracts=contracts)
                self.assertEqual(contracts.timestamp_calls, [OBSERVED_AT])
                self.assertEqual(contracts.validation_calls, [])

    def test_authoritative_timestamp_failure_propagates_without_fallback_parser_or_validation(self):
        error = ValueError("synthetic-authoritative-time-rejection")
        contracts = FakeAuthoritativeValidatorRecorder(epoch_error=error)
        with self.assertRaises(ValueError) as raised:
            self.project(contracts=contracts)
        self.assertIs(raised.exception, error)
        self.assertEqual(contracts.timestamp_calls, [OBSERVED_AT])
        self.assertEqual(contracts.validation_calls, [])

    def test_authoritative_schema_failure_is_not_replaced_by_unvalidated_status(self):
        error = ValueError("synthetic-authoritative-schema-rejection")
        contracts = FakeAuthoritativeValidatorRecorder(validation_error=error)
        with self.assertRaises(ValueError) as raised:
            self.project(contracts=contracts)
        self.assertIs(raised.exception, error)
        self.assertEqual(len(contracts.validation_calls), 1)
        self.assertEqual(contracts.validation_calls[0][0], "BrokerRecoveryStatus")
        self.assertEqual(contracts.validation_calls[0][2], "1.0.0")

    def test_process_or_socket_evidence_never_projects_an_authenticated_handshake(self):
        for dimension, infrastructure in (
            (Dimension.PROCESS, "observed"), (Dimension.REACHABLE, "unknown")
        ):
            with self.subTest(dimension=dimension):
                assessment = self.assess(snapshot=synthetic_snapshot(observations=(synthetic_observation(dimension),)))
                result = self.project(assessment)
                self.assertEqual(result["infrastructure"], infrastructure)
                self.assertEqual(result["brokerHandshake"], "unknown")
                self.assertEqual(result["trading"], "disabled")
                self.assertIs(assessment.read_only_ready, EvidenceState.UNKNOWN)

    def test_authentication_handshake_projects_only_its_own_tri_state(self):
        for state, handshake in (
            (EvidenceState.YES, "authenticated"),
            (EvidenceState.NO, "disconnected"),
            (EvidenceState.UNKNOWN, "unknown"),
        ):
            with self.subTest(state=state):
                assessment = self.assess(snapshot=self.with_observation(Dimension.AUTHENTICATED, state=state))
                result = self.project(assessment)
                self.assertEqual(result["brokerHandshake"], handshake)
                self.assertEqual(result["infrastructure"], "observed")
                self.assertEqual(result["trading"], "disabled")

    def test_infrastructure_projection_has_explicit_host_reachability_process_precedence(self):
        cases = (
            (self.assess(trust=replace(self.trust, state=EvidenceState.NO)), "blocked"),
            (self.assess(snapshot=self.with_observation(Dimension.REACHABLE, state=EvidenceState.NO)), "failed"),
            (self.assess(), "observed"),
            (self.assess(snapshot=self.with_observation(Dimension.PROCESS, state=EvidenceState.NO)), "unknown"),
            (self.assess(snapshot=self.with_observation(Dimension.PROCESS, state=EvidenceState.UNKNOWN)), "unknown"),
            (self.assess(trust=None), "unknown"),
        )
        for assessment, expected in cases:
            with self.subTest(infrastructure=expected, host_trust=assessment.host_trust):
                result = self.project(assessment)
                self.assertEqual(result["infrastructure"], expected)
                self.assertEqual(result["trading"], "disabled")

    def test_authenticated_public_handshake_is_not_a_claim_of_account_or_environment_readiness(self):
        for dimension, changes in (
            (Dimension.ACCOUNT, {"account_ref": OTHER_ACCOUNT_REF}),
            (Dimension.ENVIRONMENT, {"environment": Environment.LIVE}),
        ):
            with self.subTest(dimension=dimension):
                assessment = self.assess(snapshot=self.with_observation(dimension, **changes))
                self.assertIs(assessment.read_only_ready, EvidenceState.NO)
                result = self.project(assessment)
                self.assertEqual(result["brokerHandshake"], "authenticated")
                self.assertEqual(result["environment"], "paper")
                self.assertNotIn("readOnlyReady", result)
                self.assertEqual(result["trading"], "disabled")
                self.assertIn(f"{dimension.value}-" + ("account-mismatch" if dimension is Dimension.ACCOUNT else "environment-mismatch"),
                              result["reasonCodes"])

    def test_all_recovery_phase_projections_remain_trading_disabled_and_preserve_request_reference(self):
        expected = {
            RecoveryPhase.PLANNED: "disabled",
            RecoveryPhase.BLOCKED: "disabled",
            RecoveryPhase.NOT_ATTEMPTED: "failed",
            RecoveryPhase.HUMAN_REQUIRED: "human-required",
            RecoveryPhase.IN_PROGRESS: "in-progress",
            RecoveryPhase.RECONCILIATION_REQUIRED: "in-progress",
            RecoveryPhase.UNKNOWN: "unknown",
            RecoveryPhase.COMPLETED: "completed",
        }
        assessment = self.assess(snapshot=None)
        for phase, projected in expected.items():
            with self.subTest(phase=phase):
                result = self.project(assessment, recovery_phase=phase,
                                      last_human_request_id="synthetic-human-request")
                self.assertEqual(result["recovery"], projected)
                self.assertEqual(result["lastHumanRequestId"], "synthetic-human-request")
                self.assertEqual(result["brokerHandshake"], "unknown")
                self.assertEqual(result["trading"], "disabled")
                self.assertNotIn("killSwitchReset", result)

    def test_public_reconciliation_reason_does_not_grant_trading_or_rewrite_handshake(self):
        for state in EvidenceState:
            with self.subTest(reconciled=state):
                assessment = self.assess(snapshot=self.with_observation(Dimension.RECONCILED, state=state))
                result = self.project(assessment)
                self.assertEqual(result["brokerHandshake"], "authenticated")
                self.assertEqual(result["trading"], "disabled")
                self.assertEqual(result["reasonCodes"], assessment.reason_codes)
                self.assertIs(assessment.read_only_ready, EvidenceState.YES)

    def test_only_literal_true_validator_result_can_authorize_public_projection(self):
        for rejected in (False, None, 0, 1, "true", {}, {"schemaVersion": "1.0.0"}, [], [True], object()):
            with self.subTest(result_type=type(rejected).__name__):
                contracts = FakeAuthoritativeValidatorRecorder(validation_result=rejected)
                with self.assertRaisesRegex(ValueError, "^status_contract_rejected$"):
                    self.project(contracts=contracts)
                self.assertEqual(len(contracts.validation_calls), 1)
                self.assertEqual(contracts.validation_calls[0][0], "BrokerRecoveryStatus")
                self.assertEqual(contracts.validation_calls[0][2], "1.0.0")
        contracts = FakeAuthoritativeValidatorRecorder(validation_result=True)
        result = self.project(contracts=contracts)
        self.assertEqual(result["statusId"], "synthetic-status")
        self.assertEqual(len(contracts.validation_calls), 1)

    def test_validated_result_is_owned_and_deeply_immutable_without_mutating_assessment(self):
        assessment = self.assess()
        before = deepcopy(assessment)
        contracts = FakeAuthoritativeValidatorRecorder()
        result = self.project(assessment, contracts)
        original_reasons = result["reasonCodes"]
        self.assertIsInstance(original_reasons, tuple)
        with self.assertRaises(TypeError):
            result["trading"] = "enabled"
        with self.assertRaises(TypeError):
            result["reasonCodes"][0] = "synthetic-mutation"
        contracts.received_value["statusId"] = "synthetic-mutated-after-return"
        contracts.received_value["reasonCodes"].append("synthetic-mutated-after-return")
        self.assertEqual(result["statusId"], "synthetic-status")
        self.assertEqual(result["reasonCodes"], original_reasons)
        self.assertNotIn("synthetic-mutated-after-return", result["reasonCodes"])
        self.assertEqual(assessment, before)
        self.assertEqual(assessment.reason_codes, original_reasons)
