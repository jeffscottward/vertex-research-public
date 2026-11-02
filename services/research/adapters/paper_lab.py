"""Selected reviewed paper/lab sources -> existing pure mappings/publication.

No model, parser, engine, scheduler, promotion or receipt-echo verifier. Every
source is re-read through current scoped control operations. The selected local
implementation manifest pins this verifier and its pure computational modules.
"""
from __future__ import annotations

import base64
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any

from agents.types import AcceptedReview
from backtesting.lineage import (AcceptanceCriterion, DataPin, ForwardCriteria, Incident,
    LineageInputs, ModelAssumption, Pin, PointInTimeEvidence, TimeWindow, TrialRegistry, WalkForwardFold)
from backtesting.planner import EngineDescriptor
from backtesting.ports import ResourceBudget
from knowledge.models import Segment, SourceInput
from knowledge.papers import PaperInput
from strategies.core import digest_text, identity
from strategies.experiment_backtest import (DatasetSnapshotBinding, ReviewedBacktestBinding,
    backtest_candidates, map_committed_experiment)
from strategies.experiment_gates import (GateCriterion, GateObservation, GatePolicy, committed_policy_rules,
    parse_time, review_with_gate_evidence)
from strategies.lab_authority import (LabScope, LabVerificationReceipt, LabVerificationRequest,
    LabVerifierPin, ReviewedEvidence, evidence_record, original_record, public_record, receipt_record, timestamp)
from strategies.lab_metrics import (COST_FIELDS, COST_PROFILE, OOS_PRECOMMITTED_FIELDS, OOS_PRECOMMITTED_PROFILE,
    REPRODUCTION_FIELDS, REPRODUCTION_PROFILE, REPRODUCTION_ROLES, STRESS_FIELDS, STRESS_PROFILE,
    STRESS_PRECOMMITTED_PROFILE, gate_method_rule_pin, project_cost_observation,
    project_historical_stress_observation, project_oos_observation, project_reproduction_observation)
from strategies.paper_lab import PaperClaim, PaperClaimMapRequest, _claim_record, map_reviewed_claims, plan_mapped_experiment
from strategies.publication import ImmutablePublicationPlan, Unavailable, encode_authoritatively
from strategies.quant import (ClaimCitation, ExperimentHandoff, ExperimentRequest, ExperimentWindow,
    FrozenDataset, Hypothesis, PROMOTION_GATES, store_experiment)
from vertex_control.client import ControlError

from .experiments import ControlImmutableExperimentStore
from .ports import AdapterUnavailable

REVIEW_FIELDS = {"collectionId", "evidenceId", "artifactId", "artifactSha256", "reviewId", "reviewVersion", "rightsPolicyId", "rightsVersion"}
RECIPE_FIELDS = {"profile", "module_id", "task_contract", "operation", "collection_id", "snapshot_id",
                 "implementation", "request", "inputs", "dependency_pins", "publication"}
OPERATIONS = {"map-claims", "freeze-experiment", "map-backtest", "review-gates"}
RESEARCH_SOURCE_PATHS = ("adapters/paper_lab.py", "strategies/lab_authority.py", "strategies/paper_lab.py",
    "strategies/experiment_backtest.py", "strategies/experiment_gates.py", "strategies/lab_metrics.py",
    "strategies/quant.py", "strategies/publication.py", "strategies/core.py",
    "backtesting/lineage.py", "backtesting/ports.py", "backtesting/planner.py",
    "agents/types.py", "knowledge/models.py", "knowledge/papers.py",
    "adapters/experiments.py", "adapters/handlers.py", "adapters/ports.py", "providers/ports.py", "providers/boundary.py")
SOURCE_PATHS = tuple("services/research/" + name for name in RESEARCH_SOURCE_PATHS) + (
    "services/control-client/vertex_control/adapters.py", "services/control-client/vertex_control/client.py")


def _record(value: Any, keys: set[str]) -> dict:
    if type(value) is not dict or set(value) != keys:
        raise AdapterUnavailable("paper-lab-closed-profile-required")
    return dict(value)


def _ref(value: Any) -> dict:
    row = _record(value, {"artifactId", "sha256"})
    identity(row["artifactId"])
    digest_text(row["sha256"])
    return row


