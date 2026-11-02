"""Closed historical source projections, never gate approval or forward evidence.

Reproduction requires two independently committed runs of identical reviewed
inputs. A reviewed method pins both mappings and exact metric/units/comparison;
the existing gate policy alone supplies acceptance thresholds. Source limitations
and incidents remain disqualifying even when numerical reproduction succeeds.
"""
from __future__ import annotations

import base64
import json
import re
from copy import deepcopy
from dataclasses import asdict, fields
from datetime import datetime
from decimal import Decimal, Inexact, Rounded, localcontext
from hashlib import sha256

from backtesting.lineage import (AcceptanceCriterion, DataPin, ForwardCriteria, Incident,
    LEAKAGE_KINDS, LineageInputs, ModelAssumption, Pin, PointInTimeEvidence, TimeWindow,
    TrialRegistry, WalkForwardFold, time_ns)
from backtesting.planner import EngineDescriptor
from backtesting.ports import ResourceBudget
from .core import digest_text, identity
from .lab_authority import original_record, public_record, text
from .publication import AuthoritativeValidator, CanonicalCodec, Unavailable, encode_authoritatively

PROJECTION_FIELDS = {"profile", "experimentId", "experimentHash", "policyHash", "observationId",
                     "runInput", "resultsInput", "lineageInput", "mappingInput", "method", "window",
                     "producedAt", "availableAt", "reviewerId", "metrics"}
OOS_PRECOMMITTED_PROFILE = "vertex-backtest-oos-projection-v2"
OOS_PRECOMMITTED_FIELDS = PROJECTION_FIELDS | {"recipeInput", "receiptInput", "isolationInput"}


def gate_method_rule_pin(gate: str, source: dict, *, codec: CanonicalCodec) -> Pin:
    """Canonical scientific core, not a rehashed post-run binding envelope.

    Excluded fields are ONLY exact experiment/mapping identities, whose original
    joins remain mandatory in the existing projectors. In particular cost model
    review digests, fee values, comparison directions and thresholds stay here.
    The OOS algorithm is explicitly direct-copy; stress retains its v2 bytes.
    """
    if gate == "out-of-sample":
        if set(source) != OOS_PRECOMMITTED_FIELDS or source["profile"] != OOS_PRECOMMITTED_PROFILE:
            raise ValueError("OOS v2 original projection and completed-source bindings required")
        rules = {"format": "vertex-backtest-oos-method-v2", "operation": "original-oos-metric-value",
                 "metrics": source["metrics"]}
        name, version = "vertex-backtest-oos", "2.0.0"
    elif gate == "reproducible-backtest":
        if (set(source) != {"format", "experimentHash", "baselineMappingHash", "repeatMappingHash", "invariants", "metrics"}
                or source["format"] != "vertex-backtest-reproducibility-method-v1"):
            raise ValueError("Exact original reproduction binding envelope required")
        rules = {"format": "vertex-backtest-reproducibility-rules-v1",
                 "invariants": source["invariants"], "metrics": source["metrics"]}
        name, version = "vertex-backtest-reproducibility-rules", "1.0.0"
    elif gate == "cost-sensitivity":
        if (set(source) != {"format", "baselineExperimentHash", "variantExperimentHash",
                "baselineMappingHash", "variantMappingHash", "invariants", "dimension", "metrics"}
                or source["format"] != "vertex-backtest-cost-sensitivity-method-v1"):
            raise ValueError("Exact original cost binding envelope required")
        rules = {"format": "vertex-backtest-cost-sensitivity-rules-v1",
                 "invariants": source["invariants"], "dimension": source["dimension"], "metrics": source["metrics"]}
        name, version = "vertex-backtest-cost-sensitivity-rules", "1.0.0"
    elif gate == "stress":
        if (set(source) != {"format", "qualification", "performance"}
                or source["format"] != "vertex-backtest-historical-midpoint-stress-method-v2"):
            raise ValueError("Exact original rule-only stress v2 method required")
        rules = source
        name, version = "vertex-backtest-historical-midpoint-stress", "2.0.0"
    else:
        raise ValueError("No qualified rule derivation for this gate; never fabricate a method")
    return Pin(name, version, encode_authoritatively(rules, codec)[1])


def _historical_source(projection: dict, *, handoff_bytes: bytes, run_bytes: bytes,
                       results_bytes: bytes, lineage_bytes: bytes, mapping_bytes: bytes,
                       results_artifact_id: str, codec: CanonicalCodec,
                       validator: AuthoritativeValidator) -> tuple[dict, dict, dict, dict, dict] | Unavailable:
    """Shared exact historical source join; no measurement or gate verdict."""
    experiment = original_record(handoff_bytes, codec=codec)
    run = public_record(run_bytes, "BacktestRun", codec=codec, validator=validator)
    results = original_record(results_bytes, codec=codec)
    lineage = original_record(lineage_bytes, codec=codec)
    mapping = original_record(mapping_bytes, codec=codec)
    if set(results) != {"lineageDigest", "strategyDigest", "enginePin", "datasetContentDigests",
                        "assumptionDigest", "economics", "economicsOrigin", "economicsSimulated",
                        "sandbox", "evidenceDigests", "incidentCodes", "executionAuthorized", "forwardAssessment"}:
        return Unavailable(("existing-simulated-result-profile-unavailable",))
    if (mapping.get("format") != "vertex-reviewed-experiment-backtest-binding-v1"
            or mapping.get("experimentId") != experiment["experimentId"]
            or mapping.get("experimentHash") != sha256(handoff_bytes).hexdigest()
            or (projection["experimentId"], projection["experimentHash"])
            != (experiment["experimentId"], mapping["experimentHash"])
            or projection["window"] != experiment["windows"]["outOfSample"]
            or run["runId"] != mapping["runId"]
            or run["strategyVersion"] != experiment["strategy"]["id"]
            or run["engineVersion"] != experiment["engineVersion"]
            or run["seed"] != experiment["seed"]
            or run["datasetManifestIds"] != [item["datasetId"] for item in experiment["datasets"]]
            or run["testWindow"] != {"startAtInclusive": projection["window"]["start"], "endAtExclusive": projection["window"]["end"]}
            or run["trainingWindow"] != {"startAtInclusive": experiment["windows"]["training"]["start"],
                                          "endAtExclusive": experiment["windows"]["training"]["end"]}
            or run["resultsRef"] != results_artifact_id
            or results_artifact_id != "backtest-results-" + sha256(results_bytes).hexdigest()
            or results["lineageDigest"] != sha256(lineage_bytes).hexdigest()
            or results["strategyDigest"] != experiment["strategy"]["hash"]
            or lineage.get("strategyDigest") != experiment["strategy"]["hash"]
            or lineage.get("runDigest") != mapping["runHash"]
            or lineage.get("lineage") != mapping["lineage"]
            or lineage.get("budget") != mapping["budget"]
            or lineage.get("engineDescriptor") != mapping["descriptor"]
            or lineage.get("datasetManifestDigests") != [d["manifestHash"] for d in experiment["datasets"]]
            or results["enginePin"] != mapping["descriptor"]["pin"]
            or results["datasetContentDigests"] != [p["content_digest"] for p in mapping["lineage"]["dataPins"]]
            or results["economicsOrigin"] != "injected-simulation-engine"
            or results["economicsSimulated"] is not True or results["executionAuthorized"] is not False):
        raise ValueError("Original OOS run/result/lineage/experiment identities do not join")
    _, cost_hash = encode_authoritatively(run["transactionCosts"], codec)
    _, assumptions_hash = encode_authoritatively(mapping["lineage"]["assumptions"], codec)
    if (cost_hash != mapping["costModelHash"] or results["assumptionDigest"] != assumptions_hash
            or run["slippageModel"] != run["transactionCosts"]["impactModel"]
            or run["validationMode"] != "historical"):
        return Unavailable(("explicit-historical-oos-source-binding-required",))
    economics = results["economics"]
    if (type(economics) is not dict or economics.get("metricScope") != "out-of-sample"
            or type(economics.get("metrics")) is not dict or economics.get("executionAuthorized") is not False):
        return Unavailable(("original-out-of-sample-metrics-unavailable",))
    if not time_ns(projection["window"]["end"]) <= time_ns(projection["producedAt"]) <= time_ns(projection["availableAt"]):
        raise ValueError("Reviewed historical observation chronology invalid")
    return experiment, run, results, lineage, mapping


def project_oos_observation(projection_bytes: bytes, *, handoff_bytes: bytes, run_bytes: bytes,
                            results_bytes: bytes, lineage_bytes: bytes, mapping_bytes: bytes,
                            results_artifact_id: str, codec: CanonicalCodec,
                            validator: AuthoritativeValidator) -> bytes | Unavailable:
    """Copy explicitly selected source metrics; output still needs current review."""
    projection = original_record(projection_bytes, codec=codec)
    profile = projection.get("profile")
    expected = OOS_PRECOMMITTED_FIELDS if profile == OOS_PRECOMMITTED_PROFILE else PROJECTION_FIELDS
    if (set(projection) != expected
            or profile not in {"vertex-backtest-oos-projection-v1", OOS_PRECOMMITTED_PROFILE}):
        raise ValueError("Closed reviewed OOS projection required")
    if profile == OOS_PRECOMMITTED_PROFILE and projection["method"] != asdict(
            gate_method_rule_pin("out-of-sample", projection, codec=codec)):
        raise ValueError("Exact rule-only direct-copy OOS v2 method pin required")
    joined = _historical_source(projection, handoff_bytes=handoff_bytes, run_bytes=run_bytes,
        results_bytes=results_bytes, lineage_bytes=lineage_bytes, mapping_bytes=mapping_bytes,
        results_artifact_id=results_artifact_id, codec=codec, validator=validator)
    if isinstance(joined, Unavailable):
        return joined
    _, run, results, _, _ = joined
    economics = results["economics"]
    requested = projection["metrics"]
    if (type(requested) is not list or not 1 <= len(requested) <= 16
            or any(type(m) is not dict or set(m) != {"criterionId", "metricId", "unit"} for m in requested)
            or len({m["criterionId"] for m in requested}) != len(requested)
            or len({m["metricId"] for m in requested}) != len(requested)):
        raise ValueError("Explicit distinct reviewed metric identities and units required")
    measurements = []
    for metric in requested:
        value = economics["metrics"].get(metric["metricId"])
        if value is None:
            return Unavailable(("declared-oos-metric-unavailable",))
        AcceptanceCriterion._decimal(value)
        measurements.append({**metric, "value": value})
    limitations = list(economics.get("limitations", []))
    if type(economics.get("limitations")) is not list:
        return Unavailable(("original-result-limitations-unavailable",))
    incidents = results["incidentCodes"]
    if type(incidents) is not list or len(incidents) > 64 or any(type(code) is not str for code in incidents):
        raise ValueError("Original source incidents must be retained")
    limitations.extend("Source incident: " + code for code in incidents)
    checks = run["leakageChecks"]
    if {c["kind"] for c in checks} != LEAKAGE_KINDS or any(c["status"] != "passed" for c in checks):
        limitations.append("Original backtest leakage evidence is incomplete or failed.")
    if run["reviewStatus"] in {"incomplete", "rejected"}:
        limitations.append("Original backtest computational review status is " + run["reviewStatus"] + ".")
    if economics.get("closedRoundTrip") is not True:
        limitations.append("Original source does not establish a completed economic round trip.")
    observation = {"format": "vertex-experiment-gate-observation-v1",
        "observationId": projection["observationId"], "experimentHash": projection["experimentHash"],
        "policyHash": projection["policyHash"], "gate": "out-of-sample",
        "producedAt": projection["producedAt"], "availableAt": projection["availableAt"],
        "window": projection["window"], "origin": "backtest", "method": projection["method"],
        "provenanceId": results_artifact_id, "provenanceHash": sha256(results_bytes).hexdigest(),
        "reviewerId": projection["reviewerId"], "metrics": measurements,
        "contaminated": any(c["status"] == "failed" for c in checks),
        "limitations": list(dict.fromkeys(limitations))}
    encoded, _ = encode_authoritatively(observation, codec)
    return encoded


