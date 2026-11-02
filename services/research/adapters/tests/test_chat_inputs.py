"""Offline pure tests plus an EXPLICITLY gated real pinned-SDK transport test.

Run pure tests without optional SDKs. VERTEX_CHAT_SDK_PARITY=1 opts into the
separate SDK test ONLY in an independently adopted exact installed environment;
missing/wrong versions then FAIL, never substitute another SDK. Downloaded
source-inspection wheels are not imported or installed by this file.
"""
from __future__ import annotations

from base64 import b64encode
from contextlib import nullcontext
from dataclasses import replace
from hashlib import sha256
from importlib.metadata import version
import json
import os
import socket
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from adapters.agno import DEPENDENCIES, ExactAgnoTransport, _schema
from adapters.chat_inputs import (
    ChatInputIdentity, ChatInputLimits, ChatInputPricing, _HumanCodec, _timestamp_ns,
    assert_chat_measured_tokens, canonical_chat_input_bytes, prepare_chat_inputs,
)
from adapters.model_policy import ModelPolicy
from adapters.ports import EndpointPolicy
from agents.adapters import AgnoCall
from agents.chat_context import parse_research_chat_human_context_v1
from agents.types import AgentFault, Evidence, SYSTEM_INSTRUCTION


def fixture():
    context = parse_research_chat_human_context_v1({
        "schema_version": "1.0.0", "kind": "research-chat-human-context",
        "account_alias": "fixture", "environment": "research", "owner_actor_id": "owner",
        "response_request_id": "response", "thread_id": "thread", "parent_message_id": "message",
        "participant_id": "expert", "participant_config_sha256": "a" * 64,
        "participant_label": "Synthetic Researcher", "persona_text": "Untrusted synthetic persona.",
        "snapshot_revision": "9007199254740994", "high_water_sequence": "9007199254740993",
        "start_sequence": "9007199254740993", "messages": [{
            "message_id": "message", "sequence": "9007199254740993", "record_sha256": "b" * 64,
            "author": {"kind": "user", "actor_id": "owner"}, "body": "Literal e\u0301 / 雪 / 𝄞 and quotes \" remain data.",
        }],
    }, codec=_HumanCodec())
    policy = ModelPolicy("policy", "model-version", "served-model", "vllm-0.9.2", "a" * 40,
                         "b" * 64, "c" * 64, "d" * 64, "tokenize", "complete", "prices", "1", "2", 4096)
    def endpoint(name, operation, path):
        return EndpointPolicy(name, "provider", operation, "https://model.example.com", path,
            "POST", "secret-reference-not-a-secret", "Authorization", "Bearer ", (), "policy", "source",
            maximum_request_bytes=1_000_000, maximum_response_bytes=1_000_000, timeout_ms=1000,
            allowed_ip_addresses=("93.184.216.34",))
    endpoints = (endpoint("tokenize", "model-tokenize", "/tokenize"),
                 endpoint("complete", "model-completion", "/v1/chat/completions"))
    excerpt = "Original bounded excerpt 雪 e\u0301 𝄞. Human messages are not corpus evidence."
    evidence = Evidence("evidence", "collection", "snapshot", "source", "source-snapshot",
        "https://example.com/research", "paragraph-1", "Synthetic source", "c" * 64,
        sha256(excerpt.encode()).hexdigest(), excerpt, "rights", 1_800_000_000_000_000_001, None,
        1_800_000_100_000_000_123, "d" * 64, "review", 9_007_199_254_740_993)
    return dict(human_context=context, task="Explain this synthetic research evidence.", evidence=(evidence,),
        policy=policy, endpoints=endpoints,
        identity=ChatInputIdentity("run", "trace", "owner", "response", "2027-01-15T08:01:00.000000123Z", 1_800_000_060_000_000_123),
        limits=ChatInputLimits(1000, 128, 2000, 1500, 3000, "1", "0.5", "2", "0.4", "0.01", "0.1"),
        pricing=ChatInputPricing("0.001", "0.000000001", "0.001", "0.000000001", "0.0001"))


@pytest.fixture(autouse=True)
def prohibit_external_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("External network is disabled for chat input tests")
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


