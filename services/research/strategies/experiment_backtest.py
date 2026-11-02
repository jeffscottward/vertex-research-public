"""Pure committed-experiment -> reviewed BacktestRun/recipe-field mapping.

Only compatible public fields are derived. Engine/model/calendar/PIT/fitting,
benchmark, snapshot semantics, publication scope and resource units are explicit
reviewed inputs, never guesses. The verifier must perform a committed-only read;
constructing ExperimentHandoff or supplying a receipt is not proof of persistence.
No recipe dispatch, artifact publication, native execution or acceptance occurs.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256

from backtesting.lineage import LineageInputs, time_ns
from backtesting.planner import EngineDescriptor
from backtesting.ports import ResourceBudget
from .core import count, digest_text, identity, instant
from .experiment_gates import parse_time
from .lab_authority import (LabScope, LabVerifier, LabVerifierPin, LabVerificationReceipt,
                            bounded_tuple, original_record, public_record, receipt_record,
                            timestamp, verify_binding)
from .publication import AuthoritativeValidator, CanonicalCodec, Unavailable, encode_authoritatively
from .quant import ExperimentHandoff, PROMOTION_GATES


@dataclass(frozen=True)
class DatasetSnapshotBinding:
    """FrozenDataset.snapshot_id has no direct DatasetManifest field.

    This supplied binding names the exact source snapshots represented by that
    reviewed catalog identity; the verifier must establish the catalog relation.
    It must never substitute dataVintageId/calendar/captureTime for snapshot_id.
    """
    dataset_id: str
    experiment_snapshot_id: str
    source_snapshots: tuple[tuple[str, str], ...]
    content_artifact_id: str
    content_format: str
    declared_events: int

    def __post_init__(self) -> None:
        identity(self.dataset_id)
        identity(self.experiment_snapshot_id)
        identity(self.content_artifact_id)
        identity(self.content_format)
        count(self.declared_events, positive=True)
        bounded_tuple(self.source_snapshots, 512, minimum=1)
        for pair in self.source_snapshots:
            bounded_tuple(pair, 2, minimum=2)
            for value in pair:
                identity(value)
        if len({pair[0] for pair in self.source_snapshots}) != len(self.source_snapshots):
            raise ValueError("Unique exact source/snapshot identities required")


@dataclass(frozen=True)
class ReviewedBacktestBinding:
    binding_id: str
    revision: int
    run_id: str
    benchmark: str
    validation_mode: str
    lineage: LineageInputs
    budget: ResourceBudget
    descriptor: EngineDescriptor
    model_bytes: bytes
    publication_bytes: bytes
    planned_at: datetime
    memory_mb_bytes: int
    trial_parameters: tuple[tuple[str, str], ...]
    parameter_targets: tuple[tuple[str, str], ...]
    dataset_snapshots: tuple[DatasetSnapshotBinding, ...]

    def __post_init__(self) -> None:
        for value in (self.binding_id, self.run_id, self.benchmark):
            identity(value)
        count(self.revision, positive=True)
        if self.validation_mode not in {"historical", "walk-forward"}:
            raise ValueError("Historical experiment cannot invent a paper-forward run")
        if (type(self.lineage) is not LineageInputs or type(self.budget) is not ResourceBudget
                or type(self.descriptor) is not EngineDescriptor):
            raise ValueError("Existing typed lineage/budget/descriptor contracts required")
        if type(self.memory_mb_bytes) is not int or self.memory_mb_bytes not in {1_000_000, 1_048_576}:
            raise ValueError("Experiment MB unit requires explicit reviewed decimal/binary binding")
        instant(self.planned_at)
        for original in (self.model_bytes, self.publication_bytes):
            if type(original) is not bytes or not 1 <= len(original) <= 262_144:
                raise ValueError("Original bounded reviewed engine/publication bindings required")
        for pairs in (self.trial_parameters, self.parameter_targets):
            bounded_tuple(pairs, 64)
            for pair in pairs:
                bounded_tuple(pair, 2, minimum=2)
                identity(pair[0])
                if type(pair[1]) is not str or not 1 <= len(pair[1]) <= 65536:
                    raise ValueError("Explicit literal parameter value/target required")
            if len({key for key, _ in pairs}) != len(pairs):
                raise ValueError("Duplicate parameter dimension")
        bounded_tuple(self.dataset_snapshots, 64, minimum=1)
        if (any(type(item) is not DatasetSnapshotBinding for item in self.dataset_snapshots)
                or len({item.dataset_id for item in self.dataset_snapshots}) != len(self.dataset_snapshots)):
            raise ValueError("Distinct explicit dataset snapshot bindings required")


@dataclass(frozen=True)
class ExperimentBacktestMapping:
    run_id: str
    run_bytes: bytes
    run_hash: str
    strategy_id: str
    strategy_hash: str
    dataset_refs: tuple[tuple[str, str, str, str, str, int], ...]
    binding_bytes: bytes
    binding_hash: str
    receipt: LabVerificationReceipt

    def recipe_references(self) -> dict:
        """Exact reference fields for existing vertex-host-backtest-recipe-v2.

        NOT a full recipe. Existing host serialization must pack the independently
        reviewed LineageInputs/ResourceBudget/EngineDescriptor and preserve model,
        publication, evidence, plannedAt. Run publication and selected recipe review
        must complete through existing stores before use. No authority is conveyed.
        """
        return {"strategy": {"artifactId": self.strategy_id, "sha256": self.strategy_hash},
                "run": {"artifactId": self.run_id, "sha256": self.run_hash},
                "datasets": [{"manifest": {"artifactId": name, "sha256": digest},
                              "content": {"artifactId": content_id, "sha256": content_hash},
                              "contentFormat": content_format, "declaredEvents": events}
                             for name, digest, content_id, content_hash, content_format, events in self.dataset_refs]}

    def record(self) -> dict:
        return {"format": "vertex-experiment-backtest-result-v1", "bindingHash": self.binding_hash,
                "recipeReferences": self.recipe_references(), "receipt": receipt_record(self.receipt),
                "executionAuthority": "none", "simulatedCapitalEntersNav": False}

    def publication_source(self, handoff: ExperimentHandoff, *, reviewed_binding_bytes: bytes,
                           binding_review: dict, dependency_pins: tuple[dict, ...],
                           codec: CanonicalCodec) -> dict:
        """Bounded expectations for the existing worker publication transaction.

        Original separately reviewed binding bytes must equal this reconstruction.
        No supplied pin is authority: the server resolves original committed
        experiment/binding/dependency identities and fresh reviews at commit.
        This helper never republishes the private handoff as a public record.
        """
        if (reviewed_binding_bytes != self.binding_bytes
                or sha256(reviewed_binding_bytes).hexdigest() != self.binding_hash
                or sha256(self.run_bytes).hexdigest() != self.run_hash):
            raise ValueError("Original reviewed mapping bytes differ")
        original = original_record(reviewed_binding_bytes, codec=codec)
        if ((original["experimentId"], original["experimentHash"], original["runId"], original["runHash"])
                != (handoff.experiment_id, handoff.content_hash, self.run_id, self.run_hash)):
            raise ValueError("Exact experiment/binding/run publication link required")
        review_fields = {"collectionId", "evidenceId", "artifactId", "artifactSha256",
                         "reviewId", "reviewVersion", "rightsPolicyId", "rightsVersion"}
        dependency_fields = review_fields - {"collectionId", "evidenceId"}
        if type(binding_review) is not dict or set(binding_review) != review_fields:
            raise ValueError("Exact binding review expectation required")
        bounded_tuple(dependency_pins, 63, minimum=1)
        for pin in (binding_review, *dependency_pins):
            if type(pin) is not dict or set(pin) != (review_fields if pin is binding_review else dependency_fields):
                raise ValueError("Exact generic dependency review expectation required")
            for key, value in pin.items():
                (digest_text if key == "artifactSha256" else identity)(value)
        ids = [pin["artifactId"] for pin in (binding_review, *dependency_pins)]
        if len(set(ids)) != len(ids) or self.run_id in ids:
            raise ValueError("Distinct binding/dependency/run identities required")
        return {"experimentId": handoff.experiment_id, "experimentHash": handoff.content_hash,
                "bindingSha256": self.binding_hash, "bindingReview": deepcopy(binding_review),
                "dependencyPins": deepcopy(list(dependency_pins))}


def backtest_candidates(handoff: ExperimentHandoff, binding: ReviewedBacktestBinding,
                        strategy: dict, codec: CanonicalCodec) -> tuple[dict, dict]:
    """Deterministic projection only; grants no verification or publication.

    Shared with the concrete verifier so it can rebuild the full candidate from
    independently loaded originals rather than echo caller-supplied hashes.
    """
    frozen = original_record(handoff.canonical_bytes, codec=codec)
    training, oos = frozen["windows"]["training"], frozen["windows"]["outOfSample"]
    candidate = {"schemaVersion": "1.0.0", "runId": binding.run_id,
        "strategyVersion": frozen["strategy"]["id"],
        "datasetManifestIds": sorted(row["datasetId"] for row in frozen["datasets"]),
        "seed": frozen["seed"], "engineVersion": frozen["engineVersion"],
        "trainingWindow": {"startAtInclusive": training["start"], "endAtExclusive": training["end"]},
        "testWindow": {"startAtInclusive": oos["start"], "endAtExclusive": oos["end"]},
        "benchmark": binding.benchmark, "transactionCosts": strategy["costModel"],
        "slippageModel": strategy["costModel"]["impactModel"], "resultsRef": None,
        "leakageChecks": [], "reviewStatus": "unreviewed", "validationMode": binding.validation_mode,
        "forwardSampleCount": 0, "gammaProvenance": None}
    record = {"format": "vertex-reviewed-experiment-backtest-binding-v1", "bindingId": binding.binding_id,
        "revision": binding.revision, "experimentId": handoff.experiment_id, "experimentHash": handoff.content_hash,
        "runId": binding.run_id, "runHash": codec.digest(candidate), "costModelHash": codec.digest(strategy["costModel"]),
        "lineage": binding.lineage.record(), "budget": asdict(binding.budget), "descriptor": asdict(binding.descriptor),
        "memoryMbBytes": binding.memory_mb_bytes, "trialParameters": dict(binding.trial_parameters),
        "parameterTargets": dict(binding.parameter_targets),
        "datasetSnapshots": [asdict(item) for item in binding.dataset_snapshots],
        "model": original_record(binding.model_bytes, codec=codec), "modelHash": sha256(binding.model_bytes).hexdigest(),
        "publication": original_record(binding.publication_bytes, codec=codec),
        "publicationHash": sha256(binding.publication_bytes).hexdigest(),
        "plannedAt": timestamp(binding.planned_at), "executionAuthority": "none", "simulatedCapitalEntersNav": False}
    return candidate, record


def map_committed_experiment(handoff: ExperimentHandoff, binding: ReviewedBacktestBinding, *,
                             strategy_bytes: bytes, dataset_manifest_bytes: tuple[bytes, ...],
                             scope: LabScope, as_of: datetime, codec: CanonicalCodec | None,
                             validator: AuthoritativeValidator | None, verifier: LabVerifier | None,
                             verifier_pin: LabVerifierPin | None) -> ExperimentBacktestMapping | Unavailable:
    """Produce unreviewed BacktestRun bytes after exact committed/source verification.

    Handoff strategy.id/hash -> recipe.strategy and run.strategyVersion.
    Dataset datasetId/manifestHash -> run.datasetManifestIds and recipe.datasets.
    seed/engineVersion/training/OOS -> same existing run fields (renamed clocks).
    Original StrategySpec.costModel -> transactionCosts; impactModel -> slippageModel.
    implementationDigest/environmentDigest -> supplied lineage code/environment pins.
    Trial/runtime/memory ceilings constrain, never enlarge, supplied ResourceBudget.
    No public field exists for snapshot/embargo/grid/budget: retained binding_bytes
    preserve these alongside explicit reviewed lineage/model/parameter mappings.
    """
    if codec is None or validator is None or verifier is None or verifier_pin is None:
        return Unavailable(("committed-experiment-backtest-ports-unavailable",))
    bounded_tuple(dataset_manifest_bytes, 64, minimum=1)
    frozen = original_record(handoff.canonical_bytes, codec=codec)
    strategy = public_record(strategy_bytes, "StrategySpec", codec=codec, validator=validator)
    if (sha256(strategy_bytes).hexdigest() != handoff.strategy_hash
            or frozen["strategy"]["id"] != strategy["strategyId"] + ":" + strategy["version"]
            or strategy["codeDigest"] != frozen["implementationDigest"]
            or strategy["hypothesis"] != frozen["hypothesis"]["statement"]
            or frozen["requiredEvidenceGates"] != list(PROMOTION_GATES)):
        raise ValueError("Exact frozen experiment/strategy identity mismatch")
    planned = instant(binding.planned_at)
    requested = parse_time(frozen["requestedAt"])
    if not requested <= planned <= instant(as_of):
        raise ValueError("Backtest plan predates experiment or is from the future")
    lineage, budget = binding.lineage, binding.budget
    if (lineage.strategy_version_id != frozen["strategy"]["id"]
            or lineage.code_pin.digest != frozen["implementationDigest"]
            or lineage.environment_digest != frozen["environmentDigest"]
            or lineage.engine_pin != binding.descriptor.pin
            or binding.descriptor.pin.version != frozen["engineVersion"]
            or binding.descriptor.simulation_only is not True
            or lineage.strategy_frozen_at > parse_time(frozen["windows"]["outOfSample"]["start"])):
        raise ValueError("Reviewed code/engine/environment/OOS lineage differs from experiment")
    limits = frozen["budget"]
    if (budget.maximum_trials > limits["maximumTrials"]
            or budget.maximum_wall_ms > limits["maximumRuntimeSeconds"] * 1000
            or budget.maximum_cpu_ms > limits["maximumRuntimeSeconds"] * 1000
            or budget.maximum_memory_bytes > limits["maximumMemoryMb"] * binding.memory_mb_bytes
            or budget.network_allowed is not False or budget.execution_allowed is not False):
        raise ValueError("Reviewed backtest budget exceeds frozen experiment ceilings")
    training, oos = frozen["windows"]["training"], frozen["windows"]["outOfSample"]
    if (parse_time(oos["start"]) - parse_time(training["end"])).total_seconds() < frozen["windows"]["embargoSeconds"]:
        raise ValueError("Frozen embargo violated")
    if binding.validation_mode == "walk-forward" and not lineage.folds:
        raise ValueError("Walk-forward run requires explicit reviewed folds/fitter semantics")
    for fold in lineage.folds:
        if (fold.embargo_ms < frozen["windows"]["embargoSeconds"] * 1000
                or fold.training.start_at < parse_time(training["start"])
                or fold.test.start_at < parse_time(oos["start"])
                or fold.test.end_at > parse_time(oos["end"])):
            raise ValueError("Supplied fold must preserve frozen window and embargo bounds")
    grid = frozen["parameterGrid"]
    parameters, targets = dict(binding.trial_parameters), dict(binding.parameter_targets)
    if (set(parameters) != set(grid) or set(targets) != set(grid)
            or any(parameters[key] not in values for key, values in grid.items())
            or len(set(targets.values())) != len(targets)):
        raise ValueError("Exact selected grid values and distinct reviewed engine targets required")
    if (lineage.trials is None or lineage.trials.registered_at > requested
            or len(lineage.trials.trial_ids) > budget.maximum_trials):
        raise ValueError("Explicit preregistered selected trial identity required")
    model = original_record(binding.model_bytes, codec=codec, maximum=262_144)
    publication = original_record(binding.publication_bytes, codec=codec, maximum=262_144)
    if (set(publication) != {"actorId", "collectionId", "snapshotId", "rightsPolicyId", "rightsVersion"}
            or (publication["actorId"], publication["collectionId"], publication["snapshotId"])
            != (scope.actor_id, scope.collection_id, scope.snapshot_id)):
        raise ValueError("Explicit recipe publication scope must equal verified research scope")
    for value in publication.values():
        identity(value)
    datasets = [public_record(value, "DatasetManifest", codec=codec, validator=validator) for value in dataset_manifest_bytes]
    indexed = {item["datasetId"]: (item, original) for item, original in zip(datasets, dataset_manifest_bytes, strict=True)}
    expected = {item["datasetId"]: item for item in frozen["datasets"]}
    pins = {pin.dataset_id: pin for pin in lineage.data_pins}
    snapshots = {item.dataset_id: item for item in binding.dataset_snapshots}
    if (len(indexed) != len(datasets) or len(expected) != len(frozen["datasets"])
            or len(pins) != len(lineage.data_pins) or set(indexed) != set(expected)
            or set(pins) != set(expected) or set(snapshots) != set(expected)):
        raise ValueError("Exact experiment dataset/lineage/snapshot coverage required")
    refs = []
    for dataset_id in sorted(expected):
        manifest, original = indexed[dataset_id]
        frozen_dataset, pin, snapshot = expected[dataset_id], pins[dataset_id], snapshots[dataset_id]
        digest = sha256(original).hexdigest()
        if (digest != frozen_dataset["manifestHash"] or digest != pin.manifest_digest
                or pin.content_digest != manifest["contentHash"]
                or pin.source_digests != tuple(source["contentHash"] for source in manifest["sources"])
                or snapshot.experiment_snapshot_id != frozen_dataset["snapshotId"]
                or snapshot.source_snapshots != tuple((s["sourceId"], s["snapshotId"]) for s in manifest["sources"])
                or frozen_dataset["pointInTime"] is not True
                or manifest["dataVintageStatus"] != "available" or pin.vintage_id != manifest["dataVintageId"]
                or pin.calendar_pin.identity != manifest["calendar"]
                or manifest["calendar"] != strategy["signalSchedule"]["calendar"]
                or time_ns(manifest["captureTime"]) > time_ns(frozen_dataset["availableAt"])
                or time_ns(manifest["asOfAt"]) > time_ns(frozen_dataset["knowledgeCutoff"])
                or time_ns(frozen_dataset["availableAt"]) > time_ns(requested)
                or time_ns(manifest["startAtInclusive"]) > time_ns(training["start"])
                or time_ns(manifest["endAtExclusive"]) < time_ns(oos["end"])):
            raise ValueError("Dataset identity/PIT/window/source binding differs from experiment")
        if manifest["gammaProvenance"] is not None:
            return Unavailable(("explicit-gamma-replay-backtest-binding-required",))
        if snapshot.content_format not in binding.descriptor.supported_formats:
            return Unavailable(("explicit-engine-dataset-format-binding-required",))
        refs.append((dataset_id, digest, snapshot.content_artifact_id, manifest["contentHash"],
                     snapshot.content_format, snapshot.declared_events))
    if sum(item.declared_events for item in binding.dataset_snapshots) > budget.maximum_events:
        raise ValueError("Explicit dataset event counts exceed reviewed resource budget")
    candidate, record = backtest_candidates(handoff, binding, strategy, codec)
    if validator.validate("BacktestRun", deepcopy(candidate), schema_version="1.0.0") is not True:
        raise ValueError("Existing authoritative BacktestRun contract rejected mapping")
    run_bytes, run_hash = encode_authoritatively(candidate, codec)
    encoded, digest = encode_authoritatively(record, codec)
    receipt = verify_binding("experiment-backtest", {"binding": record, "bindingHash": digest},
        (handoff.canonical_bytes, strategy_bytes, *dataset_manifest_bytes,
         binding.model_bytes, binding.publication_bytes, run_bytes, encoded),
        scope=scope, as_of=as_of, codec=codec, verifier=verifier, verifier_pin=verifier_pin)
    if isinstance(receipt, Unavailable):
        return receipt
    return ExperimentBacktestMapping(binding.run_id, run_bytes, run_hash, frozen["strategy"]["id"],
        handoff.strategy_hash, tuple(refs), encoded, digest, receipt)
