"""Python output boundary tests; NOT TS issuer/worker/storage acceptance.

Uses actual Python consumer, _Job, governed stage/publication adapters and HTTPS
transport with external control/HTTP doubles. No SDK/provider/DB/cleanup calls.
"""
from base64 import b64decode
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import asyncio
import json

import pytest

from adapters.chat_consumer import ApprovedChatConsumer, MODEL_PROOF_MAXIMUM_BYTES
from adapters.chat_output import prepare_chat_output, retain_chat_advisory
from adapters.handlers import _research, create_handlers
from adapters.ports import AdapterUnavailable
from adapters.tests.test_chat_consumer import build_boundary, repin_recipe, prohibit_real_network
from vertex_control.client import ControlError


def dispatch(f):
    return asyncio.run(create_handlers(f.context)["research-run"](f.recipe, f.lease))


def test_actual_handler_governed_stage_then_only_bodyless_public_stage_and_publication(monkeypatch):
    f = build_boundary(monkeypatch)
    f.http.responses["/v1/chat/completions"]["ignored_provider_debug"] = {"private": "not retained", "temperature": 0.5}
    f.http.raw_response_mutator = lambda path, body: b" \n" + body + b"\n" if path == "/v1/chat/completions" else body
    result = dispatch(f)
    assert result == {"status": "completed", "outputArtifactIds": ["run"], "executionAuthorized": False}
    assert len(f.http.sent) == 2 and f.control.durable_outputs == ["run"]
    stages = [fields for method, fields in f.control.calls if method == "stageArtifact"]
    assert [fields["artifactId"] for fields in stages] == ["advisory-copy", "run"]
    advisory_stage, public_stage = stages
    assert set(advisory_stage["chatCompletion"]) == {"request", "responseBase64", "proof"}
    raw = b64decode(advisory_stage["chatCompletion"]["responseBase64"])
    assert raw == f.http.received["/v1/chat/completions"] and raw != f.authority.encode(json.loads(raw))
    assert advisory_stage["chatCompletion"]["request"] == f.control.proofs[2]
    assert advisory_stage["chatCompletion"]["proof"] == f.control.proof_replies[3]
    assert advisory_stage["chatCompletion"]["proof"]["externalDispatchAllowed"] is False
    assert advisory_stage["lineageArtifactIds"] == ["evidence-artifact"]
    assert "chatCompletion" not in public_stage and public_stage["lineageArtifactIds"] == []
    assert set(f.control.governed) == {"advisory-copy"} and set(f.control.ordinary) == {"run"}
    retained_bytes = f.control.governed["advisory-copy"]
    retained = json.loads(retained_bytes)
    assert set(retained) == {"profile", "responseRequestId", "planId", "planSha256", "runId", "traceId", "taskContract",
                            "modelVersion", "modelUseRequestSha256", "responseSha256", "usage", "output", "executionAuthorized"}
    assert retained["profile"] == "vertex-research-chat-advisory-v1"
    assert retained["usage"] == {"inputTokens": 200, "outputTokens": 20, "totalTokens": 220, "completionCostUsd": "0.00024"}
    assert retained["responseSha256"] == sha256(raw).hexdigest()
    assert retained["modelUseRequestSha256"] == f.control.proofs[2]["requestSha256"]
    assert f.authority.encode(retained) == retained_bytes
    assert all(word not in retained for word in ("result", "human_context", "evidence", "messages", "query", "task", "persona_text"))
    assert "ignored_provider_debug" not in retained_bytes.decode() and "not retained" not in retained_bytes.decode()
    assert f.args["human_context"].messages[0].body not in retained_bytes.decode()
    public = json.loads(f.control.ordinary["run"])
    queued = json.loads(f.control.records[f.recipe["execution"]["queuedRun"]["artifactId"]])
    assert public == {**queued, "status": "completed", "outputArtifactIds": ["advisory-copy"]}
    assert public["allowedTools"] == [] and public["executionAuthorized"] is False
    assert f.control.publications[0]["idempotencyKey"] == "chat-publish-response"
    assert f.control.publications[0]["reviewPins"] == f.recipe["execution"]["reviewPins"]
    assert len(f.control.config.envelope.encode(advisory_stage)) <= 2_097_152
    assert all(method not in {"complete", "cancel", "publishArtifact"} for method, _ in f.control.calls)