def test_exact_body_keys_prompt_and_integer_nanoseconds():
    args = fixture()
    prepared = prepare_chat_inputs(**args)
    tokenizer = json.loads(prepared.tokenize_input)
    completion = json.loads(prepared.completion_input)
    assert len(completion) == 14
    assert "tools" not in completion and tokenizer["tools"] is None
    assert completion["messages"] == tokenizer["messages"]
    assert completion["messages"][0] == {"role": "system", "content": SYSTEM_INSTRUCTION}
    payload = json.loads(completion["messages"][1]["content"])
    assert payload["data"]["human_context"] == json.loads(prepared.context)
    assert payload["data"]["evidence"][0]["captured_ns"] == 1_800_000_000_000_000_001
    assert payload["data"]["evidence"][0]["published_ns"] is None
    assert payload["data"]["evidence"][0]["accepted_review_revision"] == 9_007_199_254_740_993
    assert payload["inert_tool_names"] == []
    assert payload["data"]["prior_analyses"] == payload["data"]["tool_results"] == []
    assert completion["response_format"]["json_schema"]["schema"] == _schema(())
    assert completion["max_completion_tokens"] == 128
    assert prepared.fields == {"runId": "run", "traceId": "trace", "expiresAt": args["identity"].expires_at}


@pytest.mark.parametrize("value", [1.0, -0.0, 0.5, float("nan"), float("inf"), {"x": 1.0}, "\ud800"])
def test_rejects_float_type_or_invalid_unicode(value):
    with pytest.raises(AgentFault):
        canonical_chat_input_bytes(value)


def test_codepoint_key_order_and_exact_integer_are_python_json_not_js_coercions():
    value = {"\U00010000": 9_007_199_254_740_993, "\ue000": None, "z": "e\u0301 雪\n\t\""}
    assert canonical_chat_input_bytes(value) == json.dumps(value, ensure_ascii=False, allow_nan=False,
        sort_keys=True, separators=(",", ":")).encode()
    assert canonical_chat_input_bytes(value).index("\ue000".encode()) < canonical_chat_input_bytes(value).index("\U00010000".encode())
    # The exact response schema contains no hidden float leaves either.
    assert canonical_chat_input_bytes(_schema(()))


def test_measured_headroom_does_not_change_fixed_output_or_preapproved_bytes():
    args = fixture()
    before = prepare_chat_inputs(**args)
    assert_chat_measured_tokens(limits=args["limits"], policy=args["policy"], count=200)
    after = prepare_chat_inputs(**args)
    assert after == before
    assert args["limits"].attempt_tokens - args["limits"].maximum_output_tokens != 200
    with pytest.raises(AgentFault):
        assert_chat_measured_tokens(limits=args["limits"], policy=args["policy"], count=1001)
    with pytest.raises(AgentFault):
        assert_chat_measured_tokens(limits=replace(args["limits"], attempt_tokens=250), policy=args["policy"], count=200)


@pytest.mark.parametrize("change", ["endpoint", "origin", "ips", "limit", "float-ns", "digest", "identity", "tokens", "cost", "zero-tokenize"])
def test_negative_bounds_and_projection_mismatches(change):
    args = fixture()
    if change in {"endpoint", "origin", "ips", "limit"}:
        updates = {"endpoint": {"path": "/wrong"}, "origin": {"origin": "https://other.example.com"},
                   "ips": {"allowed_ip_addresses": ("192.0.2.2",)}, "limit": {"maximum_request_bytes": 10}}[change]
        args["endpoints"] = (replace(args["endpoints"][0], **updates), args["endpoints"][1])
    elif change == "float-ns":
        args["evidence"] = (replace(args["evidence"][0], captured_ns=1.8e18),)
    elif change == "digest":
        args["evidence"] = (replace(args["evidence"][0], excerpt="Rewritten source excerpt."),)
    elif change == "identity":
        args["identity"] = replace(args["identity"], response_request_id="other")
    elif change == "tokens":
        args["limits"] = replace(args["limits"], attempt_tokens=1100)
    elif change == "cost":
        args["limits"] = replace(args["limits"], completion_cost_usd="0.00001")
    else:
        args["limits"] = replace(args["limits"], tokenize_cost_usd="0")
    with pytest.raises((AgentFault, ValueError)):
        prepare_chat_inputs(**args)


