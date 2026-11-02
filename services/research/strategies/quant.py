"""Pure hypothesis/spec/experiment orchestration, without running research code.

Experiment handoffs are internal immutable requests, not a new public contract.
Replay/backtesting consumes their frozen identities through explicit integration.
A complete evidence review is still not paper execution or live authorization.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from copy import deepcopy
from typing import Protocol

from .core import count, digest_text, identity, instant
from .publication import (AuthoritativeValidator, CanonicalCodec, ImmutablePublicationPlan,
                          Unavailable, encode_authoritatively)

PROMOTION_GATES = ("reproducible-backtest", "out-of-sample", "walk-forward", "stress",
                   "cost-sensitivity", "forward-paper")


@dataclass(frozen=True)
class ClaimCitation:
    source_id: str
    artifact_hash: str
    locator: str
    url_or_doi: str
    author: str
    source_version: str
    rights_receipt_id: str
    claim_kind: str

    def __post_init__(self):
        identity(self.source_id)
        identity(self.rights_receipt_id)
        digest_text(self.artifact_hash)
        if not all(value.strip() for value in (self.locator, self.url_or_doi, self.author, self.source_version)):
            raise ValueError("Citation needs source/version/author/locator; no invented paper claim")
        if self.claim_kind not in {"source-asserted", "analyst-derived", "reproduced"}:
            raise ValueError("Claim attribution kind required")


@dataclass(frozen=True)
class Hypothesis:
    hypothesis_id: str
    revision: int
    statement: str
    falsification: str
    assumptions: tuple[str, ...]
    citations: tuple[ClaimCitation, ...]
    created_at: datetime

    def __post_init__(self):
        identity(self.hypothesis_id)
        count(self.revision, positive=True)
        instant(self.created_at)
        if not self.statement.strip() or not self.falsification.strip() or not self.assumptions or not self.citations:
            raise ValueError("Hypothesis requires falsification, explicit assumptions and citations")
        if any(not value.strip() for value in self.assumptions):
            raise ValueError("Empty assumption")


@dataclass(frozen=True)
class FrozenDataset:
    dataset_id: str
    manifest_hash: str
    snapshot_id: str
    available_at: datetime
    knowledge_cutoff: datetime
    rights_receipt_id: str
    point_in_time: bool

    def __post_init__(self):
        for value in (self.dataset_id, self.snapshot_id, self.rights_receipt_id):
            identity(value)
        digest_text(self.manifest_hash)
        instant(self.available_at)
        instant(self.knowledge_cutoff)
        if self.knowledge_cutoff > self.available_at or type(self.point_in_time) is not bool:
            raise ValueError("Invalid frozen dataset clocks/status")


@dataclass(frozen=True)
class ExperimentWindow:
    start_at: datetime
    end_at: datetime

    def __post_init__(self):
        instant(self.start_at)
        instant(self.end_at)
        if self.start_at >= self.end_at:
            raise ValueError("Experiment intervals are half-open and nonempty")


@dataclass(frozen=True)
class ExperimentRequest:
    experiment_id: str
    hypothesis: Hypothesis
    strategy: ImmutablePublicationPlan
    datasets: tuple[FrozenDataset, ...]
    training: ExperimentWindow
    out_of_sample: ExperimentWindow
    embargo_seconds: int
    seed: int
    environment_digest: str
    engine_version: str
    implementation_digest: str
    requested_at: datetime
    parameter_grid: tuple[tuple[str, tuple[str, ...]], ...]
    maximum_trials: int
    maximum_runtime_seconds: int
    maximum_memory_mb: int
    prior_experiment_hash: str | None = None

    def __post_init__(self):
        identity(self.experiment_id)
        identity(self.engine_version)
        digest_text(self.environment_digest)
        digest_text(self.implementation_digest)
        if self.prior_experiment_hash is not None:
            digest_text(self.prior_experiment_hash)
        instant(self.requested_at)
        for value in (self.embargo_seconds, self.seed):
            count(value)
        for value in (self.maximum_trials, self.maximum_runtime_seconds, self.maximum_memory_mb):
            count(value, positive=True)
        if self.hypothesis.created_at > self.requested_at:
            raise ValueError("Future hypothesis")
        if (self.out_of_sample.start_at - self.training.end_at).total_seconds() < self.embargo_seconds:
            raise ValueError("Training/OOS overlap or embargo violation")
        if self.out_of_sample.end_at > self.requested_at:
            raise ValueError("Historical experiment cannot request future outcomes")
        if not self.datasets or len({item.dataset_id for item in self.datasets}) != len(self.datasets):
            raise ValueError("Distinct frozen datasets required")
        if any(not item.point_in_time or item.available_at > self.requested_at for item in self.datasets):
            raise ValueError("Point-in-time datasets known at request are required")
        if len({key for key, _ in self.parameter_grid}) != len(self.parameter_grid):
            raise ValueError("Duplicate parameter dimension")
        trials = 1
        for key, values in self.parameter_grid:
            identity(key)
            if not values or len(set(values)) != len(values) or any(not isinstance(value, str) or not value for value in values):
                raise ValueError("Parameter values must be distinct literal research inputs")
            trials *= len(values)
            if trials > self.maximum_trials:
                raise ValueError("Parameter search exceeds explicit trial budget")


@dataclass(frozen=True)
class ExperimentHandoff:
    experiment_id: str
    content_hash: str
    canonical_bytes: bytes
    strategy_hash: str
    dataset_hashes: tuple[str, ...]
    executable: bool = False
    simulated_capital_enters_nav: bool = False

    def __post_init__(self):
        identity(self.experiment_id)
        digest_text(self.content_hash)
        digest_text(self.strategy_hash)
        for value in self.dataset_hashes:
            digest_text(value)
        if type(self.canonical_bytes) is not bytes or hashlib.sha256(self.canonical_bytes).hexdigest() != self.content_hash:
            raise ValueError("Experiment handoff bytes/hash mismatch")
        if self.executable is not False or self.simulated_capital_enters_nav is not False:
            raise ValueError("Research capital and handoffs cannot authorize execution or enter NAV")
        payload = json.loads(self.canonical_bytes)
        if (payload.get("internalKind") != "vertex-quant-experiment-handoff-v1"
                or payload.get("experimentId") != self.experiment_id
                or payload.get("strategy", {}).get("hash") != self.strategy_hash
                or tuple(item.get("manifestHash") for item in payload.get("datasets", ())) != self.dataset_hashes):
            raise ValueError("Experiment identity does not bind immutable payload")
        if payload.get("executionAuthority") != "none" or payload.get("simulatedCapitalEntersNav") is not False:
            raise ValueError("Immutable experiment payload cannot authorize execution or enter NAV")


class ImmutableExperimentStore(Protocol):
    def put_if_absent(self, handoff: ExperimentHandoff) -> str:
        """Persist immutable internal handoff; same ID/different hash must reject.

        Return the exact content hash; this does not schedule/execute the request.
        """
        ...


def _timestamp(value: datetime) -> str:
    return instant(value).isoformat().replace("+00:00", "Z")


def plan_experiment(request: ExperimentRequest, *, codec: CanonicalCodec | None,
                    validator: AuthoritativeValidator | None) -> ExperimentHandoff | Unavailable:
    if codec is None or validator is None:
        return Unavailable(("authoritative-canonical-codec-or-validator-unavailable",))
    candidate = json.loads(request.strategy.canonical_bytes)
    if validator.validate("StrategySpec", deepcopy(candidate), schema_version="1.0.0") is not True:
        raise ValueError("Experiment needs an authoritative StrategySpec")
    encoded_strategy, strategy_hash = encode_authoritatively(candidate, codec)
    if encoded_strategy != request.strategy.canonical_bytes or strategy_hash != request.strategy.content_hash:
        raise ValueError("Strategy canonical bytes do not match experiment dependency")
    if f"{candidate['strategyId']}:{candidate['version']}" != request.strategy.artifact_id:
        raise ValueError("Strategy identity mismatch")
    if candidate["hypothesis"] != request.hypothesis.statement:
        raise ValueError("Frozen strategy must bind the stated hypothesis")
    h = request.hypothesis
    payload = {
        "internalKind": "vertex-quant-experiment-handoff-v1", "experimentId": request.experiment_id,
        "hypothesis": {"id": h.hypothesis_id, "revision": h.revision, "statement": h.statement,
                       "falsification": h.falsification, "assumptions": list(h.assumptions),
                       "createdAt": _timestamp(h.created_at),
                       "citations": [{"sourceId": c.source_id, "artifactHash": c.artifact_hash,
                                      "locator": c.locator, "urlOrDoi": c.url_or_doi, "author": c.author,
                                      "sourceVersion": c.source_version, "rightsReceiptId": c.rights_receipt_id,
                                      "claimKind": c.claim_kind} for c in h.citations]},
        "strategy": {"id": request.strategy.artifact_id, "hash": request.strategy.content_hash,
                     "contractName": "StrategySpec", "schemaVersion": "1.0.0"},
        "datasets": [{"datasetId": d.dataset_id, "manifestHash": d.manifest_hash,
                      "snapshotId": d.snapshot_id, "availableAt": _timestamp(d.available_at),
                      "knowledgeCutoff": _timestamp(d.knowledge_cutoff), "rightsReceiptId": d.rights_receipt_id,
                      "pointInTime": d.point_in_time} for d in sorted(request.datasets, key=lambda d: d.dataset_id)],
        "windows": {"training": {"start": _timestamp(request.training.start_at), "end": _timestamp(request.training.end_at)},
                    "outOfSample": {"start": _timestamp(request.out_of_sample.start_at), "end": _timestamp(request.out_of_sample.end_at)},
                    "embargoSeconds": request.embargo_seconds},
        "seed": request.seed, "environmentDigest": request.environment_digest,
        "engineVersion": request.engine_version, "implementationDigest": request.implementation_digest,
        "requestedAt": _timestamp(request.requested_at),
        "parameterGrid": {key: list(values) for key, values in sorted(request.parameter_grid)},
        "budget": {"maximumTrials": request.maximum_trials, "maximumRuntimeSeconds": request.maximum_runtime_seconds,
                   "maximumMemoryMb": request.maximum_memory_mb},
        "sandbox": {"network": False, "broker": False, "secrets": False, "writeOutsideArtifactRoot": False},
        "priorExperimentHash": request.prior_experiment_hash,
        "requiredEvidenceGates": list(PROMOTION_GATES),
        "executionAuthority": "none", "simulatedCapitalEntersNav": False,
    }
    encoded, digest = encode_authoritatively(payload, codec)
    return ExperimentHandoff(request.experiment_id, digest, encoded, request.strategy.content_hash,
                             tuple(d.manifest_hash for d in sorted(request.datasets, key=lambda d: d.dataset_id)))


def store_experiment(handoff: ExperimentHandoff, *, store: ImmutableExperimentStore | None) -> str | Unavailable:
    if store is None:
        return Unavailable(("immutable-experiment-store-unavailable",))
    # Bytes are immutable and were identity-checked by the frozen handoff.
    stored_hash = store.put_if_absent(handoff)
    if stored_hash != handoff.content_hash:
        raise ValueError("Experiment store did not confirm exact immutable identity")
    return stored_hash


@dataclass(frozen=True)
class ExperimentEvidence:
    gate: str
    experiment_hash: str
    artifact_hash: str
    reviewed_at: datetime
    reviewer_id: str
    outcome: str
    contaminated: bool
    limitations: tuple[str, ...] = ()

    def __post_init__(self):
        if self.gate not in PROMOTION_GATES or self.outcome not in {"pass", "fail", "unavailable"}:
            raise ValueError("Unknown evidence gate/outcome")
        digest_text(self.experiment_hash)
        digest_text(self.artifact_hash)
        instant(self.reviewed_at)
        identity(self.reviewer_id)
        if type(self.contaminated) is not bool:
            raise ValueError("Contamination must be explicit")


@dataclass(frozen=True)
class PromotionReview:
    state: str
    missing_gates: tuple[str, ...]
    rejected_gates: tuple[str, ...]
    execution_authority: str = "none"
    requires_separate_human_approval: bool = True


def review_experiment(handoff: ExperimentHandoff, evidence: tuple[ExperimentEvidence, ...], *,
                      as_of: datetime) -> PromotionReview:
    instant(as_of)
    if len({item.gate for item in evidence}) != len(evidence):
        raise ValueError("Conflicting duplicate gate evidence")
    indexed = {item.gate: item for item in evidence}
    missing, rejected = [], []
    for gate in PROMOTION_GATES:
        item = indexed.get(gate)
        if item is None or item.outcome == "unavailable":
            missing.append(gate)
        elif item.experiment_hash != handoff.content_hash or item.reviewed_at > as_of or item.outcome != "pass" or item.contaminated or item.limitations:
            rejected.append(gate)
    state = "research-evidence-complete" if not missing and not rejected else "research-incomplete"
    return PromotionReview(state, tuple(missing), tuple(rejected))