REPRODUCTION_PROFILE = "vertex-backtest-reproducibility-projection-v1"
REPRODUCTION_FIELDS = {"profile", "experimentId", "experimentHash", "policyHash", "observationId",
    "baseline", "repeat", "derivedLineageDigests", "methodInput", "method", "window",
    "producedAt", "availableAt", "reviewerId"}
REPRODUCTION_ROLES = ("run", "results", "mapping", "recipe", "receipt", "isolation")
_RECIPE_TYPES = {kind.__name__: kind for kind in (AcceptanceCriterion, DataPin, ForwardCriteria,
    Incident, LineageInputs, ModelAssumption, Pin, PointInTimeEvidence, TimeWindow, TrialRegistry,
    WalkForwardFold, EngineDescriptor, ResourceBudget)}


def _recipe_value(value, depth=0):
    """Decode only existing inert lineage/budget/descriptor wire records.

    No host import, engine construction, registry supplied by callers, or arbitrary
    import/type selection. Every field and primitive envelope is closed.
    """
    if depth > 32:
        raise ValueError("Reviewed recipe nesting exceeds comparison bound")
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is not dict:
        raise ValueError("Exact reviewed recipe envelope required")
    if set(value) == {"record", "fields"}:
        kind = _RECIPE_TYPES.get(value["record"])
        if kind is None or type(value["fields"]) is not dict or set(value["fields"]) != {f.name for f in fields(kind)}:
            raise ValueError("Unsupported comparison recipe record")
        decoded = {key: _recipe_value(item, depth + 1) for key, item in value["fields"].items()}
        result = kind(**{f.name: decoded[f.name] for f in fields(kind) if f.init})
        if any(getattr(result, f.name) != decoded[f.name] for f in fields(kind)):
            raise ValueError("Recipe record changes during closed reconstruction")
        return result
    if len(value) != 1:
        raise ValueError("Closed recipe primitive required")
    key, item = next(iter(value.items()))
    if key == "tuple" and type(item) is list and len(item) <= 1024:
        return tuple(_recipe_value(row, depth + 1) for row in item)
    if key == "integer" and type(item) is str and len(item) <= 40:
        parsed = int(item)
        if str(parsed) == item and -(2**127) <= parsed < 2**127:
            return parsed
    if key == "datetime" and type(item) is str and len(item) <= 40:
        parsed = datetime.fromisoformat(item)
        if parsed.tzinfo is not None and parsed.utcoffset() is not None:
            return parsed
    if key == "bytes" and type(item) is str and len(item) <= 350_000:
        parsed = base64.b64decode(item, validate=True)
        if base64.b64encode(parsed).decode("ascii") == item:
            return parsed
    raise ValueError("Unsupported reviewed recipe primitive")


def _reproduction_source(selection: dict, originals: dict[str, bytes], *, projection: dict,
                         handoff_bytes: bytes, derived_lineage_digest: str, codec: CanonicalCodec,
                         validator: AuthoritativeValidator) -> tuple[dict, dict, dict, dict, dict]:
    """Join completed economics back to its planned run and original host recipe."""
    if type(selection) is not dict or set(selection) != set(REPRODUCTION_ROLES) or set(originals) != set(REPRODUCTION_ROLES):
        raise ValueError("All six exact original reproduction sources required")
    for role in REPRODUCTION_ROLES:
        selected = selection[role]
        if type(selected) is not dict or set(selected) != {"input", "sha256"}:
            raise ValueError("Exact named original and digest required")
        identity(selected["input"])
        digest_text(selected["sha256"])
        if sha256(originals[role]).hexdigest() != selected["sha256"]:
            raise ValueError("Reproduction source differs from reviewed original digest")
    experiment = original_record(handoff_bytes, codec=codec)
    run = public_record(originals["run"], "BacktestRun", codec=codec, validator=validator)
    results, mapping, recipe = (original_record(originals[key], codec=codec) for key in ("results", "mapping", "recipe"))
    if set(recipe) != {"format", "strategy", "run", "datasets", "evidence", "lineage", "budget",
                       "descriptor", "model", "plannedAt", "publication"} or recipe["format"] != "vertex-host-backtest-recipe-v2":
        raise ValueError("Original closed host backtest recipe v2 required")
    inputs, budget, descriptor = (_recipe_value(recipe[key]) for key in ("lineage", "budget", "descriptor"))
    if type(inputs) is not LineageInputs or type(budget) is not ResourceBudget or type(descriptor) is not EngineDescriptor:
        raise ValueError("Original typed lineage, budget and engine descriptor required")
    mapping_fields = {"format", "bindingId", "revision", "experimentId", "experimentHash", "runId", "runHash",
        "costModelHash", "lineage", "budget", "descriptor", "memoryMbBytes", "trialParameters", "parameterTargets",
        "datasetSnapshots", "model", "modelHash", "publication", "publicationHash", "plannedAt",
        "executionAuthority", "simulatedCapitalEntersNav"}
    if set(mapping) != mapping_fields or mapping["executionAuthority"] != "none" or mapping["simulatedCapitalEntersNav"] is not False:
        raise ValueError("Exact original reviewed experiment-backtest mapping required")
    # These are the ONLY fields planner.complete changes. In particular do not
    # erase seed, economics assumptions, windows, leakage checks or provenance.
    planned = {**run, "resultsRef": None, "reviewStatus": "unreviewed", "forwardSampleCount": 0}
    if (codec.digest(planned) != mapping["runHash"]
            or recipe["run"] != {"artifactId": mapping["runId"], "sha256": mapping["runHash"]}
            or recipe["strategy"] != {"artifactId": experiment["strategy"]["id"], "sha256": experiment["strategy"]["hash"]}
            or codec.encode(inputs.record()) != codec.encode(mapping["lineage"])
            or codec.encode(asdict(budget)) != codec.encode(mapping["budget"])
            or codec.encode(asdict(descriptor)) != codec.encode(mapping["descriptor"])
            or recipe["model"] != mapping["model"] or codec.digest(recipe["model"]) != mapping["modelHash"]
            or recipe["publication"] != mapping["publication"] or codec.digest(recipe["publication"]) != mapping["publicationHash"]
            or recipe["plannedAt"] != mapping["plannedAt"]
            or inputs.code_pin.digest != experiment["implementationDigest"]
            or inputs.environment_digest != experiment["environmentDigest"]
            or inputs.engine_pin != descriptor.pin or descriptor.pin.version != experiment["engineVersion"]
            or descriptor.simulation_only is not True or run["forwardSampleCount"] != 0
            or run["gammaProvenance"] is not None or planned["leakageChecks"] != []):
        raise ValueError("Recipe/planned run/model/code/engine differs from immutable experiment mapping")
    if not time_ns(experiment["requestedAt"]) <= time_ns(recipe["plannedAt"]) <= time_ns(projection["producedAt"]):
        raise ValueError("Reproduction plan chronology mismatch")
    expected_datasets = []
    for frozen in experiment["datasets"]:
        pins = [p for p in mapping["lineage"]["dataPins"] if p["dataset_id"] == frozen["datasetId"]]
        snapshots = [s for s in mapping["datasetSnapshots"] if s["dataset_id"] == frozen["datasetId"]]
        if len(pins) != 1 or len(snapshots) != 1 or pins[0]["manifest_digest"] != frozen["manifestHash"] or snapshots[0]["experiment_snapshot_id"] != frozen["snapshotId"]:
            raise ValueError("Original dataset/manifest/snapshot pin mismatch")
        expected_datasets.append({"manifest": {"artifactId": frozen["datasetId"], "sha256": frozen["manifestHash"]},
            "content": {"artifactId": snapshots[0]["content_artifact_id"], "sha256": pins[0]["content_digest"]},
            "contentFormat": snapshots[0]["content_format"], "declaredEvents": snapshots[0]["declared_events"]})
    if recipe["datasets"] != expected_datasets:
        raise ValueError("Original recipe dataset content/window selection differs")
    if type(recipe["evidence"]) is not list or not 1 <= len(recipe["evidence"]) <= 256:
        raise ValueError("Bounded original recipe evidence required")
    for reference in recipe["evidence"]:
        if type(reference) is not dict or set(reference) != {"artifactId", "sha256"}:
            raise ValueError("Exact original evidence reference required")
        identity(reference["artifactId"])
        digest_text(reference["sha256"])
    expected_lineage = {"strategyDigest": experiment["strategy"]["hash"], "runDigest": mapping["runHash"],
        "datasetManifestDigests": [d["manifest"]["sha256"] for d in recipe["datasets"]],
        "evidenceDigests": [e["sha256"] for e in recipe["evidence"]],
        "lineage": inputs.record(), "budget": asdict(budget), "engineDescriptor": asdict(descriptor),
        "gammaReplayEvidence": None, "gammaSourceCaptures": [], "plannedAt": recipe["plannedAt"],
        "proposalOnly": True, "executionAuthorized": False}
    # The producer persists the digest, not a separate lineage artifact. Rebuild
    # those exact bytes from current-reviewed originals; never invent a lineage
    # artifact ID, publication receipt, or independent review for this derivative.
    lineage_bytes, lineage_digest = encode_authoritatively(expected_lineage, codec)
    digest_text(derived_lineage_digest)
    if lineage_digest != derived_lineage_digest or lineage_digest != results["lineageDigest"]:
        raise ValueError("Derived lineage differs from original result and reviewed projection pins")
    joined = _historical_source(projection, handoff_bytes=handoff_bytes,
        run_bytes=originals["run"], results_bytes=originals["results"], lineage_bytes=lineage_bytes,
        mapping_bytes=originals["mapping"], results_artifact_id="backtest-results-" + selection["results"]["sha256"],
        codec=codec, validator=validator)
    if isinstance(joined, Unavailable):
        raise ValueError("Comparable complete historical economics are unavailable")
    _, _, _, lineage, _ = joined
    model, economics = recipe["model"], results["economics"]
    if (model.get("strategy_digest") != experiment["strategy"]["hash"]
            or model.get("strategy_code_digest") != experiment["implementationDigest"]
            or model.get("assumptions_digest") != results["assumptionDigest"]
            or model.get("engine_digest") != descriptor.pin.digest
            or model.get("review_digest") != economics.get("reviewDigest")
            or economics.get("model") != descriptor.pin.identity
            or economics.get("modelVersion") != descriptor.pin.version):
        raise ValueError("Original economics does not bind exact reviewed model/engine")
    _execution_source(originals, results=results, budget=budget, descriptor=descriptor, codec=codec)
    native_raw = base64.b64decode(model["native_configuration_bytes"], validate=True)
    native = _private_record(native_raw, maximum=1_048_576)
    if (economics.get("model") != "vertex-nautilus-quote-research"
            or economics.get("modelVersion") != "1.0.0"
            or native["distribution"]["name"] != "nautilus-trader"
            or native["distribution"]["version"] != "2.0.0rc5"
            or economics.get("nativeConfigurationSha256") != sha256(native_raw).hexdigest()
            or economics.get("distributionBuildSha256") != native["distribution"]["buildSha256"]
            or economics.get("runnerSha256") != model["engine_digest"]
            or native["instrument"]["id"] != model["instrument_id"]
            or native["instrument"]["currency"] != "USD"):
        raise ValueError("Reproduction requires exact original native model/configuration pins")
    return run, results, lineage, mapping, recipe