def _actual_sdk_body(args):
    # Execute the ACTUAL legacy bridge, including its actual SDK invocation.
    # Only external HTTP and authority/admission ports are fakes. This asserts
    # bytes, not positive permission, deployment readiness or budget admission.
    assert {name: version(name) for name in DEPENDENCIES} == DEPENDENCIES
    prepared = prepare_chat_inputs(**args)
    body = json.loads(prepared.completion_input)
    data = json.loads(body["messages"][1]["content"])["data"]
    captures = []
    response = {"id": "synthetic", "object": "chat.completion", "created": 1,
        "model": args["policy"].served_model, "choices": [{"index": 0, "finish_reason": "stop",
        "message": {"role": "assistant", "content": '{"output":null,"tool_requests":[]}'}}],
        "usage": {"prompt_tokens": 200, "completion_tokens": 10, "total_tokens": 210}}

    class ExternalHttpDouble:
        def request_until(self, request, *, deadline_ns, authorize_disclosure):
            authorize_disclosure()
            captures.append((request.path, request.body))
            result = {"count": 200, "tokens": list(range(200)),
                      "max_model_len": args["policy"].maximum_context_tokens} if request.path == "/tokenize" else response
            return SimpleNamespace(status_code=200, body=canonical_chat_input_bytes(result))

    cancelled = SimpleNamespace(cancelled=lambda: False)
    bridge = ExactAgnoTransport(policy=args["policy"], endpoints=args["endpoints"],
        http=ExternalHttpDouble(), gate=SimpleNamespace(acquire=lambda *args: True),
        admission=SimpleNamespace(reserve_model=lambda **kwargs: "synthetic-reservation",
                                  settle_model=lambda *args, **kwargs: None),
        clock=SimpleNamespace(now_ns=lambda: 1_800_000_000_000_000_000),
        timestamps=SimpleNamespace(), cancellation=cancelled, before_disclosure=lambda call: None,
        rights=SimpleNamespace(operation=lambda *args: nullcontext(), model_evidence_refs=lambda evidence: (),
            authorize_model_use=lambda **kwargs: {"decision": "allowed", "requestSha256": "synthetic", "externalDispatchAllowed": True}),
        model_use_requests=SimpleNamespace(request=lambda **kwargs: {"requestSha256": "synthetic"}))
    call = AgnoCall(args["identity"].run_id, args["identity"].trace_id, "synthetic-attempt",
        args["policy"].model_version, SYSTEM_INSTRUCTION, data, (), args["limits"].maximum_output_tokens,
        args["limits"].attempt_tokens, args["limits"].completion_cost_usd, args["identity"].expires_ns)
    assert bridge.input_tokens(call) == 200
    bridge.run(call, cancellation=cancelled)
    assert captures == [("/tokenize", prepared.tokenize_input), ("/v1/chat/completions", prepared.completion_input)]
    return captures[-1][1]


@pytest.mark.skipif(os.environ.get("VERTEX_CHAT_SDK_PARITY") != "1",
                    reason="Deferred: requires independently adopted Agno1.7.12/OpenAI1.93.0/httpx0.28.1 environment")
def test_actual_pinned_sdk_completion_parity():
    _actual_sdk_body(fixture())


def mirror_civet_input(value):
    """Test-only bridge: Civet preflights selected/configuration joins first."""
    provider = value["configuration"]["provider"]
    budgets, research = value["budgets"], value["selection"]["research"]
    price, identity = value["modelDescriptor"]["pricing"], value["identity"]
    args = dict(human_context=parse_research_chat_human_context_v1(value["humanContext"], codec=_HumanCodec()),
        task=value["request"]["retrievalQuery"], evidence=tuple(Evidence(**row) for row in value["evidence"]),
        policy=ModelPolicy(**value["modelPolicy"]), endpoints=tuple(EndpointPolicy(**{
            **row, "allowed_query_keys": tuple(row["allowed_query_keys"]),
            "allowed_ip_addresses": tuple(row["allowed_ip_addresses"])}) for row in value["endpoints"]),
        identity=ChatInputIdentity(identity["runId"], identity["traceId"], value["ownerActorId"],
            value["responseRequestId"], identity["expiresAt"], _timestamp_ns(identity["expiresAt"])),
        limits=ChatInputLimits(provider["maximumInputTokens"], provider["maximumOutputTokens"],
            budgets["requestTokens"], budgets["attemptTokens"], research["tokenBudget"],
            budgets["requestCostUsd"], budgets["attemptCostUsd"], research["costBudgetUsd"], provider["maximumCostUsd"],
            budgets["tokenizeCostUsd"], budgets["completionCostUsd"]),
        pricing=ChatInputPricing(price["tokenizationBaseUsd"], price["tokenizationInputByteUsd"],
            price["completionBaseUsd"], price["completionInputByteUsd"], price["outputTokenUsd"]))
    prepared = prepare_chat_inputs(**args)
    return {"fields": prepared.fields, "context": b64encode(prepared.context).decode(),
        "tokenizeInput": b64encode(prepared.tokenize_input).decode(),
        "completionInput": b64encode(prepared.completion_input).decode(),
        "schema": _schema(())}


if __name__ == "__main__":
    if sys.argv[1:] != ["--mirror"]:
        raise SystemExit("Use pytest, or --mirror for the Civet parity test")
    # No SDK code is run by the bridge; any accidental socket use fails closed.
    with patch.object(socket, "create_connection", side_effect=AssertionError("Network forbidden")), \
         patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden")):
        print(json.dumps(mirror_civet_input(json.load(sys.stdin)), ensure_ascii=False, allow_nan=False,
                         sort_keys=True, separators=(",", ":")))
