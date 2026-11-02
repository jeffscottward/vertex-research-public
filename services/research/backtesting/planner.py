"""Source-only StrategySpec/BacktestRun planning and explicit simulator orchestration.

The simulator is a separate owner. No implicit engine, canonical codec, validator,
clock, store, model, provider, network, filesystem, reservation or broker exists.
Planning and completing a result return immutable publication candidates only.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Protocol

from .lineage import (
    ASSUMPTION_KINDS, LEAKAGE_KINDS, ForwardAssessment, ForwardSample,
    LineageInputs, Pin, assess_forward, time_ns, timestamp,
)
from .ports import (
    Artifact, ContractRejected, PortUnavailable, PublicBoundary, ResourceBudget,
    capture_json, decode_json, require_hash, require_id, utc,
)
from .replay import ReplayResult, ReplayRunner


@dataclass(frozen=True)
class DatasetInput:
    manifest_bytes: bytes
    content_bytes: bytes | None
    content_format: str
    declared_events: int

    def __post_init__(self) -> None:
        if not isinstance(self.manifest_bytes, bytes):
            raise ValueError("dataset manifest must be immutable bytes")
        if self.content_bytes is not None and not isinstance(self.content_bytes, bytes):
            raise ValueError("dataset content must be immutable bytes")
        require_id(self.content_format)
        if type(self.declared_events) is not int or self.declared_events < 1:
            raise ValueError("positive declared event budget required")


@dataclass(frozen=True)
class BacktestRequest:
    strategy_bytes: bytes
    run_bytes: bytes
    datasets: tuple[DatasetInput, ...]
    evidence_bytes: tuple[bytes, ...]
    lineage: LineageInputs
    budget: ResourceBudget
    planned_at: datetime
    replay_evidence: ReplayResult | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "datasets", tuple(self.datasets))
        object.__setattr__(self, "evidence_bytes", tuple(self.evidence_bytes))
        object.__setattr__(self, "planned_at", utc(self.planned_at))
        if any(not isinstance(value, bytes) for value in (self.strategy_bytes, self.run_bytes, *self.evidence_bytes)):
            raise ValueError("immutable request captures required")


@dataclass(frozen=True)
class EngineDescriptor:
    pin: Pin
    modeled_assumptions: tuple[str, ...]
    supported_formats: tuple[str, ...]
    sandbox_policy_digest: str
    simulation_only: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "modeled_assumptions", tuple(self.modeled_assumptions))
        object.__setattr__(self, "supported_formats", tuple(self.supported_formats))
        require_hash(self.sandbox_policy_digest)
        if self.simulation_only is not True:
            raise ValueError("engine must be simulation only")


@dataclass(frozen=True)
class BacktestPlan:
    request: BacktestRequest
    status: str
    strategy: Artifact | None
    run: Artifact | None
    datasets: tuple[Artifact, ...]
    evidence: tuple[Artifact, ...]
    lineage: Artifact | None
    reasons: tuple[str, ...]
    missing_ports: tuple[str, ...]
    engine: EngineDescriptor | None
    execution_authorized: bool = False


@dataclass(frozen=True)
class SandboxReceipt:
    policy_digest: str
    budget: ResourceBudget
    limits_enforced: bool
    network_used: bool
    execution_authority_used: bool
    input_bytes: int
    events_processed: int
    peak_memory_bytes: int
    cpu_ms: int
    wall_ms: int
    isolation_evidence_id: str

    def __post_init__(self) -> None:
        require_hash(self.policy_digest)
        require_id(self.isolation_evidence_id)
        for value in (self.input_bytes, self.events_processed, self.peak_memory_bytes, self.cpu_ms, self.wall_ms):
            if type(value) is not int or value < 0:
                raise ValueError("invalid sandbox resource accounting")

    def qualified(self, descriptor: EngineDescriptor, budget: ResourceBudget) -> bool:
        return (
            self.policy_digest == descriptor.sandbox_policy_digest and self.budget == budget
            and self.limits_enforced is True and self.network_used is False
            and self.execution_authority_used is False
            and self.input_bytes <= budget.maximum_input_bytes
            and 0 < self.events_processed <= budget.maximum_events
            and self.peak_memory_bytes <= budget.maximum_memory_bytes
            and self.cpu_ms <= budget.maximum_cpu_ms and self.wall_ms <= budget.maximum_wall_ms
        )


@dataclass(frozen=True)
class SimulationRequest:
    plan: BacktestPlan
    """Immutable sealed records plus pinned bytes; contains no executable order."""


@dataclass(frozen=True)
class SimulationOutput:
    lineage_digest: str
    strategy_digest: str
    engine_pin: Pin
    dataset_content_digests: tuple[str, ...]
    assumption_digest: str
    economics_bytes: bytes
    evidence_bytes: tuple[bytes, ...]
    modeled_assumptions: tuple[str, ...]
    sandbox: SandboxReceipt
    data_complete: bool
    point_in_time_enforced: bool
    economics_simulated: bool
    status: str
    incident_codes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for value in (self.lineage_digest, self.strategy_digest, self.assumption_digest):
            require_hash(value)
        for name in ("dataset_content_digests", "evidence_bytes", "modeled_assumptions", "incident_codes"):
            object.__setattr__(self, name, tuple(getattr(self, name)))
        for value in self.dataset_content_digests:
            require_hash(value)
        if not isinstance(self.economics_bytes, bytes) or len(self.economics_bytes) > 8_000_000:
            raise ValueError("bounded immutable economics required")
        for value in self.evidence_bytes:
            if not isinstance(value, bytes):
                raise ValueError("immutable simulation evidence required")
        if self.status not in {"completed", "rejected", "inconclusive"}:
            raise ValueError("unknown simulation output status")
        for code in self.incident_codes:
            require_id(code)


class SimulationEngine(Protocol):
    """Host MUST enforce requested limits/isolation outside this Python module.

    describe() is metadata only. simulate() is called only by explicit simulate(),
    never by planning or import. The adapter must have no broker/network capability.
    Engine failure and rejected/inconclusive results remain publication artifacts.
    """
    def describe(self) -> EngineDescriptor: ...
    def simulate(self, request: SimulationRequest) -> SimulationOutput: ...


class CitationReviewAdmission(Protocol):
    """Trusted synchronous current-review check over exact original evidence.

    Return None only after admitting a current accepted review and rights for
    this artifact; raise on denial/unavailability. Embedded acceptance labels
    and caller/model booleans are not review authority. Called on every replan.
    """
    def __call__(self, evidence: Artifact) -> None: ...


@dataclass(frozen=True)
class BacktestCompletion:
    plan: BacktestPlan
    output: SimulationOutput | None
    status: str
    run: Artifact | None
    results: Artifact | None
    evidence: tuple[Artifact, ...]
    reasons: tuple[str, ...]
    realism_qualified: bool
    forward: ForwardAssessment | None
    execution_authorized: bool = False


def _window_contains(window: dict[str, Any], start: datetime, end: datetime) -> bool:
    return time_ns(window["startAtInclusive"]) <= time_ns(start) < time_ns(end) <= time_ns(window["endAtExclusive"])


class BacktestPlanner:
    def __init__(
        self, *, boundary: PublicBoundary, engine: SimulationEngine | None = None,
        citation_review: CitationReviewAdmission | None = None,
    ) -> None:
        self.boundary = boundary
        self.engine = engine
        self.citation_review = citation_review

    def plan(self, request: BacktestRequest) -> BacktestPlan:
        """Seal original input attempts, never silently repair an invalid public shape."""
        missing = (
            *self.boundary.missing_ports,
            *(("simulation-engine",) if self.engine is None else ()),
            *(("current-citation-review",) if self.citation_review is None else ()),
        )
        strategy: Artifact | None = None
        run: Artifact | None = None
        datasets: tuple[Artifact, ...] = ()
        evidence: tuple[Artifact, ...] = ()
        lineage: Artifact | None = None
        descriptor: EngineDescriptor | None = None
        if self.boundary.missing_ports:
            return BacktestPlan(request, "unavailable", None, None, (), (), None, (), missing, None)
        try:
            raw_bytes = len(request.strategy_bytes) + len(request.run_bytes)
            raw_bytes += sum(len(value) for value in request.evidence_bytes)
            raw_bytes += sum(len(item.manifest_bytes) + len(item.content_bytes or b"") for item in request.datasets)
            raw_bytes += len(capture_json(request.lineage.record(), maximum_bytes=request.budget.maximum_input_bytes))
            if request.replay_evidence is not None:
                replay_request = request.replay_evidence.request
                raw_bytes += len(replay_request.manifest_bytes or b"")
                raw_bytes += sum(len(item.payload_bytes) for item in replay_request.sources)
                raw_bytes += sum(len(item.payload_bytes) for item in replay_request.candidates)
                raw_bytes += sum(len(item.payload_bytes) for item in replay_request.replay_executions)
            if raw_bytes > request.budget.maximum_input_bytes:
                raise ValueError("request resource budget exceeded")
            if sum(item.declared_events for item in request.datasets) > request.budget.maximum_events:
                raise ValueError("dataset event budget exceeded")
            if len(request.lineage.folds) > request.budget.maximum_folds:
                raise ValueError("fold budget exceeded")
            if request.lineage.trials and len(request.lineage.trials.trial_ids) > request.budget.maximum_trials:
                raise ValueError("trial budget exceeded")
            strategy = self.boundary.public("StrategySpec", decode_json(request.strategy_bytes))
            run = self.boundary.public("BacktestRun", decode_json(request.run_bytes))
            datasets = tuple(self.boundary.public("DatasetManifest", decode_json(item.manifest_bytes)) for item in request.datasets)
            evidence = tuple(self.boundary.public("ResearchEvidence", decode_json(item)) for item in request.evidence_bytes)
            if self.engine is not None:
                descriptor = self.engine.describe()
                if not isinstance(descriptor, EngineDescriptor):
                    raise ValueError("engine metadata contract mismatch")
            reasons = self._qualification_reasons(request, strategy, run, datasets, evidence, descriptor)
            lineage = self.boundary.internal("internal.BacktestLineage.v1", {
                "strategyDigest": strategy.digest, "runDigest": run.digest,
                "datasetManifestDigests": [item.digest for item in datasets],
                "evidenceDigests": [item.digest for item in evidence],
                "lineage": request.lineage.record(), "budget": asdict(request.budget),
                "engineDescriptor": asdict(descriptor) if descriptor else None,
                "gammaReplayEvidence": request.replay_evidence.gamma_provenance() if request.replay_evidence else None,
                "gammaSourceCaptures": [{
                    "provider": item.provider, "manifestKey": item.manifest_key,
                    "sourceBytesSha256": item.source_bytes_sha256, "originalGammaHash": item.original_gamma_hash,
                } for item in request.replay_evidence.request.sources] if request.replay_evidence else [],
                "plannedAt": timestamp(request.planned_at), "proposalOnly": True, "executionAuthorized": False,
            })
            status = "unavailable" if missing else "inconclusive" if reasons else "ready"
            return BacktestPlan(request, status, strategy, run, datasets, evidence, lineage, reasons, missing, descriptor)
        except PortUnavailable:
            return BacktestPlan(request, "unavailable", strategy, run, datasets, evidence, lineage,
                                ("required-port-unavailable",), missing, descriptor)
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            return BacktestPlan(request, "rejected", strategy, run, datasets, evidence, lineage,
                                ("contract-lineage-or-budget-rejected",), missing, descriptor)
        except Exception:
            # Adapter exceptions are intentionally sanitized; request remains
            # available for private diagnostics, not exception payload printing.
            return BacktestPlan(request, "unavailable", strategy, run, datasets, evidence, lineage,
                                ("injected-port-failed",), missing, descriptor)

    def _qualification_reasons(
        self, request: BacktestRequest, strategy: Artifact, run: Artifact,
        datasets: tuple[Artifact, ...], evidence: tuple[Artifact, ...],
        descriptor: EngineDescriptor | None,
    ) -> tuple[str, ...]:
        spec, record = strategy.decode(), run.decode()
        inputs = request.lineage
        reasons: list[str] = []
        citations = {item.decode()["evidenceId"]: item.decode() for item in evidence}
        manifests = {item.decode()["datasetId"]: (item, item.decode()) for item in datasets}
        if len(citations) != len(evidence) or len(manifests) != len(datasets):
            reasons.append("duplicate-evidence-or-dataset-identity")
        if not inputs.citations or not set(inputs.citations).issubset(citations):
            reasons.append("citations-missing")
        if self.citation_review is None:
            reasons.append("current-citation-review-unavailable")
        else:
            for artifact in evidence:
                if self.citation_review(artifact) is not None:
                    raise PortUnavailable("citation-review-admission-contract")
        if any(time_ns(item["capturedAt"]) > time_ns(request.planned_at) for item in citations.values()):
            reasons.append("citation-from-future")
        if request.replay_evidence is not None:
            replay = ReplayRunner().plan(request.replay_evidence.request)
            if replay.status != "replay-evidence" or replay != request.replay_evidence:
                reasons.append("gamma-replay-evidence-not-reproducible")
            if record["gammaProvenance"] != replay.gamma_provenance():
                reasons.append("gamma-public-provenance-mismatch")
        elif record["gammaProvenance"] is not None:
            reasons.append("gamma-source-evidence-unavailable")
        if record["strategyVersion"] != inputs.strategy_version_id:
            reasons.append("strategy-version-lineage-mismatch")
        if len(spec["universe"]) > request.budget.maximum_candidates:
            reasons.append("strategy-universe-budget-exceeded")
        if spec["codeDigest"] != inputs.code_pin.digest:
            reasons.append("code-pin-mismatch")
        if inputs.strategy_frozen_at > request.planned_at:
            reasons.append("strategy-not-yet-frozen")
        if time_ns(inputs.strategy_frozen_at) > time_ns(record["testWindow"]["startAtInclusive"]):
            reasons.append("strategy-frozen-after-oos-start")
        if record["reviewStatus"] == "accepted" or record["resultsRef"] is not None:
            reasons.append("preaccepted-or-prepopulated-results-not-permitted")
        if record["reviewStatus"] == "rejected":
            reasons.append("review-already-rejected")
        if record["forwardSampleCount"] != 0:
            reasons.append("prepopulated-forward-count-not-permitted")
        if record["transactionCosts"] != spec["costModel"] or record["slippageModel"] != spec["costModel"]["impactModel"]:
            reasons.append("run-cost-or-slippage-differs-from-spec")
        if inputs.engine_pin is None or descriptor is None:
            reasons.append("simulation-engine-pin-unavailable")
        elif inputs.engine_pin != descriptor.pin or record["engineVersion"] != descriptor.pin.version:
            reasons.append("engine-pin-mismatch")
        pins = {pin.dataset_id: pin for pin in inputs.data_pins}
        if len(pins) != len(inputs.data_pins) or set(pins) != set(manifests) or set(manifests) != set(record["datasetManifestIds"]):
            reasons.append("dataset-pin-set-mismatch")
        for supplied, artifact in zip(request.datasets, datasets, strict=True):
            data = artifact.decode()
            pin = pins.get(data["datasetId"])
            if pin is None:
                continue
            if (pin.manifest_digest, pin.content_digest) != (artifact.digest, data["contentHash"]):
                reasons.append("dataset-digest-mismatch")
            if tuple(pin.source_digests) != tuple(source["contentHash"] for source in data["sources"]):
                reasons.append("dataset-source-pins-mismatch")
            if pin.calendar_pin.identity != data["calendar"] or data["calendar"] != spec["signalSchedule"]["calendar"]:
                reasons.append("calendar-pin-mismatch")
            if pin.vintage_id is None or data["dataVintageStatus"] != "available" or pin.vintage_id != data["dataVintageId"]:
                reasons.append("point-in-time-vintage-unavailable")
            if pin.entitlement_evidence_id not in citations:
                reasons.append("entitlement-evidence-missing")
            if not any(
                requirement["kind"] in pin.data_kinds
                and requirement["entitlementPolicyId"] == data["entitlementPolicyId"]
                for requirement in spec["requiredData"]
            ):
                reasons.append("dataset-kind-or-entitlement-policy-mismatch")
            if not set(spec["universe"]).issubset(data["instrumentUniverse"]):
                reasons.append("dataset-universe-incomplete")
            if time_ns(data["startAtInclusive"]) > time_ns(record["trainingWindow"]["startAtInclusive"]) or time_ns(data["endAtExclusive"]) < time_ns(record["testWindow"]["endAtExclusive"]):
                reasons.append("dataset-window-incomplete")
            if time_ns(data["captureTime"]) > time_ns(request.planned_at):
                reasons.append("dataset-capture-after-plan")
            if supplied.content_bytes is None:
                reasons.append("dataset-content-unavailable")
            elif hashlib.sha256(supplied.content_bytes).hexdigest() != data["contentHash"]:
                reasons.append("dataset-content-hash-mismatch")
            if descriptor is not None and supplied.content_format not in descriptor.supported_formats:
                reasons.append("dataset-format-unsupported")
        if not {item["kind"] for item in spec["requiredData"]}.issubset(
            kind for pin in inputs.data_pins for kind in pin.data_kinds
        ):
            reasons.append("required-data-kinds-incomplete")
        by_dataset: dict[str, int] = {}
        for point in inputs.point_in_time:
            by_dataset[point.dataset_id] = by_dataset.get(point.dataset_id, 0) + 1
            manifest = manifests.get(point.dataset_id)
            if manifest is not None:
                pin = pins.get(point.dataset_id)
                for requirement in spec["requiredData"]:
                    if pin is not None and requirement["kind"] in pin.data_kinds:
                        if time_ns(point.decision_at) - time_ns(point.observed_at) > requirement["maximumAgeMs"] * 1_000_000:
                            reasons.append("point-in-time-data-stale-for-spec")
            if not point.causal():
                reasons.append("point-in-time-causality-failed")
            if point.evidence_id not in citations:
                reasons.append("point-in-time-evidence-missing")
            if manifest is None or point.vintage_id != manifest[1]["dataVintageId"] or not any(
                source["sourceId"] == point.source_id and source["contentHash"] == point.source_digest
                for source in manifest[1]["sources"]
            ):
                reasons.append("point-in-time-source-identity-mismatch")
            if point.decision_at > request.planned_at:
                reasons.append("point-in-time-decision-after-plan")
        if set(by_dataset) != set(manifests):
            reasons.append("point-in-time-coverage-incomplete")
        assumptions = {item.kind: item for item in inputs.assumptions}
        if len(assumptions) != len(inputs.assumptions) or set(assumptions) != ASSUMPTION_KINDS:
            reasons.append("economic-assumptions-incomplete")
        for assumption in inputs.assumptions:
            if assumption.disposition == "missing" or not assumption.evidence_ids or not set(assumption.evidence_ids).issubset(citations):
                reasons.append("economic-assumption-evidence-missing")
            if any(
                citations[identity]["publishedAt"] is None
                or time_ns(citations[identity]["publishedAt"]) > time_ns(record["testWindow"]["startAtInclusive"])
                for identity in assumption.evidence_ids if identity in citations
            ):
                reasons.append("economic-model-evidence-unavailable-before-oos")
            if assumption.disposition == "modeled" and descriptor is not None and assumption.kind not in descriptor.modeled_assumptions:
                reasons.append("economic-assumption-not-modeled-by-engine")
            parameters = decode_json(assumption.parameters_bytes)
            if not parameters:
                reasons.append("economic-assumption-parameters-missing")
            if assumption.disposition == "not-applicable" and not parameters.get("reason"):
                reasons.append("economic-assumption-inapplicability-not-explained")
        cost_parameters = {
            "commission": ("commissionPerUnit",), "spread": ("spreadBps",),
            "slippage": ("slippageBps", "impactModel", "maximumParticipationBps"),
            "borrow": ("borrowAnnualBps",),
        }
        for kind, names in cost_parameters.items():
            assumption = assumptions.get(kind)
            if assumption is None:
                continue
            parameters = decode_json(assumption.parameters_bytes)
            if any(parameters.get(name) != spec["costModel"][name] for name in names):
                reasons.append("economic-cost-assumption-differs-from-spec")
        checks = {item["kind"]: item for item in record["leakageChecks"]}
        if set(checks) != LEAKAGE_KINDS or any(item["status"] != "passed" or item["evidenceId"] not in citations for item in checks.values()):
            reasons.append("leakage-gates-not-qualified")
        if not inputs.folds:
            reasons.append("out-of-sample-folds-missing")
        if record["validationMode"] == "walk-forward" and len(inputs.folds) < 2:
            reasons.append("walk-forward-needs-multiple-folds")
        if len({fold.fold_id for fold in inputs.folds}) != len(inputs.folds):
            reasons.append("duplicate-fold-identity")
        previous_end: datetime | None = None
        for fold in inputs.folds:
            reasons.extend(fold.failure_codes())
            # Walk-forward expands training with prior, already observed OOS;
            # it may not consume the current fold or overlap prior test windows.
            if time_ns(fold.training.start_at) < time_ns(record["trainingWindow"]["startAtInclusive"]) or not _window_contains(record["testWindow"], fold.test.start_at, fold.test.end_at):
                reasons.append("fold-outside-declared-window")
            if previous_end is not None and fold.test.start_at < previous_end:
                reasons.append("overlapping-or-unordered-oos-folds")
            if previous_end is not None and fold.test.start_at > previous_end:
                reasons.append("gap-in-declared-oos-coverage")
            previous_end = fold.test.end_at
            if not set(fold.evidence_ids).issubset(citations):
                reasons.append("fold-evidence-missing")
        if inputs.folds and (
            time_ns(inputs.folds[0].test.start_at) != time_ns(record["testWindow"]["startAtInclusive"])
            or time_ns(inputs.folds[-1].test.end_at) != time_ns(record["testWindow"]["endAtExclusive"])
            or time_ns(inputs.folds[0].training.start_at) != time_ns(record["trainingWindow"]["startAtInclusive"])
            or time_ns(inputs.folds[0].training.end_at) != time_ns(record["trainingWindow"]["endAtExclusive"])
        ):
            reasons.append("declared-train-oos-coverage-incomplete")
        if inputs.trials is None or inputs.trials.evidence_id not in citations:
            reasons.append("multiple-testing-registry-missing")
        elif time_ns(inputs.trials.registered_at) > time_ns(record["testWindow"]["startAtInclusive"]):
            reasons.append("trial-selection-policy-registered-after-oos")
        if not inputs.acceptance_criteria:
            reasons.append("preregistered-metric-criteria-missing")
        if len({item.metric_id for item in inputs.acceptance_criteria}) != len(inputs.acceptance_criteria):
            reasons.append("duplicate-preregistered-metric")
        for criterion in inputs.acceptance_criteria:
            if time_ns(criterion.registered_at) > time_ns(record["testWindow"]["startAtInclusive"]):
                reasons.append("metric-criteria-registered-after-oos")
            if not criterion.evidence_ids or not set(criterion.evidence_ids).issubset(citations):
                reasons.append("metric-criteria-evidence-missing")
        if inputs.forward_criteria is None:
            reasons.append("forward-sampling-criteria-missing")
        elif (
            inputs.forward_criteria.registered_at < inputs.strategy_frozen_at
            or inputs.forward_criteria.registered_at > request.planned_at
            or not inputs.forward_criteria.evidence_ids
            or not set(inputs.forward_criteria.evidence_ids).issubset(citations)
        ):
            reasons.append("forward-sampling-policy-not-evidenced")
        if any(item.severity == "blocking" and not item.resolved for item in inputs.incidents):
            reasons.append("open-blocking-incident")
        for incident in inputs.incidents:
            if not set(incident.evidence_ids).issubset(citations):
                reasons.append("incident-citation-missing")
        return tuple(dict.fromkeys(reasons))

    def simulate(self, plan: BacktestPlan, *, as_of: datetime) -> BacktestCompletion:
        """Explicit opt-in engine invocation; not called during source authoring.

        Does not catch-and-retry, open a transport, authorize execution, or persist.
        A rejected/incomplete plan never reaches the separately supplied engine.
        """
        if self.engine is None or plan.status != "ready" or plan.lineage is None:
            return BacktestCompletion(plan, None, "unavailable" if self.engine is None else "inconclusive",
                                      plan.run, None, plan.evidence, plan.reasons or ("simulation-not-ready",), False, None)
        # Re-seal/check every lineage pin rather than trust a caller-forged plan.
        fresh = self.plan(plan.request)
        if fresh.status != "ready" or fresh.lineage != plan.lineage:
            return BacktestCompletion(plan, None, "rejected", plan.run, None, plan.evidence,
                                      ("plan-changed-before-simulation",), False, None)
        try:
            result = self.engine.simulate(SimulationRequest(fresh))
        except Exception:
            return BacktestCompletion(fresh, None, "inconclusive", fresh.run, None, fresh.evidence,
                                      ("simulation-engine-failed-no-retry",), False, None)
        return self.complete(fresh, result, reviewed_acceptance=False, as_of=as_of)

    def complete(
        self, plan: BacktestPlan, output: SimulationOutput, *, reviewed_acceptance: bool = False,
        forward_samples: tuple[ForwardSample, ...] = (), as_of: datetime | None = None,
    ) -> BacktestCompletion:
        """Join an engine result, keeping raw rejected/inconclusive outputs.

        This is artifact preparation only, not storage publication. Acceptance
        requires explicit review and qualified simulator/data/model evidence;
        paper-forward additionally requires predeclared forward gates.
        """
        if plan.status != "ready" or plan.strategy is None or plan.run is None or plan.lineage is None or plan.engine is None:
            return BacktestCompletion(plan, output, "inconclusive", plan.run, None, plan.evidence,
                                      ("plan-not-qualified",), False, None)
        reasons: list[str] = []
        results: Artifact | None = None
        evidence = plan.evidence
        forward: ForwardAssessment | None = None
        try:
            fresh = self.plan(plan.request)
            if fresh.status != "ready" or fresh.lineage != plan.lineage:
                return BacktestCompletion(
                    plan, output, "unavailable" if fresh.status == "unavailable" else "rejected",
                    plan.run, None, plan.evidence,
                    tuple(dict.fromkeys(("plan-identity-not-reproducible", *fresh.reasons))), False, None,
                )
            if output.lineage_digest != plan.lineage.digest or output.strategy_digest != plan.strategy.digest or output.engine_pin != plan.engine.pin:
                reasons.append("simulation-lineage-pin-mismatch")
            expected_data = tuple(item.decode()["contentHash"] for item in plan.datasets)
            if output.dataset_content_digests != expected_data:
                reasons.append("simulation-dataset-pin-mismatch")
            assumptions = self.boundary.internal("internal.Assumptions.v1", [item.record() for item in plan.request.lineage.assumptions])
            if output.assumption_digest != assumptions.digest:
                reasons.append("simulation-assumption-pin-mismatch")
            modeled = {item.kind for item in plan.request.lineage.assumptions if item.disposition == "modeled"}
            if not modeled.issubset(output.modeled_assumptions):
                reasons.append("simulation-economic-model-coverage-incomplete")
            if not output.sandbox.qualified(plan.engine, plan.request.budget):
                reasons.append("sandbox-enforcement-not-qualified")
            if output.data_complete is not True or output.point_in_time_enforced is not True or output.economics_simulated is not True:
                reasons.append("simulation-economics-data-or-causality-unqualified")
            if output.status != "completed":
                reasons.append("simulation-" + output.status)
            reasons.extend(output.incident_codes)
            if sum(len(value) for value in output.evidence_bytes) + len(output.economics_bytes) > plan.request.budget.maximum_input_bytes:
                raise ValueError("simulation output byte budget exceeded")
            extra = tuple(self.boundary.public("ResearchEvidence", decode_json(value)) for value in output.evidence_bytes)
            evidence = (*plan.evidence, *extra)
            evidence_map = {item.decode()["evidenceId"]: item for item in evidence}
            if len(evidence_map) != len(evidence):
                reasons.append("duplicate-simulation-evidence-identity")
            if output.sandbox.isolation_evidence_id not in evidence_map:
                reasons.append("sandbox-isolation-evidence-missing")
            # New simulator artifacts cannot review themselves. Acceptance is
            # a later trusted overlay over these immutable original bytes.
            if not extra or any(item.decode()["acceptanceStatus"] != "unreviewed" for item in extra):
                reasons.append("simulation-evidence-must-remain-unreviewed")
            economics = decode_json(output.economics_bytes)
            if not isinstance(economics, dict) or not economics:
                raise ValueError("nonempty simulator economic artifact required")
            metrics = economics.get("metrics")
            if economics.get("metricScope") != "out-of-sample" or not isinstance(metrics, dict):
                reasons.append("out-of-sample-metrics-unavailable")
            else:
                for criterion in plan.request.lineage.acceptance_criteria:
                    if criterion.metric_id not in metrics:
                        reasons.append("preregistered-metric-unavailable")
                    elif not criterion.accepts(metrics[criterion.metric_id]):
                        reasons.append("preregistered-metric-rejection")
            run_data = plan.run.decode()
            if as_of is not None:
                at = utc(as_of)
                if at < plan.request.planned_at or any(time_ns(item.decode()["capturedAt"]) > time_ns(at) for item in extra):
                    reasons.append("result-evidence-not-available-at-completion")
            else:
                at = plan.request.planned_at
                if extra:
                    reasons.append("completion-clock-not-supplied")
            if plan.request.lineage.forward_criteria is not None:
                forward = assess_forward(
                    criteria=plan.request.lineage.forward_criteria, samples=tuple(forward_samples),
                    incidents=plan.request.lineage.incidents, strategy_digest=plan.strategy.digest,
                    lineage_digest=plan.lineage.digest, as_of=at, evidence_ids=frozenset(evidence_map),
                )
            if run_data["validationMode"] == "paper-forward" and (forward is None or not forward.qualified):
                reasons.extend(forward.reasons if forward else ("forward-assessment-missing",))
            if reviewed_acceptance is not False:
                reasons.append("simulation-output-requires-independent-review")
            realism = not reasons
            # Public canonicalization rejects floating-point source PnL. The
            # engine must explicitly produce the canonical exact-decimal domain.
            results = self.boundary.internal("internal.SimulatedBacktestResults.v1", {
                "lineageDigest": output.lineage_digest, "strategyDigest": output.strategy_digest,
                "enginePin": asdict(output.engine_pin), "datasetContentDigests": list(output.dataset_content_digests),
                "assumptionDigest": output.assumption_digest, "economics": economics,
                "economicsOrigin": "injected-simulation-engine", "economicsSimulated": output.economics_simulated,
                "sandbox": asdict(output.sandbox), "evidenceDigests": [item.digest for item in extra],
                "incidentCodes": list(output.incident_codes), "executionAuthorized": False,
                "forwardAssessment": forward.record() if forward is not None else None,
            })
            run_data["resultsRef"] = "backtest-results-" + results.digest
            run_data["forwardSampleCount"] = forward.sample_count if forward else 0
            run_data["reviewStatus"] = (
                "rejected" if output.status == "rejected" or "preregistered-metric-rejection" in reasons
                else "incomplete" if reasons
                else "unreviewed"
            )
            updated_run = self.boundary.public("BacktestRun", run_data)
            return BacktestCompletion(
                plan, output, run_data["reviewStatus"], updated_run, results, evidence,
                tuple(dict.fromkeys(reasons)), realism, forward,
            )
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError, PortUnavailable):
            return BacktestCompletion(plan, output, "rejected", plan.run, results, evidence,
                                      tuple(dict.fromkeys((*reasons, "simulation-result-contract-rejected"))), False, forward)
        except Exception:
            return BacktestCompletion(plan, output, "unavailable", plan.run, results, evidence,
                                      ("result-authority-port-failed",), False, forward)
