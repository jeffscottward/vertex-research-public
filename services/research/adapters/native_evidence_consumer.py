"""Selected two-invoke protocol. Model intent is data, never grants or authority."""
from __future__ import annotations

from dataclasses import fields
from hashlib import sha256
import base64
from typing import Any

from agents.budget import usd_text, usd_units
from agents.chat_context import parse_research_chat_human_context_v1
from agents.types import Evidence, SYSTEM_INSTRUCTION
from .agno import CHAT_OPTIONS, _schema, invoke_native_evidence_once
from .chat_consumer import (
    ApprovedChatConsumer, ChatTransportResult, ChatTransportUnknown, _checked_advisory,
    _digest, _id, _input_json, _integer, _pin, _record, _require, _response_json,
    decode_chat_recipe, run_research_chat,
)
from .chat_inputs import _HumanCodec, canonical_chat_input_bytes
from .configuration import (
    NATIVE_EVIDENCE_PROFILE, NATIVE_EVIDENCE_PROTOCOL, NATIVE_EVIDENCE_SERIALIZER,
    NativeEvidenceConfiguration, native_evidence_tool_schema,
)
from .ports import AdapterUnavailable

PROFILE = "vertex-research-chat-native-evidence-job-v1"
MAXIMUM_INTERMEDIATE_BYTES = 262_144
INITIAL_PURPOSES = ("context", "tokenizeInput", "completionInput", "evidenceBundle")
LATER_PURPOSES = ("phaseOneResponse", "toolResult", "phaseTwoTokenizeInput", "phaseTwoCompletionInput", "advisory")
PHASE_TWO_PURPOSES = ("toolResult", "phaseTwoTokenizeInput", "phaseTwoCompletionInput")


def _content_pin(value: Any) -> dict[str, Any]:
    row = _record(value, {"sha256", "byteLength"})
    _digest(row["sha256"])
    _integer(row["byteLength"], MAXIMUM_INTERMEDIATE_BYTES)
    return row


def decode_native_evidence_descriptor(value: Any) -> dict[str, Any]:
    row = _record(value, {"profile", "toolName", "maximumCalls", "phaseCount", "derivationProfile",
        "serializerProfile", "nativeCapability", "operationCeilings", "aggregateTokens", "aggregateCostUsd",
        "maximumIntermediateBytes", "bundle"})
    _require(row["profile"] == NATIVE_EVIDENCE_PROTOCOL and row["toolName"] == "read_reviewed_evidence"
             and type(row["maximumCalls"]) is int and row["maximumCalls"] == 1
             and type(row["phaseCount"]) is int and row["phaseCount"] == 2
             and row["derivationProfile"] == "reviewed-evidence-single-projection-v1"
             and row["serializerProfile"] == NATIVE_EVIDENCE_SERIALIZER
             and type(row["maximumIntermediateBytes"]) is int
             and row["maximumIntermediateBytes"] == MAXIMUM_INTERMEDIATE_BYTES)
    _pin(row["nativeCapability"])
    _content_pin(row["bundle"])
    _integer(row["aggregateTokens"])
    total_tokens, total_cost = 0, 0
    ceilings = row["operationCeilings"]
    _require(type(ceilings) is list and len(ceilings) == 4)
    for slot, (phase, operation) in zip(ceilings, ((1, "model-tokenize"), (1, "model-completion"),
                                                (2, "model-tokenize"), (2, "model-completion"))):
        _record(slot, {"phaseOrdinal", "operation", "maximumInputTokens", "maximumOutputTokens", "maximumCostUsd"})
        _require(type(slot["phaseOrdinal"]) is int and slot["phaseOrdinal"] == phase and slot["operation"] == operation)
        _integer(slot["maximumInputTokens"])
        if operation == "model-tokenize":
            _require(type(slot["maximumOutputTokens"]) is int and slot["maximumOutputTokens"] == 0)
        else:
            _integer(slot["maximumOutputTokens"])
        total_tokens += slot["maximumInputTokens"] + slot["maximumOutputTokens"]
        total_cost += usd_units(slot["maximumCostUsd"])
    _require(total_tokens <= row["aggregateTokens"] and total_cost <= usd_units(row["aggregateCostUsd"]))
    return row


