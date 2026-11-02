"""Synthetic boundary/lineage tests. No public-validator substitute ships.

The allowlists admit enumerated fixture bytes only, never real review or rights.
Actual authoritative contract/codec integration is a separate production gate.
"""
from dataclasses import FrozenInstanceError, asdict, replace
from datetime import UTC, datetime
import hashlib
import json

import pytest

from backtesting.lineage import (
    ASSUMPTION_KINDS, LEAKAGE_KINDS, AcceptanceCriterion, DataPin, ForwardCriteria, ForwardSample,
    Incident, LineageInputs, ModelAssumption, Pin, PointInTimeEvidence,
    TimeWindow, TrialRegistry, WalkForwardFold, assess_forward, time_ns,
)
from backtesting.planner import (
    BacktestPlanner, BacktestRequest, DatasetInput, EngineDescriptor, SandboxReceipt,
    SimulationOutput,
)
from backtesting.ports import ContractRejected, PortUnavailable, PublicBoundary, ResourceBudget, capture_json


def moment(day: int) -> datetime:
    return datetime(2026, 1, day, tzinfo=UTC)


class SyntheticCodec:
    """Finite ASCII fixture domain only; deliberately not a production fallback."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()


class ExactFixtureAuthority:
    def __init__(self, codec):
        self.codec = codec
        self.allowed = set()
        self.calls = []
        self.reviewed = set()
        self.review_calls = []

    def allow_review(self, payload):
        self.reviewed.add(self.codec.encode(payload))

    def review(self, artifact):
        """Synthetic current-review port, independent of embedded status labels."""
        self.review_calls.append(artifact.digest)
        if artifact.payload_bytes not in self.reviewed:
            raise PortUnavailable("synthetic-current-review-denied")
        if hashlib.sha256(artifact.payload_bytes).hexdigest() != artifact.digest:
            raise PortUnavailable("synthetic-current-review-digest-mismatch")

    def allow(self, name, payload):
        self.allowed.add((name, self.codec.encode(payload)))

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.calls.append((contract_name, schema_version))
        return schema_version == "1.0.0" and (contract_name, self.codec.encode(payload)) in self.allowed


class SyntheticEngine:
    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.simulation_calls = 0

    def describe(self):
        return self.descriptor

    def simulate(self, request):
        self.simulation_calls += 1
        raise RuntimeError("synthetic engine intentionally unavailable")


def fixture_request():
    codec = SyntheticCodec()
    authority = ExactFixtureAuthority(codec)
    boundary = PublicBoundary(validator=authority, codec=codec)
    costs = {"commissionPerUnit": "1", "spreadBps": "2", "slippageBps": "3", "borrowAnnualBps": "4",
             "impactModel": "fixed-bps", "maximumParticipationBps": "100"}
    code_pin = Pin("strategy-code", "1.0.0", "a" * 64)
    engine_pin = Pin("synthetic-engine", "1.0.0", "b" * 64)
    calendar_pin = Pin("synthetic-calendar", "1.0.0", "c" * 64)
    spec = {
        "schemaVersion": "1.0.0", "strategyId": "strategy-a", "version": "1.0.0", "sleeve": "quant",
        "hypothesis": "Synthetic hypothesis only", "universe": ["instrument-a"],
        "signalSchedule": {"calendar": "synthetic-calendar", "timezone": "UTC", "interval": "bar-close"},
        "entryRules": [{"ruleId": "entry-a", "featureId": "feature-a", "operator": "gt", "threshold": "0", "lookbackBars": 1}],
        "exitRules": [{"ruleId": "exit-a", "featureId": "feature-a", "operator": "lte", "threshold": "0", "lookbackBars": 1}],
        "riskLimits": {"maximumLoss": "1", "maximumNotional": "10", "maximumPositions": 1},
        "requiredData": [{"kind": "candles", "maximumAgeMs": 1_000_000_000, "pointInTimeRequired": True, "entitlementPolicyId": "rights-a"}],
        "costModel": costs, "codeDigest": code_pin.digest,
    }
    content = b'[{"synthetic":true,"close":"10"}]'
    content_digest = hashlib.sha256(content).hexdigest()
    source_digest = "d" * 64
    dataset = {
        "schemaVersion": "1.0.0", "datasetId": "dataset-a", "provider": "synthetic", "entitlementPolicyId": "rights-a",
        "instrumentUniverse": ["instrument-a"], "startAtInclusive": "2026-01-01T00:00:00Z", "endAtExclusive": "2026-01-20T00:00:00Z",
        "captureTime": "2026-01-21T00:00:00Z", "dataVintageId": "vintage-a", "dataVintageStatus": "available",
        "asOfAt": "2026-01-20T00:00:00Z", "adjustmentMethod": "unadjusted", "calendar": calendar_pin.identity,
        "contentHash": content_digest, "storageRef": "not-persisted-synthetic", "retentionPolicy": "synthetic",
        "sources": [{"provider": "synthetic", "sourceId": "source-a", "snapshotId": "snapshot-a", "contentHash": source_digest}],
        "gammaProvenance": None,
    }
    evidence = {
        "schemaVersion": "1.0.0", "evidenceId": "evidence-plan", "collectionId": "synthetic-collection", "snapshotId": "snapshot-a",
        "sourceType": "derived-analysis", "sourceUri": "https://example.invalid/synthetic", "sourceIdentity": dataset["sources"][0],
        "sourceLocator": "synthetic", "attribution": "synthetic fixture", "publishedAt": "2026-01-01T00:00:00Z",
        "capturedAt": "2026-01-08T00:00:00Z", "contentHash": source_digest, "claim": "Synthetic only", "method": "Fixture",
        "limitations": ["Not empirical evidence"], "acceptanceStatus": "accepted", "rightsPolicyId": "rights-a", "untrustedContent": True,
    }
    run = {
        "schemaVersion": "1.0.0", "runId": "run-a", "strategyVersion": "strategy-a-v1", "datasetManifestIds": ["dataset-a"],
        "seed": 7, "engineVersion": "1.0.0", "trainingWindow": {"startAtInclusive": "2026-01-01T00:00:00Z", "endAtExclusive": "2026-01-10T00:00:00Z"},
        "testWindow": {"startAtInclusive": "2026-01-10T00:00:00Z", "endAtExclusive": "2026-01-20T00:00:00Z"},
        "benchmark": "benchmark-a", "transactionCosts": costs, "slippageModel": "fixed-bps", "resultsRef": None,
        "leakageChecks": [{"kind": kind, "status": "passed", "evidenceId": "evidence-plan"} for kind in sorted(LEAKAGE_KINDS)],
        "reviewStatus": "unreviewed", "validationMode": "historical", "forwardSampleCount": 0, "gammaProvenance": None,
    }
    for name, record in (("StrategySpec", spec), ("BacktestRun", run), ("DatasetManifest", dataset), ("ResearchEvidence", evidence)):
        authority.allow(name, record)
    authority.allow_review(evidence)
    assumptions = tuple(ModelAssumption(kind, "modeled", Pin("model-" + kind, "1.0.0", "e" * 64),
                                        capture_json({**costs, "policy": "synthetic-explicit-policy"}), ("evidence-plan",))
                        for kind in sorted(ASSUMPTION_KINDS))
    lineage = LineageInputs(
        "strategy-a-v1", moment(9), code_pin, engine_pin,
        (DataPin("dataset-a", codec.digest(dataset), content_digest, (source_digest,), calendar_pin, "vintage-a", "evidence-plan", ("candles",)),),
        (PointInTimeEvidence("evidence-plan", "dataset-a", "source-a", source_digest, moment(1), moment(1), moment(1), moment(1), moment(10), "vintage-a"),),
        assumptions,
        (WalkForwardFold("fold-a", TimeWindow(moment(1), moment(10)), TimeWindow(moment(10), moment(20)), moment(10), moment(9), 0, 0, "f" * 64, ("evidence-plan",)),),
        TrialRegistry(("trial-a",), "trial-a", "1" * 64, moment(9), "evidence-plan"),
        ForwardCriteria(moment(9), moment(22), 2, 86_400_000, 1, 0, "2" * 64, ("evidence-plan",)), (), ("evidence-plan",),
        (AcceptanceCriterion("net-return", "gte", "0", moment(9), ("evidence-plan",)),),
    )
    descriptor = EngineDescriptor(engine_pin, tuple(sorted(ASSUMPTION_KINDS)), ("synthetic-json",), "3" * 64, True)
    engine = SyntheticEngine(descriptor)
    request = BacktestRequest(capture_json(spec), capture_json(run), (DatasetInput(capture_json(dataset), content, "synthetic-json", 1),),
                              (capture_json(evidence),), lineage, ResourceBudget(), moment(22))
    return request, boundary, engine, authority


def test_plan_immutable_complete_pins_and_no_engine_simulation_during_planning():
    request, boundary, engine, authority = fixture_request()
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(request)
    assert plan.status == "ready"
    assert plan.reasons == ()
    assert engine.simulation_calls == 0
    assert all(version == "1.0.0" for _, version in authority.calls)
    assert authority.review_calls == [plan.evidence[0].digest]
    assert plan.lineage.decode()["proposalOnly"] is True
    assert plan.execution_authorized is False
    changed = plan.strategy.decode()
    changed["hypothesis"] = "mutation"
    assert plan.strategy.decode()["hypothesis"] != "mutation"
    with pytest.raises(FrozenInstanceError):
        plan.status = "accepted"


def test_missing_validator_codec_engine_and_dataset_are_not_realism():
    request, boundary, engine, authority = fixture_request()
    unavailable = BacktestPlanner(boundary=PublicBoundary(validator=None, codec=None)).plan(request)
    assert unavailable.status == "unavailable"
    assert set(unavailable.missing_ports) == {
        "authoritative-contract-validator", "vertex-canonical-codec", "simulation-engine", "current-citation-review",
    }
    no_engine = BacktestPlanner(boundary=boundary, citation_review=authority.review).plan(request)
    assert no_engine.status == "unavailable"
    assert no_engine.missing_ports == ("simulation-engine",)
    no_review = BacktestPlanner(boundary=boundary, engine=engine).plan(request)
    assert no_review.status == "unavailable"
    assert no_review.missing_ports == ("current-citation-review",)
    assert "current-citation-review-unavailable" in no_review.reasons
    missing_data = replace(request, datasets=(replace(request.datasets[0], content_bytes=None),))
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(missing_data)
    assert "dataset-content-unavailable" in plan.reasons
    assert plan.status == "inconclusive"


def test_public_authority_requires_literal_true_not_truthiness():
    class Truthy:
        def validate(self, *args, **kwargs):
            return {"valid": True}
    with pytest.raises(ContractRejected):
        PublicBoundary(validator=Truthy(), codec=SyntheticCodec()).public("StrategySpec", {"synthetic": True})
    with pytest.raises(PortUnavailable):
        PublicBoundary(validator=None, codec=None).public("BacktestRun", {})


def test_codec_bytes_digest_mismatch_and_validator_mutation_rejected():
    class WrongDigest(SyntheticCodec):
        def digest(self, value):
            return "0" * 64
    class Mutating:
        def validate(self, name, value, schema_version="1.0.0"):
            value["changed"] = True
            return True
    with pytest.raises(ValueError):
        PublicBoundary(validator=None, codec=WrongDigest()).internal("internal.Synthetic", {"x": 1})
    with pytest.raises(ContractRejected):
        PublicBoundary(validator=Mutating(), codec=SyntheticCodec()).public("BacktestRun", {"x": 1})


@pytest.mark.parametrize("mutation,reason", [
    (lambda inputs: replace(inputs, code_pin=replace(inputs.code_pin, digest="0" * 64)), "code-pin-mismatch"),
    (lambda inputs: replace(inputs, assumptions=inputs.assumptions[:-1]), "economic-assumptions-incomplete"),
    (lambda inputs: replace(inputs, point_in_time=()), "point-in-time-coverage-incomplete"),
    (lambda inputs: replace(inputs, trials=None), "multiple-testing-registry-missing"),
    (lambda inputs: replace(inputs, folds=()), "out-of-sample-folds-missing"),
    (lambda inputs: replace(inputs, forward_criteria=None), "forward-sampling-criteria-missing"),
    (lambda inputs: replace(inputs, incidents=(Incident("incident-a", "data-gap", "blocking", ("evidence-plan",)),)), "open-blocking-incident"),
])
def test_incomplete_research_artifacts_are_retained(mutation, reason):
    request, boundary, engine, authority = fixture_request()
    request = replace(request, lineage=mutation(request.lineage))
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(request)
    assert plan.status == "inconclusive"
    assert reason in plan.reasons
    assert plan.request is request
    assert plan.lineage is not None


def test_walk_forward_purge_embargo_and_late_revision_gates():
    request, boundary, engine, authority = fixture_request()
    fold = replace(request.lineage.folds[0], purge_ms=2 * 86_400_000)
    point = replace(request.lineage.point_in_time[0], available_at=moment(11), revision_at=moment(11))
    lineage = replace(request.lineage, folds=(fold,), point_in_time=(point,))
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(replace(request, lineage=lineage))
    assert "purge-or-embargo-insufficient" in plan.reasons
    assert "point-in-time-causality-failed" in plan.reasons
    assert plan.status == "inconclusive"


def test_nanosecond_windows_are_not_silently_truncated():
    assert time_ns("2026-01-01T00:00:00.000000001Z") - time_ns("2026-01-01T00:00:00Z") == 1


def test_simulator_failure_is_retained_not_retried_and_not_realism():
    request, boundary, engine, authority = fixture_request()
    planner = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review)
    plan = planner.plan(request)
    result = planner.simulate(plan, as_of=moment(23))
    assert result.status == "inconclusive"
    assert result.realism_qualified is False
    assert engine.simulation_calls == 1
    assert result.reasons == ("simulation-engine-failed-no-retry",)


def test_forward_sampling_excludes_supplied_and_simulated_economics():
    request, boundary, engine, authority = fixture_request()
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(request)
    sample = ForwardSample("sample-a", plan.strategy.digest, plan.lineage.digest, moment(23), moment(23), "regime-a", "evidence-plan", "supplied-outcome")
    result = assess_forward(criteria=request.lineage.forward_criteria, samples=(sample,), incidents=(),
                            strategy_digest=plan.strategy.digest, lineage_digest=plan.lineage.digest,
                            as_of=moment(24), evidence_ids=frozenset({"evidence-plan"}))
    assert result.sample_count == 0
    assert not result.qualified
    assert result.samples == (sample,)
    assert "ineligible-forward-sample" in result.reasons


def test_engine_sandbox_receipt_must_cover_limits_network_and_execution():
    request, _, engine, _ = fixture_request()
    receipt = SandboxReceipt(engine.descriptor.sandbox_policy_digest, request.budget, True, False, False,
                             100, 1, 1000, 5, 10, "isolation-a")
    assert receipt.qualified(engine.descriptor, request.budget)
    assert not replace(receipt, network_used=True).qualified(engine.descriptor, request.budget)
    assert not replace(receipt, execution_authority_used=True).qualified(engine.descriptor, request.budget)
    assert not replace(receipt, limits_enforced=False).qualified(engine.descriptor, request.budget)
    assert not replace(receipt, wall_ms=100_000).qualified(engine.descriptor, request.budget)


def test_preregistered_metrics_compare_exact_decimals_and_fail_closed():
    criterion = AcceptanceCriterion("net-return", "gte", "0.000000000000000001", moment(9), ("evidence-plan",))
    assert criterion.accepts("0.000000000000000001")
    assert not criterion.accepts("0")
    with pytest.raises(ValueError):
        criterion.accepts(0.000000000000000001)
    request, boundary, engine, authority = fixture_request()
    late = replace(request.lineage.acceptance_criteria[0], registered_at=moment(11))
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review).plan(
        replace(request, lineage=replace(request.lineage, acceptance_criteria=(late,)))
    )
    assert "metric-criteria-registered-after-oos" in plan.reasons


def synthetic_output(plan, boundary, authority, *, evidence_acceptance="unreviewed", **output_changes):
    economics = {"metricScope": "out-of-sample", "metrics": {"net-return": "0.1"}, "netPnl": "1"}
    economics_bytes = capture_json(economics)
    evidence = plan.evidence[0].decode()
    evidence["evidenceId"] = "evidence-simulator"
    evidence["acceptanceStatus"] = evidence_acceptance
    evidence["publishedAt"] = "2026-01-23T00:00:00Z"
    evidence["capturedAt"] = "2026-01-23T00:00:00Z"
    evidence["contentHash"] = hashlib.sha256(economics_bytes).hexdigest()
    evidence["sourceIdentity"] = {**evidence["sourceIdentity"], "sourceId": "simulator-proof", "contentHash": evidence["contentHash"]}
    authority.allow("ResearchEvidence", evidence)
    receipt = SandboxReceipt(plan.engine.sandbox_policy_digest, plan.request.budget, True, False, False,
                             100, 1, 1000, 5, 10, "evidence-simulator")
    assumptions = boundary.internal("internal.Assumptions.v1", [item.record() for item in plan.request.lineage.assumptions])
    output = SimulationOutput(
        plan.lineage.digest, plan.strategy.digest, plan.engine.pin,
        tuple(item.decode()["contentHash"] for item in plan.datasets), assumptions.digest,
        economics_bytes, (capture_json(evidence),), plan.engine.modeled_assumptions,
        receipt, True, True, True, "completed",
    )
    output = replace(output, **output_changes)
    forward = assess_forward(
        criteria=plan.request.lineage.forward_criteria, samples=(), incidents=plan.request.lineage.incidents,
        strategy_digest=plan.strategy.digest, lineage_digest=plan.lineage.digest, as_of=moment(24),
        evidence_ids=frozenset([item.decode()["evidenceId"] for item in plan.evidence] + [evidence["evidenceId"]]),
    )
    evidence_artifact = boundary.public("ResearchEvidence", evidence)
    result = boundary.internal("internal.SimulatedBacktestResults.v1", {
        "lineageDigest": output.lineage_digest, "strategyDigest": output.strategy_digest,
        "enginePin": asdict(output.engine_pin), "datasetContentDigests": list(output.dataset_content_digests),
        "assumptionDigest": output.assumption_digest, "economics": economics,
        "economicsOrigin": "injected-simulation-engine", "economicsSimulated": output.economics_simulated,
        "sandbox": asdict(output.sandbox), "evidenceDigests": [evidence_artifact.digest],
        "incidentCodes": [], "executionAuthorized": False,
        "forwardAssessment": forward.record(),
    })
    # Register only the two exact records this bounded fixture can prepare.
    # Neither is an independently reviewed accepted run.
    for status in ("unreviewed", "incomplete"):
        authority.allow("BacktestRun", {
            **plan.run.decode(), "reviewStatus": status, "resultsRef": "backtest-results-" + result.digest,
            "forwardSampleCount": forward.sample_count,
        })
    return output


def test_simulated_economics_require_exact_pins_evidence_and_independent_review():
    request, boundary, engine, authority = fixture_request()
    planner = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review)
    plan = planner.plan(request)
    output = synthetic_output(plan, boundary, authority)
    completed = planner.complete(plan, output, as_of=moment(24))
    assert completed.status == "unreviewed"
    assert completed.reasons == ()
    assert completed.realism_qualified
    assert completed.run.decode()["reviewStatus"] == "unreviewed"
    assert completed.evidence[-1].decode()["acceptanceStatus"] == "unreviewed"
    assert completed.execution_authorized is False
    assert completed.forward.qualified is False  # historical evidence is not forward-paper readiness
    assert engine.simulation_calls == 0
    self_accepted = planner.complete(plan, output, reviewed_acceptance=True, as_of=moment(24))
    assert self_accepted.status == "incomplete"
    assert not self_accepted.realism_qualified
    assert self_accepted.reasons == ("simulation-output-requires-independent-review",)
    forged_output = synthetic_output(plan, boundary, authority, economics_simulated=False)
    forged = planner.complete(plan, forged_output, as_of=moment(24))
    assert forged.status == "incomplete"
    assert not forged.realism_qualified
    assert forged.reasons == ("simulation-economics-data-or-causality-unqualified",)
    assert forged.output.economics_simulated is False
    stale_output = synthetic_output(plan, boundary, authority, lineage_digest="0" * 64)
    stale = planner.complete(plan, stale_output, as_of=moment(24))
    assert stale.status == "incomplete"
    assert not stale.realism_qualified
    assert stale.reasons == ("simulation-lineage-pin-mismatch",)
    assert stale.output.lineage_digest == "0" * 64


def test_embedded_accepted_simulator_evidence_cannot_review_itself():
    request, boundary, engine, authority = fixture_request()
    planner = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review)
    plan = planner.plan(request)
    output = synthetic_output(plan, boundary, authority, evidence_acceptance="accepted")
    result = planner.complete(plan, output, as_of=moment(24))
    assert result.status == "incomplete"
    assert result.reasons == ("simulation-evidence-must-remain-unreviewed",)
    assert not result.realism_qualified


def test_current_review_is_checked_again_at_completion_and_can_be_revoked():
    request, boundary, engine, authority = fixture_request()
    planner = BacktestPlanner(boundary=boundary, engine=engine, citation_review=authority.review)
    plan = planner.plan(request)
    output = synthetic_output(plan, boundary, authority)
    authority.reviewed.clear()
    result = planner.complete(plan, output, as_of=moment(24))
    assert result.status == "unavailable"
    assert result.reasons == ("plan-identity-not-reproducible", "required-port-unavailable")
    assert authority.review_calls == [plan.evidence[0].digest, plan.evidence[0].digest]
    assert result.results is None
    assert result.output is output
    assert not result.realism_qualified
    assert engine.simulation_calls == 0


def test_truthy_current_review_return_does_not_admit_even_accepted_evidence():
    request, boundary, engine, _ = fixture_request()
    plan = BacktestPlanner(boundary=boundary, engine=engine, citation_review=lambda artifact: True).plan(request)
    assert plan.status == "unavailable"
    assert plan.reasons == ("required-port-unavailable",)
    assert engine.simulation_calls == 0