def test_exact_consumed_wire_bytes_and_after_return_proof_are_not_reconstructed(monkeypatch):
    f = build_boundary(monkeypatch)
    f.http.raw_response_mutator = lambda path, body: b"\n  " + body + b"  \n"
    job = f.job()
    consumer = ApprovedChatConsumer(job, f.recipe)
    output = prepare_chat_output(job=job, consumer=consumer)
    result = consumer.consume()
    assert result.completion_response == f.http.received["/v1/chat/completions"]
    assert result.completion_response != f.authority.encode(json.loads(result.completion_response))
    assert result.completion_request == f.control.proofs[2]
    assert result.completion_proof == f.control.proof_replies[3]
    assert len(f.authority.encode(result.completion_proof)) <= MODEL_PROOF_MAXIMUM_BYTES
    assert "Synthetic bounded" not in repr(result) and "not retained" not in repr(result)
    retained = retain_chat_advisory(job=job, recipe=consumer.recipe, result=result,
                                    queued_run=output.queued_run, maximum_bytes=output.maximum_bytes)
    assert json.loads(retained.content)["responseSha256"] == sha256(result.completion_response).hexdigest()
    with pytest.raises(AdapterUnavailable):
        retain_chat_advisory(job=job, recipe=consumer.recipe,
            result=replace(result, completion_proof={**result.completion_proof, "externalDispatchAllowed": True}),
            queued_run=output.queued_run, maximum_bytes=output.maximum_bytes)
    with pytest.raises(AdapterUnavailable):
        retain_chat_advisory(job=job, recipe=consumer.recipe,
            result=replace(result, completion_request={**result.completion_request, "inputTokens": 201}),
            queued_run=output.queued_run, maximum_bytes=output.maximum_bytes)
    assert f.control.governed == f.control.ordinary == {}


@pytest.mark.parametrize("change", ["client-bound", "unsupported-envelope", "impossible-advisory", "old-shape"])
def test_fixed_output_prerequisite_unavailable_has_zero_effects(monkeypatch, change):
    f = build_boundary(monkeypatch)
    if change == "client-bound": f.control.config.max_request_bytes = 1_000_000
    if change == "unsupported-envelope": f.control.config.envelope = object()
    if change == "impossible-advisory": f.recipe["execution"]["advisoryMaximumBytes"] = 1
    if change == "old-shape": del f.recipe["execution"]["queuedRun"]
    repin_recipe(f)
    result = dispatch(f)
    assert result["status"] == "unavailable" and result["outputArtifactIds"] == []
    assert f.control.calls == f.control.proofs == f.http.sent == []
    assert f.control.governed == f.control.ordinary == {}


@pytest.mark.parametrize("change", ["queued-sha", "queued-model", "queued-budget", "queued-status", "rights-version", "rights-denied"])
def test_actual_original_queued_metadata_and_rights_required_before_model(monkeypatch, change):
    f = build_boundary(monkeypatch)
    pin = f.recipe["execution"]["queuedRun"]
    if change == "queued-sha": pin["artifactSha256"] = "f" * 64
    elif change.startswith("queued-"):
        value = json.loads(f.control.records[pin["artifactId"]])
        if change == "queued-model": value["modelVersion"] = "different-model"
        if change == "queued-budget": value["tokenBudget"] = 1999
        if change == "queued-status": value["status"] = "completed"
        body = f.authority.encode(value)
        f.control.records[pin["artifactId"]] = body
        pin["artifactSha256"] = sha256(body).hexdigest()
    elif change == "rights-version": pin["rightsVersion"] = "9.0.0"
    else:
        def mutate(method, fields, reply):
            if method == "currentRights": reply["status"] = "denied"
        f.control.mutate = mutate
    repin_recipe(f)
    result = dispatch(f)
    assert result["status"] == "unavailable" and f.control.proofs == f.http.sent == []
    assert f.control.admissions == 0 and f.control.governed == f.control.ordinary == {}


