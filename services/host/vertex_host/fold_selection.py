"""Opt-in, source-only candle selection host; never a walk-forward executor.

HostCandleFoldSelectionProfile is a distinct selected private artifact. It does
not reinterpret HostBacktestRecipe v2 and is not mounted by the job dispatcher.
Current control reads authorize each call; only the existing Linux supervisor
can produce stage evidence. Full policy admission deliberately remains absent.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from backtesting.candle_labels import CANDLE_CONTENT_FORMAT, CandleLabelPolicy
from backtesting.candle_selection import (
    CandleAuthorityRequest, CandleFoldSelector, CandleSelectionCandidate,
    select_candle_candidate,
)
from backtesting.fold_contracts import (
    FoldPortPin, FoldRecord, FoldSelection, FoldSelectionRequest, FoldStageEvidence,
    FoldVerification, PolicyAdmissionRequest, WalkForwardPolicy,
)
from backtesting.lineage import Pin, time_ns, timestamp
from backtesting.planner import SandboxReceipt
from backtesting.ports import Artifact, ContractRejected, PortUnavailable, PublicBoundary, ResourceBudget, require_hash

from .cache import canonical_object, thaw
from .config import read_pinned
from .dispatcher import fence

PROFILE_CONTRACT = "HostCandleFoldSelectionProfile"
PROFILE_FORMAT = "vertex-host-candle-fold-selection-v1"
FOLD_MODE = "candle-fold-v1"
FOLD_OPERATIONS = frozenset({"candle.select-v1", "candle.verify-v1"})
_REVIEW_KEYS = {"collectionId", "evidenceId", "artifactId", "artifactSha256", "reviewId",
                "reviewVersion", "rightsPolicyId", "rightsVersion"}
_PROFILE_KEYS = {"format", "publication", "lineage", "walkForwardPolicy", "candlePolicy",
                 "candlePolicyPin", "datasets", "reviewPins", "evidenceTemplate"}
_BINDING_KEYS = {"parentLineageDigest", "strategyDigest", "codePin", "enginePin", "dataPins",
                 "assumptionDigest", "trialRegistry", "policyDigest", "policyAdmissionDigest",
                 "selectorPin", "verifierPin", "fitterPin", "parameterMappingPin", "parameterContract",
                 "initialStateDigest", "capitalPolicy", "positionPolicy", "foldIndex", "fold", "budget",
                 "executionAuthorized"}
_COMMON_CODE = frozenset({"host/vertex_host/fold_selection.py", "host/vertex_host/sandbox.py",
    "host/vertex_host/sandbox_worker.py", "research/backtesting/candle_labels.py",
    "research/backtesting/candle_selection.py", "research/backtesting/fold_contracts.py",
    "research/backtesting/lineage.py", "research/backtesting/ports.py", "research/backtesting/planner.py",
    "research/backtesting/walk_forward.py"})


def _object(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        raise ContractRejected("closed-candle-host-record-required")
    return value


def _artifact(boundary: PublicBoundary, artifact: Artifact, name: str) -> Artifact:
    if type(artifact) is not Artifact or artifact.contract_name != name:
        raise ContractRejected("candle-host-artifact-contract-mismatch")
    if boundary.internal(name, artifact.decode()) != artifact:
        raise ContractRejected("candle-host-canonical-bytes-mismatch")
    return artifact


def _same(boundary: PublicBoundary, left: Any, right: Any) -> bool:
    return boundary.internal("internal.CandleHostComparison.v1", left) == boundary.internal(
        "internal.CandleHostComparison.v1", right)


def _record(record: FoldRecord) -> dict[str, Any]:
    return {"recordId": record.record_id, "datasetId": record.dataset_id,
        "sourceContentDigest": record.source_content_digest, "observedAt": record.observed_at,
        "availableAt": record.available_at,
        "features": {"contractName": record.features.contract_name, "digest": record.features.digest},
        "label": {"contractName": record.label.contract_name, "digest": record.label.digest} if record.label else None,
        "labelEndAt": record.label_end_at, "labelAvailableAt": record.label_available_at}


def selection_artifact(boundary: PublicBoundary, request: FoldSelectionRequest, selection: FoldSelection) -> Artifact:
    """Exact existing workflow capture, including—not trusting—candidate evidence."""
    return boundary.internal("internal.FoldSelection.v1", {
        "expectedRequestDigest": request.binding.digest, "requestDigest": selection.request_digest,
        "training": [_record(item) for item in selection.training],
        "test": [_record(item) for item in selection.test],
        "selectionProofDigest": selection.selection_proof.digest,
        "stageEvidence": {"sandbox": asdict(selection.evidence.sandbox),
            "evidenceDigests": [hashlib.sha256(raw).hexdigest() for raw in selection.evidence.evidence_bytes]},
        "executionAuthorized": False,
    })


@dataclass(frozen=True)
class CandleFoldJob:
    operation: str
    request: FoldSelectionRequest
    policy: CandleLabelPolicy
    policy_pin: Pin
    selector: FoldPortPin
    verifier: FoldPortPin
    admission: Artifact
    profile_digest: str
    evidence_template_bytes: bytes
    selection: FoldSelection | None
    sealed_selection: Artifact | None


@dataclass(frozen=True)
class CandleFoldRunBinding:
    operation: str
    request_digest: str
    profile_digest: str
    admission_digest: str
    job_digest: str
    policy_digest: str
    budget: ResourceBudget
    input_bytes: int


def make_fold_binding(job: CandleFoldJob, input_bytes: int) -> CandleFoldRunBinding:
    from .sandbox import fold_wire_registry, pack, protocol_bytes
    if type(input_bytes) is not int or not fold_input_bytes(job) <= input_bytes <= job.request.budget.maximum_input_bytes:
        raise ContractRejected("candle-fold-actual-input-byte-budget")
    return CandleFoldRunBinding(job.operation, job.request.binding.digest, job.profile_digest,
        job.admission.digest, hashlib.sha256(protocol_bytes(pack(job, fold_wire_registry()))).hexdigest(),
        job.selector.sandbox_policy_digest, job.request.budget, input_bytes)


@dataclass(frozen=True)
class CandleFoldWorkerOutput:
    request_digest: str
    subject_digest: str
    candidate: CandleSelectionCandidate | None
    verified: bool
    sandbox: SandboxReceipt
    evidence_bytes: tuple[bytes, ...]


def fold_input_bytes(job: CandleFoldJob) -> int:
    """Charge all transported bytes, including proof, policy and admission.

    The outer protocol bytes are charged separately by run_fold_worker; typed
    bytes use Base64 there, so this is a conservative additional lower bound.
    """
    from .sandbox import fold_wire_registry, pack, protocol_bytes
    return len(protocol_bytes(pack(job, fold_wire_registry())))


def check_fold_job(job: CandleFoldJob, boundary: PublicBoundary) -> None:
    if type(job) is not CandleFoldJob or job.operation not in FOLD_OPERATIONS:
        raise ContractRejected("fixed-candle-fold-operation-required")
    request = job.request
    if type(request) is not FoldSelectionRequest or type(job.policy) is not CandleLabelPolicy:
        raise ContractRejected("typed-candle-fold-input-required")
    if type(job.selector) is not FoldPortPin or type(job.verifier) is not FoldPortPin:
        raise ContractRejected("typed-candle-fold-port-pins-required")
    if (job.selector.pin.identity == job.verifier.pin.identity or job.selector.pin.digest == job.verifier.pin.digest
            or job.selector.sandbox_policy_digest != job.verifier.sandbox_policy_digest):
        raise ContractRejected("independent-candle-port-pins-required")
    require_hash(job.profile_digest)
    sealed_policy = job.policy.seal(boundary, job.policy_pin)
    _artifact(boundary, request.binding, "internal.FoldBinding.v1")
    binding = _object(request.binding.decode(), _BINDING_KEYS)
    if (binding["executionAuthorized"] is not False
            or not _same(boundary, binding["selectorPin"], asdict(job.selector))
            or not _same(boundary, binding["verifierPin"], asdict(job.verifier))):
        raise ContractRejected("candle-fold-worker-binding-mismatch")
    admission = _artifact(boundary, job.admission, "internal.CandleAuthority.v1").decode()
    _object(admission, {"requestDigest", "policyDigest", "selectorPin", "verifierPin", "checkedAt",
                        "expiresAt", "reviewEvidenceIds", "verified", "executionAuthorized"})
    if (admission["requestDigest"] != request.binding.digest or admission["policyDigest"] != sealed_policy.digest
            or not _same(boundary, admission["selectorPin"], asdict(job.selector))
            or not _same(boundary, admission["verifierPin"], asdict(job.verifier.pin))
            or not _same(boundary, admission["reviewEvidenceIds"], list(job.policy.review_evidence_ids))
            or admission["verified"] is not True or admission["executionAuthorized"] is not False
            or time_ns(admission["checkedAt"]) >= time_ns(admission["expiresAt"])):
        raise ContractRejected("candle-fold-worker-authority-mismatch")
    if (request.budget.maximum_folds != 1 or fold_input_bytes(job) > request.budget.maximum_input_bytes
            or not 0 < sum(item.declared_events for item in request.sources) <= request.budget.maximum_events):
        raise ContractRejected("candle-fold-worker-input-budget")
    # Exactly one fixed transformation/comparison; no model candidates or trials
    # are dispatched, and no request may ask this worker to run a search loop.
    if job.operation == "candle.select-v1":
        if job.selection is not None or job.sealed_selection is not None:
            raise ContractRejected("selection-job-cannot-accept-candidate")
    elif type(job.selection) is not FoldSelection or type(job.sealed_selection) is not Artifact:
        raise ContractRejected("verification-job-candidate-required")
    if type(job.evidence_template_bytes) is not bytes or not 0 < len(job.evidence_template_bytes) <= 64_000:
        raise ContractRejected("bounded-candle-isolation-template-required")


def run_candle_fold_job(job: CandleFoldJob, authority: Any, supervisor: Any) -> CandleFoldWorkerOutput:
    """Child only: rederive from original bytes; never approve supplied flags."""
    boundary = PublicBoundary(validator=authority, codec=authority,
                              maximum_bytes=job.request.budget.maximum_input_bytes)
    check_fold_job(job, boundary)
    request = job.request
    candidate = select_candle_candidate(request, policy=job.policy, policy_pin=job.policy_pin,
                                        selector_pin=job.selector, boundary=boundary)
    verified = False
    subject = candidate.selection_proof.digest
    if job.operation == "candle.verify-v1":
        selected = job.selection
        assert selected is not None and job.sealed_selection is not None
        _artifact(boundary, job.sealed_selection, "internal.FoldSelection.v1")
        if selection_artifact(boundary, request, selected) != job.sealed_selection:
            raise ContractRejected("candle-sealed-selection-mismatch")
        # Compare immutable payload bytes as well as all source-derived times,
        # identities, ordering, labels, complete record sets and canonical proof.
        # Candidate sandbox/verified booleans play no part in this decision.
        if (selected.request_digest != request.binding.digest or selected.execution_authorized is not False
                or selected.training != candidate.training or selected.test != candidate.test
                or selected.selection_proof != candidate.selection_proof):
            raise ContractRejected("candle-independent-recomputation-mismatch")
        verified, subject = True, job.sealed_selection.digest
    evidence = supervisor.isolation_evidence(authority, job.evidence_template_bytes)
    return CandleFoldWorkerOutput(request.binding.digest, subject,
        candidate if job.operation == "candle.select-v1" else None, verified,
        supervisor.receipt(sum(item.declared_events for item in request.sources)), (evidence,))


class CurrentCandleAuthority:
    """Concrete worker-fenced control authority, separate from selection output.

    Every resolution re-reads the exact selected profile, original dataset
    artifacts and accepted reviews. Nothing is admitted from cache flags or a
    caller-supplied timestamp. reviewed_modules is the existing host config's
    source inventory, measured again against both selection and worker rootfs.
    """
    def __init__(self, *, context: Any, sandbox: Any, reviewed_modules: Any,
                 profile_artifact_id: str, profile_sha256: str) -> None:
        from .sandbox import ConfiguredSandbox
        if type(sandbox) is not ConfiguredSandbox or sandbox.config is None:
            raise PortUnavailable("candle-real-configured-supervisor-required")
        if sandbox.authority is not context.contracts or context.control.authority is not context.contracts:
            raise PortUnavailable("candle-single-current-contract-authority-required")
        self.context, self.sandbox = context, sandbox
        self.reviewed_modules = thaw(reviewed_modules)
        self.profile_id, self.profile_digest = profile_artifact_id, require_hash(profile_sha256)
        self.boundary = PublicBoundary(validator=context.contracts, codec=context.contracts, maximum_bytes=1_048_576)
        self.selection = thaw(context.selection)
        self.lease = thaw(context.lease)
        self._profile_bytes: bytes | None = None
        self._stage_result: tuple[str, FoldSelection] | None = None
        self._used_requests: set[str] = set()
        self._admission: Artifact | None = None
        self._checked_at: str | None = None
        self._last_now_ns: int | None = None
        self._load_profile()

    def now_ns(self) -> int:
        value = self.context.clock.now_ns()
        if type(value) is not int or (self._last_now_ns is not None and value < self._last_now_ns):
            raise PortUnavailable("candle-host-clock-regressed")
        self._last_now_ns = value
        return value

    def check_time(self) -> str:
        self._guard()
        value = timestamp(datetime.fromisoformat(self.context.clock.now().replace("Z", "+00:00")))
        if time_ns(value) > self.now_ns():
            raise PortUnavailable("candle-host-clock-inconsistent")
        self._checked_at = value
        return value

    def deadline_ns(self) -> int:
        return min(time_ns(self.lease["leaseExpiresAt"]), time_ns(self.lease["deadlineAt"]),
                   time_ns(self.selection["expiresAt"]))

    def _guard(self) -> None:
        if (self.context.cancellation.is_set() or self.sandbox.cancellation.is_set()
                or self.now_ns() >= self.deadline_ns()):
            raise PortUnavailable("candle-current-worker-lease-expired-or-cancelled")

    def _call(self, method: str, **fields: Any) -> dict[str, Any]:
        self._guard()
        result = self.context.control_bridge.run(
            lambda: self.context.control.call(method, {**fence(self.lease), **fields}),
            timeout_seconds=(self.deadline_ns() - self.now_ns()) / 1_000_000_000)
        self._guard()
        return result

    def _read(self, reference: dict[str, Any], collection: str | None) -> bytes:
        from vertex_control.adapters import decode_content
        _object(reference, {"artifactId", "sha256"})
        result = self._call("readArtifact", collectionId=collection, artifactId=reference["artifactId"])
        if (result["artifact"] != {"artifactId": reference["artifactId"], "artifactSha256": reference["sha256"]}
                or result["contentSha256"] != reference["sha256"]):
            raise ContractRejected("candle-current-artifact-pin-mismatch")
        raw = decode_content(result["contentBase64"], reference["sha256"])
        if result["canonicalSha256"] is not None:
            if (result["canonicalSha256"] != reference["sha256"]
                    or self.context.contracts.encode(canonical_object(self.context.contracts, raw, 16_000_000)) != raw):
                raise ContractRejected("candle-current-artifact-canonical-mismatch")
        return raw

    def _selected(self) -> dict[str, Any]:
        selected = self._call("policySelection", selectionId=self.lease["policySelectionId"],
                              selectionSha256=self.lease["policySelectionSha256"])
        if self.context.contracts.validate("RuntimePolicySelection", selected) is not True:
            raise ContractRejected("candle-current-selection-contract-rejected")
        body = {key: value for key, value in selected.items() if key != "selectionSha256"}
        if (not _same(self.boundary, selected, self.selection)
                or self.context.contracts.digest(body) != self.lease["policySelectionSha256"]
                or selected["selectionId"] != self.lease["policySelectionId"]
                or selected["selectionSha256"] != self.lease["policySelectionSha256"]
                or selected["accountAlias"] != self.lease["accountAlias"]
                or selected["environment"] != self.lease["environment"]
                or not time_ns(selected["issuedAt"]) <= self.now_ns() < time_ns(selected["expiresAt"])):
            raise ContractRejected("candle-current-exact-selection-required")
        pins = [row["artifact"] for row in selected["artifacts"]
                if row["role"] == "simulation-engine" and row["artifact"]["contractName"] == PROFILE_CONTRACT]
        expected = {"artifactId": self.profile_id, "artifactSha256": self.profile_digest,
                    "contractName": PROFILE_CONTRACT, "schemaVersion": "1.0.0"}
        if pins != [expected]:
            raise PortUnavailable("unique-selected-candle-profile-required")
        return selected

    def _load_profile(self) -> None:
        from .sandbox import fold_wire_registry, unpack
        self._selected()
        raw = self._read({"artifactId": self.profile_id, "sha256": self.profile_digest}, None)
        if self._profile_bytes is not None:
            if self._profile_bytes != raw:
                raise ContractRejected("candle-selected-profile-changed")
            return
        record = _object(canonical_object(self.context.contracts, raw, 1_048_576), _PROFILE_KEYS)
        if record["format"] != PROFILE_FORMAT:
            raise ContractRejected("explicit-candle-profile-version-required")
        publication = _object(record["publication"], {"actorId", "collectionId", "snapshotId", "rightsPolicyId", "rightsVersion"})
        if publication["actorId"] != self.lease["researchPrincipalId"]:
            raise ContractRejected("candle-profile-principal-mismatch")
        registry = fold_wire_registry()
        lineage, policy, candle, pin = (unpack(record[key], registry)
            for key in ("lineage", "walkForwardPolicy", "candlePolicy", "candlePolicyPin"))
        if (type(policy) is not WalkForwardPolicy or type(candle) is not CandleLabelPolicy
                or type(pin) is not Pin):
            raise ContractRejected("closed-candle-profile-types-required")
        _artifact(self.boundary, lineage, "internal.BacktestLineage.v1")
        sealed_policy = self.boundary.internal("internal.WalkForwardPolicy.v1", policy.record())
        if (not _same(self.boundary, lineage.decode()["engineDescriptor"], asdict(policy.executor))
                or policy.registered_at > min(datetime.fromisoformat(row["fittedAt"].replace("Z", "+00:00"))
                    for row in lineage.decode()["lineage"]["folds"])):
            raise ContractRejected("candle-profile-parent-policy-registration-mismatch")
        candle.seal(self.boundary, pin)
        if (policy.selector.pin.identity == policy.verifier.pin.identity
                or policy.selector.pin.digest == policy.verifier.pin.digest
                or policy.selector.sandbox_policy_digest != self.sandbox.config.policy_digest
                or policy.verifier.sandbox_policy_digest != self.sandbox.config.policy_digest):
            raise ContractRejected("candle-profile-code-or-sandbox-pin-mismatch")
        if (type(record["datasets"]) is not list or not 1 <= len(record["datasets"]) <= 64
                or len(record["datasets"]) != len(candle.datasets)
                or type(record["reviewPins"]) is not list or not 1 <= len(record["reviewPins"]) <= 64):
            raise ContractRejected("bounded-candle-profile-sources-and-reviews-required")
        for row in record["datasets"]:
            _object(row, {"manifest", "content", "declaredEvents"})
            _object(row["manifest"], {"artifactId", "sha256"})
            _object(row["content"], {"artifactId", "sha256"})
            if type(row["declaredEvents"]) is not int or not 1 <= row["declaredEvents"] <= 100_000:
                raise ContractRejected("candle-profile-source-count-invalid")
        for row in record["reviewPins"]:
            _object(row, _REVIEW_KEYS)
        if len({row["evidenceId"] for row in record["reviewPins"]}) != len(record["reviewPins"]):
            raise ContractRejected("duplicate-candle-profile-review")
        template = unpack(record["evidenceTemplate"], registry)
        if type(template) is not bytes or not 0 < len(template) <= 64_000:
            raise ContractRejected("bounded-candle-profile-evidence-template-required")
        template_record = canonical_object(self.context.contracts, template, 64_000)
        if (self.context.contracts.validate("ResearchEvidence", template_record) is not True
                or template_record["collectionId"] != publication["collectionId"]
                or template_record["snapshotId"] != publication["snapshotId"]
                or template_record["rightsPolicyId"] != publication["rightsPolicyId"]):
            raise ContractRejected("candle-profile-evidence-scope-rejected")
        # Templates contribute identity/scope, never accepted evidence.
        if template_record["acceptanceStatus"] != "unreviewed" or template_record["publishedAt"] is not None:
            raise ContractRejected("candle-template-cannot-contribute-reviewed-facts")
        self.profile, self._profile_bytes = record, raw
        self.lineage, self.policy, self.candle, self.policy_pin = lineage, policy, candle, pin
        self.sealed_policy, self.descriptor = sealed_policy, policy.verifier.pin
        self.template_bytes = template
        self.boundary = PublicBoundary(validator=self.context.contracts, codec=self.context.contracts,
            maximum_bytes=ResourceBudget(**lineage.decode()["budget"]).maximum_input_bytes)

    def _module(self, descriptor: FoldPortPin) -> None:
        selected = [row for row in self.selection["modules"] if row["moduleId"] == descriptor.pin.identity]
        if (len(selected) != 1 or selected[0]["enabled"] is not True
                or selected[0]["version"] != descriptor.pin.version
                or selected[0]["codeSha256"] != descriptor.pin.digest):
            raise PortUnavailable("candle-selected-module-code-pin-unavailable")
        module = selected[0]
        operation = "candle.select-v1" if descriptor == self.policy.selector else "candle.verify-v1"
        if operation not in module["capabilities"]:
            raise PortUnavailable("candle-exact-operation-capability-not-selected")
        reviewed = self.reviewed_modules.get(module["moduleId"])
        _object(reviewed, {"version", "codeSha256", "contractSha256", "files", "contractFile"})
        if any(reviewed[key] != module[key] for key in ("version", "codeSha256", "contractSha256")):
            raise ContractRejected("candle-reviewed-module-pin-mismatch")
        files = reviewed["files"]
        if type(files) is not dict or not _COMMON_CODE.issubset(files) or len(files) > 4096:
            raise PortUnavailable("candle-exact-operation-source-inventory-required")
        runtime = {item.path: item for item in self.sandbox.config.runtime_files}
        measured = {}
        for name, pin in files.items():
            self._guard()
            if (type(name) is not str or name.startswith("/") or ".." in name.split("/")
                    or "/vertex/" + name not in runtime):
                raise ContractRejected("candle-module-runtime-member-required")
            raw = read_pinned(pin, 8_388_608)
            digest = hashlib.sha256(raw).hexdigest()
            installed = runtime["/vertex/" + name]
            if (installed.sha256, installed.size) != (digest, len(raw)):
                raise ContractRejected("candle-worker-module-source-mismatch")
            measured[name] = digest
        if (self.context.contracts.digest(measured) != module["codeSha256"]
                or hashlib.sha256(read_pinned(reviewed["contractFile"], 16_777_216)).hexdigest() != module["contractSha256"]):
            raise ContractRejected("candle-measured-code-contract-pin-mismatch")
        # The parent authority adapter itself must be the same reviewed source
        # shipped to the worker, not another arbitrary file with a matching name.
        if hashlib.sha256(read_pinned({"path": __file__,
                "sha256": measured["host/vertex_host/fold_selection.py"]}, 8_388_608)).hexdigest() != measured["host/vertex_host/fold_selection.py"]:
            raise ContractRejected("candle-current-host-source-pin-mismatch")

    def _binding(self, request: CandleAuthorityRequest) -> None:
        from backtesting.walk_forward import _stage_budget
        binding = _object(_artifact(self.boundary, request.binding, "internal.FoldBinding.v1").decode(), _BINDING_KEYS)
        parent = self.lineage.decode()
        lineage = parent["lineage"]
        parent_budget = ResourceBudget(**parent["budget"])
        expected_budget = _stage_budget(parent_budget, len(lineage["folds"]))
        if not _same(self.boundary, binding["budget"], asdict(expected_budget)):
            raise ContractRejected("candle-selected-stage-budget-mismatch")
        expected = {"parentLineageDigest": self.lineage.digest, "strategyDigest": parent["strategyDigest"],
            "codePin": lineage["codePin"], "enginePin": lineage["enginePin"], "dataPins": lineage["dataPins"],
            "assumptionDigest": self.boundary.internal("internal.Assumptions.v1", lineage["assumptions"]).digest,
            "trialRegistry": lineage["trials"], "policyDigest": self.sealed_policy.digest,
            "selectorPin": asdict(self.policy.selector), "verifierPin": asdict(self.policy.verifier),
            "fitterPin": asdict(self.policy.fitter), "parameterMappingPin": asdict(self.policy.parameter_mapping),
            "parameterContract": self.policy.parameter_contract, "initialStateDigest": self.policy.initial_state.digest,
            "capitalPolicy": self.policy.capital_policy, "positionPolicy": self.policy.position_policy,
            "executionAuthorized": False}
        if not _same(self.boundary, {key: binding[key] for key in expected}, expected):
            raise ContractRejected("candle-exact-parent-policy-binding-required")
        index = binding["foldIndex"]
        if (type(index) is not int or not 0 <= index < len(lineage["folds"])
                or not _same(self.boundary, binding["fold"], lineage["folds"][index])):
            raise ContractRejected("candle-selected-fold-binding-mismatch")
        require_hash(binding["policyAdmissionDigest"])
        if (request.policy != self.candle.seal(self.boundary, self.policy_pin)
                or request.policy_pin != self.policy_pin or request.selector_pin != self.policy.selector
                or request.verifier_pin != self.policy.verifier.pin
                or not _same(self.boundary, lineage["dataPins"], [asdict(item.data_pin) for item in self.candle.datasets])):
            raise ContractRejected("candle-exact-config-registration-required")

    def verify(self, request: CandleAuthorityRequest) -> Artifact:
        from vertex_control.adapters import decode_content
        started = self.now_ns()
        self._admission = None
        checked_at, self._checked_at = self._checked_at, None
        if checked_at is None or request.checked_at != checked_at or time_ns(checked_at) > started:
            raise ContractRejected("candle-independent-clock-sample-required")
        self._load_profile()
        self._binding(request)
        self._module(self.policy.selector)
        self._module(self.policy.verifier)
        publication = self.profile["publication"]
        rights_pin = [row for row in self.selection["policies"] if row["role"] == "licensing-rights"]
        if (len(rights_pin) != 1 or rights_pin[0]["policyId"] != publication["rightsPolicyId"]
                or rights_pin[0]["version"] != publication["rightsVersion"]):
            raise ContractRejected("candle-selected-rights-policy-mismatch")
        expiry = min((self.lease["leaseExpiresAt"], self.lease["deadlineAt"], self.selection["expiresAt"]), key=time_ns)
        for use in ("read", "derive"):
            rights = self._call("currentRights", collectionId=publication["collectionId"],
                                policyId=publication["rightsPolicyId"], use=use)
            if (rights["policyId"] != publication["rightsPolicyId"] or rights["version"] != publication["rightsVersion"]
                    or rights["status"] != "granted" or use not in rights["allowedUses"] or rights["expiresAt"] is None
                    or not started <= time_ns(rights["checkedAt"]) <= self.now_ns() < time_ns(rights["expiresAt"])):
                raise PortUnavailable("candle-current-read-derive-rights-denied")
            expiry = min(expiry, rights["expiresAt"], key=time_ns)
        required = {self.lineage.digest, self.sealed_policy.digest, request.policy.digest,
                    self.policy.selector.pin.digest, self.policy.verifier.pin.digest}
        if len(request.sources) != len(self.profile["datasets"]):
            raise ContractRejected("candle-current-source-count-mismatch")
        for original, reference, dataset_policy in zip(request.sources, self.profile["datasets"], self.candle.datasets, strict=True):
            manifest = self._read(reference["manifest"], publication["collectionId"])
            content = self._read(reference["content"], publication["collectionId"])
            if (original.manifest_bytes != manifest or original.content_bytes != content
                    or original.content_format != CANDLE_CONTENT_FORMAT
                    or original.declared_events != reference["declaredEvents"]
                    or reference["manifest"]["sha256"] != dataset_policy.data_pin.manifest_digest
                    or reference["content"]["sha256"] != dataset_policy.data_pin.content_digest):
                raise ContractRejected("candle-current-original-source-bytes-mismatch")
            manifest_value = canonical_object(self.context.contracts, manifest, 1_048_576)
            if (self.context.contracts.validate("DatasetManifest", manifest_value) is not True
                    or manifest_value["entitlementPolicyId"] != publication["rightsPolicyId"]):
                raise ContractRejected("candle-current-source-rights-binding-mismatch")
            required.update((reference["manifest"]["sha256"], reference["content"]["sha256"]))
        reviewed: dict[str, dict[str, Any]] = {}
        for pin in self.profile["reviewPins"]:
            if (pin["collectionId"] != publication["collectionId"] or pin["rightsPolicyId"] != publication["rightsPolicyId"]
                    or pin["rightsVersion"] != publication["rightsVersion"]):
                raise ContractRejected("candle-profile-review-scope-mismatch")
            value = self._call("acceptedEvidence", collectionId=publication["collectionId"], evidenceId=pin["evidenceId"])
            artifact, evidence, review, rights = (value[key] for key in ("artifact", "evidence", "review", "rights"))
            raw = decode_content(value["contentBase64"], pin["artifactSha256"])
            expected_pin = {"collectionId": publication["collectionId"], "evidenceId": evidence["evidenceId"],
                "artifactId": artifact["artifactId"], "artifactSha256": artifact["artifactSha256"],
                "reviewId": review["reviewId"], "reviewVersion": review["reviewVersion"],
                "rightsPolicyId": rights["policyId"], "rightsVersion": rights["version"]}
            if (pin != expected_pin or self.context.contracts.encode(evidence) != raw
                    or self.context.contracts.validate("ResearchEvidence", evidence) is not True
                    or evidence["collectionId"] != publication["collectionId"]
                    or evidence["snapshotId"] != publication["snapshotId"]
                    or evidence["rightsPolicyId"] != publication["rightsPolicyId"]
                    or evidence["contentHash"] not in required
                    or review["artifactId"] != artifact["artifactId"] or review["artifactSha256"] != pin["artifactSha256"]
                    or review["accountAlias"] != self.lease["accountAlias"] or review["environment"] != self.lease["environment"]
                    or review["collectionId"] != publication["collectionId"] or review["purpose"] != "research"
                    or review["decision"] != "accepted" or not time_ns(review["reviewedAt"]) <= started < time_ns(review["expiresAt"])
                    or rights["status"] != "granted" or not {"read", "derive"}.issubset(rights["allowedUses"])
                    or rights["expiresAt"] is None
                    or not started <= time_ns(rights["checkedAt"]) <= self.now_ns() < time_ns(rights["expiresAt"])):
                raise PortUnavailable("candle-current-exact-source-or-policy-review-denied")
            expiry = min(expiry, review["expiresAt"], rights["expiresAt"], key=time_ns)
            reviewed[evidence["evidenceId"]] = evidence
        if {item["contentHash"] for item in reviewed.values()} != required:
            raise PortUnavailable("candle-current-source-policy-review-coverage-missing")
        for ids, digest, registered in ((self.candle.review_evidence_ids, request.policy.digest, self.candle.registered_at),
                (self.policy.review_evidence_ids, self.sealed_policy.digest, timestamp(self.policy.registered_at))):
            if (not set(ids).issubset(reviewed) or not any(reviewed[identity]["contentHash"] == digest
                    and reviewed[identity]["publishedAt"] is not None
                    and time_ns(reviewed[identity]["publishedAt"]) <= time_ns(registered) for identity in ids)):
                raise PortUnavailable("candle-preregistered-policy-review-coverage-missing")
        self._selected()
        self._guard()
        if self.now_ns() >= time_ns(expiry):
            raise PortUnavailable("candle-current-authority-expired-during-check")
        # Retain our consumed clock sample, not a request-supplied assertion;
        # every server rights checkedAt was independently checked >= started.
        self._admission = self.boundary.internal("internal.CandleAuthority.v1", {
            "requestDigest": request.binding.digest, "policyDigest": request.policy.digest,
            "selectorPin": asdict(self.policy.selector), "verifierPin": asdict(self.descriptor),
            "checkedAt": checked_at, "expiresAt": expiry,
            "reviewEvidenceIds": list(self.candle.review_evidence_ids), "verified": True, "executionAuthorized": False,
        })
        return self._admission


class BoundedCandleHost:
    def __init__(self, authority: CurrentCandleAuthority) -> None:
        self.authority = authority
        self.descriptor = authority.policy.selector

    def select(self, request: FoldSelectionRequest, policy: CandleLabelPolicy,
               policy_pin: Pin, admission: Artifact) -> FoldSelection:
        if policy != self.authority.candle or policy_pin != self.authority.policy_pin:
            raise ContractRejected("candle-host-selected-policy-mismatch")
        owner = self.authority
        if (owner._admission != admission or owner._stage_result is not None
                or request.binding.digest in owner._used_requests or len(owner._used_requests) >= 256):
            raise ContractRejected("candle-current-admission-or-once-only-stage-required")
        owner._admission = None
        owner._used_requests.add(request.binding.digest)
        job = CandleFoldJob("candle.select-v1", request, policy, policy_pin, self.descriptor,
            self.authority.policy.verifier, admission, self.authority.profile_digest,
            self.authority.template_bytes, None, None)
        output = self.authority.sandbox.run_fold_worker(job, deadline_ns=self.authority.deadline_ns(),
                                                       cancellation=self.authority.context.cancellation)
        if output.candidate is None or output.verified is not False:
            raise ContractRejected("candle-selector-cannot-approve-output")
        candidate = output.candidate
        result = FoldSelection(candidate.request_digest, candidate.training, candidate.test, candidate.selection_proof,
                               FoldStageEvidence(output.sandbox, output.evidence_bytes))
        # Only an actual result from our concrete supervisor is eligible for the
        # verifier. Caller-created stage DTOs never enter this bounded ledger.
        self.authority._stage_result = (self.authority.profile_digest, result)
        return result


class CandleFoldVerifier:
    def __init__(self, authority: CurrentCandleAuthority) -> None:
        self.authority = authority
        self.descriptor = authority.policy.verifier

    def admit(self, request: PolicyAdmissionRequest) -> FoldVerification:
        raise PortUnavailable("candle-full-fitter-executor-isolation-mapping-admission-unavailable")

    def verify_selection(self, request: FoldSelectionRequest, selection: FoldSelection,
                         sealed_selection: Artifact) -> FoldVerification:
        owner = self.authority
        original, owner._stage_result = owner._stage_result, None
        if original != (owner.profile_digest, selection):
            raise ContractRejected("candle-selection-measured-stage-origin-required")
        now = owner.check_time()
        admission = owner.verify(CandleAuthorityRequest(request.binding,
            owner.candle.seal(owner.boundary, owner.policy_pin), owner.policy_pin,
            owner.policy.selector, self.descriptor.pin, request.sources, now))
        owner._admission = None
        job = CandleFoldJob("candle.verify-v1", request, owner.candle, owner.policy_pin,
            owner.policy.selector, self.descriptor, admission, owner.profile_digest,
            owner.template_bytes, selection, sealed_selection)
        output = owner.sandbox.run_fold_worker(job, deadline_ns=owner.deadline_ns(), cancellation=owner.context.cancellation)
        owner.verify(CandleAuthorityRequest(request.binding, owner.candle.seal(owner.boundary, owner.policy_pin),
            owner.policy_pin, owner.policy.selector, self.descriptor.pin, request.sources, owner.check_time()))
        if (output.verified is not True or output.candidate is not None
                or output.request_digest != request.binding.digest or output.subject_digest != sealed_selection.digest):
            raise ContractRejected("candle-independent-worker-verification-required")
        return FoldVerification(output.request_digest, output.subject_digest, True,
                                FoldStageEvidence(output.sandbox, output.evidence_bytes))


class _CandleClock:
    def __init__(self, authority: CurrentCandleAuthority) -> None:
        self.authority = authority

    def now(self) -> datetime:
        return datetime.fromisoformat(self.authority.check_time().replace("Z", "+00:00"))


def create_candle_fold_ports(*, context: Any, sandbox: Any, reviewed_modules: Any,
                            profile_artifact_id: str, profile_sha256: str) -> tuple[CandleFoldSelector, CandleFoldVerifier]:
    """Explicit opt-in construction only; no handler, provider or process starts.

    Construction resolves authenticated current profile bytes. Use on the host's
    existing bounded worker thread, not its event loop. No default profile/pin.
    """
    owner = CurrentCandleAuthority(context=context, sandbox=sandbox, reviewed_modules=reviewed_modules,
                                  profile_artifact_id=profile_artifact_id, profile_sha256=profile_sha256)
    selector = CandleFoldSelector(descriptor=owner.policy.selector, policy=owner.candle, policy_pin=owner.policy_pin,
        verifier_pin=owner.descriptor, authority=owner, host=BoundedCandleHost(owner),
        clock=_CandleClock(owner), boundary=owner.boundary)
    return selector, CandleFoldVerifier(owner)
