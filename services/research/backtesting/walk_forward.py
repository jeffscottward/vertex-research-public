"""Bounded independent-fold orchestration through explicitly injected ports.

This is NOT connected to a host, native runner, recipe, worker, or publisher.
Opaque DatasetInput bytes are never filtered here. A pinned selector AND an
independent pinned verifier must establish supported causal feature/label
semantics before fitting. Missing capabilities remain unavailable.

The only supported execution semantics are explicitly reviewed independent
capital resets with flat fold boundaries. No carry, forced liquidation, metric
averaging, parent metric acceptance, or forward observations are inferred. The
ordered collection is always incomplete until a separately reviewed aggregation
policy and implementation exist. No method grants execution authority.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from typing import Any

from .fold_contracts import (
    FoldExecutionRequest, FoldExecutionResult, FoldExecutor, FoldFitRequest,
    FoldFitResult, FoldFitter, FoldPortPin, FoldRecord, FoldSelection,
    FoldSelectionRequest, FoldSelector, FoldStageEvidence, FoldVerification,
    FoldVerifier, PolicyAdmissionRequest, WalkForwardPolicy,
)
from .lineage import WalkForwardFold, time_ns, timestamp
from .planner import BacktestPlan, BacktestPlanner, EngineDescriptor
from .ports import Artifact, ContractRejected, PortUnavailable, ResourceBudget, decode_json, utc


@dataclass(frozen=True)
class FoldAttempt:
    fold: WalkForwardFold
    binding: Artifact | None
    status: str
    reasons: tuple[str, ...]
    selection: FoldSelection | None = None
    verification: FoldVerification | None = None
    fit: FoldFitResult | None = None
    execution: FoldExecutionResult | None = None
    artifacts: tuple[Artifact, ...] = ()
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "reasons", tuple(self.reasons))
        object.__setattr__(self, "artifacts", tuple(self.artifacts))


@dataclass(frozen=True)
class WalkForwardCollection:
    parent: BacktestPlan
    policy: Artifact | None
    admission: FoldVerification | None
    folds: tuple[FoldAttempt, ...]
    status: str
    reasons: tuple[str, ...]
    artifact: Artifact | None
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "folds", tuple(self.folds))
        object.__setattr__(self, "reasons", tuple(self.reasons))


def _record(record: FoldRecord) -> dict[str, Any]:
    return {
        "recordId": record.record_id, "datasetId": record.dataset_id,
        "sourceContentDigest": record.source_content_digest,
        "observedAt": record.observed_at, "availableAt": record.available_at,
        "features": {"contractName": record.features.contract_name, "digest": record.features.digest},
        "label": {"contractName": record.label.contract_name, "digest": record.label.digest} if record.label else None,
        "labelEndAt": record.label_end_at, "labelAvailableAt": record.label_available_at,
    }


def _record_bytes(records: tuple[FoldRecord, ...]) -> int:
    return sum(len(item.features.payload_bytes) + (len(item.label.payload_bytes) if item.label else 0)
               for item in records)


def _evidence_record(evidence: FoldStageEvidence) -> dict[str, Any]:
    return {"sandbox": asdict(evidence.sandbox),
            "evidenceDigests": [hashlib.sha256(value).hexdigest() for value in evidence.evidence_bytes]}


def _evidence_bytes(evidence: FoldStageEvidence) -> int:
    return sum(len(value) for value in evidence.evidence_bytes)


def _source_bytes(parent: BacktestPlan) -> int:
    return sum(len(item.manifest_bytes) + len(item.content_bytes or b"") for item in parent.request.datasets)


def _stage_budget(budget: ResourceBudget, fold_count: int) -> ResourceBudget:
    # One policy admission and four calls per fold: select, verify, fit, execute.
    # Reserve the entire quota BEFORE calls, even for failures. The host still
    # owns hard enforcement; a missing/invalid receipt stops subsequent calls.
    calls = 1 + 4 * fold_count
    return replace(
        budget, maximum_events=budget.maximum_events // calls,
        maximum_cpu_ms=budget.maximum_cpu_ms // calls,
        maximum_wall_ms=budget.maximum_wall_ms // calls,
        maximum_trials=budget.maximum_trials // fold_count, maximum_folds=1,
    )


class WalkForwardWorkflow:
    def __init__(
        self, planner: BacktestPlanner, *, selector: FoldSelector | None = None,
        verifier: FoldVerifier | None = None, fitter: FoldFitter | None = None,
        executor: FoldExecutor | None = None,
    ) -> None:
        self.planner = planner
        self.boundary = planner.boundary
        self.selector = selector
        self.verifier = verifier
        self.fitter = fitter
        self.executor = executor

    def _check_ports(self, policy: WalkForwardPolicy) -> None:
        if self.selector is None or self.verifier is None or self.fitter is None or self.executor is None:
            raise PortUnavailable("walk-forward-separated-data-fit-or-execution-port-missing")
        if (self.selector.descriptor != policy.selector or self.verifier.descriptor != policy.verifier
                or self.fitter.descriptor != policy.fitter or self.executor.descriptor != policy.executor
                or policy.verifier.pin.digest == policy.selector.pin.digest
                or policy.verifier.pin.identity == policy.selector.pin.identity
                or self.verifier is self.selector or self.fitter is self.selector
                or self.fitter is self.verifier or self.fitter is self.executor):
            raise ContractRejected("walk-forward-capability-pin-or-independence-rejected")

    def _canonical(self, artifact: Artifact) -> None:
        if self.boundary.internal(artifact.contract_name, artifact.decode()) != artifact:
            raise ContractRejected("noncanonical-fold-artifact")

    def _stage(
        self, evidence: FoldStageEvidence, descriptor: FoldPortPin | EngineDescriptor,
        budget: ResourceBudget, input_bytes: int, as_of: datetime, evidence_ids: set[str],
    ) -> tuple[Artifact, ...]:
        receipt = evidence.sandbox
        if (receipt.policy_digest != descriptor.sandbox_policy_digest or receipt.budget != budget
                or receipt.limits_enforced is not True or receipt.network_used is not False
                or receipt.execution_authority_used is not False or receipt.input_bytes < input_bytes
                or not 0 < input_bytes <= receipt.input_bytes <= budget.maximum_input_bytes
                or not 0 < receipt.events_processed <= budget.maximum_events
                or receipt.peak_memory_bytes > budget.maximum_memory_bytes
                or receipt.cpu_ms > budget.maximum_cpu_ms or receipt.wall_ms > budget.maximum_wall_ms):
            raise ContractRejected("fold-stage-resource-receipt-rejected")
        if not evidence.evidence_bytes or len(evidence.evidence_bytes) > 64 or _evidence_bytes(evidence) > budget.maximum_input_bytes:
            raise ContractRejected("fold-stage-evidence-budget-rejected")
        artifacts = tuple(self.boundary.public("ResearchEvidence", decode_json(raw)) for raw in evidence.evidence_bytes)
        ids = [item.decode()["evidenceId"] for item in artifacts]
        if len(set(ids)) != len(ids) or set(ids) & evidence_ids or receipt.isolation_evidence_id not in ids:
            raise ContractRejected("fold-stage-isolation-evidence-rejected")
        if any(item.decode()["acceptanceStatus"] != "unreviewed"
               or time_ns(item.decode()["capturedAt"]) > time_ns(as_of) for item in artifacts):
            raise ContractRejected("fold-stage-evidence-time-or-review-rejected")
        evidence_ids.update(ids)
        return artifacts

    def _selection(
        self, request: FoldSelectionRequest, selection: FoldSelection, parent: BacktestPlan,
    ) -> None:
        if selection.request_digest != request.binding.digest:
            raise ContractRejected("fold-selection-request-mismatch")
        if not selection.training or not selection.test or len(selection.training) + len(selection.test) > request.budget.maximum_events:
            raise ContractRejected("fold-selection-record-budget-rejected")
        self._canonical(selection.selection_proof)
        sources = {pin.dataset_id: pin.content_digest for pin in parent.request.lineage.data_pins}
        seen: set[tuple[str, str]] = set()
        fold = request.fold
        for training, records in ((True, selection.training), (False, selection.test)):
            window = fold.training if training else fold.test
            previous: tuple[int, str, str] | None = None
            for record in records:
                key = (record.dataset_id, record.record_id)
                if key in seen or sources.get(record.dataset_id) != record.source_content_digest:
                    raise ContractRejected("fold-record-source-or-identity-rejected")
                seen.add(key)
                observed, available = time_ns(record.observed_at), time_ns(record.available_at)
                order = (observed if training else available, record.dataset_id, record.record_id)
                if previous is not None and order <= previous:
                    raise ContractRejected("fold-record-order-rejected")
                previous = order
                if not time_ns(window.start_at) <= observed < time_ns(window.end_at) or available < observed:
                    raise ContractRejected("fold-record-window-rejected")
                self._canonical(record.features)
                if training:
                    if record.label is None or record.label_end_at is None or record.label_available_at is None:
                        raise PortUnavailable("supervised-fold-label-semantics-required")
                    horizon, label_available = time_ns(record.label_end_at), time_ns(record.label_available_at)
                    if (available > time_ns(fold.fitted_at) or not observed <= horizon <= label_available
                            or horizon > time_ns(fold.training_labels_end_at)
                            or label_available > time_ns(fold.fitted_at)
                            or horizon + fold.purge_ms * 1_000_000 > time_ns(fold.test.start_at)):
                        raise ContractRejected("fold-training-causality-rejected")
                    self._canonical(record.label)
                elif record.label is not None or available >= time_ns(fold.test.end_at):
                    raise ContractRejected("fold-test-label-or-availability-rejected")

    def _selection_capture(self, request: FoldSelectionRequest, selection: FoldSelection) -> Artifact:
        return self.boundary.internal("internal.FoldSelection.v1", {
            "expectedRequestDigest": request.binding.digest, "requestDigest": selection.request_digest,
            "training": [_record(item) for item in selection.training],
            "test": [_record(item) for item in selection.test],
            "selectionProofDigest": selection.selection_proof.digest,
            "stageEvidence": _evidence_record(selection.evidence), "executionAuthorized": False,
        })

    def _verification(
        self, result: FoldVerification, request_digest: str, subject_digest: str,
    ) -> None:
        if result.request_digest != request_digest or result.subject_digest != subject_digest or result.verified is not True:
            raise ContractRejected("fold-independent-verification-rejected")

    def _verification_capture(self, result: FoldVerification) -> Artifact:
        return self.boundary.internal("internal.FoldVerification.v1", {
            "requestDigest": result.request_digest, "subjectDigest": result.subject_digest,
            "verified": result.verified, "stageEvidence": _evidence_record(result.evidence),
            "executionAuthorized": False,
        })

    def _attempt(
        self, parent: BacktestPlan, policy: WalkForwardPolicy, policy_artifact: Artifact,
        admission_artifact: Artifact, assumptions: Artifact, fold: WalkForwardFold,
        index: int, budget: ResourceBudget, as_of: datetime, evidence_ids: set[str],
        remaining_bytes: int,
    ) -> tuple[FoldAttempt, bool, int]:
        binding = None
        selection = None
        verification = None
        fit = None
        execution = None
        artifacts: list[Artifact] = []
        accounted = True
        consumed = 0

        def retain(artifact: Artifact) -> Artifact:
            nonlocal consumed
            consumed += len(artifact.payload_bytes)
            if consumed > remaining_bytes:
                raise ContractRejected("workflow-retained-byte-budget-exceeded")
            artifacts.append(artifact)
            return artifact

        def retain_payloads(size: int) -> None:
            nonlocal consumed
            consumed += size
            if consumed > remaining_bytes:
                raise ContractRejected("workflow-retained-byte-budget-exceeded")

        try:
            assert parent.lineage is not None and parent.strategy is not None and parent.engine is not None
            assert self.selector is not None and self.verifier is not None and self.fitter is not None and self.executor is not None
            self._check_ports(policy)
            binding = retain(self.boundary.internal("internal.FoldBinding.v1", {
                "parentLineageDigest": parent.lineage.digest, "strategyDigest": parent.strategy.digest,
                "codePin": asdict(parent.request.lineage.code_pin), "enginePin": asdict(parent.engine.pin),
                "dataPins": [asdict(pin) for pin in parent.request.lineage.data_pins],
                "assumptionDigest": assumptions.digest, "trialRegistry": parent.request.lineage.trials.record(),
                "policyDigest": policy_artifact.digest, "policyAdmissionDigest": admission_artifact.digest,
                "selectorPin": asdict(policy.selector), "verifierPin": asdict(policy.verifier),
                "fitterPin": asdict(policy.fitter), "parameterMappingPin": asdict(policy.parameter_mapping),
                "parameterContract": policy.parameter_contract, "initialStateDigest": policy.initial_state.digest,
                "capitalPolicy": policy.capital_policy, "positionPolicy": policy.position_policy,
                "foldIndex": index, "fold": fold.record(), "budget": asdict(budget), "executionAuthorized": False,
            }))
            selection_request = FoldSelectionRequest(binding, fold, parent.request.datasets, budget)
            selection_input_bytes = len(binding.payload_bytes) + _source_bytes(parent)
            if selection_input_bytes > budget.maximum_input_bytes:
                raise ContractRejected("fold-selection-input-budget-exceeded")
            accounted = False
            selected = self.selector.select(selection_request)
            if not isinstance(selected, FoldSelection):
                raise ContractRejected("fold-selection-result-type-rejected")
            if len(selected.training) + len(selected.test) > budget.maximum_events:
                raise ContractRejected("fold-selection-record-budget-rejected")
            selected_bytes = _record_bytes((*selected.training, *selected.test)) + len(selected.selection_proof.payload_bytes)
            retain_payloads(selected_bytes + _evidence_bytes(selected.evidence))
            selection = selected
            selected_artifact = retain(self._selection_capture(selection_request, selection))
            self._check_ports(policy)
            for artifact in self._stage(selection.evidence, policy.selector, budget, selection_input_bytes, as_of, evidence_ids):
                retain(artifact)
            accounted = True
            self._selection(selection_request, selection, parent)
            verification_input_bytes = selection_input_bytes + selected_bytes + len(selected_artifact.payload_bytes) + _evidence_bytes(selection.evidence)
            if verification_input_bytes > budget.maximum_input_bytes:
                raise ContractRejected("fold-verification-input-budget-exceeded")
            accounted = False
            checked = self.verifier.verify_selection(selection_request, selection, selected_artifact)
            if not isinstance(checked, FoldVerification):
                raise ContractRejected("fold-verification-result-type-rejected")
            retain_payloads(_evidence_bytes(checked.evidence))
            verification = checked
            verification_artifact = retain(self._verification_capture(verification))
            for artifact in self._stage(verification.evidence, policy.verifier, budget, verification_input_bytes, as_of, evidence_ids):
                retain(artifact)
            accounted = True
            self._verification(verification, binding.digest, selected_artifact.digest)
            self._check_ports(policy)
            fit_binding = retain(self.boundary.internal("internal.FoldFitRequest.v1", {
                "foldBinding": binding.decode(), "selectionDigest": selected_artifact.digest,
                "verificationDigest": verification_artifact.digest,
                "training": [_record(item) for item in selection.training], "executionAuthorized": False,
            }))
            fit_request = FoldFitRequest(fit_binding, selection.training, budget)
            fit_input_bytes = len(fit_binding.payload_bytes) + _record_bytes(selection.training)
            if fit_input_bytes > budget.maximum_input_bytes:
                raise ContractRejected("fold-fit-input-budget-exceeded")
            accounted = False
            fitted = self.fitter.fit(fit_request)
            if not isinstance(fitted, FoldFitResult):
                raise ContractRejected("fold-fit-result-type-rejected")
            retain_payloads(len(fitted.provenance.payload_bytes) + (len(fitted.parameters.payload_bytes) if fitted.parameters else 0) + _evidence_bytes(fitted.evidence))
            fit = fitted
            fit_artifact = retain(self.boundary.internal("internal.FoldFitResult.v1", {
                "requestDigest": fit.request_digest, "status": fit.status, "reasons": list(fit.reasons),
                "parameterDigest": fit.parameters.digest if fit.parameters else None,
                "provenanceDigest": fit.provenance.digest, "stageEvidence": _evidence_record(fit.evidence),
                "executionAuthorized": False,
            }))
            self._check_ports(policy)
            for artifact in self._stage(fit.evidence, policy.fitter, budget, fit_input_bytes, as_of, evidence_ids):
                retain(artifact)
            accounted = True
            if fit.request_digest != fit_binding.digest:
                raise ContractRejected("fold-fit-request-mismatch")
            self._canonical(fit.provenance)
            if fit.parameters is not None:
                self._canonical(fit.parameters)
                if fit.parameters.contract_name != policy.parameter_contract or fit.parameters.digest != fold.parameter_digest:
                    raise ContractRejected("fold-preregistered-parameter-pin-mismatch")
            if fit.status != "completed" or fit.reasons:
                return FoldAttempt(fold, binding, fit.status if fit.status != "completed" else "inconclusive",
                                   tuple(dict.fromkeys(("fold-fit-not-qualified", *fit.reasons))),
                                   selection, verification, fit, None, tuple(artifacts)), True, consumed
            if fit.parameters is None:
                raise ContractRejected("fold-fit-parameters-missing")
            execution_binding = retain(self.boundary.internal("internal.FoldExecutionRequest.v1", {
                "foldBinding": binding.decode(), "selectionDigest": selected_artifact.digest,
                "verificationDigest": verification_artifact.digest, "fitResultDigest": fit_artifact.digest,
                "parameterDigest": fit.parameters.digest, "test": [_record(item) for item in selection.test],
                "executionAuthorized": False,
            }))
            execution_request = FoldExecutionRequest(execution_binding, selection.test, fit.parameters,
                                                     parent.strategy, assumptions, policy.initial_state, budget)
            execution_input_bytes = sum(len(item.payload_bytes) for item in (
                execution_binding, fit.parameters, parent.strategy, assumptions, policy.initial_state,
            )) + _record_bytes(selection.test)
            if execution_input_bytes > budget.maximum_input_bytes:
                raise ContractRejected("fold-execution-input-budget-exceeded")
            accounted = False
            executed = self.executor.execute(execution_request)
            if not isinstance(executed, FoldExecutionResult):
                raise ContractRejected("fold-execution-result-type-rejected")
            if (len(executed.output.evidence_bytes) > 64 or len(executed.output.incident_codes) > 64
                    or len(executed.output.modeled_assumptions) > 64):
                raise ContractRejected("fold-execution-result-type-rejected")
            retain_payloads(len(executed.output.economics_bytes) + sum(len(raw) for raw in executed.output.evidence_bytes))
            execution = executed
            output = execution.output
            stage_evidence = FoldStageEvidence(output.sandbox, output.evidence_bytes)
            retain(self.boundary.internal("internal.FoldExecutionAttempt.v1", {
                "expectedRequestDigest": execution_binding.digest, "requestDigest": execution.request_digest,
                "initialStateDigest": execution.initial_state_digest, "startedFlat": execution.started_flat,
                "endedFlat": execution.ended_flat, "lineageDigest": output.lineage_digest,
                "strategyDigest": output.strategy_digest, "enginePin": asdict(output.engine_pin),
                "datasetContentDigests": list(output.dataset_content_digests),
                "assumptionDigest": output.assumption_digest,
                "economicsBytesSha256": hashlib.sha256(output.economics_bytes).hexdigest(),
                "modeledAssumptions": list(output.modeled_assumptions), "dataComplete": output.data_complete,
                "pointInTimeEnforced": output.point_in_time_enforced, "economicsSimulated": output.economics_simulated,
                "status": output.status, "incidentCodes": list(output.incident_codes),
                "stageEvidence": _evidence_record(stage_evidence), "executionAuthorized": False,
            }))
            self._check_ports(policy)
            for artifact in self._stage(stage_evidence, policy.executor, budget, execution_input_bytes, as_of, evidence_ids):
                retain(artifact)
            accounted = True
            if (execution.request_digest != execution_binding.digest
                    or execution.initial_state_digest != policy.initial_state.digest
                    or output.lineage_digest != parent.lineage.digest or output.strategy_digest != parent.strategy.digest
                    or output.engine_pin != parent.engine.pin or output.assumption_digest != assumptions.digest
                    or output.dataset_content_digests != tuple(item.decode()["contentHash"] for item in parent.datasets)):
                raise ContractRejected("fold-execution-lineage-pin-mismatch")
            economics = decode_json(output.economics_bytes)
            if not isinstance(economics, dict) or not economics:
                raise ContractRejected("fold-economic-result-contract-rejected")
            reasons = list(output.incident_codes)
            if output.status != "completed":
                reasons.append("fold-execution-" + output.status)
            if execution.started_flat is not True or execution.ended_flat is not True:
                reasons.append("fold-position-boundary-unqualified")
            if output.data_complete is not True or output.point_in_time_enforced is not True or output.economics_simulated is not True:
                reasons.append("fold-economics-data-or-causality-unqualified")
            modeled = {item.kind for item in parent.request.lineage.assumptions if item.disposition == "modeled"}
            if not modeled.issubset(output.modeled_assumptions):
                reasons.append("fold-economic-model-coverage-incomplete")
            if economics.get("metricScope") != "out-of-sample" or not isinstance(economics.get("metrics"), dict):
                reasons.append("fold-out-of-sample-metrics-unavailable")
            retain(self.boundary.internal("internal.FoldExecutionResult.v1", {
                "requestDigest": execution.request_digest, "parentLineageDigest": output.lineage_digest,
                "foldId": fold.fold_id, "foldIndex": index, "trainingWindow": fold.training.record(),
                "testWindow": fold.test.record(), "parameterDigest": fit.parameters.digest,
                "fitResultDigest": fit_artifact.digest, "initialStateDigest": execution.initial_state_digest,
                "startedFlat": execution.started_flat, "endedFlat": execution.ended_flat,
                "status": output.status, "reasons": list(dict.fromkeys(reasons)), "economics": economics,
                "stageEvidence": _evidence_record(stage_evidence), "executionAuthorized": False,
            }))
            status = "rejected" if output.status == "rejected" else "inconclusive" if reasons else "completed-unreviewed"
            return FoldAttempt(fold, binding, status, tuple(dict.fromkeys(reasons)), selection, verification,
                               fit, execution, tuple(artifacts)), True, consumed
        except PortUnavailable:
            status, reasons = "unavailable", ("fold-required-capability-unavailable",)
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, OverflowError):
            status, reasons = "rejected", ("fold-contract-causality-or-budget-rejected",)
        except Exception:
            status, reasons = "unavailable", ("fold-injected-port-failed",)
        return FoldAttempt(fold, binding, status, reasons, selection, verification, fit,
                           execution, tuple(artifacts)), accounted and consumed <= remaining_bytes, consumed

    def run(self, parent: BacktestPlan, policy: WalkForwardPolicy, *, as_of: datetime) -> WalkForwardCollection:
        """Prepare immutable ordered attempts; never publish or authorize them.

        Port byte receipts must cover at least the explicit artifact/source
        payload bytes counted here, AND all additional host serialization and
        inputs. The host enforces the same hard budget; these are lower bounds.
        Retention counts both original port payloads and canonical envelopes;
        over-budget payloads are not attached to the returned collection.
        """
        at = utc(as_of)
        policy_artifact = None
        admission = None
        attempts: list[FoldAttempt] = []
        reasons: tuple[str, ...] = ()
        status = "unavailable"
        collection = None
        folds = parent.request.lineage.folds
        if not 2 <= len(folds) <= parent.request.budget.maximum_folds:
            return WalkForwardCollection(parent, None, None, (), "rejected",
                                         ("walk-forward-fold-bound-rejected",), None)
        missing = tuple("walk-forward-" + name + "-unavailable" for name, port in (
            ("selector", self.selector), ("verifier", self.verifier),
            ("fitter", self.fitter), ("executor", self.executor),
        ) if port is None) + self.boundary.missing_ports
        if parent.status == "unavailable":
            missing = (*missing, "walk-forward-parent-unavailable", *parent.missing_ports)
        if policy.capital_policy != "independent-reset" or policy.position_policy != "flat-boundaries":
            missing = (*missing, "walk-forward-capital-or-position-semantics-unsupported")
        if missing:
            reasons = tuple(dict.fromkeys(missing))
            return WalkForwardCollection(
                parent, None, None, tuple(FoldAttempt(fold, None, "unavailable", reasons) for fold in folds),
                "unavailable", reasons, None,
            )
        try:
            if (parent.status != "ready" or parent.execution_authorized is not False
                    or parent.lineage is None or parent.strategy is None or parent.run is None or parent.engine is None
                    or parent.reasons or parent.missing_ports):
                raise ContractRejected("walk-forward-parent-not-qualified")
            fresh = self.planner.plan(parent.request)
            if fresh.status == "unavailable":
                raise PortUnavailable("walk-forward-parent-requalification-unavailable")
            if fresh != parent or fresh.status != "ready":
                raise ContractRejected("walk-forward-parent-not-reproducible")
            if parent.run.decode()["validationMode"] != "walk-forward":
                raise ContractRejected("walk-forward-fold-bound-rejected")
            if at < parent.request.planned_at or parent.request.lineage.trials is None:
                raise ContractRejected("walk-forward-completion-time-or-trials-rejected")
            if policy.executor != parent.engine or policy.registered_at > min(fold.fitted_at for fold in folds):
                raise ContractRejected("walk-forward-policy-pin-or-registration-rejected")
            citations = {item.decode()["evidenceId"] for item in parent.evidence}
            if not set(policy.review_evidence_ids).issubset(citations):
                raise ContractRejected("walk-forward-policy-review-evidence-missing")
            self._check_ports(policy)
            budget = _stage_budget(parent.request.budget, len(folds))
            self._canonical(policy.initial_state)
            policy_artifact = self.boundary.internal("internal.WalkForwardPolicy.v1", policy.record())
            if not any(
                item.decode()["evidenceId"] in policy.review_evidence_ids
                and item.decode()["contentHash"] == policy_artifact.digest
                and item.decode()["publishedAt"] is not None
                and time_ns(item.decode()["publishedAt"]) <= time_ns(policy.registered_at)
                for item in parent.evidence
            ):
                raise ContractRejected("walk-forward-policy-content-review-pin-missing")
            admission_binding = self.boundary.internal("internal.WalkForwardPolicyAdmission.v1", {
                "parentLineageDigest": parent.lineage.digest, "policyDigest": policy_artifact.digest,
                "asOf": timestamp(at), "budget": asdict(budget), "executionAuthorized": False,
            })
            admission_request = PolicyAdmissionRequest(admission_binding, parent, policy, policy_artifact, budget)
            admission_input_bytes = sum(len(item.payload_bytes) for item in (admission_binding, policy_artifact, policy.initial_state))
            admission_input_bytes += _source_bytes(parent) + len(parent.request.strategy_bytes) + len(parent.request.run_bytes)
            admission_input_bytes += sum(len(raw) for raw in parent.request.evidence_bytes) + len(parent.lineage.payload_bytes)
            if admission_input_bytes > budget.maximum_input_bytes:
                raise ContractRejected("walk-forward-admission-input-budget-exceeded")
            admitted = self.verifier.admit(admission_request)
            if not isinstance(admitted, FoldVerification) or _evidence_bytes(admitted.evidence) > parent.request.budget.maximum_input_bytes:
                raise ContractRejected("walk-forward-admission-result-rejected")
            admission = admitted
            self._check_ports(policy)
            evidence_ids = set(citations)
            admission_evidence = self._stage(admission.evidence, policy.verifier, budget, admission_input_bytes, at, evidence_ids)
            admitted_artifact = self._verification_capture(admission)
            self._verification(admission, admission_binding.digest, policy_artifact.digest)
            assumptions = self.boundary.internal("internal.Assumptions.v1", [item.record() for item in parent.request.lineage.assumptions])
            retained = sum(len(item.payload_bytes) for item in (
                policy_artifact, admission_binding, admitted_artifact, assumptions, *admission_evidence,
            )) + _evidence_bytes(admission.evidence)
            if retained > parent.request.budget.maximum_input_bytes:
                admission = None
                raise ContractRejected("walk-forward-admission-retention-budget-exceeded")
            proceed = True
            for index, fold in enumerate(folds):
                if not proceed or retained >= parent.request.budget.maximum_input_bytes:
                    attempts.append(FoldAttempt(fold, None, "unavailable", ("prior-stage-accounting-or-retention-bound-unavailable",)))
                    continue
                attempt, proceed, size = self._attempt(parent, policy, policy_artifact, admitted_artifact,
                                                       assumptions, fold, index, budget, at, evidence_ids,
                                                       parent.request.budget.maximum_input_bytes - retained)
                attempts.append(attempt)
                retained += size
            reasons = ("walk-forward-aggregation-policy-unavailable", "parent-metric-criteria-not-assessed")
            status = "rejected" if any(item.status == "rejected" for item in attempts) else "inconclusive"
            if all(item.status == "unavailable" for item in attempts):
                status = "unavailable"
            collection = self.boundary.internal("internal.WalkForwardCollection.v1", {
                "parentLineageDigest": parent.lineage.digest, "policyDigest": policy_artifact.digest,
                "policyAdmission": admitted_artifact.decode(), "asOf": timestamp(at), "status": status,
                "folds": [{"foldIndex": index, "fold": attempt.fold.record(), "status": attempt.status,
                           "reasons": list(attempt.reasons), "bindingDigest": attempt.binding.digest if attempt.binding else None,
                           "artifactDigests": [item.digest for item in attempt.artifacts]}
                          for index, attempt in enumerate(attempts)],
                "reasons": list(reasons), "aggregateEconomics": None, "executionAuthorized": False,
            })
            if retained + len(collection.payload_bytes) > parent.request.budget.maximum_input_bytes:
                collection = None
                reasons = (*reasons, "walk-forward-collection-byte-budget-exceeded")
                status = "rejected"
        except PortUnavailable:
            reasons = ("walk-forward-required-capability-or-semantics-unavailable",)
            status = "unavailable"
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, OverflowError):
            reasons = ("walk-forward-contract-lineage-or-budget-rejected",)
            status = "rejected"
        except Exception:
            reasons = ("walk-forward-injected-port-failed",)
            status = "unavailable"
        if not attempts:
            attempts = [FoldAttempt(fold, None, status, reasons) for fold in parent.request.lineage.folds]
        return WalkForwardCollection(parent, policy_artifact, admission, tuple(attempts), status, reasons, collection)
