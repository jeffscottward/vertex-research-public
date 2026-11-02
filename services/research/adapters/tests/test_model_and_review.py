"""Unexecuted offline regressions; provider/SDK calls are replaceable fakes."""
from dataclasses import replace
from types import SimpleNamespace
import json

import pytest

from adapters.agno import ExactAgnoTransport, _messages, _schema
from adapters.model_policy import ModelPolicy
from adapters.ports import AdapterUnavailable, EndpointPolicy
from adapters.review import CurrentUseGuard, GuardedModel
from agents.adapters import AgnoCall
from agents.types import AgentFault, SYSTEM_INSTRUCTION


def model_policy(**changes):
    return replace(ModelPolicy("compute-policy", "selected-model-rev", "served-model-commit", "vllm-0.9.2",
        "a" * 40, "b" * 64, "c" * 64, "d" * 64, "tokenizer-endpoint", "completion-endpoint", "price-artifact",
        "1", "2", 4096), **changes)


def endpoint(endpoint_id, operation, path):
    return EndpointPolicy(endpoint_id, "selected-vllm", operation, "https://model.example.com", path, "POST",
        "secret-ref", "Authorization", "Bearer ", (), "rights-policy", "tagged-source",
        maximum_request_bytes=1_000_000, maximum_response_bytes=1_000_000,
        allowed_ip_addresses=("93.184.216.34",))


def call(**changes):
    return replace(AgnoCall("run", "trace", "attempt", "selected-model-rev", SYSTEM_INSTRUCTION,
        {"task": "Untrusted supplied evidence", "untrusted_content": True}, ("read-evidence",), 0, 100, "1", 1_800_000_060_000_000_000), **changes)


def bridge(monkeypatch):
    monkeypatch.setattr("adapters.agno.version", lambda name: {"agno": "1.7.12", "openai": "1.93.0", "httpx": "0.28.1"}[name])
    clock = SimpleNamespace(now_ns=lambda: 1_800_000_000_000_000_000)
    timestamps = SimpleNamespace(now=lambda: "2027-01-15T08:00:00.000000000Z")
    gate = SimpleNamespace(acquire=lambda *args: True)
    instance = ExactAgnoTransport(policy=model_policy(), endpoints=(
        endpoint("tokenizer-endpoint", "model-tokenize", "/tokenize"),
        endpoint("completion-endpoint", "model-completion", "/v1/chat/completions")),
        http=None, gate=gate, admission=None, clock=clock, timestamps=timestamps,
        rights=None, cancellation=SimpleNamespace(cancelled=lambda: False), before_disclosure=lambda call: None,
        model_use_requests=SimpleNamespace())
    return instance


def test_meter_uses_same_complete_messages_not_character_estimate(monkeypatch):
    instance = bridge(monkeypatch)
    requests = []
    def request(endpoint, body, deadline):
        requests.append(body)
        return json.dumps({"count": 4, "tokens": [1, 10, 30, 99], "max_model_len": 4096}).encode()
    instance._request = request
    request_call = call()
    assert instance.input_tokens(request_call) == 4
    assert requests[0]["messages"] == _messages(request_call)
    assert requests[0]["tools"] is None
    assert requests[0]["add_special_tokens"] is False
    assert requests[0]["continue_final_message"] is False
    assert requests[0]["chat_template_kwargs"] == {}


@pytest.mark.parametrize("response", [
    {"count": 3, "tokens": [1, 2], "max_model_len": 4096},
    {"count": True, "tokens": [1], "max_model_len": 4096},
    {"count": 1, "tokens": [False], "max_model_len": 4096},
    {"count": 1, "tokens": [1], "max_model_len": 8192},
])
def test_invalid_meter_identity_or_count_fails_closed(monkeypatch, response):
    instance = bridge(monkeypatch)
    instance._request = lambda *args: json.dumps(response).encode()
    with pytest.raises(AgentFault):
        instance.input_tokens(call())


def test_unsupported_sdk_pin_does_not_even_call_tokenizer(monkeypatch):
    instance = bridge(monkeypatch)
    monkeypatch.setattr("adapters.agno.version", lambda name: "unknown")
    instance._request = lambda *args: pytest.fail("No model/meter HTTP should occur")
    with pytest.raises(AgentFault):
        instance.input_tokens(call())


