"""Canonical bounded chat output; no copied-input/full-run-result retention.

Only the actual final advisory and checked citation quotes enter this profile.
The request/raw response/post-return proof remain transient transport evidence;
the server independently rejoins original authority and reparses actual bytes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any

from agents.budget import usd_text, usd_units
from agents.wire import internal_value
from .chat_consumer import (
    CHAT_RESPONSE_MAXIMUM_BYTES, MODEL_PROOF_MAXIMUM_BYTES, MODEL_REQUEST_MAXIMUM_BYTES,
    ApprovedChatConsumer, ChatTransportResult, _MODEL_REF_KEYS, _checked_advisory, _record, _require, _response_json,
    decode_chat_recipe, decode_chat_recipe_v2,
)
from .chat_inputs import decode_chat_debate_plan
from .model_use import timestamp_ns


ADVISORY_MAXIMUM_BYTES = 262_144
RETAINED_PROFILE = "vertex-research-chat-advisory-v1"
RETAINED_DEBATE_PROFILE = "vertex-research-chat-advisory-v2"
_AGENT_RUN_KEYS = {"schemaVersion", "runId", "agentRole", "taskContract", "allowedTools", "modelVersion",
                   "inputEvidenceIds", "outputArtifactIds", "tokenBudget", "costBudgetUsd", "status",
                   "errors", "approvalRequests", "executionAuthorized"}


@dataclass(frozen=True)
class RetainedChatAdvisory:
    content: bytes = field(repr=False)
    sha256: str
    public_run: dict[str, Any] = field(repr=False)
    public_content: bytes = field(repr=False)
    public_sha256: str


def retain_chat_advisory(*, job: Any, recipe: dict[str, Any], result: ChatTransportResult,
                         queued_run: dict[str, Any], maximum_bytes: int,
                         native_phase: dict[str, Any] | None = None,
                         native_copies: dict[str, Any] | None = None) -> RetainedChatAdvisory:
    """Validate actual consumed bytes again and produce the exact retained DTO.

    `queued_run` must be the verified original read, not invented caller metadata.
    This pure function is NOT a publication receipt or model/provider attestation.
    """
    _record(queued_run, _AGENT_RUN_KEYS)
    _require(queued_run["status"] == "queued" and queued_run["outputArtifactIds"] == [])
    contracts = job.context.contracts
    native = recipe.get("profile") == "vertex-research-chat-native-evidence-job-v1"
    if native:
        from .native_evidence_consumer import decode_native_evidence_recipe
        recipe = decode_native_evidence_recipe(recipe, contracts=contracts)
        _require(type(native_phase) is dict and type(native_copies) is dict
                 and native_phase.get("profile") == "vertex-research-chat-native-phase-v1"
                 and native_phase.get("phaseOrdinal") == 2
                 and native_phase.get("planSha256") == recipe["plan_sha256"]
                 and native_phase.get("responseRequestId") == recipe["response_request_id"]
                 and native_phase.get("accountAlias") == recipe["account_alias"]
                 and native_phase.get("environment") == "research"
                 and contracts.digest({key: value for key, value in native_phase.items() if key != "phaseSha256"})
                     == native_phase.get("phaseSha256"))
        completion_pin = native_copies["phaseTwoCompletionInput"]
        reserved = recipe["copies"]["phaseTwoCompletionInput"]
        _require(all(completion_pin[key] == reserved[key] for key in ("copyId", "reservationSha256"))
                 and native_phase["completionInput"] == {key: completion_pin[key] for key in ("sha256", "byteLength")}
                 and len(result.evidence) == 1
                 and result.evidence[0].evidence_id == native_phase["derivation"]["evidenceId"]
                 and native_phase["derivation"]["toolResultSha256"] == native_copies["toolResult"]["sha256"])
    else:
        _require(native_phase is None and native_copies is None)
        decoder = decode_chat_recipe_v2 if recipe.get("profile") == "vertex-research-chat-job-v2" else decode_chat_recipe
        recipe = decoder(recipe, contracts=contracts)
        completion_pin = recipe["copies"]["completionInput"]
    _require(contracts.digest(recipe) == job.lease["payloadSha256"])
    execution = recipe["execution"]
    provider, budgets = execution["provider"], execution["budgets"]
    final_limits = execution["nativeEvidence"]["operationCeilings"][3] if native else {
        "maximumOutputTokens": provider["maximumOutputTokens"], "maximumCostUsd": budgets["completionCostUsd"]}
    _require(type(maximum_bytes) is int and 1 <= maximum_bytes <= ADVISORY_MAXIMUM_BYTES)
    _require(type(result) is ChatTransportResult and type(result.completion_response) is bytes
             and 1 <= len(result.completion_response) <= CHAT_RESPONSE_MAXIMUM_BYTES)
    request, proof = result.completion_request, result.completion_proof
    _require(contracts.validate("ModelUseRequest", request, "1.0.0") is True
             and contracts.validate("ModelUseProof", proof, "1.0.0") is True
             and len(contracts.encode(request)) <= MODEL_REQUEST_MAXIMUM_BYTES
             and len(contracts.encode(proof)) <= MODEL_PROOF_MAXIMUM_BYTES)
    _require(contracts.digest({key: value for key, value in request.items() if key != "requestSha256"}) == request["requestSha256"]
             and request["requestId"] == "model-use-" + contracts.digest(
                 {key: value for key, value in request.items() if key not in {"requestId", "requestSha256"}}))
    expected = {
        "accountAlias": recipe["account_alias"], "environment": "research", "researchPrincipalId": recipe["actor_id"],
        "selectionId": execution["selectionId"], "selectionSha256": execution["selectionSha256"],
        "providerId": provider["providerId"], "modelVersion": provider["modelVersion"],
        "tokenizerArtifactId": provider["tokenizerArtifact"]["artifactId"], "tokenizerSha256": provider["tokenizerArtifact"]["artifactSha256"],
        "endpointReferenceId": job.config.model.completion_endpoint_id, "endpointSha256": provider["completionEndpoint"]["artifactSha256"],
        "consumerServiceId": job.config.model_use.consumer_service_id, "modelUsePolicyVersion": job.config.model_use.model_use_policy_version,
        "grantId": job.config.model_use.completion_grant_id, "grantVersion": job.config.model_use.completion_grant_version,
        "operation": "model-completion", "purpose": "research", "tools": [],
        "inputSha256": completion_pin["sha256"], "inputBytes": completion_pin["byteLength"],
        "inputTokens": result.input_tokens, "maximumOutputTokens": final_limits["maximumOutputTokens"],
        "maximumCostUsd": final_limits["maximumCostUsd"], "deadlineAt": timestamp_ns(job.deadline),
        "evidence": [{key: pin[key] for key in _MODEL_REF_KEYS} for pin in execution["reviewPins"]],
        **{key: job.lease[key] for key in ("jobId", "leaseId", "leaseEpoch")},
    }
    _require(all(contracts.encode(request[key]) == contracts.encode(value) for key, value in expected.items()))
    for key in ("requestId", "requestSha256", "accountAlias", "environment", "researchPrincipalId", "consumerServiceId",
                "selectionId", "selectionSha256", "providerId", "modelVersion", "tokenizerArtifactId", "tokenizerSha256",
                "endpointReferenceId", "endpointSha256", "modelUsePolicyVersion", "jobId", "leaseId", "leaseEpoch", "grantId",
                "grantVersion", "operation"):
        _require(proof[key] == request[key])
    _require(proof["decision"] == "allowed" and proof["externalDispatchAllowed"] is False
             and proof["modelProcessingOnly"] is True and proof["executionAuthorized"] is False
             and proof["grantRevision"] is not None and proof["privacyPolicyId"] is not None and proof["privacyPolicyVersion"] is not None
             and proof["currentEvidenceSha256"] == contracts.digest(request["evidence"]))
    now = job.clock.now_ns()
    _require(contracts.epoch_ns(proof["checkedAt"]) <= now < contracts.epoch_ns(proof["validUntil"]) <= job.deadline)
    response = _response_json(result.completion_response, maximum_bytes=CHAT_RESPONSE_MAXIMUM_BYTES)
    _require(type(response) is dict and response.get("model") == job.config.model.served_model)
    usage = response.get("usage")
    _require(type(usage) is dict)
    inputs, outputs, total = usage.get("prompt_tokens"), usage.get("completion_tokens"), usage.get("total_tokens")
    _require(all(type(n) is int and 0 <= n <= 9_007_199_254_740_991 for n in (inputs, outputs, total))
             and inputs == result.input_tokens == request["inputTokens"] and inputs <= provider["maximumInputTokens"]
             and outputs == result.output_tokens and outputs <= final_limits["maximumOutputTokens"]
             and total == inputs + outputs and total <= min(budgets["requestTokens"], budgets["attemptTokens"],
                 job.selection["research"]["tokenBudget"], job.config.model.maximum_context_tokens))
    cost = usd_text((inputs * usd_units(job.config.model.input_usd_per_million)
                    + outputs * usd_units(job.config.model.output_usd_per_million) + 999_999) // 1_000_000)
    _require(cost == result.completion_cost_usd and usd_units(cost) <= usd_units(final_limits["maximumCostUsd"]))
    choices = response.get("choices")
    _require(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict and choices[0].get("finish_reason") == "stop")
    message = choices[0].get("message")
    _require(type(message) is dict and message.get("role") == "assistant" and not message.get("refusal")
             and not message.get("tool_calls") and not message.get("function_call") and type(message.get("content")) is str)
    parsed = _record(_response_json(message["content"].encode("utf-8"), maximum_bytes=500_000), {"output", "tool_requests"})
    _require(parsed["tool_requests"] == [])
    advisory = _checked_advisory(parsed["output"], result.evidence)
    _require(advisory == result.advisory)
    retained = {
        "profile": "vertex-research-chat-native-evidence-advisory-v1" if native else RETAINED_PROFILE,
        "responseRequestId": recipe["response_request_id"], "planId": recipe["plan_id"],
        "planSha256": recipe["plan_sha256"], "runId": recipe["run_id"], "traceId": recipe["trace_id"],
        "taskContract": execution["taskContract"], "modelVersion": provider["modelVersion"],
        "modelUseRequestSha256": request["requestSha256"], "responseSha256": sha256(result.completion_response).hexdigest(),
        "usage": {"inputTokens": inputs, "outputTokens": outputs, "totalTokens": total, "completionCostUsd": cost},
        "output": internal_value(advisory), "executionAuthorized": False,
    }
    if recipe["profile"] == "vertex-research-chat-job-v2":
        retained["profile"] = RETAINED_DEBATE_PROFILE
        retained["debate"] = decode_chat_debate_plan(execution["debate"], contracts=contracts)
    if native:
        _require(job.clock.now_ns() < job.deadline <= contracts.epoch_ns(native_phase["expiresAt"]))
    content = contracts.encode(retained)
    _require(type(content) is bytes and 1 <= len(content) <= maximum_bytes, "chat-advisory-byte-budget")
    public = {**queued_run, "status": "completed", "outputArtifactIds": [recipe["copies"]["advisory"]["copyId"]]}
    _require(contracts.validate("AgentRun", public, "1.0.0") is True
             and public["runId"] == recipe["run_id"] and public["taskContract"] == execution["taskContract"]
             and public["modelVersion"] == provider["modelVersion"] and public["agentRole"] == "research"
             and public["allowedTools"] == [] and public["inputEvidenceIds"] == [p["evidenceId"] for p in execution["reviewPins"]]
             and public["tokenBudget"] == budgets["requestTokens"] and public["costBudgetUsd"] == budgets["requestCostUsd"]
             and public["errors"] == [] and public["approvalRequests"] == [] and public["executionAuthorized"] is False)
    public_content = contracts.encode(public)
    _require(type(public_content) is bytes and len(public_content) <= 262_144)
    job.check()
    return RetainedChatAdvisory(content, sha256(content).hexdigest(), public, public_content, sha256(public_content).hexdigest())


@dataclass(frozen=True)
class ChatOutputContext:
    queued_run: dict[str, Any] = field(repr=False)
    maximum_bytes: int
    rights_policy_id: str
    rights_version: str


def prepare_chat_output(*, job: Any, consumer: ApprovedChatConsumer) -> ChatOutputContext:
    """Actual pinned original queued-run read and current rights BEFORE model use."""
    from vertex_control.adapters import ArtifactAdapter
    recipe, execution = consumer.recipe, consumer.execution
    pin = execution["queuedRun"]
    maximum = min(execution["advisoryMaximumBytes"], ADVISORY_MAXIMUM_BYTES)
    _require(isinstance(job.control.artifacts, ArtifactAdapter), "chat-output-port-unavailable")
    # This metadata-only serialization is a lower size bound, not a fabricated
    # answer. Any real strict output is larger; reject an impossible fixed cap.
    floor = {
        "profile": RETAINED_PROFILE, "responseRequestId": recipe["response_request_id"], "planId": recipe["plan_id"],
        "planSha256": recipe["plan_sha256"], "runId": recipe["run_id"], "traceId": recipe["trace_id"],
        "taskContract": execution["taskContract"], "modelVersion": execution["provider"]["modelVersion"],
        "modelUseRequestSha256": "0" * 64, "responseSha256": "0" * 64,
        "usage": {"inputTokens": 1, "outputTokens": 0, "totalTokens": 1, "completionCostUsd": "0"},
        "output": {}, "executionAuthorized": False,
    }
    if recipe["profile"] == "vertex-research-chat-job-v2":
        floor["profile"] = RETAINED_DEBATE_PROFILE
        floor["debate"] = execution["debate"]
    if recipe["profile"] == "vertex-research-chat-native-evidence-job-v1":
        floor["profile"] = "vertex-research-chat-native-evidence-advisory-v1"
    _require(len(job.context.contracts.encode(floor)) < maximum, "chat-advisory-impossible-cap")
    # Reject impossible configured envelopes before even original input reads or
    # durable run/model admission. No ready flag substitutes for this real path.
    job.control.artifacts.chat_stage_capacity(collection_id=execution["collectionId"],
        artifact_id=recipe["copies"]["advisory"]["copyId"], rights_policy_id=pin["rightsPolicyId"],
        rights_version=pin["rightsVersion"], lineage_artifact_ids=tuple(p["artifactId"] for p in execution["reviewPins"]),
        maximum_content_bytes=maximum, maximum_response_bytes=min(consumer.complete.maximum_response_bytes, CHAT_RESPONSE_MAXIMUM_BYTES),
        maximum_request_bytes=MODEL_REQUEST_MAXIMUM_BYTES, maximum_proof_bytes=MODEL_PROOF_MAXIMUM_BYTES)
    job.check()
    _require(pin["artifactId"] != recipe["run_id"])
    original = job.control.artifacts.read(artifact_id=pin["artifactId"], expected_digest=pin["artifactSha256"],
                                          collection_id=execution["collectionId"])
    queued = _record(_response_json(original, maximum_bytes=262_144), _AGENT_RUN_KEYS)
    _require(sha256(original).hexdigest() == pin["artifactSha256"] and job.context.contracts.encode(queued) == original
             and job.context.contracts.validate("AgentRun", queued, "1.0.0") is True)
    expected = {
        "schemaVersion": "1.0.0", "runId": recipe["run_id"], "agentRole": "research",
        "taskContract": execution["taskContract"], "modelVersion": execution["provider"]["modelVersion"],
        "allowedTools": [], "inputEvidenceIds": [p["evidenceId"] for p in execution["reviewPins"]], "outputArtifactIds": [],
        "tokenBudget": execution["budgets"]["requestTokens"], "costBudgetUsd": execution["budgets"]["requestCostUsd"],
        "status": "queued", "errors": [], "approvalRequests": [], "executionAuthorized": False,
    }
    _require(job.context.contracts.encode(queued) == job.context.contracts.encode(expected), "chat-original-queued-run-mismatch")
    # Pins select real original metadata; currentRights is the independent
    # collection-scoped observation, and the server rejoins that metadata.
    job.control.rights.current(pin["rightsPolicyId"], ("read", "store", "derive"),
                              collection_id=execution["collectionId"], expected_version=pin["rightsVersion"])
    job.check()
    return ChatOutputContext(queued, maximum, pin["rightsPolicyId"], pin["rightsVersion"])


def publish_chat_output(*, job: Any, consumer: ApprovedChatConsumer, output_context: ChatOutputContext,
                        result: ChatTransportResult) -> tuple[str, ...]:
    """Reserved governed stage → bodyless public stage → genuine publishAgent."""
    recipe, execution = consumer.recipe, consumer.execution
    retained = retain_chat_advisory(job=job, recipe=recipe, result=result, queued_run=output_context.queued_run,
                                    maximum_bytes=output_context.maximum_bytes,
                                    native_phase=getattr(consumer, "phase_two", None),
                                    native_copies=getattr(consumer, "phase_two_copies", None))
    job.check()
    artifact = job.control.artifacts.stage_chat_advisory(collection_id=execution["collectionId"],
        artifact_id=recipe["copies"]["advisory"]["copyId"], content=retained.content,
        maximum_content_bytes=output_context.maximum_bytes, rights_policy_id=output_context.rights_policy_id,
        rights_version=output_context.rights_version, lineage_artifact_ids=tuple(p["artifactId"] for p in execution["reviewPins"]),
        completion_request=result.completion_request, completion_response=result.completion_response,
        completion_proof=result.completion_proof, deadline_ns=job.deadline, cancellation=job.cancel)
    _require(artifact == {"artifactId": recipe["copies"]["advisory"]["copyId"], "artifactSha256": retained.sha256})
    job.check()
    outputs = job.control.artifacts.publish_chat_agent(collection_id=execution["collectionId"], public_content=retained.public_content,
        public_digest=retained.public_sha256, advisory=artifact, review_pins=tuple(execution["reviewPins"]),
        response_request_id=recipe["response_request_id"], rights_policy_id=output_context.rights_policy_id,
        rights_version=output_context.rights_version, expected_lease=job.lease, deadline_ns=job.deadline, cancellation=job.cancel)
    _require(type(outputs) is tuple and outputs == (recipe["run_id"],), "chat-publication-output-unconfirmed")
    return outputs
