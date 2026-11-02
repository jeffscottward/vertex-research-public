"""Reviewed Gamma recipes -> pure native computation -> unreviewed evidence.

No model/provider calls, committee-vote authority, execution or capital effects.
The input binding's provenance is usable only after an independent CURRENT
review of the exact ResearchEvidence whose contentHash binds those bytes.
"""
from __future__ import annotations

import base64
import json
import math
import re
from dataclasses import dataclass, fields
from datetime import datetime, timedelta, timezone
from typing import Any

from gamma.adapter import InputArtifact, NativeResearchArtifact, ResearchAdapter
from gamma.decision_adapter import GammaDecisionAdapter, ResearchInputDecision
from gamma.decimal_boundary import DecimalFieldRule, FloatDecimalPolicy
from gamma.engines.options_strategy_selector import StrategySelectionConstraints
from gamma.engines.portfolio_committee import PortfolioRiskConstraints
from gamma.publication import GammaPublicationPlanner

from .ports import AdapterUnavailable


MAX_NATIVE_BYTES = 700_000
MAX_NATIVE_ENCODED = ((MAX_NATIVE_BYTES + 2) // 3) * 4
MAX_AGE_NS = 31_536_000_000_000_000
REVIEW_FIELDS = {"collectionId", "evidenceId", "artifactId", "artifactSha256", "reviewId", "reviewVersion", "rightsPolicyId", "rightsVersion"}
RECIPE_FIELDS = {"profile", "module_id", "collection_id", "snapshot_id", "as_of", "max_input_age_ns", "inputs", "conversion", "operation", "publication"}
DECISION_OPERATIONS = frozenset({"options-selector", "portfolio-committee"})
# Exact authored keyword roles. No generic feature-name dispatch, synthetic
# signals/votes, inferred units, or substitution of a feature for a snapshot.
OPERATION_ROLES = {
    "options-selector": ({"setup", "option_chain"}, {"financial_context"}),
    "portfolio-committee": ({"portfolio"}, set()),
    "momentum": ({"rows"}, {"spy_rows", "qqq_rows"}),
    "market_structure": ({"rows"}, set()),
    "volatility": ({"payload"}, set()),
    "liquidity": (set(), {"stock_rows", "option_chain", "option_totals"}),
    "fundamental_catalyst": ({"payload"}, set()),
    "option_flow": ({"snapshot"}, set()),
    "identify_setup": ({"candidate", "research_brief", "flow_snapshot", "market_structure", "volatility"},
                       {"liquidity", "fundamental_catalyst", "market_regime"}),
}


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        raise AdapterUnavailable("gamma-profile-shape-invalid")
    return dict(value)


def _identifier(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is None:
        raise AdapterUnavailable("gamma-identity-invalid")
    return value


def _digest(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise AdapterUnavailable("gamma-digest-invalid")
    return value


def _reference(value: Any) -> dict[str, str]:
    result = _record(value, {"artifactId", "sha256"})
    _identifier(result["artifactId"])
    _digest(result["sha256"])
    return result


def _datetime(ns: int, *, expiry: bool = False) -> datetime:
    # Gamma's original datetime cannot represent sub-microsecond source time.
    # Reject input truncation; flooring an expiry is conservative, never a grant.
    if ns % 1000 and not expiry:
        raise AdapterUnavailable("gamma-nanosecond-source-not-representable")
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ns // 1000)


def _canonical(job: Any, content: bytes) -> dict[str, Any]:
    value = json.loads(content)
    if type(value) is not dict or job.context.contracts.encode(value) != content:
        raise AdapterUnavailable("gamma-canonical-input-required")
    return value


def _constraints(operation: str, value: Any) -> Any:
    kind = StrategySelectionConstraints if operation == "options-selector" else PortfolioRiskConstraints
    raw = _record(value, {field.name for field in fields(kind)})
    integers = {"min_dte", "max_dte", "min_open_interest", "min_volume"}
    converted = {}
    for name, number in raw.items():
        if name in integers:
            if type(number) is not int or not 0 <= number <= 9_007_199_254_740_991:
                raise AdapterUnavailable("gamma-integer-constraint-invalid")
            converted[name] = number
        elif number is None and name == "max_premium_per_trade":
            converted[name] = None
        else:
            if type(number) is not str or re.fullmatch(r"-?(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,18})?", number) is None:
                raise AdapterUnavailable("gamma-decimal-constraint-invalid")
            native = float(number)
            if not math.isfinite(native):
                raise AdapterUnavailable("gamma-nonfinite-constraint")
            converted[name] = native
    # Native bounds remain the Gamma adapter's responsibility. The original
    # reviewed decimal strings remain pinned by recipeSha256, not miscast as wire.
    return kind(**converted)


def _parameters(operation: str, value: Any) -> dict[str, str]:
    names = (set() if operation in ("option_flow", "identify_setup") else
             {"ticker", "timeframe"} if operation == "market_structure" else {"ticker"})
    parameters = _record(value, names)
    for text in parameters.values():
        if (type(text) is not str or not 1 <= len(text) <= 160
                or re.search(r"[\x00-\x1f\x7f\ud800-\udfff]", text) is not None):
            raise AdapterUnavailable("gamma-native-parameter-invalid")
    return parameters


def _native_research(operation: str, adapter: ResearchAdapter, sources: dict[str, InputArtifact],
                     parameters: dict[str, str]) -> NativeResearchArtifact:
    if operation == "momentum":
        return adapter.momentum(ticker=parameters["ticker"], rows=sources["rows"],
                                spy_rows=sources.get("spy_rows"), qqq_rows=sources.get("qqq_rows"))
    if operation == "market_structure":
        return adapter.market_structure(ticker=parameters["ticker"], rows=sources["rows"], timeframe=parameters["timeframe"])
    if operation == "volatility":
        return adapter.volatility(ticker=parameters["ticker"], payload=sources["payload"])
    if operation == "liquidity":
        return adapter.liquidity(ticker=parameters["ticker"], stock_rows=sources.get("stock_rows"),
                                 option_chain=sources.get("option_chain"), option_totals=sources.get("option_totals"))
    if operation == "fundamental_catalyst":
        return adapter.fundamental_catalyst(ticker=parameters["ticker"], payload=sources["payload"])
    if operation == "option_flow":
        return adapter.option_flow(snapshot=sources["snapshot"])
    if operation == "identify_setup":
        return adapter.identify_setup(candidate=sources["candidate"], research_brief=sources["research_brief"],
            flow_snapshot=sources["flow_snapshot"], market_structure=sources["market_structure"], volatility=sources["volatility"],
            liquidity=sources.get("liquidity"), fundamental_catalyst=sources.get("fundamental_catalyst"),
            market_regime=sources.get("market_regime"))
    raise AdapterUnavailable("gamma-operation-unavailable")


@dataclass(frozen=True)
class _Source:
    role: str
    source: InputArtifact
    evidence_bytes: bytes
    pin: dict[str, Any]
    binding_sha256: str
    source_kind: str


class _CurrentInputs:
    def __init__(self, job: Any, recipe: dict[str, Any], recipe_sha256: str):
        self.job, self.recipe, self.recipe_sha256 = job, recipe, recipe_sha256
        self.sources: list[_Source] = []
        self.as_of_ns = job.context.contracts.epoch_ns(recipe["as_of"])
        self.as_of = _datetime(self.as_of_ns)
        age = recipe["max_input_age_ns"]
        if type(age) is not str or re.fullmatch(r"[1-9][0-9]{0,29}", age) is None or int(age) > MAX_AGE_NS:
            raise AdapterUnavailable("gamma-freshness-policy-invalid")
        self.maximum_age_ns = int(age)

    def _review(self, pin: dict[str, Any], original: bytes) -> Any:
        self.job.check()
        review = self.job.control.rights.resolve_current(
            actor_id=self.job.lease["researchPrincipalId"], account_alias=self.job.lease["accountAlias"],
            environment=self.job.lease["environment"], collection_id=self.recipe["collection_id"],
            snapshot_id=self.recipe["snapshot_id"], evidence_id=pin["evidenceId"],
            artifact_digest=pin["artifactSha256"], original_bytes=original, purpose="research",
            reference_ns=self.job.clock.now_ns(), authorization=self.job.authorization, expected_pin=pin)
        if review is None:
            raise AdapterUnavailable("gamma-current-exact-review-unavailable")
        return review

    def load(self, value: Any) -> None:
        row = _record(value, {"role", "review", "binding"})
        pin = _record(row["review"], REVIEW_FIELDS)
        for name, item in pin.items():
            (_digest if name == "artifactSha256" else _identifier)(item)
        binding_ref = _reference(row["binding"])
        if pin["collectionId"] != self.recipe["collection_id"]:
            raise AdapterUnavailable("gamma-input-scope-mismatch")
        original = self.job.artifact({"artifactId": pin["artifactId"], "sha256": pin["artifactSha256"]}, collection_id=pin["collectionId"])
        evidence = _canonical(self.job, original)
        if (self.job.context.contracts.validate("ResearchEvidence", evidence, "1.0.0") is not True
                or evidence["evidenceId"] != pin["evidenceId"] or evidence["collectionId"] != pin["collectionId"]
                or evidence["snapshotId"] != self.recipe["snapshot_id"]
                or evidence["rightsPolicyId"] != pin["rightsPolicyId"]
                or evidence["contentHash"] != binding_ref["sha256"]
                or evidence["sourceIdentity"]["contentHash"] != binding_ref["sha256"]):
            raise AdapterUnavailable("gamma-reviewed-input-binding-mismatch")
        # acceptanceStatus is NOT consulted as current-review authority.
        self._review(pin, original)
        raw = self.job.artifact(binding_ref, collection_id=pin["collectionId"])
        binding = _record(_canonical(self.job, raw), {
            "profile", "role", "collection_id", "snapshot_id", "source_kind", "synthetic_reason",
            "observed_at", "available_at", "native_sha256", "native_json_base64"})
        if (binding["profile"] != "vertex-gamma-input-v1" or binding["role"] != row["role"]
                or binding["collection_id"] != pin["collectionId"] or binding["snapshot_id"] != self.recipe["snapshot_id"]
                or binding["source_kind"] not in ("real", "synthetic")):
            raise AdapterUnavailable("gamma-reviewed-source-scope-invalid")
        reason = binding["synthetic_reason"]
        if (binding["source_kind"] == "real" and reason is not None
                or binding["source_kind"] == "synthetic" and (type(reason) is not str or not 1 <= len(reason.strip()) <= 4000)):
            raise AdapterUnavailable("gamma-reviewed-provenance-invalid")
        observed = self.job.context.contracts.epoch_ns(binding["observed_at"])
        available = self.job.context.contracts.epoch_ns(binding["available_at"])
        captured = self.job.context.contracts.epoch_ns(evidence["capturedAt"])
        if not observed <= available <= captured <= self.as_of_ns or self.as_of_ns - observed > self.maximum_age_ns:
            raise AdapterUnavailable("gamma-input-not-point-in-time-qualified")
        encoded = binding["native_json_base64"]
        if type(encoded) is not str or not 4 <= len(encoded) <= MAX_NATIVE_ENCODED or not encoded.isascii():
            raise AdapterUnavailable("gamma-native-input-budget")
        native = base64.b64decode(encoded, validate=True)
        if (not native or len(native) > MAX_NATIVE_BYTES or base64.b64encode(native).decode("ascii") != encoded
                or self.job.input_bytes + len(native) > 16_000_000):
            raise AdapterUnavailable("gamma-native-input-budget")
        self.job.input_bytes += len(native)
        source = InputArtifact(content=native, expected_sha256=_digest(binding["native_sha256"]),
                               observed_at=_datetime(observed), available_at=_datetime(available))
        # No parse/re-encode substitutes for these original native bytes.
        self.sources.append(_Source(row["role"], source, original, pin, binding_ref["sha256"], binding["source_kind"]))

    def qualify(self, *, source: InputArtifact, as_of: datetime, operation: str) -> ResearchInputDecision:
        matches = [entry for entry in self.sources if entry.source is source]
        if len(matches) != 1 or as_of != self.as_of or operation != self.recipe["operation"]:
            raise AdapterUnavailable("gamma-qualification-scope-mismatch")
        entry = matches[0]
        review = self._review(entry.pin, entry.evidence_bytes)
        valid_until = _datetime(min(review.expires_ns, review.rights_valid_until_ns), expiry=True)
        if valid_until <= _datetime(self.job.clock.now_ns(), expiry=True):
            raise AdapterUnavailable("gamma-review-expired")
        return ResearchInputDecision(source.expected_sha256, entry.pin["evidenceId"], True, "fresh", valid_until,
            entry.source_kind, ("reviewed-binding-sha256:" + entry.binding_sha256,
                                "recipe-sha256:" + self.recipe_sha256,
                                "review:" + entry.pin["reviewId"] + "@" + entry.pin["reviewVersion"]))

    def refresh(self) -> dict[str, ResearchInputDecision]:
        return {entry.role: self.qualify(source=entry.source, as_of=self.as_of, operation=self.recipe["operation"])
                for entry in self.sources}


def run_gamma(job: Any, payload: Any) -> dict[str, Any]:
    row = _record(payload, {"profile", "recipe", "recipeArtifactId", "recipeSha256", "run_id", "trace_id",
                            "actor_id", "task_contract", "account_alias", "environment", "input_evidence_ids"})
    raw_recipe = row["recipe"]
    operation = raw_recipe.get("operation") if type(raw_recipe) is dict else None
    if type(operation) is not str or operation not in OPERATION_ROLES:
        raise AdapterUnavailable("gamma-operation-unavailable")
    recipe = _record(raw_recipe, RECIPE_FIELDS | ({"constraints"} if operation in DECISION_OPERATIONS else {"parameters"}))
    if row["profile"] != "vertex-gamma-research-v1" or recipe["profile"] != "vertex-gamma-recipe-v1":
        raise AdapterUnavailable("gamma-profile-unavailable")
    for name in ("run_id", "trace_id", "actor_id", "task_contract", "account_alias", "recipeArtifactId"):
        _identifier(row[name])
    for name in ("module_id", "collection_id", "snapshot_id"):
        _identifier(recipe[name])
    if (row["actor_id"], row["account_alias"], row["environment"]) != (
            job.lease["researchPrincipalId"], job.lease["accountAlias"], job.lease["environment"]):
        raise AdapterUnavailable("gamma-principal-scope-mismatch")
    selected = [pin for pin in job.selection["artifacts"] if pin["role"] == "tool-config"
                and pin["artifact"]["artifactId"] == row["recipeArtifactId"]
                and pin["artifact"]["artifactSha256"] == row["recipeSha256"]]
    if (len(selected) != 1 or job.context.contracts.digest(recipe) != _digest(row["recipeSha256"])
            or not any(module["moduleId"] == recipe["module_id"] and module["enabled"] is True for module in job.selection["modules"])):
        raise AdapterUnavailable("gamma-reviewed-recipe-unavailable")
    inputs = recipe["inputs"]
    if type(inputs) is not list or not 1 <= len(inputs) <= 8:
        raise AdapterUnavailable("gamma-input-membership-budget")
    roles = [item.get("role") for item in inputs if type(item) is dict]
    required, optional = OPERATION_ROLES[operation]
    if (len(roles) != len(inputs) or any(type(role) is not str for role in roles)
            or len(set(roles)) != len(roles) or not required <= set(roles) <= required | optional):
        raise AdapterUnavailable("gamma-input-role-mismatch")
    policy = _CurrentInputs(job, recipe, row["recipeSha256"])
    if policy.as_of_ns > job.clock.now_ns():
        raise AdapterUnavailable("gamma-future-cutoff")
    metadata = _record(recipe["publication"], {"evidenceId", "collectionId", "snapshotId", "sourceUri", "sourceIdentity",
        "sourceLocator", "attribution", "publishedAt", "capturedAt", "claim", "limitations", "rightsPolicyId"})
    identity = _record(metadata["sourceIdentity"], {"provider", "sourceId", "snapshotId"})
    _identifier(metadata["evidenceId"])
    for value in identity.values():
        _identifier(value)
    if (metadata["collectionId"] != recipe["collection_id"] or metadata["snapshotId"] != recipe["snapshot_id"]
            or metadata["sourceIdentity"]["snapshotId"] != recipe["snapshot_id"]
            or metadata["rightsPolicyId"] != job.rights_policy["policyId"]
            or not policy.as_of_ns <= job.context.contracts.epoch_ns(metadata["capturedAt"]) <= job.clock.now_ns()):
        raise AdapterUnavailable("gamma-publication-scope-mismatch")
    for item in inputs:
        policy.load(item)
    evidence_ids = [entry.pin["evidenceId"] for entry in policy.sources]
    command_ids = row["input_evidence_ids"]
    if (type(command_ids) is not list or len(set(evidence_ids)) != len(evidence_ids)
            or len(command_ids) != len(evidence_ids) or set(command_ids) != set(evidence_ids)
            or metadata["evidenceId"] in evidence_ids
            or metadata["evidenceId"] in {entry.pin["artifactId"] for entry in policy.sources}):
        raise AdapterUnavailable("gamma-command-evidence-mismatch")
    conversion_row = _record(recipe["conversion"], {field.name for field in fields(FloatDecimalPolicy)})
    rules = conversion_row["rules"]
    if type(rules) is not list or not 1 <= len(rules) <= 256:
        raise AdapterUnavailable("gamma-conversion-budget")
    conversion_row["rules"] = tuple(DecimalFieldRule(**_record(rule, {field.name for field in fields(DecimalFieldRule)})) for rule in rules)
    conversion = FloatDecimalPolicy(**conversion_row)
    constraints = _constraints(operation, recipe["constraints"]) if operation in DECISION_OPERATIONS else None
    parameters = _parameters(operation, recipe["parameters"]) if operation not in DECISION_OPERATIONS else None
    sources = {entry.role: entry.source for entry in policy.sources}
    job.check()
    admission = job.admit_private_research(row)
    if admission is not None:
        return admission
    planner = GammaPublicationPlanner(validate=job.context.contracts.validate, codec=job.context.contracts)
    if operation in DECISION_OPERATIONS:
        adapter = GammaDecisionAdapter(as_of=policy.as_of, input_policy=policy)
        decision = (adapter.select(**sources, constraints=constraints) if operation == "options-selector"
                    else adapter.allocate(portfolio=sources["portfolio"], constraints=constraints))
        job.check()
        if decision.status == "unavailable":
            return {"status": "unavailable", "reason": "gamma-input-or-computation-unavailable", "outputArtifactIds": [], "executionAuthorized": False}
        result_status = decision.status
        plan = planner.evidence(decision=decision, metadata=metadata, conversion=conversion)
    else:
        # Every supplied role crosses the same CURRENT review/rights port before
        # any pure native call; bindings alone never authorize their assertions.
        qualifications = policy.refresh()
        native = _native_research(operation, ResearchAdapter(as_of=policy.as_of), sources, parameters)
        job.check()
        result_status = "rejected" if operation == "identify_setup" and native.payload["rejection_reasons"] else "candidate"
        plan = planner.native_evidence(artifact=native, operation=operation, qualifications=qualifications,
            parameters=parameters, recipe_sha256=row["recipeSha256"], metadata=metadata, conversion=conversion)
    if plan.status != "candidate":
        return {"status": "unavailable", "reason": "gamma-publication-unavailable", "outputArtifactIds": [], "executionAuthorized": False}
    if (type(plan.content_bytes) is not bytes or type(plan.record_bytes) is not bytes
            or not 0 < len(plan.content_bytes) <= 1_048_576 or not 0 < len(plan.record_bytes) <= 1_048_576):
        raise AdapterUnavailable("gamma-publication-byte-budget")
    policy.refresh()
    # The existing worker source stage + publishArtifact commit binds both exact
    # output hashes atomically. Native hashes remain only within derived content.
    lineage = tuple(entry.pin["artifactId"] for entry in policy.sources)
    from vertex_control.client import ControlError
    content_id = "gamma-content-" + job.context.contracts.digest({"jobId": job.lease["jobId"], "contentSha256": plan.content_digest})
    try:
        job.control.artifacts.stage(artifact_id=content_id, content=plan.content_bytes,
            content_type="application/json", lineage_artifact_ids=lineage, collection_id=recipe["collection_id"],
            rights_policy_id=job.rights_policy["policyId"], rights_version=job.rights_policy["version"])
        policy.refresh()
        job.check()
        job.control.artifacts.publish_record(contract_name="ResearchEvidence", artifact_id=plan.evidence_id,
            content=plan.record_bytes, digest=plan.record_digest, collection_id=recipe["collection_id"],
            lineage_artifact_ids=lineage, rights_policy_id=job.rights_policy["policyId"], rights_version=job.rights_policy["version"],
            review_pins=tuple(entry.pin for entry in policy.sources))
    except ControlError as error:
        status = "unknown" if error.effect == "unknown" else "unavailable"
        return {"status": status, "reason": "gamma-publication-" + status, "outputArtifactIds": [], "executionAuthorized": False}
    return {"status": "completed", "decisionStatus": result_status, "outputArtifactIds": [plan.evidence_id],
            "contentSha256": plan.content_digest, "recordSha256": plan.record_digest,
            "proposalOnly": True, "acceptanceStatus": "unreviewed", "executionAuthorized": False}