def test_unknown_backend_never_substitutes_groq_or_model():
    with pytest.raises(AdapterUnavailable):
        model_policy(backend="groq-unqualified-tokenizer").require()


def test_changed_prompt_after_meter_cannot_use_old_reservation(monkeypatch):
    instance = bridge(monkeypatch)
    instance._request = lambda *args: b'{"count":1,"tokens":[1],"max_model_len":4096}'
    instance.input_tokens(call())
    with pytest.raises(AgentFault):
        instance.run(call(max_output_tokens=99, untrusted_user_data={"task": "changed"}), cancellation=SimpleNamespace(cancelled=lambda: False))


def test_structured_result_uses_existing_domain_proposal_vocabulary():
    schema = _schema(("propose-strategy",))
    output = schema["properties"]["output"]["anyOf"][0]
    kinds = output["properties"]["proposals"]["items"]["properties"]["kind"]["enum"]
    assert kinds == ["strategy-hypothesis", "backtest-request"]
    assert _messages(call())[0] == {"role": "system", "content": SYSTEM_INSTRUCTION}


def test_review_rejection_after_inflight_model_suppresses_result():
    calls = []
    class Guard:
        def check(self, evidence):
            calls.append("review")
            if len(calls) == 3:
                raise AgentFault("rights-denied")
    class Model:
        def invoke(self, request, *, cancellation):
            calls.append("model")
            return "must-not-escape"
    guarded = GuardedModel(Model(), Guard())
    with pytest.raises(AgentFault, match="rights-denied"):
        guarded.invoke(SimpleNamespace(untrusted_evidence=()), cancellation=SimpleNamespace(cancelled=lambda: False))
    assert calls == ["review", "model", "review"]


def test_current_review_is_not_an_acceptance_status_flag():
    # Construct only an object shell to prove the guard refuses absent original
    # bytes before it can authorize from a mutable DTO or cached acceptance flag.
    guard = object.__new__(CurrentUseGuard)
    guard.time = SimpleNamespace(now_ns=lambda: 10)
    guard.request = SimpleNamespace(deadline_ns=20, reference_ns=0, max_evidence_age_ns=100)
    guard.originals = SimpleNamespace(originals={})
    evidence = SimpleNamespace(collection_id="collection", snapshot_id="snapshot", evidence_id="evidence",
                               captured_ns=0, valid_until_ns=30)
    with pytest.raises(AgentFault):
        guard.check((evidence,))


def test_model_dispatch_uses_one_exact_request_before_and_after(monkeypatch):
    from contextlib import nullcontext
    instance = bridge(monkeypatch)
    proof_requests = []
    def proof(*, request, input_bytes, deadline_ns):
        proof_requests.append(request)
        return {"decision": "allowed", "requestSha256": "hash",
                "externalDispatchAllowed": len(proof_requests) == 1}
    instance.rights = SimpleNamespace(operation=lambda *args: nullcontext(),
        model_evidence_refs=lambda evidence: (), authorize_model_use=proof)
    instance.model_use_requests = SimpleNamespace(request=lambda **fields: {"requestSha256": "hash"})
    def http(request, *, deadline_ns, authorize_disclosure):
        authorize_disclosure()
        authorize_disclosure()
        return SimpleNamespace(status_code=200, body=b"{}")
    instance.http = SimpleNamespace(request_until=http)
    assert instance._request(instance.tokenize, {}, call(untrusted_user_data={"evidence": []})) == b"{}"
    assert len(proof_requests) == 2
    assert proof_requests[0] is proof_requests[1]


def test_duplicate_model_proof_cannot_dispatch_even_when_currently_allowed(monkeypatch):
    from contextlib import nullcontext
    instance = bridge(monkeypatch)
    instance.rights = SimpleNamespace(operation=lambda *args: nullcontext(),
        model_evidence_refs=lambda evidence: (), authorize_model_use=lambda **fields: {
            "decision": "allowed", "requestSha256": "hash", "externalDispatchAllowed": False})
    instance.model_use_requests = SimpleNamespace(request=lambda **fields: {"requestSha256": "hash"})
    def http(request, *, deadline_ns, authorize_disclosure):
        authorize_disclosure()
        pytest.fail("Duplicate admission must not reach external disclosure")
    instance.http = SimpleNamespace(request_until=http)
    with pytest.raises(AgentFault, match="rights-denied"):
        instance._request(instance.tokenize, {}, call(untrusted_user_data={"evidence": []}))
