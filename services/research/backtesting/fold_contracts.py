"""Internal walk-forward capabilities, not a host recipe or public wire schema.

Only the selector and its independent verifier receive original dataset bytes.
Fitters receive verified training records; executors receive test records and
canonical fitted parameters. These interfaces provide no implementation,
authorization, data decoder, default fitter, or economic aggregation policy.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .lineage import Pin, WalkForwardFold, time_ns, timestamp
from .planner import BacktestPlan, DatasetInput, EngineDescriptor, SandboxReceipt, SimulationOutput
from .ports import Artifact, ResourceBudget, require_hash, require_id, utc


def _bounded_artifact(artifact: Artifact) -> None:
    if not isinstance(artifact, Artifact) or len(artifact.payload_bytes) > 64_000_000:
        raise ValueError("bounded immutable fold artifact required")
    require_id(artifact.contract_name)


@dataclass(frozen=True)
class FoldPortPin:
    pin: Pin
    sandbox_policy_digest: str

    def __post_init__(self) -> None:
        require_hash(self.sandbox_policy_digest)


@dataclass(frozen=True)
class WalkForwardPolicy:
    """Explicitly reviewed capabilities; unsupported carry semantics fail closed.

    initial_state is the canonical capital/accounting state for EACH independent
    fold. Its interpretation and the parameter-to-engine mapping belong to the
    pinned executor and must be admitted by the independent policy verifier.
    No state is inferred from the parent run or carried from another fold.
    """
    selector: FoldPortPin
    verifier: FoldPortPin
    fitter: FoldPortPin
    executor: EngineDescriptor
    parameter_mapping: Pin
    parameter_contract: str
    initial_state: Artifact
    capital_policy: str
    position_policy: str
    registered_at: datetime
    review_evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.parameter_contract)
        _bounded_artifact(self.initial_state)
        object.__setattr__(self, "registered_at", utc(self.registered_at))
        object.__setattr__(self, "review_evidence_ids", tuple(self.review_evidence_ids))
        if not 1 <= len(self.review_evidence_ids) <= 64 or len(set(self.review_evidence_ids)) != len(self.review_evidence_ids):
            raise ValueError("unique policy review evidence required")
        for identity in self.review_evidence_ids:
            require_id(identity)

    def record(self) -> dict[str, Any]:
        """Seal as internal.WalkForwardPolicy.v1 before admitting its evidence."""
        return {
            "selector": asdict(self.selector), "verifier": asdict(self.verifier),
            "fitter": asdict(self.fitter), "executor": asdict(self.executor),
            "parameterMapping": asdict(self.parameter_mapping), "parameterContract": self.parameter_contract,
            "initialState": {"contractName": self.initial_state.contract_name, "digest": self.initial_state.digest},
            "capitalPolicy": self.capital_policy, "positionPolicy": self.position_policy,
            "registeredAt": timestamp(self.registered_at), "reviewEvidenceIds": list(self.review_evidence_ids),
            "executionAuthorized": False,
        }


@dataclass(frozen=True)
class FoldRecord:
    """A source-addressed record, NEVER trusted merely from its declared times.

    The verifier must check payloads AND timestamp/label semantics against the
    original pinned source bytes under the reviewed selection policy. Offsets,
    source row keys and format-specific proofs belong to selection_proof, not
    guessed field aliases here. UTC strings preserve nanosecond precision.
    """
    record_id: str
    dataset_id: str
    source_content_digest: str
    observed_at: str
    available_at: str
    features: Artifact
    label: Artifact | None = None
    label_end_at: str | None = None
    label_available_at: str | None = None

    def __post_init__(self) -> None:
        require_id(self.record_id)
        require_id(self.dataset_id)
        require_hash(self.source_content_digest)
        _bounded_artifact(self.features)
        if self.label is not None:
            _bounded_artifact(self.label)
        for value in (self.observed_at, self.available_at):
            if not isinstance(value, str):
                raise ValueError("exact UTC record timestamp required")
            time_ns(value)
        if (self.label is None) != (self.label_end_at is None) or (self.label is None) != (self.label_available_at is None):
            raise ValueError("label payload, horizon and availability must be supplied together")
        for value in (self.label_end_at, self.label_available_at):
            if value is not None:
                if not isinstance(value, str):
                    raise ValueError("exact UTC label timestamp required")
                time_ns(value)


@dataclass(frozen=True)
class FoldStageEvidence:
    sandbox: SandboxReceipt
    evidence_bytes: tuple[bytes, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "evidence_bytes", tuple(self.evidence_bytes))
        if any(not isinstance(value, bytes) for value in self.evidence_bytes):
            raise ValueError("immutable stage evidence required")
        if len(self.evidence_bytes) > 64 or sum(len(value) for value in self.evidence_bytes) > 64_000_000:
            raise ValueError("bounded stage evidence required")


@dataclass(frozen=True)
class PolicyAdmissionRequest:
    binding: Artifact
    parent: BacktestPlan
    policy: WalkForwardPolicy
    sealed_policy: Artifact
    budget: ResourceBudget
    execution_authorized: bool = field(default=False, init=False)


@dataclass(frozen=True)
class FoldSelectionRequest:
    binding: Artifact
    fold: WalkForwardFold
    sources: tuple[DatasetInput, ...]
    budget: ResourceBudget
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "sources", tuple(self.sources))


@dataclass(frozen=True)
class FoldSelection:
    request_digest: str
    training: tuple[FoldRecord, ...]
    test: tuple[FoldRecord, ...]
    selection_proof: Artifact
    evidence: FoldStageEvidence
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        require_hash(self.request_digest)
        object.__setattr__(self, "training", tuple(self.training))
        object.__setattr__(self, "test", tuple(self.test))
        _bounded_artifact(self.selection_proof)
        if len(self.training) + len(self.test) > 2_000_000:
            raise ValueError("bounded selected record count required")


@dataclass(frozen=True)
class FoldVerification:
    request_digest: str
    subject_digest: str
    verified: bool
    evidence: FoldStageEvidence
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        require_hash(self.request_digest)
        require_hash(self.subject_digest)
        if type(self.verified) is not bool:
            raise ValueError("explicit verification decision required")


@dataclass(frozen=True)
class FoldFitRequest:
    binding: Artifact
    training: tuple[FoldRecord, ...]
    budget: ResourceBudget
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "training", tuple(self.training))


@dataclass(frozen=True)
class FoldFitResult:
    request_digest: str
    parameters: Artifact | None
    provenance: Artifact
    evidence: FoldStageEvidence
    status: str
    reasons: tuple[str, ...] = ()
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        require_hash(self.request_digest)
        object.__setattr__(self, "reasons", tuple(self.reasons))
        _bounded_artifact(self.provenance)
        if self.parameters is not None:
            _bounded_artifact(self.parameters)
        if len(self.reasons) > 64:
            raise ValueError("bounded fit reasons required")
        if self.status not in {"completed", "rejected", "inconclusive", "unavailable"}:
            raise ValueError("unknown fit status")
        for reason in self.reasons:
            require_id(reason)


@dataclass(frozen=True)
class FoldExecutionRequest:
    binding: Artifact
    test: tuple[FoldRecord, ...]
    parameters: Artifact
    strategy: Artifact
    assumptions: Artifact
    initial_state: Artifact
    budget: ResourceBudget
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "test", tuple(self.test))


@dataclass(frozen=True)
class FoldExecutionResult:
    request_digest: str
    initial_state_digest: str
    started_flat: bool
    ended_flat: bool
    output: SimulationOutput
    execution_authorized: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        require_hash(self.request_digest)
        require_hash(self.initial_state_digest)
        if type(self.started_flat) is not bool or type(self.ended_flat) is not bool:
            raise ValueError("explicit fold position boundary facts required")


class FoldSelector(Protocol):
    descriptor: FoldPortPin

    def select(self, request: FoldSelectionRequest) -> FoldSelection: ...


class FoldVerifier(Protocol):
    descriptor: FoldPortPin

    def admit(self, request: PolicyAdmissionRequest) -> FoldVerification:
        """Verify exact policy/source/review pins, including selection semantics.

        Require current review for the policy and every capability, original
        dataset rights, feature/label causal interpretation, parameter mapping,
        and explicit initial state/reset/flat-boundary accounting semantics.
        The fitter's isolation policy must confine it to this fold's training
        request only: no shared selector/verifier memory, source catalog access,
        prior fit state, or test inputs. The executor must expose test features
        only in availability order, not preload future observations into the
        strategy. Receipts must enforce all ResourceBudget limits, including
        candidate/trial limits, not just process CPU/memory limits. Python
        object separation alone is not evidence of that host isolation.
        Unsupported or unreviewed semantics must not return verified=True.
        """
        ...

    def verify_selection(
        self, request: FoldSelectionRequest, selection: FoldSelection, sealed_selection: Artifact,
    ) -> FoldVerification:
        """Independently verify source membership, payloads, causality and completeness.

        Check exact original bytes, source pins and policy, not just the supplied
        per-record timestamps or selector's assertion. Verify no future/test
        information occurs inside training feature/label payloads. Test features
        must be available at the recorded decision/availability time and contain
        no labels/future observations. Reject unknown data/label semantics.
        """
        ...


class FoldFitter(Protocol):
    descriptor: FoldPortPin

    def fit(self, request: FoldFitRequest) -> FoldFitResult: ...


class FoldExecutor(Protocol):
    descriptor: EngineDescriptor

    def execute(self, request: FoldExecutionRequest) -> FoldExecutionResult: ...
