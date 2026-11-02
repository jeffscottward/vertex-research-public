"""Authored unit scenarios only; synthetic pins/receipts are not runtime evidence."""

from dataclasses import FrozenInstanceError, replace
import unittest

from vertex_gateway.compatibility import (
    AdapterSurface,
    AssessmentStatus,
    CompatibilityRequest,
    EvidenceGate,
    EvidenceReceipt,
    EvidenceState,
    EvaluationScope,
    PersistenceBackend,
    ReleaseLine,
    RuntimePins,
    SOURCE_REFERENCES,
    V1_BASELINE,
    V2_RC5,
    evaluate_compatibility,
    release_facts,
    required_evidence_gates,
)


def synthetic_pins(version: str = "1.231.0", **changes: object) -> RuntimePins:
    """Deliberately invented fixture identifiers, never deployment defaults."""
    pins = RuntimePins(
        package_version=version,
        source_tag=f"v{version}",
        package_sha256="a" * 64,
        wheel_sha256="b" * 64,
        python_version="3.12.11",
        interpreter_abi="cpython-312-x86_64-linux-gnu",
        rust_toolchain="1.98.1",
        cargo_lock_sha256="c" * 64,
        target_platform="linux-x86_64",
        isolated_environment_id=f"synthetic-isolated-{version}",
        gateway_image_digest="sha256:" + "d" * 64,
        broker_config_sha256="e" * 64,
        account_ref="acctref-" + "a" * 64,
        client_identity="synthetic-reader",
        client_id=17,
        scope=EvaluationScope.PAPER,
        adapter_surface=AdapterSurface.IN_TREE_IBKR,
        persistence_backend=PersistenceBackend.OTHER,
    )
    return replace(pins, **changes)


def synthetic_request(pins: RuntimePins) -> CompatibilityRequest:
    return CompatibilityRequest(
        pins=pins,
        receipts=tuple(
            EvidenceReceipt(gate, pins, EvidenceState.PASS, "report-" + "b" * 64)
            for gate in required_evidence_gates(pins)
        ),
    )


def omit_gate(request: CompatibilityRequest, gate: EvidenceGate) -> CompatibilityRequest:
    return replace(request, receipts=tuple(r for r in request.receipts if r.gate is not gate))


class ReleaseFactsTests(unittest.TestCase):
    def test_exact_source_facts_do_not_infer_latest_or_installed_release(self) -> None:
        self.assertIs(release_facts("1.231.0"), V1_BASELINE)
        self.assertIs(release_facts("2.0.0rc5"), V2_RC5)
        for value in (None, "latest", "v1.231.0", "1.231", "2.0.0", "2.0.0rc6", "1.231.0 "):
            with self.subTest(value=value):
                self.assertIsNone(release_facts(value))
        self.assertFalse(V1_BASELINE.prerelease)
        self.assertIn("Beta", V1_BASELINE.implementation)
        self.assertEqual(V1_BASELINE.line, ReleaseLine.V1_BASELINE)
        self.assertIsNone(V1_BASELINE.python_constraint)
        self.assertTrue(V2_RC5.prerelease)
        self.assertEqual(V2_RC5.python_constraint, ">=3.12,<3.15")
        self.assertEqual(V2_RC5.rust_toolchain, "1.98.1")
        self.assertIn("v2.0.0rc5/MIGRATION_V2.md", V2_RC5.migration_url)
        facts = " ".join(V2_RC5.distinctions)
        for distinction in ("Rust/Python IBKR", "factories", "actor/strategy", "heartbeat", "synthetics", "OrderReleased/OrderFillVoided", "never delete"):
            self.assertIn(distinction, facts)
        self.assertEqual(SOURCE_REFERENCES[0].locator, "ADR-V06")