@pytest.mark.parametrize("change", ["text-number", "usage-float", "usage-bool", "tool-request", "proposal-execution", "duplicate-claim-citation", "claim-codepoints", "title-codepoints", "duplicate-json"])
def test_strict_actual_output_rejects_coercion_tools_duplicates_and_oversize_text(monkeypatch, change):
    f = build_boundary(monkeypatch)
    def mutate(path, response):
        if path != "/v1/chat/completions": return
        if change == "usage-float": response["usage"]["prompt_tokens"] = 200.0
        if change == "usage-bool": response["usage"]["completion_tokens"] = True
        value = json.loads(response["choices"][0]["message"]["content"])
        if change == "text-number": value["output"]["claims"][0]["text"] = 123.5
        if change == "tool-request": value["tool_requests"] = [{"call_id": "nope"}]
        if change == "proposal-execution":
            value["output"]["proposals"] = [{"proposal_id": "p", "kind": "strategy-hypothesis", "title": "Not execution",
                "rationale": value["output"]["claims"][0], "execution_authorized": True}]
        if change == "duplicate-claim-citation": value["output"]["claims"][0]["citations"] *= 2
        if change == "claim-codepoints": value["output"]["claims"][0]["text"] = "𝄞" * 2001
        if change == "title-codepoints":
            value["output"]["proposals"] = [{"proposal_id": "p", "kind": "strategy-hypothesis", "title": "𝄞" * 201,
                "rationale": value["output"]["claims"][0], "execution_authorized": False}]
        response["choices"][0]["message"]["content"] = f.authority.encode(value).decode()
    f.http.response_mutator = mutate
    if change == "duplicate-json":
        f.http.raw_response_mutator = lambda path, body: b'{"model":"x","model":"y"}' if path == "/v1/chat/completions" else body
    result = dispatch(f)
    assert result["status"] == "failed" and result["outputArtifactIds"] == []
    assert len(f.http.sent) == 2 and f.control.governed == f.control.ordinary == {} and f.control.publications == []


@pytest.mark.parametrize("target, count", [("claim", 1001), ("claim", 2000), ("title", 101), ("title", 200)])
def test_original_codepoint_limits_accept_astral_claim_and_title_boundaries(monkeypatch, target, count):
    f = build_boundary(monkeypatch)
    text = "𝄞" * count
    def mutate(path, response):
        if path != "/v1/chat/completions": return
        value = json.loads(response["choices"][0]["message"]["content"])
        if target == "claim":
            value["output"]["claims"][0]["text"] = text
        else:
            value["output"]["proposals"] = [{"proposal_id": "p", "kind": "strategy-hypothesis", "title": text,
                "rationale": value["output"]["claims"][0], "execution_authorized": False}]
        response["choices"][0]["message"]["content"] = f.authority.encode(value).decode()
    f.http.response_mutator = mutate
    result = dispatch(f)
    assert result == {"status": "completed", "outputArtifactIds": ["run"], "executionAuthorized": False}
    output = json.loads(f.control.governed["advisory-copy"])["output"]
    assert (output["claims"][0]["text"] if target == "claim" else output["proposals"][0]["title"]) == text
    assert len(f.http.sent) == 2 and f.control.durable_outputs == ["run"]