def _private_record(original: bytes, *, maximum: int = 700_000) -> dict:
    """Parse bounded original protocol/config bytes without recanonicalizing them."""
    if type(original) is not bytes or not 1 <= len(original) <= maximum:
        raise ValueError("Private original byte bound")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate private original field")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError("Floating/nonfinite private fields are unsupported")
    result = json.loads(original, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)
    if type(result) is not dict:
        raise ValueError("Private original object required")
    return result


def _natural(value: str) -> int:
    if type(value) is not str or not value.isascii() or not value.isdigit() or len(value) > 40:
        raise ValueError("Canonical bounded nonnegative resource measurement required")
    result = int(value)
    if str(result) != value:
        raise ValueError("Noncanonical resource measurement")
    return result


def _source_decimal(value: str) -> Decimal:
    """Native fixed-point strings may retain zeros; never floats or exponents.

    Parse the exact original amount without rewriting the original artifact.
    Only the newly calculated difference uses the gate canonical decimal domain.
    """
    if type(value) is not str or re.fullmatch(r"-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?", value) is None:
        raise ValueError("Bounded exact native fixed-point source amount required")
    return Decimal(value)


def _execution_source(originals: dict[str, bytes], *, results: dict, budget: ResourceBudget,
                      descriptor: EngineDescriptor, codec: CanonicalCodec) -> None:
    """Check recorded measurements and exact attestation payload joins.

    Local ephemeral HMAC keys are not exported. Authentication remains the
    original trusted native producer plus CURRENT reviews of these exact
    artifacts, not a retrospective signature claim or a caller receipt boolean.
    """
    receipt = original_record(originals["receipt"], codec=codec)
    isolation = _private_record(originals["isolation"])
    if (set(receipt) != {"format", "observation", "outputSha256", "peakMemoryBytes", "cpuMs", "wallMs",
            "memoryEvents", "isolationArtifactId", "startAttestationBase64", "finishAttestationBase64",
            "processExited", "cgroupEmpty"} or receipt["format"] != "vertex-worker-observation-v1"
            or receipt["isolationArtifactId"] != "sandbox-isolation-" + sha256(originals["isolation"]).hexdigest()
            or set(isolation) != {"bindingDigest", "enforcement"}
            or receipt["processExited"] is not True or receipt["cgroupEmpty"] is not True):
        raise ValueError("Original successful complete worker receipt/isolation required")
    digest_text(receipt["outputSha256"])
    digest_text(isolation["bindingDigest"])
    observation, enforcement, sandbox = receipt["observation"], isolation["enforcement"], results["sandbox"]
    if (set(enforcement) != {"parentObservation", "localNamespaces", "controls", "hardLimits",
                            "networkPolicy", "runtimePolicy", "scope"}
            or enforcement["parentObservation"] != observation
            or enforcement["localNamespaces"] != observation["namespaces"]
            or enforcement["networkPolicy"] != "default-deny-seccomp-and-private-netns"
            or enforcement["runtimePolicy"] != "root-owned-exact-inventory-read-only-mount"
            or enforcement["scope"] != "entire-attested-adapter-in-worker"
            or observation["policy_digest"] != descriptor.sandbox_policy_digest
            or observation["memory_max"] != budget.maximum_memory_bytes
            or observation["pids_max"] != 2 or observation["cpu_max"] != "100000 100000"
            or observation["no_new_privs"] != 1 or observation["seccomp"] != 2
            or int(observation["effective_capabilities"], 16) != 0 or observation["root_read_only"] is not True
            or observation["thread_profile"] != "nautilus-rc5-glibc244-x86_64-2task-v1"
            or observation["native_profile"]["profile"] != observation["thread_profile"]
            or enforcement["hardLimits"] != [[9, budget.maximum_memory_bytes],
                [0, (budget.maximum_cpu_ms + 999) // 1000], [6, 2], [7, 32], [1, 0], [4, 0]]
            or enforcement["controls"] != {"memory.max": str(budget.maximum_memory_bytes),
                "memory.swap.max": "0", "memory.oom.group": "1", "pids.max": "2", "cpu.max": "100000 100000"}
            or sandbox["policy_digest"] != descriptor.sandbox_policy_digest
            or codec.encode(sandbox["budget"]) != codec.encode(asdict(budget))
            or sandbox["limits_enforced"] is not True or sandbox["network_used"] is not False
            or sandbox["execution_authority_used"] is not False
            or sandbox["isolation_evidence_id"] != "isolation-" + observation["session_id"]):
        raise ValueError("Original recorded native enforcement/sandbox identities disagree")
    limits = {"input_bytes": budget.maximum_input_bytes, "events_processed": budget.maximum_events,
        "peak_memory_bytes": budget.maximum_memory_bytes, "cpu_ms": budget.maximum_cpu_ms, "wall_ms": budget.maximum_wall_ms}
    if (any(type(sandbox[key]) is not int or not 0 <= sandbox[key] <= limit for key, limit in limits.items())
            or sandbox["events_processed"] == 0):
        raise ValueError("Original measured simulation budget unqualified")
    for recorded, source, limit in (("peakMemoryBytes", "peak_memory_bytes", budget.maximum_memory_bytes),
            ("cpuMs", "cpu_ms", budget.maximum_cpu_ms), ("wallMs", "wall_ms", budget.maximum_wall_ms)):
        if not sandbox[source] <= _natural(receipt[recorded]) <= limit:
            raise ValueError("Final recorded worker measurement exceeds reviewed budget or precedes output")
    events = receipt["memoryEvents"]
    if (type(events) is not list or len(events) > 16
            or any(type(row) is not list or len(row) != 2 for row in events)
            or len({row[0] for row in events}) != len(events)):
        raise ValueError("Exact original memory event accounting required")
    counts = {row[0]: _natural(row[1]) for row in events}
    if any(name not in counts or counts[name] != 0 for name in ("max", "oom", "oom_kill", "oom_group_kill")):
        raise ValueError("Recorded native memory limit/oom event")
    for phase, key in (("start", "startAttestationBase64"), ("finish", "finishAttestationBase64")):
        proof = _private_record(base64.b64decode(receipt[key], validate=True), maximum=65_536)
        if set(proof) != {"payload", "mac"}:
            raise ValueError("Original bounded native attestation envelope required")
        digest_text(proof["mac"])
        payload = _private_record(base64.b64decode(proof["payload"], validate=True), maximum=60_000)
        expected = {"phase": phase, "bindingDigest": isolation["bindingDigest"],
                    "enforcementDigest": sha256(originals["isolation"]).hexdigest()}
        if phase == "finish":
            expected["outputDigest"] = receipt["outputSha256"]
        if payload != expected:
            raise ValueError("Original native attestation payload does not join result receipt/isolation")


def project_reproduction_observation(projection_bytes: bytes, *, method_bytes: bytes,
        handoff_bytes: bytes, baseline: dict[str, bytes], repeat: dict[str, bytes],
        projection_artifact_id: str, codec: CanonicalCodec,
        validator: AuthoritativeValidator) -> bytes | Unavailable:
    """Derive absolute metric differences, not a supplied pass flag or receipt.

    Caller additionally proves distinct producer jobs/committed run graphs through
    readBacktestRun and current reviews. This pure function verifies original bytes
    and scientific comparability; its output has no admission/promotion authority.
    """
    projection = original_record(projection_bytes, codec=codec)
    if set(projection) != REPRODUCTION_FIELDS or projection["profile"] != REPRODUCTION_PROFILE:
        raise ValueError("Closed reviewed reproduction projection required")
    method = original_record(method_bytes, codec=codec)
    if (set(method) != {"format", "experimentHash", "baselineMappingHash", "repeatMappingHash", "invariants", "metrics"}
            or method["format"] != "vertex-backtest-reproducibility-method-v1"
            or method["invariants"] != "identical-reviewed-inputs-v1"
            or method["experimentHash"] != sha256(handoff_bytes).hexdigest()
            or method["baselineMappingHash"] != sha256(baseline["mapping"]).hexdigest()
            or method["repeatMappingHash"] != sha256(repeat["mapping"]).hexdigest()
            or set(projection["method"]) != {"identity", "version", "digest"}
            or projection["method"]["digest"] != sha256(method_bytes).hexdigest()):
        raise ValueError("Exact separately reviewed method and both mapping pins required")
    Pin(**projection["method"])
    identity(projection_artifact_id)
    if type(projection["derivedLineageDigests"]) is not dict or set(projection["derivedLineageDigests"]) != {"baseline", "repeat"}:
        raise ValueError("Explicit derived lineage digest pins required, not fabricated source artifacts")
    sources = [_reproduction_source(projection[key], originals, projection=projection,
        handoff_bytes=handoff_bytes, derived_lineage_digest=projection["derivedLineageDigests"][key],
        codec=codec, validator=validator)
        for key, originals in (("baseline", baseline), ("repeat", repeat))]
    left, right = sources
    if (left[0]["runId"] == right[0]["runId"] or left[3]["bindingId"] == right[3]["bindingId"]
            or any(baseline[key] == repeat[key] for key in REPRODUCTION_ROLES)):
        raise ValueError("Independent distinct original runs/results/mappings/recipes/receipts/isolation required")
    # Only publication identities and plan timestamps differ. Entire remaining
    # mappings cover identical seed, data, code, environment, engine, model,
    # budget, parameters, units, windows, assumptions and review evidence.
    ignored = {"bindingId", "runId", "runHash", "plannedAt"}
    if (codec.encode({k: v for k, v in left[3].items() if k not in ignored})
            != codec.encode({k: v for k, v in right[3].items() if k not in ignored})
            or left[4]["evidence"] != right[4]["evidence"]
            or {k: v for k, v in left[0].items() if k not in {"runId", "resultsRef", "reviewStatus"}}
            != {k: v for k, v in right[0].items() if k not in {"runId", "resultsRef", "reviewStatus"}}):
        raise ValueError("Undeclared scientific/configuration difference between reproduction runs")
    observations = [original_record(originals["receipt"], codec=codec)["observation"] for originals in (baseline, repeat)]
    per_execution = {"session_id", "process_id", "namespaces", "cgroup_path"}
    if (observations[0]["session_id"] == observations[1]["session_id"]
            or {k: v for k, v in observations[0].items() if k not in per_execution}
            != {k: v for k, v in observations[1].items() if k not in per_execution}):
        raise ValueError("Reproduction requires distinct sessions and identical reviewed runtime/enforcement")
    requested = method["metrics"]
    if (type(requested) is not list or not 1 <= len(requested) <= 16
            or any(type(m) is not dict or set(m) != {"criterionId", "metricId", "sourceMetricId", "unit", "operation", "maximumAbsoluteDifference"} for m in requested)
            or any(m["operation"] != "absolute-difference" for m in requested)
            or any(len({m[key] for m in requested}) != len(requested) for key in ("criterionId", "metricId", "sourceMetricId"))):
        raise ValueError("Distinct explicit reviewed absolute-difference measurements required")
    economics = [source[1]["economics"] for source in sources]
    if any(set(e["metrics"]) != {m["sourceMetricId"] for m in requested} for e in economics):
        return Unavailable(("reproduction-all-original-metrics-required",))
    # Current native profile explicitly records currency and original native
    # totals. Other economics profiles lack source unit declarations.
    if any(e.get("nativeResult", {}).get("currency") != "USD" for e in economics):
        return Unavailable(("reproduction-explicit-source-metric-units-unavailable",))
    if ({m["sourceMetricId"] for m in requested} != {"gross-pnl", "net-pnl", "total-commission", "ending-cash"}
            or any(m["unit"] != "USD" for m in requested)):
        return Unavailable(("reproduction-unsupported-source-metric-unit",))
    measurements, limitations = [], []
    traces = []
    for economic in economics:
        native, fills = economic["nativeResult"], economic["simulatedFills"]
        if (set(native) != {"iterations", "totalOrders", "totalPositions", "endingCash", "currency"}
                or native["endingCash"] != economic["metrics"]["ending-cash"]
                or type(fills) is not list or len(fills) != 2
                or _natural(native["iterations"]) == 0 or _natural(native["totalOrders"]) != 2
                or _natural(native["totalPositions"]) != 1):
            raise ValueError("Original complete native result/fill accounting required")
        for fill in fills:
            if (type(fill) is not dict or set(fill) != {"eventId", "availableNs", "side", "price", "quantity",
                    "commission", "currency", "clientOrderId", "tradeId"} or fill["currency"] != "USD"):
                raise ValueError("Original exact native fill facts and currency required")
            _natural(fill["availableNs"])
            for key in ("price", "quantity", "commission"):
                if _source_decimal(fill[key]) < 0:
                    raise ValueError("Original native fill amounts cannot be negative")
        # Run-local order/trade IDs are not economic dimensions. Every remaining
        # source field stays exact; equal aggregate PnL cannot hide another path.
        traces.append({**{k: v for k, v in economic.items() if k not in {"metrics", "limitations", "nativeResult", "simulatedFills"}},
            "nativeResult": {k: v for k, v in native.items() if k != "endingCash"},
            "simulatedFills": [{k: v for k, v in fill.items() if k not in {"clientOrderId", "tradeId"}} for fill in fills]})
    if traces[0] != traces[1]:
        limitations.append("Original native economic paths differ beyond the declared aggregate metric comparison.")
    for metric in requested:
        identity(metric["criterionId"])
        identity(metric["metricId"])
        if AcceptanceCriterion._decimal(metric["maximumAbsoluteDifference"]) < 0:
            raise ValueError("Reviewed nonnegative absolute tolerance required")
        values = [_source_decimal(e["metrics"][metric["sourceMetricId"]]) for e in economics]
        # Native fixed-point input has <=30 integer +18 fraction digits. A 64-digit
        # context preserves subtraction exactly; overflow is rejected, not rounded.
        with localcontext() as context:
            context.prec = 64
            context.Emax, context.Emin = 99, -99
            context.traps[Inexact] = context.traps[Rounded] = True
            difference = abs(values[1] - values[0])
            rendered = format(difference, "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        AcceptanceCriterion._decimal(rendered)
        measurements.append({"criterionId": metric["criterionId"], "metricId": metric["metricId"],
                             "unit": metric["unit"], "value": rendered})
    contaminated = False
    for label, (run, result, lineage, mapping, recipe) in zip(("baseline", "repeat"), sources, strict=True):
        economic = result["economics"]
        if type(economic.get("limitations")) is not list or type(result["incidentCodes"]) is not list:
            raise ValueError("Original limitations/incidents must be retained")
        for value in economic["limitations"]:
            limitations.append(label + ": " + text(value))
        for code in result["incidentCodes"]:
            limitations.append(label + " source incident: " + text(code))
        for incident in lineage["lineage"]["incidents"]:
            # Retain even resolved incidents; no source incident is silently
            # reclassified as scientific approval by this narrow producer.
            limitations.append(label + " lineage incident: " + codec.encode(incident).decode("utf-8"))
        checks = run["leakageChecks"]
        if {c["kind"] for c in checks} != LEAKAGE_KINDS or any(c["status"] != "passed" for c in checks):
            limitations.append(label + ": Original backtest leakage evidence is incomplete or failed.")
        contaminated = contaminated or any(c["status"] == "failed" for c in checks)
        if run["reviewStatus"] in {"incomplete", "rejected"}:
            limitations.append(label + ": Original backtest computational review status is " + run["reviewStatus"] + ".")
        if economic.get("closedRoundTrip") is not True:
            limitations.append(label + ": Original economic round trip is incomplete.")
    limitations = list(dict.fromkeys(limitations))
    if len(limitations) > 64 or any(len(item) > 4000 for item in limitations):
        return Unavailable(("reproduction-source-limitations-exceed-observation-bound",))
    observation = {"format": "vertex-experiment-gate-observation-v1",
        "observationId": projection["observationId"], "experimentHash": projection["experimentHash"],
        "policyHash": projection["policyHash"], "gate": "reproducible-backtest",
        "producedAt": projection["producedAt"], "availableAt": projection["availableAt"],
        "window": projection["window"], "origin": "backtest", "method": projection["method"],
        "provenanceId": projection_artifact_id, "provenanceHash": sha256(projection_bytes).hexdigest(),
        "reviewerId": projection["reviewerId"], "metrics": measurements,
        "contaminated": contaminated, "limitations": limitations}
    return encode_authoritatively(observation, codec)[0]


COST_PROFILE = "vertex-backtest-cost-sensitivity-projection-v1"
COST_FIELDS = {"profile", "experimentId", "experimentHash", "policyHash", "observationId",
    "baseline", "variant", "baselineExperiment", "variantExperiment", "baselineStrategy",
    "variantStrategy", "derivedLineageDigests", "methodInput", "method", "window",
    "producedAt", "availableAt", "reviewerId"}
_COST_METRICS = {"gross-pnl", "net-pnl", "total-commission", "ending-cash"}


def _cost_declaration(method: dict) -> dict:
    """One executed dimension, not a configurable arbitrary JSON-path transform.

    FixedFeeModel charges USD per FOK fill. Public commissionPerUnit is USD per
    share; both originals must explicitly declare the exact quantity conversion.
    Captured L1 spread is retained, never replaced by a hypothetical bps charge.
    """
    dimension = method["dimension"]
    if (type(dimension) is not dict or set(dimension) != {
            "strategyField", "strategyUnit", "modelField", "modelUnit", "assumptionKind", "baseline", "variant"}
            or dimension["strategyField"] != "costModel.commissionPerUnit"
            or dimension["strategyUnit"] != "USD/share"
            or dimension["modelField"] != "commission_per_fill" or dimension["modelUnit"] != "USD/fill"
            or dimension["assumptionKind"] != "commission"):
        raise ValueError("Only declared native fixed commission sensitivity is supported")
    for label in ("baseline", "variant"):
        value = dimension[label]
        if type(value) is not dict or set(value) != {"commissionPerUnit", "commissionPerFill", "modelReviewDigest"}:
            raise ValueError("Exact original unit/fill fees and model review pin required")
        if AcceptanceCriterion._decimal(value["commissionPerUnit"]) < 0:
            raise ValueError("Nonnegative original per-share fee required")
        amount = _source_decimal(value["commissionPerFill"])
        if not 0 <= amount <= Decimal("1000000000000") or amount != amount.quantize(Decimal("0.01")):
            raise ValueError("Native fixed fee must be an exact bounded USD cent amount")
        digest_text(value["modelReviewDigest"])
    if (_source_decimal(dimension["baseline"]["commissionPerFill"])
            == _source_decimal(dimension["variant"]["commissionPerFill"])
            or dimension["baseline"]["modelReviewDigest"] == dimension["variant"]["modelReviewDigest"]):
        raise ValueError("A distinct fee and independently declared model review are required")
    return dimension


def _cost_scientific_inputs(experiments: list[dict], strategies: list[dict], sources: list[tuple],
                            dimension: dict, codec: CanonicalCodec) -> None:
    """Prove each dependent identity before narrowly normalizing its counterpart.

    All unknown/additional fields remain in the comparisons. No ignore-list for
    scientific inputs, assumptions, evidence, timestamps of data, or budgets.
    Different requested/planned timestamps and version identities are bookkeeping
    of the separately committed experiment, not permission to vary its science.
    """
    experiment_fields = {"internalKind", "experimentId", "hypothesis", "strategy", "datasets", "windows",
        "seed", "environmentDigest", "engineVersion", "implementationDigest", "requestedAt", "parameterGrid",
        "budget", "sandbox", "priorExperimentHash", "requiredEvidenceGates", "executionAuthority", "simulatedCapitalEntersNav"}
    model_fields = {"strategy_digest", "strategy_code_digest", "assumptions_digest", "engine_digest", "review_digest",
        "instrument_id", "quantity", "initial_cash", "commission_per_fill", "slippage_per_unit",
        "enter_not_before_ns", "exit_not_before_ns", "evidence_template_bytes", "native_configuration_bytes"}
    for label, experiment, strategy, (run, result, lineage, mapping, recipe) in zip(
            ("baseline", "variant"), experiments, strategies, sources, strict=True):
        declared, model = dimension[label], recipe["model"]
        identity(mapping["bindingId"])
        if (set(experiment) != experiment_fields or experiment["internalKind"] != "vertex-quant-experiment-handoff-v1"
                or experiment["executionAuthority"] != "none" or experiment["simulatedCapitalEntersNav"] is not False
                or experiment["strategy"] != {"id": strategy["strategyId"] + ":" + strategy["version"],
                    "hash": codec.digest(strategy), "contractName": "StrategySpec", "schemaVersion": "1.0.0"}
                or strategy["hypothesis"] != experiment["hypothesis"]["statement"]
                or strategy["codeDigest"] != experiment["implementationDigest"]
                or run["transactionCosts"] != strategy["costModel"]
                or set(model) != model_fields
                or mapping["lineage"]["strategyVersionId"] != experiment["strategy"]["id"]
                or time_ns(mapping["lineage"]["strategyFrozenAt"]) > time_ns(experiment["windows"]["outOfSample"]["start"])
                or model["commission_per_fill"] != declared["commissionPerFill"]
                or model["review_digest"] != declared["modelReviewDigest"]
                or strategy["costModel"]["commissionPerUnit"] != declared["commissionPerUnit"]
                or result["economics"].get("strategyModel") != "reviewed-single-equity-time-gated-round-trip-v1"
                or result["economics"]["modelVersion"] != "1.0.0"
                or _source_decimal(model["slippage_per_unit"]) != 0):
            raise ValueError("Exact frozen strategy/native fee/model experiment binding required")
        # The selected native producer always emits an inconclusive realism
        # incident. A reviewed copy cannot erase that original computational
        # status or turn historical output into a forward/fold assessment.
        if (run["reviewStatus"] not in {"incomplete", "rejected"}
                or result["incidentCodes"] != ["native-model-realism-review-required"]
                or result["forwardAssessment"] is not None
                or mapping["lineage"]["folds"] or mapping["lineage"]["forwardCriteria"] is not None):
            raise ValueError("Original native inconclusive historical-only status must be preserved")
        start, end = (time_ns(experiment["windows"]["outOfSample"][key]) for key in ("start", "end"))
        enter, exit_at = (_natural(model[key]) for key in ("enter_not_before_ns", "exit_not_before_ns"))
        if not 0 <= start <= enter < exit_at < end <= 2**64 - 1:
            raise ValueError("Original native time gates must lie inside the frozen OOS window")
        cash = _source_decimal(model["initial_cash"])
        if not 0 < cash <= Decimal("1000000000000") or cash != cash.quantize(Decimal("0.01")):
            raise ValueError("Native comparison requires original bounded positive USD-cent cash")
        costs = strategy["costModel"]
        if (any(_source_decimal(costs[key]) != 0 for key in ("spreadBps", "slippageBps", "borrowAnnualBps"))
                or costs["impactModel"] != "fixed-bps"
                or _source_decimal(costs["maximumParticipationBps"]) != 10000):
            raise ValueError("Native comparison cannot execute additional bps/borrow/participation cost models")
        quantity = _source_decimal(model["quantity"])
        if not 0 < quantity <= 1_000_000 or quantity != quantity.to_integral_value():
            raise ValueError("Native comparison requires bounded whole-share FOK quantity")
        with localcontext() as context:
            context.prec = 96
            context.traps[Inexact] = context.traps[Rounded] = True
            if quantity * _source_decimal(declared["commissionPerUnit"]) != _source_decimal(declared["commissionPerFill"]):
                raise ValueError("Public per-share fee does not equal the actually executed per-fill fee")
        assumptions = mapping["lineage"]["assumptions"]
        commissions = [a for a in assumptions if a["kind"] == "commission"]
        if (len(commissions) != 1 or commissions[0]["disposition"] != "modeled"
                or codec.encode(commissions[0]["parameters"]) != codec.encode({
                    "commissionPerFill": declared["commissionPerFill"], "currency": "USD", "chargeCommissionOnce": False})):
            raise ValueError("Reviewed commission assumption must explicitly bind native fixed per-fill semantics")
        native = _private_record(base64.b64decode(model["native_configuration_bytes"], validate=True), maximum=1_048_576)
        instrument = native["instrument"]
        if (set(native) != {"format", "distribution", "instrument", "issuedNs", "expiresNs"}
                or native["format"] != "vertex-nautilus-research-v2"
                or set(instrument) != {"id", "rawSymbol", "currency", "pricePrecision", "priceIncrement", "lotSize"}
                or instrument["currency"] != "USD" or instrument["pricePrecision"] != 2
                or instrument["priceIncrement"] != "0.01" or instrument["lotSize"] != "1"):
            raise ValueError("Original native whole-share cent-price USD configuration required")
    left, right = experiments
    if (left["experimentId"] == right["experimentId"] or codec.digest(left) == codec.digest(right)
            or right["priorExperimentHash"] != codec.digest(left)
            or time_ns(right["requestedAt"]) < time_ns(left["requestedAt"])
            or strategies[0]["version"] == strategies[1]["version"]):
        raise ValueError("Variant must be a separately frozen version/experiment descending from baseline")
    normalized_experiment = deepcopy(right)
    for key in ("experimentId", "strategy", "requestedAt", "priorExperimentHash"):
        normalized_experiment[key] = left[key]
    normalized_strategy = deepcopy(strategies[1])
    normalized_strategy["version"] = strategies[0]["version"]
    normalized_strategy["costModel"]["commissionPerUnit"] = strategies[0]["costModel"]["commissionPerUnit"]
    if (codec.encode(normalized_experiment) != codec.encode(left)
            or codec.encode(normalized_strategy) != codec.encode(strategies[0])):
        raise ValueError("Cost variant changes an undeclared frozen scientific input")
    a, b = sources
    normalized_lineage = deepcopy(b[3]["lineage"])
    normalized_lineage["strategyVersionId"] = a[3]["lineage"]["strategyVersionId"]
    for assumption in normalized_lineage["assumptions"]:
        if assumption["kind"] == "commission":
            assumption["parameters"]["commissionPerFill"] = dimension["baseline"]["commissionPerFill"]
    normalized_model = deepcopy(b[4]["model"])
    for key in ("strategy_digest", "assumptions_digest", "review_digest", "commission_per_fill"):
        normalized_model[key] = a[4]["model"][key]
    normalized_mapping = deepcopy(b[3])
    for key in ("bindingId", "experimentId", "experimentHash", "runId", "runHash", "costModelHash",
                "modelHash", "plannedAt"):
        normalized_mapping[key] = a[3][key]
    normalized_mapping["lineage"], normalized_mapping["model"] = normalized_lineage, normalized_model
    normalized_run = deepcopy(b[0])
    for key in ("runId", "strategyVersion", "resultsRef", "reviewStatus"):
        normalized_run[key] = a[0][key]
    normalized_run["transactionCosts"]["commissionPerUnit"] = a[0]["transactionCosts"]["commissionPerUnit"]
    # Wire-record reconstruction was checked against the entire mapping by
    # _reproduction_source. Compare its normalized semantic record, not a new
    # invented lineage artifact or a caller-supplied record/digest.
    normalized_recipe = deepcopy(b[4])
    for key in ("strategy", "run", "plannedAt"):
        normalized_recipe[key] = a[4][key]
    normalized_recipe["model"] = normalized_model
    normalized_recipe["lineage"] = normalized_lineage
    baseline_recipe = {**a[4], "lineage": a[3]["lineage"]}
    if (codec.encode(normalized_mapping) != codec.encode(a[3])
            or codec.encode(normalized_run) != codec.encode(a[0])
            or codec.encode(normalized_recipe) != codec.encode(baseline_recipe)):
        raise ValueError("Variant mapping/recipe/run changes an undeclared scientific field")


def _cost_native_facts(economic: dict, model: dict) -> dict:
    """Validate original fee/fill/account facts; never synthesize variant returns."""
    if (set(economic) != {"model", "modelVersion", "reviewDigest", "nativeConfigurationSha256",
            "distributionBuildSha256", "runnerSha256", "strategyModel", "metricScope", "metrics",
            "simulatedFills", "nativeResult", "closedRoundTrip", "executionAuthorized", "limitations"}
            or set(economic["metrics"]) != _COST_METRICS or economic["closedRoundTrip"] is not True):
        raise ValueError("All original native monetary metrics and closed economics required")
    native, fills = economic["nativeResult"], economic["simulatedFills"]
    if (set(native) != {"iterations", "totalOrders", "totalPositions", "endingCash", "currency"}
            or native["currency"] != "USD" or type(fills) is not list or len(fills) != 2
            or _natural(native["iterations"]) == 0 or _natural(native["totalOrders"]) != 2
            or _natural(native["totalPositions"]) != 1
            or [f.get("side") for f in fills] != ["buy", "sell"]):
        raise ValueError("Complete native USD round-trip result/fill accounting required")
    for fill in fills:
        if (set(fill) != {"eventId", "availableNs", "side", "price", "quantity", "commission",
                "currency", "clientOrderId", "tradeId"} or fill["currency"] != "USD"
                or _source_decimal(fill["price"]) <= 0
                or _source_decimal(fill["quantity"]) != _source_decimal(model["quantity"])
                or _source_decimal(fill["commission"]) != _source_decimal(model["commission_per_fill"])):
            raise ValueError("Original full-size native fill does not execute the declared fee")
        _natural(fill["availableNs"])
        for key in ("eventId", "clientOrderId", "tradeId"):
            identity(fill[key])
    if (len({f["clientOrderId"] for f in fills}) != 2 or len({f["tradeId"] for f in fills}) != 2
            or not _natural(model["enter_not_before_ns"]) <= _natural(fills[0]["availableNs"])
                < _natural(model["exit_not_before_ns"]) <= _natural(fills[1]["availableNs"])):
        raise ValueError("Two distinct original full fills at the reviewed entry/exit gates required")
    amounts = {key: _source_decimal(value) for key, value in economic["metrics"].items()}
    with localcontext() as context:
        context.prec = 96
        context.Emax, context.Emin = 99, -99
        context.traps[Inexact] = context.traps[Rounded] = True
        fees = sum((_source_decimal(f["commission"]) for f in fills), Decimal(0))
        if (amounts["total-commission"] != fees
                or amounts["gross-pnl"] != amounts["net-pnl"] + fees
                or amounts["ending-cash"] != _source_decimal(native["endingCash"])
                or amounts["ending-cash"] != _source_decimal(model["initial_cash"]) + amounts["net-pnl"]
                or amounts["gross-pnl"] != (_source_decimal(fills[1]["price"]) - _source_decimal(fills[0]["price"]))
                    * _source_decimal(model["quantity"])):
            raise ValueError("Original native fee/PnL/cash/fill accounting disagrees")
    # Only proven run-local identifiers, actual fees, account totals, review pin,
    # and separately retained limitations are normalized. Every other field
    # remains exact, so a fee-related changed fill path cannot masquerade as this
    # bounded same-path comparison.
    return {**{k: v for k, v in economic.items() if k not in
            {"metrics", "simulatedFills", "nativeResult", "reviewDigest", "limitations"}},
        "grossPnl": amounts["gross-pnl"],
        "nativeResult": {k: v for k, v in native.items() if k != "endingCash"},
        "simulatedFills": [{**{k: v for k, v in f.items() if k not in
            {"commission", "clientOrderId", "tradeId", "price", "quantity"}},
            "price": _source_decimal(f["price"]), "quantity": _source_decimal(f["quantity"])} for f in fills]}


def project_cost_observation(projection_bytes: bytes, *, method_bytes: bytes,
        baseline_handoff_bytes: bytes, variant_handoff_bytes: bytes,
        baseline_strategy_bytes: bytes, variant_strategy_bytes: bytes,
        baseline: dict[str, bytes], variant: dict[str, bytes], projection_artifact_id: str,
        codec: CanonicalCodec, validator: AuthoritativeValidator) -> bytes | Unavailable:
    """Two genuine executions of separately committed immutable fee variants.

    The caller proves current accepted originals, committed experiments and
    distinct qualified producers via existing authority reads. No source bytes
    are updated, no permission is inferred, and this proposal needs its own review.
    """
    projection = original_record(projection_bytes, codec=codec)
    if set(projection) != COST_FIELDS or projection["profile"] != COST_PROFILE:
        raise ValueError("Closed reviewed cost comparison projection required")
    method = original_record(method_bytes, codec=codec)
    if (set(method) != {"format", "baselineExperimentHash", "variantExperimentHash",
            "baselineMappingHash", "variantMappingHash", "invariants", "dimension", "metrics"}
            or method["format"] != "vertex-backtest-cost-sensitivity-method-v1"
            or method["invariants"] != "native-fixed-commission-only-v1"
            or method["baselineExperimentHash"] != sha256(baseline_handoff_bytes).hexdigest()
            or method["variantExperimentHash"] != sha256(variant_handoff_bytes).hexdigest()
            or method["baselineMappingHash"] != sha256(baseline["mapping"]).hexdigest()
            or method["variantMappingHash"] != sha256(variant["mapping"]).hexdigest()
            or projection["experimentHash"] != method["baselineExperimentHash"]
            or set(projection["method"]) != {"identity", "version", "digest"}
            or projection["method"]["identity"] != "vertex-backtest-cost-sensitivity"
            or projection["method"]["version"] != "1.0.0"
            or projection["method"]["digest"] != sha256(method_bytes).hexdigest()):
        raise ValueError("Exact reviewed method and distinct experiment/mapping pins required")
    Pin(**projection["method"])
    identity(projection_artifact_id)
    dimension = _cost_declaration(method)
    extra = {"baselineExperiment": baseline_handoff_bytes, "variantExperiment": variant_handoff_bytes,
             "baselineStrategy": baseline_strategy_bytes, "variantStrategy": variant_strategy_bytes}
    for key, raw in extra.items():
        pin = projection[key]
        if type(pin) is not dict or set(pin) != {"input", "sha256"} or pin["sha256"] != sha256(raw).hexdigest():
            raise ValueError("Exact reviewed immutable experiment/strategy original pin required")
        identity(pin["input"])
    if type(projection["derivedLineageDigests"]) is not dict or set(projection["derivedLineageDigests"]) != {"baseline", "variant"}:
        raise ValueError("Both reconstructed original lineage digest pins required")
    experiments = [original_record(raw, codec=codec) for raw in (baseline_handoff_bytes, variant_handoff_bytes)]
    strategies = [public_record(raw, "StrategySpec", codec=codec, validator=validator)
                  for raw in (baseline_strategy_bytes, variant_strategy_bytes)]
    if projection["experimentId"] != experiments[0]["experimentId"]:
        raise ValueError("Cost observation must bind the baseline frozen experiment")
    sources = [_reproduction_source(projection[label], originals,
        projection={**projection, "experimentId": experiment["experimentId"], "experimentHash": sha256(raw).hexdigest()},
        handoff_bytes=raw, derived_lineage_digest=projection["derivedLineageDigests"][label], codec=codec, validator=validator)
        for label, originals, experiment, raw in (
            ("baseline", baseline, experiments[0], baseline_handoff_bytes),
            ("variant", variant, experiments[1], variant_handoff_bytes))]
    if (sources[0][0]["runId"] == sources[1][0]["runId"]
            or sources[0][3]["bindingId"] == sources[1][3]["bindingId"]
            or any(baseline[key] == variant[key] for key in REPRODUCTION_ROLES)):
        raise ValueError("Distinct original executions and scientific variant mappings required")
    _cost_scientific_inputs(experiments, strategies, sources, dimension, codec)
    observations = [original_record(originals["receipt"], codec=codec)["observation"] for originals in (baseline, variant)]
    per_execution = {"session_id", "process_id", "namespaces", "cgroup_path"}
    if (observations[0]["session_id"] == observations[1]["session_id"]
            or codec.encode({k: v for k, v in observations[0].items() if k not in per_execution})
            != codec.encode({k: v for k, v in observations[1].items() if k not in per_execution})):
        raise ValueError("Cost comparison requires distinct sessions and identical qualified runtime")
    economics = [source[1]["economics"] for source in sources]
    facts = [_cost_native_facts(source[1]["economics"], source[4]["model"]) for source in sources]
    if facts[0] != facts[1]:
        return Unavailable(("cost-comparison-native-path-changed-beyond-fixed-fee",))
    requested = method["metrics"]
    if (type(requested) is not list or len(requested) != 4
            or any(type(m) is not dict or set(m) != {"criterionId", "metricId", "sourceMetricId", "unit",
                "operation", "operator", "threshold"} for m in requested)
            or {m["sourceMetricId"] for m in requested} != _COST_METRICS
            or any(len({m[key] for m in requested}) != 4 for key in ("criterionId", "metricId"))
            or any(m["unit"] != "USD" or m["operation"] not in
                {"variant-minus-baseline", "baseline-minus-variant", "absolute-difference"}
                or m["operator"] not in {"lt", "lte", "eq", "gte", "gt"} for m in requested)):
        raise ValueError("All four original USD metrics need exact reviewed directions and policy thresholds")
    measurements = []
    for metric in requested:
        identity(metric["criterionId"])
        identity(metric["metricId"])
        threshold = AcceptanceCriterion._decimal(metric["threshold"])
        if metric["operation"] == "absolute-difference" and threshold < 0:
            raise ValueError("Absolute difference tolerance cannot be negative")
        values = [_source_decimal(e["metrics"][metric["sourceMetricId"]]) for e in economics]
        with localcontext() as context:
            context.prec = 64
            context.Emax, context.Emin = 99, -99
            context.traps[Inexact] = context.traps[Rounded] = True
            difference = values[1] - values[0]
            if metric["operation"] == "baseline-minus-variant":
                difference = -difference
            elif metric["operation"] == "absolute-difference":
                difference = abs(difference)
            rendered = "0" if difference == 0 else format(difference, "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        AcceptanceCriterion._decimal(rendered)
        measurements.append({"criterionId": metric["criterionId"], "metricId": metric["metricId"],
                             "unit": metric["unit"], "value": rendered})
    limitations, contaminated = [], False
    for label, (run, result, lineage, mapping, recipe) in zip(("baseline", "variant"), sources, strict=True):
        economic = result["economics"]
        if type(economic["limitations"]) is not list or type(result["incidentCodes"]) is not list:
            raise ValueError("Original limitations and incidents must remain explicit")
        limitations.extend(label + ": " + text(value) for value in economic["limitations"])
        limitations.extend(label + " source incident: " + text(code) for code in result["incidentCodes"])
        limitations.extend(label + " lineage incident: " + codec.encode(incident).decode("utf-8")
                           for incident in lineage["lineage"]["incidents"])
        checks = run["leakageChecks"]
        if {c["kind"] for c in checks} != LEAKAGE_KINDS or any(c["status"] != "passed" for c in checks):
            limitations.append(label + ": Original backtest leakage evidence is incomplete or failed.")
        contaminated = contaminated or any(c["status"] == "failed" for c in checks)
        if run["reviewStatus"] in {"incomplete", "rejected"}:
            limitations.append(label + ": Original backtest computational review status is " + run["reviewStatus"] + ".")
        if economic["closedRoundTrip"] is not True:
            limitations.append(label + ": Original economic round trip is incomplete.")
    limitations = list(dict.fromkeys(limitations))
    if len(limitations) > 64 or any(len(item) > 4000 for item in limitations):
        return Unavailable(("cost-comparison-source-limitations-exceed-observation-bound",))
    observation = {"format": "vertex-experiment-gate-observation-v1",
        "observationId": projection["observationId"], "experimentHash": projection["experimentHash"],
        "policyHash": projection["policyHash"], "gate": "cost-sensitivity",
        "producedAt": projection["producedAt"], "availableAt": projection["availableAt"],
        "window": projection["window"], "origin": "cost-sensitivity", "method": projection["method"],
        "provenanceId": projection_artifact_id, "provenanceHash": sha256(projection_bytes).hexdigest(),
        "reviewerId": projection["reviewerId"], "metrics": measurements,
        "contaminated": contaminated, "limitations": limitations}
    return encode_authoritatively(observation, codec)[0]


STRESS_PROFILE = "vertex-backtest-historical-midpoint-stress-projection-v1"
STRESS_PRECOMMITTED_PROFILE = "vertex-backtest-historical-midpoint-stress-projection-v2"
STRESS_COMMITMENT_PREFIX = "stress-method:vertex-backtest-historical-midpoint-stress:"
STRESS_FIELDS = {"profile", "experimentId", "experimentHash", "policyHash", "observationId",
    "source", "manifest", "content", "derivedLineageDigest", "methodInput", "method", "window",
    "qualification", "producedAt", "availableAt", "reviewerId"}


def _stress_amount(value: str, *, cents: bool = False) -> int:
    """Exact native nonnegative whole sizes / cent prices, without rounding."""
    if type(value) is not str or re.fullmatch(r"(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?", value) is None:
        raise ValueError("Original native nonnegative fixed-point amount required")
    numerator, denominator = Decimal(value).as_integer_ratio()
    scaled, remainder = divmod(numerator * (100 if cents else 1), denominator)
    if remainder or (cents and not 0 < scaled <= 100_000_000_000_000):
        raise ValueError("Native positive cent price / whole-share size required")
    return scaled


def _stress_dataset(*, manifest: dict, manifest_bytes: bytes, content: bytes,
                    experiment: dict, mapping: dict, recipe: dict, projection: dict) -> None:
    """Direct capture only; current source reviews, not shape, attest market origin."""
    if (len(recipe["datasets"]) != 1 or len(experiment["datasets"]) != 1
            or len(mapping["lineage"]["dataPins"]) != 1 or len(mapping["datasetSnapshots"]) != 1
            or len(manifest["sources"]) != 1):
        raise ValueError("Historical midpoint stress v2 requires one exact original native dataset")
    dataset, frozen = recipe["datasets"][0], experiment["datasets"][0]
    pin, snapshot = mapping["lineage"]["dataPins"][0], mapping["datasetSnapshots"][0]
    instrument = recipe["model"]["instrument_id"]
    source = manifest["sources"][0]
    if (type(source) is not dict or set(source) != {"provider", "sourceId", "snapshotId", "contentHash"}
            or manifest["sources"] != [source] or source["contentHash"] != sha256(content).hexdigest()
            or manifest["provider"] != source["provider"] or manifest["contentHash"] != source["contentHash"]
            or manifest["instrumentUniverse"] != [instrument] or manifest["gammaProvenance"] is not None
            or manifest["adjustmentMethod"] != "unadjusted"
            or manifest["datasetId"] != frozen["datasetId"] or pin["dataset_id"] != frozen["datasetId"]
            or sha256(manifest_bytes).hexdigest() != frozen["manifestHash"]
            or dataset["manifest"] != {"artifactId": frozen["datasetId"], "sha256": frozen["manifestHash"]}
            or dataset["content"] != {"artifactId": snapshot["content_artifact_id"], "sha256": source["contentHash"]}
            or dataset["contentFormat"] != "vertex-jsonl-events-v1"
            or dataset["contentFormat"] not in mapping["descriptor"]["supported_formats"]
            or dataset["declaredEvents"] != snapshot["declared_events"]
            or pin["manifest_digest"] != frozen["manifestHash"] or pin["content_digest"] != source["contentHash"]
            or pin["source_digests"] != [source["contentHash"]] or "quotes" not in pin["data_kinds"]
            or snapshot["source_snapshots"] != [[source["sourceId"], source["snapshotId"]]]
            or snapshot["experiment_snapshot_id"] != frozen["snapshotId"]
            or snapshot["dataset_id"] != frozen["datasetId"]
            or manifest["dataVintageStatus"] != "available" or pin["vintage_id"] != manifest["dataVintageId"]
            or pin["calendar_pin"]["identity"] != manifest["calendar"]
            or manifest["entitlementPolicyId"] != recipe["publication"]["rightsPolicyId"]
            or frozen["pointInTime"] is not True):
        raise ValueError("Original observed quote source/units/manifest/recipe/snapshot provenance mismatch")
    if (not 0 <= time_ns(manifest["startAtInclusive"]) <= time_ns(experiment["windows"]["training"]["start"])
            or not time_ns(projection["window"]["end"]) <= time_ns(manifest["endAtExclusive"])
                <= time_ns(manifest["captureTime"]) <= time_ns(frozen["availableAt"])
                <= time_ns(experiment["requestedAt"]) <= time_ns(recipe["plannedAt"])
            or not time_ns(manifest["asOfAt"]) <= time_ns(frozen["knowledgeCutoff"])
                <= time_ns(experiment["requestedAt"])):
        raise ValueError("Original quote capture/knowledge/window chronology mismatch")


def _stress_quotes(content: bytes, *, manifest: dict, recipe: dict, results: dict,
                   window: dict) -> dict:
    """Qualify the ENTIRE frozen native test window, never its fill-selected slice.

    Fill joins and holding counts describe the original execution only. Neither
    selects the midpoint observations or threshold. Twice the midpoint is bid
    cents + ask cents; its common factor cancels. Keep an unreduced bps ratio
    and earliest maximum on ties, without division or a calendar guess.
    """
    budget, model = _recipe_value(recipe["budget"]), recipe["model"]
    declared = recipe["datasets"][0]["declaredEvents"]
    if (type(content) is not bytes or not 0 < len(content) <= min(1_048_576, budget.maximum_input_bytes)
            or type(declared) is not int or not 2 <= declared <= min(2_000_000, budget.maximum_events)
            or not content.endswith(b"\n")):
        raise ValueError("Bounded complete original newline-terminated native capture required")
    lines = content.split(b"\n")
    if len(lines) - 1 != declared or results["sandbox"]["events_processed"] != declared:
        raise ValueError("Original declared rows and actual native loaded-event count disagree")
    economic = results["economics"]
    _cost_native_facts(economic, model)
    fills = economic["simulatedFills"]
    entry, exit_at = (_natural(fill["availableNs"]) for fill in fills)
    enter_gate, exit_gate = (_natural(model[key]) for key in ("enter_not_before_ns", "exit_not_before_ns"))
    start, end = (time_ns(window[key]) for key in ("start", "end"))
    if not 0 <= start <= enter_gate <= entry < exit_gate <= exit_at < end <= 2**64 - 1:
        raise ValueError("Exact native holding interval must lie inside the executed historical window")
    quantity = _stress_amount(model["quantity"])
    if not 0 < quantity <= 1_000_000 or _source_decimal(model["slippage_per_unit"]) != 0:
        raise ValueError("Only the recorded native whole-share zero-extra-slippage profile is supported")
    bounds = tuple(time_ns(manifest[k]) for k in ("startAtInclusive", "endAtExclusive", "captureTime"))
    seen, previous, eligible, holding, fill_index = set(), -1, 0, 0, 0
    peak = best_peak = best_trough = None
    best_numerator, best_denominator = 0, 1
    for line in lines[:-1]:
        row = _private_record(line, maximum=1_100_000)
        if (set(row) != {"eventId", "eventNs", "availableNs", "payload"}
                or type(row["payload"]) is not dict
                or type(row["eventId"]) is not str or not 1 <= len(row["eventId"]) <= 128):
            raise ValueError("Exact native captured event envelope required")
        event, available = row["eventNs"], row["availableNs"]
        if (type(event) is not int or type(available) is not int or row["eventId"] in seen
                or not bounds[0] <= event < bounds[1] or not event <= available <= bounds[2]
                or not previous < available <= 2**64 - 1):
            raise ValueError("Original native event identity/availability/order mismatch")
        seen.add(row["eventId"])
        previous = available
        quote = row["payload"]
        if (set(quote) != {"instrumentId", "bid", "ask", "bidSize", "askSize"}
                or quote["instrumentId"] != model["instrument_id"]):
            raise ValueError("Only exact original instrument L1 quotes can qualify historical stress")
        bid, ask = (_stress_amount(quote[k], cents=True) for k in ("bid", "ask"))
        bid_size, ask_size = (_stress_amount(quote[k]) for k in ("bidSize", "askSize"))
        if bid > ask:
            raise ValueError("Original crossed L1 quote is not native-qualified")
        if not start <= event <= available < end:
            continue
        eligible += 1
        # Same first eligible entry/exit predicates as the committed native
        # round trip. This verifies existing fills; it does not simulate new ones.
        entry_due = fill_index == 0 and enter_gate <= available < exit_gate and ask_size >= quantity
        exit_due = fill_index == 1 and available >= exit_gate and bid_size >= quantity
        if entry_due or exit_due:
            fill = fills[fill_index]
            if (fill["eventId"] != row["eventId"] or _natural(fill["availableNs"]) != available
                    or _stress_amount(fill["price"], cents=True) != (ask if entry_due else bid)
                    or _stress_amount(fill["quantity"]) != quantity):
                raise ValueError("Actual native fill does not join its first eligible original quote")
            fill_index += 1
        if entry <= available <= exit_at:
            holding += 1
        point = (bid + ask, row["eventId"], str(available))
        if peak is None or point[0] > peak[0]:
            peak = point
        numerator = (peak[0] - point[0]) * 10_000
        if best_peak is None or numerator * best_denominator > best_numerator * peak[0]:
            best_numerator, best_denominator = numerator, peak[0]
            best_peak, best_trough = peak, point
    if (fill_index != 2 or holding < 2 or eligible < 2 or best_peak is None
            or _natural(economic["nativeResult"]["iterations"]) != eligible):
        raise ValueError("Both actual fill joins and all native eligible/holding quote counts are required")
    return {"entryAvailableNs": str(entry), "exitAvailableNs": str(exit_at),
        "loadedQuoteCount": declared, "eligibleQuoteCount": eligible, "holdingQuoteCount": holding,
        "qualifyingQuoteCount": eligible,
        "peakEventId": best_peak[1], "peakAvailableNs": best_peak[2],
        "troughEventId": best_trough[1], "troughAvailableNs": best_trough[2],
        "drawdownBpsNumerator": str(best_numerator), "drawdownBpsDenominator": str(best_denominator)}


def project_historical_stress_observation(projection_bytes: bytes, *, method_bytes: bytes,
        handoff_bytes: bytes, originals: dict[str, bytes], manifest_bytes: bytes, content_bytes: bytes,
        projection_artifact_id: str, codec: CanonicalCodec, validator: AuthoritativeValidator) -> bytes | Unavailable:
    """Precommitted entire-window observed midpoint drawdown, not OOS qualification.

    Rule-only bytes are hashed in an immutable hypothesis assumption, BEFORE
    candidate evaluation. No method field hashes the experiment/mapping/recipe,
    avoiding a cyclic digest. Their post-run joins belong to the projection.
    Current original-source reviews attest capture provenance, not precommitment.
    Caller must prove experiment publication before producer admission through
    the dedicated committed reader and refresh all current authority.
    """
    if type(content_bytes) is not bytes or not 0 < len(content_bytes) <= 1_048_576:
        raise ValueError("Bounded original native quote bytes required before hashing or parsing")
    projection, method = (original_record(raw, codec=codec) for raw in (projection_bytes, method_bytes))
    if projection.get("profile") == STRESS_PROFILE:
        # Preserve immutable v1 artifacts, but never reinterpret their holding-
        # interval rule or later review as a scientific precommitment.
        return Unavailable(("historical-midpoint-stress-v1-precommitment-unavailable",))
    if set(projection) != STRESS_FIELDS or projection["profile"] != STRESS_PRECOMMITTED_PROFILE:
        raise ValueError("Closed precommitted historical midpoint stress v2 projection required")
    if (set(method) != {"format", "qualification", "performance"}
            or method["format"] != "vertex-backtest-historical-midpoint-stress-method-v2"
            or projection["method"] != {"identity": "vertex-backtest-historical-midpoint-stress",
                "version": "2.0.0", "digest": sha256(method_bytes).hexdigest()}):
        raise ValueError("Exact rule-only historical midpoint stress v2 method required")
    experiment = original_record(handoff_bytes, codec=codec)
    commitments = [value for value in experiment["hypothesis"]["assumptions"]
        if type(value) is str and value.startswith(STRESS_COMMITMENT_PREFIX)]
    if commitments != [STRESS_COMMITMENT_PREFIX + "2.0.0:sha256:" + sha256(method_bytes).hexdigest()]:
        return Unavailable(("historical-midpoint-stress-original-method-precommitment-unavailable",))
    if projection["window"] != experiment["windows"]["outOfSample"]:
        raise ValueError("Qualification requires the entire independently frozen native test window")
    Pin(**projection["method"])
    identity(projection_artifact_id)
    declaration = method["qualification"]
    fixed = {"statistic": "maximum-observed-midpoint-drawdown", "direction": "long-adverse",
        "price": "midpoint", "priceUnit": "USD/share", "unit": "bps", "operator": "gte",
        "window": "entire-frozen-native-test-window", "ordering": "native-available-ns",
        "arithmetic": "unreduced-integer-ratio"}
    if type(declaration) is not dict or set(declaration) != {*fixed, "threshold"} or any(
            declaration[key] != value for key, value in fixed.items()):
        raise ValueError("Explicit observed midpoint stress statistic/direction/window/units required")
    threshold = AcceptanceCriterion._decimal(declaration["threshold"])
    if not 0 < threshold < 10_000:
        raise ValueError("A positive precommitted drawdown threshold below 100 percent is required")
    metric = method["performance"]
    if (type(metric) is not dict or set(metric) != {"criterionId", "metricId", "unit", "operation", "operator", "threshold"}
            or metric["metricId"] != "net-pnl" or metric["unit"] != "USD"
            or metric["operation"] != "original-native-value" or metric["operator"] not in {"lt", "lte", "eq", "gte", "gt"}):
        raise ValueError("Separately precommitted original net-PnL USD criterion required")
    identity(metric["criterionId"])
    AcceptanceCriterion._decimal(metric["threshold"])
    for key, raw in (("manifest", manifest_bytes), ("content", content_bytes)):
        pin = projection[key]
        if type(pin) is not dict or set(pin) != {"input", "sha256"} or pin["sha256"] != sha256(raw).hexdigest():
            raise ValueError("Exact reviewed original manifest/content pin required")
        identity(pin["input"])
    run, result, lineage, mapping, recipe = _reproduction_source(projection["source"], originals,
        projection=projection, handoff_bytes=handoff_bytes, derived_lineage_digest=projection["derivedLineageDigest"],
        codec=codec, validator=validator)
    economic = result["economics"]
    if (economic["strategyModel"] != "reviewed-single-equity-time-gated-round-trip-v1"
            or economic["modelVersion"] != "1.0.0" or result["forwardAssessment"] is not None):
        raise ValueError("Only original native historical USD equity round-trip economics are supported")
    if (run["reviewStatus"] not in {"incomplete", "rejected"}
            or result["incidentCodes"] != ["native-model-realism-review-required"]
            or mapping["lineage"]["folds"] or mapping["lineage"]["forwardCriteria"] is not None):
        raise ValueError("Original native inconclusive historical-only status must be preserved")
    native = _private_record(base64.b64decode(recipe["model"]["native_configuration_bytes"], validate=True), maximum=1_048_576)
    instrument = native["instrument"]
    if (set(native) != {"format", "distribution", "instrument", "issuedNs", "expiresNs"}
            or native["format"] != "vertex-nautilus-research-v2"
            or set(instrument) != {"id", "rawSymbol", "currency", "pricePrecision", "priceIncrement", "lotSize"}
            or instrument["currency"] != "USD" or type(instrument["pricePrecision"]) is not int
            or instrument["pricePrecision"] != 2 or instrument["priceIncrement"] != "0.01" or instrument["lotSize"] != "1"):
        raise ValueError("Original native whole-share cent-price USD configuration required")
    manifest = public_record(manifest_bytes, "DatasetManifest", codec=codec, validator=validator)
    _stress_dataset(manifest=manifest, manifest_bytes=manifest_bytes, content=content_bytes,
        experiment=experiment, mapping=mapping, recipe=recipe, projection=projection)
    qualification = _stress_quotes(content_bytes, manifest=manifest, recipe=recipe, results=result, window=projection["window"])
    if codec.encode(projection["qualification"]) != codec.encode(qualification):
        raise ValueError("Reviewed quantitative qualification must equal the original quote calculation")
    threshold_numerator, threshold_denominator = threshold.as_integer_ratio()
    if (_natural(qualification["drawdownBpsNumerator"]) * threshold_denominator
            < threshold_numerator * _natural(qualification["drawdownBpsDenominator"])):
        return Unavailable(("observed-entire-window-midpoint-drawdown-below-precommitted-threshold",))
    # Native money strings may retain zeros. Only this derivative is rendered
    # in the gate's canonical decimal domain; original result bytes stay intact.
    value = _source_decimal(economic["metrics"]["net-pnl"])
    rendered = "0" if value == 0 else format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    AcceptanceCriterion._decimal(rendered)
    if type(economic["limitations"]) is not list or type(result["incidentCodes"]) is not list:
        raise ValueError("Original native limitations and incidents must remain explicit")
    limitations = [text(item) for item in economic["limitations"]]
    limitations.append("Observed entire-window midpoint drawdown is descriptive market qualification, "
                       "not executable loss, equity drawdown, liquidation stress or independent OOS evidence.")
    limitations.extend("Source incident: " + text(code) for code in result["incidentCodes"])
    limitations.extend("Lineage incident: " + codec.encode(incident).decode("utf-8")
                       for incident in lineage["lineage"]["incidents"])
    checks = run["leakageChecks"]
    if {c["kind"] for c in checks} != LEAKAGE_KINDS or any(c["status"] != "passed" for c in checks):
        limitations.append("Original backtest leakage evidence is incomplete or failed.")
    if run["reviewStatus"] in {"incomplete", "rejected"}:
        limitations.append("Original backtest computational review status is " + run["reviewStatus"] + ".")
    limitations = list(dict.fromkeys(limitations))
    if len(limitations) > 64 or any(len(item) > 4000 for item in limitations):
        return Unavailable(("historical-stress-source-limitations-exceed-observation-bound",))
    observation = {"format": "vertex-experiment-gate-observation-v1",
        "observationId": projection["observationId"], "experimentHash": projection["experimentHash"],
        "policyHash": projection["policyHash"], "gate": "stress",
        "producedAt": projection["producedAt"], "availableAt": projection["availableAt"],
        "window": projection["window"], "origin": "stress", "method": projection["method"],
        "provenanceId": projection_artifact_id, "provenanceHash": sha256(projection_bytes).hexdigest(),
        "reviewerId": projection["reviewerId"],
        "metrics": [{"criterionId": metric["criterionId"], "metricId": "net-pnl", "unit": "USD", "value": rendered}],
        "contaminated": any(c["status"] == "failed" for c in checks), "limitations": limitations}
    return encode_authoritatively(observation, codec)[0]