class CompatibilityTests(unittest.TestCase):
    def test_absent_evidence_is_unknown_not_runtime_or_trading_readiness(self) -> None:
        assessment = evaluate_compatibility(CompatibilityRequest(RuntimePins()))
        self.assertEqual(assessment.status, AssessmentStatus.UNKNOWN)
        self.assertIsNone(assessment.release)
        self.assertTrue(assessment.unknowns)
        self.assertEqual(assessment.blockers, assessment.unknowns)
        self.assertFalse(assessment.runtime_compatibility_proven)
        self.assertFalse(assessment.trading_authorized)
        self.assertEqual(assessment.source_refs, SOURCE_REFERENCES)

    def test_unknown_version_cannot_pass_even_with_complete_receipts(self) -> None:
        result = evaluate_compatibility(synthetic_request(synthetic_pins("9.0.0")))
        self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
        self.assertIn("release_line", {check.code for check in result.blockers})

    def test_baseline_metadata_alone_is_not_evidence(self) -> None:
        result = evaluate_compatibility(CompatibilityRequest(synthetic_pins()))
        self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
        self.assertIn(EvidenceGate.ISOLATED_ENVIRONMENT.value, {c.code for c in result.unknowns})
        self.assertIn(EvidenceGate.WHEEL_HOST_ABI.value, {c.code for c in result.unknowns})

    def test_baseline_complete_evidence_does_not_assert_runtime_compatibility(self) -> None:
        request = synthetic_request(synthetic_pins())
        result = evaluate_compatibility(request)
        self.assertEqual(result, evaluate_compatibility(request))
        self.assertEqual(result.status, AssessmentStatus.EVIDENCE_COMPLETE)
        self.assertIs(result.release, V1_BASELINE)
        self.assertEqual(result.blockers, ())
        self.assertFalse(result.runtime_compatibility_proven)
        self.assertFalse(result.trading_authorized)
        self.assertNotIn(EvidenceGate.PRERELEASE_EXCEPTION, required_evidence_gates(request.pins))

    def test_each_exact_pin_or_identity_is_required(self) -> None:
        for field in (
            "source_tag", "package_sha256", "wheel_sha256", "python_version",
            "interpreter_abi", "rust_toolchain", "cargo_lock_sha256", "target_platform",
            "isolated_environment_id", "gateway_image_digest", "broker_config_sha256",
            "account_ref", "client_identity", "client_id",
        ):
            with self.subTest(field=field):
                pins = replace(synthetic_pins(), **{field: None})
                result = evaluate_compatibility(synthetic_request(pins))
                self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
                self.assertIn(field, {check.code for check in result.unknowns})

    def test_wrong_or_floating_pins_are_blocked(self) -> None:
        for field, value in (
            ("source_tag", "main"), ("package_sha256", "latest"),
            ("wheel_sha256", "B" * 64), ("cargo_lock_sha256", "short"),
            ("python_version", "3.12"), ("rust_toolchain", "stable"),
            ("gateway_image_digest", "gateway:latest"), ("client_id", -1),
            ("client_identity", " reader "), ("target_platform", "linux\nother"),
            ("account_ref", "synthetic-account-number"),
            ("account_ref", "acctref-" + "a" * 63),
            ("account_ref", "acctref-" + "A" * 64),
        ):
            with self.subTest(field=field):
                result = evaluate_compatibility(synthetic_request(replace(synthetic_pins(), **{field: value})))
                self.assertEqual(result.status, AssessmentStatus.BLOCKED)
                self.assertIn(field, {check.code for check in result.blockers})

    def test_explicit_client_zero_is_not_confused_with_missing(self) -> None:
        result = evaluate_compatibility(synthetic_request(synthetic_pins(client_id=0)))
        self.assertEqual(result.status, AssessmentStatus.EVIDENCE_COMPLETE)

    def test_unknown_adapter_and_persistence_are_blockers(self) -> None:
        for field, value in (("adapter_surface", AdapterSurface.UNKNOWN), ("persistence_backend", PersistenceBackend.UNKNOWN)):
            with self.subTest(field=field):
                result = evaluate_compatibility(synthetic_request(replace(synthetic_pins(), **{field: value})))
                self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
                self.assertIn(field, {check.code for check in result.blockers})

    def test_each_runtime_evidence_gate_is_required(self) -> None:
        request = synthetic_request(synthetic_pins())
        for gate in required_evidence_gates(request.pins):
            with self.subTest(gate=gate):
                result = evaluate_compatibility(omit_gate(request, gate))
                self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
                self.assertEqual(tuple(c.code for c in result.blockers), (gate.value,))

    def test_total_return_only_never_substitutes_for_ordered_and_financial_parity(self) -> None:
        request = synthetic_request(synthetic_pins())
        request = omit_gate(omit_gate(request, EvidenceGate.ORDERED_EVENTS), EvidenceGate.FINANCIAL_PARITY)
        result = evaluate_compatibility(request)
        self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
        self.assertEqual({c.code for c in result.blockers}, {EvidenceGate.ORDERED_EVENTS.value, EvidenceGate.FINANCIAL_PARITY.value})

    def test_failed_evidence_and_other_unknowns_remain_visible(self) -> None:
        request = synthetic_request(synthetic_pins())
        request = replace(request, receipts=(replace(request.receipts[0], state=EvidenceState.FAIL),) + request.receipts[1:])
        result = evaluate_compatibility(omit_gate(request, EvidenceGate.LATENCY))
        self.assertEqual(result.status, AssessmentStatus.BLOCKED)
        self.assertIn(EvidenceGate.LATENCY.value, {c.code for c in result.unknowns})
        self.assertIn(EvidenceGate.ISOLATED_ENVIRONMENT.value, {c.code for c in result.blockers})

    def test_unknown_or_unreferenced_receipt_is_not_a_pass(self) -> None:
        request = synthetic_request(synthetic_pins())
        for changed in (
            replace(request.receipts[0], state=EvidenceState.UNKNOWN),
            replace(request.receipts[0], report_ref=None),
            replace(request.receipts[0], report_ref="  "),
        ):
            result = evaluate_compatibility(replace(request, receipts=(changed,) + request.receipts[1:]))
            self.assertEqual(result.status, AssessmentStatus.UNKNOWN)

    def test_report_references_are_opaque_and_malformed_values_are_not_echoed(self) -> None:
        request = synthetic_request(synthetic_pins())
        for invalid in (
            "/private/synthetic-report", "https://example.invalid/synthetic-report",
            "synthetic-credential-canary", "report-" + "c" * 65,
            "report-" + "C" * 64, "report-" + "c" * 64 + "\n",
        ):
            with self.subTest(invalid=invalid):
                receipt = replace(request.receipts[0], report_ref=invalid)
                result = evaluate_compatibility(replace(request, receipts=(receipt,) + request.receipts[1:]))
                self.assertEqual(result.status, AssessmentStatus.BLOCKED)
                self.assertNotIn(invalid, repr(receipt))
                self.assertNotIn(invalid, repr(result))
                self.assertIsNone(result.blockers[0].report_ref)

    def test_identity_fields_are_not_exposed_in_nested_repr(self) -> None:
        request = synthetic_request(synthetic_pins())
        for value in (request.pins.account_ref, request.pins.client_identity):
            self.assertNotIn(value, repr(request.pins))
            self.assertNotIn(value, repr(request))
        self.assertNotIn("client_id=", repr(request.pins))
        invalid = synthetic_pins(account_ref="synthetic-sensitive-canary")
        result = evaluate_compatibility(synthetic_request(invalid))
        self.assertEqual(result.status, AssessmentStatus.BLOCKED)
        self.assertNotIn(invalid.account_ref, repr(invalid))
        self.assertNotIn(invalid.account_ref, repr(result))

    def test_duplicate_receipts_cannot_choose_a_favorable_result(self) -> None:
        request = synthetic_request(synthetic_pins())
        duplicate = replace(request.receipts[0], state=EvidenceState.FAIL)
        result = evaluate_compatibility(replace(request, receipts=request.receipts + (duplicate,)))
        self.assertEqual(result.status, AssessmentStatus.BLOCKED)
        self.assertIn("duplicate", result.blockers[0].detail)

    def test_receipts_bind_every_pin_including_environment_digest_and_client(self) -> None:
        request = synthetic_request(synthetic_pins())
        for changes in (
            {"package_version": "2.0.0rc5", "source_tag": "v2.0.0rc5"},
            {"scope": EvaluationScope.RESEARCH}, {"client_id": 18},
            {"gateway_image_digest": "sha256:" + "f" * 64},
            {"account_ref": "acctref-" + "f" * 64},
            {"isolated_environment_id": "another-isolated-environment"},
            {"wheel_sha256": "f" * 64}, {"interpreter_abi": "another-abi"},
        ):
            with self.subTest(changes=changes):
                result = evaluate_compatibility(replace(request, pins=replace(request.pins, **changes)))
                self.assertEqual(result.status, AssessmentStatus.BLOCKED)
                self.assertTrue(any("exact requested pins" in c.detail for c in result.blockers))

    def test_live_scope_cannot_be_promoted_by_any_release_metadata_or_receipts(self) -> None:
        for version in ("1.231.0", "2.0.0rc5"):
            result = evaluate_compatibility(synthetic_request(synthetic_pins(version, scope=EvaluationScope.LIVE)))
            self.assertEqual(result.status, AssessmentStatus.BLOCKED)
            self.assertIn("evaluation_scope", {c.code for c in result.blockers})
            self.assertFalse(result.trading_authorized)

    def test_inputs_and_results_are_immutable(self) -> None:
        request = synthetic_request(synthetic_pins())
        result = evaluate_compatibility(request)
        for value, field, replacement in (
            (request, "receipts", ()), (request.pins, "client_id", 99),
            (request.receipts[0], "state", EvidenceState.FAIL),
            (result, "checks", ()), (result.checks[0], "detail", "changed"),
            (V2_RC5, "version", "latest"), (SOURCE_REFERENCES[0], "locator", "changed"),
        ):
            with self.subTest(field=field):
                with self.assertRaises(FrozenInstanceError):
                    setattr(value, field, replacement)
        with self.assertRaises(TypeError):
            CompatibilityRequest(request.pins, list(request.receipts))
        with self.assertRaises(TypeError):
            RuntimePins(client_id=True)
        with self.assertRaises(TypeError):
            RuntimePins(scope="paper")
        with self.assertRaises(TypeError):
            RuntimePins(interpreter_abi=[])
        with self.assertRaises(TypeError):
            EvidenceReceipt("wheel_host_abi", request.pins)