def decode_native_evidence_recipe(value: Any, *, contracts: Any) -> dict[str, Any]:
    raw = contracts.encode(value)
    row = _input_json(raw, maximum_bytes=262_144)
    _record(row, {"profile", "run_id", "trace_id", "actor_id", "account_alias", "environment",
                  "response_request_id", "plan_id", "plan_sha256", "copies", "execution"})
    _require(row["profile"] == PROFILE and type(row["execution"]) is dict)
    descriptor = decode_native_evidence_descriptor(row["execution"].get("nativeEvidence"))
    copies = _record(row["copies"], {*INITIAL_PURPOSES, *LATER_PURPOSES})
    for purpose, copy in copies.items():
        bound = purpose in INITIAL_PURPOSES
        _record(copy, {"copyId", "reservationSha256"} | ({"sha256", "byteLength"} if bound else {"content"}))
        _id(copy["copyId"])
        _digest(copy["reservationSha256"])
        if bound:
            _digest(copy["sha256"])
            _integer(copy["byteLength"], 1_048_576 if purpose == "context" else MAXIMUM_INTERMEDIATE_BYTES)
        else:
            _require(copy["content"] is None)
    _require(len({copy["copyId"] for copy in copies.values()}) == 9)
    _require({key: copies["evidenceBundle"][key] for key in ("sha256", "byteLength")} == descriptor["bundle"])
    # Validate every unchanged field with its original strict decoder. This
    # temporary validation projection is never hashed, queued, admitted or sent.
    legacy = {**row, "profile": "vertex-research-chat-job-v1",
              "copies": {key: copies[key] for key in ("context", "tokenizeInput", "completionInput", "advisory")},
              "execution": {key: item for key, item in row["execution"].items() if key != "nativeEvidence"}}
    decode_chat_recipe(legacy, contracts=contracts)
    budgets, provider = row["execution"]["budgets"], row["execution"]["provider"]
    _require(descriptor["aggregateTokens"] <= budgets["attemptTokens"] <= budgets["requestTokens"]
             and usd_units(descriptor["aggregateCostUsd"]) <= usd_units(budgets["attemptCostUsd"])
             <= usd_units(budgets["requestCostUsd"]))
    for slot in descriptor["operationCeilings"]:
        _require(slot["maximumInputTokens"] <= provider["maximumInputTokens"]
                 and slot["maximumOutputTokens"] <= provider["maximumOutputTokens"]
                 and usd_units(slot["maximumCostUsd"]) <= usd_units(budgets[
                     "tokenizeCostUsd" if slot["operation"] == "model-tokenize" else "completionCostUsd"]))
    return row


def parse_native_evidence_call(raw: bytes, *, model: str, input_tokens: int,
                               maximum_output_tokens: int, evidence_ids: tuple[str, ...]) -> dict[str, Any]:
    """Independent bounded raw parser; never trust the SDK's parsed call object."""
    response = _response_json(raw, maximum_bytes=MAXIMUM_INTERMEDIATE_BYTES)
    _require(type(response) is dict and set(response) <= {"id", "object", "created", "model", "choices", "usage",
                                                        "system_fingerprint", "service_tier"}
             and response.get("model") == model and response.get("object") == "chat.completion"
             and type(response.get("id")) is str and 1 <= len(response["id"]) <= 256
             and type(response.get("created")) is int and 0 <= response["created"] <= 9_007_199_254_740_991)
    for key in ("system_fingerprint", "service_tier"):
        _require(response.get(key) is None or type(response[key]) is str)
    usage = response.get("usage")
    _require(type(usage) is dict)
    inputs, outputs, total = (usage.get(key) for key in ("prompt_tokens", "completion_tokens", "total_tokens"))
    _require(all(type(n) is int and 0 <= n <= 9_007_199_254_740_991 for n in (inputs, outputs, total))
             and inputs == input_tokens and outputs <= maximum_output_tokens and total == inputs + outputs)
    choices = response.get("choices")
    _require(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict
             and set(choices[0]) <= {"index", "finish_reason", "message", "logprobs"}
             and choices[0].get("finish_reason") == "tool_calls"
             and type(choices[0].get("index")) is int and choices[0]["index"] == 0
             and choices[0].get("logprobs") is None)
    message = choices[0].get("message")
    _require(type(message) is dict and set(message) <= {"role", "content", "tool_calls", "refusal"}
             and message.get("role") == "assistant" and message.get("content") in (None, "")
             and message.get("refusal") is None)
    calls = message.get("tool_calls")
    _require(type(calls) is list and len(calls) == 1)
    call = _record(calls[0], {"id", "type", "function"})
    _id(call["id"])
    function = _record(call["function"], {"name", "arguments"})
    _require(call["type"] == "function" and function["name"] == "read_reviewed_evidence"
             and type(function["arguments"]) is str)
    arguments = _record(_input_json(function["arguments"].encode("utf-8"), maximum_bytes=512), {"evidence_id"})
    _id(arguments["evidence_id"])
    _require(function["arguments"].encode("utf-8") == canonical_chat_input_bytes(arguments)
             and arguments["evidence_id"] in evidence_ids)
    return {"call": call, "evidenceId": arguments["evidence_id"], "usage": usage}