@pytest.mark.parametrize("effect", ["advisory", "public-stage", "publication"])
def test_unknown_output_effect_never_success_absence_or_model_retry(monkeypatch, effect):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        target = (effect == "advisory" and method == "stageArtifact" and fields["artifactId"] == "advisory-copy"
                  or effect == "public-stage" and method == "stageArtifact" and fields["artifactId"] == "run"
                  or effect == "publication" and method == "publishAgent")
        if target: raise ControlError("synthetic-lost-ack", effect="unknown")
    f.control.mutate = mutate
    result = dispatch(f)
    assert result["status"] == "unknown" and result["outputArtifactIds"] == []
    assert len(f.http.sent) == 2 and "advisory-copy" in f.control.governed
    assert ("run" in f.control.ordinary) == (effect != "advisory")
    assert f.control.durable_outputs == (["run"] if effect == "publication" else [])
    stages = len([m for m, _ in f.control.calls if m == "stageArtifact"])
    again = dispatch(f)
    assert again["status"] == "unknown" and len(f.http.sent) == 2
    assert len([m for m, _ in f.control.calls if m == "stageArtifact"]) == stages
    assert f.control.durable_outputs == (["run"] if effect == "publication" else [])


@pytest.mark.parametrize("change", ["stage-hash", "stage-status", "public-stage-status", "publication-lease", "publication-output", "publication-state"])
def test_unconfirmed_receipts_cannot_publish_fake_outputs(monkeypatch, change):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "stageArtifact" and fields["artifactId"] == "advisory-copy":
            if change == "stage-hash": reply["artifact"]["artifactSha256"] = "f" * 64
            if change == "stage-status": reply["status"] = "unknown"
        if method == "stageArtifact" and fields["artifactId"] == "run" and change == "public-stage-status":
            reply["status"] = "unknown"
        if method == "publishAgent":
            if change == "publication-lease": reply["lease"]["leaseEpoch"] = "2"
            if change == "publication-output": reply["outputArtifactIds"] = ["advisory-copy"]
            if change == "publication-state": reply["state"] = "failed"
    f.control.mutate = mutate
    result = dispatch(f)
    assert result["status"] == "unknown" and result["outputArtifactIds"] == [] and len(f.http.sent) == 2


def test_truthful_cancelled_before_model_no_fake_public_output(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "currentRights": f.context.cancellation.set()
    f.control.mutate = mutate
    result = dispatch(f)
    assert result["status"] == "cancelled" and result["outputArtifactIds"] == []
    assert f.http.sent == f.control.proofs == [] and f.control.publications == []


def test_preexisting_cancellation_denies_before_job_or_effects(monkeypatch):
    f = build_boundary(monkeypatch)
    f.context.cancellation.set()
    def forbidden(*args, **kwargs):
        raise AssertionError("Cancelled chat must not construct a job")
    monkeypatch.setattr("adapters.handlers._Job", forbidden)
    assert dispatch(f)["status"] == "cancelled"
    assert f.control.calls == f.http.sent == [] and f.control.publications == []


def test_after_return_replayed_dispatch_permission_is_not_output_proof(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "currentModelUse" and len(f.control.proofs) == 4:
            reply["externalDispatchAllowed"] = True
    f.control.mutate = mutate
    result = dispatch(f)
    assert result["status"] == "unknown" and len(f.http.sent) == 2
    assert f.control.governed == f.control.ordinary == {} and f.control.publications == []


def test_original_advisory_cap_checked_after_real_output_not_reallocated(monkeypatch):
    f = build_boundary(monkeypatch)
    f.recipe["execution"]["advisoryMaximumBytes"] = 1100
    repin_recipe(f)
    def mutate(path, response):
        if path == "/v1/chat/completions":
            value = json.loads(response["choices"][0]["message"]["content"])
            value["output"]["claims"][0]["text"] = "x" * 1800
            response["choices"][0]["message"]["content"] = f.authority.encode(value).decode()
    f.http.response_mutator = mutate
    result = dispatch(f)
    assert result["status"] == "failed" and result["outputArtifactIds"] == []
    assert len(f.http.sent) == 2 and json.loads(f.http.sent[1][2])["max_completion_tokens"] == 128
    assert f.control.governed == f.control.ordinary == {}