class PrereleaseTests(unittest.TestCase):
    def test_rc5_is_conditional_not_blanket_rejected(self) -> None:
        request = synthetic_request(synthetic_pins("2.0.0rc5"))
        result = evaluate_compatibility(request)
        self.assertEqual(result.status, AssessmentStatus.EVIDENCE_COMPLETE)
        self.assertIs(result.release, V2_RC5)
        self.assertFalse(result.runtime_compatibility_proven)
        self.assertFalse(result.trading_authorized)

    def test_rc5_requires_exception_and_release_specific_migration_evidence(self) -> None:
        request = synthetic_request(synthetic_pins("2.0.0rc5"))
        for gate in (
            EvidenceGate.PRERELEASE_EXCEPTION, EvidenceGate.RC5_RELEASE_PARITY,
            EvidenceGate.COPIED_DATA_MIGRATION, EvidenceGate.CORRECTED_VOIDED_FILLS,
            EvidenceGate.LEGACY_EVENT_RESTORATION,
        ):
            with self.subTest(gate=gate):
                result = evaluate_compatibility(omit_gate(request, gate))
                self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
                self.assertEqual(tuple(c.code for c in result.blockers), (gate.value,))

    def test_rc5_python_and_rust_pins_are_release_specific(self) -> None:
        for python in ("3.11.9", "3.15.0", "4.0.0"):
            result = evaluate_compatibility(synthetic_request(synthetic_pins("2.0.0rc5", python_version=python)))
            self.assertEqual(result.status, AssessmentStatus.BLOCKED)
            self.assertIn("rc5_python_range", {c.code for c in result.blockers})
        for python in ("3.12.0", "3.14.9"):
            result = evaluate_compatibility(synthetic_request(synthetic_pins("2.0.0rc5", python_version=python)))
            self.assertEqual(result.status, AssessmentStatus.EVIDENCE_COMPLETE)
        result = evaluate_compatibility(synthetic_request(synthetic_pins("2.0.0rc5", rust_toolchain="1.98.0")))
        self.assertEqual(result.status, AssessmentStatus.BLOCKED)
        self.assertIn("rc5_rust_toolchain", {c.code for c in result.blockers})

    def test_v1_factory_surface_needs_rc5_migration_not_fictional_registration(self) -> None:
        baseline = synthetic_request(synthetic_pins(adapter_surface=AdapterSurface.V1_OUT_OF_TREE_FACTORIES))
        self.assertNotIn(EvidenceGate.V1_FACTORY_MIGRATION, required_evidence_gates(baseline.pins))
        self.assertEqual(evaluate_compatibility(baseline).status, AssessmentStatus.EVIDENCE_COMPLETE)
        rc5 = synthetic_request(synthetic_pins("2.0.0rc5", adapter_surface=AdapterSurface.V1_OUT_OF_TREE_FACTORIES))
        blocked = evaluate_compatibility(omit_gate(rc5, EvidenceGate.V1_FACTORY_MIGRATION))
        self.assertIn(EvidenceGate.V1_FACTORY_MIGRATION.value, {c.code for c in blocked.blockers})
        self.assertEqual(evaluate_compatibility(rc5).status, AssessmentStatus.EVIDENCE_COMPLETE)

    def test_rc5_postgresql_is_not_strategy_or_synthetic_restoration_evidence(self) -> None:
        request = synthetic_request(synthetic_pins("2.0.0rc5", persistence_backend=PersistenceBackend.POSTGRESQL_CACHE))
        result = evaluate_compatibility(omit_gate(request, EvidenceGate.POSTGRES_STATE_RESTORATION))
        self.assertEqual(result.status, AssessmentStatus.UNKNOWN)
        self.assertIn(EvidenceGate.POSTGRES_STATE_RESTORATION.value, {c.code for c in result.blockers})
        self.assertEqual(evaluate_compatibility(request).status, AssessmentStatus.EVIDENCE_COMPLETE)
        baseline = synthetic_pins(persistence_backend=PersistenceBackend.POSTGRESQL_CACHE)
        self.assertNotIn(EvidenceGate.POSTGRES_STATE_RESTORATION, required_evidence_gates(baseline))


if __name__ == "__main__":
    unittest.main()