class NativeEvidenceConsumer(ApprovedChatConsumer):
    def __init__(self, job: Any, recipe: dict[str, Any]):
        self.phase_ordinal = 1
        self.phase_two = None
        self.phase_two_copies: dict[str, Any] = {}
        self._bundle_evidence: tuple[Evidence, ...] = ()
        self._phase_one_messages: list[dict[str, Any]] = []
        self._manifest_ids: tuple[str, ...] = ()
        self._dispatched_slots: set[tuple[int, str]] = set()
        super().__init__(job, recipe)

    def _decode_recipe(self, recipe: dict[str, Any]) -> dict[str, Any]:
        return decode_native_evidence_recipe(recipe, contracts=self.contracts)

    def _native_profile(self) -> bool:
        return True

    def _validate_bindings(self) -> None:
        _require(self.job.config.profile == NATIVE_EVIDENCE_PROFILE)
        super()._validate_bindings()
        config = self.job.config.native_evidence
        descriptor = self.execution["nativeEvidence"]
        _require(isinstance(config, NativeEvidenceConfiguration) and self.rendezvous is not None
                 and config.protocol == descriptor["profile"] and config.serializer_profile == descriptor["serializerProfile"]
                 and config.allowed_tools == (descriptor["toolName"],)
                 and dict(config.native_serving) == descriptor["nativeCapability"]
                 and config.native_serving["artifactSha256"] == self.policy.serving_manifest_sha256)
        self._selected("tool-config", descriptor["nativeCapability"])
        _require(descriptor["aggregateTokens"] <= self.job.selection["research"]["tokenBudget"]
                 and usd_units(descriptor["aggregateCostUsd"]) <= usd_units(self.job.selection["research"]["costBudgetUsd"]))

    def _slot(self, operation: str) -> dict[str, Any]:
        _require(self.phase_ordinal in (1, 2) and operation in ("model-tokenize", "model-completion"))
        return self.execution["nativeEvidence"]["operationCeilings"][(self.phase_ordinal - 1) * 2 + (operation == "model-completion")]

    def _request_limits(self, endpoint: Any) -> tuple[int, str]:
        slot = self._slot(endpoint.operation)
        return slot["maximumOutputTokens"], slot["maximumCostUsd"]

    def _model_tools(self, endpoint: Any) -> tuple[str, ...]:
        return self.job.config.native_evidence.allowed_tools if self.phase_ordinal == 1 and endpoint.operation == "model-completion" else ()

    def _privacy_candidate_id(self, request: dict[str, Any]) -> str:
        _require(self.phase_ordinal in (1, 2))
        if self.phase_ordinal == 1:
            # Exact copy-owner phase body reconstructed from immutable original
            # recipe pins. This expected hash is not a stored phase or authority:
            # the server independently rejoins its immutable phase/current grants.
            phase_body = {
                "profile": "vertex-research-chat-native-phase-v1",
                "accountAlias": self.recipe["account_alias"], "environment": self.recipe["environment"],
                "responseRequestId": self.recipe["response_request_id"], "planSha256": self.recipe["plan_sha256"],
                "phaseOrdinal": 1, "derivation": None, "expiresAt": self.execution["deadlineAt"],
                "tokenizeInput": {key: self.recipe["copies"]["tokenizeInput"][key] for key in ("sha256", "byteLength")},
                "completionInput": {key: self.recipe["copies"]["completionInput"][key] for key in ("sha256", "byteLength")},
            }
            phase_sha256 = self.contracts.digest(phase_body)
        else:
            _require(type(self.phase_two) is dict and self.phase_two["phaseOrdinal"] == 2)
            phase_sha256 = self.phase_two["phaseSha256"]
        return "chat-candidate-" + self.contracts.digest({
            "responseRequestId": self.recipe["response_request_id"], "planId": self.recipe["plan_id"],
            "planSha256": self.recipe["plan_sha256"], "request": request,
            "nativePhase": {"phaseOrdinal": self.phase_ordinal, "phaseSha256": phase_sha256},
        })

    def _read_copy(self, purpose: str) -> bytes:
        if purpose not in self.phase_two_copies:
            return super()._read_copy(purpose)
        pin = self.phase_two_copies[purpose]
        self._check()
        content = self.job.control.artifacts.read_governed_copy(copy_id=pin["copyId"], expected_digest=pin["sha256"],
            expected_length=pin["byteLength"], deadline_ns=self.job.deadline, cancellation=self.job.cancel)
        _require(type(content) is bytes and len(content) == pin["byteLength"] and sha256(content).hexdigest() == pin["sha256"])
        self._check()
        return content

    def _refresh_purposes(self) -> tuple[str, ...]:
        return INITIAL_PURPOSES + (PHASE_TWO_PURPOSES if self.phase_ordinal == 2 else ())

    def _current_evidence_refs(self, rights: Any) -> tuple[dict[str, Any], ...]:
        return rights.model_evidence_refs(self._bundle_evidence)

    def _send_model_request(self, endpoint: Any, encoded: bytes, response_limit: int, authorize_disclosure: Any) -> Any:
        slot = (self.phase_ordinal, endpoint.operation)
        _require(slot not in self._dispatched_slots, "native-operation-replay-denied")
        self._dispatched_slots.add(slot)
        if endpoint.operation == "model-tokenize":
            return super()._send_model_request(endpoint, encoded, response_limit, authorize_disclosure)
        def send(actual: bytes) -> Any:
            _require(actual == encoded, "native-wire-input-drift")
            return super(NativeEvidenceConsumer, self)._send_model_request(endpoint, actual,
                min(response_limit, MAXIMUM_INTERMEDIATE_BYTES), authorize_disclosure)
        return invoke_native_evidence_once(endpoint=endpoint, policy=self.policy, input_bytes=encoded, send=send)

    def _request(self, endpoint: Any, purpose: str, count: int | None) -> Any:
        tokenizing = endpoint.operation == "model-tokenize"
        expected = ("tokenizeInput" if tokenizing else "completionInput") if self.phase_ordinal == 1 else (
            "phaseTwoTokenizeInput" if tokenizing else "phaseTwoCompletionInput")
        _require(purpose == expected and len(self._copies[purpose]) <= endpoint.maximum_request_bytes)
        slot = self._slot(endpoint.operation)
        price = self.descriptor["pricing"]
        cost = (usd_units(price["tokenizationBaseUsd" if tokenizing else "completionBaseUsd"])
                + len(self._copies[purpose]) * usd_units(price["tokenizationInputByteUsd" if tokenizing else "completionInputByteUsd"])
                + slot["maximumOutputTokens"] * usd_units(price["outputTokenUsd"]))
        _require(cost <= usd_units(slot["maximumCostUsd"]))
        if not tokenizing:
            _integer(count, slot["maximumInputTokens"])
        return super()._request(endpoint, purpose, count)

    def _canonical_copy(self, purpose: str) -> Any:
        body = self._copies[purpose]
        value = _input_json(body, maximum_bytes=1_048_576 if purpose == "context" else MAXIMUM_INTERMEDIATE_BYTES)
        _require(canonical_chat_input_bytes(value) == body, "native-copy-noncanonical")
        return value

    def _load_inputs(self) -> None:
        self._copies = {purpose: self._read_copy(purpose) for purpose in INITIAL_PURPOSES}
        human_value = self._canonical_copy("context")
        human = parse_research_chat_human_context_v1(human_value, codec=_HumanCodec())
        _require(human.account_alias == self.recipe["account_alias"] and human.environment == "research"
                 and human.owner_actor_id == self.recipe["actor_id"] and human.participant_id == "first-mate"
                 and human.response_request_id == self.recipe["response_request_id"]
                 and human.participant_config_sha256 == self.execution["participantConfiguration"]["artifactSha256"])
        bundle = self._canonical_copy("evidenceBundle")
        _require(type(bundle) is list and len(bundle) == len(self.execution["reviewPins"]))
        evidence = []
        for item, pin in zip(bundle, self.execution["reviewPins"]):
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
        self._human, self._bundle_evidence = human, tuple(evidence)
        token, completion = self._canonical_copy("tokenizeInput"), self._canonical_copy("completionInput")
        self._validate_input_pair(token, completion, phase=1)
        messages = completion["messages"]
        _require(len(messages) == 2 and messages[0]["role"] == "system" and messages[1]["role"] == "user")
        for message in messages:
            _record(message, {"role", "content"})
            _require(type(message["content"]) is str)
        _require(messages[0]["content"] == SYSTEM_INSTRUCTION)
        envelope = _record(_input_json(messages[1]["content"].encode("utf-8"), maximum_bytes=MAXIMUM_INTERMEDIATE_BYTES),
                           {"data", "inert_tool_names", "response_contract", "execution_authorized"})
        _require(envelope["inert_tool_names"] == [] and envelope["execution_authorized"] is False
                 and canonical_chat_input_bytes(envelope["response_contract"]) == canonical_chat_input_bytes(_schema(())))
        data = _record(envelope["data"], {"phase", "task", "evidence", "evidence_manifest", "native_evidence_protocol",
            "prior_analyses", "tool_results", "untrusted_content", "human_context"})
        _require(data["phase"] == "evidence-selection" and data["evidence"] == [] and data["prior_analyses"] == []
                 and data["tool_results"] == [] and data["untrusted_content"] is True and data["human_context"] == human_value
                 and data["native_evidence_protocol"] == self.execution["nativeEvidence"]
                 and type(data["task"]) is str and 10 <= len(data["task"].encode("utf-16-le")) // 2 <= 2_000)
        manifest = [{key: item[key] for key in ("evidence_id", "source_id", "source_snapshot_id", "content_hash",
                                               "excerpt_digest", "attribution", "untrusted_content")} for item in bundle]
        _require(data["evidence_manifest"] == manifest)
        self._manifest_ids = tuple(item["evidence_id"] for item in manifest)
        self._phase_one_messages = messages

    def _validate_input_pair(self, token: Any, completion: Any, *, phase: int) -> None:
        _record(token, {"model", "messages", *CHAT_OPTIONS, "tools", "return_token_strs"})
        base = {"model", "messages", *CHAT_OPTIONS, "store", "max_completion_tokens", "stream", "n", "tool_choice",
                "truncate_prompt_tokens", "skip_special_tokens"}
        _record(completion, base | ({"tools", "parallel_tool_calls"} if phase == 1 else {"response_format"}))
        _require(token["return_token_strs"] is False and completion["store"] is False and completion["stream"] is False
                 and type(completion["n"]) is int and completion["n"] == 1 and completion["truncate_prompt_tokens"] is None
                 and completion["skip_special_tokens"] is True
                 and type(completion["max_completion_tokens"]) is int
                 and completion["max_completion_tokens"] == self.execution["nativeEvidence"]["operationCeilings"][(phase - 1) * 2 + 1]["maximumOutputTokens"])
        for body in (token, completion):
            _require(body["model"] == self.policy.served_model
                     and canonical_chat_input_bytes({key: body[key] for key in CHAT_OPTIONS}) == canonical_chat_input_bytes(CHAT_OPTIONS))
        _require(type(token["messages"]) is list and completion["messages"] == token["messages"])
        if phase == 1:
            tool = native_evidence_tool_schema()
            _require(token["tools"] == [tool] and completion["tools"] == [tool]
                     and completion["tool_choice"] == {"type": "function", "function": {"name": "read_reviewed_evidence"}}
                     and completion["parallel_tool_calls"] is False)
        else:
            _require(token["tools"] is None and completion["tool_choice"] == "none"
                     and completion["response_format"] == {"type": "json_schema", "json_schema": {
                         "name": "vertex_advisory_v1", "schema": _schema(()), "strict": True}})

    def _measure(self, purpose: str) -> int:
        measured = _response_json(self._request(self.tokenize, purpose, None).response,
                                  maximum_bytes=self.tokenize.maximum_response_bytes)
        _require(type(measured) is dict)
        count, ids = measured.get("count"), measured.get("tokens")
        _integer(count, min(self.policy.maximum_context_tokens, self._slot("model-tokenize")["maximumInputTokens"],
                            self._slot("model-completion")["maximumInputTokens"]))
        _require(type(ids) is list and len(ids) == count and all(type(token) is int and token >= 0 for token in ids)
                 and type(measured.get("max_model_len")) is int and measured["max_model_len"] == self.policy.maximum_context_tokens)
        slot = self._slot("model-completion")
        _require(count + slot["maximumOutputTokens"] <= min(self.policy.maximum_context_tokens, self.budgets["attemptTokens"]))
        cost = (count * usd_units(self.policy.input_usd_per_million)
                + slot["maximumOutputTokens"] * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
        _require(cost <= usd_units(slot["maximumCostUsd"]))
        return count

    def _prepare_phase_two(self, exchange: Any, call: dict[str, Any]) -> None:
        self._check()
        result = self.job.control.artifacts.call("prepareNativeEvidencePhaseTwo", request=exchange.request,
            proof=exchange.post_return_proof, responseBase64=base64.b64encode(exchange.response).decode("ascii"),
            deadline_ns=self.job.deadline, cancellation=self.job.cancel)
        _record(result, {"phase", "copies", "executionAuthorized"})
        _require(result["executionAuthorized"] is False)
        phase = _record(result["phase"], {"profile", "accountAlias", "environment", "responseRequestId", "planSha256",
            "phaseOrdinal", "tokenizeInput", "completionInput", "derivation", "expiresAt", "phaseSha256"})
        _require(phase["profile"] == "vertex-research-chat-native-phase-v1" and type(phase["phaseOrdinal"]) is int
                 and phase["phaseOrdinal"] == 2 and phase["accountAlias"] == self.recipe["account_alias"]
                 and phase["environment"] == "research" and phase["responseRequestId"] == self.recipe["response_request_id"]
                 and phase["planSha256"] == self.recipe["plan_sha256"]
                 and self.contracts.digest({key: value for key, value in phase.items() if key != "phaseSha256"}) == phase["phaseSha256"]
                 and self.job.clock.now_ns() < self.job.deadline <= self.contracts.epoch_ns(phase["expiresAt"]))
        copies = _record(result["copies"], set(PHASE_TWO_PURPOSES))
        for purpose, pin in copies.items():
            _record(pin, {"copyId", "reservationSha256", "sha256", "byteLength"})
            _require(all(pin[key] == self.recipe["copies"][purpose][key] for key in ("copyId", "reservationSha256")))
            _content_pin({key: pin[key] for key in ("sha256", "byteLength")})
        for phase_key, purpose in (("tokenizeInput", "phaseTwoTokenizeInput"), ("completionInput", "phaseTwoCompletionInput")):
            _require(_content_pin(phase[phase_key]) == {key: copies[purpose][key] for key in ("sha256", "byteLength")})
        self.phase_two, self.phase_two_copies = phase, copies
        self._copies.update({purpose: self._read_copy(purpose) for purpose in PHASE_TWO_PURPOSES})
        delivered = self._canonical_copy("toolResult")
        bundle = self._canonical_copy("evidenceBundle")
        selected = [item for item in bundle if item["evidence_id"] == call["evidenceId"]]
        _require(len(selected) == 1 and delivered == selected[0])
        derivation = _record(phase["derivation"], {"profile", "phaseOneResponseSha256", "phaseOneRequestSha256",
            "phaseOneProofSha256", "callId", "toolName", "argumentsCanonical", "evidenceId", "bundleSha256", "toolResultSha256"})
        expected = {"profile": "reviewed-evidence-single-projection-v1", "phaseOneResponseSha256": sha256(exchange.response).hexdigest(),
            "phaseOneRequestSha256": exchange.request["requestSha256"], "phaseOneProofSha256": self.contracts.digest(exchange.post_return_proof),
            "callId": call["call"]["id"], "toolName": "read_reviewed_evidence",
            "argumentsCanonical": call["call"]["function"]["arguments"], "evidenceId": call["evidenceId"],
            "bundleSha256": self.execution["nativeEvidence"]["bundle"]["sha256"], "toolResultSha256": copies["toolResult"]["sha256"]}
        _require(all(derivation[key] == value for key, value in expected.items()))
        token, completion = self._canonical_copy("phaseTwoTokenizeInput"), self._canonical_copy("phaseTwoCompletionInput")
        self._validate_input_pair(token, completion, phase=2)
        expected_messages = [*self._phase_one_messages,
            {"role": "assistant", "content": None, "tool_calls": [call["call"]]},
            {"role": "tool", "tool_call_id": call["call"]["id"], "content": self._copies["toolResult"].decode("utf-8")}]
        _require(completion["messages"] == expected_messages)
        self._evidence = (Evidence(**delivered),)
        self.phase_ordinal = 2
        self._check()

    def consume(self) -> ChatTransportResult:
        with self._lock:
            if self._started:
                raise ChatTransportUnknown("native-consumer-replay-unknown")
            self._started = True
        try:
            self._check()
            admission = self.job.admit_private_research(self.recipe)
            if admission is not None:
                if admission.get("status") == "unknown":
                    raise ChatTransportUnknown("native-admission-unknown")
                raise AdapterUnavailable("native-admission-unavailable")
            self._load_inputs()
            count_one = self._measure("tokenizeInput")
            first = self._request(self.complete, "completionInput", count_one)
            call = parse_native_evidence_call(first.response, model=self.policy.served_model, input_tokens=count_one,
                maximum_output_tokens=self._slot("model-completion")["maximumOutputTokens"], evidence_ids=self._manifest_ids)
            self._prepare_phase_two(first, call)
            count_two = self._measure("phaseTwoTokenizeInput")
            final = self._request(self.complete, "phaseTwoCompletionInput", count_two)
            response = _response_json(final.response, maximum_bytes=MAXIMUM_INTERMEDIATE_BYTES)
            _require(type(response) is dict and response.get("model") == self.policy.served_model)
            usage = response.get("usage")
            _require(type(usage) is dict)
            inputs, outputs, total = (usage.get(key) for key in ("prompt_tokens", "completion_tokens", "total_tokens"))
            _require(all(type(n) is int and 0 <= n <= 9_007_199_254_740_991 for n in (inputs, outputs, total))
                     and inputs == count_two and outputs <= self._slot("model-completion")["maximumOutputTokens"]
                     and total == inputs + outputs and total <= min(self.policy.maximum_context_tokens, self.budgets["attemptTokens"]))
            cost = (inputs * usd_units(self.policy.input_usd_per_million)
                    + outputs * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
            _require(cost <= usd_units(self._slot("model-completion")["maximumCostUsd"]))
            choices = response.get("choices")
            _require(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict
                     and choices[0].get("finish_reason") == "stop")
            message = choices[0].get("message")
            _require(type(message) is dict and message.get("role") == "assistant" and not message.get("refusal")
                     and message.get("tool_calls") in (None, []) and message.get("function_call") is None
                     and type(message.get("content")) is str)
            parsed = _record(_response_json(message["content"].encode("utf-8"), maximum_bytes=MAXIMUM_INTERMEDIATE_BYTES),
                             {"output", "tool_requests"})
            _require(parsed["tool_requests"] == [])
            advisory = _checked_advisory(parsed["output"], self._evidence)
            self._check()
            return ChatTransportResult(inputs, outputs, usd_text(cost), advisory, self._human, self._evidence,
                                       final.request, final.response, final.post_return_proof)
        except Exception as error:
            if isinstance(error, ChatTransportUnknown) or getattr(error, "effect", None) == "unknown":
                raise ChatTransportUnknown("native-protocol-outcome-unknown") from None
            raise AdapterUnavailable("native-protocol-unavailable") from None
        finally:
            self._copies.clear()
            self._bundle_evidence, self._evidence, self._manifest_ids = (), (), ()
            self._phase_one_messages = []
            self._human = None


def run_native_evidence_chat(job: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return run_research_chat(job, payload, consumer_type=NativeEvidenceConsumer)