def _bytes(value: Any, maximum: int = 262_144) -> bytes:
    if type(value) is not str or not value.isascii() or not 4 <= len(value) <= ((maximum + 2) // 3) * 4:
        raise AdapterUnavailable("paper-lab-original-byte-budget")
    raw = base64.b64decode(value, validate=True)
    if not raw or len(raw) > maximum or base64.b64encode(raw).decode("ascii") != value:
        raise AdapterUnavailable("paper-lab-original-byte-budget")
    return raw


def _at(ns: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ns // 1000)


def _construct(kind: Any, value: Any, **replacements: Any) -> Any:
    row = _record(value, {field.name for field in fields(kind)})
    return kind(**{**row, **replacements})


def _lineage(value: Any) -> LineageInputs:
    """Closed authored dataclass source shape, never arbitrary class/import names."""
    row = _record(value, {f.name for f in fields(LineageInputs)})
    pins = tuple(_construct(DataPin, p, calendar_pin=_construct(Pin, p["calendar_pin"]),
        source_digests=tuple(p["source_digests"]), data_kinds=tuple(p["data_kinds"])) for p in row["data_pins"])
    points = tuple(_construct(PointInTimeEvidence, p, **{k: parse_time(p[k]) for k in
        ("observed_at", "published_at", "available_at", "revision_at", "decision_at")}) for p in row["point_in_time"])
    assumptions = tuple(_construct(ModelAssumption, a,
        model_pin=None if a["model_pin"] is None else _construct(Pin, a["model_pin"]),
        parameters_bytes=_bytes(a["parameters_bytes"]), evidence_ids=tuple(a["evidence_ids"])) for a in row["assumptions"])
    def window(w):
        return _construct(TimeWindow, w, start_at=parse_time(w["start_at"]), end_at=parse_time(w["end_at"]))
    folds = tuple(_construct(WalkForwardFold, f, training=window(f["training"]), test=window(f["test"]),
        fitted_at=parse_time(f["fitted_at"]), training_labels_end_at=parse_time(f["training_labels_end_at"]),
        evidence_ids=tuple(f["evidence_ids"])) for f in row["folds"])
    trial = row["trials"]
    trials = None if trial is None else _construct(TrialRegistry, trial,
        registered_at=parse_time(trial["registered_at"]), trial_ids=tuple(trial["trial_ids"]))
    fc = row["forward_criteria"]
    forward = None if fc is None else _construct(ForwardCriteria, fc, registered_at=parse_time(fc["registered_at"]),
        not_before=parse_time(fc["not_before"]), evidence_ids=tuple(fc["evidence_ids"]))
    criteria = tuple(_construct(AcceptanceCriterion, c, registered_at=parse_time(c["registered_at"]),
        evidence_ids=tuple(c["evidence_ids"])) for c in row["acceptance_criteria"])
    return _construct(LineageInputs, row, strategy_frozen_at=parse_time(row["strategy_frozen_at"]),
        code_pin=_construct(Pin, row["code_pin"]), engine_pin=None if row["engine_pin"] is None else _construct(Pin, row["engine_pin"]),
        data_pins=pins, point_in_time=points, assumptions=assumptions, folds=folds, trials=trials,
        forward_criteria=forward, incidents=tuple(_construct(Incident, i, evidence_ids=tuple(i["evidence_ids"])) for i in row["incidents"]),
        citations=tuple(row["citations"]), acceptance_criteria=criteria)


def _backtest_binding(value: Any) -> ReviewedBacktestBinding:
    row = _record(value, {f.name for f in fields(ReviewedBacktestBinding)})
    descriptor = row["descriptor"]
    return _construct(ReviewedBacktestBinding, row, lineage=_lineage(row["lineage"]),
        budget=_construct(ResourceBudget, row["budget"]),
        descriptor=_construct(EngineDescriptor, descriptor, pin=_construct(Pin, descriptor["pin"]),
            modeled_assumptions=tuple(descriptor["modeled_assumptions"]), supported_formats=tuple(descriptor["supported_formats"])),
        model_bytes=_bytes(row["model_bytes"]), publication_bytes=_bytes(row["publication_bytes"]),
        planned_at=parse_time(row["planned_at"]), trial_parameters=tuple(tuple(p) for p in row["trial_parameters"]),
        parameter_targets=tuple(tuple(p) for p in row["parameter_targets"]),
        dataset_snapshots=tuple(_construct(DatasetSnapshotBinding, d, source_snapshots=tuple(tuple(p) for p in d["source_snapshots"]))
                                for d in row["dataset_snapshots"]))


def _policy(raw: bytes, codec: Any) -> GatePolicy:
    original = original_record(raw, codec=codec)
    if original.get("format") == "vertex-experiment-gate-policy-v1":
        raise AdapterUnavailable("paper-lab-legacy-gate-policy-publication-proof-unavailable")
    row = _record(original, {"format", "policyId", "revision", "experimentHash", "registeredAt",
        "rulesHash", "criteria", "executionAuthority"})
    if row["format"] != "vertex-experiment-gate-policy-v2" or row["executionAuthority"] != "none":
        raise AdapterUnavailable("paper-lab-gate-policy-profile")
    items = []
    for value in row["criteria"]:
        c = _record(value, {"criterionId", "gate", "criterion", "unit", "window", "method",
            "ruleMethod", "maximumAgeSeconds", "requiredOrigin"})
        metric = _record(c["criterion"], {"metricId", "operator", "threshold", "registeredAt", "evidenceIds"})
        item = GateCriterion(c["criterionId"], c["gate"], AcceptanceCriterion(metric["metricId"], metric["operator"],
            metric["threshold"], parse_time(metric["registeredAt"]), tuple(metric["evidenceIds"])), c["unit"],
            ExperimentWindow(parse_time(c["window"]["start"]), parse_time(c["window"]["end"])),
            _construct(Pin, c["method"]), c["maximumAgeSeconds"], _construct(Pin, c["ruleMethod"]))
        if item.record() != c:
            raise AdapterUnavailable("paper-lab-gate-policy-original-mismatch")
        items.append(item)
    policy = GatePolicy(row["policyId"], row["revision"], row["experimentHash"],
        parse_time(row["registeredAt"]), tuple(items), row["rulesHash"])
    if codec.encode(policy.record()) != raw:
        raise AdapterUnavailable("paper-lab-gate-policy-original-mismatch")
    return policy


def _handoff(raw: bytes, codec: Any) -> ExperimentHandoff:
    row = original_record(raw, codec=codec)
    return ExperimentHandoff(row["experimentId"], sha256(raw).hexdigest(), raw,
        row["strategy"]["hash"], tuple(d["manifestHash"] for d in row["datasets"]))


def _experiment(raw: bytes, strategy_raw: bytes, codec: Any) -> ExperimentRequest:
    h = _handoff(raw, codec)
    row = original_record(raw, codec=codec)
    hypothesis = row["hypothesis"]
    citations = tuple(ClaimCitation(c["sourceId"], c["artifactHash"], c["locator"], c["urlOrDoi"], c["author"],
        c["sourceVersion"], c["rightsReceiptId"], c["claimKind"]) for c in hypothesis["citations"])
    strategy = ImmutablePublicationPlan("StrategySpec", "1.0.0", row["strategy"]["id"], h.strategy_hash, strategy_raw)
    datasets = tuple(FrozenDataset(d["datasetId"], d["manifestHash"], d["snapshotId"], parse_time(d["availableAt"]),
        parse_time(d["knowledgeCutoff"]), d["rightsReceiptId"], d["pointInTime"]) for d in row["datasets"])
    window = lambda value: ExperimentWindow(parse_time(value["start"]), parse_time(value["end"]))
    return ExperimentRequest(h.experiment_id, Hypothesis(hypothesis["id"], hypothesis["revision"], hypothesis["statement"],
        hypothesis["falsification"], tuple(hypothesis["assumptions"]), citations, parse_time(hypothesis["createdAt"])),
        strategy, datasets, window(row["windows"]["training"]), window(row["windows"]["outOfSample"]),
        row["windows"]["embargoSeconds"], row["seed"], row["environmentDigest"], row["engineVersion"],
        row["implementationDigest"], parse_time(row["requestedAt"]),
        tuple((key, tuple(values)) for key, values in sorted(row["parameterGrid"].items())),
        row["budget"]["maximumTrials"], row["budget"]["maximumRuntimeSeconds"], row["budget"]["maximumMemoryMb"], row["priorExperimentHash"])


@dataclass(frozen=True)
class _Source:
    name: str
    reference: dict
    pin: dict
    raw: bytes
    evidence_bytes: bytes
    evidence: dict


class CurrentPaperLabVerifier:
    """Concrete fresh control reads + closed source transformations, not a callback echo."""
    def __init__(self, job: Any, recipe: dict, recipe_hash: str, implementation: dict):
        self.job, self.recipe, self.codec = job, recipe, job.context.contracts
        manifest = _record(implementation, {"profile", "identity", "version", "sourceHashes"})
        if (manifest["profile"] != "vertex-paper-lab-implementation-v1" or manifest["identity"] != "vertex-paper-lab"
                or manifest["version"] != "1.0.0" or type(manifest["sourceHashes"]) is not dict
                or set(manifest["sourceHashes"]) != set(SOURCE_PATHS)):
            raise AdapterUnavailable("paper-lab-implementation-profile")
        root = Path(__file__).resolve().parents[3]
        for relative in SOURCE_PATHS:
            digest_text(manifest["sourceHashes"][relative])
            if sha256((root / relative).read_bytes()).hexdigest() != manifest["sourceHashes"][relative]:
                raise AdapterUnavailable("paper-lab-reviewed-implementation-mismatch")
        self.source_hashes = dict(manifest["sourceHashes"])
        self.source_root = root
        self.pin = LabVerifierPin(Pin("vertex-paper-lab", "1.0.0", self.codec.digest(manifest)), recipe_hash)
        self.reference_ns = job.clock.now_ns() // 1000 * 1000
        self.as_of = _at(self.reference_ns)
        self.scope = LabScope(job.lease["researchPrincipalId"], job.lease["accountAlias"], recipe["collection_id"],
            recipe["snapshot_id"], job.lease["policySelectionSha256"], job.lease["environment"])
        self.sources: dict[str, _Source] = {}
        self.reviews: dict[str, AcceptedReview] = {}
        self.reviewers: dict[str, str] = {}
        self.used: set[str] = set()
        self.committed: ExperimentHandoff | None = None
        self.spec: PaperClaimMapRequest | None = None
        self.expected_mapping: bytes | None = None
        self.expected_handoff: bytes | None = None
        self.backtest: ReviewedBacktestBinding | None = None
        self.strategy_original: bytes | None = None
        self.backtest_dataset_originals: tuple[bytes, ...] = ()
        self.last_claim_receipt: LabVerificationReceipt | None = None
        self.gate_policy_evidence: ReviewedEvidence | None = None
        self.gate_observations: tuple[GateObservation, ...] = ()
        self.expected_observations: tuple[bytes, ...] = ()
        self.expected_policy: bytes | None = None
        self.committed_backtests: dict[tuple[str, str], tuple[dict, dict]] = {}
        self.projecting_backtests: set[tuple[str, str]] = set()
        self.gate_authorities: dict[str, tuple[tuple[str, str], ...]] = {}
        self.comparison_experiments: dict[str, ExperimentHandoff] = {}
        self.experiment_commit_confirmed = False
        self.pending_backtest_publication: tuple[Any, dict] | None = None
        self.published_run_id: str | None = None

    def _review(self, source: _Source) -> AcceptedReview:
        self.job.check()
        pin = source.pin
        review = self.job.control.rights.resolve_current(actor_id=self.scope.actor_id,
            account_alias=self.scope.account_alias, environment=self.scope.environment,
            collection_id=self.scope.collection_id, snapshot_id=self.scope.snapshot_id,
            evidence_id=pin["evidenceId"], artifact_digest=pin["artifactSha256"], original_bytes=source.evidence_bytes,
            purpose="research", reference_ns=self.reference_ns, authorization=self.job.authorization, expected_pin=pin)
        if type(review) is not AcceptedReview:
            raise AdapterUnavailable("paper-lab-current-source-review-unavailable")
        # Resolve actual review author separately; AcceptedReview.actor_id above
        # is the consuming actor and MUST NOT be substituted for this identity.
        response = self.job.control.artifacts.call("acceptedEvidence", collectionId=self.scope.collection_id, evidenceId=pin["evidenceId"])
        current = response["review"]
        if (current["reviewId"] != pin["reviewId"] or current["reviewVersion"] != pin["reviewVersion"]
                or current["artifactId"] != pin["artifactId"] or current["artifactSha256"] != pin["artifactSha256"]
                or current["decision"] != "accepted" or current["purpose"] != "research"
                or (current["accountAlias"], current["environment"], current["collectionId"]) !=
                    (self.scope.account_alias, self.scope.environment, self.scope.collection_id)
                or response["artifact"]["artifactId"] != pin["artifactId"]
                or response["artifact"]["artifactSha256"] != pin["artifactSha256"]
                or response["rights"]["policyId"] != pin["rightsPolicyId"]
                or response["rights"]["version"] != pin["rightsVersion"]
                or self.codec.epoch_ns(current["reviewedAt"]) > self.job.clock.now_ns()
                or self.codec.epoch_ns(current["expiresAt"]) <= self.job.clock.now_ns()
                or self.codec.encode(response["evidence"]) != source.evidence_bytes):
            raise AdapterUnavailable("paper-lab-current-review-changed")
        identity(current["actorId"])
        self.reviewers[source.name] = current["actorId"]
        self.reviews[source.name] = review
        return review

    def load(self, name: str, value: Any) -> None:
        identity(name)
        if name in self.sources:
            raise AdapterUnavailable("paper-lab-duplicate-input-name")
        row = _record(value, {"binding", "review"})
        ref, pin = _ref(row["binding"]), _record(row["review"], REVIEW_FIELDS)
        for key, value in pin.items():
            (digest_text if key == "artifactSha256" else identity)(value)
        evidence_raw = self.job.artifact({"artifactId": pin["artifactId"], "sha256": pin["artifactSha256"]}, collection_id=self.scope.collection_id)
        evidence = public_record(evidence_raw, "ResearchEvidence", codec=self.codec, validator=self.codec)
        if (pin["collectionId"] != self.scope.collection_id or evidence["collectionId"] != self.scope.collection_id
                or evidence["snapshotId"] != self.scope.snapshot_id or evidence["evidenceId"] != pin["evidenceId"]
                or evidence["rightsPolicyId"] != pin["rightsPolicyId"] or evidence["contentHash"] != ref["sha256"]):
            raise AdapterUnavailable("paper-lab-source-original-binding")
        raw = self.job.artifact(ref, collection_id=self.scope.collection_id)
        source = _Source(name, ref, pin, raw, evidence_raw, evidence)
        self.sources[name] = source
        self._review(source)

    def source(self, name: str) -> _Source:
        identity(name)
        if name not in self.sources:
            raise AdapterUnavailable("paper-lab-required-input-unavailable")
        self.used.add(name)
        return self.sources[name]

    def reviewed(self, name: str) -> ReviewedEvidence:
        source = self.source(name)
        return ReviewedEvidence(source.evidence_bytes, source.pin["artifactSha256"], self._review(source))

    def refresh(self) -> None:
        for relative in SOURCE_PATHS:
            if sha256((self.source_root / relative).read_bytes()).hexdigest() != self.source_hashes[relative]:
                raise AdapterUnavailable("paper-lab-reviewed-implementation-changed")
        for source in self.sources.values():
            original = self.job.control.artifacts.read(artifact_id=source.reference["artifactId"],
                expected_digest=source.reference["sha256"], collection_id=self.scope.collection_id)
            if original != source.raw:
                raise AdapterUnavailable("paper-lab-source-bytes-changed")
            self._review(source)
        if self.committed is not None:
            current = self._read_committed_bytes(self.committed.experiment_id, self.committed.content_hash)
            if current != self.committed.canonical_bytes:
                raise AdapterUnavailable("paper-lab-committed-experiment-changed")
        for fields, expected in self.committed_backtests.values():
            current = self.job.control.artifacts.read_backtest_run(**fields)
            if current != expected:
                raise AdapterUnavailable("paper-lab-committed-backtest-source-changed")
        for handoff in self.comparison_experiments.values():
            if self._read_committed_bytes(handoff.experiment_id, handoff.content_hash) != handoff.canonical_bytes:
                raise AdapterUnavailable("paper-lab-cost-comparison-experiment-changed")

    def committed_backtest(self, sources: dict[str, _Source], *, experiment: ExperimentHandoff) -> str:
        """Actual prior experiment publication + committed producer, never stage fallback."""
        run, results, recipe, receipt, isolation = (sources[key] for key in ("run", "results", "recipe", "receipt", "isolation"))
        original_recipe = original_record(recipe.raw, codec=self.codec)
        planned = _ref(original_recipe["run"])
        def worker_ref(reference):
            return {"artifactId": reference["artifactId"], "artifactSha256": reference["sha256"]}
        fields = {"collection_id": self.scope.collection_id, "artifact": worker_ref(run.reference),
            "planned_run": worker_ref(planned), "results": worker_ref(results.reference), "recipe": worker_ref(recipe.reference)}
        if experiment != self.committed and experiment != self.comparison_experiments.get(experiment.experiment_id):
            raise AdapterUnavailable("paper-lab-precommitted-experiment-original-required")
        fields["experiment"] = {"experimentId": experiment.experiment_id,
            "artifact": {"artifactId": "experiment-" + self.codec.digest({
                "collectionId": self.scope.collection_id, "experimentId": experiment.experiment_id}),
                "artifactSha256": experiment.content_hash}}
        proof = self.job.control.artifacts.read_backtest_run(**fields)
        if (_bytes(proof["contentBase64"], maximum=700_000) != run.raw
                or proof["artifact"] != fields["artifact"]
                or proof["contentSha256"] != run.reference["sha256"]
                or proof["canonicalSha256"] != run.reference["sha256"]
                or proof["collectionId"] != self.scope.collection_id
                or proof["plannedRun"] != fields["planned_run"] or proof["results"] != fields["results"]
                or proof["recipe"] != fields["recipe"]
                or proof["receipt"] != worker_ref(receipt.reference)
                or proof["isolation"] != worker_ref(isolation.reference)
                or ("experiment" in proof) != ("experiment" in fields)
                or proof.get("experiment") != fields.get("experiment")
                or proof["jobId"] == self.job.lease["jobId"]):
            raise AdapterUnavailable("paper-lab-completed-run-original-graph-mismatch")
        identity(proof["jobId"])
        cache_key = (run.name, experiment.content_hash)
        previous = self.committed_backtests.get(cache_key)
        if previous is not None and previous != (fields, proof):
            raise AdapterUnavailable("paper-lab-completed-run-producer-changed")
        self.committed_backtests[cache_key] = (fields, proof)
        self.projecting_backtests.add(cache_key)
        return proof["jobId"]

    def _read_committed_bytes(self, experiment_id: str, digest: str) -> bytes:
        """Dedicated committed reader capability; no writer or stage fallback."""
        identity(experiment_id)
        digest_text(digest)
        artifact_id = "experiment-" + self.codec.digest({
            "collectionId": self.scope.collection_id, "experimentId": experiment_id})
        return self.job.control.artifacts.read_experiment(experiment_id=experiment_id,
            artifact_id=artifact_id, expected_digest=digest, collection_id=self.scope.collection_id,
            deadline_ns=self.job.deadline, cancellation=self.job.cancel)

    def read_committed(self, experiment_id: str, digest: str) -> ExperimentHandoff:
        identity(experiment_id)
        digest_text(digest)
        raw = self._read_committed_bytes(experiment_id, digest)
        if len(raw) > 700_000 or self.job.input_bytes + len(raw) > 16_000_000:
            raise AdapterUnavailable("paper-lab-committed-input-budget")
        self.job.input_bytes += len(raw)
        self.committed = _handoff(raw, self.codec)
        return self.committed

    def comparison_experiment(self, source: _Source) -> ExperimentHandoff:
        """A current review alone cannot establish immutable experiment commit."""
        handoff = _handoff(source.raw, self.codec)
        raw = self._read_committed_bytes(handoff.experiment_id, handoff.content_hash)
        if raw != source.raw:
            raise AdapterUnavailable("paper-lab-cost-comparison-committed-original-mismatch")
        previous = self.comparison_experiments.get(handoff.experiment_id)
        if previous is not None and previous != handoff:
            raise AdapterUnavailable("paper-lab-cost-comparison-experiment-identity-conflict")
        self.comparison_experiments[handoff.experiment_id] = handoff
        return handoff

    def gate_authority(self, observation: bytes, policy: GatePolicy) -> bool:
        """Only source-derived observations with refreshed server proofs qualify.

        The dedicated read already checks original publishedAt <= planned record
        < producer admission and all immutable scientific joins/current authority.
        Its result is NOT replaced by registeredAt, a boolean, or a supplied time.
        """
        row = original_record(observation, codec=self.codec)
        keys = self.gate_authorities.get(sha256(observation).hexdigest(), ())
        required = {"out-of-sample": 1, "stress": 1, "reproducible-backtest": 2, "cost-sensitivity": 2}
        if row["gate"] not in required or len(keys) != required[row["gate"]]:
            return False
        handoffs = {h.content_hash: h for h in self.comparison_experiments.values()}
        if self.committed is not None:
            handoffs[self.committed.content_hash] = self.committed
        producers = set()
        for key in keys:
            item, handoff = self.committed_backtests.get(key), handoffs.get(key[1])
            if item is None or handoff is None:
                return False
            fields, proof = item
            if (fields.get("experiment") != proof.get("experiment")
                    or proof.get("experiment", {}).get("experimentId") != handoff.experiment_id
                    or proof.get("experiment", {}).get("artifact", {}).get("artifactSha256") != handoff.content_hash
                    or committed_policy_rules(policy, handoff.canonical_bytes, codec=self.codec) != policy.rules_hash):
                return False
            producers.add(proof["jobId"])
        return len(producers) == required[row["gate"]]

    def claim_request(self, raw: bytes) -> PaperClaimMapRequest:
        row = _record(original_record(raw, codec=self.codec), {"profile", "mapping_id", "revision", "hypothesis_id",
            "hypothesis_revision", "statement", "falsification", "assumptions", "created_at", "claims"})
        if row["profile"] != "vertex-paper-claim-request-v1" or type(row["claims"]) is not list or not 1 <= len(row["claims"]) <= 64:
            raise AdapterUnavailable("paper-lab-claim-request-profile")
        claims = []
        for value in row["claims"]:
            c = _record(value, {"input", "claim_id", "page_number", "normalized_start", "quote", "statement", "rights_receipt_id", "paper", "metadata_base64"})
            source = self.source(c["input"])
            paper = _record(c["paper"], {"ssrn_id", "version_id", "title", "authors", "doi", "published_at", "captured_at", "media_type", "rights_policy_id"})
            supplied = PaperInput(**{**paper, "authors": tuple(paper["authors"])}, data=source.raw, expected_digest=source.reference["sha256"])
            e = source.evidence
            metadata = _bytes(c["metadata_base64"], 64_000)
            prepared = SourceInput(e["sourceIdentity"]["sourceId"], e["sourceUri"], e["attribution"], e["capturedAt"], e["publishedAt"],
                source.raw, (Segment(e["sourceLocator"], e["claim"], e["method"]),), e["rightsPolicyId"], "paper", "not-applicable", "paper",
                None, tuple(e["limitations"]), metadata, source.reference["sha256"])
            claims.append(PaperClaim(supplied, prepared, self.reviewed(c["input"]), c["claim_id"], c["page_number"],
                c["normalized_start"], c["quote"], c["statement"], c["rights_receipt_id"]))
        self.spec = PaperClaimMapRequest(row["mapping_id"], row["revision"], row["hypothesis_id"], row["hypothesis_revision"],
            row["statement"], row["falsification"], tuple(row["assumptions"]), parse_time(row["created_at"]), tuple(claims))
        return self.spec

    def _claim_semantics(self, binding: dict, originals: tuple[bytes, ...]) -> bool:
        if self.spec is None:
            return False
        spec = self.spec
        actual = binding.get("mapping")
        projected = [_claim_record(c, scope=self.scope, as_of=self.as_of, codec=self.codec, validator=self.codec) for c in spec.claims]
        records = [item[0] for item in projected]
        expected = {"format": "vertex-reviewed-paper-claim-map-v1", "mappingId": spec.mapping_id, "revision": spec.revision,
            "scope": {"actorId": self.scope.actor_id, "accountAlias": self.scope.account_alias, "environment": self.scope.environment,
                      "collectionId": self.scope.collection_id, "snapshotId": self.scope.snapshot_id},
            "hypothesis": {"id": spec.hypothesis_id, "revision": spec.hypothesis_revision, "statement": spec.statement,
                "falsification": spec.falsification, "assumptions": list(spec.assumptions), "createdAt": timestamp(spec.created_at)},
            "claims": records, "executionAuthority": "none"}
        encoded, digest = encode_authoritatively(expected, self.codec)
        expected_originals = (*tuple(dict.fromkeys(raw for item in projected for raw in item[2])), encoded)
        return (set(binding) == {"mapping", "mappingHash", "currentReviews"}
                and actual == expected and binding.get("mappingHash") == digest
                and binding.get("currentReviews") == [item[1] for item in projected]
                and originals == expected_originals
                and (self.expected_mapping is None or encoded == self.expected_mapping))

    def verify(self, request: LabVerificationRequest) -> LabVerificationReceipt | None:
        """Current originals are independently read before any exact-True receipt."""
        self.refresh()
        row = _record(original_record(request.canonical_bytes, codec=self.codec),
            {"format", "purpose", "verifier", "scope", "asOf", "originalHashes", "binding"})
        if (sha256(request.canonical_bytes).hexdigest() != request.request_hash
                or row.get("format") != "vertex-lab-verification-v1" or row.get("purpose") != request.purpose
                or row.get("verifier") != asdict(self.pin) or row.get("scope") != asdict(self.scope)
                or row.get("asOf") != timestamp(self.as_of)
                or row.get("originalHashes") != [sha256(raw).hexdigest() for raw in request.originals]):
            return None
        b = row["binding"]
        if request.purpose == "paper-claim-map":
            verified = self._claim_semantics(b, request.originals)
        elif request.purpose == "paper-experiment":
            verified = (set(b) == {"experimentHash", "mappingHash", "costModelHash", "mappingReceipt"}
                and self.expected_handoff is not None and self.expected_mapping is not None
                and self.strategy_original is not None and self.last_claim_receipt is not None
                and b.get("experimentHash") == sha256(self.expected_handoff).hexdigest()
                and b.get("mappingHash") == sha256(self.expected_mapping).hexdigest()
                and b.get("costModelHash") == self.codec.digest(original_record(self.strategy_original, codec=self.codec)["costModel"])
                and b.get("mappingReceipt") == receipt_record(self.last_claim_receipt)
                and request.originals == (self.expected_mapping, self.expected_handoff, self.strategy_original))
        elif request.purpose == "experiment-backtest":
            verified = False
            if self.committed is not None and self.backtest is not None and self.strategy_original is not None:
                candidate, expected = backtest_candidates(self.committed, self.backtest,
                    public_record(self.strategy_original, "StrategySpec", codec=self.codec, validator=self.codec), self.codec)
                run_bytes, _ = encode_authoritatively(candidate, self.codec)
                binding_bytes, binding_hash = encode_authoritatively(expected, self.codec)
                verified = (set(b) == {"binding", "bindingHash"} and b.get("bindingHash") == binding_hash
                    and self.codec.encode(b.get("binding")) == binding_bytes
                    and request.originals == (self.committed.canonical_bytes, self.strategy_original,
                        *self.backtest_dataset_originals, self.backtest.model_bytes,
                        self.backtest.publication_bytes, run_bytes, binding_bytes))
        elif request.purpose == "experiment-gates":
            verified = False
            if self.committed is not None and self.expected_policy is not None and self.gate_policy_evidence is not None:
                policy = _policy(self.expected_policy, self.codec)
                reviews = [evidence_record(item, scope=self.scope, as_of=self.as_of,
                    codec=self.codec, validator=self.codec)[1]
                    for item in (self.gate_policy_evidence, *(o.evidence for o in self.gate_observations))]
                expected_originals = (self.committed.canonical_bytes, self.expected_policy, self.gate_policy_evidence.original_bytes,
                    *(raw for o in self.gate_observations for raw in
                        (o.observation_bytes, o.provenance_bytes, o.evidence.original_bytes)))
                verified = (set(b) == {"experimentId", "experimentHash", "policyHash", "policyRulesHash",
                        "policy", "observations", "currentReviews"}
                    and b.get("experimentId") == self.committed.experiment_id
                    and b.get("experimentHash") == self.committed.content_hash
                    and b.get("policyHash") == sha256(self.expected_policy).hexdigest()
                    and b.get("policy") == original_record(self.expected_policy, codec=self.codec)
                    and b.get("policyRulesHash") == policy.rules_hash
                    and committed_policy_rules(policy, self.committed.canonical_bytes, codec=self.codec) == policy.rules_hash
                    and all(self.gate_authority(raw, policy) for raw in self.expected_observations)
                    and b.get("currentReviews") == reviews
                    and b.get("observations") == [{"observation": original_record(raw, codec=self.codec),
                        "observationHash": sha256(raw).hexdigest(), "evidenceHash": self._observation_evidence_hash(raw)}
                        for raw in self.expected_observations]
                    and request.originals == expected_originals)
        else:
            verified = False
        if verified is not True:
            return None
        self.job.check()
        expires = min(self.job.deadline, self.codec.epoch_ns(self.job.lease["leaseExpiresAt"]),
            self.codec.epoch_ns(self.job.selection["expiresAt"]),
            *(min(r.expires_ns, r.rights_valid_until_ns) for r in self.reviews.values()))
        if expires // 1000 * 1000 <= self.job.clock.now_ns():
            return None
        receipt = LabVerificationReceipt(self.pin, request.request_hash, self.as_of, _at(expires), True)
        if request.purpose == "paper-claim-map":
            self.last_claim_receipt = receipt
        return receipt

    def _observation_evidence_hash(self, raw: bytes) -> str:
        matches = [source for source in self.sources.values() if source.raw == raw]
        if len(matches) != 1:
            raise AdapterUnavailable("paper-lab-observation-source-ambiguous")
        return matches[0].pin["artifactSha256"]


def _options(verifier: CurrentPaperLabVerifier) -> dict:
    return {"scope": verifier.scope, "as_of": verifier.as_of, "codec": verifier.codec,
            "validator": verifier.codec, "verifier": verifier, "verifier_pin": verifier.pin}


def _cost_projection(verifier: CurrentPaperLabVerifier, source: _Source, projection: dict,
                     handoff: ExperimentHandoff, policy: GatePolicy) -> tuple[bytes | Unavailable, list[_Source]]:
    """Current original reviews + dedicated experiment/completed-producer reads."""
    _record(projection, COST_FIELDS)
    def selected(value):
        pin = _record(value, {"input", "sha256"})
        original = verifier.source(pin["input"])
        if original.reference["sha256"] != pin["sha256"]:
            raise AdapterUnavailable("paper-lab-cost-comparison-original-pin-mismatch")
        return original
    method = verifier.source(projection["methodInput"])
    extras = {key: selected(projection[key]) for key in
        ("baselineExperiment", "variantExperiment", "baselineStrategy", "variantStrategy")}
    baseline_handoff = verifier.comparison_experiment(extras["baselineExperiment"])
    variant_handoff = verifier.comparison_experiment(extras["variantExperiment"])
    if (baseline_handoff != handoff or baseline_handoff.experiment_id == variant_handoff.experiment_id
            or baseline_handoff.content_hash == variant_handoff.content_hash):
        raise AdapterUnavailable("paper-lab-cost-comparison-distinct-committed-experiments-required")
    for original in (baseline_handoff, variant_handoff):
        if isinstance(committed_policy_rules(policy, original.canonical_bytes, codec=verifier.codec), Unavailable):
            return Unavailable(("cost-comparison-original-gate-rules-precommitment-unavailable",)), []
    method_record = original_record(method.raw, codec=verifier.codec)
    _method_rules(verifier, policy, "cost-sensitivity", method_record)
    groups = []
    for label in ("baseline", "variant"):
        selection = _record(projection[label], set(REPRODUCTION_ROLES))
        groups.append({role: selected(selection[role]) for role in REPRODUCTION_ROLES})
    selected_sources = [source, method, *extras.values(), *(s for group in groups for s in group.values())]
    if (len({s.reference["artifactId"] for s in selected_sources}) != len(selected_sources)
            or len({verifier.committed_backtest(group, experiment=original)
                for group, original in zip(groups, (baseline_handoff, variant_handoff), strict=True)}) != 2):
        raise AdapterUnavailable("paper-lab-cost-comparison-independent-originals-producers-required")
    projected = project_cost_observation(source.raw, method_bytes=method.raw,
        baseline_handoff_bytes=baseline_handoff.canonical_bytes, variant_handoff_bytes=variant_handoff.canonical_bytes,
        baseline_strategy_bytes=extras["baselineStrategy"].raw, variant_strategy_bytes=extras["variantStrategy"].raw,
        baseline={k: s.raw for k, s in groups[0].items()}, variant={k: s.raw for k, s in groups[1].items()},
        projection_artifact_id=source.reference["artifactId"], codec=verifier.codec, validator=verifier.codec)
    if isinstance(projected, Unavailable):
        return projected, selected_sources
    criteria = {c.criterion_id: c for c in policy.criteria if c.gate == "cost-sensitivity"}
    for metric in method_record["metrics"]:
        criterion = criteria.get(metric["criterionId"])
        if (criterion is None or criterion.criterion.operator != metric["operator"]
                or criterion.criterion.threshold != metric["threshold"]):
            raise AdapterUnavailable("paper-lab-cost-comparison-policy-direction-threshold-mismatch")
    return projected, selected_sources


def _stress_projection(verifier: CurrentPaperLabVerifier, source: _Source, projection: dict,
                       handoff: ExperimentHandoff, policy: GatePolicy) -> tuple[bytes | Unavailable, list[_Source]]:
    """Current original reviews and server-proven pre-evaluation experiment commit."""
    _record(projection, STRESS_FIELDS)
    if verifier.committed != handoff:
        raise AdapterUnavailable("paper-lab-stress-committed-experiment-required")
    def selected(value):
        pin = _record(value, {"input", "sha256"})
        original = verifier.source(pin["input"])
        if original.reference["sha256"] != pin["sha256"]:
            raise AdapterUnavailable("paper-lab-stress-original-pin-mismatch")
        return original
    method = verifier.source(projection["methodInput"])
    selection = _record(projection["source"], set(REPRODUCTION_ROLES))
    originals = {role: selected(selection[role]) for role in REPRODUCTION_ROLES}
    manifest, content = (selected(projection[key]) for key in ("manifest", "content"))
    selected_sources = [source, method, manifest, content, *originals.values()]
    if len({s.reference["artifactId"] for s in selected_sources}) != len(selected_sources):
        raise AdapterUnavailable("paper-lab-stress-distinct-original-roles-required")
    verifier.committed_backtest(originals, experiment=handoff)
    method_record = original_record(method.raw, codec=verifier.codec)
    _method_rules(verifier, policy, "stress", method_record)
    manifest_record = public_record(manifest.raw, "DatasetManifest", codec=verifier.codec, validator=verifier.codec)
    recipe_record = original_record(originals["recipe"].raw, codec=verifier.codec)
    # Direct observed-source only. The rule-only method contains no result,
    # dataset or capture pins; exact post-run inputs are separately joined.
    if (len(recipe_record["datasets"]) != 1 or len(manifest_record["sources"]) != 1
            or manifest.reference != recipe_record["datasets"][0]["manifest"]
            or content.reference != recipe_record["datasets"][0]["content"]
            or content.evidence["sourceType"] != "dataset"
            or content.evidence["sourceIdentity"] != manifest_record["sources"][0]
            or content.evidence["rightsPolicyId"] != manifest_record["entitlementPolicyId"]
            or manifest.evidence["rightsPolicyId"] != manifest_record["entitlementPolicyId"]
            or verifier.codec.epoch_ns(content.evidence["capturedAt"]) != verifier.codec.epoch_ns(manifest_record["captureTime"])):
        raise AdapterUnavailable("paper-lab-stress-original-market-capture-provenance-mismatch")
    projected = project_historical_stress_observation(source.raw, method_bytes=method.raw,
        handoff_bytes=handoff.canonical_bytes, originals={key: value.raw for key, value in originals.items()},
        manifest_bytes=manifest.raw, content_bytes=content.raw,
        projection_artifact_id=source.reference["artifactId"], codec=verifier.codec, validator=verifier.codec)
    if isinstance(projected, Unavailable):
        return projected, selected_sources
    metric = method_record["performance"]
    criteria = [criterion for criterion in policy.criteria if criterion.gate == "stress"]
    if (len(criteria) != 1 or criteria[0].criterion_id != metric["criterionId"]
            or criteria[0].criterion.operator != metric["operator"]
            or criteria[0].criterion.threshold != metric["threshold"]):
        raise AdapterUnavailable("paper-lab-stress-explicit-net-pnl-policy-mismatch")
    return projected, selected_sources


def _method_rules(verifier: CurrentPaperLabVerifier, policy: GatePolicy, gate: str, original: dict) -> None:
    pin = gate_method_rule_pin(gate, original, codec=verifier.codec)
    criteria = [c for c in policy.criteria if c.gate == gate]
    if not criteria or any(c.rule_method != pin for c in criteria):
        raise AdapterUnavailable("paper-lab-original-method-rules-differ-from-frozen-policy")


def _projection(verifier: CurrentPaperLabVerifier, name: str, handoff: ExperimentHandoff,
                policy: GatePolicy) -> bytes | Unavailable:
    source = verifier.source(name)
    projection = original_record(source.raw, codec=verifier.codec)
    if projection.get("reviewerId") != verifier.reviewers[name]:
        raise AdapterUnavailable("paper-lab-projection-actual-review-author-mismatch")
    verifier.projecting_backtests = set()
    if projection.get("profile") == "vertex-backtest-oos-projection-v1":
        return Unavailable(("oos-v1-prior-publication-proof-unavailable",))
    elif projection.get("profile") == OOS_PRECOMMITTED_PROFILE:
        _record(projection, OOS_PRECOMMITTED_FIELDS)
        _method_rules(verifier, policy, "out-of-sample", projection)
        roles = {"run": "runInput", "results": "resultsInput", "mapping": "mappingInput",
                 "recipe": "recipeInput", "receipt": "receiptInput", "isolation": "isolationInput"}
        group = {role: verifier.source(projection[key]) for role, key in roles.items()}
        lineage = verifier.source(projection["lineageInput"])
        run, results, mapping = (group[key] for key in ("run", "results", "mapping"))
        selected_sources = [source, lineage, *group.values()]
        if len({s.reference["artifactId"] for s in selected_sources}) != len(selected_sources):
            raise AdapterUnavailable("paper-lab-oos-distinct-original-roles-required")
        verifier.committed_backtest(group, experiment=handoff)
        projected = project_oos_observation(source.raw, handoff_bytes=handoff.canonical_bytes,
            run_bytes=run.raw, results_bytes=results.raw, lineage_bytes=lineage.raw, mapping_bytes=mapping.raw,
            results_artifact_id=results.reference["artifactId"], codec=verifier.codec, validator=verifier.codec)
    elif projection.get("profile") == REPRODUCTION_PROFILE:
        _record(projection, REPRODUCTION_FIELDS)
        method = verifier.source(projection["methodInput"])
        method_record = original_record(method.raw, codec=verifier.codec)
        _method_rules(verifier, policy, "reproducible-backtest", method_record)
        groups = []
        for key in ("baseline", "repeat"):
            selection = _record(projection[key], set(REPRODUCTION_ROLES))
            group = {}
            for role in REPRODUCTION_ROLES:
                pin = _record(selection[role], {"input", "sha256"})
                group[role] = verifier.source(pin["input"])
                if group[role].reference["sha256"] != pin["sha256"]:
                    raise AdapterUnavailable("paper-lab-reproduction-original-pin-mismatch")
            groups.append(group)
        if (len({item.reference["artifactId"] for group in groups for item in group.values()}) != 2 * len(REPRODUCTION_ROLES)
                or len({verifier.committed_backtest(group, experiment=handoff) for group in groups}) != 2):
            raise AdapterUnavailable("paper-lab-reproduction-independent-producers-required")
        projected = project_reproduction_observation(source.raw, method_bytes=method.raw,
            handoff_bytes=handoff.canonical_bytes, baseline={k: s.raw for k, s in groups[0].items()},
            repeat={k: s.raw for k, s in groups[1].items()}, projection_artifact_id=source.reference["artifactId"],
            codec=verifier.codec, validator=verifier.codec)
        criteria = {c.criterion_id: c for c in policy.criteria if c.gate == "reproducible-backtest"}
        for metric in method_record["metrics"]:
            criterion = criteria.get(metric["criterionId"])
            if (criterion is None or criterion.criterion.operator != "lte"
                    or criterion.criterion.threshold != metric["maximumAbsoluteDifference"]):
                raise AdapterUnavailable("paper-lab-reproduction-policy-tolerance-mismatch")
        selected_sources = [source, method, *(s for group in groups for s in group.values())]
    elif projection.get("profile") == COST_PROFILE:
        projected, selected_sources = _cost_projection(verifier, source, projection, handoff, policy)
    elif projection.get("profile") == STRESS_PROFILE:
        return Unavailable(("historical-midpoint-stress-v1-precommitment-unavailable",))
    elif projection.get("profile") == STRESS_PRECOMMITTED_PROFILE:
        projected, selected_sources = _stress_projection(verifier, source, projection, handoff, policy)
    else:
        return Unavailable(("unsupported-gate-source-projection",))
    if isinstance(projected, Unavailable):
        return projected
    record = original_record(projected, codec=verifier.codec)
    criteria = [c for c in policy.criteria if c.gate == record["gate"]]
    if (record["policyHash"] != verifier.codec.digest(policy.record())
            or not criteria or record["window"] != criteria[0].record()["window"]
            or record["method"] != asdict(criteria[0].method)
            or {(m["criterionId"], m["metricId"], m["unit"]) for m in record["metrics"]}
            != {(c.criterion_id, c.criterion.metric_id, c.unit) for c in criteria}):
        raise AdapterUnavailable("paper-lab-projection-declared-policy-measurements-mismatch")
    # Current review admits sources; it never removes their original limitations.
    # Keep these in the deterministic proposal as well as subsequent admission.
    record["limitations"] = list(dict.fromkeys((*record["limitations"],
        *(s.name + ": " + limitation for s in selected_sources for limitation in s.evidence["limitations"]))))
    if len(record["limitations"]) > 64 or any(len(item) > 4000 for item in record["limitations"]):
        return Unavailable(("paper-lab-original-source-limitations-exceed-bound",))
    encoded = encode_authoritatively(record, verifier.codec)[0]
    verifier.gate_authorities[sha256(encoded).hexdigest()] = tuple(sorted(verifier.projecting_backtests))
    if not verifier.gate_authority(encoded, policy):
        return Unavailable(("paper-lab-original-gate-rule-publication-proof-unavailable",))
    return encoded


def _operation(verifier: CurrentPaperLabVerifier) -> tuple[bytes, dict] | Unavailable:
    job, recipe, codec = verifier.job, verifier.recipe, verifier.codec
    request_source = verifier.source("request")
    request = original_record(request_source.raw, codec=codec)
    operation = recipe["operation"]
    if operation == "map-claims":
        spec = verifier.claim_request(request_source.raw)
        mapped = map_reviewed_claims(spec, **_options(verifier))
        if isinstance(mapped, Unavailable):
            return mapped
        return mapped.mapping_bytes, {"operationStatus": "claim-map-proposed", "mappingSha256": mapped.mapping_hash}
    if operation == "freeze-experiment":
        request = _record(request, {"profile", "claim_request_input", "mapping_input", "handoff_input", "strategy_input", "dataset_inputs"})
        if request["profile"] != "vertex-paper-experiment-request-v1":
            raise AdapterUnavailable("paper-lab-freeze-profile")
        claim_source = verifier.source(request["claim_request_input"])
        mapping_source = verifier.source(request["mapping_input"])
        prepared = verifier.source(request["handoff_input"])
        strategy = verifier.source(request["strategy_input"])
        verifier.strategy_original = strategy.raw
        spec = verifier.claim_request(claim_source.raw)
        verifier.expected_mapping, verifier.expected_handoff = mapping_source.raw, prepared.raw
        experiment = _experiment(prepared.raw, strategy.raw, codec)
        manifests = [verifier.source(name) for name in request["dataset_inputs"]]
        actual = {sha256(s.raw).hexdigest(): public_record(s.raw, "DatasetManifest", codec=codec, validator=codec) for s in manifests}
        if len(actual) != len(manifests) or set(actual) != {d.manifest_hash for d in experiment.datasets}:
            raise AdapterUnavailable("paper-lab-experiment-dataset-coverage")
        for frozen in experiment.datasets:
            manifest = actual[frozen.manifest_hash]
            if (manifest["datasetId"] != frozen.dataset_id or codec.epoch_ns(manifest["captureTime"]) != codec.epoch_ns(timestamp(frozen.available_at))
                    or codec.epoch_ns(manifest["asOfAt"]) != codec.epoch_ns(timestamp(frozen.knowledge_cutoff))
                    or any(s["snapshotId"] != frozen.snapshot_id for s in manifest["sources"])):
                raise AdapterUnavailable("paper-lab-frozen-dataset-original-mismatch")
        plan = plan_mapped_experiment(spec, experiment, expected_mapping_hash=mapping_source.reference["sha256"], **_options(verifier))
        if isinstance(plan, Unavailable):
            return plan
        if plan.handoff.canonical_bytes != prepared.raw or plan.mapping.mapping_bytes != mapping_source.raw:
            raise AdapterUnavailable("paper-lab-freeze-original-byte-mismatch")
        # Only the map's real digest is referenced by original citation locators.
        # Routing/request wrappers are never smuggled into source-review authority.
        # Generic dependencies are still checked separately by publishExperiment.
        verifier.refresh()
        pins = recipe["dependency_pins"]
        hashes = {plan.handoff.strategy_hash, *plan.handoff.dataset_hashes,
                  *(c.artifact_hash for c in experiment.hypothesis.citations)}
        if (len({pin["artifactId"] for pin in pins}) != len(pins)
                or len({pin["artifactSha256"] for pin in pins}) != len(pins)
                or {pin["artifactSha256"] for pin in pins} != hashes):
            raise AdapterUnavailable("paper-lab-freeze-dependency-pin-coverage")
        for pin in pins:
            if codec.validate("WorkerExperimentDependencyPin", pin, "1.0.0") is not True:
                raise AdapterUnavailable("paper-lab-freeze-dependency-pin-invalid")
        if verifier.used != set(verifier.sources):
            raise AdapterUnavailable("paper-lab-unused-or-unbound-input")
        store = ControlImmutableExperimentStore(job.control.artifacts, dependency_pins=pins,
            source_review_pins=(mapping_source.pin,), deadline_ns=job.deadline, cancellation=job.cancel)
        digest = store_experiment(plan.handoff, store=store)
        if digest != plan.handoff.content_hash:
            return Unavailable(("paper-lab-experiment-commit-unconfirmed",))
        verifier.experiment_commit_confirmed = True
        verifier.committed = plan.handoff
        content, _ = encode_authoritatively({"format": "vertex-paper-experiment-result-v1",
            "experimentId": plan.handoff.experiment_id, "experimentHash": digest,
            "mappingHash": plan.mapping.mapping_hash, "costModelHash": plan.cost_model_hash,
            "executionAuthority": "none", "simulatedCapitalEntersNav": False}, codec)
        return content, {"operationStatus": "experiment-committed", "experimentId": plan.handoff.experiment_id,
                         "experimentHash": digest}
    if operation == "map-backtest":
        request_keys = {"profile", "experiment_id", "experiment_hash", "strategy_input", "dataset_inputs", "binding"}
        publish = "publication_binding_input" in request
        request = _record(request, request_keys | ({"publication_binding_input"} if publish else set()))
        if bool(recipe["dependency_pins"]) != publish:
            raise AdapterUnavailable("paper-lab-backtest-publication-dependencies-required")
        if request["profile"] != "vertex-paper-backtest-request-v1":
            raise AdapterUnavailable("paper-lab-backtest-request-profile")
        handoff = verifier.read_committed(request["experiment_id"], request["experiment_hash"])
        verifier.backtest = _backtest_binding(request["binding"])
        strategy = verifier.source(request["strategy_input"])
        manifests = tuple(verifier.source(name).raw for name in request["dataset_inputs"])
        verifier.strategy_original, verifier.backtest_dataset_originals = strategy.raw, manifests
        mapped = map_committed_experiment(handoff, verifier.backtest, strategy_bytes=strategy.raw,
            dataset_manifest_bytes=manifests, **_options(verifier))
        if isinstance(mapped, Unavailable):
            return mapped
        if publish:
            original_binding = verifier.source(request["publication_binding_input"])
            source = mapped.publication_source(handoff, reviewed_binding_bytes=original_binding.raw,
                binding_review=original_binding.pin, dependency_pins=tuple(recipe["dependency_pins"]), codec=codec)
            if (mapped.run_id in {s.pin["artifactId"] for s in verifier.sources.values()}
                    or mapped.run_id in {s.reference["artifactId"] for s in verifier.sources.values()}
                    or mapped.run_id == recipe["publication"]["evidenceId"]):
                raise AdapterUnavailable("paper-lab-backtest-output-identity-conflict")
            verifier.pending_backtest_publication = (mapped, source)
        content, _ = encode_authoritatively({"format": "vertex-paper-backtest-bundle-v1",
            "experimentId": handoff.experiment_id, "experimentHash": handoff.content_hash,
            "runSha256": mapped.run_hash, "runBase64": base64.b64encode(mapped.run_bytes).decode("ascii"),
            "bindingSha256": mapped.binding_hash, "bindingBase64": base64.b64encode(mapped.binding_bytes).decode("ascii"),
            "recipeReferences": mapped.recipe_references(), "executionAuthority": "none",
            "simulatedCapitalEntersNav": False}, codec)
        return content, {"operationStatus": "backtest-mapping-proposed", "runSha256": mapped.run_hash,
                         "bindingSha256": mapped.binding_hash, "runPublished": False, "backtestDispatched": False}
    request = _record(request, {"profile", "experiment_id", "experiment_hash", "policy_input", "observations"})
    if (request["profile"] != "vertex-paper-gate-request-v1" or type(request["observations"]) is not list
            or len(request["observations"]) > 4
            or (len(request["observations"]) != 1 and any(
                type(item) is dict and item.get("observation_input") is None for item in request["observations"]))):
        raise AdapterUnavailable("paper-lab-supported-gate-request-profile")
    handoff = verifier.read_committed(request["experiment_id"], request["experiment_hash"])
    policy_source = verifier.source(request["policy_input"])
    policy = _policy(policy_source.raw, codec)
    if policy.experiment_hash != handoff.content_hash:
        raise AdapterUnavailable("paper-lab-policy-frozen-experiment-mismatch")
    commitment = committed_policy_rules(policy, handoff.canonical_bytes, codec=codec)
    if isinstance(commitment, Unavailable):
        return commitment
    verifier.expected_policy = policy_source.raw
    verifier.gate_policy_evidence = verifier.reviewed(policy_source.name)
    observations = []
    for item in request["observations"]:
        item = _record(item, {"projection_input", "observation_input"})
        projected = _projection(verifier, item["projection_input"], handoff, policy)
        if isinstance(projected, Unavailable):
            return projected
        if original_record(projected, codec=codec)["policyHash"] != policy_source.reference["sha256"]:
            raise AdapterUnavailable("paper-lab-observation-policy-mismatch")
        if item["observation_input"] is None:
            # A first pass only proposes the exact source-derived measurement.
            # It must acquire its own current review before gate admission.
            return projected, {"operationStatus": "gate-observation-proposed", "gate": original_record(projected, codec=codec)["gate"],
                "missingGates": list(PROMOTION_GATES)}
        original = verifier.source(item["observation_input"])
        if original.raw != projected:
            raise AdapterUnavailable("paper-lab-observation-not-original-source-projection")
        record = original_record(original.raw, codec=codec)
        if record["gate"] not in {"out-of-sample", "reproducible-backtest", "cost-sensitivity", "stress"} or record["reviewerId"] != verifier.reviewers[original.name]:
            raise AdapterUnavailable("paper-lab-unsupported-or-unreviewed-gate-source")
        matches = [s for s in verifier.sources.values() if s.reference == {"artifactId": record["provenanceId"], "sha256": record["provenanceHash"]}]
        if len(matches) != 1:
            raise AdapterUnavailable("paper-lab-gate-original-provenance-unavailable")
        verifier.source(matches[0].name)
        observations.append(GateObservation(original.raw, matches[0].raw, verifier.reviewed(original.name)))
    verifier.expected_observations = tuple(o.observation_bytes for o in observations)
    verifier.gate_observations = tuple(observations)
    review = review_with_gate_evidence(handoff, policy, expected_policy_hash=policy_source.reference["sha256"],
        policy_evidence=verifier.gate_policy_evidence, observations=tuple(observations), **_options(verifier))
    if isinstance(review, Unavailable):
        return review
    # Current verification receipts intentionally remain invocation-local. Their
    # fresh resolvedAt/request hashes must not alter same-job immutable output.
    content, _ = encode_authoritatively({"format": "vertex-paper-gate-review-v1",
        "experimentId": handoff.experiment_id, "experimentHash": handoff.content_hash,
        "policyHash": policy_source.reference["sha256"],
        "observationHashes": [sha256(o.observation_bytes).hexdigest() for o in observations],
        "sourceReviewPins": [s.pin for s in verifier.sources.values()],
        "state": review.review.state, "missingGates": list(review.review.missing_gates),
        "rejectedGates": list(review.review.rejected_gates),
        "executionAuthority": "none", "requiresSeparateHumanApproval": True}, codec)
    return content, {"operationStatus": review.review.state, "missingGates": list(review.review.missing_gates),
        "rejectedGates": list(review.review.rejected_gates),
        "unavailableGateSources": ["walk-forward", "forward-paper"]}


def _selected(job: Any, reference: dict, contract: str) -> None:
    matches = [entry for entry in job.selection["artifacts"] if entry["artifact"]["artifactId"] == reference["artifactId"]]
    if (len(matches) != 1 or matches[0]["role"] != "tool-config"
            or matches[0]["artifact"]["artifactSha256"] != reference["sha256"]
            or matches[0]["artifact"]["contractName"] != contract or matches[0]["artifact"]["schemaVersion"] != "1.0.0"):
        raise AdapterUnavailable("paper-lab-selected-private-reference")


def run_paper_lab(job: Any, payload: Any) -> dict:
    row = _record(payload, {"profile", "recipe", "recipeArtifactId", "recipeSha256", "implementation",
        "run_id", "trace_id", "actor_id", "task_contract", "account_alias", "environment", "input_evidence_ids"})
    recipe = _record(row["recipe"], RECIPE_FIELDS)
    if (row["profile"] != "vertex-paper-lab-job-v1" or recipe["profile"] != "vertex-paper-lab-recipe-v1"
            or recipe["operation"] not in OPERATIONS or row["environment"] != "research"):
        raise AdapterUnavailable("paper-lab-profile-unavailable")
    for key in ("run_id", "trace_id", "actor_id", "task_contract", "account_alias", "recipeArtifactId"):
        identity(row[key])
    for key in ("module_id", "task_contract", "collection_id", "snapshot_id"):
        identity(recipe[key])
    job.check()
    if (job.lease["kind"] != "research-run" or job.context.contracts.digest(row) != job.lease["payloadSha256"]
            or (row["actor_id"], row["account_alias"], row["environment"])
            != (job.lease["researchPrincipalId"], job.lease["accountAlias"], job.lease["environment"])
            or recipe["task_contract"] != row["task_contract"]
            or job.context.contracts.digest(recipe) != row["recipeSha256"]
            or recipe["collection_id"] != job.control.artifacts.context.collection_id
            or recipe["snapshot_id"] != job.control.artifacts.context.snapshot_id
            or not any(m["moduleId"] == recipe["module_id"] and m["enabled"] is True for m in job.selection["modules"])):
        raise AdapterUnavailable("paper-lab-scope-task-lease-mismatch")
    _selected(job, _ref({"artifactId": row["recipeArtifactId"], "sha256": row["recipeSha256"]}), "WorkerPaperLabRecipe")
    implementation = _ref(recipe["implementation"])
    _selected(job, implementation, "WorkerPaperLabImplementation")
    if job.context.contracts.digest(row["implementation"]) != implementation["sha256"]:
        raise AdapterUnavailable("paper-lab-selected-implementation-mismatch")
    inputs = recipe["inputs"]
    if type(inputs) is not list or not 0 <= len(inputs) <= 63:
        raise AdapterUnavailable("paper-lab-input-count-budget")
    verifier = CurrentPaperLabVerifier(job, recipe, row["recipeSha256"], row["implementation"])
    verifier.load("request", recipe["request"])
    for value in inputs:
        item = _record(value, {"name", "binding", "review"})
        verifier.load(item["name"], {"binding": item["binding"], "review": item["review"]})
    pins = [source.pin for source in verifier.sources.values()]
    if (len({p["evidenceId"] for p in pins}) != len(pins) or len({p["artifactId"] for p in pins}) != len(pins)
            or type(row["input_evidence_ids"]) is not list
            or len(row["input_evidence_ids"]) != len(pins)
            or set(row["input_evidence_ids"]) != {p["evidenceId"] for p in pins}
            or type(recipe["dependency_pins"]) is not list
            or len(recipe["dependency_pins"]) > 64
            or recipe["operation"] not in {"freeze-experiment", "map-backtest"} and recipe["dependency_pins"]):
        raise AdapterUnavailable("paper-lab-exact-command-input-membership")
    metadata = _record(recipe["publication"], {"evidenceId", "collectionId", "snapshotId", "sourceUri", "sourceIdentity",
        "sourceLocator", "attribution", "publishedAt", "claim", "limitations", "rightsPolicyId"})
    source_identity = _record(metadata["sourceIdentity"], {"provider", "sourceId", "snapshotId"})
    if (metadata["collectionId"] != verifier.scope.collection_id or metadata["snapshotId"] != verifier.scope.snapshot_id
            or source_identity["snapshotId"] != verifier.scope.snapshot_id
            or metadata["rightsPolicyId"] != job.rights_policy["policyId"]
            or metadata["evidenceId"] in {p["evidenceId"] for p in pins}
            or metadata["evidenceId"] in {p["artifactId"] for p in pins}
            or metadata["evidenceId"] in {s.reference["artifactId"] for s in verifier.sources.values()}):
        raise AdapterUnavailable("paper-lab-output-publication-scope")
    admission = job.admit_private_research(row)
    if admission is not None:
        return admission
    if job.private_admitted_at is None:
        return {"status": "unavailable", "reason": "paper-lab-durable-admission-capture-unavailable",
                "outputArtifactIds": [], "executionAuthorized": False}
    try:
        result = _operation(verifier)
        if isinstance(result, Unavailable):
            return {"status": "unavailable", "reason": result.reasons[0],
                    "outputArtifactIds": [], "executionAuthorized": False}
        if verifier.used != set(verifier.sources):
            raise AdapterUnavailable("paper-lab-unused-or-unbound-input")
        content, outcome = result
        if not 1 <= len(content) <= 700_000:
            raise AdapterUnavailable("paper-lab-output-byte-budget")
        digest = sha256(content).hexdigest()
        evidence = {**metadata, "schemaVersion": "1.0.0", "sourceType": "derived-analysis",
            "capturedAt": job.private_admitted_at,
            "sourceIdentity": {**source_identity, "contentHash": digest}, "contentHash": digest,
            "method": "Deterministic reviewed-source paper/lab mapping. capturedAt is durable job-input admission, not computation completion. No performance acceptance or execution authority.",
            "acceptanceStatus": "unreviewed", "untrustedContent": True}
        raw, evidence_hash = encode_authoritatively(evidence, verifier.codec)
        public_record(raw, "ResearchEvidence", codec=verifier.codec, validator=verifier.codec)
        verifier.refresh()
        if verifier.pending_backtest_publication is not None:
            mapped, source = verifier.pending_backtest_publication
            job.control.artifacts.publish_record(contract_name="BacktestRun", artifact_id=mapped.run_id,
                content=mapped.run_bytes, digest=mapped.run_hash, collection_id=verifier.scope.collection_id,
                experiment_source=source)
            verifier.published_run_id = mapped.run_id
            outcome = {**outcome, "operationStatus": "backtest-run-published", "runPublished": True,
                       "runArtifactId": mapped.run_id, "backtestDispatched": False}
            # Public immutable planning is not review, dispatch or execution.
            # Existing selected HostBacktestRecipe admission remains separate.
            verifier.refresh()
        lineage = tuple(source.pin["artifactId"] for source in verifier.sources.values())
        content_id = "paper-lab-content-" + job.context.contracts.digest({"jobId": job.lease["jobId"], "contentHash": digest})
        job.control.artifacts.stage(artifact_id=content_id, content=content, content_type="application/json",
            lineage_artifact_ids=lineage, collection_id=verifier.scope.collection_id,
            rights_policy_id=job.rights_policy["policyId"], rights_version=job.rights_policy["version"])
        verifier.refresh()
        job.check()
        job.control.artifacts.publish_record(contract_name="ResearchEvidence", artifact_id=metadata["evidenceId"],
            content=raw, digest=evidence_hash, collection_id=verifier.scope.collection_id,
            lineage_artifact_ids=lineage, rights_policy_id=job.rights_policy["policyId"],
            rights_version=job.rights_policy["version"], review_pins=tuple(pins))
    except ControlError as error:
        committed = verifier.experiment_commit_confirmed or verifier.published_run_id is not None
        state = "unknown" if error.effect == "unknown" or committed else "unavailable"
        return {"status": state, "reason": "paper-lab-control-" + state,
                "outputArtifactIds": [] if verifier.published_run_id is None else [verifier.published_run_id],
                "experimentCommitted": verifier.experiment_commit_confirmed,
                "runPublished": (True if verifier.published_run_id is not None else
                    None if verifier.pending_backtest_publication is not None and error.effect == "unknown" else False),
                "backtestDispatched": False,
                "executionAuthorized": False}
    except (AdapterUnavailable, ValueError, TypeError, KeyError):
        # A later bundle failure cannot conceal a confirmed independent commit.
        if verifier.experiment_commit_confirmed or verifier.published_run_id is not None:
            return {"status": "unknown", "reason": "paper-lab-output-after-source-commit",
                    "outputArtifactIds": [] if verifier.published_run_id is None else [verifier.published_run_id],
                    "experimentCommitted": verifier.experiment_commit_confirmed,
                    "runPublished": verifier.published_run_id is not None, "backtestDispatched": False,
                    "executionAuthorized": False}
        raise
    outputs = [metadata["evidenceId"]] + ([] if verifier.published_run_id is None else [verifier.published_run_id])
    return {"status": "completed", **outcome, "outputArtifactIds": outputs,
            "contentSha256": digest, "recordSha256": evidence_hash,
            "acceptanceStatus": "unreviewed", "executionAuthorized": False, "simulatedCapitalEntersNav": False}
