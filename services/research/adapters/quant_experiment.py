"""Selected original quant handoff -> normal admission -> immutable publication.

No planning, fitting, model/native execution, review creation or grant mutation.
The selected recipe carries expected pins, never current-review authority.
"""
from __future__ import annotations

import base64
from typing import Any

from strategies.quant import ExperimentHandoff, store_experiment
from vertex_control.client import ControlError

from .experiments import ControlImmutableExperimentStore
from .ports import AdapterUnavailable

MAX_HANDOFF_BYTES = 700_000
MAX_HANDOFF_BASE64 = ((MAX_HANDOFF_BYTES + 2) // 3) * 4
RECIPE_FIELDS = {"profile", "module_id", "task_contract", "collection_id", "experiment_id",
                 "handoff", "dependency_pins", "publication"}
HANDOFF_FIELDS = {"internalKind", "experimentId", "hypothesis", "strategy", "datasets", "windows",
                  "seed", "environmentDigest", "engineVersion", "implementationDigest", "requestedAt",
                  "parameterGrid", "budget", "sandbox", "priorExperimentHash", "requiredEvidenceGates",
                  "executionAuthority", "simulatedCapitalEntersNav"}


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        raise AdapterUnavailable("quant-experiment-shape-invalid")
    return dict(value)


def _identity(job: Any, value: Any) -> str:
    if job.context.contracts.validate("Identifier", value, "1.0.0") is not True:
        raise AdapterUnavailable("quant-experiment-identity-invalid")
    return value


def _selected(job: Any, artifact_id: str, digest: str, contract: str) -> None:
    matches = [entry for entry in job.selection["artifacts"] if entry["artifact"]["artifactId"] == artifact_id]
    if (len(matches) != 1 or matches[0]["role"] != "tool-config"
            or matches[0]["artifact"]["artifactSha256"] != digest
            or matches[0]["artifact"]["contractName"] != contract
            or matches[0]["artifact"]["schemaVersion"] != "1.0.0"):
        raise AdapterUnavailable("quant-experiment-selected-pin-unavailable")


def run_quant_experiment(job: Any, payload: Any) -> dict[str, Any]:
    row = _record(payload, {"profile", "recipe", "recipeArtifactId", "recipeSha256", "handoffBase64",
        "run_id", "trace_id", "actor_id", "task_contract", "account_alias", "environment", "input_evidence_ids"})
    recipe = _record(row["recipe"], RECIPE_FIELDS)
    if row["profile"] != "vertex-quant-experiment-job-v1" or recipe["profile"] != "vertex-quant-experiment-recipe-v1":
        raise AdapterUnavailable("quant-experiment-profile-unavailable")
    job.check()
    if (job.lease["kind"] != "research-run" or job.context.contracts.digest(row) != job.lease["payloadSha256"]
            or (row["actor_id"], row["account_alias"], row["environment"])
            != (job.lease["researchPrincipalId"], job.lease["accountAlias"], job.lease["environment"])):
        raise AdapterUnavailable("quant-experiment-job-binding-mismatch")
    for name in ("run_id", "trace_id", "actor_id", "task_contract", "account_alias", "recipeArtifactId"):
        _identity(job, row[name])
    for name in ("module_id", "task_contract", "collection_id", "experiment_id"):
        _identity(job, recipe[name])
    if (recipe["task_contract"] != row["task_contract"]
            or recipe["collection_id"] != job.control.artifacts.context.collection_id
            or job.context.contracts.digest(recipe) != row["recipeSha256"]
            or not any(module["moduleId"] == recipe["module_id"] and module["enabled"] is True
                       for module in job.selection["modules"])):
        raise AdapterUnavailable("quant-experiment-recipe-binding-mismatch")
    _selected(job, row["recipeArtifactId"], row["recipeSha256"], "WorkerQuantExperimentRecipe")
    reference = _record(recipe["handoff"], {"artifactId", "sha256"})
    _selected(job, reference["artifactId"], reference["sha256"], "WorkerExperimentHandoff")
    if reference["artifactId"] == row["recipeArtifactId"]:
        raise AdapterUnavailable("quant-experiment-source-identity-conflict")
    publication = _record(recipe["publication"], {"account_alias", "environment", "collection_id",
                                                 "rights_policy_id", "rights_version"})
    if (publication["account_alias"], publication["environment"], publication["collection_id"],
            publication["rights_policy_id"], publication["rights_version"]) != (
            job.lease["accountAlias"], job.lease["environment"], recipe["collection_id"],
            job.rights_policy["policyId"], job.rights_policy["version"]):
        raise AdapterUnavailable("quant-experiment-publication-scope-mismatch")
    encoded = row["handoffBase64"]
    if type(encoded) is not str or not 4 <= len(encoded) <= MAX_HANDOFF_BASE64 or not encoded.isascii():
        raise AdapterUnavailable("quant-experiment-source-budget")
    original = base64.b64decode(encoded, validate=True)
    if (not original or len(original) > MAX_HANDOFF_BYTES
            or base64.b64encode(original).decode("ascii") != encoded
            or job.input_bytes + len(original) > 16_000_000):
        raise AdapterUnavailable("quant-experiment-source-budget")
    job.input_bytes += len(original)
    handoff_value = _record(job.control.artifacts.check_experiment_bytes(original, reference["sha256"]), HANDOFF_FIELDS)
    strategy = _record(handoff_value["strategy"], {"id", "hash", "contractName", "schemaVersion"})
    datasets = handoff_value["datasets"]
    citations = handoff_value["hypothesis"]["citations"]
    if (handoff_value["experimentId"] != recipe["experiment_id"]
            or strategy["contractName"] != "StrategySpec" or strategy["schemaVersion"] != "1.0.0"
            or type(datasets) is not list or not 1 <= len(datasets) <= 64
            or type(citations) is not list or not 1 <= len(citations) <= 64
            or job.context.contracts.epoch_ns(handoff_value["requestedAt"]) > job.clock.now_ns()):
        raise AdapterUnavailable("quant-experiment-original-identity-mismatch")
    pins = recipe["dependency_pins"]
    if type(pins) is not list or not 1 <= len(pins) <= 64:
        raise AdapterUnavailable("quant-experiment-dependency-budget")
    for pin in pins:
        if job.context.contracts.validate("WorkerExperimentDependencyPin", pin, "1.0.0") is not True:
            raise AdapterUnavailable("quant-experiment-dependency-pin-invalid")
    hashes = {strategy["hash"], *(dataset["manifestHash"] for dataset in datasets),
              *(citation["artifactHash"] for citation in citations)}
    if (len({pin["artifactId"] for pin in pins}) != len(pins)
            or len({pin["artifactSha256"] for pin in pins}) != len(pins)
            or hashes != {pin["artifactSha256"] for pin in pins}
            or not any(pin["artifactId"] == strategy["id"] and pin["artifactSha256"] == strategy["hash"] for pin in pins)):
        raise AdapterUnavailable("quant-experiment-dependency-coverage-mismatch")
    evidence_ids = set()
    for digest in {citation["artifactHash"] for citation in citations}:
        pin = next(pin for pin in pins if pin["artifactSha256"] == digest)
        content = job.artifact({"artifactId": pin["artifactId"], "sha256": digest}, collection_id=recipe["collection_id"])
        evidence = job.control.artifacts.validate_record("ResearchEvidence", content, digest)
        if (evidence["collectionId"] != recipe["collection_id"] or evidence["evidenceId"] in evidence_ids
                or any(citation["sourceId"] != evidence["sourceIdentity"]["sourceId"]
                       for citation in citations if citation["artifactHash"] == digest)):
            raise AdapterUnavailable("quant-experiment-citation-binding-mismatch")
        evidence_ids.add(evidence["evidenceId"])
    command_ids = row["input_evidence_ids"]
    if type(command_ids) is not list or len(command_ids) != len(evidence_ids) or set(command_ids) != evidence_ids:
        raise AdapterUnavailable("quant-experiment-command-evidence-mismatch")
    # No plan regeneration. These are exactly the selected original canonical
    # bytes. Constructor checks internal ID/hash/dependency and safety flags;
    # complete private schema/current reviews remain server publication authority.
    handoff = ExperimentHandoff(recipe["experiment_id"], reference["sha256"], original,
        strategy["hash"], tuple(dataset["manifestHash"] for dataset in datasets))
    admission = job.admit_private_research(row)
    if admission is not None:
        return admission
    store = ControlImmutableExperimentStore(job.control.artifacts, dependency_pins=pins,
        deadline_ns=job.deadline, cancellation=job.cancel)
    try:
        digest = store_experiment(handoff, store=store)
    except ControlError as error:
        status = "unknown" if error.effect == "unknown" else "unavailable"
        return {"status": status, "reason": "quant-experiment-publication-" + status,
                "outputArtifactIds": [], "executionAuthorized": False}
    if digest != handoff.content_hash:
        return {"status": "unknown", "reason": "quant-experiment-commit-unconfirmed",
                "outputArtifactIds": [], "executionAuthorized": False}
    artifact_id = "experiment-" + job.context.contracts.digest({
        "collectionId": recipe["collection_id"], "experimentId": handoff.experiment_id})
    return {"status": "completed", "experimentId": handoff.experiment_id, "contentSha256": digest,
            "outputArtifactIds": [artifact_id], "executionAuthorized": False, "simulatedCapitalEntersNav": False}
