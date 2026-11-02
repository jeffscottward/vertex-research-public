"""Private Python chat boundary, not a worker-completion/publication pipeline.

The API owns original plan/approval/copy/admission and privacy issuance. This
consumer only verifies its bodyless projection, reads governed copies, and sends
the two approved buffers verbatim using the existing currentModelUse boundary.
No SDK, prompt reconstruction, output staging, retries, or successful noop.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from hashlib import sha256
import json
import math
import re
import threading
import time
from typing import Any, Mapping

from agents.adapters import _output
from agents.budget import usd_text, usd_units
from agents.chat_context import parse_research_chat_human_context_v1
from agents.evidence import check_output
from agents.types import AdvisoryOutput, Evidence, SYSTEM_INSTRUCTION
from providers.boundary import parse_json
from providers.ports import HttpRequest
from .agno import CHAT_OPTIONS, _schema
from .chat_inputs import (
    CHAT_DEBATE_SYSTEM_SUFFIX, ChatInputLimits, _HumanCodec, assert_chat_measured_tokens,
    canonical_chat_input_bytes, decode_chat_debate_plan, validate_chat_derived_context,
)
from .model_use import ModelUseRequests
from .configuration import RENDEZVOUS_PROFILES, PrivacyReviewRendezvous
from .ports import AdapterUnavailable


PROFILE = "vertex-research-chat-job-v1"
DEBATE_PROFILE = "vertex-research-chat-job-v2"
CONFIG_PROFILE = "vertex-research-chat-adapter-config-v1"
_COPY_PURPOSES = ("context", "tokenizeInput", "completionInput")
_REVIEW_KEYS = {"collectionId", "evidenceId", "artifactId", "artifactSha256", "reviewId",
                "reviewVersion", "rightsPolicyId", "rightsVersion"}
_MODEL_REF_KEYS = ("artifactId", "artifactSha256", "reviewId", "reviewVersion", "rightsPolicyId", "rightsVersion")
# Conservative UTF-8 JSON bounds derived from the strict real native contracts:
# ModelUseProof has 33 fields, <=32 ASCII key chars, scalar values <=160 ASCII
# chars, and <=128 reason identifiers. Chat ModelUseRequest has <=31 fields,
# no tools, and <=16 evidence references of six bounded scalar fields each.
# These are byte reservations, never fabricated request/proof authority.
MODEL_PROOF_MAXIMUM_BYTES = 2 + 33 * (32 + 3 + 162 + 1) + 2 + 128 * 163
MODEL_REQUEST_MAXIMUM_BYTES = 2 + 31 * (32 + 3 + 162 + 1) + 2 + 16 * (2 + 6 * (32 + 3 + 162 + 1))
CHAT_RESPONSE_MAXIMUM_BYTES = 1_048_576


class ChatTransportUnknown(AdapterUnavailable):
    """A durable dispatch or control effect may have happened. Never retry."""


def _require(value: Any, reason: str = "chat-input-binding-invalid") -> None:
    if not value:
        raise AdapterUnavailable(reason)


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    _require(type(value) is dict and set(value) == keys, "chat-shape-invalid")
    return value


def _input_json(content: bytes, *, maximum_bytes: int) -> Any:
    """Lossless approved Python input integers, not generic provider decimals.

    The generic response parser intentionally converts integers above 2**53 to
    decimal strings. Chat Evidence carries exact original integer nanoseconds;
    preserve them while rejecting floats, duplicate keys, and oversized trees.
    """
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            _require(key not in result, "chat-duplicate-json-key")
            result[key] = value
        return result

    def reject_number(value: str) -> None:
        raise AdapterUnavailable("chat-noninteger-json-number")

    try:
        _require(type(content) is bytes and 1 <= len(content) <= maximum_bytes)
        value = json.loads(content.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                           parse_float=reject_number, parse_constant=reject_number)
        # Existing pure codec enforces 48 depth, 50,000 nodes, 128 integer digits,
        # one MiB, no invalid Unicode, and only exact supported primitive types.
        canonical_chat_input_bytes(value)
        return value
    except Exception:
        raise AdapterUnavailable("chat-input-json-invalid") from None

def _response_json(content: bytes, *, maximum_bytes: int) -> Any:
    """Bounded strict JSON without provider-parser decimal-to-string coercion."""
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            _require(key not in result, "chat-response-duplicate-key")
            result[key] = value
        return result

    def nonfinite(value: str) -> None:
        raise AdapterUnavailable("chat-response-nonfinite-number")

    try:
        _require(type(content) is bytes and 1 <= len(content) <= maximum_bytes)
        parsed = json.loads(content.decode("utf-8", errors="strict"), object_pairs_hook=pairs, parse_constant=nonfinite)
        pending, count = [(parsed, 0)], 0
        while pending:
            value, depth = pending.pop()
            count += 1
            _require(count <= 50_000 and depth <= 24)
            if type(value) is dict:
                pending.extend((item, depth + 1) for pair in value.items() for item in pair)
            elif type(value) is list:
                pending.extend((item, depth + 1) for item in value)
            elif type(value) is str:
                _require(not any(0xD800 <= ord(char) <= 0xDFFF for char in value))
            elif type(value) is float:
                _require(math.isfinite(value))
        return parsed
    except Exception:
        raise AdapterUnavailable("chat-response-json-invalid") from None


def _checked_advisory(value: Any, evidence: tuple[Evidence, ...]) -> AdvisoryOutput:
    advisory = _output(value)
    check_output(advisory, {item.evidence_id: item for item in evidence})
    return advisory



def _id(value: Any) -> None:
    _require(type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is not None)


def _digest(value: Any) -> None:
    _require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None)


def _integer(value: Any, maximum: int = 9_007_199_254_740_991) -> None:
    _require(type(value) is int and 1 <= value <= maximum)


def _pin(value: Any) -> None:
    row = _record(value, {"artifactId", "artifactSha256", "contractName", "schemaVersion"})
    _id(row["artifactId"])
    _id(row["contractName"])
    _digest(row["artifactSha256"])
    _require(row["schemaVersion"] == "1.0.0")


def _decode_chat_recipe(value: Any, *, contracts: Any, profile: str) -> dict[str, Any]:
    """Frozen profile-specific bodyless projection; no defaults or authority."""
    # Defensive bounded capture prevents caller mutation between admission/read.
    raw = contracts.encode(value)
    _require(type(raw) is bytes and 1 <= len(raw) <= 262_144)
    row = _record(parse_json(raw, maximum_bytes=262_144), {
        "profile", "run_id", "trace_id", "actor_id", "account_alias", "environment",
        "response_request_id", "plan_id", "plan_sha256", "copies", "execution",
    })
    _require(row["profile"] == profile and row["environment"] == "research")
    for key in ("run_id", "trace_id", "actor_id", "account_alias", "response_request_id", "plan_id"):
        _id(row[key])
    _digest(row["plan_sha256"])
    copies = _record(row["copies"], {*_COPY_PURPOSES, "advisory"})
    for purpose in (*_COPY_PURPOSES, "advisory"):
        copy = _record(copies[purpose], {"copyId", "reservationSha256"} |
                       ({"content"} if purpose == "advisory" else {"sha256", "byteLength"}))
        _id(copy["copyId"])
        _digest(copy["reservationSha256"])
        if purpose == "advisory":
            _require(copy["content"] is None)
        else:
            _digest(copy["sha256"])
            _integer(copy["byteLength"], 1_048_576)
    _require(len({copy["copyId"] for copy in copies.values()}) == 4)
    execution = _record(row["execution"], {"taskContract", "collectionId", "snapshotId", "selectionId",
        "selectionSha256", "participantConfiguration", "inputPolicy", "provider", "budgets", "reviewPins", "deadlineAt",
        "advisoryMaximumBytes", "queuedRun"} | ({"debate"} if profile == DEBATE_PROFILE else set()))
    for key in ("taskContract", "collectionId", "snapshotId", "selectionId"):
        _id(execution[key])
    _digest(execution["selectionSha256"])
    _pin(execution["participantConfiguration"])
    _integer(execution["advisoryMaximumBytes"], 1_048_576)
    queued = _record(execution["queuedRun"], {"artifactId", "artifactSha256", "rightsPolicyId", "rightsVersion"})
    for key in ("artifactId", "rightsPolicyId", "rightsVersion"):
        _id(queued[key])
    _digest(queued["artifactSha256"])
    _require(type(execution["deadlineAt"]) is str)
    contracts.epoch_ns(execution["deadlineAt"])
    policy = _record(execution["inputPolicy"], {"modelPolicySha256", "modelPolicy", "endpointPolicySha256",
                                               "modelDescriptorSha256", "modelDescriptor"})
    for key in ("modelPolicy", "modelDescriptor"):
        _pin(policy[key])
        _digest(policy[key + "Sha256"])
    endpoints = _record(policy["endpointPolicySha256"], {"model-tokenize", "model-completion"})
    for digest in endpoints.values():
        _digest(digest)
    provider = _record(execution["provider"], {"providerId", "modelVersion", "servedModel", "tokenizerArtifact",
        "tokenizeEndpoint", "completionEndpoint", "maximumInputTokens", "maximumOutputTokens", "maximumCostUsd"})
    for key in ("providerId", "modelVersion", "servedModel"):
        _id(provider[key])
    for key in ("tokenizerArtifact", "tokenizeEndpoint", "completionEndpoint"):
        _pin(provider[key])
    for key in ("maximumInputTokens", "maximumOutputTokens"):
        _integer(provider[key])
    _require(provider["maximumOutputTokens"] < provider["maximumInputTokens"])
    usd_units(provider["maximumCostUsd"])
    budget = _record(execution["budgets"], {"requestTokens", "attemptTokens", "requestCostUsd",
                                          "attemptCostUsd", "tokenizeCostUsd", "completionCostUsd"})
    for key in ("requestTokens", "attemptTokens"):
        _integer(budget[key])
    for key in ("requestCostUsd", "attemptCostUsd", "tokenizeCostUsd", "completionCostUsd"):
        usd_units(budget[key])
    if profile == DEBATE_PROFILE:
        debate = decode_chat_debate_plan(execution["debate"], contracts=contracts)
        _require(budget["requestTokens"] <= debate["turnTokens"]
                 and usd_units(budget["requestCostUsd"]) <= usd_units(debate["turnCostUsd"]))
        _require(all(pin["responseRequestId"] != row["response_request_id"]
                     and pin["runId"] != row["run_id"] and pin["planId"] != row["plan_id"]
                     and pin["copyId"] != copies["advisory"]["copyId"] for pin in debate["predecessors"]))
    reviews = execution["reviewPins"]
    _require(type(reviews) is list and 1 <= len(reviews) <= 16)
    for review in reviews:
        _record(review, _REVIEW_KEYS)
        for key, item in review.items():
            (_digest if key == "artifactSha256" else _id)(item)
        _require(review["collectionId"] == execution["collectionId"])
    _require(len({p["evidenceId"] for p in reviews}) == len(reviews))
    _require(len({p["artifactId"] for p in reviews}) == len(reviews))
    return row


def decode_chat_recipe(value: Any, *, contracts: Any) -> dict[str, Any]:
    """Unchanged strict v1 decoder: v2/derived additions are rejected."""
    return _decode_chat_recipe(value, contracts=contracts, profile=PROFILE)


def decode_chat_recipe_v2(value: Any, *, contracts: Any) -> dict[str, Any]:
    """Explicit v2 decoder; the first turn also requires an exact debate plan."""
    return _decode_chat_recipe(value, contracts=contracts, profile=DEBATE_PROFILE)


@dataclass(frozen=True)
class ChatTransportResult:
    """Transient actual result only. Never a stage, AgentRun, or delivery ACK."""
    input_tokens: int
    output_tokens: int
    completion_cost_usd: str
    advisory: AdvisoryOutput = field(repr=False)
    human_context: Any = field(repr=False)
    evidence: tuple[Evidence, ...] = field(repr=False)
    completion_request: dict[str, Any] = field(repr=False)
    completion_response: bytes = field(repr=False)
    completion_proof: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class _ModelExchange:
    request: dict[str, Any] = field(repr=False)
    response: bytes = field(repr=False)
    post_return_proof: dict[str, Any] = field(repr=False)


class ApprovedChatConsumer:
    def __init__(self, job: Any, recipe: dict[str, Any]):
        self.job = job
        self.contracts = job.context.contracts
        self.recipe = self._decode_recipe(recipe)
        self.execution = self.recipe["execution"]
        self.provider = self.execution["provider"]
        self.budgets = self.execution["budgets"]
        self.policy = job.config.model
        self.descriptor = job.config.model_descriptor
        self._lock = threading.Lock()
        self._started = False
        self._copies: dict[str, bytes] = {}
        self._evidence: tuple[Evidence, ...] = ()
        self._human = None
        self._validate_bindings()
        self.requests = ModelUseRequests(config=job.config, selection=job.selection,
                                         lease=job.lease, contracts=self.contracts)

    def _decode_recipe(self, recipe: dict[str, Any]) -> dict[str, Any]:
        decoder = decode_chat_recipe_v2 if recipe.get("profile") == DEBATE_PROFILE else decode_chat_recipe
        return decoder(recipe, contracts=self.contracts)

    def _native_profile(self) -> bool:
        return False

    def _selected(self, role: str, pin: dict[str, Any], binding_id: str | None = None) -> None:
        matches = [row for row in self.job.selection["artifacts"] if row["role"] == role
                   and row["artifact"] == pin and (binding_id is None or row["bindingId"] == binding_id)]
        _require(len(matches) == 1, "chat-selected-pin-mismatch")

    def _validate_bindings(self) -> None:
        job, row, execution = self.job, self.recipe, self.execution
        from .configuration import NATIVE_EVIDENCE_PROFILE
        profiles = (CONFIG_PROFILE, *RENDEZVOUS_PROFILES, NATIVE_EVIDENCE_PROFILE) if self._native_profile() else (CONFIG_PROFILE, *RENDEZVOUS_PROFILES)
        _require(job.config.profile in profiles and self.policy is not None
                 and self.descriptor is not None and job.config.model_use is not None,
                 "chat-model-role-split-required")
        self.rendezvous = getattr(job.config, "privacy_review_rendezvous", None)
        _require((job.config.profile in (*RENDEZVOUS_PROFILES, NATIVE_EVIDENCE_PROFILE)) == isinstance(self.rendezvous, PrivacyReviewRendezvous),
                 "chat-privacy-review-config-mismatch")
        if self.rendezvous is not None:
            _require(self.recipe["profile"] == PROFILE or self._native_profile(), "chat-rendezvous-first-mate-only")
        self.policy.require()
        _require(job.lease["kind"] == "research-run" and row["environment"] == job.lease["environment"]
                 and row["account_alias"] == job.lease["accountAlias"]
                 and row["actor_id"] == job.lease["researchPrincipalId"]
                 and self.contracts.digest(row) == job.lease["payloadSha256"]
                 and execution["selectionId"] == job.selection["selectionId"] == job.config.selection_id
                 and execution["selectionSha256"] == job.selection["selectionSha256"] == job.config.selection_sha256
                 and execution["deadlineAt"] == job.lease["deadlineAt"]
                 and self.contracts.epoch_ns(execution["deadlineAt"]) == job.deadline)
        bindings = job.selection["artifacts"]
        _require(len({b["artifact"]["artifactId"] for b in bindings}) == len(bindings)
                 and len({b["bindingId"] for b in bindings}) == len(bindings)
                 and len([b for b in bindings if b["role"] == "model"]) == 1)
        input_policy = execution["inputPolicy"]
        _require(input_policy["modelPolicy"]["artifactId"] == job.config.model_policy_artifact_id
                 and input_policy["modelDescriptor"]["artifactId"] == job.config.model_artifact_id)
        self._selected("tool-config", input_policy["modelPolicy"])
        self._selected("model", input_policy["modelDescriptor"])
        model_digest = sha256(canonical_chat_input_bytes(asdict(self.policy))).hexdigest()
        descriptor = {**self.descriptor, "pricing": dict(self.descriptor["pricing"])}
        _require(input_policy["modelPolicySha256"] == model_digest
                 and input_policy["modelPolicy"]["artifactSha256"] == model_digest
                 and input_policy["modelDescriptorSha256"] == self.contracts.digest(descriptor)
                 and input_policy["modelDescriptor"]["artifactSha256"] == self.contracts.digest(descriptor))
        p = self.provider
        _require(p["modelVersion"] == self.policy.model_version == descriptor["modelVersion"]
                 and p["servedModel"] == self.policy.served_model
                 and p["providerId"] == descriptor["providerId"]
                 and descriptor["accountAlias"] == row["account_alias"] and descriptor["environment"] == "research"
                 and descriptor["tokenizerArtifactId"] == p["tokenizerArtifact"]["artifactId"]
                 == job.config.model_use.tokenizer_artifact_id
                 and descriptor["tokenizerSha256"] == p["tokenizerArtifact"]["artifactSha256"] == self.policy.tokenizer_sha256
                 and descriptor["modelUsePolicyVersion"] == job.config.model_use.model_use_policy_version
                 and job.config.model_use.purpose == "research")
        self._selected("tokenizer", p["tokenizerArtifact"])
        selected = {e.endpoint_id: e for e in job.config.endpoint_policies}
        self.tokenize, self.complete = selected[self.policy.tokenize_endpoint_id], selected[self.policy.completion_endpoint_id]
        _require(self.tokenize.origin == self.complete.origin
                 and self.tokenize.allowed_ip_addresses == self.complete.allowed_ip_addresses)
        for endpoint, operation, pin_key, path in (
            (self.tokenize, "model-tokenize", "tokenizeEndpoint", "/tokenize"),
            (self.complete, "model-completion", "completionEndpoint", "/v1/chat/completions"),
        ):
            self._selected("endpoint", p[pin_key], endpoint.endpoint_id)
            # Endpoint dataclasses use tuples; the approved policy DTO uses arrays.
            document = asdict(endpoint)
            for key in ("allowed_query_keys", "allowed_ip_addresses"):
                document[key] = list(document[key])
            digest = sha256(canonical_chat_input_bytes(document)).hexdigest()
            _require(endpoint.operation == operation and endpoint.method == "POST" and endpoint.path == path
                     and endpoint.provider == p["providerId"] and not endpoint.allowed_query_keys
                     and input_policy["endpointPolicySha256"][operation] == digest == p[pin_key]["artifactSha256"])
        _require(descriptor["endpointReferenceId"] == self.complete.endpoint_id
                 and descriptor["endpointSha256"] == p["completionEndpoint"]["artifactSha256"])
        research = job.selection["research"]
        _require(research is not None and research["modelVersion"] == self.policy.model_version
                 and research["taskContract"] == execution["taskContract"])
        b = self.budgets
        self.limits = ChatInputLimits(p["maximumInputTokens"], p["maximumOutputTokens"], b["requestTokens"],
            b["attemptTokens"], research["tokenBudget"], b["requestCostUsd"], b["attemptCostUsd"],
            research["costBudgetUsd"], p["maximumCostUsd"], b["tokenizeCostUsd"], b["completionCostUsd"])
        _require(b["attemptTokens"] <= b["requestTokens"] <= research["tokenBudget"])
        assert_chat_measured_tokens(limits=self.limits, policy=self.policy, count=p["maximumInputTokens"])
        total = usd_units(b["tokenizeCostUsd"]) + usd_units(b["completionCostUsd"])
        _require(total <= usd_units(p["maximumCostUsd"]) and total <= usd_units(b["attemptCostUsd"])
                 <= usd_units(b["requestCostUsd"]) <= usd_units(research["costBudgetUsd"]))
        ceiling_cost = (p["maximumInputTokens"] * usd_units(self.policy.input_usd_per_million)
                        + p["maximumOutputTokens"] * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
        _require(ceiling_cost <= usd_units(b["completionCostUsd"]), "chat-configured-cost-budget")
        self._check()

    def _check(self) -> None:
        self.job.check()
        now = self.job.clock.now_ns()
        for expiry in (self.descriptor["expiresAt"], self.descriptor["pricing"]["expiresAt"]):
            _require(now < self.job.deadline <= self.contracts.epoch_ns(expiry), "chat-model-descriptor-expired")

    def _read_copy(self, purpose: str) -> bytes:
        pin = self.recipe["copies"][purpose]
        self._check()
        content = self.job.control.artifacts.read_governed_copy(copy_id=pin["copyId"], expected_digest=pin["sha256"],
            expected_length=pin["byteLength"], deadline_ns=self.job.deadline, cancellation=self.job.cancel)
        _require(type(content) is bytes and len(content) == pin["byteLength"]
                 and sha256(content).hexdigest() == pin["sha256"], "chat-copy-content-mismatch")
        self._check()
        return content

    def _load_inputs(self) -> None:
        self._copies = {purpose: self._read_copy(purpose) for purpose in _COPY_PURPOSES}
        values = {}
        for purpose, body in self._copies.items():
            value = _input_json(body, maximum_bytes=1_048_576)
            _require(canonical_chat_input_bytes(value) == body, "chat-input-noncanonical")
            values[purpose] = value
        human = parse_research_chat_human_context_v1(values["context"], codec=_HumanCodec())
        _require(human.account_alias == self.recipe["account_alias"] and human.environment == "research"
                 and human.owner_actor_id == self.recipe["actor_id"]
                 and human.response_request_id == self.recipe["response_request_id"]
                 and human.participant_config_sha256 == self.execution["participantConfiguration"]["artifactSha256"])
        if self.rendezvous is not None:
            _require(human.participant_id == "first-mate", "chat-rendezvous-first-mate-only")
        token = _record(values["tokenizeInput"], {"model", "messages", *CHAT_OPTIONS, "tools", "return_token_strs"})
        complete = _record(values["completionInput"], {"model", "messages", *CHAT_OPTIONS, "store", "max_completion_tokens",
            "response_format", "stream", "n", "tool_choice", "truncate_prompt_tokens", "skip_special_tokens"})
        _require(token["tools"] is None and token["return_token_strs"] is False
                 and complete["store"] is False and complete["stream"] is False
                 and type(complete["n"]) is int and complete["n"] == 1
                 and complete["tool_choice"] == "none" and complete["truncate_prompt_tokens"] is None
                 and complete["skip_special_tokens"] is True
                 and type(complete["max_completion_tokens"]) is int
                 and complete["max_completion_tokens"] == self.provider["maximumOutputTokens"]
                 and canonical_chat_input_bytes(complete["response_format"]) == canonical_chat_input_bytes(
                     {"type": "json_schema", "json_schema": {"name": "vertex_advisory_v1", "schema": _schema(()), "strict": True}}))
        for body in (token, complete):
            _require(body["model"] == self.policy.served_model
                     and canonical_chat_input_bytes({key: body[key] for key in CHAT_OPTIONS}) == canonical_chat_input_bytes(CHAT_OPTIONS))
        messages = token["messages"]
        _require(type(messages) is list and len(messages) == 2 and complete["messages"] == messages)
        for message in messages:
            _record(message, {"role", "content"})
            _require(type(message["content"]) is str)
        v2 = self.recipe["profile"] == DEBATE_PROFILE
        system = SYSTEM_INSTRUCTION + (CHAT_DEBATE_SYSTEM_SUFFIX if v2 else "")
        _require(messages[0] == {"role": "system", "content": system} and messages[1]["role"] == "user")
        envelope = _record(_input_json(messages[1]["content"].encode("utf-8"), maximum_bytes=500_000),
                           {"data", "inert_tool_names", "response_contract", "execution_authorized"})
        _require(envelope["inert_tool_names"] == [] and envelope["execution_authorized"] is False
                 and canonical_chat_input_bytes(envelope["response_contract"]) == canonical_chat_input_bytes(_schema(())))
        data = _record(envelope["data"], {"phase", "task", "evidence", "prior_analyses", "tool_results",
                       "untrusted_content", "human_context"} | ({"derived_context"} if v2 else set()))
        _require(data["phase"] == "synthesis" and data["prior_analyses"] == [] and data["tool_results"] == []
                 and data["untrusted_content"] is True and data["human_context"] == values["context"]
                 and type(data["task"]) is str and 10 <= len(data["task"].encode("utf-16-le")) // 2 <= 2_000)
        _require(type(data["evidence"]) is list and len(data["evidence"]) == len(self.execution["reviewPins"]))
        evidence = []
        for item, pin in zip(data["evidence"], self.execution["reviewPins"]):
            _record(item, {f.name for f in fields(Evidence)})
            _require(item["evidence_id"] == pin["evidenceId"] and item["artifact_digest"] == pin["artifactSha256"]
                     and item["accepted_review_id"] == pin["reviewId"] and item["rights_policy_id"] == pin["rightsPolicyId"]
                     and item["collection_id"] == pin["collectionId"] and item["snapshot_id"] == self.execution["snapshotId"]
                     and item["untrusted_content"] is True and type(item["excerpt"]) is str
                     and 1 <= len(item["excerpt"].encode("utf-16-le")) // 2 <= 8_000
                     and sha256(item["excerpt"].encode("utf-8")).hexdigest() == item["excerpt_digest"])
            for key in ("captured_ns", "valid_until_ns", "accepted_review_revision"):
                _require(type(item[key]) is int and 0 <= item[key] <= 2**127 - 1)
            _require(item["accepted_review_revision"] > 0 and item["captured_ns"] < item["valid_until_ns"]
                     and item["valid_until_ns"] >= self.job.deadline
                     and (item["published_ns"] is None or type(item["published_ns"]) is int and 0 <= item["published_ns"] <= 2**127 - 1))
            evidence.append(Evidence(**item))
        self._human, self._evidence = human, tuple(evidence)
        if v2:
            validate_chat_derived_context(debate=self.execution["debate"], derived_context=data["derived_context"],
                human_context=human, evidence=self._evidence, contracts=self.contracts)
        price = self.descriptor["pricing"]
        for purpose, endpoint in (("tokenizeInput", self.tokenize), ("completionInput", self.complete)):
            _require(len(self._copies[purpose]) <= endpoint.maximum_request_bytes)
        _require(usd_units(self.budgets["tokenizeCostUsd"]) >= usd_units(price["tokenizationBaseUsd"])
                 + len(self._copies["tokenizeInput"]) * usd_units(price["tokenizationInputByteUsd"]))
        _require(usd_units(self.budgets["completionCostUsd"]) >= usd_units(price["completionBaseUsd"])
                 + len(self._copies["completionInput"]) * usd_units(price["completionInputByteUsd"])
                 + self.provider["maximumOutputTokens"] * usd_units(price["outputTokenUsd"]))

    def _refresh(self, endpoint: Any) -> tuple[dict[str, Any], ...]:
        self._check()
        admission = self.job.admit_private_research(self.recipe)
        if admission is not None:
            if admission.get("status") == "unknown":
                raise ChatTransportUnknown("chat-admission-unknown")
            raise AdapterUnavailable("chat-admission-unavailable")
        # Current server read rejoins the original response and input-copy fence;
        # byte equality also rejects a copy that changed after initial decoding.
        for purpose in self._refresh_purposes():
            _require(self._read_copy(purpose) == self._copies[purpose], "chat-copy-changed")
        rights = self.job.control.rights
        for pin in self.execution["reviewPins"]:
            original = self.job.control.artifacts.read(artifact_id=pin["artifactId"],
                expected_digest=pin["artifactSha256"], collection_id=pin["collectionId"])
            rights.read_current_review_receipt(actor_id=self.recipe["actor_id"],
                account_alias=self.recipe["account_alias"], environment="research", collection_id=pin["collectionId"],
                snapshot_id=self.execution["snapshotId"], evidence_id=pin["evidenceId"], artifact_digest=pin["artifactSha256"],
                original_bytes=original, purpose="research", reference_ns=self.job.clock.now_ns(),
                authorization=self.job.authorization, expected_pin=pin)
        refs = self._current_evidence_refs(rights)
        expected = tuple({key: pin[key] for key in _MODEL_REF_KEYS} for pin in self.execution["reviewPins"])
        _require(refs == expected, "chat-original-review-mismatch")
        self.job.capability(provider=endpoint.provider, operation=endpoint.operation, model_version=self.policy.model_version)
        self.job.authorize_endpoint(endpoint)
        self._check()
        return refs

    def _refresh_purposes(self) -> tuple[str, ...]:
        return _COPY_PURPOSES

    def _current_evidence_refs(self, rights: Any) -> tuple[dict[str, Any], ...]:
        return rights.model_evidence_refs(self._evidence)

    def _model_tools(self, endpoint: Any) -> tuple[str, ...]:
        return ()

    def _request_limits(self, endpoint: Any) -> tuple[int, str]:
        tokenizing = endpoint.operation == "model-tokenize"
        return (0 if tokenizing else self.provider["maximumOutputTokens"],
                self.budgets["tokenizeCostUsd" if tokenizing else "completionCostUsd"])

    def _send_model_request(self, endpoint: Any, encoded: bytes, response_limit: int,
                            authorize_disclosure: Any) -> Any:
        return self.job.transport().request_until(HttpRequest(endpoint.provider, endpoint.operation, "POST",
            endpoint.origin, endpoint.path, body=encoded, maximum_response_bytes=response_limit,
            timeout_ms=endpoint.timeout_ms), deadline_ns=self.job.deadline, authorize_disclosure=authorize_disclosure)

    def _privacy_candidate_id(self, request: dict[str, Any]) -> str:
        return "chat-candidate-" + self.contracts.digest({
            "responseRequestId": self.recipe["response_request_id"], "planId": self.recipe["plan_id"],
            "planSha256": self.recipe["plan_sha256"], "request": request})

    def _await_privacy_review(self, request: dict[str, Any]) -> None:
        limits = self.rendezvous
        if limits is None:
            return  # Existing preissued profile is unchanged, including no wait.
        self._check()
        candidate_id = self._privacy_candidate_id(request)
        until = min(self.job.deadline, self.job.clock.now_ns() + limits.maximum_wait_ms * 1_000_000)
        monotonic_end = time.monotonic() + limits.maximum_wait_ms / 1000
        unresolved_submit = False

        def check():
            self._check()
            _require(self.job.clock.now_ns() < until and time.monotonic() < monotonic_end,
                     "chat-privacy-review-wait-expired")

        def observe(prepare):
            check()
            with self.job.control.rights.operation(until, self.job.cancel):
                return self.job.control.rights.model_privacy_review(request=request, prepare=prepare, deadline_ns=until)

        try:
            try:
                status = observe(True)  # Exactly one submission in this invocation.
            except Exception as error:
                if getattr(error, "effect", None) != "unknown":
                    raise
                unresolved_submit, status = True, None
            reads = 0
            while True:
                check()
                if status is not None:
                    _record(status, {"candidateId", "requestId", "requestSha256", "status", "expiresAt"})
                    _require(status["candidateId"] == candidate_id and status["requestId"] == request["requestId"]
                             and status["requestSha256"] == request["requestSha256"], "chat-privacy-review-identity")
                    if status["status"] == "not-observed":
                        _require(status["expiresAt"] is None, "chat-privacy-review-status-invalid")
                        raise ChatTransportUnknown("chat-privacy-review-submit-unresolved")
                    _require(status["status"] in ("pending", "accepted", "rejected"))
                    until = min(until, self.contracts.epoch_ns(status["expiresAt"]))
                    check()
                    unresolved_submit = False
                    if status["status"] == "accepted":
                        return  # NOT authority: original currentModelUse still runs.
                    _require(status["status"] == "pending", "chat-privacy-review-rejected")
                _require(reads < limits.maximum_status_reads, "chat-privacy-review-read-limit")
                if status is not None:
                    wake = min(monotonic_end, time.monotonic() + limits.poll_interval_ms / 1000)
                    while time.monotonic() < wake:
                        check()
                        time.sleep(min(0.05, max(0, wake - time.monotonic())))
                reads += 1
                status = observe(False)  # Lost ACK uses preknown exact request only.
        except Exception:
            if unresolved_submit:
                raise ChatTransportUnknown("chat-privacy-review-submit-unresolved") from None
            raise

    def _request(self, endpoint: Any, purpose: str, count: int | None) -> _ModelExchange:
        encoded = self._copies[purpose]
        tokenizing = endpoint.operation == "model-tokenize"
        refs = tuple({key: pin[key] for key in _MODEL_REF_KEYS} for pin in self.execution["reviewPins"])
        maximum_output, maximum_cost = self._request_limits(endpoint)
        request = self.requests.request(operation=endpoint.operation, input_bytes=encoded, evidence_refs=refs,
            deadline_ns=self.job.deadline, input_tokens=count, maximum_output_tokens=maximum_output,
            maximum_cost_usd=maximum_cost, tools=self._model_tools(endpoint))
        _require(len(self.contracts.encode(request)) <= MODEL_REQUEST_MAXIMUM_BYTES, "chat-model-request-budget")
        self._await_privacy_review(request)
        checks = 0
        dispatched = False
        uncertain = False
        post_return_proof = None
        response_limit = endpoint.maximum_response_bytes if tokenizing else min(endpoint.maximum_response_bytes, CHAT_RESPONSE_MAXIMUM_BYTES)

        def authorize_disclosure() -> None:
            nonlocal checks, dispatched, uncertain, post_return_proof
            # HttpsTransport invokes once before its sole send and once after
            # response. No dispatch retries, even if a caller reuses the object.
            try:
                _require(checks < 2, "chat-transport-replay-denied")
                with self.job.control.rights.operation(self.job.deadline, self.job.cancel):
                    _require(self._refresh(endpoint) == refs)
                    proof = self.job.control.rights.authorize_model_use(request=request, input_bytes=encoded,
                                                                       deadline_ns=self.job.deadline)
                    _require(proof.get("decision") == "allowed" and proof.get("requestSha256") == request["requestSha256"],
                             "chat-model-use-denied")
                    if checks == 0 and proof.get("externalDispatchAllowed") is False:
                        # An earlier durable dispatch exists. Its outcome is not
                        # absence, and this worker cannot recover it by sending.
                        raise ChatTransportUnknown("chat-prior-dispatch-unresolved")
                    _require(proof.get("externalDispatchAllowed") is (checks == 0), "chat-model-use-denied")
                    proof_bytes = self.contracts.encode(dict(proof))
                    _require(self.contracts.validate("ModelUseProof", proof, "1.0.0") is True
                             and len(proof_bytes) <= MODEL_PROOF_MAXIMUM_BYTES, "chat-model-proof-budget")
                    if checks == 1:
                        post_return_proof = json.loads(proof_bytes)
                    checks += 1
                    if checks == 1:
                        dispatched = True
                    self._check()
            except Exception as error:
                # HttpsTransport intentionally sanitizes arbitrary callback
                # exceptions; retain effect uncertainty outside that wrapper.
                uncertain = uncertain or isinstance(error, ChatTransportUnknown) or getattr(error, "effect", None) == "unknown"
                raise

        try:
            _require(self.job.gate.acquire(endpoint.provider, endpoint.policy_id, self.job.clock.now_ns(), 1),
                     "chat-shared-rate-admission-denied")
            with self.job.control.rights.operation(self.job.deadline, self.job.cancel):
                response = self._send_model_request(endpoint, encoded, response_limit, authorize_disclosure)
            _require(checks == 2 and dispatched and post_return_proof is not None, "chat-transport-proof-missing")
            _require(response.status_code == 200 and type(response.body) is bytes
                     and len(response.body) <= response_limit, "chat-provider-response-unavailable")
            self._check()
            return _ModelExchange(json.loads(self.contracts.encode(request)), response.body, post_return_proof)
        except Exception as error:
            if dispatched or uncertain or isinstance(error, ChatTransportUnknown) or getattr(error, "effect", None) == "unknown":
                raise ChatTransportUnknown("chat-model-dispatch-unknown") from None
            raise AdapterUnavailable("chat-model-dispatch-denied") from None

    def consume(self) -> ChatTransportResult:
        """Single-use, in-memory boundary result; not worker success."""
        with self._lock:
            if self._started:
                raise ChatTransportUnknown("chat-consumer-replay-unknown")
            self._started = True
        try:
            self._check()
            admission = self.job.admit_private_research(self.recipe)
            if admission is not None:
                if admission.get("status") == "unknown":
                    raise ChatTransportUnknown("chat-admission-unknown")
                raise AdapterUnavailable("chat-admission-unavailable")
            self._load_inputs()
            measured = _response_json(self._request(self.tokenize, "tokenizeInput", None).response,
                                      maximum_bytes=self.tokenize.maximum_response_bytes)
            _require(type(measured) is dict)
            count, ids = measured.get("count"), measured.get("tokens")
            _integer(count, self.policy.maximum_context_tokens)
            _require(type(ids) is list and len(ids) == count and all(type(token) is int and token >= 0 for token in ids)
                     and type(measured.get("max_model_len")) is int
                     and measured["max_model_len"] == self.policy.maximum_context_tokens)
            assert_chat_measured_tokens(limits=self.limits, policy=self.policy, count=count)
            # Only the measured count is needed during the completion rendezvous.
            del measured, ids
            max_cost = (count * usd_units(self.policy.input_usd_per_million)
                        + self.provider["maximumOutputTokens"] * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
            _require(max_cost <= usd_units(self.budgets["completionCostUsd"]), "chat-completion-cost-budget")
            # Fixed approved max_completion_tokens is NEVER reallocated here.
            exchange = self._request(self.complete, "completionInput", count)
            response = _response_json(exchange.response, maximum_bytes=CHAT_RESPONSE_MAXIMUM_BYTES)
            _require(type(response) is dict and response.get("model") == self.policy.served_model)
            usage = response.get("usage")
            _require(type(usage) is dict)
            inputs, outputs, total = usage.get("prompt_tokens"), usage.get("completion_tokens"), usage.get("total_tokens")
            _require(all(type(n) is int and 0 <= n <= 9_007_199_254_740_991 for n in (inputs, outputs, total)) and inputs == count
                     and outputs <= self.provider["maximumOutputTokens"] and total == inputs + outputs
                     and total <= min(self.limits.request_tokens, self.limits.attempt_tokens,
                                      self.limits.selection_tokens, self.policy.maximum_context_tokens))
            cost = (inputs * usd_units(self.policy.input_usd_per_million)
                    + outputs * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
            _require(cost <= usd_units(self.budgets["completionCostUsd"]))
            choices = response.get("choices")
            _require(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict
                     and choices[0].get("finish_reason") == "stop")
            message = choices[0].get("message")
            _require(type(message) is dict and message.get("role") == "assistant" and not message.get("refusal")
                     and not message.get("tool_calls") and not message.get("function_call")
                     and type(message.get("content")) is str)
            parsed = _record(_response_json(message["content"].encode("utf-8"), maximum_bytes=500_000), {"output", "tool_requests"})
            _require(parsed["tool_requests"] == [])
            advisory = _checked_advisory(parsed["output"], self._evidence)
            self._check()
            return ChatTransportResult(count, outputs, usd_text(cost), advisory, self._human, self._evidence,
                                       exchange.request, exchange.response, exchange.post_return_proof)
        except Exception as error:
            if isinstance(error, ChatTransportUnknown) or getattr(error, "effect", None) == "unknown":
                raise ChatTransportUnknown("chat-model-outcome-unknown") from None
            raise AdapterUnavailable("chat-consumer-unavailable") from None
        finally:
            # Dropping these references is not a physical RAM-erasure claim.
            self._copies.clear()
            self._evidence = ()
            self._human = None


def run_research_chat(job: Any, payload: dict[str, Any], *, consumer_type: Any = ApprovedChatConsumer) -> dict[str, Any]:
    """Compose real governed output/publication; Host retains terminal ownership.

    Preconditions and envelope capacity are verified before model admission.
    Unknown output effects are never called absent, never retried with a model,
    and never promoted to success. [] means no client-confirmed public outputs;
    the server preserves its actual publication ledger on unknown completion.
    """
    from .chat_output import prepare_chat_output, publish_chat_output
    consuming = False
    try:
        consumer = consumer_type(job, payload)
        output_context = prepare_chat_output(job=job, consumer=consumer)
        consuming = True
        result = consumer.consume()
        outputs = publish_chat_output(job=job, consumer=consumer, output_context=output_context, result=result)
        return {"status": "completed", "outputArtifactIds": list(outputs), "executionAuthorized": False}
    except Exception as error:
        if isinstance(error, ChatTransportUnknown) or getattr(error, "effect", None) == "unknown":
            return {"status": "unknown", "reason": "chat-output-effect-unknown",
                    "outputArtifactIds": [], "executionAuthorized": False}
        if job.cancel.cancelled():
            status, reason = "cancelled", "chat-response-cancelled"
        else:
            status = "failed" if consuming else "unavailable"
            reason = "chat-response-failed" if consuming else "chat-output-prerequisite-unavailable"
        return {"status": status, "reason": reason, "outputArtifactIds": [], "executionAuthorized": False}
